// vim: set ft=javascript ts=2 sw=2 et:
// Main orchestration entry point for calendar synchronization

SCRIPT_DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Entry point for Google Apps Script execution
 */
function main() {
  // Lock
  const lock = LockService.getUserLock();
  if (! lock.tryLock(SCRIPT_LOCK_TIMEOUT_MS)) {
    console.error('Could not acquire script lock - exiting');
    return;
  }

  // Load
  const props = ScriptProperties.load();
  const [ active, removed ] = qualifyConfig(props);
  {
    const nSource = (new Set(active.map(a => a.sourceId))).size;
    const nDest = (new Set(active.map(a => a.destId))).size;
    console.info(`${active.length} pairs to sync (${nSource} source, ${nDest} dest), ${removed.length} pairs to dismiss`);
  }

  // Loop
  try {
    mainLoop(props, active, removed);
  } catch (e) {
    if (! (e instanceof SoftTimeoutError)) { throw e; }
    console.warn('Soft timeout reached');
  }

  // Leave
  ScriptProperties.store(props);
  lock.releaseLock();

  const callSummary = Object.entries(calApiCallsSnapshot())
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  console.info(`Done in ${Date.now() - SCRIPT_BASETIME}ms; API calls: ${callSummary}`);
}

function mainLoop(props, active, removed) {
  // Dismissal is state-only: synced replicas are left untouched and are
  // reconciled on a future full sync.
  for (const key of removed) {
    console.warn(`Dismissing sync state ${key}`);
    props.clear(key);
  }

  for (const c of active) {
    const started = Date.now();
    const opsBefore = calOpsSnapshot(c.destId);
    const summarizePair = () => {
      const ops = calOpsSince(c.destId, opsBefore);
      console.info(`Finished ${c.summarize()} in ${Date.now() - started}ms: ` +
        `+${ops.added} -${ops.removed} ~${ops.updated}`);
    };

    let nextSyncToken = null;
    let why;

    if (c.syncToken) {
      console.info(`Begin incremental sync ${c.summarize()}`);
      nextSyncToken = incrementalSync(c, c.syncToken);
      if (nextSyncToken) {
        props.update(c.key(), { syncToken: nextSyncToken,
                          configHash: c.hash(),
                          syncTime: Date.now() });
        summarizePair();
        continue;
      }

      console.info(`Incremental unsuccessful, falling back to baseline sync`);
      why = 'incremental failed';
    } else if (c.configHash) {
      why = 'changed config';
    } else {
      why = 'new config';
    }

    const lookbackDays = LOOKBACK_DAYS ?? SCRIPT_DEFAULT_LOOKBACK_DAYS;
    const startWhen = new Date();
    startWhen.setDate(startWhen.getDate() - lookbackDays);
    console.info(`Begin baseline sync (${why}) ${c.summarize()}, looking back ${lookbackDays} to ${startWhen.toISOString()}`);
    nextSyncToken = initialSync(c, startWhen.toISOString());
    if (nextSyncToken) {
      props.update(c.key(), { syncToken: nextSyncToken,
                        configHash: c.hash(),
                        syncTime: Date.now() });
    }
    summarizePair();
  }
}
