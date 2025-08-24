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
  handleServerReset,
  handlePlayerAdd,
  handlePlayerUpdate
} from './commands/handlers.js';

import {
  listUserSubscriptions,
  getGuildSettings,
  upsertGuildSettings,
  getAllGuildSettings,
  getAllBossRows,              // static metadata (used for autocomplete filtering)
  getAllBossRowsForGuild,      // guild-scoped state + metadata
  computeWindow,
  hasChannelBeenPinged,
  listRegisteredUsers,
  hasUserBeenAlerted,
  markUserAlerted,
  listKilledBosses,            // guild-scoped
  recordChannelPingMessage,
  listChannelMessagesDueForDeletion,
  markChannelAlertDeleted,
  listJormQueue,
  listJormPlayersWithoutRing,
  jormRotate,
  jormUndo
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

// --------- Jorm embeds ----------
function buildJormQueueEmbed(guildId) {
  const queue = listJormQueue(guildId);
  const lines = queue.length
    ? queue.map((q, i) => `${i + 1}. <@${q.user_id}> ${q.used_key_count ? `(used: ${q.used_key_count})` : ''}`)
    : ['(no eligible players - everyone has a belt)'];

  return new EmbedBuilder()
    .setTitle('Jorm Key Queue')
    .setDescription(lines.join('\n'))
    .setColor(0x3498DB);
}

function buildJormRingEmbed(guildId) {
  const rows = listJormPlayersWithoutRing(guildId);
  const lines = rows.length
    ? rows.map(r => `• <@${r.user_id}>`)
    : ['(everyone has a ring)'];

  return new EmbedBuilder()
    .setTitle('Ring FW List (No Montoro Skull Ring)')
    .setDescription(lines.join('\n'))
    .setColor(0x9B59B6);
}

async function renderOrCreateJormMessages(guildId, { forceCreate = false } = {}) {
  const gs = getGuildSettings(guildId) || {};
  if (!gs.jorm_channel_id) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(gs.jorm_channel_id).catch(() => null);
  if (!channel) return;

  const queueEmbed = buildJormQueueEmbed(guildId);
  const ringEmbed = buildJormRingEmbed(guildId);

  let queueMsg = null, ringMsg = null;

  if (gs.jorm_queue_message_id && !forceCreate) {
    queueMsg = await channel.messages.fetch(gs.jorm_queue_message_id).catch(() => null);
  }
  if (gs.jorm_ring_message_id && !forceCreate) {
    ringMsg = await channel.messages.fetch(gs.jorm_ring_message_id).catch(() => null);
  }

  const components = [{
    type: 1, // ActionRow
    components: [
      { type: 2, style: 3, custom_id: 'jorm:used',    label: 'Used Key' },
      { type: 2, style: 2, custom_id: 'jorm:skipped', label: 'Skipped' },
      { type: 2, style: 1, custom_id: 'jorm:undo',    label: 'Undo' }
    ]
  }];

  if (queueMsg) {
    await queueMsg.edit({ embeds: [queueEmbed], components });
  } else {
    queueMsg = await channel.send({ embeds: [queueEmbed], components });
    upsertGuildSettings(guildId, { jorm_queue_message_id: queueMsg.id });
  }

  if (ringMsg) {
    await ringMsg.edit({ embeds: [ringEmbed], components: [] });
  } else {
    ringMsg = await channel.send({ embeds: [ringEmbed] });
    upsertGuildSettings(guildId, { jorm_ring_message_id: ringMsg.id });
  }
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
          // Only bosses with a recorded kill - guild scoped
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

// --------- Setup wizard component + Jorm buttons ----------
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

  // Jorm buttons (live message controls)
  if (interaction.isButton() && interaction.customId?.startsWith('jorm:')) {
    if (!isAdmin && !isAllowedByStandardForJorm(interaction)) {
      return interaction.reply({ ephemeral: true, content: 'You do not have permission to use these controls.' });
    }
    try {
      const sub = interaction.customId.split(':')[1];
      if (sub === 'used' || sub === 'skipped') {
        jormRotate(interaction.guildId, sub);
        await renderOrCreateJormMessages(interaction.guildId);
        return interaction.reply({
          ephemeral: true,
          content: sub === 'used' ? 'Marked top of queue as **Used Key** and rotated.' : 'Marked as **Skipped** and rotated.'
        });
      }
      if (sub === 'undo') {
        const res = jormUndo(interaction.guildId);
        await renderOrCreateJormMessages(interaction.guildId);
        return interaction.reply({ ephemeral: true, content: res.undone ? 'Last action undone.' : 'Nothing to undo.' });
      }
    } catch (e) {
      console.error('Jorm button error:', e);
      return interaction.reply({ ephemeral: true, content: 'Error handling that action.' });
    }
    return;
  }

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

    // NEW: Jorm messages channel
    if (interaction.customId === 'setup:jorm_channel' && interaction.isChannelSelectMenu()) {
      const ch = interaction.channels.first();
      upsertGuildSettings(interaction.guildId, { jorm_channel_id: ch?.id ?? null });
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

    // Create/Update Jorm messages
    if (interaction.customId === 'setup:make_jorm' && interaction.isButton()) {
      const settings = getGuildSettings(interaction.guildId) || {};
      if (!settings.jorm_channel_id) {
        return interaction.update({
          content: '❗ Select a **Jorm Messages Channel** first in the menus above.',
          embeds: [],
          components: []
        });
      }

      await renderOrCreateJormMessages(interaction.guildId, { forceCreate: true });

      await interaction.update({
        content: '✅ Jorm Queue & Ring FW messages created/updated.',
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

// Helper: allow non-admins to press Jorm buttons if you gate with standard role
function isAllowedByStandardForJorm(interaction) {
  const gs = getGuildSettings(interaction.guildId);
  const roleToCheck = gs?.standard_role_id;
  if (!roleToCheck) return true;
  return interaction.member.roles.cache.has(roleToCheck);
}

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
      case 'playeradd':       await handlePlayerAdd(interaction); break;
      case 'playerupdate':    await handlePlayerUpdate(interaction); break;
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

// --------- Spawn-approaching stale cleanup (event-driven) ----------
async function cleanupStaleApproachingMessages(guildId, bossNames) {
  const gs = getGuildSettings(guildId) || {};
  if (!gs.alert_channel_id) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const channel = await guild.channels.fetch(gs.alert_channel_id).catch(() => null);
  if (!channel || !('messages' in channel)) return;

  // Build a quick lookup of current windows for each requested boss so we can keep the valid one
  const rows = getAllBossRowsForGuild(guildId);
  const currentByBoss = new Map();
  for (const name of bossNames) {
    const row = rows.find(r => r.name.toLowerCase() === String(name).toLowerCase());
    if (!row) { currentByBoss.set(name, null); continue; }
    const w = computeWindow(row);
    currentByBoss.set(name, w || null);
  }

  // Fetch a chunk of recent messages and remove outdated “Spawn Approaching - <boss>”
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return;

  for (const name of bossNames) {
    const window = currentByBoss.get(name); // may be null if timer cleared
    const keepStart = window ? `<t:${toUnixSeconds(window.start)}:f>` : null;
    const keepEnd   = window ? `<t:${toUnixSeconds(window.end)}:f>`   : null;

    const candidates = [...recent.values()].filter(m => {
      if (m.author?.id !== client.user.id) return false;
      const embeds = m.embeds || [];
      return embeds.some(e => (e?.title || '') === `Spawn Approaching - ${name}`);
    });

    for (const msg of candidates) {
      // If we have a current window, keep messages that show that exact start/end; otherwise delete all
      let isCurrent = false;
      if (window && msg.embeds?.length) {
        outer: for (const e of msg.embeds) {
          const fields = e?.fields || [];
          let sawStart = false, sawEnd = false;
          for (const f of fields) {
            const v = String(f?.value || '');
            if (keepStart && v.includes(keepStart)) sawStart = true;
            if (keepEnd   && v.includes(keepEnd))   sawEnd   = true;
          }
          if (sawStart && sawEnd) { isCurrent = true; break outer; }
        }
      }
      if (!isCurrent) {
        await msg.delete().catch(() => {});
        // time-based cleanup will mark deleted later if present in DB
      }
    }
  }
}

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

// NEW: listen for event-driven stale cleanup
bus.on('cleanupStaleApproaching', (payload) => {
  const guildId = payload?.guildId;
  if (!guildId) return;
  const names = Array.isArray(payload?.bossNames)
    ? payload.bossNames
    : (payload?.bossName ? [payload.bossName] : []);
  if (!names.length) return;
  cleanupStaleApproachingMessages(guildId, names).catch(() => {});
});

// NEW: keep Jorm messages fresh
bus.on('jormUpdate', (payload) => {
  const gid = payload?.guildId;
  if (!gid) return;
  renderOrCreateJormMessages(gid, { forceCreate: !!payload.forceCreate }).catch(() => {});
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

client.login(DISCORD_TOKEN);
