// vim: set ft=javascript ts=2 sw=2 et:
// Main orchestration entry point for calendar synchronization

const LOCK_TIMEOUT_MS = 30000;
const DEFAULT_API_PAGE_SIZE = 250;

/**
 * Main entry point for calendar synchronization.
 * Orchestrates sync across all configured calendar mappings with concurrency control
 * and timeout management. Designed to be run on a time-driven trigger (every 15 minutes).
 */
function orchestrateCalendarSync() {
  console.info('Starting calendar sync orchestration');
  const orchestrationStartMs = Date.now();

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    console.warn('Could not acquire lock - another instance is running');
    return;
  }

  try {
    if (CALENDAR_CONFIG.length === 0) {
      console.warn('No calendar mappings configured');
      return;
    }

    const resolvedCalendarConfig = resolveCalendarConfig(CALENDAR_CONFIG);
    
    for (const config of resolvedCalendarConfig) {
      if (!hasExecutionTimeRemainingMs()) {
        console.warn('Execution timeout reached - stopping');
        break;
      }

      try {
        syncCalendarPair(config);
      } catch (e) {
        console.error('Error syncing calendar pair: ' + e.message);
        console.error(e.stack);
      }
    }
    
    console.info('Calendar sync orchestration complete ' + ((Date.now() - orchestrationStartMs) / 1000).toFixed(1) + 's');
    
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sync a single source-destination calendar pair.
 * Handles incremental sync with tokens or falls back to reconciliation on errors.
 * 
 * @param {Object} config - The calendar configuration object
 */
function syncCalendarPair(config) {
  const sourceCalendarId = config.sourceCalendarId;
  const destCalendarId = config.destinationCalendarId;
  
  console.info(
    'Syncing: ' +
    config.source +
    ' (' +
    sourceCalendarId +
    ') -> ' +
    config.destination +
    ' (' +
    destCalendarId +
    ')'
  );
  
  const configChanged = checkCalendarPairConfigChange(config);
  const syncToken = getSyncToken(sourceCalendarId);
  
  if (configChanged && syncToken) {
    console.info('Config changed - triggering reconciliation sync');
    executeReconciliationSync(sourceCalendarId, destCalendarId, config);
    return;
  }
  
  try {
    performIncrementalSync(sourceCalendarId, destCalendarId, config, syncToken);
  } catch (e) {
    if (isHttpError(e, 410, 'Gone')) {
      console.warn('Sync token expired (410 Gone) - triggering reconciliation sync');
      executeReconciliationSync(sourceCalendarId, destCalendarId, config);
    } else {
      throw e;
    }
  }
}

/**
 * Perform incremental sync using syncToken or a shared tokenless source-window sync.
 * 
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} destCalendarId - The destination calendar identifier
 * @param {Object} config - The calendar configuration object
 * @param {string|null} syncToken - The sync token, or null for tokenless source-window sync
 */
function performIncrementalSync(sourceCalendarId, destCalendarId, config, syncToken) {
  if (!syncToken) {
    syncSourceWindow(sourceCalendarId, destCalendarId, config);
    return;
  }

  const startMs = Date.now();
  const metrics = { added: 0, updated: 0, deleted: 0 };
  const requestParams = {
    syncToken: syncToken,
    singleEvents: false,
    maxResults: (typeof API_PAGE_SIZE !== 'undefined') ? API_PAGE_SIZE : DEFAULT_API_PAGE_SIZE
  };
  let pageToken = null;
  let newSyncToken = null;
  
  do {
    if (!hasExecutionTimeRemainingMs()) {
      console.warn('Execution timeout reached during sync - stopping');
      break;
    }
    
    if (pageToken) {
      requestParams.pageToken = pageToken;
    }
    
    const response = Calendar.Events.list(sourceCalendarId, requestParams);
    
    if (response.items) {
      for (const item of response.items) {
        processSyncItem(item, sourceCalendarId, destCalendarId, config, metrics);
      }
    }
    
    pageToken = response.nextPageToken;
    
    if (response.nextSyncToken) {
      newSyncToken = response.nextSyncToken;
    }
    
  } while (pageToken);
  
  if (newSyncToken) {
    setSyncToken(sourceCalendarId, newSyncToken);
    console.info('Sync complete ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's; ' + metrics.added + ' added, ' + metrics.updated + ' updated, ' + metrics.deleted + ' deleted');
  }
}
