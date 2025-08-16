import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import path from 'node:path';
import bossesSeed from './data/bosses.json' with { type: 'json' };

const DB_PATH = path.join(process.cwd(), 'ge-boss-tracker.sqlite');
const db = new Database(DB_PATH);

// --------------------------
// Schema & migrations
// --------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS bosses (
  name TEXT PRIMARY KEY,
  location TEXT,
  respawn_min_hours REAL,
  respawn_max_hours REAL,
  special_conditions TEXT,
  stats_json TEXT,
  drops_json TEXT,
  respawn_notes_json TEXT,
  /* legacy columns below are no longer used for timers, but retained for compatibility */
  last_killed_at_utc TEXT,
  window_notif_key TEXT,
  parts_json TEXT,
  reset_respawn_min_hours REAL,
  reset_respawn_max_hours REAL,
  last_trigger_kind TEXT
);

/* NEW: per-guild boss state */
CREATE TABLE IF NOT EXISTS boss_states (
  guild_id TEXT,
  boss_name TEXT,
  last_killed_at_utc TEXT,
  window_notif_key TEXT,
  last_trigger_kind TEXT, -- 'death' | 'reset'
  PRIMARY KEY (guild_id, boss_name)
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  alert_channel_id TEXT,
  admin_role_id TEXT,
  standard_role_id TEXT,
  upcoming_hours INTEGER,
  ping_role_id TEXT,
  ping_minutes INTEGER,
  alert_message_id TEXT
);

CREATE TABLE IF NOT EXISTS command_roles (
  guild_id TEXT,
  command_name TEXT,
  role_id TEXT,
  PRIMARY KEY (guild_id, command_name)
);

CREATE TABLE IF NOT EXISTS user_registrations (
  user_id TEXT,
  guild_id TEXT,
  timezone TEXT,
  alert_minutes INTEGER,
  PRIMARY KEY (user_id, guild_id)
);

CREATE TABLE IF NOT EXISTS user_alerts (
  user_id TEXT,
  guild_id TEXT,
  boss_name TEXT,
  window_key TEXT,
  alerted INTEGER,
  PRIMARY KEY (user_id, guild_id, boss_name, window_key)
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id TEXT,
  guild_id TEXT,
  boss_name TEXT,
  PRIMARY KEY (user_id, guild_id, boss_name)
);

/* Includes metadata for cleanup of channel messages */
CREATE TABLE IF NOT EXISTS channel_alerts (
  guild_id TEXT,
  boss_name TEXT,
  window_key TEXT,
  pinged INTEGER,
  channel_id TEXT,
  message_id TEXT,
  delete_after_utc TEXT,
  deleted INTEGER,
  PRIMARY KEY (guild_id, boss_name, window_key)
);
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_bosses_name_nocase ON bosses(name COLLATE NOCASE);`);

// lightweight add-columns (safe if already exist)
for (const sql of [
  `ALTER TABLE bosses ADD COLUMN parts_json TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN upcoming_hours INTEGER`,
  `ALTER TABLE guild_settings ADD COLUMN ping_role_id TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN ping_minutes INTEGER`,
  `ALTER TABLE guild_settings ADD COLUMN alert_message_id TEXT`,
  `ALTER TABLE bosses ADD COLUMN reset_respawn_min_hours REAL`,
  `ALTER TABLE bosses ADD COLUMN reset_respawn_max_hours REAL`,
  `ALTER TABLE bosses ADD COLUMN last_trigger_kind TEXT`,
  // channel_alerts cleanup metadata
  `ALTER TABLE channel_alerts ADD COLUMN channel_id TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN message_id TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN delete_after_utc TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN deleted INTEGER`
]) { try { db.prepare(sql).run(); } catch { /* ignore */ } }

// --------------------------
// Seeding bosses (static metadata only)
// --------------------------
const insertBoss = db.prepare(`
  INSERT OR IGNORE INTO bosses
  (name, location, respawn_min_hours, respawn_max_hours, special_conditions,
   stats_json, drops_json, respawn_notes_json, last_killed_at_utc, window_notif_key,
   parts_json, reset_respawn_min_hours, reset_respawn_max_hours, last_trigger_kind)
  VALUES (@name, @location, @respawn_min_hours, @respawn_max_hours, @special_conditions,
          @stats_json, @drops_json, @respawn_notes_json, NULL, NULL,
          @parts_json, @reset_respawn_min_hours, @reset_respawn_max_hours, NULL)
`);
for (const b of bossesSeed) {
  insertBoss.run({
    name: b.name,
    location: b.location ?? '',
    respawn_min_hours: b.respawn_min_hours ?? null,
    respawn_max_hours: b.respawn_max_hours ?? null,
    special_conditions: b.special_conditions ?? '',
    stats_json: JSON.stringify(b.stats ?? {}),
    drops_json: JSON.stringify(b.drops ?? []),
    respawn_notes_json: JSON.stringify(b.respawn_notes ?? []),
    parts_json: JSON.stringify(b.parts ?? null),
    reset_respawn_min_hours: b.reset_respawn_min_hours ?? null,
    reset_respawn_max_hours: b.reset_respawn_max_hours ?? null
  });
}

// --------------------------
// Static boss metadata
// --------------------------
export function getBossByName(bossName) {
  const normalized = String(bossName || '').trim().replace(/\s+/g, ' ');
  const row = db.prepare(`
    SELECT * FROM bosses
     WHERE name = ? COLLATE NOCASE
  `).get(normalized);

  if (!row) return null;
  return {
    ...row,
    stats: JSON.parse(row.stats_json || '{}'),
    drops: JSON.parse(row.drops_json || '[]'),
    respawn_notes: JSON.parse(row.respawn_notes_json || '[]'),
    parts: JSON.parse(row.parts_json || 'null')
  };
}

export function listBosses() {
  const rows = db.prepare(`SELECT name FROM bosses ORDER BY name`).all();
  return rows.map(r => r.name);
}

export function getAllBossRows() {
  // static only (no guild state merged)
  return db.prepare(`SELECT * FROM bosses`).all().map(r => ({
    ...r,
    stats: JSON.parse(r.stats_json || '{}'),
    drops: JSON.parse(r.drops_json || '[]'),
    respawn_notes: JSON.parse(r.respawn_notes_json || '[]'),
    parts: JSON.parse(r.parts_json || 'null')
  }));
}

// --------------------------
// Per-guild boss state
// --------------------------
export function getBossState(guildId, bossName) {
  return db.prepare(`
    SELECT * FROM boss_states
     WHERE guild_id = ? AND boss_name = ? COLLATE NOCASE
  `).get(guildId, bossName) || null;
}

export function upsertBossState(guildId, bossName, patch) {
  const existing = getBossState(guildId, bossName);
  const merged = {
    last_killed_at_utc: patch.last_killed_at_utc ?? existing?.last_killed_at_utc ?? null,
    window_notif_key:   patch.window_notif_key   ?? existing?.window_notif_key   ?? null,
    last_trigger_kind:  patch.last_trigger_kind  ?? existing?.last_trigger_kind  ?? null
  };
  db.prepare(`
    INSERT INTO boss_states (guild_id, boss_name, last_killed_at_utc, window_notif_key, last_trigger_kind)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, boss_name) DO UPDATE SET
      last_killed_at_utc = excluded.last_killed_at_utc,
      window_notif_key   = excluded.window_notif_key,
      last_trigger_kind  = excluded.last_trigger_kind
  `).run(guildId, bossName, merged.last_killed_at_utc, merged.window_notif_key, merged.last_trigger_kind);
}

export function setKilled(guildId, bossName, utcIsoString) {
  const windowKey = `${bossName}:${utcIsoString}`;
  upsertBossState(guildId, bossName, {
    last_killed_at_utc: utcIsoString,
    window_notif_key: windowKey,
    last_trigger_kind: 'death'
  });
  return true;
}

export function resetBoss(guildId, bossName) {
  db.prepare(`
    DELETE FROM boss_states
     WHERE guild_id = ? AND boss_name = ? COLLATE NOCASE
  `).run(guildId, bossName);
  return true;
}

/** Static + state merged for a single boss (convenience) */
export function getBossWithState(guildId, bossName) {
  const b = getBossByName(bossName);
  if (!b) return null;
  const s = getBossState(guildId, b.name);
  return {
    ...b,
    last_killed_at_utc: s?.last_killed_at_utc ?? null,
    window_notif_key: s?.window_notif_key ?? null,
    last_trigger_kind: s?.last_trigger_kind ?? null
  };
}

/** Static + state merged for all bosses in a guild (for schedulers/dashboards) */
export function getAllBossRowsForGuild(guildId) {
  const statics = getAllBossRows();
  const states = db.prepare(`
    SELECT * FROM boss_states WHERE guild_id = ?
  `).all(guildId);
  const byName = new Map(states.map(s => [s.boss_name, s]));
  return statics.map(b => {
    const s = byName.get(b.name);
    return {
      ...b,
      last_killed_at_utc: s?.last_killed_at_utc ?? null,
      window_notif_key: s?.window_notif_key ?? null,
      last_trigger_kind: s?.last_trigger_kind ?? null
    };
  });
}

export function listKilledBosses(guildId) {
  const rows = db.prepare(`
    SELECT boss_name AS name
      FROM boss_states
     WHERE guild_id = ? AND last_killed_at_utc IS NOT NULL
     ORDER BY boss_name
  `).all(guildId);
  return rows.map(r => r.name);
}

// --------------------------
// Window computation
// --------------------------
/**
 * Compute the active window from a merged row that includes:
 *   - respawn_min_hours / respawn_max_hours (static)
 *   - reset_respawn_min_hours / reset_respawn_max_hours (static)
 *   - last_killed_at_utc (state)
 *   - last_trigger_kind (state)
 */
export function computeWindow(row) {
  if (!row?.last_killed_at_utc) return null;

  const killed = DateTime.fromISO(row.last_killed_at_utc, { zone: 'utc' });

  // Prefer reset-based window if last trigger was a server reset AND reset mins/maxes exist
  if (
    row.last_trigger_kind === 'reset' &&
    row.reset_respawn_min_hours != null &&
    row.reset_respawn_max_hours != null
  ) {
    const start = killed.plus({ hours: Number(row.reset_respawn_min_hours) });
    const end   = killed.plus({ hours: Number(row.reset_respawn_max_hours) });
    return { start, end, killed, trigger: 'reset' };
  }

  // Fall back to standard death-based window if configured
  if (row.respawn_min_hours != null && row.respawn_max_hours != null) {
    const start = killed.plus({ hours: Number(row.respawn_min_hours) });
    const end   = killed.plus({ hours: Number(row.respawn_max_hours) });
    return { start, end, killed, trigger: 'death' };
  }

  return null; // untracked/static boss
}

// --------------------------
// Apply server reset (per guild)
// --------------------------
export function applyServerReset(guildId, utcIsoString) {
  const eligible = db.prepare(`
    SELECT name FROM bosses
     WHERE reset_respawn_min_hours IS NOT NULL
       AND reset_respawn_max_hours IS NOT NULL
  `).all();

  const updatedNames = [];
  for (const r of eligible) {
    const key = `${r.name}:${utcIsoString}`;
    upsertBossState(guildId, r.name, {
      last_killed_at_utc: utcIsoString,
      window_notif_key: key,
      last_trigger_kind: 'reset'
    });
    updatedNames.push(r.name);
  }
  return { updatedNames };
}

// --------------------------
// Guild settings & command roles
// --------------------------
export function upsertGuildSettings(guildId, patch) {
  const existing = db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`).get(guildId);

  const merged = {
    alert_channel_id: patch.alert_channel_id ?? existing?.alert_channel_id ?? null,
    admin_role_id:    patch.admin_role_id    ?? existing?.admin_role_id    ?? null,
    standard_role_id: patch.standard_role_id ?? existing?.standard_role_id ?? null,
    upcoming_hours:   patch.upcoming_hours   ?? existing?.upcoming_hours   ?? 3,
    ping_role_id:     patch.ping_role_id     ?? existing?.ping_role_id     ?? null,
    ping_minutes:     patch.ping_minutes     ?? existing?.ping_minutes     ?? 30,
    alert_message_id: patch.alert_message_id ?? existing?.alert_message_id ?? null,
  };

  if (existing) {
    db.prepare(`
      UPDATE guild_settings
         SET alert_channel_id = ?,
             admin_role_id    = ?,
             standard_role_id = ?,
             upcoming_hours   = ?,
             ping_role_id     = ?,
             ping_minutes     = ?,
             alert_message_id = ?
       WHERE guild_id = ?
    `).run(
      merged.alert_channel_id,
      merged.admin_role_id,
      merged.standard_role_id,
      merged.upcoming_hours,
      merged.ping_role_id,
      merged.ping_minutes,
      merged.alert_message_id,
      guildId
    );
  } else {
    db.prepare(`
      INSERT INTO guild_settings
        (guild_id, alert_channel_id, admin_role_id, standard_role_id,
         upcoming_hours, ping_role_id, ping_minutes, alert_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      merged.alert_channel_id,
      merged.admin_role_id,
      merged.standard_role_id,
      merged.upcoming_hours,
      merged.ping_role_id,
      merged.ping_minutes,
      merged.alert_message_id
    );
  }
}

export function getGuildSettings(guildId) {
  return db.prepare(`SELECT * FROM guild_settings WHERE guild_id = ?`).get(guildId) || null;
}

export function getAllGuildSettings() {
  return db.prepare(`SELECT * FROM guild_settings`).all();
}

export function setCommandRole(guildId, commandName, roleId) {
  db.prepare(`
    INSERT INTO command_roles (guild_id, command_name, role_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id, command_name) DO UPDATE SET role_id = excluded.role_id
  `).run(guildId, commandName, roleId);
}

export function getCommandRole(guildId, commandName) {
  const row = db.prepare(`
    SELECT role_id FROM command_roles WHERE guild_id = ? AND command_name = ?
  `).get(guildId, commandName);
  return row?.role_id || null;
}

// --------------------------
// User alerts (per-user lead time)
// --------------------------
export function upsertUserAlertMinutes(userId, guildId, minutes) {
  const exists = db.prepare(`
    SELECT 1 FROM user_registrations WHERE user_id = ? AND guild_id = ?
  `).get(userId, guildId);
  if (exists) {
    db.prepare(`
      UPDATE user_registrations
         SET alert_minutes = ?
       WHERE user_id = ? AND guild_id = ?
    `).run(minutes, userId, guildId);
  } else {
    db.prepare(`
      INSERT INTO user_registrations (user_id, guild_id, timezone, alert_minutes)
      VALUES (?, ?, NULL, ?)
    `).run(userId, guildId, minutes);
  }
}

export function getUserRegistration(userId, guildId) {
  return db.prepare(`
    SELECT * FROM user_registrations WHERE user_id = ? AND guild_id = ?
  `).get(userId, guildId) || null;
}

export function markUserAlerted(userId, guildId, bossName, windowKey) {
  db.prepare(`
    INSERT OR REPLACE INTO user_alerts (user_id, guild_id, boss_name, window_key, alerted)
    VALUES (?, ?, ?, ?, 1)
  `).run(userId, guildId, bossName, windowKey);
}

export function hasUserBeenAlerted(userId, guildId, bossName, windowKey) {
  const row = db.prepare(`
    SELECT alerted FROM user_alerts
     WHERE user_id = ? AND guild_id = ? AND boss_name = ? AND window_key = ?
  `).get(userId, guildId, bossName, windowKey);
  return !!row?.alerted;
}

// --------------------------
// Subscriptions (per-boss opt-in)
// --------------------------
export function addSubscription(userId, guildId, bossName) {
  db.prepare(`
    INSERT OR IGNORE INTO user_subscriptions (user_id, guild_id, boss_name)
    VALUES (?, ?, ?)
  `).run(userId, guildId, bossName);
}

export function removeSubscription(userId, guildId, bossName) {
  const info = db.prepare(`
    DELETE FROM user_subscriptions
     WHERE user_id = ? AND guild_id = ? AND boss_name = ?
  `).run(userId, guildId, bossName);
  return info.changes > 0;
}

export function listUserSubscriptions(userId, guildId) {
  const rows = db.prepare(`
    SELECT boss_name FROM user_subscriptions
     WHERE user_id = ? AND guild_id = ?
     ORDER BY boss_name
  `).all(userId, guildId);
  return rows.map(r => r.boss_name);
}

export function userHasAnySubscriptions(userId, guildId) {
  const row = db.prepare(`
    SELECT 1 FROM user_subscriptions WHERE user_id = ? AND guild_id = ? LIMIT 1
  `).get(userId, guildId);
  return !!row;
}

export function listRegisteredUsers(guildId) {
  const rows = db.prepare(`
    SELECT user_id, alert_minutes FROM user_registrations
     WHERE guild_id = ?
  `).all(guildId);
  return rows;
}

// --------------------------
// Channel ping tracking + cleanup helpers
// --------------------------
export function markChannelPinged(guildId, bossName, windowKey) {
  db.prepare(`
    INSERT OR REPLACE INTO channel_alerts (guild_id, boss_name, window_key, pinged)
    VALUES (?, ?, ?, 1)
  `).run(guildId, bossName, windowKey);
}

export function hasChannelBeenPinged(guildId, bossName, windowKey) {
  const row = db.prepare(`
    SELECT pinged FROM channel_alerts WHERE guild_id = ? AND boss_name = ? AND window_key = ?
  `).get(guildId, bossName, windowKey);
  return !!row?.pinged;
}

/** Store the message so it can be deleted later */
export function recordChannelPingMessage(guildId, bossName, windowKey, channelId, messageId, deleteAfterIso) {
  db.prepare(`
    INSERT INTO channel_alerts (guild_id, boss_name, window_key, pinged, channel_id, message_id, delete_after_utc, deleted)
    VALUES (?, ?, ?, 1, ?, ?, ?, 0)
    ON CONFLICT(guild_id, boss_name, window_key) DO UPDATE SET
      pinged = 1,
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      delete_after_utc = excluded.delete_after_utc,
      deleted = 0
  `).run(guildId, bossName, windowKey, channelId, messageId, deleteAfterIso);
}

/** Find messages that are due to be deleted now (or earlier) */
export function listChannelMessagesDueForDeletion(guildId, nowIso) {
  return db.prepare(`
    SELECT guild_id, boss_name, window_key, channel_id, message_id
      FROM channel_alerts
     WHERE guild_id = ?
       AND (deleted IS NULL OR deleted = 0)
       AND message_id IS NOT NULL
       AND channel_id IS NOT NULL
       AND delete_after_utc IS NOT NULL
       AND delete_after_utc <= ?
  `).all(guildId, nowIso);
}

/** Mark a channel alert row as deleted (so we don't try again) */
export function markChannelAlertDeleted(guildId, bossName, windowKey) {
  db.prepare(`
    UPDATE channel_alerts
       SET deleted = 1
     WHERE guild_id = ? AND boss_name = ? AND window_key = ?
  `).run(guildId, bossName, windowKey);
}

export default db;
