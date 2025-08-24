# GE Boss Tracker

Tracks **Granado Espada** boss respawn windows. Uses **UTC internally** and Discord **timestamp formatting** so each user sees the correct local time automatically. Includes a live **Upcoming Spawns dashboard**, optional **role pings** before windows open, and **Jormongand player tracking**.

> Built with **Node 20+**, **discord.js v14**, **SQLite**.

---

## Features

- **UTC-based** timers; embeds show both **Server Time (UTC)** and **Your Time** (`<t:...>`).
- Clean, consistent embeds (no relative times in `/status`, `/killed`, `/upcoming`).
- **Multi-part bosses** (e.g., *Rafflesia*, *Argus*) are tracked as **one boss** (single timer). Parts and their stats appear in `/details`.
- **Multi-location bosses**: if a boss has multiple locations, each location becomes its **own entry** (e.g., `Swamp Angler - Bahamar Dark Swamp`, `Swamp Angler - Bahamar Swamp of Peril`).
- **Subscriptions & DMs** (opt-in):
    - `/subscribe boss|all` / `/unsubscribe boss|all`
    - Default **30 min** alert lead time is set on a user’s first subscribe; adjustable with `/setalert`.
    - `/unsubscribe boss` autocomplete shows **only bosses you’re subscribed to**.
    - `/subscriptions` lists your current subscriptions.
- **Upcoming dashboard** (auto-updated):
    - Shows all windows that **start within N hours** (default **3**).
    - Optional **role ping** X minutes before a window opens.
    - Configurable via **wizard-style `/setup`** with dropdowns & a button.
    - **Instant refresh** whenever `/killed` or `/reset` or `/serverreset` runs.
    - **Stale alert cleanup**: if a boss window changes (kill/reset), any “Spawn Approaching” pings for the old window are removed.
- **Role gating**: `/setcommandrole` can restrict any standard command (including `/jorm`) to a role.
- **Jormongand player tracking (per-server)**:
    - Track who has **Jormongand Belt** and **Montoro Skull Ring**.
    - **Jorm Key Queue**: rotating queue of players without a belt. Buttons: **Used Key**, **Skipped**, **Undo**.
    - **Ring FW List**: players who **do not** have a Montoro Skull Ring.
    - Configure a channel in `/setup` and click **Create/Update Jorm Messages**.
- Lightweight scheduler (ticks every minute; configurable).

---

## Commands

### Player-Facing

- `/killed <boss> [server_time_hhmm]`  
  Record a kill in **UTC**. If time is omitted, uses **now (UTC)**. If provided as `HH:MM` and that time is still in the future **today** (UTC), it assumes **yesterday**.

- `/status <boss>`  
  Shows:
    - **Last Death** or **Last Server Reset** – Your Time / Server Time (UTC)
    - **Respawn Window/Time** – Your Time(s) / Server Time (UTC)

- `/details <boss>`  
  Location, respawn pattern, special conditions, **stats** (per-part when applicable), optional notes.

- `/drops <boss>`  
  Drop list.

- `/upcoming [hours]`  
  Upcoming spawns: shows all windows starting within `hours` (default **3**).

- `/listbosses`  
  Lists all known bosses (canonical names; if multi-location, names are `Boss - Location`).

- `/subscribe boss <boss>` / `/subscribe all`  
  Subscribe to DM alerts (defaults your lead time to **30 min** if you don’t have one yet).

- `/unsubscribe boss <boss>` / `/unsubscribe all`  
  Unsubscribe from one or all bosses.  
  *(Autocomplete for `/unsubscribe boss` only suggests bosses you’re subscribed to.)*

- `/subscriptions`  
  Shows your current subscriptions.

- `/setalert <minutes>`  
  Sets **your** lead time before window start (1–1440).
  > This **does not** enroll you; you must `/subscribe` to receive DMs.

### Jormongand Tracking

- `/jorm addplayer <user> [belt] [ring]` – add a player to the Jorm list (flags default to `false` if omitted).
- `/jorm updateplayer <user> [belt] [ring]` – update belt/ring flags; updates the queue and ring list automatically.
- `/jorm refresh` *(admin)* – (re)post/refresh the **Jorm Key Queue** and **Ring FW List** messages in the configured channel.

The **Jorm Key Queue** shows only players with **Belt = false**; top → bottom rotation:
- **Used Key**: increments their used count and moves them to the bottom.
- **Skipped**: moves them to the bottom without incrementing.
- **Undo**: restores the previous ordering and reverts the last “Used” count (if any).

### Admin

- `/setup` - **Wizard** (no args)  
  Interactive embed with dropdowns to configure:
    1) **Alert Channel** (dashboard & pings)
    2) **Ping Role** (optional)
    3) **Dashboard Lookahead Hours**
    4) **Ping Lead Minutes**
    5) **Jorm Messages Channel**  
       Then click **Create/Update Dashboard Message** and/or **Create/Update Jorm Messages**.  
       *Selections save silently; the wizard reply is dismissed after creating/updating messages.*

- `/reset <boss>`  
  Clear the timer (sets status to **Unknown**). *(Forces a dashboard refresh and cleans stale alerts.)*

- `/serverreset [server_time_hhmm]`  
  Apply a server reset to all reset-based bosses (uses UTC now if omitted). *(Forces refresh + stale alert cleanup.)*

- `/setcommandrole <command> <role>`  
  Gate a command behind a role (otherwise anyone can use it).

---

## DM Alerts

- The bot checks timers **every minute**.
- For each boss with a known last-death/reset time, it computes the respawn window in **UTC**.
- Subscribed users receive a **DM** **~lead minutes** **before the window start** (lead minutes set via `/setalert`).
- **Opt-in model**: users must `/subscribe` (boss or all). If no one subscribes to a boss, no DMs are sent.

---

## Upcoming Dashboard & Role Pings

- The dashboard message (single message in your alert channel) is **auto-updated every minute** to show upcoming spawns for your configured **lookahead hours**.
- If a **ping role** and **lead minutes** are set in `/setup`, the bot **@mentions the role** once when a window is within the lead time.
- **Stale cleanup**: If a boss window changes due to `/killed` or `/serverreset`, old “Spawn Approaching” alerts are removed.
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
