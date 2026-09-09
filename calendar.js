const { google } = require('googleapis');
const config = require('./config');

function createOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    'https://developers.google.com/oauthplayground' // redirect URI for Desktop app
  );
  
  oauth2Client.setCredentials({
    refresh_token: config.google.refreshToken,
  });
  
  return oauth2Client;
}

async function getCalendarService() {
  const auth = createOAuth2Client();
  return google.calendar({ version: 'v3', auth });
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
  const endTime = parseEventTime(raidEvent.closingtime || raidEvent.endTime || raidEvent.end_time || raidEvent.end, timezone);

  if (!startTime) return null;
  // Default to 2 hours if no explicit end time, same rule used when the event was created
  return endTime || new Date(startTime.getTime() + 2 * 60 * 60 * 1000);
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
  const calendar = await getCalendarService();
  const event = buildCalendarEvent(raidEvent, config.timezone, config.reminderMinutesBefore, userSpec, raidLeader);
  
  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
  });
  
  return response.data.id;
}

async function deleteCalendarEvent(googleEventId) {
  const calendar = await getCalendarService();
  try {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: googleEventId,
    });
  } catch (e) {
    // Already deleted manually or gone (410/404) - not a real failure for our purposes
    if (e.code === 410 || e.code === 404) return;
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