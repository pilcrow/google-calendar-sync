// vim: set ft=javascript ts=2 sw=2 et:

// Functions for wrapping the Google Calendar API:
//   - pace write operations per calendar to avoid burst limits
//   - handle pageToken pagination
//
// All functions are calFooBar(...) and take a calendar ID as the
// first parameter.

const DEFAULT_CAL_OPS_ENTRY = { added: 0, removed: 0, updated: 0 };
const CAL_OPS = {};

const calGetIdByName = (function() {
  let Names2Ids = null;

  return function(calName) {
    if (! Names2Ids) {
      Names2Ids = new Map();
      for (const cal of Calendar.CalendarList.list({showHidden: true}).items) {
        
      }
    }
    return Names2Ids.get(calName);
  }
})();

/**
 * Sleep if needed to ensure a 500ms pause since the last write operation we
 * performed on the given calendar.  Intended to be called immediately before a
 * write operation.
 *
 * @param {string} calendarId - The calendar which we're about to modify
 */
const _paceCalendarWrite = (function() {
  let LAST_WRITE_OP = {};

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
 * Fetch a single event by ID, or return null if the API reports it absent (404).
 *
 * Deliberately status-agnostic: a soft-deleted (cancelled) event still resolves
 * — GET returns 200 with `status: 'cancelled'` — so a non-null result is not
 * proof the event is active.  Callers needing "active" semantics must check
 * `status` themselves.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {string} eventId - The event to fetch
 * @return {Object|null} The event resource regardless of status, or null on 404
 */
function calGetEvent(calendarId, eventId) {
  try {
    return Calendar.Events.get(calendarId, eventId);
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, 404)) { throw e; }
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
  CAL_OPS[calendarId] ||= { ...DEFAULT_CAL_OPS_ENTRY };

  let removed = false;

  try {
    _paceCalendarWrite(calendarId);
    Calendar.Events.remove(calendarId, eventId);
    CAL_OPS[calendarId].removed++;
    removed = true;
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, ...toleratedErrors)) { throw e; }
  }

  return removed;
}

/**
 * Put the given event on the calendar, overwriting any previous version.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {Object} event - The event to be upserted
 */
function calUpsertEvent(calendarId, event) {
  // N.B.: we count `status := cancelled` as an update or add, not a removal
  CAL_OPS[calendarId] ||= { ...DEFAULT_CAL_OPS_ENTRY };

  try {
    const existing = Calendar.Events.get(calendarId, event.id)
    _paceCalendarWrite(calendarId);
    Calendar.Events.update(event, calendarId, event.id, {}, { 'If-Match': existing.etag });
    CAL_OPS[calendarId].updated++;
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, 404)) { throw e; }

    _paceCalendarWrite(calendarId);
    Calendar.Events.insert(event, calendarId); // FIXME - skip exception events
    CAL_OPS[calendarId].added++;
  }
}

/**
 * Replace a given event on the calendar, overwriting any previous version.
 * Useful for creating exception instances.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {Object} event - The event to be updated
 */
function calReplaceEvent(calendarId, event) {
  CAL_OPS[calendarId] ||= { ...DEFAULT_CAL_OPS_ENTRY };

  Calendar.Events.update(event, calendarId, event.id);
  CAL_OPS[calendarId].updated++;
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
 * handles paging automatically.
 *
 * @param {string} calendarId - The calendar to search
 * @param {Object} params - Search parameters as for Calendar.Events.list
 * @param {eventCallback} [callback=null] - Optional function to call on each event
 * @return {string|null} - The syncToken to interrogate the calendar for changes
 */
function calStreamEvents(calendarId, params = {}, callback = null) {
  let response = null;

  const searchParams = { ...params };
  delete searchParams.pageToken;

  do {
    try {
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
