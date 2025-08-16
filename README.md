# GE Boss Tracker

Tracks **Granado Espada** boss respawn windows. Uses **UTC internally** and Discord **timestamp formatting** so each user sees the correct local time automatically. Includes a live **Upcoming Spawns dashboard**, optional **role pings**, **DM alerts**, and **automatic cleanup** of stale alerts.

> Built with **Node 20+**, **discord.js v14**, **SQLite**.

---

## Features

- **UTC-based** timers; embeds show both **Server Time (UTC)** and **Your Time** (`<t:...>`).
- Clean, consistent embeds (no relative times in `/status`, `/killed`, `/upcoming`).
- **Per-Guild timers & state** ✨  
  Boss kill times and windows are stored **per Discord guild**, so multiple servers can track independently.
- **Reset-aware respawns** ✨  
  Supports alternative **reset respawn windows** when timers are driven by a server reset.
- **Multi-part bosses** (e.g., *Rafflesia*, *Argus*) tracked as **one boss** (single timer). Parts and stats appear in `/details`.
- **Subscriptions & DMs** (opt-in):
  - `/subscribe boss|all` / `/unsubscribe boss|all`
  - Default **30 min** lead time set on first subscribe; adjust with `/setalert`.
  - `/unsubscribe boss` autocomplete shows **only bosses you’re subscribed to**.
  - `/subscriptions` lists your current subscriptions.
- **Upcoming dashboard** (auto-updated):
  - Shows **all respawn windows starting within N hours** (default **3h**). Already-open windows count as “now” and are sorted earliest first.
  - Optional **role ping** X minutes before a window opens (one ping per boss window).
  - Configurable via a **wizard-style `/setup`** with dropdowns & button.
  - **Instant refresh** whenever timers change (via `/killed`, `/reset`, `/serverreset`).
- **Stale alert cleanup** ✨
  - **Event-driven:** If a boss window changes (new kill or server reset), any outdated **“Spawn Approaching – <boss>”** messages in the alert channel are **deleted immediately**.
  - **Time-based:** “Spawn Approaching” messages also **auto-delete 30 minutes after window end**.
- **Role gating**: `/setcommandrole` can restrict any standard command to a role.
- Lightweight scheduler (ticks every minute).

---

## Commands

### Player-Facing

- `/killed <boss> [server_time_hhmm]`  
  Record a kill in **UTC**. If time is omitted, uses **now (UTC)**. If provided as `HH:MM` and that time is still in the future **today** (UTC), it assumes **yesterday**.  
  *(Per-guild; only changes the current server’s data.)*

- `/status <boss>`  
  Shows:
  - **Last Death** (or **Last Server Reset** when applicable) – Your Time / Server Time (UTC)
  - **Respawn Window/Time** – Your Time(s) / Server Time (UTC)  
    *(If `min==max`, shows a single **Respawn Time**.)*

- `/details <boss>`  
  Location, respawn pattern (+optional reset window), special conditions, **stats** (per-part when applicable), notes.

- `/drops <boss>`  
  Drop list.

- `/upcoming [hours]`  
  Shows **all** windows that **start within `hours`** (default **3**). Already-open windows are included and the list is sorted by the soonest relevant time.

- `/listbosses`  
  Lists all known bosses (canonical names; **boss parts are not listed**).

- `/subscribe boss <boss>` / `/subscribe all`  
  Subscribe to DM alerts (defaults your lead time to **30 min** if you don’t have one yet).

- `/unsubscribe boss <boss>` / `/unsubscribe all`  
  Unsubscribe from one or all bosses.  
  *(Autocomplete for `/unsubscribe boss` suggests **only your subscriptions**.)*

- `/subscriptions`  
  Shows your current subscriptions.

- `/setalert <minutes>`  
  Sets **your** lead time before window start (1–1440).
  > This **does not** enroll you; you must `/subscribe` to receive DMs.

### Admin

- `/setup` — **Wizard** (no args)  
  Interactive embed with dropdowns to configure:
  1) **Alert Channel** (dashboard & pings)
  2) **Ping Role** (optional)
  3) **Dashboard Lookahead Hours**
  4) **Ping Lead Minutes**  
     Then click **Create/Update Dashboard Message** to post or refresh the dashboard.  
     *Dropdown picks save silently; the wizard dismisses after creating/updating.*

- `/reset <boss>`  
  Clear the timer for a boss **in this guild** (status becomes **Unknown**).  
  **Triggers:** instant dashboard refresh **and** stale “Spawn Approaching” cleanup.

- `/serverreset [server_time_hhmm]`  
  Apply a **server reset** time for this guild and recalculate windows for bosses that use **reset-based respawns**.  
  **Triggers:** instant dashboard refresh **and** stale “Spawn Approaching” cleanup for all affected bosses.

- `/setcommandrole <command> <role>`  
  Gate a command behind a role (otherwise anyone can use it).

---

## DM Alerts

- The bot checks timers **every minute**.
- For each boss with a known last-death/reset time, it computes the respawn window in **UTC**.
- Subscribed users receive a **DM** **~lead minutes** **before window start** (lead minutes set via `/setalert`).
- **Opt-in model**: users must `/subscribe` (boss or all). If no one subscribes to a boss, no DMs are sent.

---

## Upcoming Dashboard, Pings & Cleanup

- The dashboard message (single message in your alert channel) is **auto-updated every minute** based on your **lookahead hours**.
- If a **ping role** and **lead minutes** are set in `/setup`, the bot **@mentions the role** once when a window is within the lead time.
- **Cleanup behavior:**
  - When a timer changes (new `/killed`, `/reset`, `/serverreset`), the bot **immediately removes** any **out-of-date** “Spawn Approaching – <boss>” messages for that boss.
  - Regardless, any “Spawn Approaching” messages **expire** and are **deleted 30 minutes after** the window ends.
- Ensure the bot can send messages in the channel and can mention the chosen role (make role “mentionable” or grant permission).

---

## Quick Start

1) **Clone & install**
```bash
cd /opt
git clone <your-repo-url> ge-boss-tracker
cd ge-boss-tracker
npm ci


```
2) **Create .env**
```bash
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
# Optional: instant guild registration during development
TEST_GUILD_ID=your-guild-id
```
3) **Register commands**
```bash
npm run register
```
4) **Run the bot (PM2 recommended)**
```bash
pm2 start src/index.js --name ge-boss-tracker
pm2 save
pm2 startup   # optional: start on reboot
```
5) **Configure in Discord**
- Run /setup (admin).
- Choose Alert Channel, Ping Role (optional), Lookahead Hours, Ping Lead Minutes.
- Click Create/Update Dashboard Message.
6) **Users opt-in**
- /subscribe boss <name> or /subscribe all
- /setalert 30 (for example) to get DMs ~30 minutes before a subscribed boss window opens.

## Permissions to Invite

When generating the OAuth2 URL (Developer Portal), include **scopes**:

- `bot`
- `applications.commands`

**Recommended permissions**:

- Send Messages
- Embed Links
- Read Message History
- Mention @everyone, @here, and All Roles *(or make your ping role “mentionable”)*

---

## Autocomplete Notes

- All `<boss>` options support autocomplete.
- `/unsubscribe boss` autocomplete filters to **only the user’s current subscriptions**.

---

## Data & Reseeding

- Data is stored in `./ge-boss-tracker.sqlite`.
- Boss definitions seed from `src/data/bosses.json` on first run.

To reseed bosses **without** touching guild/user settings:

```bash
pm2 stop ge-boss-tracker
sqlite3 ge-boss-tracker.sqlite "DELETE FROM bosses; VACUUM;"
pm2 start ge-boss-tracker
