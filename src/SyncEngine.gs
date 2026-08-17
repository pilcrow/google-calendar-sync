// vim: set ft=javascript ts=2 sw=2 et:

/**
 * Generate a deterministic destination event ID from source calendar and event IDs,
 * preserving any instance/exception timestamp suffix.
 *
 * source cal    source event id         -> dest event id
 * -------  ----------------------    -------------
 *   abc     XYZ                      'gcs' + hash('abc::XYZ')
 *   abc     XYZ_20260101T010203Z     'gcs' + hash('abc::XYZ') + '_20260101T010203Z'
 *
 * @param {string} calendarId - The (source) calendar identifier
 * @param {string} baseId - The original (source) base event ID
 * @param {string} [instanceSuffix=''] - Optional instance suffix, preserved
 * @return {string} A valid destination event ID (up to 1024 chars supported by Google)
 */
function _makeDestId(calendarId, baseId, instanceSuffix = '') {
  // XXX would in the future like a reversible Id, back to source cal and source event, but the
  // length of each combined can *in theory* exceed the 1024 limit, so we could not just
  // naively embed, e.g. base32(calId + '::' + eId).

  // FIXME - magic string
  let destId = 'gcs' + GCS.Utils.generateMd5Hash(calendarId + '::' + baseId);
  if (instanceSuffix) {
    destId += ('_' + instanceSuffix)
  }

  return destId;
}

/**
 * Compose the event to sync over, given a source calendar and config rule.  Skipped
 * events have their status changed to 'cancelled'.
 *
 * @param {Object} sourceEvent - A complete calendar event to translate to the dest cal
 * @param {Object} config - The src/dst sync instructions
 * @return {Object} The destination event
 */
function buildDestReplica(sourceEvent, config) {
  const rulesResult = GCS.Rules.evaluateRules(sourceEvent.summary, config.rules);

  const destEvent = {
    summary: (rulesResult.prefix || '') + (sourceEvent.summary || ''),
    extendedProperties: {
      private: {
        sourceCalendarId: config.sourceId,
        sourceEventId:    sourceEvent.id
      }
    }
  };

  if (rulesResult.skip) {
    destEvent.status = 'cancelled';
  } else if (sourceEvent.status != null) {
    destEvent.status = sourceEvent.status;
  }

  for (const attr of ['description', 'location', 'transparency', 'visibility']) {
    if (sourceEvent[attr] != null) {
      destEvent[attr] = sourceEvent[attr];
    }
  }

  for (const attr of ['start', 'end']) {
    if (sourceEvent[attr] != null) {
      destEvent[attr] = { ...sourceEvent[attr] };
    }
  }

  if (sourceEvent.recurrence) {
    destEvent.recurrence = [ ...sourceEvent.recurrence ];
  }

  if (rulesResult.colorId != null) {
    destEvent.colorId = rulesResult.colorId;
  }

  if (sourceEvent.recurringEventId) {
    const instanceSuffix = sourceEvent.id.slice(sourceEvent.recurringEventId.length + 1);
    //if (! instanceSuffix) { throw new Error('Corrupted source event?'); }
    destEvent.id = _makeDestId(config.sourceId, sourceEvent.recurringEventId, instanceSuffix);
  } else {
    destEvent.id = _makeDestId(config.sourceId, sourceEvent.id);
  }

  return destEvent;
}

/**
 * @callback onSync
 * @param {Object} destEvent - The newly sync'd destination event
 */

/**
 * Sync a recurring exception instance to the destination calendar.
 *
 * A confirmed exception is materialized in place on its computed instance ID
 * (calReplaceEvent — the instance is addressed directly, never inserted).  A
 * cancelled or skip-filtered exception is removed from the destination by its
 * computed instance ID (calRemoveEvent), mirroring the master path.
 *
 * Exceptions are only synced while their parent master is viable on the
 * destination.  If the update reports the parent absent (404), the source parent
 * is fetched and synced first; if that parent is missing, cancelled, or
 * skip-filtered, it is recorded in omittedParents and the exception is not
 * synced (removing the destination master cascades to its instances).
 *
 * @param {Object} sourceEvent - The event to process
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {Set} omittedParents - Internal bookkeeping set of known-absent parent events
 * @param {onSync} [onSync=null] - Optional callback to run on every sync'd dest event
 * @return {string|undefined} The new destEvent's id, if applicable
 */
function _syncExceptionEvent(sourceEvent, config, omittedParents, onSync) {
  // 1) If we know the parent is absent from the dest calendar,
  //    then there are no exceptions to update.  Nothing to do.
  //
  if (omittedParents.has(sourceEvent.recurringEventId)) {
    return;
  }

  const destEvent = buildDestReplica(sourceEvent, config);

  // Apply a dest-side exception: replace a confirmed exception, or remove a
  // cancelled one.  Returns true when fully handled (cancelled: removed or
  // already gone), false when replaced and still to be reported via onSync.
  //
  // toleratedErrors only affects the cancelled branch.  The first attempt
  // passes [410] to *raise* 404s: on a recurring series, remove() of an
  // instance of an existing master always succeeds, so a 404 here means the
  // parent master is absent from the dest cal — and a later orphaned sibling
  // exception that is *not* cancelled (like a reschedule) might pull in the
  // absent parent, so our cancels can't be themselves omitted — they need to
  // appear on the dest cal.  The retry uses the default [404, 410]: the parent
  // was just materialized, so a 404 is anomalous and safe to ignore.
  const applyException = (toleratedErrors = [404, 410]) => {
    if (destEvent.status === 'cancelled') {
      calRemoveEvent(config.destId, destEvent.id, toleratedErrors);
      return true;
    } else {
      calReplaceEvent(config.destId, destEvent);
      return false;
    }
  };

  try {
    if (applyException([410])) { return; }
  } catch (e) {
    if (! GCS.Utils.isGoogleJsonResponseErr(e, 404)) { throw e; }

    // Parent is missing.  Can happen on a time-windowed Events.list
    // on a first-time sync, where an exception event appears in our
    // window, but the main series otherwise does not.  Or a race if
    // someone deleted the parent outside this script.
    const sourceParent = calGetEvent(config.sourceId, sourceEvent.recurringEventId);
    if (! sourceParent) {
      // Parent is completely missing from source. Unusual (true expiry/trash on
      // source cal?), but same as cancelled parent from our perspective.
      omittedParents.add(sourceEvent.recurringEventId);
      return;
    } else if (! syncEvent(sourceParent, config, omittedParents, onSync)) {
      // Parent is cancelled or skipped, and calRemoveEvent already called
      // on dest parent replica, which will cascade to children.
      // syncEvent() records the parent in omittedParents itself.
      return;
    }

    // Try again
    if (applyException()) { return; }
  }

  onSync?.(destEvent);
  return destEvent.id;
}

/**
 * Upsert or delete event, after applying any rules. 
 *
 * @param {Object} sourceEvent - The event to process
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {Set} omittedParents - Internal bookkeeping set of known-absent parent events
 * @param {onSync} [onSync=null] - Optional callback to run on every sync'd dest event
 * @return The new destEvent id, if applicable
 * @throws {SoftTimeoutError} 
 */
function syncEvent(sourceEvent, config, omittedParents, onSync=null) {
  if (sourceEvent.extendedProperties?.private?.sourceCalendarId) {
    console.warn('Loop guard: skipping replica found in source calendar: ' + sourceEvent.summary);
    return;
  }

  GCS.Utils.scriptTimeCheck();

  if (sourceEvent.recurringEventId) {
    return _syncExceptionEvent(sourceEvent, config, omittedParents, onSync);
  }

  const destEvent = buildDestReplica(sourceEvent, config);
  if (destEvent.status === 'cancelled') {
    calRemoveEvent(config.destId, destEvent.id);
    if (sourceEvent.recurrence) { omittedParents.add(sourceEvent.id); }
    return;
  }

  // upsert
  if (config.syncTime && (Date.parse(sourceEvent.created) <= config.syncTime)) {
    // we likely synced this event previously.  optimistic replace
    if (!calReplaceEvent(config.destId, destEvent, [404])) {
      GCS.Utils.scriptTimeCheck();
      calInsertEvent(config.destId, destEvent, []);
    }
  } else {
    // optimistic insert
    if (! calInsertEvent(config.destId, destEvent, [409])) {
      GCS.Utils.scriptTimeCheck();
      calReplaceEvent(config.destId, destEvent, []);
    }
  }
  onSync?.(destEvent);
  return destEvent.id;
}

/**
 * Perform the requested source -> dest sync loop, applying policy.
 *
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {Object} params - Params to pass to calStreamEvents
 * @param {onSync} [onSync=null] - Optional callback to run on every sync'd dest event
 * @return {string} The next syncToken for the given source calendar
 */
function syncLoop(config, params, onSync = null) {
  const omittedParents = new Set(); // bookkeeping for _syncExceptionEvent

  const effectiveParams = { ...params,
                            eventTypes: 'default',
                            singleEvents: false };

  GCS.Utils.scriptTimeCheck();
  return calStreamEvents(config.sourceId, effectiveParams, sourceEvent =>
    syncEvent(sourceEvent, config, omittedParents, onSync)
  );
}

/**
 * Perform an initial baseline sync of the given config spec's source calendar to the
 * dest calendar, applying any transformation or skip rules along the way.
 *
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {string} startFrom - ISO timestamp string to start from
 * @return {string} The source calendar syncToken for a subsequent incremental sync
 */
function initialSync(config, startFrom) {
  const synced = new Set();

  const syncToken = syncLoop(config,
                             { timeMin: startFrom,
                               showDeleted: false },
                             (destEvent) => synced.add(destEvent.id)
  );

  const filter = { privateExtendedProperty: 'sourceCalendarId=' + config.sourceId };

  GCS.Utils.scriptTimeCheck();
  calStreamEvents(config.destId, filter, event => {
    if (! synced.has(event.id)) {
      GCS.Utils.scriptTimeCheck();
      calRemoveEvent(config.destId, event.id);
    }
  });

  return syncToken;
}

/**
 * Perform an incremental sync from the given config spec's source calendar to the
 * dest calendar, applying any transformation or skip rules along the way.
 * If the syncToken is expired, returns null.
 *
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {string} syncToken - The src calendar starting point token
 * @return {string} The source calendar syncToken for a subsequent incremental sync
 *                  or null if the token was expired.
 */
function incrementalSync(config, syncToken) {
  const params = {   syncToken: syncToken,
                   showDeleted: true       };

  try {
    return syncLoop(config, params);
  } catch (e) {
    if (GCS.Utils.isGoogleJsonResponseErr(e, 410)) {
      for (const err of (e.details?.errors || [])) {
        if (err.reason === 'fullSyncRequired') {
          return null;
        }
      }
    }
    throw e;
  }
  // not reached
}
