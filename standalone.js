// Standalone (bot-less) mode — no Discord bot invite / gateway needed.
//
// How it works:
//   1. You supply Raid-Helper event IDs manually via EVENT_IDS in .env
//      (Discord: right-click Raid-Helper post -> Copy Message ID.
//       Or Copy Message Link -> last number in the URL is the event ID.)
//   2. This script polls ONLY the public Raid-Helper API:
//        GET https://raid-helper.dev/api/event/{eventId}
//      No Discord token, no guild access, no intents.
//   3. Same Google Calendar sync logic as index.js: when YOUR user ID
//      (MY_DISCORD_USER_ID) has an attending class, a native Calendar
//      event with popup reminder is created; removed on un-signup.
//
// Usage:
//   STANDALONE_MODE=true EVENT_IDS=1187380378235838548,1185027833676968027 npm run standalone
//   or set them in .env and run: npm run standalone

const config = require('./config');
const state = require('./state');
const raidhelper = require('./raidhelper');
const calendar = require('./calendar');

let pollInterval = null;
let isPolling = false;

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
}

function syncEventIdsIntoState() {
  const stateData = state.loadState();
  let added = 0;
  for (const eventId of config.standalone.eventIds) {
    if (!state.isEventWatched(stateData, eventId)) {
      state.addWatchedEvent(stateData, eventId, `Event ${eventId}`);
      log(`[Standalone] Added watched event: ${eventId}`);
      added++;
    }
  }
  if (added === 0) {
    log(`[Standalone] Watching ${Object.keys(stateData.events).length} event(s) from state file.`);
  } else {
    log(`[Standalone] Added ${added} new event(s) to watch list.`);
  }
}

function startPolling() {
  if (pollInterval) return;
  log(`[Standalone] No Discord connection. Polling Raid-Helper API every ${config.pollIntervalMs / 60000} min for ${config.standalone.eventIds.length} configured + stored events.`);
  pollInterval = setInterval(() => {
    if (!isPolling) {
      pollEvents().catch(e => log(`Poll error: ${e.message}`));
    }
  }, config.pollIntervalMs);
  pollEvents().catch(e => log(`Initial poll error: ${e.message}`));
}

async function pollEvents() {
  if (isPolling) return;
  isPolling = true;

  // Re-sync in case EVENT_IDS changed while running
  syncEventIdsIntoState();

  const stateData = state.loadState();
  const pendingEvents = state.getPendingEvents(stateData);

  if (pendingEvents.length === 0) {
    isPolling = false;
    return;
  }

  log(`Polling ${pendingEvents.length} pending events...`);

  for (const event of pendingEvents) {
    try {
      await processEvent(event, stateData);
    } catch (e) {
      log(`Error processing event ${event.id}: ${e.message}`);
    }
  }

  state.cleanupOldEvents(stateData);
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
      state.updateEventStatus(stateData, event.id, {
        status: 'added',
        googleEventId,
        addedAt: Date.now(),
      });
      log(`Added to Google Calendar: ${event.title} (Google ID: ${googleEventId})`);
    } catch (e) {
      log(`Failed to create calendar event: ${e.message}`);
    }
  } else if (!isAttending && event.status === 'added' && event.googleEventId) {
    try {
      log(`Removing calendar event for: ${event.title}`);
      await calendar.deleteCalendarEvent(event.googleEventId);
      state.updateEventStatus(stateData, event.id, {
        status: 'pending',
        googleEventId: null,
        addedAt: null,
      });
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

  if (!Array.isArray(signUps)) {
    return null;
  }

  for (const signup of signUps) {
    const userId = signup.userId
      || signup.user_id
      || signup.userid
      || signup.discordId
      || signup.discord_id
      || signup.id;

    if (String(userId) === String(config.discord.myUserId)) {
      return signup;
    }
  }

  return null;
}

async function main() {
  if (!config.discord.myUserId) {
    log('ERROR: MY_DISCORD_USER_ID is required even in standalone mode (to detect your sign-up).');
    process.exit(1);
  }
  if (config.standalone.eventIds.length === 0) {
    log('WARNING: EVENT_IDS is empty. Will still poll events already stored in watched_events.json.');
    log('Add event IDs to .env: EVENT_IDS=123,456  (right-click Raid-Helper message -> Copy Message ID)');
  } else {
    log(`[Standalone] Configured EVENT_IDS: ${config.standalone.eventIds.join(', ')}`);
  }
  syncEventIdsIntoState();
  if (process.argv.includes('--once')) {
    await pollEvents();
    log('[Once] Single pass complete, exiting (for Alwaysdata Scheduled Tasks / cron).');
    process.exit(0);
  }
  startPolling();
}

process.on('SIGINT', () => {
  log('Shutting down...');
  if (pollInterval) clearInterval(pollInterval);
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

main();
