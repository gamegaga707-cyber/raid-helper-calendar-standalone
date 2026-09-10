// No googleapis dependency: talks to the Calendar REST API + OAuth2 token
// endpoint with the built-in global fetch (Node 18+). Only `dotenv` (via
// config) is needed to run the sync modes.
const config = require('./config');

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60000) {
    return cachedAccessToken;
  }
  const res = await globalThis.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      refresh_token: config.google.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`Google OAuth refresh failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedAccessTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

function parseEventTime(rawTime, timezone) {
  // Try multiple formats that Raid-Helper might return
  if (!rawTime) return null;
  
  // Unix timestamp (seconds or milliseconds)
  if (typeof rawTime === 'number') {
    const ts = rawTime > 1e12 ? rawTime : rawTime * 1000;
    return new Date(ts);
  }
  
  // ISO string or other parseable string
  const parsed = new Date(rawTime);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }
  
  return null;
}

function getEventEndTime(raidEvent, timezone) {
  const startTime = parseEventTime(raidEvent.unixtime || raidEvent.startTime || raidEvent.start_time || raidEvent.start, timezone);
  if (!startTime) return null;

  // Fixed-duration mode: ignore all end fields, event is start + N minutes.
  // N = 0 gives end == start (calendar shows start time only).
  if (config.fixedDurationMinutes >= 0) {
    return new Date(startTime.getTime() + config.fixedDurationMinutes * 60 * 1000);
  }

  // Prefer a REAL end field. `closingtime` is the sign-up deadline (often
  // BEFORE the raid starts) — only use it as end if it is after start.
  // Otherwise Google rejects the event with `timeRangeEmpty`.
  const realEnd = parseEventTime(raidEvent.endTime || raidEvent.end_time || raidEvent.end || raidEvent.endtime, timezone);
  if (realEnd && realEnd.getTime() > startTime.getTime()) return realEnd;

  const closing = parseEventTime(raidEvent.closingtime || raidEvent.closing_time, timezone);
  if (closing && closing.getTime() > startTime.getTime()) return closing;

  // Default to 2 hours if no usable end time, same rule used when the event was created
  return new Date(startTime.getTime() + 2 * 60 * 60 * 1000);
}

function buildCalendarEvent(raidEvent, timezone, reminderMinutes, userSpec, raidLeader) {
  const startTime = parseEventTime(raidEvent.unixtime || raidEvent.startTime || raidEvent.start_time || raidEvent.start, timezone);
  const eventEndTime = getEventEndTime(raidEvent, timezone);

  if (!startTime) {
    throw new Error(`Cannot parse start time from event: ${JSON.stringify(raidEvent)}`);
  }

  // Build summary: "Raid Title - Your Spec (Raid Leader)"
  const raidTitle = raidEvent.displayTitle || raidEvent.title || raidEvent.name || 'Raid Event';
  const summaryParts = [raidTitle];
  if (userSpec) summaryParts.push(userSpec);
  if (raidLeader) summaryParts.push(`(${raidLeader})`);
  const summary = summaryParts.join(' - ');
  
  return {
    summary,
    description: `Synced from Raid-Helper\nRaid: ${raidTitle}\nLeader: ${raidLeader || 'Unknown'}\nYour Spec: ${userSpec || 'Unknown'}\nEvent ID: ${raidEvent.id || 'unknown'}`,
    start: {
      dateTime: startTime.toISOString(),
      timeZone: timezone,
    },
    end: {
      dateTime: eventEndTime.toISOString(),
      timeZone: timezone,
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: reminderMinutes },
      ],
    },
  };
}

async function createCalendarEvent(raidEvent, userSpec, raidLeader) {
  const token = await getAccessToken();
  const event = buildCalendarEvent(raidEvent, config.timezone, config.reminderMinutesBefore, userSpec, raidLeader);

  const response = await globalThis.fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    }
  );

  if (!response.ok) {
    throw new Error(`Calendar insert failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const data = await response.json();
  return data.id;
}

async function deleteCalendarEvent(googleEventId) {
  const token = await getAccessToken();
  try {
    const response = await globalThis.fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      }
    );
    // Already deleted manually or gone (410/404) - not a real failure for our purposes
    if (response.status === 410 || response.status === 404) return;
    if (!response.ok && response.status !== 204) {
      throw new Error(`Calendar delete failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
    }
  } catch (e) {
    // Already deleted manually or gone (410/404) - not a real failure for our purposes
    if (e.code === 410 || e.code === 404) return;
    if (e.status === 410 || e.status === 404) return;
    throw e;
  }
}

module.exports = {
  createCalendarEvent,
  deleteCalendarEvent,
  buildCalendarEvent,
  parseEventTime,
  getEventEndTime,
};