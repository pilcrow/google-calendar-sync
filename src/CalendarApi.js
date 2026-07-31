// vim: set ft=javascript ts=2 sw=2 et:

// Functions for wrapping the Google Calendar API:
//   - pace write operations per calendar to avoid burst limits
//   - handle pageToken pagination
//
// All functions are calFooBar(...) and take a calendar ID as the
// first parameter.

const DEFAULT_CAL_OPS_ENTRY = { added: 0, removed: 0, updated: 0 };
const CAL_OPS = {};

/**
 * Sleep if needed to ensure a 500ms pause since the last write operation we
 * performed on the given calendar.  Intended to be called immediately before a
 * write operation.
 *
 * @param {string} calendarId - The calendar which we're about to modify
 */
function _paceCalendarWrite = (function() {
  let LAST_WRITE_OP = {};

  return function(calendarId) {
    const now = Date.now;
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
 * Remove the given eventId from the specified calendar, ignoring already absent events.
 *
 * @param {string} calendarId - The calendar possibly containing the event
 * @param {string} eventId - The event to be removed
 * @return {boolean} True if the event existed and was removed.
 */
function calRemoveEvent(calendarId, eventId) {
  CAL_OPS[calendarId] ||= { ...DEFAULT_CAL_OPS_ENTRY };

  try {
    _paceCalendarWrite(calendarId);
    Calendar.Events.delete(calendarId, eventId);
    CAL_OPS[calendarId].removed++;
    return true;
  } catch (e) {
    if (isHttpError(e, 404, 'Not Found') || isHttpError(e, 410, 'Resource has been deleted')) {
      return false;
    }
    throw e;
  }
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
    existing = Calendar.Events.get(calendarId, event.id)
    _paceCalendarWrite(calendarId);
    Calendar.Events.update({ ...event, ...{ etag: existing.etag } }, calendarId, event.id)
    CAL_OPS[calendarId].updated++;
  } catch (e) {
    if (! isHttpError(404, 'Not Found')) {
      throw e;
    }
    _paceCalendarWrite(calendarId);
    Calendar.Events.insert(event, calendarId);
    CAL_OPS[calendarId].added++;
  }
}

/**
 * A callback accepting a calendar event object.
 *
 * @callback eventCallback
 * @param {Object} event
 */

/**
 * Stream the given calendar's events to the given callback, including cancelled events, one
 * at a time.  The search parameters are the same as for Calendar.Events.list, but this
 * function handles paging automatically.
 *
 * @param {string} calendarId - The calendar to search
 * @param {Object} calendarId - Search parameters as for Calendar.Events.List
 * @param callback - The function to call
 * @return {string} - The syncToken to interrogate the calendar for changes
 */
function calStreamEvents(calendarId, params = {}, callback = null) {
  const params = { ...options, ...{ showDeleted: true, maxResults: FIXME, pageToken: pageToken } };
  let pageToken = null;
  let response = null;

  do {
    if (!haveExecutionTimeRemainingMs()) {
      console.warn('Execution timeout reached during calendar list');
      return;
    }

    try {
      response = Calendar.Events.list(calendarId, options)
    } catch (e) {
      if (isHttpError(e, 404, 'Not Found')) {
        console.warn('Calendar not found');
        return null;
      }
      throw e;
    }

    response.items.forEach(event => callback(event));

    pageToken = response.nextPageToken;
  } while (pageToken)

  return response?.nextSyncToken;
}
