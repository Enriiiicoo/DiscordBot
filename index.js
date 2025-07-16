// Discord bot with all whitelist & verification logic + all commands restored
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

function hasAdminRole(member) {
  return member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

async function safeReply(interaction, content, options = {}) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(typeof content === "string" ? { content, ...options } : content);
    }
    return await interaction.reply(typeof content === "string" ? { content, ...options } : content);
  } catch (err) {
    console.error("safeReply error:", err);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton()) return;

  const connection = await pool.getConnection();
  try {
    // --- Verification Button ---
    if (interaction.isButton() && interaction.customId === "verify_mta") {
      await interaction.deferReply({ ephemeral: true });

      const [rows] = await connection.execute("SELECT mta_serial FROM mta_whitelist WHERE discord_id = ? LIMIT 1", [interaction.user.id]);
      if (!rows.length) return interaction.editReply("❌ You must be whitelisted first.");

      await connection.execute(`
        INSERT INTO mta_verifications (mta_serial, discord_id, verified_at, expires_at)
        VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE))
        ON DUPLICATE KEY UPDATE verified_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)
      `, [rows[0].mta_serial, interaction.user.id]);

      return interaction.editReply("✅ Verified for 5 minutes. Join the server now.");
    }

    // --- /verifycode ---
    if (interaction.isCommand() && interaction.commandName === "verifycode") {
      const code = interaction.options.getString("code").toUpperCase();
      const discordId = interaction.options.getString("discord_id");

      const [rows] = await connection.execute(
        "SELECT mta_serial, ip, nickname FROM verification_attempts WHERE code = ? AND expires_at > NOW() LIMIT 1",
        [code]
      );

      if (!rows.length) return safeReply(interaction, "❌ Invalid or expired code.");

      const { mta_serial, ip, nickname } = rows[0];
      await connection.execute(
        "UPDATE mta_whitelist SET ip = ?, nickname = ? WHERE mta_serial = ? AND discord_id = ?",
        [ip, nickname, mta_serial, discordId]
      );

      await connection.execute(`
        INSERT INTO verified_players (mta_serial, discord_id, ip, nickname, verified_at)
        VALUES (?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE ip = VALUES(ip), nickname = VALUES(nickname), verified_at = NOW()
      `, [mta_serial, discordId, ip, nickname]);

      await connection.execute("DELETE FROM verification_attempts WHERE code = ?", [code]);

      return safeReply(interaction, `✅ Code verified and data linked to \`${mta_serial}\`.\n🕵️ Now click the **Verify** button to temporarily verify.`);
    }

    // --- /whitelist ---
    if (interaction.isCommand() && interaction.commandName === "whitelist") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const serial = interaction.options.getString("serial");
      const discordId = interaction.options.getString("discord_id");

      await connection.execute(`
        INSERT INTO mta_whitelist (mta_serial, discord_id, added_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)
      `, [serial, discordId, interaction.user.id]);

      return interaction.reply({
        content: "✅ Whitelisted",
        embeds: [
          new EmbedBuilder().setColor(0x00ff00).addFields(
            { name: "Serial", value: serial, inline: true },
            { name: "Discord", value: `<@${discordId}>`, inline: true }
          ),
        ],
        ephemeral: true,
      });
    }

    // --- /unwhitelist ---
    if (interaction.isCommand() && interaction.commandName === "unwhitelist") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const serial = interaction.options.getString("serial");
      await connection.execute("DELETE FROM mta_whitelist WHERE mta_serial = ?", [serial]);
      await connection.execute("DELETE FROM mta_verifications WHERE mta_serial = ?", [serial]);

      return safeReply(interaction, `✅ Removed serial \`${serial}\` from whitelist.`);
    }

    // --- /removeverification ---
    if (interaction.isCommand() && interaction.commandName === "removeverification") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const discordId = interaction.options.getString("discord_id");
      await connection.execute("DELETE FROM mta_verifications WHERE discord_id = ?", [discordId]);
      return safeReply(interaction, `✅ Removed verification for <@${discordId}>`);
    }

    // --- /whitelistinfo ---
    if (interaction.isCommand() && interaction.commandName === "whitelistinfo") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");
      const [rows] = await connection.execute("SELECT * FROM mta_whitelist");
      if (!rows.length) return safeReply(interaction, "No entries.");

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

    // --- /mtaverify ---
    if (interaction.isCommand() && interaction.commandName === "mtaverify") {
      if (!hasAdminRole(interaction.member)) return safeReply(interaction, "❌ No permission.");

      const channel = interaction.options.getChannel("channel") || interaction.channel;
      const embed = new EmbedBuilder()
        .setTitle("🔗 MTA:SA Verification")
        .setColor(0x00ff00)
        .setDescription(
          `**Step 1:** Get a code in-game.\n**Step 2:** Use /verifycode <code>.\n**Step 3:** Press button below to temporarily verify.`
        );

      const verifyButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("verify_mta").setLabel("✅ Verify").setStyle(ButtonStyle.Success)
      );

      await channel.send({ embeds: [embed], components: [verifyButton] });
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
  await client.application.commands.set([
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
      options: [
        { name: "serial", type: 3, description: "MTA Serial", required: true },
      ],
    },
    {
      name: "removeverification",
      description: "Remove verification",
      options: [
        { name: "discord_id", type: 3, description: "Discord ID", required: true },
      ],
    },
    {
      name: "verifycode",
      description: "Link in-game code to Discord ID",
      options: [
        { name: "code", type: 3, description: "Verification Code", required: true },
        { name: "discord_id", type: 3, description: "Discord ID", required: true },
      ],
    },
    {
      name: "whitelistinfo",
      description: "View whitelist list",
    },
    {
      name: "mtaverify",
      description: "Send verify button",
      options: [
        { name: "channel", type: 7, description: "Target channel", required: false },
      ],
    },
  ], process.env.GUILD_ID);
});

// Ping cleanup
setInterval(async () => {
  const connection = await pool.getConnection();
  try {
    await connection.execute("DELETE FROM verification_attempts WHERE expires_at <= NOW()");
  } finally {
    connection.release();
  }
}, 10 * 60 * 1000);

client.login(process.env.DISCORD_TOKEN);
