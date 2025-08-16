import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import path from 'node:path';
import bossesSeed from './data/bosses.json' with { type: 'json' };

const DB_PATH = path.join(process.cwd(), 'ge-boss-bot.sqlite');
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
  last_killed_at_utc TEXT,
  window_notif_key TEXT,
  parts_json TEXT
);

CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  alert_channel_id TEXT,
  admin_role_id TEXT,
  standard_role_id TEXT,
  upcoming_hours INTEGER,      -- NEW: lookahead for dashboard
  ping_role_id TEXT,           -- NEW: role to @mention
  ping_minutes INTEGER,        -- NEW: minutes before start to ping
  alert_message_id TEXT        -- NEW: dashboard message id to edit
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

/* NEW: channel-level ping tracking to avoid duplicate pings per window */
CREATE TABLE IF NOT EXISTS channel_alerts (
  guild_id TEXT,
  boss_name TEXT,
  window_key TEXT,
  pinged INTEGER,
  PRIMARY KEY (guild_id, boss_name, window_key)
);
`);

// lightweight add-columns (safe if already exist)
for (const sql of [
  `ALTER TABLE bosses ADD COLUMN parts_json TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN upcoming_hours INTEGER`,
  `ALTER TABLE guild_settings ADD COLUMN ping_role_id TEXT`,
  `ALTER TABLE guild_settings ADD COLUMN ping_minutes INTEGER`,
  `ALTER TABLE guild_settings ADD COLUMN alert_message_id TEXT`
]) { try { db.prepare(sql).run(); } catch { /* ignore */ } }

// --------------------------
// Seeding bosses
// --------------------------
const insertBoss = db.prepare(`
  INSERT OR IGNORE INTO bosses
  (name, location, respawn_min_hours, respawn_max_hours, special_conditions,
   stats_json, drops_json, respawn_notes_json, last_killed_at_utc, window_notif_key, parts_json)
  VALUES (@name, @location, @respawn_min_hours, @respawn_max_hours, @special_conditions,
          @stats_json, @drops_json, @respawn_notes_json, NULL, NULL, @parts_json)
`);
for (const b of bossesSeed) {
  insertBoss.run({
    name: b.name,
    location: b.location ?? '',
    respawn_min_hours: b.respawn_min_hours ?? 0,
    respawn_max_hours: b.respawn_max_hours ?? 0,
    special_conditions: b.special_conditions ?? '',
    stats_json: JSON.stringify(b.stats ?? {}),
    drops_json: JSON.stringify(b.drops ?? []),
    respawn_notes_json: JSON.stringify(b.respawn_notes ?? []),
    parts_json: JSON.stringify(b.parts ?? null)
  });
}

// --------------------------
// Boss timers & queries
// --------------------------
export function setKilled(bossName, utcIsoString) {
  const windowKey = `${bossName}:${utcIsoString}`;
  const stmt = db.prepare(`
    UPDATE bosses
       SET last_killed_at_utc = ?, window_notif_key = ?
     WHERE name = ?
  `);
  const info = stmt.run(utcIsoString, windowKey, bossName);
  return info.changes > 0;
}

export function resetBoss(bossName) {
  const stmt = db.prepare(`
    UPDATE bosses
       SET last_killed_at_utc = NULL, window_notif_key = NULL
     WHERE name = ?
  `);
  const info = stmt.run(bossName);
  return info.changes > 0;
}

export function getBossByName(bossName) {
  const row = db.prepare(`SELECT * FROM bosses WHERE name = ?`).get(bossName);
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
  return db.prepare(`SELECT * FROM bosses`).all().map(r => ({
    ...r,
    stats: JSON.parse(r.stats_json || '{}'),
    drops: JSON.parse(r.drops_json || '[]'),
    respawn_notes: JSON.parse(r.respawn_notes_json || '[]'),
    parts: JSON.parse(r.parts_json || 'null')
  }));
}

export function computeWindow(row) {
  if (!row?.last_killed_at_utc) return null;
  const killed = DateTime.fromISO(row.last_killed_at_utc, { zone: 'utc' });
  const start = killed.plus({ hours: row.respawn_min_hours });
  const end   = killed.plus({ hours: row.respawn_max_hours });
  return { start, end, killed };
}

// --------------------------
// Guild settings & command roles
// --------------------------
export function upsertGuildSettings(guildId, settings) {
  const existing = db.prepare(`SELECT 1 FROM guild_settings WHERE guild_id = ?`).get(guildId);
  if (existing) {
    const keys = [
      'alert_channel_id','admin_role_id','standard_role_id',
      'upcoming_hours','ping_role_id','ping_minutes','alert_message_id'
    ];
    const sets = keys.map(k => `${k} = COALESCE(@${k}, ${k})`).join(', ');
    db.prepare(`UPDATE guild_settings SET ${sets} WHERE guild_id = @guild_id`)
      .run({ guild_id: guildId, ...settings });
  } else {
    db.prepare(`
      INSERT INTO guild_settings
      (guild_id, alert_channel_id, admin_role_id, standard_role_id, upcoming_hours, ping_role_id, ping_minutes, alert_message_id)
      VALUES (@guild_id, @alert_channel_id, @admin_role_id, @standard_role_id, @upcoming_hours, @ping_role_id, @ping_minutes, @alert_message_id)
    `).run({ guild_id: guildId, ...settings });
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

// --------------------------
// Channel ping tracking
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

export default db;
