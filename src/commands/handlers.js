import {
  getBossByName,
  listBosses,
  setKilled,
  resetBoss,
  computeWindow,
  getGuildSettings,
  upsertGuildSettings,
  setCommandRole,
  getCommandRole,
  upsertUserAlertMinutes,
  addSubscription,
  listUserSubscriptions
} from '../db.js';

import {
  nowUtc,
  parseServerHHmmToUtcToday,
  fmtUtc,
  toUnixSeconds
} from '../utils/time.js';

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

// ---------- helpers ----------

function titleCase(s) {
  return s?.trim().replace(/\s+/g, ' ').replace(/\b\w/g, m => m.toUpperCase()) || '';
}

function ensureBossExists(bossName) {
  const boss = getBossByName(bossName);
  if (!boss) {
    const list = listBosses().join(', ');
    return { error: `Unknown boss \`${bossName}\`. Known bosses: ${list}` };
  }
  return { boss };
}

// Role gate: returns true if allowed
function isAllowedForStandard(interaction, commandName) {
  const gs = getGuildSettings(interaction.guildId);
  const explicitRole = getCommandRole(interaction.guildId, commandName);
  const roleToCheck = explicitRole || gs?.standard_role_id;
  if (!roleToCheck) return true; // anyone can use
  return interaction.member.roles.cache.has(roleToCheck);
}

// Admin gate
function isAdminAllowed(interaction) {
  const gs = getGuildSettings(interaction.guildId);
  if (gs?.admin_role_id) {
    return interaction.member.roles.cache.has(gs.admin_role_id);
  }
  return interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

// Formatting helpers
const NBSP_TILDE = '\u00A0~\u00A0'; // keeps Start~End on one line (reduces wrapping)

function formatRespawnPattern(min, max) {
  const nMin = Number(min);
  const nMax = Number(max);
  if (!Number.isNaN(nMin) && !Number.isNaN(nMax) && nMin === nMax) {
    return `${nMin} hours after death`;
  }
  return `${min}–${max} hours after death`;
}

function renderWindowFields(boss, window) {
  // min==max → single time; else Start~End (with non-breaking spaces around ~)
  const min = Number(boss.respawn_min_hours);
  const max = Number(boss.respawn_max_hours);
  const startUnix = toUnixSeconds(window.start);
  const endUnix   = toUnixSeconds(window.end);

  if (!Number.isNaN(min) && !Number.isNaN(max) && min === max) {
    return {
      name: 'Respawn Time',
      value: [
        `**Your Time:** <t:${startUnix}:f>`,
        `**Server Time (UTC):** ${fmtUtc(window.start)}`
      ].join('\n')
    };
  }
  return {
    name: 'Respawn Window',
    value: [
      `**Your Time:** <t:${startUnix}:f>${NBSP_TILDE}<t:${endUnix}:f>`,
      `**Server Time (UTC):** ${fmtUtc(window.start)} ~ ${fmtUtc(window.end)}`
    ].join('\n')
  };
}

function dropsField(boss) {
  const drops = (boss.drops || []);
  const value = drops.length ? drops.map(d => `• ${d}`).join('\n') : '—';
  // Discord field limit is 1024 chars; trim defensively
  return { name: 'Drops', value: value.slice(0, 1024) };
}

// ---------- commands ----------

// /listbosses
export async function handleListBosses(interaction) {
  const names = listBosses();
  const embed = new EmbedBuilder()
    .setTitle('Boss List')
    .setDescription(names.length ? names.map(n => `• ${n}`).join('\n') : 'No bosses configured.')
    .setColor(0x95A5A6);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// /subscribe <boss>
export async function handleSubscribe(interaction) {
  if (!isAllowedForStandard(interaction, 'subscribe')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /subscribe.' });
  }
  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const boss = check.boss;

  addSubscription(interaction.user.id, interaction.guildId, boss.name);

  const current = listUserSubscriptions(interaction.user.id, interaction.guildId);
  const desc = current.length ? current.map(b => `• ${b}`).join('\n') : 'None';

  const embed = new EmbedBuilder()
    .setTitle('Subscribed to Boss')
    .setDescription(`You will receive alerts for **${boss.name}** when you have a /setalert configured.`)
    .addFields(
      { name: 'Your Subscriptions', value: desc },
      dropsField(boss)
    )
    .setColor(0x1ABC9C);

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// /killed
export async function handleKilled(interaction) {
  if (!isAllowedForStandard(interaction, 'killed')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /killed.' });
  }

  const bossName = titleCase(interaction.options.getString('boss', true));
  const timeStr = interaction.options.getString('server_time_hhmm', false);
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const boss = check.boss;

  let deathUtc = nowUtc();
  if (timeStr) {
    const parsed = parseServerHHmmToUtcToday(timeStr);
    if (!parsed) {
      return interaction.reply({ ephemeral: true, content: 'Invalid time format. Use HH:MM in UTC, e.g. 21:22' });
    }
    // If HH:MM UTC is still in the future "today", assume they meant yesterday.
    deathUtc = parsed > nowUtc() ? parsed.minus({ days: 1 }) : parsed;
  }

  if (!setKilled(boss.name, deathUtc.toISO())) {
    return interaction.reply({ ephemeral: true, content: 'Failed to record kill. (DB)' });
  }

  const updated = getBossByName(boss.name);
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
  if (Array.isArray(updated.parts) && updated.parts.length) {
    fields.push({ name: 'Boss Parts', value: updated.parts.map(p => `• ${p.name}`).join('\n') });
  }
  fields.push(dropsField(updated));

  const embed = new EmbedBuilder()
    .setTitle(`Recorded Kill: ${updated.name}`)
    .addFields(fields)
    .setFooter({ text: 'Server time is UTC. Local times are rendered by Discord.' })
    .setColor(0x00B894);

  return interaction.reply({ embeds: [embed] });
}

// /status
export async function handleStatus(interaction) {
  if (!isAllowedForStandard(interaction, 'status')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /status.' });
  }

  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const boss = check.boss;

  // Helper to decide label based on min/max
  const min = Number(boss.respawn_min_hours);
  const max = Number(boss.respawn_max_hours);
  const showSingle = (!Number.isNaN(min) && !Number.isNaN(max) && min === max);
  const windowLabel = showSingle ? 'Respawn Time' : 'Respawn Window';

  // Unknown state: keep ONLY the two sections
  if (!boss.last_killed_at_utc) {
    const embed = new EmbedBuilder()
      .setTitle(`${boss.name} Status`)
      .addFields(
        {
          name: 'Last Death',
          value: [
            `**Your Time:** Unknown`,
            `**Server Time (UTC):** Unknown`
          ].join('\n')
        },
        showSingle
          ? {
              name: windowLabel,
              value: [
                `**Your Time:** Unknown`,
                `**Server Time (UTC):** Unknown`
              ].join('\n')
            }
          : {
              name: windowLabel,
              value: [
                `**Your Time:** Unknown`,
                `**Server Time (UTC):** Unknown`
              ].join('\n')
            }
      )
      .setColor(0xD63031);

    return interaction.reply({ embeds: [embed] });
  }

  // Known state
  const window = computeWindow(boss);
  const killedUnix = toUnixSeconds(window.killed);

  // Use :f to match “August 16, 2025 1:30 AM” style
  const lastDeathField = {
    name: 'Last Death',
    value: [
      `**Your Time:** <t:${killedUnix}:f>`,
      `**Server Time (UTC):** ${fmtUtc(window.killed)}`
    ].join('\n')
  };

  let windowField;
  if (showSingle) {
    const startUnix = toUnixSeconds(window.start);
    windowField = {
      name: 'Respawn Time',
      value: [
        `**Your Time:** <t:${startUnix}:f>`,
        `**Server Time (UTC):** ${fmtUtc(window.start)}`
      ].join('\n')
    };
  } else {
    const NBSP_TILDE = '\u00A0~\u00A0'; // keep the two times together
    const startUnix = toUnixSeconds(window.start);
    const endUnix   = toUnixSeconds(window.end);
    windowField = {
      name: 'Respawn Window',
      value: [
        `**Your Time:** <t:${startUnix}:f>${NBSP_TILDE}<t:${endUnix}:f>`,
        `**Server Time (UTC):** ${fmtUtc(window.start)} ~ ${fmtUtc(window.end)}`
      ].join('\n')
    };
  }

  const embed = new EmbedBuilder()
    .setTitle(`${boss.name} Status`)
    .addFields(lastDeathField, windowField)
    .setColor(0x0984E3);

  return interaction.reply({ embeds: [embed] });
}

// /details  (now includes Drops per your latest request)
export async function handleDetails(interaction) {
  if (!isAllowedForStandard(interaction, 'details')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /details.' });
  }

  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const b = check.boss;

  const fields = [
    { name: 'Location', value: b.location || 'Unknown', inline: true },
    { name: 'Respawn Pattern', value: formatRespawnPattern(b.respawn_min_hours, b.respawn_max_hours), inline: true },
    { name: 'Special Conditions', value: b.special_conditions || 'None' }
  ];

  if (Array.isArray(b.parts) && b.parts.length) {
    for (const part of b.parts) {
      const statsLines = Object.entries(part.stats || {}).map(([k, v]) => `**${k}**: ${v}`).join('\n') || '-';
      fields.push({ name: `Stats — ${part.name}`, value: statsLines });
    }
  } else {
    const statsLines = Object.entries(b.stats || {}).map(([k, v]) => `**${k}**: ${v}`).join('\n') || '-';
    fields.push({ name: 'Stats', value: statsLines });
  }

  if ((b.respawn_notes || []).length) {
    fields.push({ name: 'Notes', value: (b.respawn_notes || []).map(n => `• ${n}`).join('\n') });
  }

  // Add Drops (new request)
  fields.push(dropsField(b));

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${b.name} - Details`)
        .addFields(fields)
        .setColor(0x6C5CE7)
    ]
  });
}

// /drops (unchanged — already dedicated to drop list)
export async function handleDrops(interaction) {
  if (!isAllowedForStandard(interaction, 'drops')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /drops.' });
  }
  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const b = check.boss;
  const drops = (b.drops || []).map(d => `• ${d}`).join('\n') || '—';

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${b.name} - Drops`)
        .setDescription(drops.slice(0, 4096)) // description limit
        .setColor(0x00CEC9)
    ]
  });
}

// /reset
export async function handleReset(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /reset.' });
  }
  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const boss = check.boss;

  const ok = resetBoss(boss.name);
  if (!ok) return interaction.reply({ ephemeral: true, content: 'Failed to reset boss.' });

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Reset: ${boss.name}`)
        .setDescription('Respawn timer cleared. Status is now **Unknown**.')
        .addFields(dropsField(boss))
        .setColor(0xE17055)
    ]
  });
}

// /setup
export async function handleSetup(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /setup.' });
  }
  const channel = interaction.options.getChannel('alert_channel', false);
  const adminRole = interaction.options.getRole('admin_role', false);
  const standardRole = interaction.options.getRole('standard_role', false);

  upsertGuildSettings(interaction.guildId, {
    alert_channel_id: channel?.id ?? null,
    admin_role_id: adminRole?.id ?? null,
    standard_role_id: standardRole?.id ?? null
  });

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('Setup complete')
        .setDescription(
          `Alerts Channel: ${channel ? `<#${channel.id}>` : 'not set'}\n` +
          `Admin Role: ${adminRole ? `<@&${adminRole.id}>` : 'not set'}\n` +
          `Standard Role (gate): ${standardRole ? `<@&${standardRole.id}>` : 'not set'}`
        )
        .setColor(0x2ECC71)
    ],
    ephemeral: true
  });
}

// /setcommandrole
export async function handleSetCommandRole(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /setcommandrole.' });
  }
  const commandName = interaction.options.getString('command', true);
  const role = interaction.options.getRole('role', true);
  setCommandRole(interaction.guildId, commandName, role.id);
  return interaction.reply({ ephemeral: true, content: `Set role for /${commandName} to ${role}.` });
}

// /setalert
export async function handleSetAlert(interaction) {
  const minutes = interaction.options.getInteger('minutes', true);
  if (minutes < 1 || minutes > 1440) {
    return interaction.reply({ ephemeral: true, content: 'Minutes must be between 1 and 1440.' });
  }
  upsertUserAlertMinutes(interaction.user.id, interaction.guildId, minutes);
  return interaction.reply({ ephemeral: true, content: `You will be DM’d ~${minutes} minutes before a subscribed (or all) boss window starts.` });
}
