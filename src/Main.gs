// vim: set ft=javascript ts=2 sw=2 et:
// Main orchestration entry point for calendar synchronization

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
  const props = loadProperties();
  const [ active, removed ] = qualifyConfig(props);
  {
    const nSource = (new Set(active.map(a => a.sourceId))).size;
    const nDest = (new Set(active.map(a => a.destId))).size;
    console.info(`${active.length} pairs to sync (${nSource} source, ${nDest} dest), ${removed.length} pairs to remove`);
  }

  // Loop
  try {
    mainLoop(props, active, removed);
  } catch (e) {
    if (! (e instanceof SoftTimeoutError)) { throw e; }
    console.warn('Soft timeout reached');
  }

  // Leave
  storeProperties(props);
  lock.releaseLock();  
  // FIXME - log CAL_OPS summary

}

function mainLoop(props, active, removed) {
  for (const r of removed) {
    if (removeSync(r)) {
      delete props.syncToken[ r.key() ];
      delete props.configHash[ r.key() ];
    }
  }

  for (const c of active) {
    let nextSyncToken = null;
    let why;

    if (c.syncToken) {
      console.info(`Begin incremental sync ${c.summarize()}`);
      nextSyncToken = incrementalSync(c, c.syncToken);
      if (nextSyncToken) {
        props.syncToken[ c.key() ] = nextSyncToken;
        props.configHash[ c.key() ] = c.hash();
        console.info('Finished');
        continue;
      }

      console.info(`Incremental unsuccessful, attempting new baseline sync`);
      why = 'incremental failed';
    } else if (c.configHash) {
      why = 'changed config';
    } else {
      why = 'new config';
    }

    console.info(`Begin baseline sync (${why}) ${c.summarize()}`);
    nextSyncToken = intitialSync(...);
    if (nextSyncToken) {
      props.syncToken[ c.key() ] = nextSyncToken;
      props.configHash[ c.key() ] = c.hash();
    }
    console.log('Finished');
  }
}
