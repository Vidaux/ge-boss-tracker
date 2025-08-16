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
  handleServerReset
} from './commands/handlers.js';

import {
  listUserSubscriptions,
  getGuildSettings,
  upsertGuildSettings,
  getAllGuildSettings,
  getAllBossRows,              // static metadata (used for autocomplete filtering)
  getAllBossRowsForGuild,      // NEW: guild-scoped state + metadata
  computeWindow,
  hasChannelBeenPinged,
  listRegisteredUsers,
  hasUserBeenAlerted,
  markUserAlerted,
  listKilledBosses,            // now guild-scoped
  recordChannelPingMessage,
  listChannelMessagesDueForDeletion,
  markChannelAlertDeleted
} from './db.js';

import { nowUtc, fmtUtc, toUnixSeconds } from './utils/time.js';
import { bus } from './bus.js';

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

// Small helper for pretty window ranges
const NBSP_TILDE = '\u00A0~\u00A0';

// Build an upcoming embed **for a specific guild**, using that guild's boss state
function buildUpcomingEmbedForGuild(hours, guildId) {
  const rows = getAllBossRowsForGuild(guildId);
  const now = nowUtc();
  const horizon = now.plus({ hours });

  const within = [];
  for (const b of rows) {
    if (!b.last_killed_at_utc) continue;
    const w = computeWindow(b);
    if (!w) continue;
    if (w.end <= now) continue;      // already closed window
    if (w.start > horizon) continue; // starts beyond horizon
    within.push({ boss: b, window: w });
  }

  within.sort((a, b) => {
    const aKey = (a.window.start < now ? now : a.window.start).toMillis();
    const bKey = (b.window.start < now ? now : b.window.start).toMillis();
    return aKey - bKey;
  });

  const fields = within.length
    ? within.map(({ boss, window }) => {
        const startUnix = toUnixSeconds(window.start);
        const endUnix = toUnixSeconds(window.end);
        const isSingle = window.start.toMillis() === window.end.toMillis();

        const value = isSingle
          ? [
              `**Your Time:** <t:${startUnix}:f>`,
              `**Server Time (UTC):** ${fmtUtc(window.start)}`
            ].join('\n')
          : [
              `**Your Time:** <t:${startUnix}:f>${NBSP_TILDE}<t:${endUnix}:f>`,
              `**Server Time (UTC):** ${fmtUtc(window.start)} ~ ${fmtUtc(window.end)}`
            ].join('\n');

        const label = window.trigger === 'reset'
          ? `${boss.name} *(after server reset)*`
          : boss.name;

        return { name: label, value };
      })
    : [{ name: 'No upcoming windows', value: `Nothing starts within the next ${hours} hour(s).` }];

  return new EmbedBuilder()
    .setTitle(`Upcoming Spawns - next ${hours}h`)
    .addFields(fields)
    .setColor(0x00A8FF);
}

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
        const rows = getAllBossRows(); // static metadata for filtering tracked/untracked
        const isUntracked = (b) => b.respawn_min_hours == null || b.respawn_max_hours == null;

        let sourceNames = [];

        if (interaction.commandName === 'unsubscribe') {
          const sub = interaction.options.getSubcommand(false);
          sourceNames = (!sub || sub === 'boss')
            ? listUserSubscriptions(interaction.user.id, interaction.guildId)
            : [];
        } else if (interaction.commandName === 'reset') {
          // Only bosses with a recorded kill — guild scoped
          sourceNames = listKilledBosses(interaction.guildId);
        } else if (interaction.commandName === 'details' || interaction.commandName === 'drops') {
          // All bosses (tracked + untracked) for info-only commands
          sourceNames = rows.map(b => b.name);
        } else {
          // Other commands → tracked-only
          sourceNames = rows.filter(b => !isUntracked(b)).map(b => b.name);
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
  if (
    !(
      interaction.isStringSelectMenu() ||
      interaction.isRoleSelectMenu() ||
      interaction.isChannelSelectMenu() ||
      interaction.isButton()
    )
  ) return;

  const gs = getGuildSettings(interaction.guildId) || {};
  const isAdmin = gs?.admin_role_id
    ? interaction.member.roles.cache.has(gs.admin_role_id)
    : interaction.member.permissions.has('ManageGuild');

  if (!isAdmin) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use the setup wizard.' });
  }

  try {
    if (interaction.customId === 'setup:channel' && interaction.isChannelSelectMenu()) {
      const ch = interaction.channels.first();
      upsertGuildSettings(interaction.guildId, { alert_channel_id: ch?.id ?? null });
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'setup:role' && interaction.isRoleSelectMenu()) {
      const role = interaction.roles.first();
      upsertGuildSettings(interaction.guildId, { ping_role_id: role?.id ?? null });
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'setup:hours' && interaction.isStringSelectMenu()) {
      const hours = parseInt(interaction.values[0], 10);
      upsertGuildSettings(interaction.guildId, { upcoming_hours: hours });
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'setup:minutes' && interaction.isStringSelectMenu()) {
      const minutes = parseInt(interaction.values[0], 10);
      upsertGuildSettings(interaction.guildId, { ping_minutes: minutes });
      return interaction.deferUpdate();
    }

    if (interaction.customId === 'setup:make_message' && interaction.isButton()) {
      const settings = getGuildSettings(interaction.guildId) || {};
      if (!settings.alert_channel_id) {
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
      const embed = buildUpcomingEmbedForGuild(hours, interaction.guildId);

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

      await interaction.update({
        content: '✅ Dashboard message created/updated.',
        embeds: [],
        components: []
      });

      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 3000);

      return;
    }
  } catch (err) {
    console.error('Setup component error:', err);
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
      case 'serverreset':     await handleServerReset(interaction); break;
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

// --------- Scheduler: update dashboard + role pings + DMs + cleanup ----------
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

        const embed = buildUpcomingEmbedForGuild(hours, gs.guild_id);
        const msg = await channel.messages.fetch(gs.alert_message_id).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
        } else {
          const newMsg = await channel.send({ embeds: [embed] });
          upsertGuildSettings(gs.guild_id, { alert_message_id: newMsg.id });
        }
      } catch { /* ignore per-guild errors */ }
    }

    // 2) Ping role if a window is approaching (and record the message for later cleanup)
    if (gs.ping_role_id && gs.ping_minutes) {
      const rows = getAllBossRowsForGuild(gs.guild_id);
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

        if (now >= threshold && now < w.start) {
          try {
            const sent = await channel.send({
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

            // Record message so we can auto-delete it 30 minutes after window end
            const deleteAfter = w.end.plus({ minutes: 30 });
            recordChannelPingMessage(
              gs.guild_id,
              b.name,
              windowKey,
              gs.alert_channel_id,
              sent.id,
              deleteAfter.toISO()
            );
          } catch {
            /* ignore send errors */
          }
        }
      }
    }

    // 3) DM alerts to subscribed users when their lead time hits
    try {
      const rows = getAllBossRowsForGuild(gs.guild_id);
      const regs = listRegisteredUsers(gs.guild_id); // users with alert_minutes set

      // For DMs we optionally include the Guild name in the embed footer
      const guildObj = await client.guilds.fetch(gs.guild_id).catch(() => null);

      for (const reg of regs) {
        const subs = listUserSubscriptions(reg.user_id, gs.guild_id);
        if (!subs || subs.length === 0) continue; // opt-in model: no subs, no DMs

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

    // 4) Cleanup: delete "Spawn Approaching" messages 30 minutes after window end
    try {
      const due = listChannelMessagesDueForDeletion(gs.guild_id, now.toISO());
      if (due && due.length) {
        const guild = await client.guilds.fetch(gs.guild_id).catch(() => null);
        if (!guild) continue;

        for (const row of due) {
          try {
            const ch = await guild.channels.fetch(row.channel_id).catch(() => null);
            if (!ch) {
              markChannelAlertDeleted(gs.guild_id, row.boss_name, row.window_key);
              continue;
            }
            const msg = await ch.messages.fetch(row.message_id).catch(() => null);
            if (msg) {
              await msg.delete().catch(() => {});
            }
          } finally {
            // Mark deleted regardless of actual delete result to avoid endless retries
            markChannelAlertDeleted(gs.guild_id, row.boss_name, row.window_key);
          }
        }
      }
    } catch {
      /* ignore cleanup errors */
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
