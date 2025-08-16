import {
  getBossByName, listBosses, setKilled, resetBoss, computeWindow,
  getGuildSettings, upsertGuildSettings, setCommandRole, getCommandRole,
  upsertUserAlertMinutes
} from '../db.js';

import {
  addSubscription, listUserSubscriptions
} from '../db.js';

import {
  nowUtc, parseServerHHmmToUtcToday, fmtUtc, toUnixSeconds
} from '../utils/time.js';

import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

function titleCase(s){ return s?.trim().replace(/\s+/g, ' ').replace(/\b\w/g, m=>m.toUpperCase()) || ''; }

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

// ---------- New: /listbosses ----------
export async function handleListBosses(interaction) {
  const names = listBosses();
  const embed = new EmbedBuilder()
    .setTitle('Boss List')
    .setDescription(names.length ? names.map(n => `• ${n}`).join('\n') : 'No bosses configured.')
    .setColor(0x95A5A6);
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

// ---------- New: /subscribe <boss> ----------
export async function handleSubscribe(interaction) {
  if (!isAllowedForStandard(interaction, 'subscribe')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /subscribe.' });
  }
  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });

  addSubscription(interaction.user.id, interaction.guildId, check.boss.name);

  const current = listUserSubscriptions(interaction.user.id, interaction.guildId);
  const desc = current.length ? current.map(b => `• ${b}`).join('\n') : 'None';

  const embed = new EmbedBuilder()
    .setTitle('Subscribed to Boss')
    .setDescription(`You will receive alerts for **${check.boss.name}** when you have a /setalert configured.`)
    .addFields({ name: 'Your Subscriptions', value: desc })
    .setColor(0x1ABC9C);

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

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
    if (parsed > nowUtc()) deathUtc = parsed.minus({ days: 1 });
    else deathUtc = parsed;
  }

  const ok = setKilled(boss.name, deathUtc.toISO());
  if (!ok) return interaction.reply({ ephemeral: true, content: 'Failed to record kill. (DB)' });

  const deathUnix = toUnixSeconds(deathUtc);

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Recorded Kill: ${boss.name}`)
        .setDescription(`Respawn window will be recalculated.`)
        .addFields(
          { name: 'Server Time (UTC)', value: fmtUtc(deathUtc), inline: true },
          { name: 'Your Time', value: `<t:${deathUnix}:F>`, inline: true },
          { name: 'Relative', value: `<t:${deathUnix}:R>` }
        )
        .setColor(0x00B894)
    ]
  });
}

export async function handleStatus(interaction) {
  if (!isAllowedForStandard(interaction, 'status')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /status.' });
  }

  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const boss = check.boss;

  if (!boss.last_killed_at_utc) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`${boss.name} Status`)
          .setDescription('Last kill time: **Unknown**\nRespawn window: **Unknown**')
          .addFields({ name: 'Respawn Pattern', value: `${boss.respawn_min_hours}–${boss.respawn_max_hours} hours after death` })
          .setColor(0xD63031)
      ]
    });
  }

  const window = computeWindow(boss);
  const killedUnix = toUnixSeconds(window.killed);
  const startUnix = toUnixSeconds(window.start);
  const endUnix = toUnixSeconds(window.end);

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${boss.name} Status`)
        .addFields(
          { name: 'Last Death — Server', value: fmtUtc(window.killed), inline: true },
          { name: 'Last Death — Your',   value: `<t:${killedUnix}:F>`, inline: true },
          { name: 'Last Death — Relative', value: `<t:${killedUnix}:R>` },
          { name: 'Window Start — Server', value: fmtUtc(window.start), inline: true },
          { name: 'Window Start — Your',   value: `<t:${startUnix}:F>`, inline: true },
          { name: 'Window Start — Relative', value: `<t:${startUnix}:R>` },
          { name: 'Window End — Server', value: fmtUtc(window.end), inline: true },
          { name: 'Window End — Your',   value: `<t:${endUnix}:F>`, inline: true },
          { name: 'Window End — Relative', value: `<t:${endUnix}:R>` }
        )
        .setFooter({ text: 'Server time is UTC. Local times are rendered by Discord.' })
        .setColor(0x0984E3)
    ]
  });
}

export async function handleDetails(interaction) {
  if (!isAllowedForStandard(interaction, 'details')) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /details.' });
  }

  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });
  const b = check.boss;

  const statsLines = Object.entries(b.stats || {}).map(([k, v]) => `**${k}**: ${v}`).join('\n') || '—';
  const notes = (b.respawn_notes || []).map(n => `• ${n}`).join('\n') || '—';

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`${b.name} — Details`)
        .addFields(
          { name: 'Location', value: b.location || 'Unknown', inline: true },
          { name: 'Respawn Pattern', value: `${b.respawn_min_hours}–${b.respawn_max_hours} hours after death`, inline: true },
          { name: 'Special Conditions', value: b.special_conditions || 'None' },
          { name: 'Stats', value: statsLines },
          { name: 'Notes', value: notes }
        )
        .setColor(0x6C5CE7)
    ]
  });
}

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
        .setTitle(`${b.name} — Drops`)
        .setDescription(drops)
        .setColor(0x00CEC9)
    ]
  });
}

export async function handleReset(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /reset.' });
  }
  const bossName = titleCase(interaction.options.getString('boss', true));
  const check = ensureBossExists(bossName);
  if (check.error) return interaction.reply({ ephemeral: true, content: check.error });

  const ok = resetBoss(check.boss.name);
  if (!ok) return interaction.reply({ ephemeral: true, content: 'Failed to reset boss.' });

  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle(`Reset: ${check.boss.name}`)
        .setDescription('Respawn timer cleared. Status is now **Unknown**.')
        .setColor(0xE17055)
    ]
  });
}

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

export async function handleSetCommandRole(interaction) {
  if (!isAdminAllowed(interaction)) {
    return interaction.reply({ ephemeral: true, content: 'You do not have permission to use /setcommandrole.' });
  }
  const commandName = interaction.options.getString('command', true);
  const role = interaction.options.getRole('role', true);
  setCommandRole(interaction.guildId, commandName, role.id);
  return interaction.reply({ ephemeral: true, content: `Set role for /${commandName} to ${role}.` });
}

// /setalert minutes => enroll for DMs and set lead time
export async function handleSetAlert(interaction) {
  const minutes = interaction.options.getInteger('minutes', true);
  if (minutes < 1 || minutes > 1440) {
    return interaction.reply({ ephemeral: true, content: 'Minutes must be between 1 and 1440.' });
  }
  upsertUserAlertMinutes(interaction.user.id, interaction.guildId, minutes);
  return interaction.reply({ ephemeral: true, content: `You will be DM’d ~${minutes} minutes before a subscribed (or all) boss window starts.` });
}
