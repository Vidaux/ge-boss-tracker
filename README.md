# GE Boss Bot

Tracks boss respawn windows for Granado Espada. Supports:
- `/killed <boss> [server_time_hhmm]` (UTC server time, optional HH:MM)
- `/status <boss>` (shows respawn window in Server Time + Your Time)
- `/details <boss>` (location, stats, notes)
- `/drops <boss>` (drop list)
- `/reset <boss>` (admin only via role)
- `/setup [alert_channel] [admin_role] [standard_role]` (admin)
- `/setcommandrole <command> <role>` gate specific standard commands (admin)
- `/register <timezone>` (IANA timezone, for “Your Time” and DMs)
- `/setalert <minutes>` (per-user DM alert minutes before window start)

## Requirements
- Node 18+
- A Discord application and bot token
- Invite the bot with `applications.commands` and proper guild permissions

## Setup
1. `cp .env.example .env` and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`.
2. `npm install`
3. (Optionally set `TEST_GUILD_ID` in `.env` while developing)
4. Register slash commands:
    - Test guild: set `TEST_GUILD_ID` in `.env` then run `npm run register`
    - Global: leave `TEST_GUILD_ID` empty, then `npm run register` (global updates can take a bit to appear)
5. `npm start`

## First-time in your server
- `/setup` to set:
    - `alert_channel` (where start-of-window alerts post)
    - `admin_role` (controls `/reset` and `/setup`)
    - `standard_role` (if set, standard commands are gated to that role)
- (Optional) `/setcommandrole` to gate specific commands like `/killed` separately
- Users run `/register timezone: America/New_York` (or their TZ)
- Users can adjust DM lead time: `/setalert 30` (30 minutes before window)

## Adding/Editing Bosses
- Edit `src/data/bosses.json`, then restart the bot. New/changed bosses are seeded as needed.

## Notes
- “Server Time” is UTC.
- If `/killed` is given a future time for “today” in UTC, the bot assumes you meant yesterday.
- If no `server_time_hhmm` is provided, it uses the current UTC time.
