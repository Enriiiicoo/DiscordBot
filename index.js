// ✅ FIXED VERSION OF YOUR BOT CODE (Only ONE modal handler, safe .showModal usage)

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  Events
} = require('discord.js');

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const { SlashCommandBuilder } = require('@discordjs/builders');

const commands = [
  new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Apply for server whitelist')
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    console.log('✅ Slash command registered');
  } catch (error) {
    console.error('❌ Failed to register slash command:', error);
  }
  await client.login(process.env.DISCORD_TOKEN);
})();

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Handle /apply command
    if (interaction.isChatInputCommand() && interaction.commandName === 'apply') {
      const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_application_modal')
          .setLabel('🧾 Submit Application')
          .setStyle(ButtonStyle.Secondary)
      );

      const embed = new EmbedBuilder()
        .setTitle('📝 𝗠𝗧𝗔:𝗦𝗔 𝗥𝗢𝗟𝗘𝗣𝗟𝗔𝗬 𝗪𝗛𝗜𝗧𝗘𝗟𝗜𝗦𝗧 𝗔𝗣𝗣𝗟𝗜𝗖𝗔𝗧𝗜𝗢𝗡')
        .setColor(0x2C2F33)
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(
          'Welcome to the roleplay whitelist system!\n' +
          '1 | Apply and wait for approval or rejection.\n' +
          '2 | Fill the form properly or risk getting rejected.'
        )
        .setFooter({ text: 'MTA:SA Whitelist System', iconURL: client.user.displayAvatarURL() });

      return interaction.reply({ embeds: [embed], components: [button] });
    }

    // Handle button click (show modal only, no DB checks yet)
    if (interaction.isButton() && interaction.customId === 'open_application_modal') {
      const modal = new ModalBuilder()
        .setCustomId('whitelist_application')
        .setTitle('✨ Whitelist Application')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('irl_name')
              .setLabel('🧑‍🦱 Your Full Name (IRL)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('irl_age')
              .setLabel('🎂 Your Age (IRL)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ingame_name')
              .setLabel('🎮 In-game Name')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('ingame_age')
              .setLabel('🕹️ Character Age')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('serial')
              .setLabel('🔐 MTA Serial (32 characters)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(32)
              .setMaxLength(32)
          )
        );

      return await interaction.showModal(modal);
    }

    // Handle modal submission
    if (interaction.isModalSubmit() && interaction.customId === 'whitelist_application') {
      const serial = interaction.fields.getTextInputValue('serial');

      if (!/^[a-fA-F0-9]{32}$/.test(serial)) {
        return interaction.reply({ content: '❌ Serial must be 32 hex characters.', ephemeral: true });
      }

      const [existing] = await pool.execute(
        'SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1',
        [interaction.user.id]
      );

      let retries = 0;
      if (existing.length > 0) {
        if (existing[0].retries >= 1) {
          return interaction.reply({
            content: '❌ You have already reapplied once after rejection.',
            ephemeral: true
          });
        }
        retries = existing[0].retries + 1;
        await pool.execute('DELETE FROM whitelist_submissions WHERE discord_id = ?', [interaction.user.id]);
      }

      const fields = {
        irlName: interaction.fields.getTextInputValue('irl_name'),
        irlAge: interaction.fields.getTextInputValue('irl_age'),
        ingameName: interaction.fields.getTextInputValue('ingame_name'),
        ingameAge: interaction.fields.getTextInputValue('ingame_age')
      };

      await pool.execute(
        `INSERT INTO whitelist_submissions (discord_id, irl_name, irl_age, ingame_name, ingame_age, serial, retries, experience)
         VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
        [interaction.user.id, fields.irlName, fields.irlAge, fields.ingameName, fields.ingameAge, serial, retries]
      );

      const embed = new EmbedBuilder()
        .setTitle('📝 New Whitelist Application')
        .setColor(0xFFA500)
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: '🧑‍🦱 IRL Name', value: `\`${fields.irlName}\``, inline: true },
          { name: '🎂 IRL Age', value: `\`${fields.irlAge}\``, inline: true },
          { name: '🎮 In-game Name', value: `\`${fields.ingameName}\``, inline: true },
          { name: '🕹️ Character Age', value: `\`${fields.ingameAge}\``, inline: true },
          { name: '🔐 MTA Serial', value: `\`${serial}\``, inline: false },
          { name: '🔁 Reapply Count', value: `\`${retries}\` / \`1\``, inline: true },
          { name: '👤 Discord', value: `<@${interaction.user.id}>`, inline: true },
          { name: '🆔 Discord ID', value: `\`${interaction.user.id}\``, inline: true }
        )
        .setFooter({ text: 'Whitelist System', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`accept_${interaction.user.id}`)
          .setLabel('✅ Accept')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject_${interaction.user.id}`)
          .setLabel('❌ Reject')
          .setStyle(ButtonStyle.Danger)
      );

      const logChannel = await client.channels.fetch(process.env.SUBMISSIONS_CHANNEL_ID);
      await logChannel.send({ embeds: [embed], components: [buttons] });

      return interaction.reply({ content: '✅ Your application has been submitted!', ephemeral: true });
    }

    // Handle accept/reject buttons
    if (interaction.isButton() && (interaction.customId.startsWith('accept_') || interaction.customId.startsWith('reject_'))) {
      const userId = interaction.customId.split('_')[1];
      const [rows] = await pool.execute('SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1', [userId]);

      if (rows.length === 0) {
        return interaction.reply({ content: '❌ Application not found in database.', ephemeral: true });
      }

      const { serial, discord_id } = rows[0];

      if (interaction.customId.startsWith('accept_')) {
        await pool.execute(
          `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id), added_by = VALUES(added_by)`,
          [serial, discord_id, interaction.user.tag]
        );

        const user = await client.users.fetch(discord_id).catch(() => null);
        if (user) await user.send(`🎉 Your whitelist application has been accepted!`);

        return interaction.update({ content: '✅ Application accepted and user whitelisted.', components: [] });
      }

      if (interaction.customId.startsWith('reject_')) {
        await pool.execute('UPDATE whitelist_submissions SET retries = retries + 1 WHERE discord_id = ?', [userId]);

        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await user.send(`❌ Your application has been rejected. Good luck next time.`);

        return interaction.update({ content: '❌ Application rejected.', components: [] });
      }
    }
  } catch (error) {
    console.error('❌ Error handling interaction:', error);
    if (!interaction.replied) {
      await interaction.reply({ content: '❌ Unexpected error occurred.', ephemeral: true });
    }
  }
});


// ✅ FULLY FIXED MTA:SA DISCORD BOT WITH WORKING COMMANDS
const keep_alive = require('./keep_alive.js')
const mysql = require("mysql2/promise");
const axios = require("axios");

// ✅ Database Configuration
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
};

const pool = mysql.createPool({
  ...dbConfig,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

// ✅ MTA Server Configuration
const MTA_SERVER = {
  host: ":89.42.88.252",
  port: 22005,
  timeout: 5000,
  auth: {
    user: "admin",
    pass: "YourSecurePassword123!",
  },
};

function logError(context, error, interaction = null) {
  const errorInfo = {
    timestamp: new Date().toISOString(),
    context,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
      response: error.response?.data,
    },
    interaction: interaction
      ? {
          type: interaction.isButton()
            ? "button"
            : interaction.isCommand()
              ? "command"
              : "unknown",
          id: interaction.id,
          command: interaction.isCommand() ? interaction.commandName : null,
          customId: interaction.isButton() ? interaction.customId : null,
        }
      : null,
  };
  console.error("🚨 ERROR:", JSON.stringify(errorInfo, null, 2));
}

async function safeReply(interaction, content, options = {}) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(
        typeof content === "string" ? { content, ...options } : content,
      );
    }
    return await interaction.reply(
      typeof content === "string" ? { content, ...options } : content,
    );
  } catch (error) {
    logError("safeReply", error, interaction);
  }
}

// ✅ Main Interaction Handler
client.on("interactionCreate", async (interaction) => {
  const connection = await pool.getConnection();

  try {
    // ✅ Button: verify_mta
    if (interaction.isButton() && interaction.customId === "verify_mta") {
      await interaction.deferReply({ ephemeral: true });

      const [whitelist] = await connection.execute(
        `SELECT mta_serial FROM mta_whitelist WHERE discord_id = ? LIMIT 1`,
        [interaction.user.id],
      );

      if (!whitelist.length) {
        return interaction.editReply("❌ You must be whitelisted first.");
      }

      const serial = whitelist[0].mta_serial;

      await connection.execute(
        `INSERT INTO mta_verifications (mta_serial, discord_id, verified_at, expires_at)
         VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))
         ON DUPLICATE KEY UPDATE verified_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
        [serial, interaction.user.id],
      );

      await interaction.editReply(
        "✅ Temporary verification active! You have 5 minutes to join the server.",
      );
    }

    // ✅ Command: whitelist
    if (interaction.isCommand() && interaction.commandName === "whitelist") {
      const serial = interaction.options.getString("serial");
      const discordId = interaction.options.getString("discord_id");

      if (!/^[a-fA-F0-9]{32}$/.test(serial)) {
        return safeReply(interaction, "❌ Invalid MTA serial format");
      }

      await connection.execute(
        `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)`,
        [serial, discordId, interaction.user.id],
      );

      await interaction.reply({
        content: "✅ Whitelist Updated",
        embeds: [
          new EmbedBuilder()
            .setColor(0x00ff00)
            .addFields(
              { name: "MTA Serial", value: serial, inline: true },
              { name: "Discord User", value: `<@${discordId}>`, inline: true },
              {
                name: "Whitelisted by",
                value: `<@${interaction.user.id}>`,
                inline: true,
              },
            ),
        ],
        ephemeral: true,
      });
    }

    // ✅ Command: unwhitelist
    if (interaction.isCommand() && interaction.commandName === "unwhitelist") {
      const serial = interaction.options.getString("serial");

      const [check] = await connection.execute(
        `SELECT * FROM mta_whitelist WHERE mta_serial = ?`,
        [serial],
      );

      if (!check.length) {
        return interaction.reply(`❌ Serial ${serial} not found in whitelist`);
      }

      // ✅ First delete from child tables
      await connection.execute(
        `DELETE FROM mta_verifications WHERE mta_serial = ?`,
        [serial],
      );

      // ✅ Optionally also clean up permanent verification if needed
      await connection.execute(
        `DELETE FROM permanent_verifications WHERE discord_id = (
          SELECT discord_id FROM mta_whitelist WHERE mta_serial = ?
        )`,
        [serial],
      );

      // ✅ Now safely delete from the main whitelist
      await connection.execute(
        `DELETE FROM mta_whitelist WHERE mta_serial = ?`,
        [serial],
      );

      try {
        await axios.get(
          `http://${MTA_SERVER.host}:${MTA_SERVER.port}/exec?command=serialkick%20${serial}`,
          {
            auth: MTA_SERVER.auth,
            timeout: 3000,
          },
        );
      } catch (kickError) {
        logError("unwhitelistKick", kickError);
      }

      await interaction.reply({
        content: "✅ Whitelist Updated",
        embeds: [
          new EmbedBuilder()
            .setColor(0x00ff00)
            .setDescription(`Removed ${serial} from whitelist`),
        ],
      });
    }

    // ✅ Command: removeverification
    if (
      interaction.isCommand() &&
      interaction.commandName === "removeverification"
    ) {
      const discordId = interaction.options.getString("discord_id");

      await connection.execute(
        `DELETE FROM mta_verifications WHERE discord_id = ?`,
        [discordId],
      );
      await connection.execute(
        `DELETE FROM permanent_verifications WHERE discord_id = ?`,
        [discordId],
      );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle("✅ Verification Removed")
            .setDescription(`Removed verification for <@${discordId}>`),
        ],
      });
    }

    // ✅ Command: whitelistinfo
    if (
      interaction.isCommand() &&
      interaction.commandName === "whitelistinfo"
    ) {
      const [rows] = await connection.execute(
        `SELECT w.mta_serial, w.discord_id, w.added_by, w.added_at,
         IF(p.discord_id IS NULL, '❌ Not Verified', '✅ Verified') AS status
         FROM mta_whitelist w
         LEFT JOIN mta_verifications p ON w.discord_id = p.discord_id`,
      );

      if (!rows.length)
        return interaction.reply("ℹ️ No players are currently whitelisted");

      const embed = new EmbedBuilder()
        .setTitle("📋 Whitelist Information")
        .setColor(0x0099ff);

      for (let i = 0; i < rows.length; i += 10) {
        const chunk = rows.slice(i, i + 10);
        embed.setFields(
          chunk.map((p) => ({
            name: `Serial: ${p.mta_serial.substring(0, 6)}...`,
            value: `User: <@${p.discord_id}>\nBy: <@${p.added_by}>\nStatus: ${p.status}\nAdded: ${new Date(p.added_at).toLocaleDateString()}`,
            inline: true,
          })),
        );

        if (i === 0)
          await interaction.reply({ embeds: [embed], ephemeral: true });
        else await interaction.followUp({ embeds: [embed], ephemeral: true });
      }
    }

    // ✅ Command: mtaverify
    if (interaction.isCommand() && interaction.commandName === "mtaverify") {
      if (!interaction.member.permissions.has("Administrator")) {
        return safeReply(
          interaction,
          "❌ You need Administrator permissions to use this command.",
        );
      }

      const channel =
        interaction.options.getChannel("channel") || interaction.channel;

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("🔗 MTA:SA Account Verification")
        .setDescription(
          "**Step 1️⃣:** Link your MTA:SA account with Discord.\n**Step 2️⃣:** Click the button below to verify.\n**Step 3️⃣:** Join the server with the same account.\n\n⚠️ **Note:** This verification is required to play!",
        )
        .setFooter({ text: "MTA:SA Server Verification System" });

      const verifyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("verify_mta")
          .setLabel("Verify MTA Account")
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅"),
      );

      await channel.send({ embeds: [embed], components: [verifyButton] });
      await safeReply(
        interaction,
        `✅ Verification button added to ${channel}`,
      );
    }
  } catch (error) {
    logError("interactionHandler", error, interaction);
    if (interaction.isRepliable())
      await safeReply(interaction, "❌ Something went wrong");
  } finally {
    connection.release();
  }
});

client.on("ready", async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);

  try {
    await client.application.commands.set(
      [
        {
          name: "whitelist",
          description: "Add/update whitelist entry",
          options: [
            {
              name: "serial",
              description: "32-character MTA serial",
              type: 3,
              required: true,
            },
            {
              name: "discord_id",
              description: "Discord user ID",
              type: 3,
              required: true,
            },
          ],
        },
        {
          name: "unwhitelist",
          description: "Remove whitelist entry",
          options: [
            {
              name: "serial",
              description: "MTA serial to remove",
              type: 3,
              required: true,
            },
          ],
        },
        {
          name: "removeverification",
          description: "Remove player verification",
          options: [
            {
              name: "discord_id",
              description: "Discord ID to remove",
              type: 3,
              required: true,
            },
          ],
        },
        {
          name: "whitelistinfo",
          description: "View all whitelisted players",
        },
        {
          name: "mtaverify",
          description: "Add verification button to channel",
          options: [
            {
              name: "channel",
              description: "Target channel",
              type: 7,
              required: false,
            },
          ],
        },
      ],
      process.env.GUILD_ID,
    );

    console.log("✅ Commands registered");
  } catch (error) {
    logError("commandRegistration", error);
    console.error("❌ Failed to register commands");
  }
});

const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  logError("botLogin", error);
  console.error("❌ Failed to login to Discord");
  process.exit(1);
});
