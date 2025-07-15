// ✅ MERGED DISCORD BOT FOR MTA:SA WHITELIST + VERIFICATION + APPLICATION
require("dotenv").config();
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
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const mysql = require("mysql2/promise");

// ✅ MySQL Setup
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// ✅ Discord Bot Setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// ✅ Commands
const commands = [
  new SlashCommandBuilder().setName("apply").setDescription("Apply for server whitelist"),
  new SlashCommandBuilder().setName("whitelistinfo").setDescription("View all whitelisted players"),
  new SlashCommandBuilder().setName("mtaverify").setDescription("Add verification button to channel"),
  new SlashCommandBuilder().setName("whitelist").setDescription("Add/update whitelist").addStringOption(o => o.setName("serial").setDescription("MTA Serial").setRequired(true)).addStringOption(o => o.setName("discord_id").setDescription("Discord ID").setRequired(true)),
  new SlashCommandBuilder().setName("unwhitelist").setDescription("Remove whitelist entry").addStringOption(o => o.setName("serial").setDescription("MTA Serial").setRequired(true)),
  new SlashCommandBuilder().setName("removeverification").setDescription("Remove verification").addStringOption(o => o.setName("discord_id").setDescription("Discord ID").setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
(async () => {
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
    body: commands.map(cmd => cmd.toJSON()),
  });
  console.log("✅ Slash commands registered");
  await client.login(process.env.DISCORD_TOKEN);
})();

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  const conn = await pool.getConnection();
  try {
    // /apply command
    if (interaction.isChatInputCommand() && interaction.commandName === 'apply') {
      const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_application_modal').setLabel('🧾 Submit Application').setStyle(ButtonStyle.Secondary)
      );
      const embed = new EmbedBuilder().setTitle('📝 Whitelist Application').setColor(0x2C2F33).setDescription('Click below to start the application.');
      return interaction.reply({ embeds: [embed], components: [button] });
    }

    // Modal trigger
    if (interaction.isButton() && interaction.customId === 'open_application_modal') {
      const modal = new ModalBuilder().setCustomId('whitelist_application').setTitle('Whitelist Application')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('irl_name').setLabel('IRL Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('irl_age').setLabel('IRL Age').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ingame_name').setLabel('In-game Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ingame_age').setLabel('Character Age').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('serial').setLabel('MTA Serial').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(32).setMaxLength(32))
        );
      return await interaction.showModal(modal);
    }

    // Modal submit
    if (interaction.isModalSubmit() && interaction.customId === 'whitelist_application') {
      const serial = interaction.fields.getTextInputValue('serial');
      if (!/^[a-fA-F0-9]{32}$/.test(serial)) return interaction.reply({ content: '❌ Invalid serial format.', ephemeral: true });

      const [existing] = await conn.execute('SELECT * FROM whitelist_submissions WHERE discord_id = ?', [interaction.user.id]);
      if (existing.length && existing[0].retries >= 1) return interaction.reply({ content: '❌ Already reapplied once.', ephemeral: true });

      await conn.execute('DELETE FROM whitelist_submissions WHERE discord_id = ?', [interaction.user.id]);
      await conn.execute(`INSERT INTO whitelist_submissions (discord_id, irl_name, irl_age, ingame_name, ingame_age, serial, retries)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [interaction.user.id, interaction.fields.getTextInputValue('irl_name'), interaction.fields.getTextInputValue('irl_age'), interaction.fields.getTextInputValue('ingame_name'), interaction.fields.getTextInputValue('ingame_age'), serial, existing.length ? 1 : 0]);

      const embed = new EmbedBuilder().setTitle('📝 New Application').setColor(0xFFA500)
        .addFields({ name: 'Serial', value: serial }, { name: 'Discord', value: `<@${interaction.user.id}>` });

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accept_${interaction.user.id}`).setLabel("✅ Accept").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`reject_${interaction.user.id}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger)
      );

      const logChannel = await client.channels.fetch(process.env.SUBMISSIONS_CHANNEL_ID);
      await logChannel.send({ embeds: [embed], components: [buttons] });
      return interaction.reply({ content: '✅ Submitted!', ephemeral: true });
    }

    // Accept / Reject
    if (interaction.isButton() && (interaction.customId.startsWith('accept_') || interaction.customId.startsWith('reject_'))) {
      const userId = interaction.customId.split('_')[1];
      const [rows] = await conn.execute('SELECT * FROM whitelist_submissions WHERE discord_id = ?', [userId]);
      if (!rows.length) return interaction.reply({ content: '❌ Application not found.', ephemeral: true });

      if (interaction.customId.startsWith('accept_')) {
        await conn.execute(`INSERT INTO mta_whitelist (mta_serial, discord_id, added_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)`, [rows[0].serial, rows[0].discord_id, interaction.user.tag]);
        return interaction.update({ content: '✅ Accepted.', components: [] });
      } else {
        await conn.execute('UPDATE whitelist_submissions SET retries = retries + 1 WHERE discord_id = ?', [userId]);
        return interaction.update({ content: '❌ Rejected.', components: [] });
      }
    }

    // /whitelistinfo
    if (interaction.isChatInputCommand() && interaction.commandName === 'whitelistinfo') {
      const [rows] = await conn.execute('SELECT * FROM mta_whitelist');
      if (!rows.length) return interaction.reply('ℹ️ No players are currently whitelisted');
      const embed = new EmbedBuilder().setTitle("📋 Whitelist Info").setColor(0x0099ff);
      rows.forEach(p => embed.addFields({ name: p.mta_serial, value: `<@${p.discord_id}>`, inline: true }));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /mtaverify
    if (interaction.isChatInputCommand() && interaction.commandName === 'mtaverify') {
      const embed = new EmbedBuilder().setTitle('🔗 MTA:SA Account Verification').setDescription('Click to verify your MTA:SA account.').setColor(0x00ff00);
      const verifyBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('verify_mta').setLabel('Verify MTA').setStyle(ButtonStyle.Success).setEmoji('✅')
      );
      await interaction.channel.send({ embeds: [embed], components: [verifyBtn] });
      return interaction.reply({ content: '✅ Button added.', ephemeral: true });
    }

    // /verify_mta button
    if (interaction.isButton() && interaction.customId === 'verify_mta') {
      await interaction.deferReply({ ephemeral: true });
      const [rows] = await conn.execute('SELECT mta_serial FROM mta_whitelist WHERE discord_id = ?', [interaction.user.id]);
      if (!rows.length) return interaction.editReply('❌ Not whitelisted.');
      const serial = rows[0].mta_serial;
      await conn.execute(`INSERT INTO mta_verifications (mta_serial, discord_id, verified_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 5 MINUTE)) ON DUPLICATE KEY UPDATE verified_at = NOW(), expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)`, [serial, interaction.user.id]);
      return interaction.editReply('✅ You are verified for 5 minutes. Join now!');
    }

    // /whitelist
    if (interaction.isChatInputCommand() && interaction.commandName === 'whitelist') {
      const serial = interaction.options.getString('serial');
      const discordId = interaction.options.getString('discord_id');
      await conn.execute(`INSERT INTO mta_whitelist (mta_serial, discord_id, added_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id)`, [serial, discordId, interaction.user.id]);
      return interaction.reply(`✅ Whitelisted ${serial}`);
    }

    // /unwhitelist
    if (interaction.isChatInputCommand() && interaction.commandName === 'unwhitelist') {
      const serial = interaction.options.getString('serial');
      await conn.execute('DELETE FROM mta_verifications WHERE mta_serial = ?', [serial]);
      await conn.execute('DELETE FROM mta_whitelist WHERE mta_serial = ?', [serial]);
      return interaction.reply(`✅ Removed ${serial}`);
    }

    // /removeverification
    if (interaction.isChatInputCommand() && interaction.commandName === 'removeverification') {
      const discordId = interaction.options.getString('discord_id');
      await conn.execute('DELETE FROM mta_verifications WHERE discord_id = ?', [discordId]);
      return interaction.reply(`✅ Removed verification for <@${discordId}>.`);
    }
  } catch (err) {
    console.error('❌ Error:', err);
    if (!interaction.replied) await interaction.reply({ content: '❌ Unexpected error.', ephemeral: true });
  } finally {
    conn.release();
  }
});

// ✅ Web server for keep-alive
const app = express();
app.get("/", (req, res) => res.send("Bot is alive!"));
app.listen(process.env.PORT || 3000);
