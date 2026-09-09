// User-token (personal login) mode — FULLY AUTOMATIC, no bot invite needed.
//
// Reads the events channels with YOUR OWN Discord account (read-only REST
// calls), finds Raid-Helper posts, then runs the same Raid-Helper API +
// Google Calendar sync as the other modes. You just sign up in Discord
// normally; this script does the rest. No EVENT_IDS to maintain.
//
//   npm run usertoken
//
// Required in .env:
//   DISCORD_USER_TOKEN  - your personal token (how-to below)
//   GUILD_ID            - server ID (right-click server -> Copy Server ID)
//   EVENTS_CHANNEL_IDS  - and/or EVENTS_CATEGORY_IDS (right-click -> Copy ID)
//   MY_DISCORD_USER_ID  - your user ID (right-click yourself -> Copy User ID)
//   + Google OAuth vars (same as other modes)
//
// HOW TO GET YOUR TOKEN (browser, 30 seconds):
//   1. Open https://discord.com/app and log in
//   2. Press F12 -> Console tab, paste:  copy(JSON.parse(localStorage.token))
//   3. Paste into .env as DISCORD_USER_TOKEN (no quotes, no "Bot " prefix)
//
// !!!!!! READ THIS !!!!!!
// - A user token is FULL ACCESS to your account. Never share it, never commit
//   .env, never paste it anywhere. If it leaks, change your Discord password
//   immediately (that invalidates all tokens).
// - Automated access via user tokens violates Discord's ToS. This script is
//   strictly READ-ONLY (it never sends messages or clicks reactions) and polls
//   gently, which keeps the risk low — but it is NOT zero. Worst case is a
//   warning/temporary lock or, rarely, account termination. If that risk is
//   unacceptable, use the bot mode (index.js) or manual mode (standalone.js).
// - Mitigations built in: read-only endpoints only, one pass per poll cycle,
//   POLL_INTERVAL_MINUTES=15 recommended, stops loudly on 401/403/429.

const config = require('./config');
const state = require('./state');
const raidhelper = require('./raidhelper');
const calendar = require('./calendar');

const DISCORD_API = 'https://discord.com/api/v10';
// Browser-like UA: Discord rejects user-token calls with a bot/library UA.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let pollInterval = null;
let isPolling = false;
let cachedChannels = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function authHeaders() {
  return {
    'Authorization': config.discord.userToken,
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
  };
}

async function discordGet(path) {
  const res = await fetch(`${DISCORD_API}${path}`, { headers: authHeaders() });
  if (res.status === 401) {
    throw new Error('Discord 401: invalid DISCORD_USER_TOKEN (expired? password changed?). Get a fresh token and update .env.');
  }
  if (res.status === 403) {
    throw new Error(`Discord 403 on ${path}: token cannot access this (missing channel/guild access?).`);
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Discord rate-limited (429). Increase POLL_INTERVAL_MINUTES. Retry after ~${body.retry_after ?? '?'}s.`);
  }
  if (!res.ok) {
    throw new Error(`Discord API ${res.status} on ${path}: ${await res.text().catch(() => '')}`.slice(0, 300));
  }
  return res.json();
}

// Resolve watched channels: explicit IDs + all chat channels under categories.
async function discoverChannels() {
  const channels = [];
  const seen = new Set();

  for (const id of config.discord.eventsChannelIds) {
    if (!seen.has(id)) {
      seen.add(id);
      try {
        const ch = await discordGet(`/channels/${id}`);
        channels.push({ id: ch.id, name: ch.name || id });
      } catch (e) {
        log(`WARNING: cannot access channel ${id}: ${e.message}`);
      }
    }
  }

  if (config.discord.eventsCategoryIds.length > 0) {
    if (!config.discord.guildId) {
      log('ERROR: EVENTS_CATEGORY_IDS is set but GUILD_ID is empty. Set GUILD_ID in .env.');
      process.exit(1);
    }
    const all = await discordGet(`/guilds/${config.discord.guildId}/channels`);
    // 0=text, 2=voice(with chat), 5=announcement, 13=stage, 15=forum
    const chatTypes = new Set([0, 2, 5, 13, 15]);
    for (const ch of all) {
      if (ch.parent_id && config.discord.eventsCategoryIds.includes(ch.parent_id)
        && chatTypes.has(ch.type) && !seen.has(ch.id)) {
        seen.add(ch.id);
        channels.push({ id: ch.id, name: ch.name || ch.id });
      }
    }
  }

  return channels;
}

function extractTitle(msg) {
  if (msg.embeds && msg.embeds.length > 0 && msg.embeds[0].title) {
    return msg.embeds[0].title;
  }
  if (msg.content) {
    return msg.content.split('\n')[0].substring(0, 100);
  }
  return null;
}

// One discovery pass: latest 50 messages per channel, keep Raid-Helper posts.
async function discoverEvents() {
  const stateData = state.loadState();
  let added = 0;
  for (const ch of cachedChannels) {
    let messages;
    try {
      messages = await discordGet(`/channels/${ch.id}/messages?limit=50`);
    } catch (e) {
      log(`WARNING: cannot read #${ch.name}: ${e.message}`);
      continue;
    }
    for (const msg of messages) {
      if (msg.author && msg.author.id === config.discord.raidHelperBotUserId
        && !state.isEventWatched(stateData, msg.id)) {
        state.addWatchedEvent(stateData, msg.id, extractTitle(msg) || `Event ${msg.id}`);
        log(`[Discover] New event in #${ch.name}: ${extractTitle(msg) || msg.id} (${msg.id})`);
        added++;
      }
    }
  }
  if (added > 0) log(`[Discover] Added ${added} new event(s).`);
}

async function pollEvents() {
  if (isPolling) return;
  isPolling = true;
  try {
    await discoverEvents();
    const stateData = state.loadState();
    const pending = state.getPendingEvents(stateData);
    if (pending.length > 0) {
      log(`Polling ${pending.length} watched event(s) via Raid-Helper API...`);
      for (const event of pending) {
        try {
          await processEvent(event, stateData);
        } catch (e) {
          log(`Error processing event ${event.id}: ${e.message}`);
        }
      }
      state.cleanupOldEvents(stateData);
    }
  } catch (e) {
    log(`Poll error: ${e.message}`);
  }
  isPolling = false;
}

async function processEvent(event, stateData) {
  const raidEvent = await raidhelper.fetchEventWithRetry(event.id);
  if (!raidEvent || raidEvent.status === 'failed') {
    log(`Event ${event.id} not found (deleted), marking skipped`);
    state.updateEventStatus(stateData, event.id, { status: 'skipped' });
    return;
  }

  if (!event.lastPolled) {
    log(`[DEBUG] Raw Raid-Helper response for ${event.id}:`);
    console.dir(raidEvent, { depth: null });
    if (raidEvent.title && event.title !== raidEvent.title) {
      state.updateEventStatus(stateData, event.id, { title: raidEvent.title });
      event.title = raidEvent.title;
    }
  }
  state.updateEventStatus(stateData, event.id, { lastPolled: Date.now() });

  const eventEndTime = calendar.getEventEndTime(raidEvent, config.timezone);
  if (eventEndTime && eventEndTime.getTime() < Date.now()) {
    if (config.deletePastEvents && event.status === 'added' && event.googleEventId) {
      try {
        await calendar.deleteCalendarEvent(event.googleEventId);
        log(`Auto-removed finished event from Google Calendar: ${raidEvent.title || event.title}`);
      } catch (e) {
        log(`Failed to auto-remove finished calendar event: ${e.message}`);
      }
    }
    log(`Skipping past event: ${raidEvent.title || event.title} (ended ${eventEndTime.toISOString()})`);
    state.updateEventStatus(stateData, event.id, { status: 'skipped', googleEventId: null });
    return;
  }

  const mySignup = findMySignUp(raidEvent);
  const myClass = mySignup ? (mySignup.class || mySignup.cClass || mySignup.className || null) : null;
  if (myClass !== event.myClass) {
    state.updateEventStatus(stateData, event.id, { myClass });
    log(`Class for ${event.title}: ${myClass || 'not signed up'}`);
  }

  const isAttending = !!mySignup && !!myClass
    && !config.nonAttendingClasses.includes(myClass.trim().toLowerCase());

  if (isAttending && event.status !== 'added') {
    try {
      log(`Creating calendar event for: ${event.title}`);
      const userSpec = mySignup?.spec || mySignup?.cSpec || mySignup?.role;
      const raidLeader = raidEvent.leadername || raidEvent.creator?.name || raidEvent.leader;
      const googleEventId = await calendar.createCalendarEvent(raidEvent, userSpec, raidLeader);
      state.updateEventStatus(stateData, event.id, { status: 'added', googleEventId, addedAt: Date.now() });
      log(`Added to Google Calendar: ${event.title} (Google ID: ${googleEventId})`);
    } catch (e) {
      log(`Failed to create calendar event: ${e.message}`);
    }
  } else if (!isAttending && event.status === 'added' && event.googleEventId) {
    try {
      log(`Removing calendar event for: ${event.title}`);
      await calendar.deleteCalendarEvent(event.googleEventId);
      state.updateEventStatus(stateData, event.id, { status: 'pending', googleEventId: null, addedAt: null });
      log(`Removed from Google Calendar: ${event.title}`);
    } catch (e) {
      log(`Failed to delete calendar event: ${e.message}`);
    }
  }
}

function findMySignUp(raidEvent) {
  const signUps = raidEvent.signUps
    || raidEvent.signups
    || raidEvent.sign_ups
    || raidEvent.participants
    || raidEvent.attendees
    || [];
  if (!Array.isArray(signUps)) return null;
  for (const signup of signUps) {
    const userId = signup.userId
      || signup.user_id
      || signup.userid
      || signup.discordId
      || signup.discord_id
      || signup.id;
    if (String(userId) === String(config.discord.myUserId)) return signup;
  }
  return null;
}

async function main() {
  if (!config.discord.userToken) {
    log('ERROR: DISCORD_USER_TOKEN is empty. See header comment in usertoken.js for how to get it.');
    process.exit(1);
  }
  if (config.discord.eventsChannelIds.length === 0 && config.discord.eventsCategoryIds.length === 0) {
    log('ERROR: set EVENTS_CHANNEL_IDS and/or EVENTS_CATEGORY_IDS in .env (right-click channel/category -> Copy ID).');
    process.exit(1);
  }
  // Sanity-check the token before starting the loop.
  const me = await discordGet('/users/@me').catch((e) => {
    log(`ERROR: token check failed: ${e.message}`);
    process.exit(1);
  });
  log(`Logged in as ${me.username} (${me.id}). Read-only user-token mode.`);
  if (String(me.id) !== String(config.discord.myUserId)) {
    log(`WARNING: token belongs to ${me.id} but MY_DISCORD_USER_ID=${config.discord.myUserId}. Sign-up detection will fail — fix MY_DISCORD_USER_ID.`);
  }

  cachedChannels = await discoverChannels().catch((e) => {
    log(`ERROR during channel discovery: ${e.message}`);
    process.exit(1);
  });
  if (cachedChannels.length === 0) {
    log('ERROR: no accessible channels. Check EVENTS_CHANNEL_IDS / EVENTS_CATEGORY_IDS + GUILD_ID.');
    process.exit(1);
  }
  log(`Watching: ${cachedChannels.map(c => `#${c.name}`).join(', ')}`);

  await pollEvents();
  if (process.argv.includes('--once')) {
    log('[Once] Single pass complete, exiting (for Alwaysdata Scheduled Tasks / cron).');
    process.exit(0);
  }
  log(`Starting poll interval: every ${config.pollIntervalMs / 60000} minutes (recommended >= 15 in this mode).`);
  pollInterval = setInterval(() => { if (!isPolling) pollEvents(); }, config.pollIntervalMs);
}

process.on('SIGINT', () => {
  log('Shutting down...');
  if (pollInterval) clearInterval(pollInterval);
  process.exit(0);
});
process.on('unhandledRejection', (reason) => log(`Unhandled rejection: ${reason}`));

main();
