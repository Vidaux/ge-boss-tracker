# GE Boss Bot

Tracks boss respawn windows for Granado Espada. Uses **UTC internally** and Discord **timestamp formatting** so users see local times automatically.

## Commands
- `/killed <boss> [server_time_hhmm]` - record a kill. If time is omitted, uses current UTC. If given (`HH:MM`) and is “future today” in UTC, it assumes you meant yesterday.
- `/status <boss>` - shows window with **Server (UTC)** and **Your Time** (Discord `<t:…>`).
- `/details <boss>` - location, stats, notes.
- `/drops <boss>` - drop list.
- `/reset <boss>` - admin-only reset to Unknown.
- `/setup [alert_channel] [admin_role] [standard_role]` - admin configuration.
- `/setcommandrole <command> <role>` - gate a specific standard command.
- `/setalert <minutes>` - **enrolls** the user for DMs and sets per-user lead time (1–1440).

## DM Alerts
- The bot checks every minute.
- For each boss with a known last-death time, it computes the respawn window in **UTC**.
- For users who ran `/setalert <minutes>`, it sends a DM **~minutes** before the **window start**.
- Messages show both explicit **Server (UTC)** times and `<t:…>` timestamps for local rendering.

## Setup
1. Fill `.env` with `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` (optional `TEST_GUILD_ID`).
2. `npm install`
3. `npm run register` (test guild if `TEST_GUILD_ID` set; otherwise global)
4. `npm start`
5. In Discord: `/setup` to set alert channel and roles.
6. Users run `/setalert 30` (for example) to get DMs ~30 minutes before the window.

## Notes
- Server time is **UTC**.
- All visible “Your Time” values use Discord’s timestamp feature - clients render them in the viewer’s local time.

## New Commands
- `/listbosses` - lists all known bosses.
- `/subscribe <boss>` - subscribe to alerts for a specific boss.
    - If a user has **any** subscriptions, they’ll only receive DMs for those bosses.
    - If a user has **no** subscriptions, they’ll receive DMs for **all** bosses (when `/setalert` is set).

## Relative Time
Embeds now include Discord relative timestamps like `<t:…:R>` (e.g., “in 27 minutes”) alongside exact server UTC and your local time.
