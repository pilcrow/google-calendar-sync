# Test Plan: Google Calendar Sync

This plan defines what to test for manual validation today, with a structure that can be executed semi-programmatically later.

## 1. Scope and goals

The plan validates:

1. Correct one-way sync behavior (insert/update/delete).
2. Correct rule behavior (`match`, `prefix`, `colorId`, `skip`, ordering).
3. Recurring master/exception correctness.
4. Incremental sync, reconciliation, and state persistence behavior.
5. Safety behavior (loop guard, lock, timeout handling, error handling).

Out of scope for now:

1. Full end-to-end automation framework.
2. Unsupported multi-destination fan-out for a single source calendar.

## 2. Test environment

Use dedicated calendars and test-only event titles.

| Role | Suggested name |
|---|---|
| Source A | `GCS TEST Source A` |
| Source B | `GCS TEST Source B` |
| Destination | `GCS TEST Destination` |

Suggested title prefix for all fixtures: `GCS-TP-`.

## 3. Evidence to capture per test case

For each case, record:

1. **Config used** (`CALENDAR_CONFIG` snippet).
2. **Action** (what changed in source + sync runs).
3. **Observed destination state** (event exists/updated/deleted, summary, color, recurrence behavior).
4. **Observed properties state** (`SYNC_TOKEN_*`, `CONFIG_HASH_*` presence/change).
5. **Observed logs** (key info/warn/error markers).

## 4. Manual execution pattern

For each case:

1. Set fixture config in `src/Config.gs`.
2. Push/deploy and run `orchestrateCalendarSync()` manually.
3. Apply source-side change for the scenario.
4. Run `orchestrateCalendarSync()` again (or more if case requires).
5. Inspect destination events, properties, and logs against expected outcomes.

## 5. Test matrix

Legend:

- **Priority**: P0 (must pass), P1 (important), P2 (nice to cover).
- **Automation potential**: High means straightforward to instrument with helper assertions.

| ID | Priority | Area | Scenario | Expected outcome | Automation potential |
|---|---|---|---|---|---|
| TP-001 | P0 | Orchestration | Empty `CALENDAR_CONFIG` | If no prior managed mappings, warns and exits without sync writes; if prior managed mappings exist, runs removed-mapping cleanup | High |
| TP-002 | P0 | Orchestration | Lock already held by another run | Warns and exits without syncing | Medium |
| TP-003 | P0 | Pair isolation | One pair throws unexpected error | Error logged; remaining pairs still processed | Medium |
| TP-004 | P0 | Calendar resolution | Source/destination by exact calendar ID | Pair resolves and syncs | High |
| TP-005 | P0 | Calendar resolution | Source/destination by unique display name | Pair resolves and syncs | High |
| TP-006 | P0 | Calendar resolution | Missing/ambiguous name | Pair skipped with warning; others continue | High |
| TP-007 | P0 | Rules | First-match-wins ordering | First matching rule controls prefix/color/skip | High |
| TP-008 | P0 | Rules | Catch-all rule with no `match` | Catch-all applies when earlier rules do not | High |
| TP-009 | P0 | Rules | `skip: true` for matching summary | Destination copy removed/absent | High |
| TP-010 | P1 | Rules | Null/empty summary handling | No crash; rule evaluation still deterministic | Medium |
| TP-011 | P0 | Core sync | New non-recurring event | Deterministic destination ID inserted with tags | High |
| TP-012 | P0 | Core sync | Source event edit (summary/time/location/description) | Destination event updated in place | High |
| TP-013 | P0 | Core sync | Source event cancelled/deleted | Destination event removed; missing remove is tolerated | High |
| TP-014 | P0 | Incremental sync | First run (no sync token) | Runs tokenless source window sync; token stored | High |
| TP-015 | P0 | Incremental sync | Later run (sync token present) | Uses incremental sync; only changed items processed | Medium |
| TP-016 | P0 | Reconciliation trigger | Token expired (HTTP 410) | Reconciliation runs; no full destination wipe | Medium |
| TP-017 | P0 | Reconciliation trigger | Rules hash changed and token exists | Reconciliation runs for pair | High |
| TP-018 | P1 | Reconciliation edge | Rules changed and no token exists | Falls back to source-window sync (no orphan cleanup in this pass) | Medium |
| TP-019 | P0 | Reconciliation cleanup | Destination has orphan tagged events | Orphans removed; allowed events retained | High |
| TP-020 | P0 | Recurring masters | Recurring master in source | Destination master includes recurrence and deterministic ID | High |
| TP-021 | P0 | Recurring exceptions | Modified single occurrence | Destination instance updated at computed instance ID | Medium |
| TP-022 | P0 | Recurring exceptions | Cancelled exception occurrence | Destination exception instance removed (404 ignored) | Medium |
| TP-023 | P0 | Recurring exceptions | Exception arrives before master exists on destination | If master passes rules: master synced on-demand and exception synced; if master is skip-filtered: exception also skipped | Low |
| TP-024 | P0 | Loop protection | Source item already tagged as sync replica | Item skipped with loop-guard warning | High |
| TP-025 | P1 | IDs/state | Event and instance ID determinism | IDs stable across runs; no duplicate logical copies | High |
| TP-026 | P1 | State keys | Sync token/config hash key encoding | Keys stored with encoded IDs and pair-specific hash keying | High |
| TP-027 | P1 | Timeout guard | Execution budget exhausted mid-run | Warns and stops gracefully without crash | Low |
| TP-028 | P1 | Write pacing | Multiple write operations in one run | Writes paced; no quota-spike behavior regressions | Low |
| TP-029 | P1 | API errors | 404 on get/remove, non-404 unexpected errors | 404 paths handled as designed; non-404 surfaces/logged | Medium |
| TP-030 | P0 | Config removal | Remove one source→destination mapping | Tagged events for that mapping are deleted from destination; pair hash and source token state are cleared | High |
| TP-031 | P1 | Config removal | Remove all mappings | All events tagged from previously managed mappings are cleaned and registry/state reflects empty config | Medium |
| TP-032 | P1 | Config removal | Remove then re-add same mapping | Re-added mapping performs clean tokenless sync and re-establishes token/hash/registry state | Medium |
| TP-033 | P1 | Config removal | First run with no managed registry present | Registry initializes from current config; removed-mapping cleanup starts on subsequent successful runs | Medium |

## 6. Minimal fixture set for fast regression runs

For repeat manual checks, keep a compact subset:

1. TP-005 (name resolution)
2. TP-001 (empty config guard)
3. TP-003 (pair error isolation)
4. TP-007 (rule order)
5. TP-011 (insert)
6. TP-012 (update)
7. TP-013 (cancel/delete)
8. TP-014 + TP-015 (tokenless then incremental)
9. TP-017 + TP-019 (reconciliation trigger + orphan cleanup)
10. TP-021 + TP-023 (exception update + missing-master path)
11. TP-024 (loop guard)
12. TP-030 (single mapping removal cleanup)

## 7. Semi-programmatic path

Start with a lightweight assertion harness (helper functions callable from Apps Script IDE):

1. `listDestinationEventsBySource(sourceCalendarId)` using `privateExtendedProperty`.
2. `getSyncState(sourceCalendarId, destCalendarId)` returning token/hash values.
3. `assertEventShape(event, expected)` for summary/time/color/tags checks.
4. `runCase(caseId)` that applies fixture mutation instructions and records pass/fail evidence.

Record outputs in a structured JSON object per case (`caseId`, `steps`, `actual`, `expected`, `pass`, `notes`) so the same cases can later be run via Execution API or a clasp-driven runner.

## 8. Exit criteria

Before declaring a release-ready sync behavior:

1. All P0 cases pass.
2. No P0/P1 regression in the minimal fixture subset across two consecutive sync runs.
3. Reconciliation and recurring exception paths are exercised at least once in the current config.
