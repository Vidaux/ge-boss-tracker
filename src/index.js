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
  markChannelPinged,
  listRegisteredUsers,
  hasUserBeenAlerted,
  markUserAlerted,
  listKilledBosses
} from './db.js';

import { nowUtc, fmtUtc, toUnixSeconds } from './utils/time.js';
import { bus } from './bus.js'; // <-- NEW: event bus

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
          sourceNames = (!sub || sub === 'boss')
            ? listUserSubscriptions(interaction.user.id, interaction.guildId)
            : listBosses();
        } else if (interaction.commandName === 'reset') {
          // ONLY bosses that currently have a recorded kill
          sourceNames = listKilledBosses();
        } else {
          sourceNames = listBosses();
        }

        const names = sourceNames
          .filter(n => n.toLowerCase().includes(query))
          .slice(0, 25);

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
  // Only care about these component types
  if (
    !(
      interaction.isStringSelectMenu() ||
      interaction.isRoleSelectMenu() ||
      interaction.isChannelSelectMenu() ||
      interaction.isButton()
    )
  ) return;

  // Admin guard for the wizard
  const gs = getGuildSettings(interaction.guildId) || {};
  const isAdmin = gs?.admin_role_id
    ? interaction.member.roles.cache.has(gs.admin_role_id)
    : interaction.member.permissions.has('ManageGuild');

  if (!isAdmin) {
    // Minimal one-off error; no follow-ups afterwards
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use the setup wizard.' });
  }

  try {
    // ----- Silent saves: no extra messages -----
    if (interaction.customId === 'setup:channel' && interaction.isChannelSelectMenu()) {
      const ch = interaction.channels.first();
      upsertGuildSettings(interaction.guildId, { alert_channel_id: ch?.id ?? null });
      return interaction.deferUpdate(); // no new message
    }

    if (interaction.customId === 'setup:role' && interaction.isRoleSelectMenu()) {
      const role = interaction.roles.first();
      upsertGuildSettings(interaction.guildId, { ping_role_id: role?.id ?? null });
      return interaction.deferUpdate(); // no new message
    }

    if (interaction.customId === 'setup:hours' && interaction.isStringSelectMenu()) {
      const hours = parseInt(interaction.values[0], 10);
      upsertGuildSettings(interaction.guildId, { upcoming_hours: hours });
      return interaction.deferUpdate(); // no new message
    }

    if (interaction.customId === 'setup:minutes' && interaction.isStringSelectMenu()) {
      const minutes = parseInt(interaction.values[0], 10);
      upsertGuildSettings(interaction.guildId, { ping_minutes: minutes });
      return interaction.deferUpdate(); // no new message
    }

    // ----- Create/Update dashboard: show one confirmation, then dismiss wizard -----
    if (interaction.customId === 'setup:make_message' && interaction.isButton()) {
      const settings = getGuildSettings(interaction.guildId) || {};
      if (!settings.alert_channel_id) {
        // Replace the wizard with a single inline error (no extra messages)
        return interaction.update({
          content: '❗ Select an **Alert Channel** first in the menus above.',
          embeds: [],
          components: []
        });
      }

      const channel = await interaction.guild.channels.fetch(settings.alert_channel_id).catch(() => null);
      if (!channel) {
        return interaction.update({
          content: '❗ Configured alert channel is invalid or missing permissions.',
          embeds: [],
          components: []
        });
      }

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

      // Replace the wizard with a single confirmation, no extra new messages
      await interaction.update({
        content: '✅ Dashboard message created/updated.',
        embeds: [],
        components: []
      });

      // OPTIONAL: auto-dismiss the confirmation after a short delay.
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 3000);

      return;
    }
  } catch (err) {
    console.error('Setup component error:', err);
    // Only send an error if nothing was acknowledged
    if (!interaction.deferred && !interaction.replied) {
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
async function tickOnce(onlyGuildId = null) {
  const guilds = onlyGuildId
    ? [getGuildSettings(onlyGuildId)].filter(Boolean)
    : getAllGuildSettings();

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
      } catch {
        /* ignore per-guild errors */
      }
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
          } catch {
            /* ignore send errors */
          }
        }
      }
    }

    // 3) DM alerts to subscribed users when their lead time hits
    try {
      const rows = getAllBossRows();
      const regs = listRegisteredUsers(gs.guild_id); // users with alert_minutes set

      // For DMs we need the Guild name in the embed footer (optional, but helpful)
      const guildObj = await client.guilds.fetch(gs.guild_id).catch(() => null);

      for (const reg of regs) {
        const subs = listUserSubscriptions(reg.user_id, gs.guild_id);
        if (!subs || subs.length === 0) continue; // opt-in model: no subs, no DMs

        // Only consider bosses this user is subscribed to
        for (const b of rows) {
          if (!subs.includes(b.name)) continue;
          if (!b.last_killed_at_utc) continue;

          const w = computeWindow(b);
          if (!w) continue;

          const windowKey = `${b.name}:${b.last_killed_at_utc}`;
          if (hasUserBeenAlerted(reg.user_id, gs.guild_id, b.name, windowKey)) continue;

          // When the user's alert lead time hits
          const threshold = w.start.minus({ minutes: reg.alert_minutes || 30 });
          if (now >= threshold && now < w.start) {
            try {
              const user = await client.users.fetch(reg.user_id).catch(() => null);
              if (!user) continue;

              const embed = new EmbedBuilder()
                .setTitle(`Spawn Approaching - ${b.name}`)
                .addFields(
                  { name: 'Window Start',
                    value: `**Your Time:** <t:${toUnixSeconds(w.start)}:f>\n**Server Time (UTC):** ${fmtUtc(w.start)}` },
                  { name: 'Window End',
                    value: `**Your Time:** <t:${toUnixSeconds(w.end)}:f>\n**Server Time (UTC):** ${fmtUtc(w.end)}` }
                )
                .setFooter({ text: guildObj ? `Guild: ${guildObj.name}` : 'Boss Alert' })
                .setColor(0x2ECC71);

              await user.send({ embeds: [embed] }).catch(() => {});
              markUserAlerted(reg.user_id, gs.guild_id, b.name, windowKey);
            } catch {
              // ignore DM errors (user has DMs off, left the server, etc.)
            }
          }
        }
      }
    } catch {
      // ignore per-guild DM errors
    }
  }
}

// Regular tick (every minute)
setInterval(() => { tickOnce().catch(() => {}); }, 60 * 1000);

// Immediate per-guild refresh when handlers ask for it
bus.on('forceUpdate', (payload) => {
  const gid = payload?.guildId ?? null;
  tickOnce(gid).catch(() => {});
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

client.login(DISCORD_TOKEN);
