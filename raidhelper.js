const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const RAID_HELPER_API_BASE = 'https://raid-helper.dev/api';

async function fetchEvent(eventId) {
  const url = `${RAID_HELPER_API_BASE}/event/${eventId}`;
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Raid-Helper API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

async function fetchEventWithRetry(eventId, retries = 3, delayMs = 1000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetchEvent(eventId);
    } catch (e) {
      lastError = e;
      if (i < retries - 1) {
        console.log(`[RaidHelper] Retry ${i + 1}/${retries} for event ${eventId} after ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        delayMs *= 2;
      }
    }
  }
  throw lastError;
}

module.exports = {
  fetchEvent,
  fetchEventWithRetry,
};