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
  const totalMetrics = { added: 0, updated: 0, deleted: 0 };
  let hadSyncErrors = false;
  let reachedExecutionTimeout = false;

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
    validateUniqueSourceCalendarMappings(resolvedCalendarConfig);
    const sourceCalendarCount = new Set(
      resolvedCalendarConfig.map(function(config) {
        return config.sourceCalendarId;
      })
    ).size;
    const destinationCalendarCount = new Set(
      resolvedCalendarConfig.map(function(config) {
        return config.destinationCalendarId;
      })
    ).size;
    
    for (const config of resolvedCalendarConfig) {
      if (!hasExecutionTimeRemainingMs()) {
        console.warn('Execution timeout reached - stopping; sync run will be marked unsuccessful');
        reachedExecutionTimeout = true;
        break;
      }

      try {
        const pairMetrics = syncCalendarPair(config);
        if (pairMetrics) {
          totalMetrics.added += pairMetrics.added || 0;
          totalMetrics.updated += pairMetrics.updated || 0;
          totalMetrics.deleted += pairMetrics.deleted || 0;
          if (pairMetrics.timedOut) {
            reachedExecutionTimeout = true;
            console.warn('Execution timeout reached during calendar pair sync - stopping; sync run will be marked unsuccessful');
            break;
          }
        }
      } catch (e) {
        hadSyncErrors = true;
        console.error('Error syncing calendar pair; sync run will be marked unsuccessful: ' + e.message);
        console.error(e.stack);
      }
    }

    const elapsedSeconds = ((Date.now() - orchestrationStartMs) / 1000).toFixed(1);
    if (!hadSyncErrors && !reachedExecutionTimeout) {
      console.info(
        'Sync complete ' +
        elapsedSeconds +
        's; ' +
        sourceCalendarCount +
        ' source calendars, ' +
        destinationCalendarCount +
        ' destination calendars, ' +
        totalMetrics.added +
        ' added, ' +
        totalMetrics.updated +
        ' updated, ' +
        totalMetrics.deleted +
        ' deleted'
      );
    } else {
      const failureReasons = [];
      if (hadSyncErrors) {
        failureReasons.push('exceptions encountered');
      }
      if (reachedExecutionTimeout) {
        failureReasons.push('execution timeout reached');
      }
      console.error(
        'Sync run not successful ' +
        elapsedSeconds +
        's; ' +
        failureReasons.join(', ') +
        '; partial totals: ' +
        totalMetrics.added +
        ' added, ' +
        totalMetrics.updated +
        ' updated, ' +
        totalMetrics.deleted +
        ' deleted'
      );
    }
    
  } finally {
    lock.releaseLock();
  }
}

/**
 * Sync a single source-destination calendar pair.
 * Handles incremental sync with tokens or falls back to reconciliation on errors.
 * 
 * @param {Object} config - The calendar configuration object
 * @return {Object} Metrics object with added, updated, deleted, and timedOut fields
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
    return executeReconciliationSync(sourceCalendarId, destCalendarId, config);
  }
  
  try {
    return performIncrementalSync(sourceCalendarId, destCalendarId, config, syncToken);
  } catch (e) {
    if (isHttpError(e, 410, 'Gone')) {
      console.warn('Sync token expired (410 Gone) - triggering reconciliation sync');
      return executeReconciliationSync(sourceCalendarId, destCalendarId, config);
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
 * @return {Object} Metrics object with added, updated, deleted, and timedOut fields
 */
function performIncrementalSync(sourceCalendarId, destCalendarId, config, syncToken) {
  if (!syncToken) {
    return syncSourceWindow(sourceCalendarId, destCalendarId, config);
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
    }
    
    const response = Calendar.Events.list(sourceCalendarId, requestParams);
    
    if (response.items) {
      for (const item of response.items) {
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
    console.info('Sync complete ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's; ' + metrics.added + ' added, ' + metrics.updated + ' updated, ' + metrics.deleted + ' deleted');
  }

  return {
    added: metrics.added,
    updated: metrics.updated,
    deleted: metrics.deleted,
    timedOut: timedOut || timedOutMidPage
  };
}
