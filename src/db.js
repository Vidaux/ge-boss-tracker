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

/* Per-guild boss state (NEW) */
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
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_bosses_name_nocase ON bosses(name COLLATE NOCASE);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_gbs_guild_boss ON guild_boss_state(guild_id, boss_name);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_channel_alerts_due ON channel_alerts(guild_id, delete_after_utc);`);

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
// Seeding bosses (per-location expansion)
// --------------------------
function asLocationArray(loc) {
  // New format: array already
  if (Array.isArray(loc)) {
    return loc.map(s => String(s).trim()).filter(Boolean);
  }
  // Back-compat: split only on "|" (never on comma; many legit names contain commas)
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

  // If multiple locations → create one row per location with "Name - Location"
  // If single or empty → keep original name
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

// --- Cleanup: remove stale base-name rows for multi-location bosses ---
// Any boss in the seed that has >1 location should NOT have a base row anymore.
try {
  const multiBaseNames = bossesSeed
    .filter(b => {
      // Same splitter used in seeding
      const asLocationArray = (loc) => {
        if (Array.isArray(loc)) return loc.map(s => String(s).trim()).filter(Boolean);
        const raw = String(loc || '').trim();
        if (!raw) return [];
        return raw.split('|').map(s => s.trim()).filter(Boolean);
      };
      return asLocationArray(b.location).length > 1;
    })
    .map(b => b.name);

  const delStmt = db.prepare(`DELETE FROM bosses WHERE name = ? COLLATE NOCASE`);
  for (const base of multiBaseNames) {
    delStmt.run(base);
  }
} catch (e) {
  // Non-fatal: if anything goes wrong, we just keep going
}


// --------------------------
// One-time backfill: migrate legacy global kills -> per-guild
// --------------------------
(function backfillGlobalKillsToGuildStateOnce() {
  // If guild_boss_state already has rows, skip.
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
    // Clear legacy global fields so they stop affecting anything
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

// STATIC meta by name (no guild state)
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

// STATIC list
export function listBosses() {
  const rows = db.prepare(`SELECT name FROM bosses ORDER BY name`).all();
  return rows.map(r => r.name);
}

// GUILD-SCOPED joins
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
  // static metadata only
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

/**
 * Compute the active window from a row (which may include reset respawns).
 * Row should have: last_killed_at_utc, last_trigger_kind, respawn_min/max, reset_respawn_min/max.
 */
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

/**
 * Apply a server reset for a single guild.
 */
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

// Has this guild already been pinged for this boss+window?
export function hasChannelBeenPinged(guildId, bossName, windowKey) {
  const row = db.prepare(`
    SELECT pinged
      FROM channel_alerts
     WHERE guild_id = ? AND boss_name = ? AND window_key = ?
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
