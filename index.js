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
  Events,
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
  if (!payload.flags) payload.flags = 64; // make it ephemeral
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    console.error("safeReply error:", err);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton()) return;

  const connection = await pool.getConnection();
  try {
    // Button: Verify
    if (interaction.isButton() && interaction.customId === "verify_mta") {
      await interaction.deferReply({ ephemeral: true });

      const [rows] = await connection.execute(
        "SELECT mta_serial FROM mta_whitelist WHERE discord_id = ? LIMIT 1",
        [interaction.user.id]
      );
      if (!rows.length)
        return interaction.editReply("❌ You must be whitelisted first.");

      await connection.execute(
        `INSERT INTO mta_verifications (mta_serial, discord_id, verified_at, expires_at)
         VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))
         ON DUPLICATE KEY UPDATE verified_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
        [rows[0].mta_serial, interaction.user.id]
      );

      return interaction.editReply("✅ Verified for 5 minutes. Join the server now.");
    }

    // Slash: /verifycode
    if (interaction.isCommand() && interaction.commandName === "verifycode") {
      const code = interaction.options.getString("code").toUpperCase();
      const discordId = interaction.options.getString("discord_id");

      const [rows] = await connection.execute(
        "SELECT mta_serial, ip, nickname FROM verification_attempts WHERE code = ? AND expires_at > NOW() LIMIT 1",
        [code]
      );

      if (!rows.length)
        return safeReply(interaction, "❌ Invalid or expired code.");

      const { mta_serial, ip, nickname } = rows[0];

      await connection.execute(
        `INSERT INTO verified_players (mta_serial, discord_id, ip, nickname, verified_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE ip = VALUES(ip), nickname = VALUES(nickname), verified_at = NOW()`,
        [mta_serial, discordId, ip, nickname]
      );

      await connection.execute("DELETE FROM verification_attempts WHERE code = ?", [code]);

      return safeReply(
        interaction,
        `✅ Code verified and linked to \`${mta_serial}\`.\nNow press the ✅ **Verify** button to complete your verification.`
      );
    }

    // Slash: /whitelist
    if (interaction.isCommand() && interaction.commandName === "whitelist") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const serial = interaction.options.getString("serial");
      const discordId = interaction.options.getString("discord_id");

      await connection.execute(
        `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)`,
        [serial, discordId, interaction.user.id]
      );

      return safeReply(interaction, {
        content: "✅ Whitelisted",
        embeds: [
          new EmbedBuilder().setColor(0x00ff00).addFields(
            { name: "Serial", value: serial, inline: true },
            { name: "Discord", value: `<@${discordId}>`, inline: true }
          ),
        ],
      });
    }

    // Slash: /unwhitelist
    if (interaction.isCommand() && interaction.commandName === "unwhitelist") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const serial = interaction.options.getString("serial");
      await connection.execute("DELETE FROM mta_whitelist WHERE mta_serial = ?", [serial]);
      await connection.execute("DELETE FROM mta_verifications WHERE mta_serial = ?", [serial]);
      return safeReply(interaction, `✅ Removed \`${serial}\` from whitelist.`);
    }

    // Slash: /removeverification
    if (interaction.isCommand() && interaction.commandName === "removeverification") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const discordId = interaction.options.getString("discord_id");
      await connection.execute("DELETE FROM mta_verifications WHERE discord_id = ?", [discordId]);
      return safeReply(interaction, `✅ Removed verification for <@${discordId}>`);
    }

    // Slash: /whitelistinfo
    if (interaction.isCommand() && interaction.commandName === "whitelistinfo") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const [rows] = await connection.execute("SELECT * FROM mta_whitelist");

      if (!rows.length) return safeReply(interaction, "No entries found.");

      const embed = new EmbedBuilder().setTitle("📋 Whitelist Info").setColor(0x0099ff);
      rows.forEach((r) => {
        embed.addFields({
          name: `Serial: ${r.mta_serial.substring(0, 6)}...`,
          value: `User: <@${r.discord_id}>\nBy: <@${r.added_by}>`,
          inline: true,
        });
      });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Slash: /mtaverify
    if (interaction.isCommand() && interaction.commandName === "mtaverify") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const channel = interaction.options.getChannel("channel") || interaction.channel;

      const embed = new EmbedBuilder()
        .setTitle("🔗 MTA:SA Verification")
        .setColor(0x00ff00)
        .setDescription("**Step 1:** Get a code in-game\n**Step 2:** Use `/verifycode <code>`\n**Step 3:** Press the ✅ **Verify** button.");

      const verifyBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("verify_mta")
          .setLabel("✅ Verify")
          .setStyle(ButtonStyle.Success)
      );

      await channel.send({ embeds: [embed], components: [verifyBtn] });
      return safeReply(interaction, `✅ Sent verification panel to ${channel}`);
    }
  } catch (err) {
    console.error("[Interaction Error]", err);
    return safeReply(interaction, "❌ An error occurred.");
  } finally {
    connection.release();
  }
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await client.application.commands.set(
    [
      {
        name: "whitelist",
        description: "Whitelist a player",
        options: [
          { name: "serial", type: 3, description: "MTA Serial", required: true },
          { name: "discord_id", type: 3, description: "Discord ID", required: true },
        ],
      },
      {
        name: "unwhitelist",
        description: "Remove player from whitelist",
        options: [{ name: "serial", type: 3, description: "MTA Serial", required: true }],
      },
      {
        name: "removeverification",
        description: "Remove a verification",
        options: [{ name: "discord_id", type: 3, description: "Discord ID", required: true }],
      },
      {
        name: "verifycode",
        description: "Link a code to a Discord ID",
        options: [
          { name: "code", type: 3, description: "Verification Code", required: true },
          { name: "discord_id", type: 3, description: "Discord ID", required: true },
        ],
      },
      {
        name: "whitelistinfo",
        description: "View current whitelist entries",
      },
      {
        name: "mtaverify",
        description: "Send verify button",
        options: [
          {
            name: "channel",
            type: 7, // Channel type
            description: "Target channel",
            required: false,
          },
        ],
      },
    ],
    process.env.GUILD_ID
  );
});

// Clean expired attempts
setInterval(async () => {
  const connection = await pool.getConnection();
  try {
    await connection.execute("DELETE FROM verification_attempts WHERE expires_at <= NOW()");
  } catch (e) {
    console.error("Failed to cleanup expired codes", e);
  } finally {
    connection.release();
  }
}, 10 * 60 * 1000);

client.login(process.env.DISCORD_TOKEN);
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

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  const connection = await pool.getConnection();
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "apply") {
      const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("open_application_modal")
          .setLabel("🧾 Submit Application")
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle("📝 𝗠𝗧𝗔:𝗦𝗔 𝗥𝗢𝗟𝗘𝗣𝗟𝗔𝗬 𝗪𝗛𝗜𝗧𝗘𝗟𝗜𝗦𝗧 𝗔𝗣𝗣𝗟𝗜𝗖𝗔𝗧𝗜𝗢𝗡")
        .setColor(0x2C2F33)
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(
          "Welcome to the roleplay whitelist system!\n" +
            "1 | Apply and wait for approval or rejection.\n" +
            "2 | Fill the form properly or risk getting rejected."
        )
        .setFooter({ text: "MTA:SA Whitelist System", iconURL: client.user.displayAvatarURL() });

      return interaction.reply({ embeds: [embed], components: [button] });
    }

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

    if (interaction.isModalSubmit() && interaction.customId === "whitelist_application") {
      const serial = interaction.fields.getTextInputValue("serial");

      if (!/^[a-fA-F0-9]{32}$/.test(serial)) {
        return interaction.reply({ content: "❌ Serial must be 32 hex characters.", ephemeral: true });
      }

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
        await connection.execute("DELETE FROM whitelist_submissions WHERE discord_id = ?", [interaction.user.id]);
      }

      const fields = {
        irlName: interaction.fields.getTextInputValue("irl_name"),
        irlAge: interaction.fields.getTextInputValue("irl_age"),
        ingameName: interaction.fields.getTextInputValue("ingame_name"),
        ingameAge: interaction.fields.getTextInputValue("ingame_age"),
      };

      await connection.execute(
        `INSERT INTO whitelist_submissions (discord_id, irl_name, irl_age, ingame_name, ingame_age, serial, retries, experience)
         VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
        [interaction.user.id, fields.irlName, fields.irlAge, fields.ingameName, fields.ingameAge, serial, retries]
      );

      const embed = new EmbedBuilder()
        .setTitle("📝 New Whitelist Application")
        .setColor(0xFFA500)
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
        new ButtonBuilder().setCustomId(`accept_${interaction.user.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`reject_${interaction.user.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      );

      const logChannel = await client.channels.fetch(process.env.SUBMISSIONS_CHANNEL_ID);
      await logChannel.send({ embeds: [embed], components: [buttons] });

      return interaction.reply({ content: "✅ Your application has been submitted!", ephemeral: true });
    }

    if (interaction.isButton() && (interaction.customId.startsWith("accept_") || interaction.customId.startsWith("reject_"))) {
      const userId = interaction.customId.split("_")[1];
      const [rows] = await connection.execute("SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1", [userId]);

      if (rows.length === 0) {
        return interaction.reply({ content: "❌ Application not found in database.", ephemeral: true });
      }

      const { serial, discord_id } = rows[0];

      if (interaction.customId.startsWith("accept_")) {
        await pool.execute(
          `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id), added_by = VALUES(added_by)`,
          [serial, discord_id, interaction.user.tag]
        );

        const user = await client.users.fetch(discord_id).catch(() => null);
        if (user) await user.send(`🎉 Your whitelist application has been accepted!`);

        return interaction.update({ content: "✅ Application accepted and user whitelisted.", components: [] });
      }

      if (interaction.customId.startsWith("reject_")) {
        await pool.execute("UPDATE whitelist_submissions SET retries = retries + 1 WHERE discord_id = ?", [userId]);

        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await user.send(`❌ Your application has been rejected. Good luck next time.`);

        return interaction.update({ content: "❌ Application rejected.", components: [] });
      }
    }
  } catch (e) {
    console.error("❌ Error handling interaction:", e);
    if (!interaction.replied) {
      await interaction.reply({ content: "❌ Unexpected error occurred.", ephemeral: true });
    }
  } finally {
    connection.release();
  }
});

const commands = [
  new SlashCommandBuilder().setName("apply").setDescription("Apply for server whitelist"),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
      body: commands.map((cmd) => cmd.toJSON()),
    });
    console.log("✅ Slash command registered");
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error("❌ Failed to register slash command:", error);
  }
})();
