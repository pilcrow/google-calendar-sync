# TODO

## Testing

### qualifyConfig has no unit tests

`qualifyConfig()` (`src/AppConfig.gs`) implements a large decision tree — active,
ambiguous, absurd, zero-match, duplicate-key, and `STATE_RECLAIM_DAYS` stale-state
dismissal — but nothing exercises it in a test. `Test.gs` deliberately avoids
project code (Calendar API probes only), and no harness covers `qualifyConfig` or
the `RuntimeConfig`/`ActiveConfig`/`InactiveConfig` classes. Add unit tests for
the classifier before relying on its behavior.

#### Implementation plan (recorded for a future session)

**Foundation.** A throwaway Node harness exists at
`/var/folders/l_/xrvs2ck51tj22q2kt8vyyg880000gp/T/opencode/harness.js`; adapt it into
a real `test/qualifyConfig.test.js` (with the repo vim modeline on line 1). Keep
its `makeProps()`/`run()` helpers and its approach of loading the real
`AppConfig.gs` source so tests can't drift from the code. Salient pieces of the
current classifier to test against: `calIterCalendars()` iterator seam, bounded
loading (only referenced calendars retained), both-field name matching
(`summaryOverride` and `summary`), `calId2Name`/`calName2Ids` maps, and
`stateKeys` reuse.

**Design decisions.**
- Zero-dependency runner: the repo has no Node tooling, and `Test.gs` is
  deliberately Apps-Script-only. Use a tiny `test(title, fn)` + `assert` helper
  and a `node test/qualifyConfig.test.js` invocation documented in the README.
- Stub the `calIterCalendars()` global directly (fake iterator yielding fixture
  calendars) rather than mocking `Calendar.CalendarList` two layers down. This is
  the single clean seam between the classifier and the API.
- Load sources into a fresh context per test (per-test `CALENDAR_CONFIG` + fake
  iterator + captured `console.warn`/`console.info` spy). Do NOT reuse the
  harness's eval-once-shared-globals approach — its tests are order-dependent.
- Injectable clock for the reclaim-window logic so `STATE_RECLAIM_DAYS`
  boundaries (no syncTime, just-inside, exactly-at, just-past) are deterministic.
- Assert on observable behavior (active/removed keys + warning messages). The one
  justified white-box check is the space-efficiency property: a spy on
  `calIterCalendars` proving only referenced calendars were retained.

**Coverage.**
- Active: name, `summaryOverride`, base `summary` behind an override, literal ID.
- Ambiguous: duplicated display name; base `summary` shared by two calendars;
  config value that is both a real ID and a display name.
- Absurd (srcId == dstId), zero-match, duplicate-key (multi-config dedup).
- Bounded loading (white-box, above).
- Stale dismissal: no syncTime → immediate; within window → held; past window →
  dismissed; active pairs kept.
- `InactiveConfig` display-name lookup and `summarize()`.
- `ScriptProperties.load()`/`store()` round-trip (stub `PropertiesService`).
- Separate small test for `calIterCalendars()` multi-page pagination
  (`nextPageToken` traversal).

## Open Questions

### Feature? Destination self-heal implementation follow-up

Self-heal design details now live in `spec/destination-self-heal.md`.
Use that spec as the implementation checklist for destination-delta monitoring,
recovery behavior, and rollout/migration steps.

### Feature? sync deletion keyword

Extend CALENDAR_CONFIG to support a new configuration directive which would
clear state and clear any replicas previously synced from that source/dest
pair. (e.g., `delete: true`)
