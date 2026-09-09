// Node 18+ has a built-in global fetch — no dependency needed.
const doFetch = (...args) => globalThis.fetch(...args);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RAID_HELPER_API_BASE = 'https://raid-helper.dev/api';

async function fetchEvent(eventId) {
  const url = `${RAID_HELPER_API_BASE}/event/${eventId}`;
  // 20s timeout so one hung request can't freeze a whole scheduled run.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await doFetch(url, {
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Raid-Helper API timeout for event ${eventId}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  
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
      if (e.status === 429) {
        // Rate-limited: pause 15s and retry once — the window usually clears.
        // If still limited, fail fast; the event stays pending and the next
        // scheduled run picks it up.
        if (i === 0) {
          if (!quiet) console.log(`[RaidHelper] 429 rate-limited on ${eventId}, pausing 15s before one retry...`);
          await sleep(15000);
          continue;
        }
        throw e;
      }
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