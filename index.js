// ✅ FULLY FIXED MTA:SA DISCORD BOT WITH ROLE RESTRICTIONS
require("dotenv").config();
const keep_alive = require("./keep_alive.js");
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
  Events,
} = require("discord.js");
const mysql = require("mysql2/promise");
const axios = require("axios");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

const MTA_SERVER = {
  host: "89.42.88.252",
  port: 22005,
  auth: {
    user: "admin",
    pass: "YourSecurePassword123!",
  },
};

function logError(context, error, interaction = null) {
  console.error(`\n[ERROR] ${context}:`, error);
}

function hasAdminRole(member) {
  const allowedRoleId = process.env.ADMIN_ROLE_ID;
  return member.roles.cache.has(allowedRoleId);
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

client.on(Events.InteractionCreate, async (interaction) => {
  const connection = await pool.getConnection();

  try {
    // Button: verify_mta
    if (interaction.isButton() && interaction.customId === "verify_mta") {
      await interaction.deferReply({ ephemeral: true });
      const [whitelist] = await connection.execute(
        `SELECT mta_serial FROM mta_whitelist WHERE discord_id = ? LIMIT 1`,
        [interaction.user.id]
      );

      if (!whitelist.length) {
        return interaction.editReply("❌ You must be whitelisted first.");
      }

      const serial = whitelist[0].mta_serial;
      await connection.execute(
        `INSERT INTO mta_verifications (mta_serial, discord_id, verified_at, expires_at)
         VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))
         ON DUPLICATE KEY UPDATE verified_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
        [serial, interaction.user.id]
      );

      return interaction.editReply(
        "✅ Temporary verification active! You have 5 minutes to join the server."
      );
    }

    // Command: whitelist
    if (interaction.isCommand() && interaction.commandName === "whitelist") {
      if (!hasAdminRole(interaction.member)) {
        return safeReply(interaction, "❌ You do not have permission to use this command.");
      }

      const serial = interaction.options.getString("serial");
      const discordId = interaction.options.getString("discord_id");

      if (!/^[a-fA-F0-9]{32}$/.test(serial)) {
        return safeReply(interaction, "❌ Invalid MTA serial format");
      }

      await connection.execute(
        `INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)`,
        [serial, discordId, interaction.user.id]
      );

      return interaction.reply({
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

    // Command: unwhitelist
    if (interaction.isCommand() && interaction.commandName === "unwhitelist") {
      if (!hasAdminRole(interaction.member)) {
        return safeReply(interaction, "❌ You do not have permission to use this command.");
      }

      const serial = interaction.options.getString("serial");
      const [check] = await connection.execute(
        `SELECT * FROM mta_whitelist WHERE mta_serial = ?`,
        [serial]
      );

      if (!check.length) {
        return interaction.reply(`❌ Serial ${serial} not found in whitelist`);
      }

      await connection.execute(`DELETE FROM mta_verifications WHERE mta_serial = ?`, [serial]);
      await connection.execute(
        `DELETE FROM permanent_verifications WHERE discord_id = (
          SELECT discord_id FROM mta_whitelist WHERE mta_serial = ?
        )`,
        [serial]
      );
      await connection.execute(`DELETE FROM mta_whitelist WHERE mta_serial = ?`, [serial]);

      try {
        await axios.get(
          `http://${MTA_SERVER.host}:${MTA_SERVER.port}/exec?command=serialkick%20${serial}`,
          { auth: MTA_SERVER.auth, timeout: 3000 }
        );
      } catch (kickError) {
        logError("unwhitelistKick", kickError);
      }

      return interaction.reply({
        content: "✅ Whitelist Updated",
        embeds: [
          new EmbedBuilder()
            .setColor(0x00ff00)
            .setDescription(`Removed ${serial} from whitelist`),
        ],
      });
    }

    // Command: removeverification
    if (interaction.isCommand() && interaction.commandName === "removeverification") {
      if (!hasAdminRole(interaction.member)) {
        return safeReply(interaction, "❌ You do not have permission to use this command.");
      }

      const discordId = interaction.options.getString("discord_id");
      await connection.execute(`DELETE FROM mta_verifications WHERE discord_id = ?`, [discordId]);
      await connection.execute(`DELETE FROM permanent_verifications WHERE discord_id = ?`, [discordId]);

      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle("✅ Verification Removed")
            .setDescription(`Removed verification for <@${discordId}>`),
        ],
      });
    }

    // Command: whitelistinfo
    if (interaction.isCommand() && interaction.commandName === "whitelistinfo") {
      if (!hasAdminRole(interaction.member)) {
        return safeReply(interaction, "❌ You do not have permission to use this command.");
      }

      const [rows] = await connection.execute(
        `SELECT w.mta_serial, w.discord_id, w.added_by, w.added_at,
         IF(p.discord_id IS NULL, '❌ Not Verified', '✅ Verified') AS status
         FROM mta_whitelist w
         LEFT JOIN mta_verifications p ON w.discord_id = p.discord_id`
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
          }))
        );

        if (i === 0)
          await interaction.reply({ embeds: [embed], ephemeral: true });
        else await interaction.followUp({ embeds: [embed], ephemeral: true });
      }
    }

    // Command: mtaverify
    if (interaction.isCommand() && interaction.commandName === "mtaverify") {
      if (!hasAdminRole(interaction.member)) {
        return safeReply(interaction, "❌ You do not have permission to use this command.");
      }

      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle("🔗 MTA:SA Account Verification")
        .setDescription(
          "**Step 1️⃣:** Link your MTA:SA account with Discord.\n**Step 2️⃣:** Click the button below to verify.\n**Step 3️⃣:** Join the server with the same account.\n\n⚠️ **Note:** This verification is required to play!"
        );

      const verifyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("verify_mta")
          .setLabel("Verify MTA Account")
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅")
      );

      await channel.send({ embeds: [embed], components: [verifyButton] });
      return safeReply(interaction, `✅ Verification button added to ${channel}`);
    }
  } catch (err) {
    logError("interactionHandler", err, interaction);
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
      process.env.GUILD_ID
    );

    console.log("✅ Commands registered");
  } catch (error) {
    logError("commandRegistration", error);
  }
});

const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Web server running on port ${process.env.PORT || 3000}`);
});

client.login(process.env.DISCORD_TOKEN).catch((error) => {
  logError("botLogin", error);
  process.exit(1);
});
