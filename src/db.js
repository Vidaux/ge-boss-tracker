// src/db.js
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

  /* legacy (pre-guild) columns: keep for migration/backfill, but no longer used for state */
  last_killed_at_utc TEXT,
  window_notif_key TEXT,
  parts_json TEXT,
  reset_respawn_min_hours REAL,
  reset_respawn_max_hours REAL,
  last_trigger_kind TEXT
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  alert_channel_id TEXT,
  admin_role_id TEXT,
  standard_role_id TEXT,
  upcoming_hours INTEGER,
  ping_role_id TEXT,
  ping_minutes INTEGER,
  alert_message_id TEXT,
  jorm_channel_id TEXT,
  jorm_queue_message_id TEXT,
  jorm_ring_message_id TEXT
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

/* Per-guild boss state */
CREATE TABLE IF NOT EXISTS guild_boss_state (
  guild_id TEXT,
  boss_name TEXT,
  last_killed_at_utc TEXT,
  window_notif_key TEXT,
  last_trigger_kind TEXT,
  PRIMARY KEY (guild_id, boss_name),
  FOREIGN KEY (boss_name) REFERENCES bosses(name) ON DELETE CASCADE
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

/* Jorm player tracking - keyed by (guild_id, family_name) */
CREATE TABLE IF NOT EXISTS jorm_players (
  guild_id TEXT,
  family_name TEXT,
  display_name TEXT,
  has_belt INTEGER DEFAULT 0,
  has_ring INTEGER DEFAULT 0,
  used_key_count INTEGER DEFAULT 0,
  queue_order INTEGER,
  /* future-proof armor fields */
  mcc1 TEXT,
  mcc2 TEXT,
  mcc3 TEXT,
  PRIMARY KEY (guild_id, family_name)
);

CREATE TABLE IF NOT EXISTS jorm_queue_history (
  guild_id TEXT,
  family_name TEXT,
  action TEXT, /* 'used'|'skipped' */
  ts_utc TEXT
);
`);

/* -------------------------
   Lightweight add-column migrations (idempotent)
------------------------- */
for (const sql of [
  `ALTER TABLE bosses ADD COLUMN parts_json TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN upcoming_hours INTEGER`,
  `ALTER TABLE guild_settings ADD COLUMN ping_role_id TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN ping_minutes INTEGER`,
  `ALTER TABLE guild_settings ADD COLUMN alert_message_id TEXT`,
  `ALTER TABLE bosses ADD COLUMN reset_respawn_min_hours REAL`,
  `ALTER TABLE bosses ADD COLUMN reset_respawn_max_hours REAL`,
  `ALTER TABLE bosses ADD COLUMN last_trigger_kind TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN channel_id TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN message_id TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN delete_after_utc TEXT`,
  `ALTER TABLE channel_alerts ADD COLUMN deleted INTEGER`,
  /* Jorm settings/message IDs */
  `ALTER TABLE guild_settings ADD COLUMN jorm_channel_id TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN jorm_queue_message_id TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN jorm_ring_message_id TEXT`,
  /* Jorm players columns for new scheme */
  `ALTER TABLE jorm_players ADD COLUMN family_name TEXT`,
  `ALTER TABLE jorm_players ADD COLUMN used_key_count INTEGER`,
  `ALTER TABLE jorm_players ADD COLUMN queue_order INTEGER`,
  `ALTER TABLE jorm_players ADD COLUMN mcc1 TEXT`,
  `ALTER TABLE jorm_players ADD COLUMN mcc2 TEXT`,
  `ALTER TABLE jorm_players ADD COLUMN mcc3 TEXT`,
  /* Jorm history uses family_name */
  `ALTER TABLE jorm_queue_history ADD COLUMN family_name TEXT`
]) {
  try { db.prepare(sql).run(); } catch { /* already exists */ }
}

try {
  db.exec(`
    UPDATE jorm_players
       SET family_name = COALESCE(NULLIF(TRIM(family_name), ''), TRIM(display_name))
     WHERE family_name IS NULL OR TRIM(family_name) = ''
  `);
} catch {}

/* Ensure uniqueness by (guild_id, family_name) even on older DBs */
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_jorm_family ON jorm_players(guild_id, family_name)`); } catch {}

/* Indexes */
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_bosses_name_nocase ON bosses(name COLLATE NOCASE);`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_gbs_guild_boss ON guild_boss_state(guild_id, boss_name);`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_alerts_due ON channel_alerts(guild_id, delete_after_utc);`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jorm_queue_order ON jorm_players(guild_id, queue_order);`); } catch {}

// --------------------------
// Seeding bosses (per-location expansion)
// --------------------------
function asLocationArray(loc) {
  if (Array.isArray(loc)) return loc.map(s => String(s).trim()).filter(Boolean);
  const raw = String(loc || '').trim();
  if (!raw) return [];
  return raw.split('|').map(s => s.trim()).filter(Boolean);
}

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
  const locs = asLocationArray(b.location);
  const multi = locs.length > 1;
  const entries = (multi ? locs : [locs[0] ?? '']).map(loc => {
    const name = multi ? `${b.name} - ${loc}` : b.name;
    return {
      name,
      location: loc || (Array.isArray(b.location) ? (b.location[0] ?? '') : String(b.location ?? '')),
      respawn_min_hours: b.respawn_min_hours ?? null,
      respawn_max_hours: b.respawn_max_hours ?? null,
      special_conditions: b.special_conditions ?? '',
      stats_json: JSON.stringify(b.stats ?? {}),
      drops_json: JSON.stringify(b.drops ?? []),
      respawn_notes_json: JSON.stringify(b.respawn_notes ?? []),
      parts_json: JSON.stringify(b.parts ?? null),
      reset_respawn_min_hours: b.reset_respawn_min_hours ?? null,
      reset_respawn_max_hours: b.reset_respawn_max_hours ?? null
    };
  });
  for (const row of entries) insertBoss.run(row);
}

// Remove base-name rows for multi-location bosses
try {
  const multiBaseNames = bossesSeed
    .filter(b => asLocationArray(b.location).length > 1)
    .map(b => b.name);
  const delStmt = db.prepare(`DELETE FROM bosses WHERE name = ? COLLATE NOCASE`);
  for (const base of multiBaseNames) delStmt.run(base);
} catch {}

// --------------------------
// One-time backfill: legacy global -> per-guild
// --------------------------
(function backfillGlobalKillsToGuildStateOnce() {
  const any = db.prepare(`SELECT 1 FROM guild_boss_state LIMIT 1`).get();
  if (any) return;

  const guilds = db.prepare(`SELECT guild_id FROM guild_settings`).all();
  if (!guilds.length) return;

  const bossesWithKills = db.prepare(`
    SELECT name, last_killed_at_utc, window_notif_key, last_trigger_kind
    FROM bosses WHERE last_killed_at_utc IS NOT NULL
  `).all();
  if (!bossesWithKills.length) return;

  const upsert = db.prepare(`
    INSERT INTO guild_boss_state (guild_id, boss_name, last_killed_at_utc, window_notif_key, last_trigger_kind)
    VALUES (@guild_id, @boss_name, @last_killed_at_utc, @window_notif_key, @last_trigger_kind)
    ON CONFLICT(guild_id, boss_name) DO UPDATE SET
      last_killed_at_utc = excluded.last_killed_at_utc,
      window_notif_key   = excluded.window_notif_key,
      last_trigger_kind  = excluded.last_trigger_kind
  `);

  const tx = db.transaction(() => {
    for (const g of guilds) {
      for (const b of bossesWithKills) {
        upsert.run({
          guild_id: g.guild_id,
          boss_name: b.name,
          last_killed_at_utc: b.last_killed_at_utc,
          window_notif_key: b.window_notif_key ?? `${b.name}:${b.last_killed_at_utc}`,
          last_trigger_kind: b.last_trigger_kind ?? 'death'
        });
      }
    }
    db.prepare(`UPDATE bosses SET last_killed_at_utc = NULL, window_notif_key = NULL, last_trigger_kind = NULL`).run();
  });
  tx();
})();

// --------------------------
// Boss timers & queries (GUILD-SCOPED)
// --------------------------
export function setKilled(guildId, bossName, utcIsoString) {
  const windowKey = `${bossName}:${utcIsoString}`;
  const info = db.prepare(`
    INSERT INTO guild_boss_state (guild_id, boss_name, last_killed_at_utc, window_notif_key, last_trigger_kind)
    VALUES (?, ?, ?, ?, 'death')
    ON CONFLICT(guild_id, boss_name) DO UPDATE SET
      last_killed_at_utc = excluded.last_killed_at_utc,
      window_notif_key   = excluded.window_notif_key,
      last_trigger_kind  = 'death'
  `).run(guildId, bossName, utcIsoString, windowKey);
  return info.changes > 0;
}

export function resetBoss(guildId, bossName) {
  const info = db.prepare(`
    INSERT INTO guild_boss_state (guild_id, boss_name, last_killed_at_utc, window_notif_key, last_trigger_kind)
    VALUES (?, ?, NULL, NULL, NULL)
    ON CONFLICT(guild_id, boss_name) DO UPDATE SET
      last_killed_at_utc = NULL,
      window_notif_key   = NULL,
      last_trigger_kind  = NULL
  `).run(guildId, bossName);
  return info.changes > 0;
}

// STATIC meta by name
export function getBossByName(bossName) {
  const normalized = String(bossName || '').trim().replace(/\s+/g, ' ');
  const row = db.prepare(`SELECT * FROM bosses WHERE name = ? COLLATE NOCASE`).get(normalized);
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

export function getBossForGuild(guildId, bossName) {
  const normalized = String(bossName || '').trim().replace(/\s+/g, ' ');
  const row = db.prepare(`
    SELECT b.*,
           g.last_killed_at_utc,
           g.window_notif_key,
           g.last_trigger_kind
      FROM bosses b
      LEFT JOIN guild_boss_state g
        ON g.boss_name = b.name AND g.guild_id = ?
     WHERE b.name = ? COLLATE NOCASE
  `).get(guildId, normalized);
  if (!row) return null;
  return {
    ...row,
    stats: JSON.parse(row.stats_json || '{}'),
    drops: JSON.parse(row.drops_json || '[]'),
    respawn_notes: JSON.parse(row.respawn_notes_json || '[]'),
    parts: JSON.parse(row.parts_json || 'null')
  };
}

export function getAllBossRows() {
  return db.prepare(`SELECT * FROM bosses ORDER BY name`).all().map(r => ({
    ...r,
    stats: JSON.parse(r.stats_json || '{}'),
    drops: JSON.parse(r.drops_json || '[]'),
    respawn_notes: JSON.parse(r.respawn_notes_json || '[]'),
    parts: JSON.parse(r.parts_json || 'null')
  }));
}

export function getAllBossRowsForGuild(guildId) {
  return db.prepare(`
    SELECT b.*,
           g.last_killed_at_utc,
           g.window_notif_key,
           g.last_trigger_kind
      FROM bosses b
      LEFT JOIN guild_boss_state g
        ON g.boss_name = b.name AND g.guild_id = ?
     ORDER BY b.name
  `).all(guildId).map(r => ({
    ...r,
    stats: JSON.parse(r.stats_json || '{}'),
    drops: JSON.parse(r.drops_json || '[]'),
    respawn_notes: JSON.parse(r.respawn_notes_json || '[]'),
    parts: JSON.parse(r.parts_json || 'null')
  }));
}

export function listKilledBosses(guildId) {
  const rows = db.prepare(`
    SELECT boss_name FROM guild_boss_state
     WHERE guild_id = ? AND last_killed_at_utc IS NOT NULL
     ORDER BY boss_name
  `).all(guildId);
  return rows.map(r => r.boss_name);
}

export function computeWindow(row) {
  if (!row?.last_killed_at_utc) return null;
  const base = DateTime.fromISO(row.last_killed_at_utc, { zone: 'utc' });

  if (
    row.last_trigger_kind === 'reset' &&
    row.reset_respawn_min_hours != null &&
    row.reset_respawn_max_hours != null
  ) {
    const start = base.plus({ hours: Number(row.reset_respawn_min_hours) });
    const end   = base.plus({ hours: Number(row.reset_respawn_max_hours) });
    return { start, end, killed: base, trigger: 'reset' };
  }

  if (row.respawn_min_hours != null && row.respawn_max_hours != null) {
    const start = base.plus({ hours: Number(row.respawn_min_hours) });
    const end   = base.plus({ hours: Number(row.respawn_max_hours) });
    return { start, end, killed: base, trigger: 'death' };
  }

  return null;
}

export function applyServerReset(guildId, utcIsoString) {
  const eligible = db.prepare(`
    SELECT name FROM bosses
     WHERE reset_respawn_min_hours IS NOT NULL
       AND reset_respawn_max_hours IS NOT NULL
  `).all();

  const upsert = db.prepare(`
    INSERT INTO guild_boss_state (guild_id, boss_name, last_killed_at_utc, window_notif_key, last_trigger_kind)
    VALUES (?, ?, ?, ?, 'reset')
    ON CONFLICT(guild_id, boss_name) DO UPDATE SET
      last_killed_at_utc = excluded.last_killed_at_utc,
      window_notif_key   = excluded.window_notif_key,
      last_trigger_kind  = 'reset'
  `);

  const updatedNames = [];
  const tx = db.transaction(() => {
    for (const r of eligible) {
      const key = `${r.name}:${utcIsoString}`;
      const info = upsert.run(guildId, r.name, utcIsoString, key);
      if (info.changes > 0) updatedNames.push(r.name);
    }
  });
  tx();
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
    jorm_channel_id:  patch.jorm_channel_id  ?? existing?.jorm_channel_id  ?? null,
    jorm_queue_message_id: patch.jorm_queue_message_id ?? existing?.jorm_queue_message_id ?? null,
    jorm_ring_message_id:  patch.jorm_ring_message_id  ?? existing?.jorm_ring_message_id  ?? null
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
             alert_message_id = ?,
             jorm_channel_id  = ?,
             jorm_queue_message_id = ?,
             jorm_ring_message_id  = ?
       WHERE guild_id = ?
    `).run(
      merged.alert_channel_id,
      merged.admin_role_id,
      merged.standard_role_id,
      merged.upcoming_hours,
      merged.ping_role_id,
      merged.ping_minutes,
      merged.alert_message_id,
      merged.jorm_channel_id,
      merged.jorm_queue_message_id,
      merged.jorm_ring_message_id,
      guildId
    );
  } else {
    db.prepare(`
      INSERT INTO guild_settings
        (guild_id, alert_channel_id, admin_role_id, standard_role_id,
         upcoming_hours, ping_role_id, ping_minutes, alert_message_id,
         jorm_channel_id, jorm_queue_message_id, jorm_ring_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guildId,
      merged.alert_channel_id,
      merged.admin_role_id,
      merged.standard_role_id,
      merged.upcoming_hours,
      merged.ping_role_id,
      merged.ping_minutes,
      merged.alert_message_id,
      merged.jorm_channel_id,
      merged.jorm_queue_message_id,
      merged.jorm_ring_message_id
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
  const exists = db.prepare(`SELECT 1 FROM user_registrations WHERE user_id = ? AND guild_id = ?`).get(userId, guildId);
  if (exists) {
    db.prepare(`UPDATE user_registrations SET alert_minutes = ? WHERE user_id = ? AND guild_id = ?`).run(minutes, userId, guildId);
  } else {
    db.prepare(`INSERT INTO user_registrations (user_id, guild_id, timezone, alert_minutes) VALUES (?, ?, NULL, ?)`).run(userId, guildId, minutes);
  }
}

export function getUserRegistration(userId, guildId) {
  return db.prepare(`SELECT * FROM user_registrations WHERE user_id = ? AND guild_id = ?`).get(userId, guildId) || null;
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
// Subscriptions
// --------------------------
export function addSubscription(userId, guildId, bossName) {
  db.prepare(`INSERT OR IGNORE INTO user_subscriptions (user_id, guild_id, boss_name) VALUES (?, ?, ?)`).run(userId, guildId, bossName);
}

export function removeSubscription(userId, guildId, bossName) {
  const info = db.prepare(`DELETE FROM user_subscriptions WHERE user_id = ? AND guild_id = ? AND boss_name = ?`).run(userId, guildId, bossName);
  return info.changes > 0;
}

export function listUserSubscriptions(userId, guildId) {
  const rows = db.prepare(`SELECT boss_name FROM user_subscriptions WHERE user_id = ? AND guild_id = ? ORDER BY boss_name`).all(userId, guildId);
  return rows.map(r => r.boss_name);
}

export function userHasAnySubscriptions(userId, guildId) {
  const row = db.prepare(`SELECT 1 FROM user_subscriptions WHERE user_id = ? AND guild_id = ? LIMIT 1`).get(userId, guildId);
  return !!row;
}

export function listRegisteredUsers(guildId) {
  return db.prepare(`SELECT user_id, alert_minutes FROM user_registrations WHERE guild_id = ?`).all(guildId);
}

// --------------------------
// Channel ping tracking + cleanup helpers
// --------------------------
export function markChannelPinged(guildId, bossName, windowKey) {
  db.prepare(`INSERT OR REPLACE INTO channel_alerts (guild_id, boss_name, window_key, pinged) VALUES (?, ?, ?, 1)`).run(guildId, bossName, windowKey);
}

export function hasChannelBeenPinged(guildId, bossName, windowKey) {
  const row = db.prepare(`SELECT pinged FROM channel_alerts WHERE guild_id = ? AND boss_name = ? AND window_key = ?`).get(guildId, bossName, windowKey);
  return !!row?.pinged;
}

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

export function markChannelAlertDeleted(guildId, bossName, windowKey) {
  db.prepare(`UPDATE channel_alerts SET deleted = 1 WHERE guild_id = ? AND boss_name = ? AND window_key = ?`).run(guildId, bossName, windowKey);
}

// --------------------------
// Jorm players (Family Name keyed)
// --------------------------
function getMaxQueueOrder(guildId) {
  const row = db.prepare(`SELECT MAX(queue_order) as maxq FROM jorm_players WHERE guild_id = ? AND has_belt = 0`).get(guildId);
  return row?.maxq ?? 0;
}

function normalizeQueue(guildId) {
  const rows = db.prepare(`
    SELECT family_name FROM jorm_players
     WHERE guild_id = ? AND has_belt = 0
     ORDER BY queue_order, display_name COLLATE NOCASE
  `).all(guildId);
  const tx = db.transaction(() => {
    let n = 1;
    for (const r of rows) {
      db.prepare(`UPDATE jorm_players SET queue_order = ? WHERE guild_id = ? AND family_name = ?`).run(n++, guildId, r.family_name);
    }
  });
  tx();
}

export function upsertJormPlayer(guildId, familyName, { has_belt = false, has_ring = false } = {}) {
  const displayName = familyName; // keep a display field (can diverge later)
  const exists = db.prepare(`SELECT * FROM jorm_players WHERE guild_id = ? AND family_name = ?`).get(guildId, familyName);

  if (exists) {
    db.prepare(`
      UPDATE jorm_players
         SET display_name = ?,
             has_belt = ?,
             has_ring = ?
       WHERE guild_id = ? AND family_name = ?
    `).run(displayName, has_belt ? 1 : 0, has_ring ? 1 : 0, guildId, familyName);

    // If belt status changed eligibility
    const row = db.prepare(`SELECT has_belt, queue_order FROM jorm_players WHERE guild_id = ? AND family_name = ?`).get(guildId, familyName);
    if (row.has_belt) {
      db.prepare(`UPDATE jorm_players SET queue_order = NULL WHERE guild_id = ? AND family_name = ?`).run(guildId, familyName);
      normalizeQueue(guildId);
    } else if (row.queue_order == null) {
      const next = getMaxQueueOrder(guildId) + 1;
      db.prepare(`UPDATE jorm_players SET queue_order = ? WHERE guild_id = ? AND family_name = ?`).run(next, guildId, familyName);
    }
  } else {
    let q = null;
    if (!has_belt) q = getMaxQueueOrder(guildId) + 1;
    db.prepare(`
      INSERT INTO jorm_players (guild_id, family_name, display_name, has_belt, has_ring, used_key_count, queue_order, mcc1, mcc2, mcc3)
      VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL)
    `).run(guildId, familyName, displayName, has_belt ? 1 : 0, has_ring ? 1 : 0, q);
  }
}

export function updateJormPlayer(guildId, familyName, { has_belt = null, has_ring = null, display_name = null } = {}) {
  const exists = db.prepare(`SELECT * FROM jorm_players WHERE guild_id = ? AND family_name = ?`).get(guildId, familyName);
  if (!exists) return false;

  const new_belt = (has_belt === null ? exists.has_belt : (has_belt ? 1 : 0));
  const new_ring = (has_ring === null ? exists.has_ring : (has_ring ? 1 : 0));
  const new_name = (display_name === null ? exists.display_name : display_name);

  db.prepare(`
    UPDATE jorm_players
       SET display_name = ?,
           has_belt = ?,
           has_ring = ?
     WHERE guild_id = ? AND family_name = ?
  `).run(new_name, new_belt, new_ring, guildId, familyName);

  if (new_belt) {
    db.prepare(`UPDATE jorm_players SET queue_order = NULL WHERE guild_id = ? AND family_name = ?`).run(guildId, familyName);
    normalizeQueue(guildId);
  } else if (exists.queue_order == null) {
    const next = getMaxQueueOrder(guildId) + 1;
    db.prepare(`UPDATE jorm_players SET queue_order = ? WHERE guild_id = ? AND family_name = ?`).run(next, guildId, familyName);
  }

  return true;
}

export function listJormQueue(guildId) {
  return db.prepare(`
    SELECT family_name, display_name, used_key_count, queue_order
      FROM jorm_players
     WHERE guild_id = ? AND has_belt = 0
     ORDER BY queue_order, display_name COLLATE NOCASE
  `).all(guildId);
}

export function listJormPlayersWithoutRing(guildId) {
  return db.prepare(`
    SELECT family_name, display_name
      FROM jorm_players
     WHERE guild_id = ? AND has_ring = 0
     ORDER BY display_name COLLATE NOCASE
  `).all(guildId);
}

export function jormRotate(guildId, action /* 'used' | 'skipped' */) {
  const top = db.prepare(`
    SELECT family_name, queue_order, used_key_count
      FROM jorm_players
     WHERE guild_id = ? AND has_belt = 0
     ORDER BY queue_order
     LIMIT 1
  `).get(guildId);
  if (!top) return { rotated: false };

  const max = getMaxQueueOrder(guildId);
  const tx = db.transaction(() => {
    db.prepare(`UPDATE jorm_players SET queue_order = ? WHERE guild_id = ? AND family_name = ?`)
      .run(max + 1, guildId, top.family_name);
    if (action === 'used') {
      db.prepare(`UPDATE jorm_players SET used_key_count = used_key_count + 1 WHERE guild_id = ? AND family_name = ?`)
        .run(guildId, top.family_name);
    }
    db.prepare(`INSERT INTO jorm_queue_history (guild_id, family_name, action, ts_utc) VALUES (?, ?, ?, ?)`)
      .run(guildId, top.family_name, action, DateTime.utc().toISO());
    normalizeQueue(guildId);
  });
  tx();
  return { rotated: true, family_name: top.family_name, action };
}

export function jormUndo(guildId) {
  const last = db.prepare(`
    SELECT rowid, family_name, action FROM jorm_queue_history
     WHERE guild_id = ?
     ORDER BY rowid DESC
     LIMIT 1
  `).get(guildId);
  if (!last) return { undone: false };

  const tx = db.transaction(() => {
    const minRow = db.prepare(`SELECT MIN(queue_order) as minq FROM jorm_players WHERE guild_id = ? AND has_belt = 0`).get(guildId);
    const newTop = (minRow?.minq ?? 1) - 1;
    db.prepare(`UPDATE jorm_players SET queue_order = ? WHERE guild_id = ? AND family_name = ?`).run(newTop, guildId, last.family_name);
    if (last.action === 'used') {
      db.prepare(`UPDATE jorm_players SET used_key_count = MAX(used_key_count - 1, 0) WHERE guild_id = ? AND family_name = ?`).run(guildId, last.family_name);
    }
    db.prepare(`DELETE FROM jorm_queue_history WHERE rowid = ?`).run(last.rowid);
    normalizeQueue(guildId);
  });
  tx();
  return { undone: true, family_name: last.family_name };
}

// --- Player lookups for /player ---
export function getJormPlayerByFamily(guildId, familyName) {
  const name = String(familyName || '').trim();
  if (!name) return null;
  const row = db.prepare(`
    SELECT *
      FROM jorm_players
     WHERE guild_id = ?
       AND (family_name = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE)
     LIMIT 1
  `).get(guildId, name, name);
  return row || null;
}

export function findJormPlayersByName(guildId, nameFragment) {
  const like = `%${String(nameFragment || '').trim()}%`;
  return db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(family_name), ''), TRIM(display_name)) AS family_name,
      display_name
      FROM jorm_players
     WHERE guild_id = ?
       AND (COALESCE(family_name, '') LIKE ? COLLATE NOCASE
         OR COALESCE(display_name, '') LIKE ? COLLATE NOCASE)
     ORDER BY display_name
     LIMIT 10
  `).all(guildId, like, like);
}

export default db;
