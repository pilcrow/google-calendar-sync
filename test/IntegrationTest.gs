// vim: set ft=javascript ts=2 sw=2 et:
// IntegrationTest.gs — real-API integration tests for the sync engine.
//
// Drives mainLoop() (never main(), so qualifyConfig and production UserProperties
// are not touched) against dedicated GCS TEST calendars, asserting on destination
// state, stored pair state, and Calendar API call/write counters.
//
// USAGE
//   Deploy to a NON-PRODUCTION script project (clasp push), then run from the
//   IDE:
//     runIntegrationTests()       full suite (reads TEST_SUITES config)
//     itCleanupAll()              wipe leftover fixture events from the test cals
//     itCleanupCalendars()        PERMANENTLY delete the GCS TEST calendars
//
// The suite creates two calendars ("GCS TEST Source"/"GCS TEST Destination",
// timezone UTC, IDs stored in script properties) and reuse them across runs.
// Source fixtures use deterministic 'gsctest...' ids and UTC times.  Every
// individual test starts from a fresh ScriptProperties instance and cleans up
// its source fixtures and destination replicas afterwards.
//
// SAFETY
//   - Run only in the dev/test script project.  Calendars are real and
//     UserProperties keys are fixture-scoped, but this still mutates a live
//     Google account.
//   - All times are relative to the effective LOOKBACK_DAYS, so fixtures stay
//     deterministic regardless of the configured window.

const IT_CAL_PREFIX = 'GCS TEST ';
const IT_PROPS_KEY_SOURCE = 'GCS_TEST_SOURCE_ID';
const IT_PROPS_KEY_DEST = 'GCS_TEST_DEST_ID';
const IT_EVENT_ID_PREFIX = 'gsctest';
const IT_HOUR = 3600000;
const IT_DAY = 86400000;

let itFailures = 0;
let itSeq = 0;

function itAssert(cond, msg) {
  if (!cond) { throw new Error('ASSERT FAILED: ' + msg); }
}

function itJson(value) {
  try { return JSON.stringify(value); } catch (e) { return String(value); }
}

function itExceptionDetails(e) {
  const details = {
    name: e && e.name,
    message: e && e.message,
    stack: e && e.stack,
    string: String(e)
  };
  try {
    for (const key of Object.getOwnPropertyNames(e)) {
      if (!(key in details)) { details[key] = e[key]; }
    }
  } catch (ignored) {}
  details.json = itJson(e);
  return itJson(details);
}

function itTest(title, fn) {
  console.log('==== ' + title + ' ====');
  try {
    fn();
    console.log('  PASS');
  } catch (e) {
    itFailures++;
    console.error('  FAIL: ' + (e && e.message ? e.message : String(e)));
    console.error('  EXCEPTION: ' + itExceptionDetails(e));
  }
}

function itGetPropsService() {
  return PropertiesService.getScriptProperties();
}

function itProvisionCalendars() {
  const store = itGetPropsService();
  let srcId = store.getProperty(IT_PROPS_KEY_SOURCE);
  let dstId = store.getProperty(IT_PROPS_KEY_DEST);
  if (srcId && !CalendarApp.getCalendarById(srcId)) { srcId = null; }
  if (dstId && !CalendarApp.getCalendarById(dstId)) { dstId = null; }

  const source = srcId ? CalendarApp.getCalendarById(srcId)
                       : CalendarApp.createCalendar(IT_CAL_PREFIX + 'Source');
  const dest = dstId ? CalendarApp.getCalendarById(dstId)
                     : CalendarApp.createCalendar(IT_CAL_PREFIX + 'Destination');
  source.setTimeZone('UTC');
  dest.setTimeZone('UTC');

  srcId = source.getId();
  dstId = dest.getId();
  store.setProperty(IT_PROPS_KEY_SOURCE, srcId);
  store.setProperty(IT_PROPS_KEY_DEST, dstId);
  return { sourceId: srcId, destId: dstId };
}

function itCleanupCalendars() {
  const store = itGetPropsService();
  const ids = [store.getProperty(IT_PROPS_KEY_SOURCE), store.getProperty(IT_PROPS_KEY_DEST)];
  store.deleteProperty(IT_PROPS_KEY_SOURCE);
  store.deleteProperty(IT_PROPS_KEY_DEST);
  for (const id of ids) {
    if (!id) { continue; }
    const cal = CalendarApp.getCalendarById(id);
    if (cal) { cal.deleteCalendar(); }
  }
  console.log('GCS TEST calendars permanently deleted.');
}

function itCleanupAll() {
  const { sourceId, destId } = itProvisionCalendars();
  itSweepSourceFixtures(sourceId);
  itCleanupPair(destId, sourceId);
  console.log('Fixture cleanup complete; GCS TEST calendars retained for inspection.');
}

function itFreshProps() {
  return new GCS.Config.ScriptProperties({ syncToken: {}, configHash: {}, syncTime: {} });
}

function itLookbackDays() {
  return (typeof LOOKBACK_DAYS !== 'undefined') ? LOOKBACK_DAYS : SCRIPT_DEFAULT_LOOKBACK_DAYS;
}

function itDaysAgo(n) { return new Date(Date.now() - n * IT_DAY); }
function itDaysAhead(n) { return new Date(Date.now() + n * IT_DAY); }
function itFmtUTC(d) { return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'"); }

function itNextEventId() {
  return IT_EVENT_ID_PREFIX + String(Date.now()) + String(itSeq++);
}

function itCalEventsCall(operation, args, logFailure = true) {
  const fn = Calendar.Events[operation];
  if (! (typeof fn === 'function')) {
    throw new Error('Unrecognized Calendar.Events requested: ' + operation);
  }
  console.log('Calendar.Events.' + operation + ' ' + itJson(args));
  try {
   return fn(...args);
  } catch (e) {
    if (logFailure !== false) {
      console.error('Calendar.Events.' + operation + ' failed: ' + itJson(args));
      console.error('Calendar.Events.' + operation + ' exception: ' + itExceptionDetails(e));
    }
    throw e;
  }
}

function itCalEventsGet(calendarId, eventId, logFailure) {
  return itCalEventsCall('get', [calendarId, eventId], logFailure);
}

function itCalEventsList(calendarId, params, logFailure) {
  return itCalEventsCall('list', [calendarId, params], logFailure);
}

function itCalEventsInsert(resource, calendarId, logFailure) {
  return itCalEventsCall('insert', [resource, calendarId], logFailure);
}

function itCalEventsUpdate(resource, calendarId, eventId, logFailure) {
  return itCalEventsCall('update', [resource, calendarId, eventId], logFailure);
}

function itCalEventsRemove(calendarId, eventId, logFailure) {
  return itCalEventsCall('remove', [calendarId, eventId], logFailure);
}

function itEpochSecond(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

function itAssertTime(start, expectedIso, msg) {
  const actualIso = start && start.dateTime;
  const expectedSecond = itEpochSecond(expectedIso);
  const actualSecond = itEpochSecond(actualIso);
  const matches = actualIso && actualSecond === expectedSecond;
  itAssert(matches, msg + ' expected=' + expectedIso + ' actual=' + itJson(start));
}

function itCreateEvent(calId, spec) {
  const resource = {
    id: spec.id,
    start: { dateTime: spec.start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: spec.end.toISOString(), timeZone: 'UTC' }
  };
  if (spec.summary != null) { resource.summary = spec.summary; }
  if (spec.recurrence) { resource.recurrence = spec.recurrence; }
  if (spec.description != null) { resource.description = spec.description; }
  if (spec.location != null) { resource.location = spec.location; }
  if (spec.extendedProperties != null) { resource.extendedProperties = spec.extendedProperties; }
  return itCalEventsInsert(resource, calId);
}

function itReschedule(sourceId, master, origStart, newStart, summary) {
  const instanceId = master.id + '_' + itFmtUTC(origStart);
  console.log('itReschedule context ' + itJson({
    sourceId: sourceId,
    masterId: master.id,
    instanceId: instanceId,
    originalStart: origStart.toISOString(),
    newStart: newStart.toISOString(),
    summary: summary
  }));
  const fetched = itCalEventsGet(sourceId, instanceId);
  const body = Object.assign({}, fetched, {
    summary: summary,
    start: { dateTime: newStart.toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(newStart.getTime() + IT_HOUR).toISOString(), timeZone: 'UTC' }
  });
  return itCalEventsUpdate(body, sourceId, instanceId);
}

function itRunSync(props, sourceId, destId, rules) {
  const config = { source: sourceId, destination: destId, rules };
  const ac = new GCS.Config.ActiveConfig(config, props, { sourceId: sourceId, destId: destId });
  mainLoop(props, [ac], []);
  return props;
}

function itListDestReplicas(destId, srcId) {
  const items = [];
  const searchParams = {
    privateExtendedProperty: 'sourceCalendarId=' + srcId,
    singleEvents: false,
    maxResults: 250
  };
  do {
    const res = itCalEventsList(destId, searchParams);
    if (res.items) { items.push(...res.items); }
    searchParams.pageToken = res.nextPageToken;
  } while (searchParams.pageToken);
  return items;
}

function itGetEvent(calId, eventId) {
  try {
    return itCalEventsGet(calId, eventId, false);
  } catch (e) {
    return null;
  }
}

function itPairState(props, srcId, destId) {
  const key = srcId + '::' + destId;
  return {
    syncToken: props.syncToken?.[key],
    configHash: props.configHash?.[key],
    syncTime: props.syncTime?.[key]
  };
}

function itCleanupPair(destId, srcId) {
  const items = itListDestReplicas(destId, srcId);
  items.sort((a, b) => (b.recurrence ? 1 : 0) - (a.recurrence ? 1 : 0));
  for (const ev of items) {
    try { itCalEventsRemove(destId, ev.id, false); } catch (e) { }
  }
}

function itCleanupSourceEvents(srcId, events) {
  for (const ev of events) {
    if (!ev) { continue; }
    try { itCalEventsRemove(srcId, ev.id, false); } catch (e) { }
  }
}

function itSweepSourceFixtures(srcId) {
  const L = itLookbackDays();
  const searchParams = {
    timeMin: itDaysAgo(L + 10).toISOString(),
    timeMax: itDaysAhead(10).toISOString(),
    singleEvents: false,
    maxResults: 250
  };
  do {
    const res = itCalEventsList(srcId, searchParams);
    for (const ev of (res.items || [])) {
      if (String(ev.id).indexOf(IT_EVENT_ID_PREFIX) === 0) {
        try { itCalEventsRemove(srcId, ev.id, false); } catch (e) { }
      }
    }
    searchParams.pageToken = res.nextPageToken;
  } while (searchParams.pageToken);
}

function itTearDown(sourceId, destId, fixtures) {
  itCleanupSourceEvents(sourceId, fixtures);
  itCleanupPair(destId, sourceId);
}

function itCtx(sourceId, destId) {
  return { sourceId: sourceId, destId: destId, props: itFreshProps() };
}

// ---------------------------------------------------------------------------
// IT-01..IT-04, IT-16..IT-17: core sync
// ---------------------------------------------------------------------------

function testInsert({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Team Lunch',
      start: start,
      end: new Date(start.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 1, 'expected 1 replica, got ' + replicas.length);
    const r = replicas[0];
    itAssert(r.id === _makeDestId(sourceId, ev.id), 'deterministic dest id');
    itAssert(r.summary === 'Team Lunch', 'summary copied');
    itAssertTime(r.start, ev.start.dateTime, 'start preserved');
    itAssertTime(r.end, ev.end.dateTime, 'end preserved');
    itAssert(r.extendedProperties?.private?.sourceCalendarId === sourceId, 'tag: source');
    itAssert(r.extendedProperties?.private?.sourceEventId === ev.id, 'tag: event');

    const st = itPairState(props, sourceId, destId);
    itAssert(Boolean(st.syncToken), 'syncToken stored');
    itAssert(Boolean(st.configHash), 'configHash stored');
    itAssert(Boolean(st.syncTime), 'syncTime stored');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testUpdate({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(2);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Planning',
      description: 'v1',
      location: 'Room A',
      start: start,
      end: new Date(start.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);
    const before = itListDestReplicas(destId, sourceId);
    itAssert(before.length === 1, 'baseline replica');
    const replicaId = before[0].id;

    const fresh = itCalEventsGet(sourceId, ev.id);
    const newStart = new Date(start.getTime() + 2 * IT_HOUR);
    itCalEventsUpdate(Object.assign({}, fresh, {
      summary: 'Planning v2',
      description: 'v2',
      location: 'Room B',
      start: { dateTime: newStart.toISOString(), timeZone: 'UTC' },
      end: { dateTime: new Date(newStart.getTime() + IT_HOUR).toISOString(), timeZone: 'UTC' }
    }), sourceId, ev.id);

    const beforeOps = calOpsSnapshot(destId);
    itRunSync(props, sourceId, destId, []);

    const after = itListDestReplicas(destId, sourceId);
    itAssert(after.length === 1, 'still exactly 1 replica, got ' + after.length);
    itAssert(after[0].id === replicaId, 'same dest id, no duplicate');
    itAssert(after[0].summary === 'Planning v2', 'summary updated');
    itAssert(after[0].description === 'v2', 'description updated');
    itAssert(after[0].location === 'Room B', 'location updated');
    itAssertTime(after[0].start, newStart.toISOString(), 'start updated');

    const ops = calOpsSince(destId, beforeOps);
    itAssert(ops.added === 0, 'no inserts on update');
    itAssert(ops.updated === 1, 'exactly 1 update, got ' + ops.updated);
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testDelete({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(3);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'To Delete',
      start: start,
      end: new Date(start.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);
    itAssert(itListDestReplicas(destId, sourceId).length === 1, 'baseline replica');

    itCalEventsRemove(sourceId, ev.id);
    const beforeOps = calOpsSnapshot(destId);
    itRunSync(props, sourceId, destId, []);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 0, 'replica removed, got ' + replicas.length);
    const ops = calOpsSince(destId, beforeOps);
    itAssert(ops.removed === 1, 'exactly 1 remove, got ' + ops.removed);
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testBaselineThenIncremental({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Token Flow',
      start: start,
      end: new Date(start.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    const c0 = calApiCallsSnapshot();
    itRunSync(props, sourceId, destId, []);
    const c1 = calApiCallsSnapshot();
    const st1 = itPairState(props, sourceId, destId);
    itAssert(Boolean(st1.syncToken), 'token stored after first run');
    const listDelta1 = c1['Events.list'] - c0['Events.list'];
    itAssert(listDelta1 === 2, 'baseline = 2 Events.list (source window + dest tagged scan), got ' + listDelta1);

    const beforeOps = calOpsSnapshot(destId);
    const c2 = calApiCallsSnapshot();
    itRunSync(props, sourceId, destId, []);
    const c3 = calApiCallsSnapshot();
    const st2 = itPairState(props, sourceId, destId);
    itAssert(Boolean(st2.syncToken), 'token present after second run');
    const listDelta2 = c3['Events.list'] - c2['Events.list'];
    itAssert(listDelta2 === 1, 'incremental = 1 Events.list (no dest orphan scan), got ' + listDelta2);
    const ops = calOpsSince(destId, beforeOps);
    itAssert(ops.added === 0 && ops.removed === 0 && ops.updated === 0, 'no writes on no-op incremental');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testPreLookbackEvent({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const L = itLookbackDays();
    const start = itDaysAgo(L + 2);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Old Event',
      start: start,
      end: new Date(start.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 0, 'pre-window event not synced, got ' + replicas.length);
    itAssert(Boolean(itPairState(props, sourceId, destId).syncToken), 'baseline still ran');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testSpanningEvent({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const L = itLookbackDays();
    // Starts before the window but ends inside it. Events.list's timeMin filter
    // is end-time based, so the event must be returned and synced.
    const start = itDaysAgo(L + 1);
    const end = itDaysAgo(L - 1);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Spans Window',
      start: start,
      end: end
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 1, 'window-spanning event synced, got ' + replicas.length);
    itAssertTime(replicas[0].start, start.toISOString(), 'start preserved');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

// ---------------------------------------------------------------------------
// IT-05..IT-08: rules
// ---------------------------------------------------------------------------

function testRulesOrdering({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const rules = [
      { match: /\bVarsity\b/i, prefix: 'Abby: ', colorId: 5 },
      { match: /\bJV\b/i, prefix: 'Bob: ', colorId: 1 },
      { skip: true }
    ];
    const s = itDaysAhead(1);
    const mk = (i, summary) => itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: summary,
      start: new Date(s.getTime() + i * 3 * IT_HOUR),
      end: new Date(s.getTime() + i * 3 * IT_HOUR + IT_HOUR)
    });
    const varsity = mk(0, 'Varsity Game');
    const jv = mk(1, 'JV Game');
    const other = mk(2, 'Unrelated');
    fixtures.push(varsity, jv, other);

    itRunSync(props, sourceId, destId, rules);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 2, 'skip rule excluded one, got ' + replicas.length);
    const bySummary = {};
    for (const r of replicas) { bySummary[r.summary] = r; }
    const abby = bySummary['Abby: Varsity Game'];
    const bob = bySummary['Bob: JV Game'];
    itAssert(abby, 'first-match prefix for Varsity');
    itAssert(abby.colorId === '5', 'first-match color for Varsity');
    itAssert(bob, 'second-match prefix for JV');
    itAssert(bob.colorId === '1', 'second-match color for JV');
    itAssert(!bySummary['Unrelated'], 'catch-all skip applied');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testCatchAll({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const rules = [{ match: /\bSkip\b/i, skip: true }, { prefix: 'X: ' }];
    const s = itDaysAhead(1);
    const evKeep = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Standup',
      start: s,
      end: new Date(s.getTime() + IT_HOUR)
    });
    const evSkip = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Skip me',
      start: new Date(s.getTime() + 2 * IT_HOUR),
      end: new Date(s.getTime() + 3 * IT_HOUR)
    });
    fixtures.push(evKeep, evSkip);

    itRunSync(props, sourceId, destId, rules);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 1, 'catch-all applies, got ' + replicas.length);
    itAssert(replicas[0].summary === 'X: Standup', 'catch-all prefix applied');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testRuleChangeBaseline({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const s = itDaysAhead(1);
    const keep = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Keep this',
      start: s,
      end: new Date(s.getTime() + IT_HOUR)
    });
    const drop = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Drop me',
      start: new Date(s.getTime() + 2 * IT_HOUR),
      end: new Date(s.getTime() + 3 * IT_HOUR)
    });
    fixtures.push(keep, drop);

    itRunSync(props, sourceId, destId, [{ match: /Keep/i, prefix: 'K: ' }, { skip: true }]);
    let replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 1 && replicas[0].summary === 'K: Keep this', 'first config applied');
    const firstHash = itPairState(props, sourceId, destId).configHash;

    itRunSync(props, sourceId, destId, [{ skip: true }]);
    replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 0, 'orphan cleanup after rule change, got ' + replicas.length);
    const secondHash = itPairState(props, sourceId, destId).configHash;
    itAssert(secondHash && secondHash !== firstHash, 'config hash changed');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testNullSummary({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const s = itDaysAhead(1);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: null,
      start: s,
      end: new Date(s.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, [{ match: /\bVarsity\b/i, prefix: 'P: ' }]);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 1, 'null-summary event handled, got ' + replicas.length);
    itAssert((replicas[0].summary || '') === '', 'empty summary synced');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

// ---------------------------------------------------------------------------
// IT-09..IT-12, IT-18..IT-20: recurring events
// ---------------------------------------------------------------------------

function testRecurringMaster({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Weekly',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3']
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);

    const replicas = itListDestReplicas(destId, sourceId);
    itAssert(replicas.length === 1, 'master synced, got ' + replicas.length);
    const r = replicas[0];
    itAssert(r.id === _makeDestId(sourceId, ev.id), 'master dest id');
    itAssert(r.recurrence && r.recurrence[0] === 'RRULE:FREQ=DAILY;COUNT=3', 'recurrence copied');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testExceptionUpdate({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const master = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Series',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5']
    });
    fixtures.push(master);

    itRunSync(props, sourceId, destId, []);
    const masterId = _makeDestId(sourceId, master.id);

    const origStart = new Date(start.getTime() + 1 * IT_DAY);
    const newStart = new Date(origStart.getTime() + 2 * IT_HOUR);
    itReschedule(sourceId, master, origStart, newStart, 'Rescheduled');

    itRunSync(props, sourceId, destId, []);

    const inst = itGetEvent(destId, masterId + '_' + itFmtUTC(origStart));
    itAssert(inst && inst.status !== 'cancelled', 'exception materialized on dest');
    itAssert(inst.summary === 'Rescheduled', 'exception summary applied');
    itAssertTime(inst.start, newStart.toISOString(), 'exception time applied');
    itAssert(itGetEvent(destId, masterId)?.status === 'confirmed', 'master intact');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testExceptionCancel({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const master = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Series',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5']
    });
    fixtures.push(master);

    itRunSync(props, sourceId, destId, []);
    const masterId = _makeDestId(sourceId, master.id);

    const origStart = new Date(start.getTime() + 2 * IT_DAY);
    const srcInstanceId = master.id + '_' + itFmtUTC(origStart);
    const fetched = itCalEventsGet(sourceId, srcInstanceId);
    itCalEventsUpdate(Object.assign({}, fetched, { status: 'cancelled' }), sourceId, srcInstanceId);

    itRunSync(props, sourceId, destId, []);

    const destInst = itGetEvent(destId, masterId + '_' + itFmtUTC(origStart));
    itAssert(!destInst || destInst.status === 'cancelled',
      'cancelled exception removed on dest (status=' + (destInst && destInst.status) + ')');
    itAssert(itGetEvent(destId, masterId)?.status === 'confirmed', 'master survives instance cancel');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testExceptionBeforeMaster({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const master = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Series',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=5']
    });
    fixtures.push(master);

    itRunSync(props, sourceId, destId, []);
    const masterId = _makeDestId(sourceId, master.id);
    itAssert(itGetEvent(destId, masterId), 'master present after baseline');

    itCalEventsRemove(destId, masterId);

    const origStart = new Date(start.getTime() + 1 * IT_DAY);
    const newStart = new Date(origStart.getTime() + 2 * IT_HOUR);
    itReschedule(sourceId, master, origStart, newStart, 'After master lost');

    itRunSync(props, sourceId, destId, []);

    const inst = itGetEvent(destId, masterId + '_' + itFmtUTC(origStart));
    itAssert(inst && inst.status !== 'cancelled', 'exception applied after on-demand master sync');
    itAssert(inst.summary === 'After master lost', 'exception summary');
    const masterEv = itGetEvent(destId, masterId);
    itAssert(masterEv && masterEv.status === 'confirmed', 'on-demand master recreated');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testRecurringExceptionInWindowOnly({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const L = itLookbackDays();
    // A series whose unmodified occurrences all predate the lookback window,
    // pulled into view only by an exception rescheduled into the window. The
    // destination master must still appear (via window match or on-demand sync).
    const start = itDaysAgo(L + 3);
    const master = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Old Series',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3']
    });
    fixtures.push(master);

    const origStart = new Date(start.getTime() + 1 * IT_DAY);
    const newStart = itDaysAgo(L - 1);
    itReschedule(sourceId, master, origStart, newStart, 'In-window exception');

    itRunSync(props, sourceId, destId, []);

    const masterId = _makeDestId(sourceId, master.id);
    const masterEv = itGetEvent(destId, masterId);
    itAssert(masterEv && masterEv.status === 'confirmed', 'master pulled in despite pre-window series');
    const inst = itGetEvent(destId, masterId + '_' + itFmtUTC(origStart));
    itAssert(inst && inst.summary === 'In-window exception', 'exception materialized');
    itAssertTime(inst.start, newStart.toISOString(), 'exception at new time');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testIncrementalExceptionsBothSides({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const L = itLookbackDays();
    const start = itDaysAgo(L + 2);
    const master = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Long Series',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=' + (L + 6)]
    });
    fixtures.push(master);

    itRunSync(props, sourceId, destId, []);
    const masterId = _makeDestId(sourceId, master.id);
    itAssert(itGetEvent(destId, masterId), 'master on dest after baseline');

    const i0Orig = new Date(start.getTime());
    const i0New = new Date(i0Orig.getTime() + 2 * IT_HOUR);
    itReschedule(sourceId, master, i0Orig, i0New, 'Early exception');

    const midOrig = new Date(start.getTime() + (L + 4) * IT_DAY);
    const midNew = new Date(midOrig.getTime() + 2 * IT_HOUR);
    itReschedule(sourceId, master, midOrig, midNew, 'Late exception');

    itRunSync(props, sourceId, destId, []);

    const early = itGetEvent(destId, masterId + '_' + itFmtUTC(i0Orig));
    itAssert(early && early.summary === 'Early exception', 'pre-window exception pulled in');
    itAssertTime(early.start, i0New.toISOString(), 'pre-window exception time');
    const late = itGetEvent(destId, masterId + '_' + itFmtUTC(midOrig));
    itAssert(late && late.summary === 'Late exception', 'post-window exception pulled in');
    itAssertTime(late.start, midNew.toISOString(), 'post-window exception time');
    itAssert(itGetEvent(destId, masterId)?.status === 'confirmed', 'master intact');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testMasterDeletedDuringIncremental({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const start = itDaysAhead(1);
    const master = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Series',
      start: start,
      end: new Date(start.getTime() + IT_HOUR),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=4']
    });
    fixtures.push(master);

    itRunSync(props, sourceId, destId, []);
    const masterId = _makeDestId(sourceId, master.id);
    itAssert(itGetEvent(destId, masterId), 'master present');

    const beforeOps = calOpsSnapshot(destId);
    itCalEventsRemove(sourceId, master.id);
    itRunSync(props, sourceId, destId, []);

    const masterEv = itGetEvent(destId, masterId);
    itAssert(!masterEv || masterEv.status === 'cancelled', 'dest master removed/cancelled');
    const ops = calOpsSince(destId, beforeOps);
    itAssert(ops.removed >= 1, 'master removed, got ' + ops.removed);
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

// ---------------------------------------------------------------------------
// IT-13..IT-15: safety and state
// ---------------------------------------------------------------------------

function testLoopGuard({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const s = itDaysAhead(1);
    const replica = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Already a replica',
      start: s,
      end: new Date(s.getTime() + IT_HOUR),
      extendedProperties: { private: { sourceCalendarId: sourceId, sourceEventId: 'zzz' } }
    });
    fixtures.push(replica);

    const beforeOps = calOpsSnapshot(destId);
    itRunSync(props, sourceId, destId, []);

    const ops = calOpsSince(destId, beforeOps);
    itAssert(ops.added === 0 && ops.updated === 0, 'no writes for replica-tagged source event');
    itAssert(itListDestReplicas(destId, sourceId).length === 0, 'no replica created');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testRemovedMappingAndReadd({ sourceId, destId, props }) {
  const fixtures = [];
  try {
    const s = itDaysAhead(1);
    const ev = itCreateEvent(sourceId, {
      id: itNextEventId(),
      summary: 'Re-add me',
      start: s,
      end: new Date(s.getTime() + IT_HOUR)
    });
    fixtures.push(ev);

    itRunSync(props, sourceId, destId, []);
    const key = sourceId + '::' + destId;
    itAssert(Boolean(itPairState(props, sourceId, destId).syncToken), 'state established');

    props.syncTime[key] = Date.now() - (STATE_RECLAIM_DAYS + 1) * IT_DAY;
    mainLoop(props, [], [key]);
    const st2 = itPairState(props, sourceId, destId);
    itAssert(st2.syncToken === undefined && st2.configHash === undefined, 'state dismissed');

    itAssert(itListDestReplicas(destId, sourceId).length === 1, 'replicas left behind after dismissal');

    itRunSync(props, sourceId, destId, []);
    const st3 = itPairState(props, sourceId, destId);
    itAssert(Boolean(st3.syncToken) && Boolean(st3.configHash), 'state re-established on re-add');
    itAssert(itListDestReplicas(destId, sourceId).length === 1, 'replica re-synced, no duplicate');
  } finally {
    itTearDown(sourceId, destId, fixtures);
  }
}

function testPersistenceRoundTrip({ sourceId, destId }) {
  const key = sourceId + '::' + destId;
  try {
    const p1 = GCS.Config.ScriptProperties.load();
    p1.update(key, { syncToken: 'tok123', configHash: 'hash456', syncTime: 123456789 });
    GCS.Config.ScriptProperties.store(p1);

    const p2 = GCS.Config.ScriptProperties.load();
    itAssert(p2.syncToken[key] === 'tok123', 'syncToken persisted');
    itAssert(p2.configHash[key] === 'hash456', 'configHash persisted');
    itAssert(p2.syncTime[key] === 123456789, 'syncTime persisted');
  } finally {
    const p3 = GCS.Config.ScriptProperties.load();
    p3.clear(key);
    GCS.Config.ScriptProperties.store(p3);
  }
}

// ---------------------------------------------------------------------------
// group runners
// ---------------------------------------------------------------------------

function _runCoreSyncTests() {
  const { sourceId, destId } = itProvisionCalendars();
  itSweepSourceFixtures(sourceId);
  itCleanupPair(destId, sourceId);
  itTest('IT-01 insert', () => testInsert(itCtx(sourceId, destId)));
  itTest('IT-02 update in place', () => testUpdate(itCtx(sourceId, destId)));
  itTest('IT-03 delete', () => testDelete(itCtx(sourceId, destId)));
  itTest('IT-04 baseline then incremental', () => testBaselineThenIncremental(itCtx(sourceId, destId)));
  itTest('IT-16 pre-lookback event not synced', () => testPreLookbackEvent(itCtx(sourceId, destId)));
  itTest('IT-17 window-spanning event synced', () => testSpanningEvent(itCtx(sourceId, destId)));
}

function _runRulesTests() {
  const { sourceId, destId } = itProvisionCalendars();
  itSweepSourceFixtures(sourceId);
  itCleanupPair(destId, sourceId);
  itTest('IT-05 rule ordering, prefix, color', () => testRulesOrdering(itCtx(sourceId, destId)));
  itTest('IT-06 catch-all rule', () => testCatchAll(itCtx(sourceId, destId)));
  itTest('IT-07 rule change -> baseline + orphan cleanup', () => testRuleChangeBaseline(itCtx(sourceId, destId)));
  itTest('IT-08 null summary', () => testNullSummary(itCtx(sourceId, destId)));
}

function _runRecurringTests() {
  const { sourceId, destId } = itProvisionCalendars();
  itSweepSourceFixtures(sourceId);
  itCleanupPair(destId, sourceId);
  itTest('IT-09 recurring master', () => testRecurringMaster(itCtx(sourceId, destId)));
  itTest('IT-10 exception update', () => testExceptionUpdate(itCtx(sourceId, destId)));
  itTest('IT-11 exception cancel', () => testExceptionCancel(itCtx(sourceId, destId)));
  itTest('IT-12 exception before master (on-demand)', () => testExceptionBeforeMaster(itCtx(sourceId, destId)));
  itTest('IT-18 series visible only via in-window exception', () => testRecurringExceptionInWindowOnly(itCtx(sourceId, destId)));
  itTest('IT-19 incremental exceptions on both sides of lookback', () => testIncrementalExceptionsBothSides(itCtx(sourceId, destId)));
  itTest('IT-20 master deleted during incremental', () => testMasterDeletedDuringIncremental(itCtx(sourceId, destId)));
}

function _runStateAndSafetyTests() {
  const { sourceId, destId } = itProvisionCalendars();
  itSweepSourceFixtures(sourceId);
  itCleanupPair(destId, sourceId);
  itTest('IT-13 loop guard', () => testLoopGuard(itCtx(sourceId, destId)));
  itTest('IT-14 removed mapping dismissal + re-add', () => testRemovedMappingAndReadd(itCtx(sourceId, destId)));
  itTest('IT-15 properties persistence round-trip', () => testPersistenceRoundTrip({ sourceId, destId }));
}

// ---------------------------------------------------------------------------
// documented entry point — run from IDE or via clasp
// ---------------------------------------------------------------------------

function runIntegrationTests() {
  const suites = (typeof TEST_SUITES !== 'undefined') ? TEST_SUITES : {};
  const t0 = Date.now();
  itFailures = 0;
  console.log('================ IntegrationTests @ ' + new Date().toISOString() + ' ================');
  try {
    if (suites.coreSync !== false)      _runCoreSyncTests();
    if (suites.rules !== false)         _runRulesTests();
    if (suites.recurring !== false)     _runRecurringTests();
    if (suites.stateAndSafety !== false) _runStateAndSafetyTests();
  } finally {
    const { sourceId, destId } = itProvisionCalendars();
    itSweepSourceFixtures(sourceId);
    itCleanupPair(destId, sourceId);
    console.log('==== done in ' + (Date.now() - t0) + 'ms; failures=' + itFailures + ' ====');
  }
  if (itFailures > 0) {
    throw new Error(itFailures + ' integration test(s) failed');
  }
}
