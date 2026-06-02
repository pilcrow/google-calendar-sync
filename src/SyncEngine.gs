// vim: set ft=javascript ts=2 sw=2 et:
// Core synchronization engine for processing events and reconciliation

const LOOKBACK_DAYS = 7;
const MAX_RESULTS_PER_PAGE = 250;
const WRITE_PACING_DELAY_MS = 500;

function paceCalendarWrite() {
  if (WRITE_PACING_DELAY_MS <= 0) {
    return;
  }
  if (!hasExecutionTimeRemainingMs(WRITE_PACING_DELAY_MS)) {
    return;
  }
  Utilities.sleep(WRITE_PACING_DELAY_MS);
}

/**
 * Process a single event from the source calendar and sync to destination.
 * Handles cancellations, rule evaluation, recurring events, and upsert operations.
 * 
 * @param {Object} item - The source calendar event
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The configuration object with rules
 */
function processSyncItem(item, sourceCalendarId, destCalendarId, config) {
  if (item.extendedProperties?.private?.sourceCalendarId) {
    Logger.log('Loop Guard: Skipping event "' + item.summary + '" - is a sync replica');
    return;
  }
  
  const destEventId = getDestinationEventId(sourceCalendarId, item.id);
  
  if (item.status === 'cancelled') {
    try {
      Calendar.Events.remove(destCalendarId, destEventId);
      Logger.log('Removed cancelled event: ' + destEventId);
    } catch (e) {
      if (!isHttpError(e, 404, 'Not Found')) {
        throw e;
      }
    } finally {
      paceCalendarWrite();
    }
    return;
  }
  
  const ruleResult = evaluateRules(item.summary, config.rules);
  
  if (ruleResult.skip) {
    try {
      Calendar.Events.remove(destCalendarId, destEventId);
      Logger.log('Removed skipped event: ' + item.summary);
    } catch (e) {
      if (!isHttpError(e, 404, 'Not Found')) {
        throw e;
      }
    } finally {
      paceCalendarWrite();
    }
    return;
  }
  
  const destEvent = buildDestinationEvent(item, sourceCalendarId, ruleResult);
  
  try {
    Calendar.Events.get(destCalendarId, destEventId);
    Calendar.Events.update(destEvent, destCalendarId, destEventId);
    Logger.log('Updated event: ' + destEvent.summary);
    paceCalendarWrite();
  } catch (e) {
    if (isHttpError(e, 404, 'Not Found')) {
      Calendar.Events.insert(buildInsertDestinationEvent(destEvent, destEventId), destCalendarId);
      Logger.log('Inserted event: ' + destEvent.summary);
      paceCalendarWrite();
    } else {
      throw e;
    }
  }
}

/**
 * Build a write-safe destination event payload from source event and rule results.
 * Only allowlisted fields are included in outbound insert/update requests.
 * 
 * @param {Object} sourceEvent - The source calendar event
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {Object} ruleResult - The result from evaluateRules (prefix, colorId, skip)
 * @return {Object} The destination event payload
 */
function buildDestinationEvent(sourceEvent, sourceCalendarId, ruleResult) {
  const destEvent = {
    summary: (ruleResult.prefix || '') + (sourceEvent.summary || ''),
    extendedProperties: {
      private: {
        sourceCalendarId: sourceCalendarId,
        sourceEventId: sourceEvent.id
      }
    }
  };

  addWritableEventField(destEvent, 'description', sourceEvent.description);
  addWritableEventField(destEvent, 'location', sourceEvent.location);
  addWritableEventField(destEvent, 'start', buildWritableEventTime(sourceEvent.start));
  addWritableEventField(destEvent, 'end', buildWritableEventTime(sourceEvent.end));
  addWritableEventField(destEvent, 'transparency', sourceEvent.transparency);
  addWritableEventField(destEvent, 'visibility', sourceEvent.visibility);
  addWritableEventField(destEvent, 'colorId', ruleResult.colorId);

  if (sourceEvent.recurrence) {
    destEvent.recurrence = sourceEvent.recurrence.slice();
  }

  return destEvent;
}

function addWritableEventField(destEvent, fieldName, value) {
  if (value !== undefined && value !== null) {
    destEvent[fieldName] = value;
  }
}

function buildWritableEventTime(eventTime) {
  if (!eventTime) {
    return null;
  }

  const writableEventTime = {};
  addWritableEventField(writableEventTime, 'date', eventTime.date);
  addWritableEventField(writableEventTime, 'dateTime', eventTime.dateTime);
  addWritableEventField(writableEventTime, 'timeZone', eventTime.timeZone);

  return Object.keys(writableEventTime).length > 0 ? writableEventTime : null;
}

function buildInsertDestinationEvent(destEvent, destEventId) {
  return Object.assign({ id: destEventId }, destEvent);
}

/**
 * @return {string} ISO timestamp for the tokenless sync window start.
 */
function getSyncWindowTimeMin() {
  const lookbackTime = new Date();
  lookbackTime.setDate(lookbackTime.getDate() - LOOKBACK_DAYS);
  return lookbackTime.toISOString();
}

/**
 * Sync the full tokenless source window and persist a fresh sync token.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The configuration object with rules
 * @param {string=} timeMin - Optional ISO timestamp overriding the default sync window start
 */
function syncSourceWindow(sourceCalendarId, destCalendarId, config, timeMin) {
  const requestParams = {
    timeMin: timeMin || getSyncWindowTimeMin(),
    singleEvents: false,
    maxResults: MAX_RESULTS_PER_PAGE
  };
  let pageToken = null;
  let newSyncToken = null;

  do {
    if (!hasExecutionTimeRemainingMs()) {
      Logger.log('Execution timeout reached during sync - stopping');
      return;
    }

    if (pageToken) {
      requestParams.pageToken = pageToken;
    } else {
      delete requestParams.pageToken;
    }

    const response = Calendar.Events.list(sourceCalendarId, requestParams);

    if (response.items) {
      for (let i = 0; i < response.items.length; i++) {
        const item = response.items[i];
        processSyncItem(item, sourceCalendarId, destCalendarId, config);
      }
    }

    pageToken = response.nextPageToken;

    if (response.nextSyncToken) {
      newSyncToken = response.nextSyncToken;
    }
  } while (pageToken);

  if (newSyncToken) {
    setSyncToken(sourceCalendarId, newSyncToken);
    setConfigHash(generateMd5Hash(JSON.stringify(CALENDAR_CONFIG)));
    Logger.log('Saved new sync token');
  }
}

/**
 * Execute reconciliation sync when sync token expires or config changes.
 * Builds AllowedSet of events that pass current rules and removes orphaned events.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The configuration object with rules
 */
function executeReconciliationSync(sourceCalendarId, destCalendarId, config) {
  Logger.log('Starting reconciliation sync for ' + sourceCalendarId);
  
  const allowedSet = new Set();
  const timeMin = getSyncWindowTimeMin();
  
  let pageToken = null;
  do {
    if (!hasExecutionTimeRemainingMs()) {
      Logger.log('Execution timeout reached during reconciliation - stopping');
      return;
    }

    const response = Calendar.Events.list(sourceCalendarId, {
      timeMin: timeMin,
      singleEvents: false,
      maxResults: MAX_RESULTS_PER_PAGE,
      pageToken: pageToken
    });
    
    if (response.items) {
      for (let i = 0; i < response.items.length; i++) {
        const item = response.items[i];
        
        if (item.extendedProperties?.private?.sourceCalendarId) {
          continue;
        }
        
        if (item.status === 'cancelled') {
          continue;
        }
        
        const ruleResult = evaluateRules(item.summary, config.rules);
        if (!ruleResult.skip) {
          const destEventId = getDestinationEventId(sourceCalendarId, item.id);
          allowedSet.add(destEventId);
        }
      }
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);
  
  Logger.log('AllowedSet size: ' + allowedSet.size);
  
  pageToken = null;
  do {
    if (!hasExecutionTimeRemainingMs()) {
      Logger.log('Execution timeout reached during reconciliation - stopping');
      return;
    }

    const response = Calendar.Events.list(destCalendarId, {
      privateExtendedProperty: 'sourceCalendarId=' + sourceCalendarId,
      maxResults: MAX_RESULTS_PER_PAGE,
      pageToken: pageToken
    });
    
    if (response.items) {
      for (let i = 0; i < response.items.length; i++) {
        const destEvent = response.items[i];
        
        if (!allowedSet.has(destEvent.id)) {
          try {
            Calendar.Events.remove(destCalendarId, destEvent.id);
            Logger.log('Removed orphaned event: ' + destEvent.id);
          } catch (e) {
            Logger.log('Failed to remove orphaned event: ' + e.message);
          } finally {
            paceCalendarWrite();
          }
        }
      }
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);
  syncSourceWindow(sourceCalendarId, destCalendarId, config, timeMin);
  
  Logger.log('Reconciliation sync complete');
}
