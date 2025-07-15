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
  PermissionsBitField
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

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.on(Events.InteractionCreate, async (interaction) => {
  const conn = await pool.getConnection();
  try {
    // /apply command
    if (interaction.isChatInputCommand() && interaction.commandName === 'apply') {
      const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('open_application_modal').setLabel('🧾 Submit Application').setStyle(ButtonStyle.Secondary)
      );
      const embed = new EmbedBuilder()
        .setTitle('📝 𝗠𝗧𝗔:𝗦𝗔 𝗥𝗢𝗟𝗘𝗣𝗟𝗔𝗬 𝗪𝗛𝗜𝗧𝗘𝗟𝗜𝗦𝗧 𝗔𝗣𝗣𝗟𝗜𝗖𝗔𝗧𝗜𝗢𝗡')
        .setColor(0x2C2F33)
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription('Welcome to the roleplay whitelist system!\n1 | Apply and wait for approval or rejection.\n2 | Fill the form properly or risk getting rejected.')
        .setFooter({ text: 'MTA:SA Whitelist System', iconURL: client.user.displayAvatarURL() });
      return interaction.reply({ embeds: [embed], components: [button] });
    }

    // Modal trigger
    if (interaction.isButton() && interaction.customId === 'open_application_modal') {
      const modal = new ModalBuilder().setCustomId('whitelist_application').setTitle('✨ Whitelist Application')
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('irl_name').setLabel('🧑‍🦱 Your Full Name (IRL)').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('irl_age').setLabel('🎂 Your Age (IRL)').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ingame_name').setLabel('🎮 In-game Name').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ingame_age').setLabel('🕹️ Character Age').setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('serial').setLabel('🔐 MTA Serial (32 characters)').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(32).setMaxLength(32))
        );
      return await interaction.showModal(modal);
    }

    // Modal submit
    if (interaction.isModalSubmit() && interaction.customId === 'whitelist_application') {
      const serial = interaction.fields.getTextInputValue('serial');
      if (!/^[a-fA-F0-9]{32}$/.test(serial)) return interaction.reply({ content: '❌ Serial must be 32 hex characters.', ephemeral: true });

      const [existing] = await conn.execute('SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1', [interaction.user.id]);
      if (existing.length && existing[0].retries >= 1) return interaction.reply({ content: '❌ You have already reapplied once after rejection.', ephemeral: true });

      await conn.execute('DELETE FROM whitelist_submissions WHERE discord_id = ?', [interaction.user.id]);
      await conn.execute(`INSERT INTO whitelist_submissions (discord_id, irl_name, irl_age, ingame_name, ingame_age, serial, retries, experience) VALUES (?, ?, ?, ?, ?, ?, ?, '')`, [interaction.user.id, interaction.fields.getTextInputValue('irl_name'), interaction.fields.getTextInputValue('irl_age'), interaction.fields.getTextInputValue('ingame_name'), interaction.fields.getTextInputValue('ingame_age'), serial, existing.length ? 1 : 0]);

      const embed = new EmbedBuilder().setTitle('📝 New Whitelist Application').setColor(0xFFA500).setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: '🧑‍🦱 IRL Name', value: `\`${interaction.fields.getTextInputValue('irl_name')}\``, inline: true },
          { name: '🎂 IRL Age', value: `\`${interaction.fields.getTextInputValue('irl_age')}\``, inline: true },
          { name: '🎮 In-game Name', value: `\`${interaction.fields.getTextInputValue('ingame_name')}\``, inline: true },
          { name: '🕹️ Character Age', value: `\`${interaction.fields.getTextInputValue('ingame_age')}\``, inline: true },
          { name: '🔐 MTA Serial', value: `\`${serial}\``, inline: false },
          { name: '🔁 Reapply Count', value: `\`${existing.length ? 1 : 0}\` / \`1\``, inline: true },
          { name: '👤 Discord', value: `<@${interaction.user.id}>`, inline: true },
          { name: '🆔 Discord ID', value: `\`${interaction.user.id}\``, inline: true }
        )
        .setFooter({ text: 'Whitelist System', iconURL: client.user.displayAvatarURL() })
        .setTimestamp();

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accept_${interaction.user.id}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`reject_${interaction.user.id}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger)
      );

      const logChannel = await client.channels.fetch(process.env.SUBMISSIONS_CHANNEL_ID);
      await logChannel.send({ embeds: [embed], components: [buttons] });

      return interaction.reply({ content: '✅ Your application has been submitted!', ephemeral: true });
    }

    // Accept / Reject
    if (interaction.isButton() && (interaction.customId.startsWith('accept_') || interaction.customId.startsWith('reject_'))) {
      const userId = interaction.customId.split('_')[1];
      const [rows] = await conn.execute('SELECT * FROM whitelist_submissions WHERE discord_id = ? LIMIT 1', [userId]);
      if (!rows.length) return interaction.reply({ content: '❌ Application not found in database.', ephemeral: true });

      const { serial, discord_id } = rows[0];

      if (interaction.customId.startsWith('accept_')) {
        await conn.execute(`INSERT INTO mta_whitelist (mta_serial, discord_id, added_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id), added_by = VALUES(added_by)`, [serial, discord_id, interaction.user.tag]);
        const user = await client.users.fetch(discord_id).catch(() => null);
        if (user) await user.send(`🎉 Your whitelist application has been accepted!`);
        return interaction.update({ content: '✅ Application accepted and user whitelisted.', components: [] });
      } else {
        await conn.execute('UPDATE whitelist_submissions SET retries = retries + 1 WHERE discord_id = ?', [userId]);
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await user.send(`❌ Your application has been rejected. Good luck next time.`);
        return interaction.update({ content: '❌ Application rejected.', components: [] });
      }
    }

    // ... keep rest unchanged
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
