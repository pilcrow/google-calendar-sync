// vim: set ft=javascript ts=2 sw=2 et:
// Core synchronization engine for processing events and reconciliation

const LOOKBACK_DAYS = 7;
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
function processSyncItem(item, sourceCalendarId, destCalendarId, config, metrics) {
  if (item.extendedProperties?.private?.sourceCalendarId) {
    console.warn('Loop Guard: Skipping event "' + item.summary + '" - is a sync replica');
    return;
  }

  if (item.recurringEventId) {
    processExceptionSyncItem(item, sourceCalendarId, destCalendarId, config, metrics);
    return;
  }

  const destEventId = getDestinationEventId(sourceCalendarId, item.id);
  
  if (item.status === 'cancelled') {
    try {
      if (removeEventIfExists(destCalendarId, destEventId)) {
        console.log('Removed cancelled event: ' + destEventId);
        if (metrics) metrics.deleted++;
      }
    } finally {
      paceCalendarWrite();
    }
    return;
  }
  
  const ruleResult = evaluateRules(item.summary, config.rules);
  
  if (ruleResult.skip) {
    try {
      if (removeEventIfExists(destCalendarId, destEventId)) {
        console.log('Removed skipped event: ' + item.summary);
        if (metrics) metrics.deleted++;
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
    console.log('Updated event: ' + destEvent.summary);
    if (metrics) metrics.updated++;
    paceCalendarWrite();
  } catch (e) {
    if (isHttpError(e, 404, 'Not Found')) {
      Calendar.Events.insert(buildInsertDestinationEvent(destEvent, destEventId), destCalendarId);
      console.log('Inserted event: ' + destEvent.summary);
      if (metrics) metrics.added++;
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

/**
 * Process a recurring event exception from the source calendar.
 * Exception instances have server-assigned IDs (masterId_timestamp) and cannot
 * be created via insert; instead the corresponding destination instance is updated
 * in place using an ID derived from the source exception ID.
 *
 * @param {Object} item - The source exception event (has recurringEventId set)
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The configuration object with rules
 */
function processExceptionSyncItem(item, sourceCalendarId, destCalendarId, config, metrics) {
  const destMasterId = getDestinationEventId(sourceCalendarId, item.recurringEventId);
  const destInstanceId = getDestinationInstanceId(sourceCalendarId, item);

  if (item.status === 'cancelled') {
    try {
      if (removeEventIfExists(destCalendarId, destInstanceId)) {
        console.log('Removed cancelled exception instance: ' + destInstanceId);
        if (metrics) metrics.deleted++;
      }
    } finally {
      paceCalendarWrite();
    }
    return;
  }

  const ruleResult = evaluateRules(item.summary, config.rules);
  if (ruleResult.skip) {
    try {
      if (removeEventIfExists(destCalendarId, destInstanceId)) {
        console.log('Removed skipped exception instance: ' + destInstanceId);
        if (metrics) metrics.deleted++;
      }
    } finally {
      paceCalendarWrite();
    }
    return;
  }

  try {
    Calendar.Events.get(destCalendarId, destMasterId);
  } catch (e) {
    if (!isHttpError(e, 404, 'Not Found')) {
      throw e;
    }
    let sourceMaster;
    try {
      sourceMaster = Calendar.Events.get(sourceCalendarId, item.recurringEventId);
    } catch (fetchErr) {
      console.warn('Exception sync skipped: source master ' + item.recurringEventId + ' not found: ' + fetchErr.message);
      return;
    }
    const masterRuleResult = evaluateRules(sourceMaster.summary, config.rules);
    if (masterRuleResult.skip) {
      console.log('Exception sync skipped: master "' + sourceMaster.summary + '" is filtered by rules');
      return;
    }
    processSyncItem(sourceMaster, sourceCalendarId, destCalendarId, config, metrics);
  }

  const destEvent = buildDestinationEvent(item, sourceCalendarId, ruleResult);
  Calendar.Events.update(destEvent, destCalendarId, destInstanceId);
  console.log('Updated exception instance: ' + item.summary);
  if (metrics) metrics.updated++;
  paceCalendarWrite();
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
 * @return {Object} Metrics object with added, updated, deleted, and timedOut fields
 */
function syncSourceWindow(sourceCalendarId, destCalendarId, config, timeMin) {
  const startMs = Date.now();
  const metrics = { added: 0, updated: 0, deleted: 0 };
  const requestParams = {
    timeMin: timeMin || getSyncWindowTimeMin(),
    singleEvents: false,
    maxResults: (typeof API_PAGE_SIZE !== 'undefined') ? API_PAGE_SIZE : DEFAULT_API_PAGE_SIZE
  };
  let pageToken = null;
  let newSyncToken = null;
  let timedOutMidPage = false;
  let timedOut = false;

  do {
    if (!hasExecutionTimeRemainingMs()) {
      console.warn('Execution timeout reached during sync - stopping');
      timedOut = true;
      break;
    }

    if (pageToken) {
      requestParams.pageToken = pageToken;
    } else {
      delete requestParams.pageToken;
    }

    const response = Calendar.Events.list(sourceCalendarId, requestParams);

    if (response.items) {
      const masters = [];
      const exceptions = [];
      for (const item of response.items) {
        if (item.recurringEventId) {
          exceptions.push(item);
        } else {
          masters.push(item);
        }
      }
      for (const item of masters) {
        if (!hasExecutionTimeRemainingMs(1000)) {
          console.warn('Execution timeout reached during item processing - stopping');
          timedOutMidPage = true;
          break;
        }
        processSyncItem(item, sourceCalendarId, destCalendarId, config, metrics);
      }

      if (timedOutMidPage) {
        break;
      }

      for (const item of exceptions) {
        if (!hasExecutionTimeRemainingMs(1000)) {
          console.warn('Execution timeout reached during item processing - stopping');
          timedOutMidPage = true;
          break;
        }
        processSyncItem(item, sourceCalendarId, destCalendarId, config, metrics);
      }
    }

    if (timedOutMidPage) {
      break;
    }

    pageToken = response.nextPageToken;

    if (response.nextSyncToken) {
      newSyncToken = response.nextSyncToken;
    }
  } while (pageToken);

  if (!timedOut && !timedOutMidPage && newSyncToken) {
    setSyncToken(sourceCalendarId, newSyncToken);
    setCalendarPairConfigHash(sourceCalendarId, destCalendarId, config.rules);
    console.info('Sync complete ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's; ' + metrics.added + ' added, ' + metrics.updated + ' updated, ' + metrics.deleted + ' deleted');
  }

  return {
    added: metrics.added,
    updated: metrics.updated,
    deleted: metrics.deleted,
    timedOut: timedOut || timedOutMidPage
  };
}

/**
 * Remove destination events that belong to a source/destination mapping that
 * no longer exists in CALENDAR_CONFIG.
 *
 * @param {string} sourceCalendarId - The removed source calendar identifier
 * @param {string} destCalendarId - The removed destination calendar identifier
 * @return {Object} Metrics object with deleted and timedOut fields
 */
function cleanupRemovedCalendarPair(sourceCalendarId, destCalendarId) {
  console.info('Cleaning removed calendar mapping: ' + sourceCalendarId + ' -> ' + destCalendarId);

  const metrics = { deleted: 0, timedOut: false };
  let pageToken = null;

  do {
    if (!hasExecutionTimeRemainingMs()) {
      console.warn('Execution timeout reached during removed mapping cleanup - stopping');
      metrics.timedOut = true;
      break;
    }

    let response;
    try {
      response = Calendar.Events.list(destCalendarId, {
        privateExtendedProperty: 'sourceCalendarId=' + sourceCalendarId,
        maxResults: (typeof API_PAGE_SIZE !== 'undefined') ? API_PAGE_SIZE : DEFAULT_API_PAGE_SIZE,
        pageToken: pageToken
      });
    } catch (e) {
      if (isHttpError(e, 404, 'Not Found')) {
        console.warn(
          'Skipping removed mapping cleanup because destination calendar is unavailable: ' +
          destCalendarId +
          '; ' +
          e.message
        );
        return metrics;
      }
      throw e;
    }

    if (response.items) {
      for (const destEvent of response.items) {
        if (!hasExecutionTimeRemainingMs(1000)) {
          console.warn('Execution timeout reached during removed mapping item cleanup - stopping');
          metrics.timedOut = true;
          break;
        }

        try {
          if (removeEventIfExists(destCalendarId, destEvent.id)) {
            console.log(
              'Removed destination event during removed mapping cleanup eventId=' +
              destEvent.id +
              ' sourceCalendarId=' +
              sourceCalendarId +
              ' destCalendarId=' +
              destCalendarId
            );
            metrics.deleted++;
          }
        } finally {
          paceCalendarWrite();
        }
      }
    }

    if (metrics.timedOut) {
      break;
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  return metrics;
}

/**
 * Execute reconciliation sync when sync token expires or config changes.
 * Builds AllowedSet of events that pass current rules and removes orphaned events.
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The configuration object with rules
 * @return {Object} Metrics object with added, updated, deleted, and timedOut fields
 */
function executeReconciliationSync(sourceCalendarId, destCalendarId, config) {
  console.info('Starting reconciliation sync for ' + sourceCalendarId);
  
  const metrics = { added: 0, updated: 0, deleted: 0 };
  const allowedSet = new Set();
  const timeMin = getSyncWindowTimeMin();
  
  let pageToken = null;
  do {
    if (!hasExecutionTimeRemainingMs()) {
      console.warn('Execution timeout reached during reconciliation - stopping');
      return {
        added: metrics.added,
        updated: metrics.updated,
        deleted: metrics.deleted,
        timedOut: true
      };
    }

    const response = Calendar.Events.list(sourceCalendarId, {
      timeMin: timeMin,
      singleEvents: false,
      maxResults: (typeof API_PAGE_SIZE !== 'undefined') ? API_PAGE_SIZE : DEFAULT_API_PAGE_SIZE,
      pageToken: pageToken
    });
    
    if (response.items) {
      for (const item of response.items) {
        if (!hasExecutionTimeRemainingMs(1000)) {
          console.warn('Execution timeout reached during reconciliation source processing - stopping');
          return {
            added: metrics.added,
            updated: metrics.updated,
            deleted: metrics.deleted,
            timedOut: true
          };
        }
        
        if (item.extendedProperties?.private?.sourceCalendarId) {
          console.warn('Loop Guard: Skipping event "' + item.summary + '" in reconciliation - is a sync replica');
          continue;
        }
        
        if (item.status === 'cancelled') {
          continue;
        }
        
        const ruleResult = evaluateRules(item.summary, config.rules);
        if (!ruleResult.skip) {
          if (item.recurringEventId) {
            allowedSet.add(getDestinationInstanceId(sourceCalendarId, item));
          } else {
            allowedSet.add(getDestinationEventId(sourceCalendarId, item.id));
          }
        }
      }
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);
  
  console.log('AllowedSet size: ' + allowedSet.size);
  
  pageToken = null;
  do {
    if (!hasExecutionTimeRemainingMs()) {
      console.warn('Execution timeout reached during reconciliation - stopping');
      return {
        added: metrics.added,
        updated: metrics.updated,
        deleted: metrics.deleted,
        timedOut: true
      };
    }

    const response = Calendar.Events.list(destCalendarId, {
      privateExtendedProperty: 'sourceCalendarId=' + sourceCalendarId,
      maxResults: (typeof API_PAGE_SIZE !== 'undefined') ? API_PAGE_SIZE : DEFAULT_API_PAGE_SIZE,
      pageToken: pageToken
    });
    
    if (response.items) {
      for (const destEvent of response.items) {
        if (!hasExecutionTimeRemainingMs(1000)) {
          console.warn('Execution timeout reached during reconciliation destination processing - stopping');
          return {
            added: metrics.added,
            updated: metrics.updated,
            deleted: metrics.deleted,
            timedOut: true
          };
        }
        
        if (!allowedSet.has(destEvent.id)) {
          try {
            if (removeEventIfExists(destCalendarId, destEvent.id)) {
              console.log('Removed orphaned event: ' + destEvent.id);
              metrics.deleted++;
            }
          } catch (e) {
            console.error('Failed to remove orphaned event: ' + e.message);
          } finally {
            paceCalendarWrite();
          }
        }
      }
    }
    
    pageToken = response.nextPageToken;
  } while (pageToken);
  const syncWindowMetrics = syncSourceWindow(sourceCalendarId, destCalendarId, config, timeMin);
  if (syncWindowMetrics) {
    metrics.added += syncWindowMetrics.added || 0;
    metrics.updated += syncWindowMetrics.updated || 0;
    metrics.deleted += syncWindowMetrics.deleted || 0;
  }
  
  console.info('Reconciliation sync complete');
  return {
    added: metrics.added,
    updated: metrics.updated,
    deleted: metrics.deleted,
    timedOut: !!(syncWindowMetrics && syncWindowMetrics.timedOut)
  };
}
