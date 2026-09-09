const fs = require('fs');
const path = require('path');
const config = require('./config');

const STATE_FILE = config.stateFile;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[State] Failed to load state, starting fresh:', e.message);
  }
  return { events: {}, lastBackfill: null };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[State] Failed to save state:', e.message);
  }
}

function isEventWatched(state, eventId) {
  return !!state.events[eventId];
}

function addWatchedEvent(state, eventId, eventTitle) {
  state.events[eventId] = {
    title: eventTitle,
    status: 'pending',
    googleEventId: null,
    addedAt: null,
    lastPolled: null,
    myStatus: null,
  };
  saveState(state);
}

function updateEventStatus(state, eventId, updates) {
  if (state.events[eventId]) {
    state.events[eventId] = { ...state.events[eventId], ...updates };
    saveState(state);
  }
}

function getWatchedEvents(state) {
  return Object.entries(state.events).map(([id, data]) => ({ id, ...data }));
}

function getPendingEvents(state) {
  // Keep re-checking 'added' events too (not just 'pending'), so that if your
  // status later changes away from an attending status, the bot detects it
  // and removes the calendar event. Only 'skipped' (past/invalid) events are excluded.
  return getWatchedEvents(state).filter(e => e.status !== 'skipped');
}

function cleanupOldEvents(state, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  let changed = false;
  for (const [id, event] of Object.entries(state.events)) {
    // If event has start time and it's past + buffer, or if it's been watched for too long
    if (event.addedAt && (now - event.addedAt) > maxAgeMs) {
      delete state.events[id];
      changed = true;
    }
  }
  if (changed) saveState(state);
}

function setLastBackfill(state, timestamp = Date.now()) {
  state.lastBackfill = timestamp;
  saveState(state);
}

function getLastBackfill(state) {
  return state.lastBackfill;
}

module.exports = {
  loadState,
  saveState,
  isEventWatched,
  addWatchedEvent,
  updateEventStatus,
  getWatchedEvents,
  getPendingEvents,
  cleanupOldEvents,
  setLastBackfill,
  getLastBackfill,
};