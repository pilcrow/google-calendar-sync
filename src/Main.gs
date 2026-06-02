// vim: set ft=javascript ts=2 sw=2 et:
// Main orchestration entry point for calendar synchronization

const LOCK_TIMEOUT_MS = 30000;

/**
 * Main entry point for calendar synchronization.
 * Orchestrates sync across all configured calendar mappings with concurrency control
 * and timeout management. Designed to be run on a time-driven trigger (every 15 minutes).
 */
function orchestrateCalendarSync() {
  const lock = LockService.getScriptLock();
  
  try {
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      Logger.log('Could not acquire lock - another instance is running');
      return;
    }
    
    Logger.log('Starting calendar sync orchestration');

    if (CALENDAR_CONFIG.length === 0) {
      Logger.log('No calendar mappings configured');
      return;
    }

    const resolvedCalendarConfig = resolveCalendarConfig(CALENDAR_CONFIG);
    
    for (let i = 0; i < resolvedCalendarConfig.length; i++) {
      if (!hasExecutionTimeRemainingMs()) {
        Logger.log('Execution timeout reached - stopping');
        break;
      }
      
      const config = resolvedCalendarConfig[i];
      
      try {
        syncCalendarPair(config);
      } catch (e) {
        Logger.log('Error syncing calendar pair: ' + e.message);
        Logger.log(e.stack);
      }
    }
    
    Logger.log('Calendar sync orchestration complete');
    
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
  
  Logger.log(
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
    Logger.log('Config changed - triggering reconciliation sync');
    executeReconciliationSync(sourceCalendarId, destCalendarId, config);
    return;
  }
  
  try {
    performIncrementalSync(sourceCalendarId, destCalendarId, config, syncToken);
  } catch (e) {
    if (isHttpError(e, 410, 'Gone')) {
      Logger.log('Sync token expired (410 Gone) - triggering reconciliation sync');
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

  const requestParams = {
    syncToken: syncToken,
    singleEvents: false,
    maxResults: MAX_RESULTS_PER_PAGE
  };
  let pageToken = null;
  let newSyncToken = null;
  
  do {
    if (!hasExecutionTimeRemainingMs()) {
      Logger.log('Execution timeout reached during sync - stopping');
      break;
    }
    
    if (pageToken) {
      requestParams.pageToken = pageToken;
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
    Logger.log('Saved new sync token');
  }
}
