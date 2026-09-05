// vim: set ft=javascript ts=2 sw=2 et:
// Main orchestration entry point for calendar synchronization

const SCRIPT_DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Entry point for Google Apps Script execution
 */
function main() {
  // Lock
  const lockStarted = Date.now();
  const lock = LockService.getUserLock();
  const lockAcquired = lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS);
  SCRIPT_TIMINGS.lockMs = Date.now() - lockStarted;
  if (! lockAcquired) {
    console.error('Could not acquire script lock - exiting');
    return;
  }

  // Load
  const props = GCS.Config.ScriptProperties.load();
  const [ active, remembered, removed ] = GCS.Config.qualifyConfig(props);
  {
    const nSource = (new Set(active.map(a => a.sourceId))).size;
    const nDest = (new Set(active.map(a => a.destId))).size;
    console.info(`${active.length} pairs to sync (${nSource} source, ${nDest} dest), ` +
                 `${remembered.length} removed pairs remembered, ${removed.length} removed pairs to forget`);
  }

  // Loop
  const syncStarted = Date.now();
  try {
    mainLoop(props, active, removed);
  } catch (e) {
    if (! (e instanceof GCS.Utils.SoftTimeoutError)) { throw e; }
    console.warn('Soft timeout reached');
  } finally {
    SCRIPT_TIMINGS.syncMs = Date.now() - syncStarted;
  }

  // Leave
  GCS.Config.ScriptProperties.store(props);
  lock.releaseLock();

  const callSummary = Object.entries(calApiCallsSnapshot())
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  const timingSummary = `lock=${SCRIPT_TIMINGS.lockMs}ms, ` +
    `load=${SCRIPT_TIMINGS.propertiesLoadMs}ms, ` +
    `sync=${SCRIPT_TIMINGS.syncMs}ms, ` +
    `store=${SCRIPT_TIMINGS.propertiesStoreMs}ms`;
  console.info(`Done in ${Date.now() - SCRIPT_BASETIME}ms; ` +
    `API calls: ${callSummary}; timing: ${timingSummary}`);
}

function mainLoop(props, active, removed) {
  // Dismissal is state-only: synced replicas are left untouched and are
  // reconciled on a future full sync.
  for (const key of removed) {
    console.warn(`Dismissing sync state ${key}`);
    props.clear(key);
  }

  for (const c of active) {
    syncPair(props, c);
  }
}

function syncPair(props, c) {
  const started = Date.now();
  const opsBefore = calOpsSnapshot(c.destId);
  let mode;
  let why;
  let result = 'ERR';

  try {
    let nextSyncToken = null;

    if (c.syncToken) {
      mode = 'incremental';
      nextSyncToken = incrementalSync(c, c.syncToken);
      if (nextSyncToken) {
        props.update(c.key(), { syncToken: nextSyncToken,
                          configHash: c.hash(),
                          syncTime: Date.now() });
        result = 'OK';
        return;
      }

      console.info(`Incremental unsuccessful, falling back to baseline sync`);
      why = 'incremental failed';
    } else if (c.configHash) {
      why = 'changed config';
    } else {
      why = 'new config';
    }

    mode = 'baseline';
    const lookbackDays = (typeof LOOKBACK_DAYS !== 'undefined' ? LOOKBACK_DAYS : SCRIPT_DEFAULT_LOOKBACK_DAYS);
    const startWhen = new Date();
    startWhen.setDate(startWhen.getDate() - lookbackDays);
    nextSyncToken = initialSync(c, startWhen.toISOString());
    if (nextSyncToken) {
      props.update(c.key(), { syncToken: nextSyncToken,
                        configHash: c.hash(),
                        syncTime: Date.now() });
    }
    result = 'OK';
  } catch (e) {
    console.error(e);
    throw e;
  } finally {
    const ops = calOpsSince(c.destId, opsBefore);
    const detail = `${mode}${why ? ` (${why})` : ''}`;
    console.info(`${c.summarize()} ${detail} ${result} ${Date.now() - started}ms: ` +
      `+${ops.added} -${ops.removed} ~${ops.updated}`);
  }
}
