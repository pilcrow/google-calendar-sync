// vim: set ft=javascript ts=2 sw=2 et:

// Functions for wrapping the Google Calendar API:
//   - pacing write operations per calendar to avoid burst limits
//   - handling pageToken pagination, syncToken extraction
//   - counting API calls
//
// All functions are calFooBar(...) and take a calendar ID as the
// first parameter.

const DEFAULT_API_PAGE_SIZE = 250; // override in Config.gs API_PAGE_SIZE
const DEFAULT_OPS_ENTRY = { added: 0, removed: 0, updated: 0 };
const CAL_OPS = { events: {},
                  apiCalls: { 'CalendarList.list': 0,
                              'Events.get': 0,
                              'Events.insert': 0,
                              'Events.list': 0,
                              'Events.remove': 0,
                              'Events.update': 0 } };

/**
 * Sleep if needed to ensure a 500ms pause since the last write operation we
 * performed on the given calendar.  Intended to be called immediately before a
 * write operation.
 *
 * @param {string} calendarId - The calendar which we're about to modify
 */
const _paceCalendarWrite = (function() {
  const LAST_WRITE_OP = {};

  return function(calendarId) {
    const now = Date.now();
    const elapsedSinceLastWrite = now - (LAST_WRITE_OP[calendarId] ||= 0);
    let zzz = 0;
    if (elapsedSinceLastWrite < 500) {
      zzz = 500 - elapsedSinceLastWrite;
      Utilities.sleep(zzz);
    }
    LAST_WRITE_OP[calendarId] = now + zzz;
  }
})();

/**
 * Fetch a single event by ID, by default returning null if the API reports it
 * absent (404).
 *
 * Deliberately status-agnostic: a soft-deleted (cancelled) event still resolves
 * — GET returns 200 with `status: 'cancelled'` — so a non-null result is not
 * proof the event is active.  Callers needing "active" semantics must check
 * `status` themselves.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {string} eventId - The event to fetch
 * @param {number[]} [toleratedErrors=[404]] - HTTP errors to tolerate
 * @return {Object|null} The event regardless of status, or null
 */
function calGetEvent(calendarId, eventId, toleratedErrors = [404]) {
  try {
    CAL_OPS.apiCalls[ 'Events.get' ]++;
    return Calendar.Events.get(calendarId, eventId);
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, ...toleratedErrors)) { throw e; }
  }
  return null;
}

/**
 * Remove the given eventId from the specified calendar.  By default, 404s and
 * 410s are tolerated.  Others will raise an exception.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {string} eventId - The event to be removed
 * @param {number[]} [toleratedErrors=[404,410]] - HTTP errors to tolerate
 * @return {boolean} True if the event existed and was removed.
 */
function calRemoveEvent(calendarId, eventId, toleratedErrors = [404, 410]) {
  let removed = false;

  _paceCalendarWrite(calendarId);
  CAL_OPS.apiCalls[ 'Events.remove' ]++;
  try {
    Calendar.Events.remove(calendarId, eventId);
    (CAL_OPS.events[calendarId] ||= { ...DEFAULT_OPS_ENTRY }).removed++;
    removed = true;
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, ...toleratedErrors)) { throw e; }
  }

  return removed;
}


/**
 * Insert an event.  By default, returns false on a 409 collision with
 * an already existing event by the same ID.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {Object} event - The event to be inserted
 * @param {number[]} [toleratedErrors=[]] - HTTP errors to tolerate
 * @return {boolean} True if the event was inserted
 */
function calInsertEvent(calendarId, event, toleratedErrors = [409]) {
  let inserted = false;

  _paceCalendarWrite(calendarId);
  CAL_OPS.apiCalls[ 'Events.insert' ]++;
  try {
    Calendar.Events.insert(event, calendarId);
    (CAL_OPS.events[calendarId] ||= { ...DEFAULT_OPS_ENTRY }).added++;
    inserted = true;
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, ...toleratedErrors)) { throw e; }
  }
  return inserted;
}

/**
 * Replace a given event on the calendar, overwriting any previous version.
 * Useful for creating exception instances.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {Object} event - The event to be updated
 * @param {number[]} [toleratedErrors=[]] - HTTP errors to tolerate
 * @return {boolean} True if the event was replaced
 */
function calReplaceEvent(calendarId, event, toleratedErrors = []) {
  let replaced = false;

  _paceCalendarWrite(calendarId);
  CAL_OPS.apiCalls['Events.update']++;
  try {
    Calendar.Events.update(event, calendarId, event.id);
    (CAL_OPS.events[calendarId] ||= { ...DEFAULT_OPS_ENTRY }).updated++;
    replaced = true;
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, ...toleratedErrors)) { throw e; }
  }
  return replaced;
}

/**
 * A callback accepting a calendar event object.
 *
 * @callback eventCallback
 * @param {Object} event - The calendar event passed as an argument
 */

/**
 * Stream the given calendar's events to the given callback, including cancelled events, one
 * at a time.  The search parameters are the same as for Calendar.Events.list, but this function
 * handles paging automatically.  Returns null on an unknown calendar.
 *
 * @param {string} calendarId - The calendar to search
 * @param {Object} params - Search parameters as for Calendar.Events.list
 * @param {eventCallback} [callback=null] - Optional function to call on each event
 * @return {string|null} - The syncToken to interrogate the calendar for changes
 */
function calStreamEvents(calendarId, params = {}, callback = null) {
  let response = null;

  const searchParams = { ...params, maxResults: (API_PAGE_SIZE ?? DEFAULT_API_PAGE_SIZE) };
  delete searchParams.pageToken;

  do {
    try {
      CAL_OPS.apiCalls['Events.list']++;
      response = Calendar.Events.list(calendarId, searchParams);
    } catch (e) {
      if (! isGoogleJsonResponseErr(e, 404)) { throw e; }
      // else bad calendarId
      console.warn(`Calendar not found: ${calendarId}`);
      return null;
    }

    if (callback && response.items) {
      response.items.forEach(event => callback(event));
    }

    searchParams.pageToken = response.nextPageToken;
  } while (searchParams.pageToken);

  return response?.nextSyncToken;
}

function calStreamCalendars(callback) {
  const searchParams = { showHidden: true,
                         maxResults: (API_PAGE_SIZE ?? DEFAULT_API_PAGE_SIZE) };
  do {
    CAL_OPS.apiCalls['CalendarList.list']++;
    const response = Calendar.CalendarList.list(searchParams);
    if (response.items) {
      response.items.forEach((c) => callback(c));
    }
    searchParams.pageToken = response.nextPageToken;
  } while (searchParams.pageToken);
}
