require("dotenv").config();
const keep_alive = require("./keep_alive.js");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

function hasAdminRole(member) {
  return member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

async function safeReply(interaction, content, options = {}) {
  const payload = typeof content === "string" ? { content, ...options } : content;
  if (!payload.flags) payload.flags = 64; // ephemeral by default
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    console.error("safeReply error:", err);
  }
}

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Register slash commands for your guild
  const commands = [
    new SlashCommandBuilder()
      .setName("apply")
      .setDescription("Apply for server whitelist"),

    new SlashCommandBuilder()
      .setName("whitelist")
      .setDescription("Whitelist a player")
      .addStringOption((opt) => opt.setName("serial").setDescription("MTA Serial").setRequired(true))
      .addStringOption((opt) => opt.setName("discord_id").setDescription("Discord ID").setRequired(true)),

    new SlashCommandBuilder()
      .setName("unwhitelist")
      .setDescription("Remove player from whitelist")
      .addStringOption((opt) => opt.setName("serial").setDescription("MTA Serial").setRequired(true)),

    new SlashCommandBuilder()
      .setName("removeverification")
      .setDescription("Remove a verification")
      .addStringOption((opt) => opt.setName("discord_id").setDescription("Discord ID").setRequired(true)),

    new SlashCommandBuilder()
      .setName("verifycode")
      .setDescription("Link a code to a Discord ID")
      .addStringOption((opt) => opt.setName("code").setDescription("Verification Code").setRequired(true))
      .addStringOption((opt) => opt.setName("discord_id").setDescription("Discord ID").setRequired(true)),

    new SlashCommandBuilder()
      .setName("whitelistinfo")
      .setDescription("View current whitelist entries"),

    new SlashCommandBuilder()
      .setName("mtaverify")
      .setDescription("Send verify button")
      .addChannelOption((opt) => opt.setName("channel").setDescription("Target channel").setRequired(false)),
  ];

  try {
    await client.application.commands.set(commands, process.env.GUILD_ID);
    console.log("✅ Slash commands registered");
  } catch (error) {
    console.error("❌ Failed to register slash commands:", error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isCommand() &&
    !interaction.isButton() &&
    !interaction.isModalSubmit()
  )
    return;

  const connection = await pool.getConnection();

  try {
    // ======= BUTTONS =======

    // Verify button pressed
    if (interaction.isButton() && interaction.customId === "verify_mta") {
      await interaction.deferReply({ ephemeral: true });

      // Check if user is whitelisted
      const [rows] = await connection.execute(
        "SELECT mta_serial FROM mta_whitelist WHERE discord_id = ? LIMIT 1",
        [interaction.user.id]
      );
      if (!rows.length) {
        return interaction.editReply(
          "❌ You must be whitelisted first."
        );
      }

      // Insert/update verification with 5 min expiry
      await connection.execute(
        `INSERT INTO mta_verifications (mta_serial, discord_id, verified_at, expires_at)
         VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))
         ON DUPLICATE KEY UPDATE verified_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
        [rows[0].mta_serial, interaction.user.id]
      );

      return interaction.editReply("✅ Verified for 5 minutes. Join the server now.");
    }

    // Accept/Reject whitelist application buttons
    if (
      interaction.isButton() &&
      (interaction.customId.startsWith("accept_") || interaction.customId.startsWith("reject_"))
    ) {
      if (!hasAdminRole(interaction.member))
        return safeReply(interaction, "❌ No permission.");

      const userId = interaction.customId.split("_")[1];
      const [rows] = await connection.execute(
        "SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1",
        [userId]
      );

      if (rows.length === 0) {
        return interaction.reply({
          content: "❌ Application not found in database.",
          ephemeral: true,
        });
      }

      const { serial, discord_id } = rows[0];

      if (interaction.customId.startsWith("accept_")) {
        // Add to whitelist table
        await connection.execute(
          `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id), added_by = VALUES(added_by)`,
          [serial, discord_id, interaction.user.tag]
        );

        // Notify user
        const user = await client.users.fetch(discord_id).catch(() => null);
        if (user)
          await user.send(
            `🎉 Your whitelist application has been accepted! Welcome!`
          );

        // Remove submission after acceptance
        await connection.execute("DELETE FROM whitelist_submissions WHERE discord_id = ?", [userId]);

        return interaction.update({
          content: "✅ Application accepted and user whitelisted.",
          components: [],
        });
      }

      if (interaction.customId.startsWith("reject_")) {
        // Increment retries count on rejection
        await connection.execute(
          "UPDATE whitelist_submissions SET retries = retries + 1 WHERE discord_id = ?",
          [userId]
        );

        // Notify user
        const user = await client.users.fetch(userId).catch(() => null);
        if (user)
          await user.send(
            `❌ Your whitelist application has been rejected. You can reapply once more.`
          );

        return interaction.update({
          content: "❌ Application rejected.",
          components: [],
        });
      }
    }

    // ======= COMMANDS =======

    // /apply command: Show application modal
    if (interaction.isCommand() && interaction.commandName === "apply") {
      const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("open_application_modal")
          .setLabel("🧾 Submit Application")
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle("📝 𝗠𝗧𝗔:𝗦𝗔 𝗥𝗢𝗟𝗘𝗣𝗟𝗔𝗬 𝗪𝗛𝗜𝗧𝗘𝗟𝗜𝗦𝗧 𝗔𝗣𝗣𝗟𝗜𝗖𝗔𝗧𝗜𝗢𝗡")
        .setColor(0x2c2f33)
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(
          "Welcome to the roleplay whitelist system!\n" +
            "1 | Apply and wait for approval or rejection.\n" +
            "2 | Fill the form properly or risk getting rejected."
        )
        .setFooter({
          text: "MTA:SA Whitelist System",
          iconURL: client.user.displayAvatarURL(),
        });

      return interaction.reply({ embeds: [embed], components: [button] });
    }

    // Open modal on button press
    if (interaction.isButton() && interaction.customId === "open_application_modal") {
      const modal = new ModalBuilder()
        .setCustomId("whitelist_application")
        .setTitle("✨ Whitelist Application")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("irl_name")
              .setLabel("🧑‍🦱 Your Full Name (IRL)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("irl_age")
              .setLabel("🎂 Your Age (IRL)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("ingame_name")
              .setLabel("🎮 In-game Name")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("ingame_age")
              .setLabel("🕹️ Character Age")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("serial")
              .setLabel("🔐 MTA Serial (32 characters)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(32)
              .setMaxLength(32)
          )
        );

      return interaction.showModal(modal);
    }

    // Modal submit for whitelist application
    if (interaction.isModalSubmit() && interaction.customId === "whitelist_application") {
      const serial = interaction.fields.getTextInputValue("serial");

      // Validate serial format (hex 32 chars)
      if (!/^[a-fA-F0-9]{32}$/.test(serial)) {
        return interaction.reply({
          content: "❌ Serial must be 32 hexadecimal characters.",
          ephemeral: true,
        });
      }

      // Check if user already has a submission
      const [existing] = await connection.execute(
        "SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1",
        [interaction.user.id]
      );

      let retries = 0;
      if (existing.length > 0) {
        if (existing[0].retries >= 1) {
          return interaction.reply({
            content: "❌ You have already reapplied once after rejection.",
            ephemeral: true,
          });
        }
        retries = existing[0].retries + 1;
        // Delete old submission before inserting new one
        await connection.execute("DELETE FROM whitelist_submissions WHERE discord_id = ?", [
          interaction.user.id,
        ]);
      }

      const fields = {
        irlName: interaction.fields.getTextInputValue("irl_name"),
        irlAge: interaction.fields.getTextInputValue("irl_age"),
        ingameName: interaction.fields.getTextInputValue("ingame_name"),
        ingameAge: interaction.fields.getTextInputValue("ingame_age"),
      };

      // Insert new submission
      await connection.execute(
        `INSERT INTO whitelist_submissions (discord_id, irl_name, irl_age, ingame_name, ingame_age, serial, retries, experience)
         VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
        [
          interaction.user.id,
          fields.irlName,
          fields.irlAge,
          fields.ingameName,
          fields.ingameAge,
          serial,
          retries,
        ]
      );

      // Send embed to submissions channel
      const embed = new EmbedBuilder()
        .setTitle("📝 New Whitelist Application")
        .setColor(0xffa500)
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: "🧑‍🦱 IRL Name", value: `\`${fields.irlName}\``, inline: true },
          { name: "🎂 IRL Age", value: `\`${fields.irlAge}\``, inline: true },
          { name: "🎮 In-game Name", value: `\`${fields.ingameName}\``, inline: true },
          { name: "🕹️ Character Age", value: `\`${fields.ingameAge}\``, inline: true },
          { name: "🔐 MTA Serial", value: `\`${serial}\``, inline: false },
          { name: "🔁 Reapply Count", value: `\`${retries}\` / \`1\``, inline: true },
          { name: "👤 Discord", value: `<@${interaction.user.id}>`, inline: true },
          { name: "🆔 Discord ID", value: `\`${interaction.user.id}\``, inline: true }
        )
        .setFooter({ text: "Whitelist System", iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`accept_${interaction.user.id}`)
          .setLabel("✅ Accept")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${interaction.user.id}`)
          .setLabel("❌ Reject")
          .setStyle(ButtonStyle.Danger)
      );

      const logChannel = await client.channels.fetch(process.env.SUBMISSIONS_CHANNEL_ID);
      await logChannel.send({ embeds: [embed], components: [buttons] });

      return interaction.reply({
        content: "✅ Your application has been submitted!",
        ephemeral: true,
      });
    }

    // /whitelist command
    if (interaction.isCommand() && interaction.commandName === "whitelist") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const serial = interaction.options.getString("serial");
      const discordId = interaction.options.getString("discord_id");

      await connection.execute(
        `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id), added_by = VALUES(added_by)`,
        [serial, discordId, interaction.user.id]
      );

      return safeReply(interaction, {
        content: "✅ Whitelisted",
        embeds: [
          new EmbedBuilder()
            .setColor(0x00ff00)
            .addFields(
              { name: "Serial", value: serial, inline: true },
              { name: "Discord", value: `<@${discordId}>`, inline: true }
            ),
        ],
      });
    }

    // /unwhitelist command
    if (interaction.isCommand() && interaction.commandName === "unwhitelist") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const serial = interaction.options.getString("serial");

      await connection.execute("DELETE FROM mta_whitelist WHERE mta_serial = ?", [serial]);
      await connection.execute("DELETE FROM mta_verifications WHERE mta_serial = ?", [serial]);

      return safeReply(interaction, `✅ Removed \`${serial}\` from whitelist.`);
    }

    // /removeverification command
    if (interaction.isCommand() && interaction.commandName === "removeverification") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const discordId = interaction.options.getString("discord_id");

      await connection.execute("DELETE FROM mta_verifications WHERE discord_id = ?", [discordId]);

      return safeReply(interaction, `✅ Removed verification for <@${discordId}>`);
    }

    // /verifycode command
    if (interaction.isCommand() && interaction.commandName === "verifycode") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const code = interaction.options.getString("code").toUpperCase();
      const discordId = interaction.options.getString("discord_id");

      // Look up verification attempt
      const [rows] = await connection.execute(
        "SELECT mta_serial, ip, nickname FROM verification_attempts WHERE code = ? AND expires_at > NOW() LIMIT 1",
        [code]
      );

      if (!rows.length) return safeReply(interaction, "❌ Invalid or expired code.");

      const { mta_serial, ip, nickname } = rows[0];

      // Insert into verified players table or update
      await connection.execute(
        `INSERT INTO verified_players (mta_serial, discord_id, ip, nickname, verified_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE ip = VALUES(ip), nickname = VALUES(nickname), verified_at = NOW()`,
        [mta_serial, discordId, ip, nickname]
      );

      // Delete verification attempt
      await connection.execute("DELETE FROM verification_attempts WHERE code = ?", [code]);

      return safeReply(
        interaction,
        `✅ Code verified and linked to \`${mta_serial}\`.\nNow press the ✅ **Verify** button to complete your verification.`
      );
    }

    // /whitelistinfo command
    if (interaction.isCommand() && interaction.commandName === "whitelistinfo") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const [rows] = await connection.execute("SELECT * FROM mta_whitelist");

      if (!rows.length) return safeReply(interaction, "No whitelist entries found.");

      const embed = new EmbedBuilder()
        .setTitle("📋 Whitelist Info")
        .setColor(0x0099ff);

      rows.forEach((r) => {
        embed.addFields({
          name: `Serial: ${r.mta_serial.substring(0, 6)}...`,
          value: `User: <@${r.discord_id}>\nBy: <@${r.added_by}>`,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /mtaverify command - sends verify button to channel
    if (interaction.isCommand() && interaction.commandName === "mtaverify") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const channel = interaction.options.getChannel("channel") || interaction.channel;

      const verifyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("verify_mta")
          .setLabel("✅ Verify")
          .setStyle(ButtonStyle.Success)
      );

      await channel.send({
        content:
          "Click the button below to verify your MTA account and link your Discord account for whitelist access.",
        components: [verifyButton],
      });

      return safeReply(interaction, `✅ Verification button sent to ${channel}.`);
    }
  } catch (error) {
    console.error("Error handling interaction:", error);
    if (!interaction.replied) {
      await safeReply(interaction, "❌ An error occurred while processing your request.");
    }
  } finally {
    connection.release();
  }
});

// Log in to Discord
client.login(process.env.DISCORD_TOKEN);
