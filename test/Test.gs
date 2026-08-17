/**
 * Test.gs — standalone interrogation of the Google Calendar Events API per se.
 *
 * This is NOT a test suite for this script's responsibilities.  It validates
 * raw Calendar API behaviors (insert/update/remove semantics, error codes,
 * instance addressing) that earlier sessions used to design the sync engine.
 * Kept as a reference and for re-validation against API changes.
 *
 * This file deliberately uses NO code from this project.  It exists to prove
 * or disprove, against the real API, behaviors this project either relies on
 * or has speculated about — none of which is fully settled by the docs.
 *
 * LOGGING CONTRACT
 *   Every probe logs three lines:
 *     doing:     the exact API call being attempted
 *     expecting: the hypothesized / documented outcome under test
 *     got:       what actually happened (result summary, or error summary)
 *   When an exception is thrown, the WHOLE exception object is additionally
 *   logged as JSON.stringify(exception, null, 2).
 *
 * Hypotheses under test:
 *   H1  Instances of a recurring event are addressable as <masterId>_<timestamp>
 *       even while still derived (not yet materialized as exceptions).
 *   H2  Calendar.Events.update() on a derived instance id materializes the
 *       exception, and a status=cancelled update cancels it.
 *   H3  Remove/cancel semantics: removing a pristine derived instance hides it;
 *       an already-cancelled instance can be removed; a cancelled instance can
 *       be resurrected via update.
 *   H4  Calendar.Events.insert() rejects caller-supplied instance-style ids
 *       (<masterId>_<timestamp>; underscores violate the base32hex charset)
 *       but accepts valid base32hex custom ids.
 *   H5  Inserting with recurringEventId + originalStartTime (no id) creates an
 *       exception — the "insert an exception" mechanism used by some tooling.
 *   H6  Not-found errors are 404 ("Not Found") or 410 ("Resource has been
 *       deleted"); error filters must tolerate both, including after removing a
 *       master (does it cascade to instances?).
 *   H7  Events.list(singleEvents=false) still returns exception instances as
 *       separate items (the working engine splits them out of the page).
 *   H8  Read-only fields (recurringEventId) are ignored, not rejected, on update.
 *
 * REQUIRED SETUP
 *   - Apps Script project, V8 runtime, with the "Calendar API" advanced service
 *     enabled (Editor > left pane "Services" > "+" > Calendar API).
 *   - Run the function `runAllTests()` and read the log (View > Logs).
 *   - Uses the signed-in user's primary calendar unless TEST_CALENDAR_ID is set.
 *
 * FIXTURE (created once per run, removed at teardown)
 *   One recurring event:
 *     summary  "TEST EVENT <first-instance-utc-timestamp>"
 *     id       test<epoch-ms>      (base32hex-safe: no underscores)
 *     start    09:00 UTC today, 30 min, recurrence RRULE:FREQ=DAILY;COUNT=8
 *   Eight instances i0..i7 give spare events for the destructive probes
 *   (materialize, cancel, remove, resurrect) while leaving a control.
 *
 * Instance addresses are <masterId>_<YYYYMMDDTHHMMSSZ> of each occurrence's
 * original start in UTC.
 *
 * Artifacts are removed at teardown (master + standalone inserts).  Set
 * KEEP_FIXTURE=true to leave them behind for manual inspection.
 */

const TEST_CALENDAR_ID = null;        // override to pin a specific calendar
const KEEP_FIXTURE = false;
const INSTANCE_COUNT = 8;
const START_HOUR_UTC = 9;
const DURATION_MIN = 30;
const ZULU = "yyyyMMdd'T'HHmmss'Z'";

let testCalendarId = null;
let master = null;                    // fixture master event (as inserted)
let masterStart = null;               // Date of the first instance
const insertedStandalone = [];        // events created by the insert probes

// ---------------------------------------------------------------------------
// helpers (Apps Script built-ins only)
// ---------------------------------------------------------------------------

function fmtUTC(d) {
  return Utilities.formatDate(d, 'UTC', ZULU);
}

function startOfInstance(i) {
  const d = new Date(masterStart.getTime());
  d.setUTCDate(d.getUTCDate() + i);
  return d;
}

function startObj(i) {
  return { dateTime: startOfInstance(i).toISOString(), timeZone: 'UTC' };
}

function endObj(i) {
  const d = startOfInstance(i);
  d.setTime(d.getTime() + DURATION_MIN * 60000);
  return { dateTime: d.toISOString(), timeZone: 'UTC' };
}

function instanceId(i) {
  return master.id + '_' + fmtUTC(startOfInstance(i));
}

function summarize(ev) {
  if (!ev) return '(null)';
  const out = {};
  for (const k of ['id', 'status', 'summary', 'recurringEventId', 'recurrence',
                   'iCalUID', 'etag', 'start', 'end', 'originalStartTime']) {
    if (ev[k] !== undefined) out[k] = ev[k];
  }
  return JSON.stringify(out);
}

function errCode(e) {
  return e && e.details ? e.details.code : null;
}

function describeError(e) {
  if (!e) return 'unknown';
  let s = String(e.name || 'Error') + ': ' + String(e.message || e);
  const d = e.details;
  if (d) {
    s += ' [code=' + d.code;
    if (d.errors && d.errors.length) {
      const er = d.errors[0];
      s += ' reason=' + er.reason + ' at ' + (er.location || '?');
    }
    s += ']';
  }
  return s;
}

// Full JSON snapshot of an exception.  Error properties are usually
// non-enumerable, so we rebuild an own-property object to stringify.
// Hardened so that a pathological exception can never prevent the dump.
function stringifyError(e) {
  if (!e) return 'null';
  try {
    const snapshot = { name: e.name, message: e.message };
    if (e.details !== undefined) snapshot.details = e.details;
    if (e.stack !== undefined) snapshot.stack = e.stack;
    for (const k of Object.keys(e)) {
      if (!(k in snapshot)) snapshot[k] = e[k];
    }
    return JSON.stringify(snapshot, null, 2);
  } catch (ex) {
    return '(stringifyError failed: ' + ex + ') name=' + e.name + ' message=' + e.message;
  }
}

function probe(doing, expecting, fn, fmt) {
  Logger.log('  doing:     ' + doing);
  Logger.log('  expecting: ' + expecting);
  const format = fmt || summarize;
  try {
    const res = fn();
    Logger.log('  got:       OK  ' + format(res));
    return { ok: true, res: res, code: null };
  } catch (e) {
    // Every exception is logged in full here — EXPECTED ones included.  A
    // probe's expectation line may predict the error, and the test's verdict
    // line may call it PASS, but neither may suppress this dump.
    Logger.log('  got:       ERR ' + describeError(e));
    Logger.log('  exception: ' + stringifyError(e));
    return { ok: false, err: e, code: errCode(e) };
  }
}

function test(title, fn) {
  Logger.log('');
  Logger.log('==== ' + title + ' ====');
  try { fn(); } catch (e) {
    Logger.log('  UNEXPECTED EXCEPTION: ' + describeError(e));
    Logger.log('  exception: ' + stringifyError(e));
  }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function setupFixture() {
  testCalendarId = TEST_CALENDAR_ID || CalendarApp.getDefaultCalendar().getId();
  Logger.log('Test calendar: ' + testCalendarId);

  // Clean up a stale fixture left by a previously aborted run.
  const props = PropertiesService.getScriptProperties();
  const stale = props.getProperty('TEST_MASTER_ID');
  if (stale) {
    Logger.log('Removing stale fixture from a previous run: ' + stale);
    probe('Calendar.Events.remove(' + testCalendarId + ', ' + stale + ')',
      'no exception (best-effort cleanup of a stale run)',
      () => Calendar.Events.remove(testCalendarId, stale));
    props.deleteProperty('TEST_MASTER_ID');
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
                                  now.getUTCDate(), START_HOUR_UTC, 0, 0, 0));
  const end = new Date(start.getTime() + DURATION_MIN * 60000);
  const customId = 'test' + String(Date.now());

  const resource = {
    id: customId,
    summary: 'TEST EVENT ' + fmtUTC(start),
    start: { dateTime: start.toISOString(), timeZone: 'UTC' },
    end: { dateTime: end.toISOString(), timeZone: 'UTC' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=' + INSTANCE_COUNT],
    description: 'Empirical API fixture (Test.gs); safe to delete.'
  };

  const r = probe('Calendar.Events.insert(fixture, ' + testCalendarId + ')',
    'succeeds; master id echoed back with recurrence array',
    () => Calendar.Events.insert(resource, testCalendarId));
  if (!r.ok) {
    Logger.log('ABORT: could not create fixture (' + describeError(r.err) + ')');
    master = null;
    return;
  }

  master = r.res;
  props.setProperty('TEST_MASTER_ID', master.id);
  masterStart = new Date(master.start.dateTime);
  Logger.log('Fixture master id:    ' + master.id);
  Logger.log('First instance start: ' + master.start.dateTime);
  for (let i = 0; i < INSTANCE_COUNT; i++) {
    Logger.log('  i' + i + '  ' + fmtUTC(startOfInstance(i)) + '  address: ' + instanceId(i));
  }
}

// ---------------------------------------------------------------------------
// 1. addressing and error codes
// ---------------------------------------------------------------------------

function runAddressingTests() {
  test('1. Remove a nonexistent event id', () => {
    const id = 'zzz_no_such_event_20260101T000000Z';
    const r = probe('Calendar.Events.remove(' + testCalendarId + ', ' + id + ')',
      '404 (Not Found) or 410 (Resource has been deleted) — the project must tolerate both (H6)',
      () => Calendar.Events.remove(testCalendarId, id));
    Logger.log('  verdict: code ' + r.code + ' ' + ((r.code === 404 || r.code === 410) ? 'PASS' : (r.ok ? 'FAIL (unexpected success)' : 'FAIL')));
  });

  test('2. Get a valid derived instance (never materialized)', () => {
    for (const i of [0, 7]) {
      const id = instanceId(i);
      const r = probe('Calendar.Events.get(' + testCalendarId + ', ' + id + ')',
        'resolves to the instance — derived instances are addressable by <masterId>_<timestamp> (H1)',
        () => Calendar.Events.get(testCalendarId, id));
      Logger.log('  verdict: i' + i + ' addressable = ' + (r.ok ? 'YES' : 'NO (code ' + r.code + ')'));
    }
  });

  test('3. Get invalid instances', () => {
    probe('Calendar.Events.get(' + testCalendarId + ', ' + master.id + '_20000101T090000Z)',
      '404 Not Found (valid format, but no such occurrence)',
      () => Calendar.Events.get(testCalendarId, master.id + '_20000101T090000Z'));
    probe('Calendar.Events.get(' + testCalendarId + ', ' + master.id + '_garbage)',
      '404 Not Found (malformed suffix)',
      () => Calendar.Events.get(testCalendarId, master.id + '_garbage'));
    probe('Calendar.Events.get(' + testCalendarId + ', ' + master.id + '_' + fmtUTC(new Date(startOfInstance(1).getTime() + 3600000)) + ')',
      '404 Not Found (day-1 occurrence at 10:00 does not exist; instance at 09:00)',
      () => Calendar.Events.get(testCalendarId, master.id + '_' + fmtUTC(new Date(startOfInstance(1).getTime() + 3600000))));
  });
}

// ---------------------------------------------------------------------------
// 2. update semantics
// ---------------------------------------------------------------------------

function runUpdateTests() {
  test('4. Update an id of a nonexistent master', () => {
    const id = 'zzz_nonexistentmaster_20260101T090000Z';
    const body = { summary: 'phantom', start: startObj(0), end: endObj(0) };
    const r = probe('Calendar.Events.update(' + JSON.stringify(body) + ', ' + testCalendarId + ', ' + id + ')',
      '404 Not Found (no such master, so no such instance)',
      () => Calendar.Events.update(body, testCalendarId, id));
    Logger.log('  verdict: update on nonexistent master -> ' + (r.ok ? 'ok (unexpected)' : 'code ' + r.code));
  });

  test('5. Materialize a derived instance via update — engine-style body WITHOUT recurringEventId/originalStartTime', () => {
    const body = {
      summary: 'materialized via update (i1)',
      description: 'H2 probe: created purely by update on the computed instance id',
      start: startObj(1),
      end: endObj(1)
    };
    const r = probe('Calendar.Events.update(' + JSON.stringify(body) + ', ' + testCalendarId + ', ' + instanceId(1) + ')',
      'succeeds and materializes i1 as an exception (H2)',
      () => Calendar.Events.update(body, testCalendarId, instanceId(1)));
    Logger.log('  verdict: materialize-by-update = ' + (r.ok ? 'SUPPORTED' : 'NOT (code ' + r.code + ')'));
    if (r.ok) {
      const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(1) + ')',
        'now returns an exception: recurringEventId === master id, originalStartTime set, status confirmed',
        () => Calendar.Events.get(testCalendarId, instanceId(1)));
      if (g.ok) {
        Logger.log('  i1 recurringEventId:  ' + g.res.recurringEventId);
        Logger.log('  i1 originalStartTime: ' + JSON.stringify(g.res.originalStartTime));
        Logger.log('  i1 status:            ' + g.res.status);
      }
    }
  });

  test('6. Cancel a derived instance via update — fetch-then-update, documented flow', () => {
    const f = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(2) + ')',
      'succeeds (i2 derived instance is addressable)',
      () => Calendar.Events.get(testCalendarId, instanceId(2)));
    if (!f.ok) { Logger.log('  cannot run: i2 not addressable'); return; }
    const body = Object.assign({}, f.res, { status: 'cancelled' });
    const r = probe('Calendar.Events.update(' + JSON.stringify(body) + ', ' + testCalendarId + ', ' + instanceId(2) + ')',
      'succeeds; i2 is cancelled (H2)',
      () => Calendar.Events.update(body, testCalendarId, instanceId(2)));
    Logger.log('  verdict: cancel-by-update = ' + (r.ok ? 'SUPPORTED' : 'NOT (code ' + r.code + ')'));
    if (r.ok) {
      const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(2) + ')',
        'returns i2 with status === "cancelled"',
        () => Calendar.Events.get(testCalendarId, instanceId(2)));
      if (g.ok) Logger.log('  i2 after cancel: ' + summarize(g.res));
    }
  });

  test('7. Update with a body containing ONLY status — is update a full PUT or partial?', () => {
    const body = { status: 'cancelled' };
    const r = probe('Calendar.Events.update(' + JSON.stringify(body) + ', ' + testCalendarId + ', ' + instanceId(5) + ')',
      'unknown — probe. If accepted, subsequent GET shows whether start/end were wiped (full PUT) or kept (partial)',
      () => Calendar.Events.update(body, testCalendarId, instanceId(5)));
    if (r.ok) {
      const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(5) + ')',
        'i5 with status "cancelled"; start/end present only if update is partial',
        () => Calendar.Events.get(testCalendarId, instanceId(5)));
      if (g.ok) Logger.log('  i5 now: ' + summarize(g.res));
    }
    Logger.log('  verdict: status-only update ' + (r.ok ? 'ACCEPTED (see fields above)' : 'rejected code ' + r.code));
  });

  test('7b. Minimal cancel body — full-PUT floor, with and without id', () => {
    const withId = {
      id:     instanceId(6),
      start:  startObj(6),
      end:    endObj(6),
      status: 'cancelled'
    };
    const r1 = probe('Calendar.Events.update(' + JSON.stringify(withId) + ', ' + testCalendarId + ', ' + instanceId(6) + ')',
      'succeeds; i6 cancelled (minimal body with id: id + start + end + status)',
      () => Calendar.Events.update(withId, testCalendarId, instanceId(6)));
    Logger.log('  verdict: minimal-with-id ' + (r1.ok ? 'ACCEPTED' : 'rejected code ' + r1.code));
    if (r1.ok) {
      const g1 = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(6) + ')',
        'i6 with status "cancelled"; start/end intact, no other fields wiped',
        () => Calendar.Events.get(testCalendarId, instanceId(6)));
      if (g1.ok) Logger.log('  i6 now: ' + summarize(g1.res));
    }

    const noId = {
      start:  startObj(7),
      end:    endObj(7),
      status: 'cancelled'
    };
    const r2 = probe('Calendar.Events.update(' + JSON.stringify(noId) + ', ' + testCalendarId + ', ' + instanceId(7) + ')',
      'succeeds; i7 cancelled (minimal body WITHOUT id and WITHOUT summary)',
      () => Calendar.Events.update(noId, testCalendarId, instanceId(7)));
    Logger.log('  verdict: minimal-without-id ' + (r2.ok ? 'ACCEPTED (id and summary optional)' : 'rejected code ' + r2.code));
    if (r2.ok) {
      const g2 = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(7) + ')',
        'i7 with status "cancelled"; start/end intact',
        () => Calendar.Events.get(testCalendarId, instanceId(7)));
      if (g2.ok) Logger.log('  i7 now: ' + summarize(g2.res));
    }
  });

  test('8. Resurrect a cancelled instance — update back to confirmed', () => {
    const f = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(4) + ')',
      'succeeds (i4 derived instance is addressable)',
      () => Calendar.Events.get(testCalendarId, instanceId(4)));
    if (!f.ok) { Logger.log('  cannot run: i4 not addressable'); return; }
    probe('Calendar.Events.update(' + JSON.stringify(Object.assign({}, f.res, { status: 'cancelled' })) + ', ' + testCalendarId + ', ' + instanceId(4) + ')',
      'succeeds; i4 cancelled (setup for the resurrect probe)',
      () => Calendar.Events.update(Object.assign({}, f.res, { status: 'cancelled' }), testCalendarId, instanceId(4)));
    const r = probe('Calendar.Events.update(' + JSON.stringify(Object.assign({}, f.res, { status: 'confirmed' })) + ', ' + testCalendarId + ', ' + instanceId(4) + ')',
      'succeeds; i4 returns to status "confirmed" (H3)',
      () => Calendar.Events.update(Object.assign({}, f.res, { status: 'confirmed' }), testCalendarId, instanceId(4)));
    const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(4) + ')',
      'i4 with status "confirmed"',
      () => Calendar.Events.get(testCalendarId, instanceId(4)));
    if (g.ok) Logger.log('  i4 status after resurrect: ' + g.res.status);
    Logger.log('  verdict: un-cancel via update = ' + (r.ok ? 'SUPPORTED' : 'NOT (code ' + r.code + ')'));
  });

  test('9. Remove a pristine derived instance (i3) — does it hide/cancel it?', () => {
    const r = probe('Calendar.Events.remove(' + testCalendarId + ', ' + instanceId(3) + ')',
      'succeeds; the instance is then hidden (H3)',
      () => Calendar.Events.remove(testCalendarId, instanceId(3)));
    Logger.log('  remove returned: ' + (r.ok ? 'ok' : 'code ' + r.code));
    const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(3) + ')',
      '404/410 (removed), or a cancelled instance',
      () => Calendar.Events.get(testCalendarId, instanceId(3)));
    Logger.log('  verdict: pristine instance after remove = ' + (g.ok ? 'STILL PRESENT: ' + summarize(g.res) : 'GONE (code ' + g.code + ')'));
  });

  test('10. Remove an already-cancelled instance (i2)', () => {
    const r = probe('Calendar.Events.remove(' + testCalendarId + ', ' + instanceId(2) + ')',
      'success, or a tolerated 404/410 — remove must be idempotent (H6)',
      () => Calendar.Events.remove(testCalendarId, instanceId(2)));
    Logger.log('  verdict: remove on cancelled instance -> ' + (r.ok ? 'ok' : 'code ' + r.code));
    const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(2) + ')',
      '404/410 or cancelled instance',
      () => Calendar.Events.get(testCalendarId, instanceId(2)));
    if (g.ok) Logger.log('  i2 still present: ' + summarize(g.res));
  });

  test('11. Read-only field enforcement — update with a bogus recurringEventId', () => {
    const body = {
      summary: 'bogus recurringEventId probe',
      start: startObj(1),
      end: endObj(1),
      recurringEventId: 'zzz_other_master'
    };
    const r = probe('Calendar.Events.update(' + JSON.stringify(body) + ', ' + testCalendarId + ', ' + instanceId(1) + ')',
      'accepted and recurringEventId ignored (read-only not enforced on update) (H8)',
      () => Calendar.Events.update(body, testCalendarId, instanceId(1)));
    Logger.log('  verdict: read-only recurringEventId ' + (r.ok ? 'IGNORED (accepted)' : 'REJECTED (code ' + r.code + ')'));
  });
}

// ---------------------------------------------------------------------------
// 3. list / instances (run before the insert probes so counts stay clean)
// ---------------------------------------------------------------------------

function runListTests() {
  const timeMin = startOfInstance(0).toISOString();
  const timeMax = startOfInstance(INSTANCE_COUNT).toISOString(); // 1 day past last instance

  test('18. Events.list(singleEvents=false) — exceptions as separate items?', () => {
    const r = probe('Calendar.Events.list(' + testCalendarId + ', {timeMin, timeMax, singleEvents: false})',
      'response includes exception instances (items with recurringEventId) alongside the master (H7)',
      () => Calendar.Events.list(testCalendarId, { timeMin: timeMin, timeMax: timeMax, singleEvents: false, maxResults: 250 }),
      res => { const it = res.items || []; return 'items=' + it.length + ' (exceptions=' + it.filter(ev => ev.recurringEventId).length + ')'; });
    if (r.ok) {
      const exc = (r.res.items || []).filter(ev => ev.recurringEventId);
      for (const e of exc) Logger.log('    exception item: ' + summarize(e));
      Logger.log('  verdict: exceptions with singleEvents=false = ' + (exc.length ? 'YES' : 'NO'));
    }
  });

  test('19. Events.list(singleEvents=true) — expanded instance count', () => {
    const r = probe('Calendar.Events.list(' + testCalendarId + ', {timeMin, timeMax, singleEvents: true})',
      'expanded instances for the fixture: ' + INSTANCE_COUNT + ' (one per day; cancelled ones still listed)',
      () => Calendar.Events.list(testCalendarId, { timeMin: timeMin, timeMax: timeMax, singleEvents: true, maxResults: 250 }),
      res => 'instances=' + (res.items || []).length);
    if (r.ok) {
      const items = r.res.items || [];
      Logger.log('  verdict: expanded instances = ' + items.length + ' (fixture = ' + INSTANCE_COUNT + ')');
      for (const e of items) Logger.log('    ' + e.status + '  ' + summarize(e));
    }
  });

  test('20. Events.instances(master) — status of every instance', () => {
    const r = probe('Calendar.Events.instances(' + testCalendarId + ', ' + master.id + ', {timeMin, timeMax})',
      'lists all ' + INSTANCE_COUNT + ' instances, including cancelled/removed ones',
      () => Calendar.Events.instances(testCalendarId, master.id, { timeMin: timeMin, timeMax: timeMax, maxResults: 250 }),
      res => 'instances=' + (res.items || []).length);
    if (r.ok) {
      for (const e of (r.res.items || [])) Logger.log('    ' + e.status + '  ' + summarize(e));
    }
  });
}

// ---------------------------------------------------------------------------
// 4. insert semantics
// ---------------------------------------------------------------------------

function runInsertTests() {
  test('12. Insert with a caller-supplied id containing an underscore', () => {
    const body = { summary: 'underscore-id probe', start: startObj(0), end: endObj(0), id: 'test_bad_id' };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(body) + ', ' + testCalendarId + ')',
      '400 Invalid ID — caller-supplied ids are base32hex, underscores forbidden (H4)',
      () => Calendar.Events.insert(body, testCalendarId));
    if (r.ok) insertedStandalone.push(r.res.id);
    Logger.log('  verdict: underscore id ' + (r.ok ? 'ACCEPTED?!' : 'rejected code ' + r.code + ' (expected 400)'));
  });

  test('13. Insert with a valid base32hex custom id (control)', () => {
    const id = 'test' + String(Date.now());
    const body = { summary: 'valid-id probe', start: startObj(0), end: endObj(0), id: id };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(body) + ', ' + testCalendarId + ')',
      'accepted; created event echoes id back (control for test 12) (H4)',
      () => Calendar.Events.insert(body, testCalendarId));
    if (r.ok) insertedStandalone.push(r.res.id);
    Logger.log('  verdict: valid custom id ' + (r.ok ? 'ACCEPTED' : 'rejected code ' + r.code));
  });

  test('13b. Insert with the same id as an existing event', () => {
    const id = 'test' + String(Date.now());
    const first = { summary: 'dup-id probe (first)', start: startObj(0), end: endObj(0), id: id };
    const r1 = probe('Calendar.Events.insert(' + JSON.stringify(first) + ', ' + testCalendarId + ')',
      'succeeds; creates the event that the duplicate insert will collide with',
      () => Calendar.Events.insert(first, testCalendarId));
    if (r1.ok) insertedStandalone.push(r1.res.id);
    const second = { summary: 'dup-id probe (second)', start: startObj(1), end: endObj(1), id: id };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(second) + ', ' + testCalendarId + ')',
      '409 Conflict (or 400) — a second event with an id that already exists is rejected',
      () => Calendar.Events.insert(second, testCalendarId));
    if (r.ok) insertedStandalone.push(r.res.id);
    Logger.log('  verdict: duplicate-id insert -> ' + (r.ok ? 'ACCEPTED?! two events share an id' : 'rejected code ' + r.code));
  });

  test('14. Insert an exception via recurringEventId + originalStartTime, no id', () => {
    const body = {
      summary: 'exception inserted via insert (i0)',
      start: startObj(0),
      end: endObj(0),
      recurringEventId: master.id,
      originalStartTime: { dateTime: startOfInstance(0).toISOString(), timeZone: 'UTC' }
    };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(body) + ', ' + testCalendarId + ')',
      'succeeds and creates/replaces an exception for i0 (H5)',
      () => Calendar.Events.insert(body, testCalendarId));
    if (r.ok) {
      insertedStandalone.push(r.res.id);
      Logger.log('  created: ' + summarize(r.res));
      const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(0) + ')',
        'i0 address resolves to the inserted exception (id may differ)',
        () => Calendar.Events.get(testCalendarId, instanceId(0)));
      if (g.ok) Logger.log('  i0 address now: ' + summarize(g.res));
    }
    Logger.log('  verdict: insert-exception = ' + (r.ok ? 'SUPPORTED' : 'NOT (code ' + r.code + ')'));
  });

  test('15. Insert a CANCELLED exception via recurringEventId + originalStartTime, no id', () => {
    const body = {
      summary: 'cancelled exception via insert (i6)',
      start: startObj(6),
      end: endObj(6),
      recurringEventId: master.id,
      originalStartTime: { dateTime: startOfInstance(6).toISOString(), timeZone: 'UTC' },
      status: 'cancelled'
    };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(body) + ', ' + testCalendarId + ')',
      'unknown — determines whether a cancelled exception can be INSERTED, or only updated',
      () => Calendar.Events.insert(body, testCalendarId));
    if (r.ok) { insertedStandalone.push(r.res.id); Logger.log('  created: ' + summarize(r.res)); }
    Logger.log('  verdict: cancelled-exception-insert = ' + (r.ok ? 'SUPPORTED' : 'NOT (code ' + r.code + ')'));
  });

  test('16. Insert with an instance-style id, valid timestamp, status=cancelled', () => {
    const id = instanceId(7);
    const body = { summary: 'instance-style id probe', start: startObj(0), end: endObj(0), id: id, status: 'cancelled' };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(body) + ', ' + testCalendarId + ')',
      '400 Invalid ID — instance-style ids contain underscores and cannot be inserted (H4)',
      () => Calendar.Events.insert(body, testCalendarId));
    if (r.ok) insertedStandalone.push(r.res.id);
    Logger.log('  verdict: instance-style insert (valid) = ' + (r.ok ? 'ACCEPTED?!' : 'rejected code ' + r.code + ' (expected 400)'));
  });

  test('17. Insert with an instance-style id, invalid timestamp', () => {
    const id = master.id + '_20000101T090000Z';
    const body = { summary: 'invalid instance-style id probe', start: startObj(0), end: endObj(0), id: id, status: 'cancelled' };
    const r = probe('Calendar.Events.insert(' + JSON.stringify(body) + ', ' + testCalendarId + ')',
      '400 Invalid ID (underscore, and not a real occurrence) (H4)',
      () => Calendar.Events.insert(body, testCalendarId));
    if (r.ok) insertedStandalone.push(r.res.id);
    Logger.log('  verdict: instance-style insert (invalid) = ' + (r.ok ? 'ACCEPTED?!' : 'rejected code ' + r.code + ' (expected 400)'));
  });
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

function teardown() {
  if (KEEP_FIXTURE) {
    Logger.log('KEEP_FIXTURE=true: leaving fixture master ' + (master && master.id)
      + ' and ' + insertedStandalone.length + ' standalone event(s) for inspection.');
    return;
  }

  if (master) {
    const r = probe('Calendar.Events.remove(' + testCalendarId + ', ' + master.id + ')',
      'succeeds; removing the master hides the whole series',
      () => Calendar.Events.remove(testCalendarId, master.id));
    Logger.log('master removed: ' + (r.ok ? 'yes' : 'code ' + r.code));
    const g = probe('Calendar.Events.get(' + testCalendarId + ', ' + master.id + ')',
      '404/410 after removal (H6)',
      () => Calendar.Events.get(testCalendarId, master.id));
    Logger.log('  verdict: GET after removal -> ' + (g.ok ? 'STILL PRESENT?!' : 'code ' + g.code + ' (404 or 410 expected)'));
    const gi = probe('Calendar.Events.get(' + testCalendarId + ', ' + instanceId(0) + ')',
      '404/410 — instance removed/cancelled by the master removal (cascade) (H6)',
      () => Calendar.Events.get(testCalendarId, instanceId(0)));
    Logger.log('  verdict: instance after master removal -> ' + (gi.ok ? 'STILL PRESENT?!' : 'GONE (code ' + gi.code + ')'));
    master = null;
  }

  for (const id of insertedStandalone) {
    probe('Calendar.Events.remove(' + testCalendarId + ', ' + id + ')',
      'succeeds (cleanup of a standalone insert probe)',
      () => Calendar.Events.remove(testCalendarId, id));
  }
  PropertiesService.getScriptProperties().deleteProperty('TEST_MASTER_ID');
  Logger.log('');
  Logger.log('==== teardown complete ====');
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function runAllTests() {
  Logger.log('================ Test.gs @ ' + new Date().toISOString() + ' ================');
  setupFixture();
  if (!master) return;
  try {
    runAddressingTests();
    runUpdateTests();
    runListTests();
    runInsertTests();
  } catch (e) {
    Logger.log('FATAL (unexpected): ' + describeError(e));
    Logger.log('exception: ' + stringifyError(e));
  }
  try {
    teardown();
  } catch (e) {
    Logger.log('TEARDOWN ERROR: ' + describeError(e));
    Logger.log('exception: ' + stringifyError(e));
  }
  Logger.log('==== done ====');
}
