require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name, defaultValue = '') {
  return process.env[name] || defaultValue;
}

function sanitizeToken(value) {
  // Tolerate copy-paste artifacts: surrounding quotes (localStorage shows the
  // value JSON-quoted) and stray whitespace/newlines.
  return (value || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

// Standalone (bot-less) mode: enabled when EVENT_IDS is set or STANDALONE_MODE=true.
// In this mode no Discord bot token / guild is needed — event IDs are supplied
// manually (right-click Raid-Helper message -> Copy Message ID) and all polling
// goes directly to the public Raid-Helper API.
const standaloneEventIds = (process.env.EVENT_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const standaloneMode = process.env.STANDALONE_MODE === 'true' || standaloneEventIds.length > 0;
// User-token mode also needs no bot token/guild invite — discovery happens
// through the personal account's REST access instead.
const userTokenMode = (process.env.DISCORD_USER_TOKEN || '').trim().length > 0;
const botlessMode = standaloneMode || userTokenMode;

module.exports = {
  // QUIET=true in .env (or --quiet flag): suppress per-event spam
  // ([Discover] lines, raw API dumps). Keeps summaries, calendar
  // add/remove actions and errors. Made for Alwaysdata job logs.
  quiet: process.env.QUIET === 'true' || process.argv.includes('--quiet'),
  // Pause between Raid-Helper API calls so big backlogs don't hit 429s.
  apiDelayMs: parseInt(process.env.API_DELAY_MS || '1200', 10),
  standalone: {
    enabled: standaloneMode,
    eventIds: standaloneEventIds,
  },
  discord: {
    botToken: botlessMode ? optionalEnv('DISCORD_BOT_TOKEN') : requireEnv('DISCORD_BOT_TOKEN'),
    guildId: botlessMode ? optionalEnv('GUILD_ID') : requireEnv('GUILD_ID'),
    // Multiple servers: GUILD_IDS=111,222 (comma-separated). Legacy single
    // GUILD_ID still works and is merged in. Only needed for
    // EVENTS_CATEGORY_IDS lookup; explicit EVENTS_CHANNEL_IDS work
    // across servers without any guild ID.
    guildIds: [...new Set([
      ...optionalEnv('GUILD_ID').split(',').map(s => s.trim()).filter(Boolean),
      ...(process.env.GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    ])],
    // Personal-login (user-token) mode: read-only REST polling with your own
    // account. Needed only for `npm run usertoken`. WARNING: automating a user
    // account violates Discord ToS — read the header comment in usertoken.js.
    userToken: sanitizeToken(optionalEnv('DISCORD_USER_TOKEN')),
    eventsChannelIds: (process.env.EVENTS_CHANNEL_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    eventsCategoryIds: (process.env.EVENTS_CATEGORY_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    raidHelperBotUserId: process.env.RAIDHELPER_BOT_USER_ID || '579155972115660803',
    myUserId: requireEnv('MY_DISCORD_USER_ID'),
  },
  // Raid-Helper's `status` field is a constant on every sign-up (e.g. always
  // "primary") - it does NOT tell you if you're in the raid comp or benched.
  // The real signal is the `class` field on your sign-up entry: a real class
  // name (Warrior, Mage, Fire, ...) means you picked a comp slot, while a
  // handful of special values mean you're not actually attending. Since real
  // class names vary per server/game and can't be enumerated, we invert the
  // check: anything NOT in this list counts as "attending".
  nonAttendingClasses: (process.env.NON_ATTENDING_CLASSES || 'Bench,Absence,Tentative,Declined')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  reminderMinutesBefore: parseInt(process.env.REMINDER_MINUTES_BEFORE || '15', 10),
  deletePastEvents: (process.env.DELETE_PAST_EVENTS || 'true').toLowerCase() !== 'false',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MINUTES || '5', 10) * 60 * 1000,
  timezone: process.env.DEFAULT_TIMEZONE || 'Europe/Berlin',
  google: {
    clientId: requireEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
    refreshToken: requireEnv('GOOGLE_REFRESH_TOKEN'),
  },
  stateFile: 'watched_events.json',
};