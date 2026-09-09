// Node 18+ has a built-in global fetch — no dependency needed.
const doFetch = (...args) => globalThis.fetch(...args);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RAID_HELPER_API_BASE = 'https://raid-helper.dev/api';

async function fetchEvent(eventId) {
  const url = `${RAID_HELPER_API_BASE}/event/${eventId}`;
  const response = await doFetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    const err = new Error(`Raid-Helper API error: ${response.status} ${response.statusText}`);
    err.status = response.status;
    throw err;
  }
  
  return response.json();
}

async function fetchEventWithRetry(eventId, retries = 3, delayMs = 1000) {
  let quiet = false;
  try { quiet = require('./config').quiet; } catch (e) { /* config unavailable (tests) */ }
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchEvent(eventId);
    } catch (e) {
      lastError = e;
      // Rate-limited: retrying immediately only makes it worse. Fail fast —
      // the event stays pending and the next scheduled run picks it up.
      if (e.status === 429) throw e;
      if (i < retries - 1) {
        if (!quiet) console.log(`[RaidHelper] Retry ${i + 1}/${retries} for event ${eventId} after ${delayMs}ms`);
        await sleep(delayMs);
        delayMs *= 2;
      }
    }
  }
  throw lastError;
}

module.exports = {
  fetchEvent,
  fetchEventWithRetry,
  sleep,
};