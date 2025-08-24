// src/commands/handlers.js
import {
  getBossByName,
  listBosses,
  setKilled,
  resetBoss,
  computeWindow,
  getGuildSettings,
  upsertGuildSettings,
  getAllGuildSettings,
  setCommandRole,
  getCommandRole,
  upsertUserAlertMinutes,
  addSubscription,
  listUserSubscriptions,
  getUserRegistration,
  removeSubscription,
  getAllBossRows,
  getAllBossRowsForGuild,   // guild
  getBossForGuild,          // guild
  applyServerReset,
  listKilledBosses,
  upsertJormPlayer,
  updateJormPlayer
} from '../db.js';

import {
  nowUtc,
  parseServerHHmmToUtcToday,
  fmtUtc,
  toUnixSeconds
} from '../utils/time.js';

import {
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
} from 'discord.js';

import { bus } from '../bus.js';

// ---------- helpers ----------
function titleCase(s) {
  return s?.trim().replace(/\s+/g, ' ').replace(/\b\w/g, m => m.toUpperCase()) || '';
}

// Flexible boss resolver (case/spacing tolerant)
function ensureBossExists(inputName) {
  // Try direct fetch first
  const direct = getBossByName(inputName);
  if (direct) return { boss: direct };

  // Fuzzy match across all bosses (static metadata)
  const rows = getAllBossRows();
  const norm = (x) => String(x || '')
    .toLowerCase()
    .replace(/[\s_'’\-]/g, ''); // collapse common separators

  const targetTitle = titleCase(inputName);
  const target = norm(inputName);
  let boss =
    rows.find(b => b.name.toLowerCase() === inputName.toLowerCase()) ||
    rows.find(b => norm(b.name) === target) ||
    rows.find(b => b.name.toLowerCase() === targetTitle.toLowerCase());

  if (!boss) {
    const list = listBosses().join(', ');
    return { error: `Unknown boss \`${inputName}\`. Known bosses: ${list}` };
  }
  return { boss };
}

function isAllowedForStandard(interaction, commandName) {
  const gs = getGuildSettings(interaction.guildId);
  const explicitRole = getCommandRole(interaction.guildId, commandName);
  const roleToCheck = explicitRole || gs?.standard_role_id;
  if (!roleToCheck) return true;
  return interaction.member.roles.cache.has(roleToCheck);
}

function isAdminAllowed(interaction) {
  const gs = getGuildSettings(interaction.guildId);
  if (gs?.admin_role_id) return interaction.member.roles.cache.has(gs.admin_role_id);
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

const NBSP_TILDE = '\u00A0~\u00A0';

function formatRespawnPattern(min, max) {
  // Untracked (null) → show "None"
  if (min == null || max == null) return 'None';
  const nMin = Number(min);
  const nMax = Number(max);
  if (!Number.isNaN(nMin) && !Number.isNaN(nMax) && nMin === nMax) {
    return `${nMin} hours after death`;
  }
  return `${min}–${max} hours after death`;
}

// Untracked (static) bosses have null min/max → only allow /details & /drops
function isUntrackedBoss(b) {
  return b?.respawn_min_hours == null || b?.respawn_max_hours == null;
}

function guardUntrackedForCommand(boss, cmdName) {
  if (!isUntrackedBoss(boss)) return null;
  if (cmdName === 'details' || cmdName === 'drops') return null;
  return `**${boss.name}** has no world respawn timer. Use **/details** or **/drops** for this boss.`;
}

function renderWindowFields(boss, window) {
  const min = Number(
    window.trigger === 'reset' && boss.reset_respawn_min_hours != null
      ? boss.reset_respawn_min_hours
      : boss.respawn_min_hours
  );
  const max = Number(
    window.trigger === 'reset' && boss.reset_respawn_max_hours != null
      ? boss.reset_respawn_max_hours
      : boss.respawn_max_hours
  );

  const startUnix = toUnixSeconds(window.start);
  const endUnix   = toUnixSeconds(window.end);
  const usingSingle = !Number.isNaN(min) && !Number.isNaN(max) && min === max;

  if (usingSingle) {
    return {
      name: window.trigger === 'reset' ? 'Respawn Time (after server reset)' : 'Respawn Time',
      value: [
        `**Your Time:** <t:${startUnix}:f>`,
        `**Server Time (UTC):** ${fmtUtc(window.start)}`
      ].join('\n')
    };
  }
  return {
    name: window.trigger === 'reset' ? 'Respawn Window (after server reset)' : 'Respawn Window',
    value: [
      `**Your Time:** <t:${startUnix}:f>${NBSP_TILDE}<t:${endUnix}:f>`,
      `**Server Time (UTC):** ${fmtUtc(window.start)} ~ ${fmtUtc(window.end)}`
    ].join('\n')
  };
}

// Guild-scoped upcoming embed
function buildUpcomingEmbedForGuild(hours, guildId) {
  const rows = getAllBossRowsForGuild(guildId);
  const now = nowUtc();
  const horizon = now.plus({ hours });

  const within = [];
  for (const b of rows) {
    if (!b.last_killed_at_utc) continue;
    const w = computeWindow(b);
    if (!w) continue;
    if (w.end <= now) continue;
    if (w.start > horizon) continue;
    within.push({ boss: b, window: w });
  }

  within.sort((a, b) => {
    const aKey = (a.window.start < now ? now : a.window.start).toMillis();
    const bKey = (b.window.start < now ? now : b.window.start).toMillis();
    return aKey - bKey;
  });

  const fields = within.length ? within.map(({ boss, window }) => {
    const startUnix = toUnixSeconds(window.start);
    const endUnix = toUnixSeconds(window.end);
    const isSingle = (window.start.toMillis() === window.end.toMillis());

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
  }) : [{ name: 'No upcoming windows', value: `Nothing starts within the next ${hours} hour(s).` }];

  return new EmbedBuilder()
    .setTitle(`Upcoming Spawns - next ${hours}h`)
    .addFields(fields)
    .setColor(0x00A8FF);
}

// ---------- commands ----------
export async function handleListBosses(interaction) {
  const names = listBosses();
  const embed = new EmbedBuilder()
    .setTitle('Boss List')
    .setDescription(names.length ? names.map(n => `• ${n}`).join('\n') : 'No bosses configured.')
    .setColor(0x95A5A6);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleKilled(interaction) {
  if (!isAllowedForStandard(interaction, 'killed')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /killed.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const timeStr = interaction.options.getString('server_time_hhmm', false);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const bossMeta = check.boss;

  const guardMsg = guardUntrackedForCommand(bossMeta, 'killed');
  if (guardMsg) return interaction.reply({ ephemeral: true, content: guardMsg });

  let deathUtc = nowUtc();
  if (timeStr) {
    const parsed = parseServerHHmmToUtcToday(timeStr);
    if (!parsed) {
      return interaction.reply({ ephemeral: true, content: 'Invalid time format. Use HH:MM in UTC, e.g. 21:22' });
    }
    deathUtc = parsed > nowUtc() ? parsed.minus({ days: 1 }) : parsed;
  }

  if (!setKilled(interaction.guildId, bossMeta.name, deathUtc.toISO())) {
    return interaction.reply({ ephemeral: true, content: 'Failed to record kill. (DB)' });
  }

  // Event-driven cleanup: remove any stale "Spawn Approaching" messages for this boss
  bus.emit('cleanupStaleApproaching', { guildId: interaction.guildId, bossNames: [bossMeta.name] });

  // Force an immediate dashboard refresh
  bus.emit('forceUpdate', { guildId: interaction.guildId });

  const updated = getBossForGuild(interaction.guildId, bossMeta.name);
  const window = computeWindow(updated);
  const killedUnix = toUnixSeconds(deathUtc);

  const fields = [
    {
      name: 'Last Death',
      value: [
        `**Your Time:** <t:${killedUnix}:f>`,
        `**Server Time (UTC):** ${fmtUtc(deathUtc)}`
      ].join('\n')
    }
  ];
  if (window) fields.push(renderWindowFields(updated, window));

  const embed = new EmbedBuilder()
    .setTitle(`Recorded Kill: ${updated.name}`)
    .addFields(fields)
    .setFooter({ text: 'Server time is UTC. Local times are rendered by Discord.' })
    .setColor(0x00B894);

  return interaction.reply({ embeds: [embed] });
}

export async function handleServerReset(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /serverreset.' });
  }

  const timeStr = interaction.options.getString('server_time_hhmm', false);
  let resetUtc = nowUtc();
  if (timeStr) {
    const parsed = parseServerHHmmToUtcToday(timeStr);
    if (!parsed) {
      return interaction.reply({ ephemeral: true, content: 'Invalid time format. Use HH:MM in UTC, e.g. 09:00' });
    }
    resetUtc = parsed > nowUtc() ? parsed.minus({ days: 1 }) : parsed;
  }

  const { updatedNames } = applyServerReset(interaction.guildId, resetUtc.toISO());

  // Event-driven cleanup for any bosses whose window just changed
  if (updatedNames && updatedNames.length) {
    bus.emit('cleanupStaleApproaching', { guildId: interaction.guildId, bossNames: updatedNames });
  }

  // Force an immediate dashboard refresh
  bus.emit('forceUpdate', { guildId: interaction.guildId });

  const embed = new EmbedBuilder()
    .setTitle('Server Reset Applied')
    .setDescription(
      updatedNames.length
        ? `Reset-based spawn timers set for:\n${updatedNames.map(n => `• ${n}`).join('\n')}`
        : 'No bosses are configured for reset-based spawns.'
    )
    .addFields({
      name: 'Reset Time',
      value: `**Your Time:** <t:${toUnixSeconds(resetUtc)}:f>\n**Server Time (UTC):** ${fmtUtc(resetUtc)}`
    })
    .setColor(0x27AE60);

  return interaction.reply({ embeds: [embed] });
}

export async function handleStatus(interaction) {
  if (!isAllowedForStandard(interaction, 'status')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /status.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });

  const boss = getBossForGuild(interaction.guildId, check.boss.name);

  const guardMsg = guardUntrackedForCommand(boss, 'status');
  if (guardMsg) return interaction.reply({ ephemeral: true, content: guardMsg });

  if (!boss.last_killed_at_utc) {
    const embed = new EmbedBuilder()
      .setTitle(`${boss.name} Status`)
      .addFields(
        { name: 'Last Death', value: `**Your Time:** Unknown\n**Server Time (UTC):** Unknown` },
        { name: 'Respawn Window', value: `**Your Time:** Unknown\n**Server Time (UTC):** Unknown` }
      )
      .setColor(0xD63031);
    return interaction.reply({ embeds: [embed] });
  }

  const window = computeWindow(boss);
  const killedUnix = toUnixSeconds(window.killed);
  const lastLabel = window.trigger === 'reset' ? 'Last Server Reset' : 'Last Death';
  const last = {
    name: lastLabel,
    value: `**Your Time:** <t:${killedUnix}:f>\n**Server Time (UTC):** ${fmtUtc(window.killed)}`
  };
  const resp = renderWindowFields(boss, window);

  const embed = new EmbedBuilder()
    .setTitle(`${boss.name} Status`)
    .addFields(last, resp)
    .setColor(0x0984E3);

  return interaction.reply({ embeds: [embed] });
}

export async function handleDetails(interaction) {
  if (!isAllowedForStandard(interaction, 'details')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /details.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const b = check.boss; // static metadata is fine for details

  const fields = [
    { name: 'Location', value: b.location || 'Unknown', inline: true },
    { name: 'Respawn Pattern', value: formatRespawnPattern(b.respawn_min_hours, b.respawn_max_hours), inline: true },
    ...(b.reset_respawn_min_hours != null && b.reset_respawn_max_hours != null
      ? [{ name: 'After Server Reset', value: `${b.reset_respawn_min_hours}–${b.reset_respawn_max_hours} hours`, inline: true }]
      : []),
    { name: 'Special Conditions', value: b.special_conditions || 'None' }
  ];

  if (Array.isArray(b.parts) && b.parts.length) {
    for (const part of b.parts) {
      const statsLines = Object.entries(part.stats || {}).map(([k, v]) => `**${k}**: ${v}`).join('\n') || '-';
      fields.push({ name: `Stats - ${part.name}`, value: statsLines });
    }
  } else {
    const statsLines = Object.entries(b.stats || {}).map(([k, v]) => `**${k}**: ${v}`).join('\n') || '-';
    fields.push({ name: 'Stats', value: statsLines });
  }

  if ((b.respawn_notes || []).length) {
    fields.push({ name: 'Notes', value: (b.respawn_notes || []).map(n => `• ${n}`).join('\n') });
  }

  return interaction.reply({
    embeds: [
      new EmbedBuilder().setTitle(`${b.name} - Details`).addFields(fields).setColor(0x6C5CE7)
    ]
  });
}

// /drops
export async function handleDrops(interaction) {
  if (!isAllowedForStandard(interaction, 'drops')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /drops.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const b = check.boss;
  const drops = (b.drops || []).map(d => `• ${d}`).join('\n') || '-';

  return interaction.reply({
    embeds: [ new EmbedBuilder().setTitle(`${b.name} - Drops`).setDescription(drops.slice(0, 4096)).setColor(0x00CEC9) ]
  });
}

export async function handleReset(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /reset.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });

  const bossRow = getBossForGuild(interaction.guildId, check.boss.name);

  const guardMsg = guardUntrackedForCommand(bossRow, 'reset');
  if (guardMsg) return interaction.reply({ ephemeral: true, content: guardMsg });

  if (!bossRow.last_killed_at_utc) {
    return interaction.reply({ ephemeral: true, content: 'That boss does not currently have a recorded kill - nothing to reset.' });
  }

  const ok = resetBoss(interaction.guildId, bossRow.name);
  if (!ok) return interaction.reply({ ephemeral: true, content: 'Failed to reset boss.' });

  // Event-driven cleanup: remove any stale "Spawn Approaching" messages for this boss
  bus.emit('cleanupStaleApproaching', { guildId: interaction.guildId, bossNames: [bossRow.name] });

  // Force an immediate dashboard refresh for this guild
  bus.emit('forceUpdate', { guildId: interaction.guildId });

  return interaction.reply({
    embeds: [ new EmbedBuilder().setTitle(`Reset: ${bossRow.name}`).setDescription('Respawn timer cleared. Status is now **Unknown**.').setColor(0xE17055) ]
  });
}

// /subscribe boss
export async function handleSubscribeBoss(interaction) {
  if (!isAllowedForStandard(interaction, 'subscribe')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /subscribe.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });

  const guardMsg = guardUntrackedForCommand(check.boss, 'subscribe');
  if (guardMsg) return interaction.reply({ ephemeral: true, content: guardMsg });

  addSubscription(interaction.user.id, interaction.guildId, check.boss.name);
  const reg = getUserRegistration(interaction.user.id, interaction.guildId);
  if (!reg || reg.alert_minutes == null) upsertUserAlertMinutes(interaction.user.id, interaction.guildId, 30);

  const current = listUserSubscriptions(interaction.user.id, interaction.guildId);
  const desc = current.length ? current.map(b => `• ${b}`).join('\n') : 'None';
  const embed = new EmbedBuilder()
    .setTitle('Subscribed to Boss')
    .setDescription(`You will receive DM alerts for **${check.boss.name}**.\n(Default lead time **30 minutes** unless changed via /setalert)`)
    .addFields({ name: 'Your Subscriptions', value: desc })
    .setColor(0x1ABC9C);

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleSubscribeAll(interaction) {
  if (!isAllowedForStandard(interaction, 'subscribe')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /subscribe.' });
  }

  const tracked = getAllBossRows()
    .filter(b => !isUntrackedBoss(b))
    .map(b => b.name);

  for (const name of tracked) addSubscription(interaction.user.id, interaction.guildId, name);
  const reg = getUserRegistration(interaction.user.id, interaction.guildId);
  if (!reg || reg.alert_minutes == null) upsertUserAlertMinutes(interaction.user.id, interaction.guildId, 30);

  const current = listUserSubscriptions(interaction.user.id, interaction.guildId);
  const desc = current.length ? current.map(b => `• ${b}`).join('\n') : 'None';
  return interaction.reply({
    embeds: [ new EmbedBuilder().setTitle('Subscribed to All Bosses').setDescription('You will receive DM alerts for **all tracked bosses**.').addFields({ name: 'Your Subscriptions', value: desc }).setColor(0x1ABC9C) ],
    ephemeral: true
  });
}

export async function handleUnsubscribeBoss(interaction) {
  if (!isAllowedForStandard(interaction, 'unsubscribe')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /unsubscribe.' });
  }
  const bossName = interaction.options.getString('boss', true);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });

  const guardMsg = guardUntrackedForCommand(check.boss, 'unsubscribe');
  if (guardMsg) return interaction.reply({ ephemeral: true, content: guardMsg });

  const removed = removeSubscription(interaction.user.id, interaction.guildId, check.boss.name);
  const current = listUserSubscriptions(interaction.user.id, interaction.guildId);
  const desc = current.length ? current.map(b => `• ${b}`).join('\n') : 'None';

  const embed = new EmbedBuilder()
    .setTitle(removed ? 'Unsubscribed from Boss' : 'Not Subscribed')
    .setDescription(removed ? `You will no longer receive alerts for **${check.boss.name}**.` : `You were not subscribed to **${check.boss.name}**.`)
    .addFields({ name: 'Your Subscriptions', value: desc })
    .setColor(removed ? 0xE17055 : 0x95A5A6);

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleUnsubscribeAll(interaction) {
  if (!isAllowedForStandard(interaction, 'unsubscribe')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /unsubscribe.' });
  }
  const current = listUserSubscriptions(interaction.user.id, interaction.guildId);
  for (const name of current) removeSubscription(interaction.user.id, interaction.guildId, name);

  return interaction.reply({
    embeds: [ new EmbedBuilder().setTitle('Unsubscribed from All Bosses').setDescription('You will no longer receive DM alerts for any boss.').addFields({ name: 'Your Subscriptions', value: 'None' }).setColor(0xE17055) ],
    ephemeral: true
  });
}

export async function handleSubscriptions(interaction) {
  if (!isAllowedForStandard(interaction, 'subscriptions')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /subscriptions.' });
  }
  const subs = listUserSubscriptions(interaction.user.id, interaction.guildId);
  const desc = subs.length ? subs.map(b => `• ${b}`).join('\n') : 'None';
  return interaction.reply({ embeds: [ new EmbedBuilder().setTitle('Your Subscriptions').setDescription(desc).setColor(0x8E44AD) ], ephemeral: true });
}

// /setalert - set user DM lead time only (1–1440)
export async function handleSetAlert(interaction) {
  if (!isAllowedForStandard(interaction, 'setalert')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /setalert.' });
  }

  const minutes = interaction.options.getInteger('minutes', true);
  if (minutes < 1 || minutes > 1440) {
    return interaction.reply({ ephemeral: true, content: 'Minutes must be between 1 and 1440.' });
  }

  upsertUserAlertMinutes(interaction.user.id, interaction.guildId, minutes);
  return interaction.reply({ ephemeral: true, content: `Your alert lead time is now **${minutes} minutes** before window start.` });
}

// /setcommandrole - gate a command behind a specific role (admin only)
export async function handleSetCommandRole(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /setcommandrole.' });
  }

  const commandName = interaction.options.getString('command', true);
  const role = interaction.options.getRole('role', true);

  setCommandRole(interaction.guildId, commandName, role.id);

  return interaction.reply({
    ephemeral: true,
    content: `Set role for **/${commandName}** to ${role}.`
  });
}

// /upcoming - dynamic hours (guild-scoped)
export async function handleUpcoming(interaction) {
  if (!isAllowedForStandard(interaction, 'upcoming')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /upcoming.' });
  }
  const hoursArg = interaction.options.getInteger('hours', false);
  const hours = (typeof hoursArg === 'number' ? hoursArg : 3);
  const embed = buildUpcomingEmbedForGuild(hours, interaction.guildId);
  return interaction.reply({ embeds: [embed] });
}

// ---------- Setup Wizard ----------
export async function handleSetup(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /setup.' });
  }

  const gs = getGuildSettings(interaction.guildId) || {};
  const emb = new EmbedBuilder()
    .setTitle('Boss Alerts - Setup Wizard')
    .setDescription([
      'Use the menus below to configure:',
      '1) **Alert Channel** for the dashboard & pings',
      '2) **Ping Role** to mention when a window is near',
      '3) **Lookahead Hours** for the dashboard',
      '4) **Ping Lead Minutes** before a window opens',
      '5) **Jorm Messages Channel** for Queue & Ring lists',
      '',
      'Click **Create/Update Dashboard Message** and/or **Create/Update Jorm Messages** when you’re done.'
    ].join('\n'))
    .addFields(
      { name: 'Current Alert Channel', value: gs.alert_channel_id ? `<#${gs.alert_channel_id}>` : '-', inline: true },
      { name: 'Current Ping Role', value: gs.ping_role_id ? `<@&${gs.ping_role_id}>` : '-', inline: true },
      { name: 'Lookahead Hours', value: String(gs.upcoming_hours ?? 3), inline: true },
      { name: 'Ping Lead Minutes', value: String(gs.ping_minutes ?? 30), inline: true },
      { name: 'Jorm Messages Channel', value: gs.jorm_channel_id ? `<#${gs.jorm_channel_id}>` : '-', inline: true }
    )
    .setColor(0x2ECC71);

  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup:channel')
      .setPlaceholder('Select alert channel')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1).setMaxValues(1)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('setup:role')
      .setPlaceholder('Select ping role (optional)')
      .setMinValues(0).setMaxValues(1)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup:hours')
      .setPlaceholder('Select lookahead hours for dashboard')
      .addOptions([1,3,6,12,24].map(h => ({ label: `${h} hour${h===1?'':'s'}`, value: String(h) })))
      .setMinValues(1).setMaxValues(1)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup:minutes')
      .setPlaceholder('Select ping lead minutes')
      .addOptions([5,10,15,30,60,120].map(m => ({ label: `${m} minutes`, value: String(m) })))
      .setMinValues(1).setMaxValues(1)
  );
  const row5 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:make_message')
      .setLabel('Create/Update Dashboard Message')
      .setStyle(ButtonStyle.Primary)
  );

  // NEW: Jorm message channel + creation button
  const rowJormChannel = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('setup:jorm_channel')
      .setPlaceholder('Select channel for Jorm Queue & Ring FW')
      .addChannelTypes(ChannelType.GuildText)
      .setMinValues(1).setMaxValues(1)
  );
  const rowJormBtn = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('setup:make_jorm')
      .setLabel('Create/Update Jorm Messages')
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({
    embeds: [emb],
    components: [row1, row2, row3, row4, row5, rowJormChannel, rowJormBtn],
    ephemeral: true
  });
}

// ---------- Standalone player commands ----------
export async function handlePlayerAdd(interaction) {
  if (!isAllowedForStandard(interaction, 'playeradd')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /playeradd.' });
  }

  const user = interaction.options.getUser('user', true);
  const belt = interaction.options.getBoolean('belt', false);
  const ring = interaction.options.getBoolean('ring', false);

  upsertJormPlayer(interaction.guildId, user.id, user.tag, {
    has_belt: belt ?? false,
    has_ring: ring ?? false
  });

  // Auto-refresh Jorm messages
  bus.emit('jormUpdate', { guildId: interaction.guildId });

  return interaction.reply({
    ephemeral: true,
    content: `Added/updated **${user}**. Belt: **${belt ?? false}**, Ring: **${ring ?? false}**.`
  });
}

export async function handlePlayerUpdate(interaction) {
  if (!isAllowedForStandard(interaction, 'playerupdate')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /playerupdate.' });
  }

  const user = interaction.options.getUser('user', true);
  const belt = interaction.options.getBoolean('belt', false);
  const ring = interaction.options.getBoolean('ring', false);

  const ok = updateJormPlayer(interaction.guildId, user.id, {
    has_belt: belt ?? null,
    has_ring: ring ?? null,
    display_name: user.tag
  });

  if (!ok) {
    return interaction.reply({ ephemeral: true, content: `Player **${user}** is not in the list. Use **/playeradd** first.` });
  }

  // Auto-refresh Jorm messages
  bus.emit('jormUpdate', { guildId: interaction.guildId });

  return interaction.reply({
    ephemeral: true,
    content: `Updated **${user}**. Belt: ${belt ?? 'no change'}, Ring: ${ring ?? 'no change'}.`
  });
}
