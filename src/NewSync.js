// vim: set ft=javascript ts=2 sw=2 et:

/**
 * Generate a deterministic destination event ID from source calendar and event IDs,
 * preserving any instance/exception timestamp suffix.
 *
 * src cal    src event id         -> dest event id
 * -------  ----------------------    -------------
 *   abc     XYZ                      'gcs' + hash('abc::XYZ')
 *   abc     XYZ_20260101T010203Z     'gcs' + hash('abc::XYZ') + '_20260101T010203Z'
 *
 * @param {string} sourceCalendarId - The source calendar identifier
 * @param {string} sourceEventId - The original source event ID
 * @return {string} A valid destination event ID (up to 1024 chars supported by Google)
 */
// XXX would in the future like a reversible Id, back to src cal and src event, but the
// length of each combined can *in theory* exceed the 1024 limit, so we could not just
// naively embed, e.g. base32(calId + '::' + eId).
function makeDestId(calendarId, eventId) {
  const [baseId, instanceSuffix] = eventId.split('_', 2);

  // FIXME - magic string
  let destId = 'gcs' + md5Hash(calendarId + '::' + baseId);
  if (instanceSuffix) {
    destId += ('_' + instanceSuffix)
  }

  return destId;
}

function buildDestReplica(sourceCalendarId, sourceEvent, rulesResult) {
  const destEvent = {
    summary: (rulesResult.prefix || '') + (sourceEvent.summary || ''),
    extendedProperties: {
      private: {
        sourceCalendarId: sourceCalendarId,
        sourceEventId:    sourceEvent.id
      }
    }
  };

  ['description', 'location', 'transparency', 'visibility']
    .filter((x) => sourceEvent[x] != null)
    .forEach((x) => destEvent[x] = sourceEvent[x]);
  for (const attr of ['description', 'location', 'transparency', 'visibility']) {
    if (sourceEvent[attr] != null) {
      destEvent[attr] = sourceEvent[attr];
    }
  }
  for (const attr of ['start', 'end', 'originalStartTime']) {
    if (sourceEvent[attr] != null) {
      destEvent[attr] = { ...sourceEvent[attr] };
    }
  }
  if (sourceEvent.recurrence) {
    destEvent.recurrence = [ ...sourceEvent.recurrence ];
  } else if (sourceEvent.recurringEventId) {
    destEvent.recurringEventId = makeDestId(config, sourceEvent.recurringEventId);
  }
  if (rulesResult.colorId != null) {
    destEvent.colorId = rulesResult.colorId;
  }
  destEvent.id = makeDestId(sourceCalendarId, sourceEvent.id);

  return destEvent;
}

function syncExceptionEvent(sourceEvent, config) {
  if (!srcEvent.recurringEventId) {
    throw new Error('syncExceptionEvent() called on non-exception event');
  }

  const dstEventId = makeDstEventId(config.dstId, srcEvent.id);
  const dstParentId = makeDstEventId(config.dstId, srcEvent.recurringEventId);

  if (! calEventExists(config.dstId, dstParentId)) {
    srcParent = calGetEvent(config.srcId, srcEvent.recurringEventId);
    if (! srcParent) {
      console.warn('Source parent event unexpectedly missing');
      calRemoveEvent(config.dstId, dstEventId);
      return;
    }
    if (! syncEvent(srcParent, config) {
      // parent cancelled/skipped, so is child
      calRemoveEvent(config.dstId, dstEventId);
      return;
    }
  }

  const verdict = evaluateRules(srcEvent, config.rules);
  const dstEvent = buildDstEvent(srcEvent, config, verdict);

  if (verdict.skip) {
    dstEvent.status = 'cancelled';
  }

  calUpsertEvent(config.dstId, dstEvent);
}

function syncEvent(srcEvent, config) {
  // XXX FIXME param to suppress calRemoveEvent on first load
  if (item.extendedProperties?.private?.sourceCalendarId) {
    console.warn('Loop guard: skipping replica found in source calendar: ' + srcEvent.summary);
    return;
  }

  if (event.recurringEventId) { return syncExceptionEvent(srcEvent, config); }

  const dstEventId = makeDstEventId(config.dstId, srcEvent.id);

  if (event.status === 'cancelled') {
    // XXX could skip on initial load, presuming nothing there to cancel
    calRemoveEvent(config.dstId, dstEventId);
    return;
  }

  const verdict = evaluateRules(srcEvent, config.rules);
  if (verdict.skip) {
    calRemoveEvent(config.dstId, dstEvent);
    return;
  }

  dstEvent = buildDestReplica(config.srcId, srcEvent, verdict);
  calEventUpsert(config.dstId, dstEvent);

  return dstEvent.id
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
  return calStreamEvents(src, { syncToken: syncToken }, event =>
    syncEvent(event, config);
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
function initialSync(config, deleteOrphans = true) {
  const replicaIds = new Set();

  const syncToken = calStreamEvents(src, { timeMin: FIXME }, event =>
    dstEventId = syncEvent(event, config);
    if (dstEventId) replicaIds.add(dstEventId);
  );

  if (deleteOrphans) {
    const filter = { privateExtendedProperty: 'sourceCalendarId=' + config.srcId };
    // XXX capture dst cal sync token?
    calStreamEvents(config.dstId, filter, event =>
      if (! replicaIds.has(event.id)) {
        calRemoveEvent(config.dstId, event);
      }
    );
  }

  return syncToken;
}
