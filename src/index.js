// src/index.js
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder
} from 'discord.js';

import {
  handleListBosses,
  handleSubscribeBoss,
  handleSubscribeAll,
  handleUnsubscribeBoss,
  handleUnsubscribeAll,
  handleSubscriptions,
  handleUpcoming,
  handleKilled,
  handleStatus,
  handleDetails,
  handleDrops,
  handleReset,
  handleSetup,
  handleSetCommandRole,
  handleSetAlert,
  buildUpcomingEmbed
} from './commands/handlers.js';

import {
  listBosses,
  listUserSubscriptions,
  getGuildSettings,
  upsertGuildSettings,
  getAllGuildSettings,
  getAllBossRows,
  computeWindow,
  hasChannelBeenPinged,
  markChannelPinged
} from './db.js';

import { nowUtc, fmtUtc, toUnixSeconds } from './utils/time.js';

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Ready
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

// --------- Autocomplete for boss names ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === 'boss') {
        const query = String(focused.value || '').toLowerCase();
        let sourceNames;
        if (interaction.commandName === 'unsubscribe') {
          const sub = interaction.options.getSubcommand(false);
          if (!sub || sub === 'boss') {
            sourceNames = listUserSubscriptions(interaction.user.id, interaction.guildId);
          } else {
            sourceNames = listBosses();
          }
        } else {
          sourceNames = listBosses();
        }
        const names = sourceNames.filter(n => n.toLowerCase().includes(query)).slice(0, 25);
        return interaction.respond(names.map(n => ({ name: n, value: n })));
      }
    } catch (err) {
      console.warn('Autocomplete error:', err);
    }
    return;
  }
});

// --------- Setup wizard component handlers ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isAnySelectMenu() && !interaction.isButton()) return;

  // Only allow admins to use setup components
  const gs = getGuildSettings(interaction.guildId) || {};
  const isAdmin =
    gs?.admin_role_id
      ? interaction.member.roles.cache.has(gs.admin_role_id)
      : interaction.member.permissions.has('ManageGuild');

  if (!isAdmin) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use the setup wizard.' });
  }

  try {
    if (interaction.customId === 'setup:channel' && interaction.isChannelSelectMenu()) {
      const ch = interaction.channels.first();
      upsertGuildSettings(interaction.guildId, { alert_channel_id: ch?.id ?? null });
      return interaction.reply({ ephemeral: true, content: `Alert channel set to ${ch ? `<#${ch.id}>` : '-'}.` });
    }

    if (interaction.customId === 'setup:role' && interaction.isRoleSelectMenu()) {
      const role = interaction.roles.first();
      upsertGuildSettings(interaction.guildId, { ping_role_id: role?.id ?? null });
      return interaction.reply({ ephemeral: true, content: `Ping role set to ${role ? `<@&${role.id}>` : '-'}.` });
    }

    if (interaction.customId === 'setup:hours' && interaction.isStringSelectMenu()) {
      const hours = parseInt(interaction.values[0], 10);
      upsertGuildSettings(interaction.guildId, { upcoming_hours: hours });
      return interaction.reply({ ephemeral: true, content: `Dashboard lookahead set to **${hours}h**.` });
    }

    if (interaction.customId === 'setup:minutes' && interaction.isStringSelectMenu()) {
      const minutes = parseInt(interaction.values[0], 10);
      upsertGuildSettings(interaction.guildId, { ping_minutes: minutes });
      return interaction.reply({ ephemeral: true, content: `Ping lead time set to **${minutes} minutes**.` });
    }

    if (interaction.customId === 'setup:make_message' && interaction.isButton()) {
      const settings = getGuildSettings(interaction.guildId) || {};
      if (!settings.alert_channel_id) {
        return interaction.reply({ ephemeral: true, content: 'Select an **Alert Channel** first.' });
      }
      const channel = await interaction.guild.channels.fetch(settings.alert_channel_id).catch(() => null);
      if (!channel) {
        return interaction.reply({ ephemeral: true, content: 'Configured alert channel is invalid or missing permissions.' });
      }

      // Create or update the dashboard message
      const hours = settings.upcoming_hours ?? 3;
      const embed = buildUpcomingEmbed(hours);

      let messageId = settings.alert_message_id;
      let msg = null;
      if (messageId) {
        msg = await channel.messages.fetch(messageId).catch(() => null);
      }
      if (msg) {
        await msg.edit({ embeds: [embed] });
      } else {
        msg = await channel.send({ embeds: [embed] });
        messageId = msg.id;
        upsertGuildSettings(interaction.guildId, { alert_message_id: messageId });
      }

      return interaction.reply({ ephemeral: true, content: 'Dashboard message is created/updated.' });
    }
  } catch (err) {
    console.error('Setup component error:', err);
    if (!interaction.replied) {
      await interaction.reply({ ephemeral: true, content: 'Error processing selection.' }).catch(() => {});
    }
  }
});

// --------- Slash command router ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'listbosses':      await handleListBosses(interaction); break;
      case 'subscribe': {
        const sub = interaction.options.getSubcommand();
        if (sub === 'boss') await handleSubscribeBoss(interaction);
        else if (sub === 'all') await handleSubscribeAll(interaction);
        else await interaction.reply({ ephemeral: true, content: 'Unknown /subscribe subcommand.' });
        break;
      }
      case 'unsubscribe': {
        const sub = interaction.options.getSubcommand();
        if (sub === 'boss') await handleUnsubscribeBoss(interaction);
        else if (sub === 'all') await handleUnsubscribeAll(interaction);
        else await interaction.reply({ ephemeral: true, content: 'Unknown /unsubscribe subcommand.' });
        break;
      }
      case 'subscriptions':   await handleSubscriptions(interaction); break;
      case 'upcoming':        await handleUpcoming(interaction); break;
      case 'killed':          await handleKilled(interaction); break;
      case 'status':          await handleStatus(interaction); break;
      case 'details':         await handleDetails(interaction); break;
      case 'drops':           await handleDrops(interaction); break;
      case 'reset':           await handleReset(interaction); break;
      case 'setup':           await handleSetup(interaction); break;
      case 'setcommandrole':  await handleSetCommandRole(interaction); break;
      case 'setalert':        await handleSetAlert(interaction); break;
      default:
        await interaction.reply({ ephemeral: true, content: 'Unknown command.' });
    }
  } catch (err) {
    console.error(`Error handling /${interaction.commandName}:`, err);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ ephemeral: true, content: 'Something went wrong executing that command.' }).catch(() => {});
    } else {
      await interaction.reply({ ephemeral: true, content: 'Something went wrong executing that command.' }).catch(() => {});
    }
  }
});

// --------- Scheduler: update dashboard + ping role ----------
async function tickOnce() {
  const guilds = getAllGuildSettings();
  const now = nowUtc();

  for (const gs of guilds) {
    if (!gs.alert_channel_id) continue;

    // 1) Update dashboard message if configured
    const hours = gs.upcoming_hours ?? 3;
    if (gs.alert_message_id) {
      try {
        const guild = await client.guilds.fetch(gs.guild_id).catch(() => null);
        if (!guild) continue;
        const channel = await guild.channels.fetch(gs.alert_channel_id).catch(() => null);
        if (!channel) continue;

        const embed = buildUpcomingEmbed(hours);
        const msg = await channel.messages.fetch(gs.alert_message_id).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
        } else {
          // recreate if missing
          const newMsg = await channel.send({ embeds: [embed] });
          upsertGuildSettings(gs.guild_id, { alert_message_id: newMsg.id });
        }
      } catch { /* ignore per-guild errors */ }
    }

    // 2) Ping role if a window is approaching
    if (gs.ping_role_id && gs.ping_minutes) {
      const rows = getAllBossRows();
      const channelGuild = await client.guilds.fetch(gs.guild_id).catch(() => null);
      const channel = channelGuild ? await channelGuild.channels.fetch(gs.alert_channel_id).catch(() => null) : null;
      if (!channel) continue;

      for (const b of rows) {
        if (!b.last_killed_at_utc) continue;
        const w = computeWindow(b);
        if (!w) continue;

        const minutesBefore = gs.ping_minutes;
        const threshold = w.start.minus({ minutes: minutesBefore });
        const windowKey = `${b.name}:${b.last_killed_at_utc}`;
        if (hasChannelBeenPinged(gs.guild_id, b.name, windowKey)) continue;

        // If we're between threshold and start → ping
        if (now >= threshold && now < w.start) {
          try {
            await channel.send({
              content: `<@&${gs.ping_role_id}>`,
              allowedMentions: { roles: [gs.ping_role_id] },
              embeds: [
                new EmbedBuilder()
                  .setTitle(`Spawn Approaching - ${b.name}`)
                  .addFields(
                    { name: 'Starts In', value: `**Your Time:** <t:${toUnixSeconds(w.start)}:f>\n**Server Time (UTC):** ${fmtUtc(w.start)}` },
                    { name: 'Window Ends', value: `**Your Time:** <t:${toUnixSeconds(w.end)}:f>\n**Server Time (UTC):** ${fmtUtc(w.end)}` }
                  )
                  .setColor(0xF39C12)
              ]
            });
            markChannelPinged(gs.guild_id, b.name, windowKey);
          } catch { /* ignore send errors */ }
        }
      }
    }
  }
}

setInterval(() => { tickOnce().catch(() => {}); }, 60 * 1000);

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

client.login(DISCORD_TOKEN);
