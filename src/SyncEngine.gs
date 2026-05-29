// vim: set ft=javascript ts=2 sw=2 et:
// Core synchronization engine for processing events and reconciliation

const LOOKBACK_DAYS = 7;
const MAX_RESULTS_PER_PAGE = 250;

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
      if (e.message.indexOf('404') === -1) {
        throw e;
      }
    }
    return;
  }
  
  const ruleResult = evaluateRules(item.summary, config.rules);
  
  if (ruleResult.skip) {
    try {
      Calendar.Events.remove(destCalendarId, destEventId);
      Logger.log('Removed skipped event: ' + item.summary);
    } catch (e) {
      if (e.message.indexOf('404') === -1) {
        throw e;
      }
    }
    return;
  }
  
  const destEvent = buildDestinationEvent(item, sourceCalendarId, ruleResult);
  
  try {
    Calendar.Events.get(destCalendarId, destEventId);
    Calendar.Events.update(destEvent, destCalendarId, destEventId);
    Logger.log('Updated event: ' + destEvent.summary);
  } catch (e) {
    if (e.message.indexOf('404') !== -1) {
      destEvent.id = destEventId;
      Calendar.Events.insert(destEvent, destCalendarId);
      Logger.log('Inserted event: ' + destEvent.summary);
    } else {
      throw e;
    }
  }
}

/**
 * Build a destination event payload from source event and rule results.
 * Handles recurring events (master and exception) properly.
 * 
 * @param {Object} sourceEvent - The source calendar event
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {Object} ruleResult - The result from evaluateRules (prefix, colorId, skip)
 * @return {Object} The destination event payload
 */
function buildDestinationEvent(sourceEvent, sourceCalendarId, ruleResult) {
  const destEvent = {
    summary: (ruleResult.prefix || '') + (sourceEvent.summary || ''),
    description: sourceEvent.description,
    location: sourceEvent.location,
    start: sourceEvent.start,
    end: sourceEvent.end,
    transparency: sourceEvent.transparency,
    visibility: sourceEvent.visibility,
    extendedProperties: {
      private: {
        sourceCalendarId: sourceCalendarId,
        sourceEventId: sourceEvent.id
      }
    }
  };
  
  if (ruleResult.colorId) {
    destEvent.colorId = ruleResult.colorId;
  }
  
  if (sourceEvent.recurrence) {
    destEvent.recurrence = sourceEvent.recurrence;
  }
  
  if (sourceEvent.recurringEventId) {
    destEvent.recurringEventId = getDestinationEventId(
      sourceCalendarId,
      sourceEvent.recurringEventId
    );
    destEvent.originalStartTime = sourceEvent.originalStartTime;
  }
  
  return destEvent;
}

/**
 * Execute reconciliation sync when sync token expires or config changes.
 * Builds AllowedSet of events that pass current rules and removes orphaned events.
 * 
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The configuration object with rules
 * @param {number} startTime - The orchestration start timestamp for timeout checks
 */
function executeReconciliationSync(sourceCalendarId, destCalendarId, config, startTime) {
  Logger.log('Starting reconciliation sync for ' + sourceCalendarId);
  
  const allowedSet = new Set();
  const lookbackTime = new Date();
  lookbackTime.setDate(lookbackTime.getDate() - LOOKBACK_DAYS);
  
  let pageToken = null;
  do {
    if (new Date().getTime() - startTime > EXECUTION_TIMEOUT_MS) {
      Logger.log('Execution timeout reached during reconciliation - stopping');
      return;
    }

    const response = Calendar.Events.list(sourceCalendarId, {
      timeMin: lookbackTime.toISOString(),
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
    if (new Date().getTime() - startTime > EXECUTION_TIMEOUT_MS) {
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
          }
        }
      }
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);
  
  pageToken = null;
  let newSyncToken = null;
  do {
    if (new Date().getTime() - startTime > EXECUTION_TIMEOUT_MS) {
      Logger.log('Execution timeout reached during reconciliation - stopping');
      return;
    }

    const response = Calendar.Events.list(sourceCalendarId, {
      timeMin: lookbackTime.toISOString(),
      singleEvents: false,
      maxResults: MAX_RESULTS_PER_PAGE,
      pageToken: pageToken
    });
    
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
    Logger.log('Saved new sync token after reconciliation');
  }
  
  Logger.log('Reconciliation sync complete');
}
