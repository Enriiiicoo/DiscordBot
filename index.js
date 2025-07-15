require('dotenv').config();

const mysql = require("mysql2/promise");
const axios = require("axios");
const express = require("express");

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
  PermissionsBitField,
} = require('discord.js');

// Database config and pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// MTA Server config
const MTA_SERVER = {
  host: "89.42.88.252",
  port: 22005,
  timeout: 5000,
  auth: {
    user: "admin",
    pass: "YourSecurePassword123!",
  },
};

// Helper functions
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
            : interaction.isChatInputCommand()
              ? "command"
              : "unknown",
          id: interaction.id,
          command: interaction.isChatInputCommand() ? interaction.commandName : null,
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
  partials: [Partials.Channel],
});

// ... [DISCORD COMMANDS HANDLING SECTION OMITTED FOR BREVITY] ...

// Cleanup expired verifications every 30 seconds
setInterval(async () => {
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.execute(
      `DELETE FROM mta_verifications WHERE expires_at <= NOW()`
    );

    if (result.affectedRows > 0) {
      console.log(`[Verification Cleanup] Removed ${result.affectedRows} expired verification(s).`);
    }
  } catch (err) {
    console.error("[Verification Cleanup] Error:", err);
  } finally {
    connection.release();
  }
}, 30000);

// Express webserver
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

app.post("/api/player-join", async (req, res) => {
  try {
    const auth = req.headers.authorization;
    const expected = `Bearer ${process.env.JOIN_WEBHOOK_SECRET}`;

    if (auth !== expected) return res.status(403).send("Forbidden");

    const { nickname, serial, ip } = req.body;

    if (!nickname || !serial || !ip)
      return res.status(400).send("Missing required fields");

    const [rows] = await pool.execute(
      `SELECT discord_id FROM mta_whitelist WHERE mta_serial = ? LIMIT 1`,
      [serial]
    );

    const discordId = rows.length ? rows[0].discord_id : null;

    const embed = new EmbedBuilder()
      .setTitle("🟢 Player Joined Server")
      .setColor(0x00bfff)
      .addFields(
        { name: "👤 Nickname", value: nickname, inline: true },
        { name: "🔐 Serial", value: `\`${serial}\``, inline: true },
        { name: "🌐 IP", value: ip, inline: true },
        {
          name: "🤖 Discord",
          value: discordId ? `<@${discordId}> (\`${discordId}\`)` : "❌ Not Linked",
          inline: true
        }
      )
      .setTimestamp();

    const logChannel = await client.channels.fetch(process.env.JOIN_LOG_CHANNEL_ID);
    await logChannel.send({ embeds: [embed] });

    res.status(200).send("Logged");
  } catch (error) {
    console.error("Error logging join:", error);
    res.status(500).send("Error logging join");
  }
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
