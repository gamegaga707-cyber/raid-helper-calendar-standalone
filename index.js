const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config');
const state = require('./state');
const raidhelper = require('./raidhelper');
const calendar = require('./calendar');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let pollInterval = null;
let isPolling = false;

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
}

async function onReady() {
  log(`Logged in as ${client.user.tag}`);
  
  // Get guild
  const guild = await client.guilds.fetch(config.discord.guildId).catch(() => null);
  if (!guild) {
    log(`ERROR: Cannot access guild ${config.discord.guildId}`);
    process.exit(1);
  }
  
  // Collect channels from explicit IDs
  const channels = [];
  for (const channelId of config.discord.eventsChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      log(`ERROR: Cannot access channel ${channelId}`);
      process.exit(1);
    }
    channels.push(channel);
    log(`Watching channel: #${channel.name} (${channel.id})`);
  }
  
  // Collect channels from categories (all text/voice child channels)
  for (const categoryId of config.discord.eventsCategoryIds) {
    const category = await client.channels.fetch(categoryId).catch(() => null);
    if (!category || category.type !== 4) { // 4 = GUILD_CATEGORY
      log(`ERROR: Category ${categoryId} not found or not a category`);
      process.exit(1);
    }
    
    // Get all child channels in this category
    const childChannels = guild.channels.cache.filter(c => c.parentId === categoryId);
    for (const [, childChannel] of childChannels) {
      if (childChannel.isTextBased() || childChannel.isVoiceBased()) {
        channels.push(childChannel);
        log(`Watching channel (from category ${category.name}): #${childChannel.name} (${childChannel.id})`);
      }
    }
  }
  
  if (channels.length === 0) {
    log('ERROR: No channels to watch! Set EVENTS_CHANNEL_IDS or EVENTS_CATEGORY_IDS in .env');
    process.exit(1);
  }
  
  // Initial backfill for all channels
  for (const channel of channels) {
    await backfillEvents(channel);
  }
  
  // Start polling
  startPolling();
}

async function backfillEvents(channel) {
  const stateData = state.loadState();
  const lastBackfill = state.getLastBackfill(stateData);
  
  // Fetch last 50 messages from Raid-Helper
  const messages = await channel.messages.fetch({ limit: 50 });
  const raidHelperMessages = messages.filter(m => m.author.id === config.discord.raidHelperBotUserId);
  
  let added = 0;
  for (const [msgId, message] of raidHelperMessages) {
    if (!state.isEventWatched(stateData, msgId)) {
      // Try to extract event title from message
      const title = extractEventTitle(message) || `Event ${msgId}`;
      state.addWatchedEvent(stateData, msgId, title);
      log(`[Backfill] Added watched event: ${title} (${msgId})`);
      added++;
    }
  }
  
  state.setLastBackfill(stateData);
  log(`Backfill complete for #${channel.name}. Added ${added} new events to watch list.`);
}

function extractEventTitle(message) {
  // Try embed title first
  if (message.embeds.length > 0 && message.embeds[0].title) {
    return message.embeds[0].title;
  }
  // Try content
  if (message.content) {
    // First line often contains the title
    const lines = message.content.split('\n');
    return lines[0].substring(0, 100);
  }
  return null;
}

async function onMessageCreate(message) {
  // Ignore non-Raid-Helper messages
  if (message.author.id !== config.discord.raidHelperBotUserId) return;
  
  // Ignore DMs
  if (!message.guild) return;
  
  // Check if message is in watched channels OR in a watched category
  const inWatchedChannel = config.discord.eventsChannelIds.includes(message.channelId);
  const inWatchedCategory = config.discord.eventsCategoryIds.length > 0 && 
    message.channel.parentId && 
    config.discord.eventsCategoryIds.includes(message.channel.parentId);
  
  if (!inWatchedChannel && !inWatchedCategory) {
    return;
  }
  
  const stateData = state.loadState();
  
  // Already watching this event?
  if (state.isEventWatched(stateData, message.id)) {
    return;
  }
  
  const title = extractEventTitle(message) || `Event ${message.id}`;
  state.addWatchedEvent(stateData, message.id, title);
  log(`New event detected in #${message.channel.name}: ${title} (${message.id})`);
}

function startPolling() {
  if (pollInterval) return;
  
  log(`Starting poll interval: every ${config.pollIntervalMs / 60000} minutes`);
  
  pollInterval = setInterval(() => {
    if (!isPolling) {
      pollEvents().catch(e => log(`Poll error: ${e.message}`));
    }
  }, config.pollIntervalMs);
  
  // Run once immediately
  pollEvents().catch(e => log(`Initial poll error: ${e.message}`));
}

async function pollEvents() {
  if (isPolling) return;
  isPolling = true;
  
  const stateData = state.loadState();
  const pendingEvents = state.getPendingEvents(stateData);
  
  if (pendingEvents.length === 0) {
    isPolling = false;
    return;
  }
  
  log(`Polling ${pendingEvents.length} pending events...`);

  const counts = { added: 0, removed: 0, skipped: 0, unchanged: 0, errors: 0 };
  for (let i = 0; i < pendingEvents.length; i++) {
    if (i > 0) await raidhelper.sleep(config.apiDelayMs);
    if (i > 0 && i % 25 === 0) log(`Progress: ${i}/${pendingEvents.length} events checked...`);
    try {
      counts[await processEvent(pendingEvents[i], stateData)]++;
    } catch (e) {
      counts.errors++;
      log(`Error processing event ${pendingEvents[i].id}: ${e.message}`);
    }
  }
  log(`Poll complete: ${counts.added} added, ${counts.removed} removed, ${counts.skipped} skipped, ${counts.unchanged} unchanged, ${counts.errors} errors.`);
  
  state.cleanupOldEvents(stateData);
  isPolling = false;
}

async function processEvent(event, stateData) {
  // Fetch event details from Raid-Helper API
  const raidEvent = await raidhelper.fetchEventWithRetry(event.id);
  
  if (!raidEvent) {
    if (!config.quiet) log(`Event ${event.id} not found (404), marking skipped`);
    state.updateEventStatus(stateData, event.id, { status: 'skipped' });
    return 'skipped';
  }
  
  // First run: log the raw response to understand the structure
  if (!event.lastPolled) {
    log(`[DEBUG] Raw Raid-Helper response for ${event.id}:`);
    console.dir(raidEvent, { depth: null });
  }
  
  // Update last polled time
  state.updateEventStatus(stateData, event.id, { lastPolled: Date.now() });
  
  // Skip (and clean up) events that have already finished, using end time so we
  // don't remove something that's still ongoing.
  const eventEndTime = calendar.getEventEndTime(raidEvent, config.timezone);
  if (eventEndTime && eventEndTime.getTime() < Date.now()) {
    if (config.deletePastEvents && event.status === 'added' && event.googleEventId) {
      try {
        await calendar.deleteCalendarEvent(event.googleEventId);
        log(`🗑️ Auto-removed finished event from Google Calendar: ${raidEvent.title || event.title}`);
      } catch (e) {
        log(`❌ Failed to auto-remove finished calendar event: ${e.message}`);
      }
    }
    if (!config.quiet) log(`Skipping past event: ${raidEvent.title || event.title} (ended ${eventEndTime.toISOString()})`);
    state.updateEventStatus(stateData, event.id, { status: 'skipped', googleEventId: null });
    return 'skipped';
  }
  
  // Extract my sign-up entry and the class I actually picked (Bench/Absence/
  // Tentative/etc. are NOT real classes and mean "not attending"; anything
  // else - a real class name - means I'm in the raid comp).
  const mySignup = findMySignUp(raidEvent);
  const myClass = mySignup ? (mySignup.class || mySignup.cClass || mySignup.className || null) : null;
  
  if (myClass !== event.myClass) {
    state.updateEventStatus(stateData, event.id, { myClass });
    if (!config.quiet) log(`Class for ${event.title}: ${myClass || 'not signed up'}`);
  }
  
  // Check if I'm attending: must have a sign-up entry, and its class must not
  // be one of the configured non-attending values (case-insensitive).
  const isAttending = !!mySignup && !!myClass
    && !config.nonAttendingClasses.includes(myClass.trim().toLowerCase());
  
  if (isAttending && event.status !== 'added') {
    // Sign up detected - create calendar event
    try {
      log(`Creating calendar event for: ${event.title}`);
      
      // Extract user's spec and raid leader
      const userSpec = mySignup?.spec || mySignup?.cSpec || mySignup?.role;
      const raidLeader = raidEvent.leadername || raidEvent.creator?.name || raidEvent.leader;
      
      const googleEventId = await calendar.createCalendarEvent(raidEvent, userSpec, raidLeader);
      state.updateEventStatus(stateData, event.id, {
        status: 'added',
        googleEventId,
        addedAt: Date.now(),
      });
      log(`✅ Added to Google Calendar: ${event.title} (Google ID: ${googleEventId})`);
      return 'added';
    } catch (e) {
      log(`❌ Failed to create calendar event: ${e.message}`);
      return 'errors';
    }
  } else if (!isAttending && event.status === 'added' && event.googleEventId) {
    // Un-signed up - delete calendar event
    try {
      log(`Removing calendar event for: ${event.title}`);
      await calendar.deleteCalendarEvent(event.googleEventId);
      state.updateEventStatus(stateData, event.id, {
        status: 'pending',
        googleEventId: null,
        addedAt: null,
      });
      log(`🗑️ Removed from Google Calendar: ${event.title}`);
      return 'removed';
    } catch (e) {
      log(`❌ Failed to delete calendar event: ${e.message}`);
      return 'errors';
    }
  }
  return 'unchanged';
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
    
    if (userId === config.discord.myUserId) {
      return signup;
    }
  }
  
  return null;
}

client.once('ready', onReady);
client.on('messageCreate', onMessageCreate);

client.on('error', (error) => {
  log(`Discord client error: ${error.message}`);
});

process.on('SIGINT', () => {
  log('Shutting down...');
  if (pollInterval) clearInterval(pollInterval);
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason}`);
});

client.login(config.discord.botToken).catch(e => {
  log(`Failed to login: ${e.message}`);
  process.exit(1);
});