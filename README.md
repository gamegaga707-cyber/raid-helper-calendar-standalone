# Raid-Helper → Google Calendar Auto-Reminder Bot

A self-hosted Discord bot that watches Raid-Helper events and automatically adds them to your Google Calendar with a **15-minute popup reminder** when you sign up.

## Features

- ✅ Watches a Discord channel for Raid-Helper events
- ✅ Detects when **you personally** sign up (any "attending" status)
- ✅ Creates native Google Calendar events via API (not ICS subscription)
- ✅ **15-minute popup reminder** — your phone rings/notifies reliably
- ✅ Removes calendar event if you un-sign-up
- ✅ Simple JSON state file (no database needed)
- ✅ Runs on any VPS, Raspberry Pi, or cloud host (Railway, Render, Fly.io)
- ✅ Docker + docker-compose support

---

## Quick Start

### 1. Clone & Install

```bash
git clone <this-repo>
cd raid-helper-calendar-bot
npm install
```

### 2. Get Google OAuth Refresh Token (one-time)

```bash
# 1. Go to https://console.cloud.google.com/
# 2. Create project → Enable "Google Calendar API"
# 3. Credentials → Create Credentials → OAuth 2.0 Client ID
#    - Type: **Desktop app**
#    - Name: "Raid Helper Calendar Bot"
# 4. Download JSON → save as `credentials.json` in this folder

npm run oauth
```

This opens a browser. Authorize with your Google account. Copy the printed **refresh token** into your `.env`.

### 3. Create Discord Bot

1. Go to https://discord.com/developers/applications → **New Application**
2. **Bot** → **Add Bot** → Copy **Token** → paste in `.env` as `DISCORD_BOT_TOKEN`
3. **Bot settings** → Enable **Message Content Intent** (required!)
4. **OAuth2 → URL Generator** → Scopes: `bot` + `applications.commands` → Permissions: `View Channel` + `Read Message History`
5. Open the generated URL → invite bot to your server

### 4. Get IDs (enable Discord Developer Mode: Settings → Advanced → Developer Mode)

| Variable | How to get |
|----------|------------|
| `GUILD_ID` | Right-click server icon → Copy Server ID |
| `EVENTS_CHANNEL_ID` | Right-click the channel where Raid-Helper posts → Copy Channel ID |
| `MY_DISCORD_USER_ID` | Right-click your own username → Copy User ID |
| `RAIDHELPER_BOT_USER_ID` | Usually `579155972115660803` (verify by right-clicking the Raid-Helper bot in your server) |

### 5. Configure `.env`

```bash
cp .env.example .env
# Edit .env with all values from steps 2-4
```

### 6. Run

```bash
# Local test
npm start

# Or with Docker
docker-compose up -d
```

### 7. Use It

1. Raid-Helper posts an event in the watched channel
2. You sign up (click "Accepted", "Bench", "Late", etc.)
3. **Within 5 minutes** (configurable), the bot detects your sign-up
4. Event appears in your Google Calendar with a **15-minute popup reminder**
5. Your phone notifies you 15 min before the raid starts

---

## How It Works

```
┌─────────────────┐     messageCreate      ┌──────────────────┐
│  Raid-Helper    │ ─────────────────────► │  Discord Bot     │
│  posts event    │                        │  (watches channel)│
└─────────────────┘                        └────────┬─────────┘
                                                     │
                                                     ▼
                                              ┌──────────────────┐
                                              │  Local JSON      │
                                              │  (watched_events.  │
                                              │   json)          │
                                              └────────┬─────────┘
                                                       │
                    ┌──────────────────────────────────┘
                    ▼
         ┌─────────────────────┐     Poll every 5 min      ┌──────────────────┐
         │  Google Calendar    │ ◄──────────────────────── │  Raid-Helper API │
         │  (your account)     │   GET /api/event/{id}     │                  │
         └─────────────────────┘     Parse sign-ups        └──────────────────┘
```

---

## Configuration (`.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token | *required* |
| `GUILD_ID` | Discord server ID | *required* |
| `EVENTS_CHANNEL_ID` | Channel where Raid-Helper posts | *required* |
| `RAIDHELPER_BOT_USER_ID` | Raid-Helper bot user ID | `579155972115660803` |
| `MY_DISCORD_USER_ID` | Your Discord user ID | *required* |
| `ATTENDING_STATUSES` | Comma-separated statuses that count as attending | `Accepted,Bench,Late` |
| `REMINDER_MINUTES_BEFORE` | Popup reminder minutes before start | `15` |
| `POLL_INTERVAL_MINUTES` | How often to check for sign-up changes | `5` |
| `DEFAULT_TIMEZONE` | IANA timezone for events | `Europe/Berlin` |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | *required* |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | *required* |
| `GOOGLE_REFRESH_TOKEN` | From `npm run oauth` | *required* |

---

## Deployment Options

### Option A: Docker (recommended)

```bash
docker-compose up -d
docker-compose logs -f
```

### Option B: PM2 (on VPS)

```bash
npm install -g pm2
pm2 start index.js --name raid-calendar
pm2 save
pm2 startup  # follow instructions to auto-start on boot
```

### Option C: systemd (Linux)

```ini
# /etc/systemd/system/raid-calendar.service
[Unit]
Description=Raid-Helper Calendar Bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/raid-helper-calendar-bot
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/home/youruser/raid-helper-calendar-bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now raid-calendar
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "Missing required environment variable" | Check `.env` has all values |
| "Cannot access channel" | Bot lacks permission or wrong channel ID |
| "Message Content Intent" errors | Enable it in Discord Developer Portal → Bot settings |
| "No refresh token received" | Revoke access at https://myaccount.google.com/permissions and re-run `npm run oauth` |
| Events not syncing | Check logs: `docker-compose logs -f` or `pm2 logs raid-calendar` |
| Wrong reminder time | Verify `DEFAULT_TIMEZONE` matches your location |
| Raid-Helper API 404 | Event might be deleted; bot marks it `skipped` automatically |

---

## Project Structure

```
raid-helper-calendar-bot/
├── index.js              # Main bot entry point
├── config.js             # Loads & validates .env
├── state.js              # JSON file state management
├── raidhelper.js         # Raid-Helper API client
├── calendar.js           # Google Calendar API client
├── get-refresh-token.js  # One-time OAuth helper
├── package.json
├── .env.example
├── .env                  # Your config (gitignored)
├── credentials.json      # Google OAuth client (gitignored)
├── token.json            # Saved OAuth tokens (gitignored)
├── watched_events.json   # State file (auto-created)
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## How Sign-Up Detection Works

The bot polls `https://raid-helper.dev/api/event/{eventId}` every 5 minutes (configurable). It looks for a sign-up entry where the user ID matches `MY_DISCORD_USER_ID` and the status is in `ATTENDING_STATUSES`.

**First run logs the raw API response** so you can verify the field names if needed.

---

## Why Not ICS Subscription?

ICS/webcal subscriptions on Android/Google Calendar **do not reliably support custom push reminders**. This bot creates native events via the Google Calendar API using your own OAuth credentials, so reminders behave exactly like events you create manually — your phone rings, vibrates, shows a notification, etc.

---

## Fallback (if maintenance gets annoying)

Raid-Helper Premium has **"individual reminders"** that DM you at a custom time before events you're signed up for. Enable Discord mobile push notifications and it's close to a phone alarm with zero setup.

---

## License

MIT#   r a i d - h e l p e r - c a l e n d a r - s t a n d a l o n e  
 