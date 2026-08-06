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
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} sourceEventId - The original source event ID
 * @param {string} [instanceSuffix=''] - Optional instance suffix, preserved
 * @return {string} A valid destination event ID (up to 1024 chars supported by Google)
 */
function _makeDestId(calendarId, baseId, instanceSuffix = '') {
  // XXX would in the future like a reversible Id, back to source cal and source event, but the
  // length of each combined can *in theory* exceed the 1024 limit, so we could not just
  // naively embed, e.g. base32(calId + '::' + eId).

  // FIXME - magic string
  let destId = 'gcs' + generateMd5Hash(calendarId + '::' + baseId);
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
 * @return {Object} A destination event, including ID
 */
function buildDestReplica(sourceEvent, config) {
  const rulesResult = evaluateRules(sourceEvent.summary, config.rules);

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
  } else if (sourceEvent['status'] != null) {
    destEvent.status = sourceEvent.status;
  }

  for (const attr of ['description', 'location', 'transparency', 'visibility']) {
    if (sourceEvent[attr] != null) {
      destEvent[attr] = sourceEvent[attr];
    }
  }
  //for (const attr of ['start', 'end', 'originalStartTime']) {
  for (const attr of ['start', 'end']) {
    if (sourceEvent[attr] != null) {
      destEvent[attr] = { ...sourceEvent[attr] };
    }
  }
  if (sourceEvent.recurrence) {
    destEvent.recurrence = [ ...sourceEvent.recurrence ];
  } 
//  else if (sourceEvent.recurringEventId) {
//    destEvent.recurringEventId = _makeDestId(config.sourceId, sourceEvent.recurringEventId);
//  }
  if (rulesResult.colorId != null) {
    destEvent.colorId = rulesResult.colorId;
  }

  if (sourceEvent.recurringEventId) {
    // if (! sourceEvent.id.startsWith(sourceEvent.recurringEventId + '_')) throw new Error
    const instanceSuffix = sourceEvent.id.slice(sourceEvent.recurringEventId.length + 1); 
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
function syncExceptionEvent(sourceEvent, config, omittedParents, onSync) {
  // 1) If we know the parent is absent from the dest calendar,
  //    then there are no exceptions to update.  Nothing to do.
  //
  if (omittedParents.has(sourceEvent.recurringEventId)) {
    return;
  }

  const destEvent = buildDestReplica(sourceEvent, config);

  if (destEvent.status === 'cancelled') {
    calRemoveEvent(config.destId, destEvent.id);
    return;
  }

  try {
    calReplaceEvent(config.destId, destEvent);
  } catch (e) {
    if (! isGoogleJsonResponseErr(e, 404)) { throw e; }

    // Parent is missing.  Can happen on a time-windowed Events.list
    // on a first-time sync, where an exception event occurs in our
    // window, but the main series otherwise does not.
    const sourceParent = calGetEvent(config.sourceId, sourceEvent.recurringEventId);
    if (! sourceParent) {
      // Parent is missing. Unusual (delete race by another actor?) but not
      // fatal
      omittedParents.add(sourceEvent.recurringEventId);
      return;
    } else if (! syncEvent(sourceParent, config, omittedParents)) {
      // Parent is cancelled or skipped.  The calRemoveEvent will
      // cascade to any child exception instances already on dest cal.
      // syncEvent() records the parent in omittedParents itself.
      return;
    }

    // Try again
    calReplaceEvent(config.destId, destEvent);
  }

  onSync?.(destEvent);
  return destEvent.id;
}

/**
 * Upsert or delete event, after applying any rules. 
 *
 * @param {string} sourceEvent - The event to process
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {Set} omittedParents - Internal bookkeeping set of known-absent parent events
 * @param {onSync} [onSync=null] - Optional callback to run on every sync'd dest event
 * @return The new destEvent id, if applicable
 */
function syncEvent(sourceEvent, config, omittedParents, onSync) {
  let r = null;

  if (sourceEvent.extendedProperties?.private?.sourceCalendarId) {
    console.warn('Loop guard: skipping replica found in source calendar: ' + sourceEvent.summary);
    return;
  }

  if (sourceEvent.recurringEventId) {
    return syncExceptionEvent(sourceEvent, config, omittedParents, onSync);
  }

  if (sourceEvent.status === 'cancelled') {
    const destEventId = _makeDestId(config.sourceId, sourceEvent.id);
    calRemoveEvent(config.destId, destEventId);
  } else {
    const candidateDestEvent = buildDestReplica(sourceEvent, config);
    if (candidateDestEvent.status === 'cancelled') {
      // skipped by rule
      calRemoveEvent(config.destId, candidateDestEvent.id);
    } else {
      calUpsertEvent(config.destId, candidateDestEvent);
      onSync?.(candidateDestEvent);
      r = candidateDestEvent.id;
    }
  }

  if (!r && sourceEvent.recurrence) {
    omittedParents.add(sourceEvent.id);
  }

  return r;
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
  const omittedParents = new Set(); // bookkeeping for syncExceptionEvent

  params = { ...params, 
             ...{ eventTypes: 'default', singleEvents: false } };

  return calStreamEvents(config.sourceId, params, sourceEvent =>
    syncEvent(sourceEvent, config, omittedParents, onSync)
  );
}

/**
 * Perform an initial baseline sync of the given config spec's source calendar to the
 * dest calendar, applying any transformation or skip rules along the way.
 *
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {boolean} deleteOrphans - Whether to delete orphaned pre-existing dst events
 * @return {string} The source calendar syncToken for a subsequent incremental sync
 */
function initialSync(config, startFrom) {
  const synced = new Set();

  const syncToken = syncLoop(config,
                             { timeMin: startFrom,
                               showDeleted: false },
                             (destEvent) => synced.add(destEvent.id)
  );

  if (synced.size) {
    const filter = { privateExtendedProperty: 'sourceCalendarId=' + config.sourceId };

    calStreamEvents(config.destId, filter, event => {
        if (! synced.has(event.id)) {
          calRemoveEvent(config.destId, event.id);
        }
      }
    );
  }

  return syncToken;
}

/**
 * Perform an incremental sync from the given config spec's source calendar to the
 * dest calendar, applying any transformation or skip rules along the way.
 *
 * @param {Object} config - The src/dst calendar configuration spec
 * @param {boolean} syncToken - The src calendar starting point token
 * @return {string} The source calendar syncToken for a subsequent incremental sync
 */
function incrementalSync(config, syncToken) {
  const params = {   syncToken: syncToken,
                   showDeleted: true       };

  return syncLoop(config, params);
}

