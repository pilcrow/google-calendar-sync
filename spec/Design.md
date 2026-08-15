# Design: Google Calendar Sync

Authoritative technical reference for the Google Apps Script calendar sync engine.

---

## 1. Architecture

### Hub-and-Spoke

Multiple source calendars sync one-way into one or more destination calendars. Each source→destination pair is configured independently in `CALENDAR_CONFIG`. Pairs are processed sequentially within each trigger execution (`mainLoop` in `src/Main.gs`).

### File Structure

Apps Script loads project files into a single shared global namespace, so cross-file references are resolved by name. All repository-owned script files use the `.gs` extension, which is part of the deployed project.

| File                | Role                                                                                       |
|---------------------|--------------------------------------------------------------------------------------------|
| `00Init.gs`         | Script globals: `SCRIPT_BASETIME`, `SCRIPT_TIMEOUT_MS`, `SCRIPT_LOCK_TIMEOUT_MS`, `STATE_RECLAIM_DAYS` |
| `AppConfig.gs`      | `ScriptProperties` (UserProperties-backed per-pair state), `qualifyConfig()` (calendar resolution and stale-state dismissal), `ActiveConfig` |
| `CalendarApi.gs`    | `cal*` wrappers over the Calendar v3 API: write pacing, pagination, `syncToken` extraction, API-call accounting (`CAL_OPS`) |
| `Config.gs`         | Human-editable configuration (gitignored; contains personal calendar IDs)                    |
| `Config.gs.example` | Committed template; must be kept in structural sync with `Config.gs`                         |
| `Main.gs`           | Orchestration entry point: `main()`, `mainLoop()`; chooses incremental vs baseline sync      |
| `SyncEngine.gs`      | Sync engine: `_makeDestId()`, `buildDestReplica()`, `syncEvent()`, `_syncExceptionEvent()`, `syncLoop()`, `initialSync()`, `incrementalSync()` |
| `RuleEngine.gs`     | `evaluateRules()`                                                                            |
| `Utils.gs`          | `generateMd5Hash()`, `SoftTimeoutError`, `scriptTimeCheck()`                                 |
| `appsscript.json`   | Apps Script manifest: V8 runtime, Calendar v3 advanced service, timezone                     |

### Coding Conventions

All repository-owned `.gs` files must include the vim modeline as line 1:

```javascript
// vim: set ft=javascript ts=2 sw=2 et:
```

Avoid inline comments that restate what the code already clearly expresses.

---

## 2. Configuration

`Config.gs` declares:

```javascript
const API_PAGE_SIZE = 250;   // Optional override (max 250)

const LOOKBACK_DAYS = 7;     // Optional override (baseline sync window)

const CALENDAR_CONFIG = [
  {
    source: 'Calendar Name or ID',
    destination: 'Calendar Name or ID',
    rules: [
      { match: /regex/i, prefix: 'Label: ', colorId: 5 },
      { skip: true }
    ]
  }
];
```

- `API_PAGE_SIZE` is optional. If it is undefined, runtime falls back to `DEFAULT_API_PAGE_SIZE` (250). It is used for all `Calendar.Events.list` and `Calendar.CalendarList.list` calls.
- `LOOKBACK_DAYS` is optional. If it is undefined, `mainLoop` falls back to `SCRIPT_DEFAULT_LOOKBACK_DAYS` (7). It controls how far back a baseline sync scans (see §4.3).

---

## 3. Calendar Reference Resolution

`source` and `destination` may each be a calendar ID or a display name — a calendar's underlying title (`summary`) or its user-set override (`summaryOverride`). A name reference matches a calendar when it equals either field. Resolution happens at runtime in `qualifyConfig()` (`src/AppConfig.gs`).

For each side, the set of candidate IDs is the union of:

1. an exact match against a known calendar ID, and
2. all calendar IDs whose `summary` or `summaryOverride` matches.

Resolution streams the calendar list but retains only calendars whose name or ID is referenced by the config or by remembered state — never the user's full calendar list.

A config entry becomes an active pair only when each side resolves to exactly one ID and the two IDs differ. Everything else is skipped with `console.warn` and processing continues with the remaining entries:

- **Unresolvable** — a side matches zero calendars.
- **Ambiguous** — a side matches more than one calendar.
- **Absurd** — source and destination resolve to the same calendar ID.
- **Duplicate** — two or more entries resolve to the same `(sourceId, destinationId)` pair; all of them are skipped.

---

## 4. Sync Flow

### 4.1 Entry Point

`main()` (`src/Main.gs`):

1. Acquires a lock (`LockService.getUserLock().tryLock(SCRIPT_LOCK_TIMEOUT_MS)`, 30 s). If the lock cannot be acquired, logs at `console.error` and exits.
2. Loads per-pair state via `ScriptProperties.load()`.
3. Calls `qualifyConfig(props)` to split `CALENDAR_CONFIG` into active pairs and removed (stale-state) pairs (§3).
4. `mainLoop()`:
   - **Dismissal is state-only.** For each removed pair, the stored state keys are cleared. Synced destination replicas are left untouched; they are reconciled by a future baseline sync if the pair is ever re-added (deterministic IDs make that safe).
   - For each active pair, chooses incremental vs baseline sync (§4.2/§4.3) and persists `syncToken`, `configHash`, and `syncTime` for the pair only after its sync completes successfully.
5. `ScriptProperties.store(props)` persists the updated state; the lock is released, and a final `console.info` reports total elapsed time since `SCRIPT_BASETIME` plus per-endpoint calendar API-call counts.

A `SoftTimeoutError` aborts the loop (see §11): the interrupted pair's state is not persisted, so the next run re-syncs it. Any other error propagates out of `mainLoop` (there is no per-pair recovery) and aborts the execution.

### 4.2 Incremental Sync

`incrementalSync(config, syncToken)` (`src/SyncEngine.gs`) streams the source calendar's changes since `syncToken` (`syncLoop` with `{ syncToken, showDeleted: true }`), calling `syncEvent()` per item. It returns the next `syncToken` on success and **null** when the token has expired (`HTTP 410` with reason `fullSyncRequired`); the caller then falls back to a baseline sync. The new token is persisted only after the pair's sync completes (see §4.1).

If no `syncToken` is stored for the pair (first run, new config, or changed config), `mainLoop` calls `initialSync()` directly.

### 4.3 Baseline Sync

Triggered when the pair has no usable `syncToken`:

- **New config** — no `configHash` recorded yet.
- **Changed config** — `ActiveConfig` detects `configHash !== hash()` and nulls the stored `syncToken` (it keeps `syncTime`, which the upsert heuristic uses).
- **Expired token** — incremental sync returned null on `410 fullSyncRequired`.

`initialSync(config, startFrom)` (`src/SyncEngine.gs`):

1. Streams `[startFrom, ∞)` on the source (`syncLoop` with `{ timeMin: startFrom, showDeleted: false }`), recording the destination ID of every synced replica.
2. **Orphan cleanup:** streams all destination events tagged with the source calendar ID (via the `privateExtendedProperty` filter) and removes any whose ID is not in the recorded set — deleted source events, newly skip-filtered events, and replicas older than the lookback window.
3. Returns a fresh `syncToken`.

**Invariant:** baseline cleanup is pair-scoped and ID-based — it removes only replicas tagged with this pair's source calendar, never performing a blanket wipe of the destination calendar.

### 4.4 `syncLoop()`

`syncLoop(config, params, onSync)` (`src/SyncEngine.gs`) is the shared streaming core. It forces `singleEvents: false` and `eventTypes: 'default'` (required for `syncToken` support), streams via `calStreamEvents()`, and invokes `syncEvent()` on each item. It returns the next `syncToken`, or `null` when the source calendar ID is unknown.

---

## 5. Event Processing

### 5.1 `syncEvent()`

`syncEvent(sourceEvent, config, omittedParents, onSync)` (`src/SyncEngine.gs`) processes a single source item:

1. **Loop guard:** If `sourceEvent.extendedProperties?.private?.sourceCalendarId` is set, the item is a sync replica — log a warning and return. (See §10.)
2. **Time check:** `scriptTimeCheck()`.
3. **Exception routing:** If `sourceEvent.recurringEventId` is set, delegate to `_syncExceptionEvent()`.
4. **Cancellation/skip:** Build the destination replica via `buildDestReplica()`. If its `status` is `cancelled` (source event cancelled, or rule-skipped), remove the destination event by its deterministic ID (`calRemoveEvent`, tolerating 404/410). If the source item was a master (`recurrence` present), record it in `omittedParents` so sibling exceptions are skipped. Otherwise continue to the upsert.
5. **Upsert** — optimistic, no read-before-write:
   - If the pair has a recorded `syncTime` and the source event was created at or before it (`Date.parse(sourceEvent.created) <= syncTime`), the replica probably exists: attempt `calReplaceEvent()` first; a `404` falls back to `calInsertEvent()`.
   - Otherwise (likely a new event): attempt `calInsertEvent()` first; a `409` collision falls back to `calReplaceEvent()`.
6. Invoke `onSync?.(destEvent)` and return the destination event ID.

### 5.2 `buildDestReplica()` — Outbound Field Allowlist

`buildDestReplica(sourceEvent, config)` constructs the destination payload. Only the following fields are written. Arbitrary source fields must not be added; many Calendar API fields are read-only or server-set.

| Field                        | Notes                                                                                         |
|------------------------------|-----------------------------------------------------------------------------------------------|
| `summary`                    | Rule prefix prepended                                                                         |
| `description`, `location`, `transparency`, `visibility` | Copied when non-null                                                           |
| `start`, `end`               | Shallow-copied when present. `date`/`dateTime`/`timeZone` are the only writable sub-keys, so copying the object is equivalent to a sub-field allowlist; the field is omitted when the source value is absent, never sent as `{}` |
| `colorId`                    | From rule result; omitted when the rule returns null                                           |
| `recurrence`                 | Master events only (shallow copy of array)                                                     |
| `extendedProperties.private` | `sourceCalendarId`, `sourceEventId`                                                            |
| `id`                         | Deterministic destination ID (see §8); exception instances are addressed by their computed instance ID |
| `status`                     | `'cancelled'` when the event is rule-skipped or the source is cancelled; otherwise copied from the source when non-null |

`recurringEventId` and `originalStartTime` are intentionally excluded: destination instances are addressed by their computed ID (§6.2), so neither belongs in a payload. `attendees` is deliberately not copied. The remaining schema fields (`etag`, `created`, `updated`, `creator`, `organizer`, `htmlLink`, `hangoutLink`, `iCalUID`, ...) are read-only or server-set and never written.

### 5.3 Exception Events

`_syncExceptionEvent(sourceEvent, config, omittedParents, onSync)` handles items with `recurringEventId`:

1. If the parent master is already known absent (`omittedParents`), return immediately.
2. `buildDestReplica()` produces a payload whose `id` is the computed instance ID (§6.2).
3. **Apply:** a cancelled/skip-filtered exception is removed by its computed instance ID (`calRemoveEvent`); a live exception is written in place (`calReplaceEvent` — instances are updated, never inserted).
4. The first attempt tolerates only `410` on the remove path, so a `404` (parent master absent from the destination) propagates. Any `404` triggers the **on-demand master sync**:
   - Fetch the source master by `recurringEventId`.
   - If the source master is gone, cancelled, or skip-filtered, `syncEvent()` removes the destination master replica (which cascades to its instances) and records the parent in `omittedParents`; the exception is not synced.
   - Otherwise the destination master is (re)created first, then the exception application is retried with the default `[404, 410]` tolerances.

---

## 6. Recurring Event Handling

### 6.1 Master Events

Recognized by the presence of `item.recurrence`. The `recurrence` array is shallow-copied to the destination payload. Processed by `syncEvent()`.

### 6.2 Exception Events

Recognized by the presence of `item.recurringEventId`. Handled by `_syncExceptionEvent()`.

**Destination instance ID computation:**

Google Calendar instance IDs follow the format `<masterId>_<timestamp>`. The destination instance ID is:

```
destInstanceId = destMasterId + '_' + sourceSuffix
```

where `destMasterId = _makeDestId(sourceCalendarId, item.recurringEventId)` and `sourceSuffix = item.id.slice(item.recurringEventId.length + 1)`. `_makeDestId()` encapsulates the prefix computation.

The suffix must be derived by slicing at `recurringEventId.length + 1`, never by splitting the source ID on `_`: source event IDs (e.g. imported `c_...` IDs) can themselves contain underscores, and a split-based derivation corrupts both the master prefix and the timestamp suffix.

**Instances are updated or removed, never inserted.**

Once the destination master series exists, every destination instance is derived from it and addressable by its computed ID `destMasterId_<timestamp>` — `events.update()` on that ID materializes the exception without needing `recurringEventId`/`originalStartTime` in the body (empirically verified; see `spec/google-api-notes.md`, "Empirically verified API behaviors"). `insert()` is used only for non-exception events, with the deterministic `gcs`-prefixed ID. The destination master must therefore exist before an exception can be materialized (see the on-demand master sync in §5.3). A cancelled source exception arrives as a sparse sync item (no `summary`/`start`/`end`), but its `id` and `recurringEventId` are present, so the computed instance ID is still derivable.

**Master-before-exception ordering is handled by the on-demand path, not by partitioning.**

`syncLoop()` streams items in list order; it does not sort masters ahead of exceptions. The 404-triggered on-demand master sync in §5.3 is what pulls in a destination master whose source master fell outside the synced window, so an exception is never applied before its master exists.

**Exception rule evaluation:**

Each exception's summary is evaluated independently — the master's rule result is not inherited:

- If the exception's summary matches the same rule as the master (common for reschedules that don't change the title), the same prefix and color apply.
- If no rule matches the exception summary, `colorId` is omitted and the destination instance inherits the series color from the destination master.
- If the exception's summary matches a different rule than the master, that rule's prefix/color apply.
- If the on-demand master fetch reveals the source master is skip-filtered, the exception is also skipped — regardless of the exception's own summary.

---

## 7. Rule Engine

`evaluateRules(summary, rules)` (`src/RuleEngine.gs`):

- A missing or `null` summary is treated as `''`.
- Rules are evaluated in order; the first matching rule wins.
- A rule with no `match` field is a catch-all that always matches.
- `RegExp` objects with the `g`/`y` flag are reset (`lastIndex = 0`) before each test, since `test()` is stateful for those.
- Returns `{ skip: boolean, prefix: string, colorId: string|null }`.

| Rule property | Type          | Effect                                          |
|---------------|---------------|-------------------------------------------------|
| `match`       | RegExp        | Tested against summary; omit for catch-all      |
| `skip`        | boolean       | If true, event is not synced                    |
| `prefix`      | string        | Prepended to summary on destination             |
| `colorId`     | number/string | Overrides event color; coerced to string        |

---

## 8. Deterministic ID Mapping

`_makeDestId(calendarId, baseId, instanceSuffix = '')` (`src/SyncEngine.gs`):

```javascript
destEventId = 'gcs' + md5(calendarId + '::' + baseId)
```

- MD5 hex output (`[0-9a-f]`) is a strict subset of Google's base32hex event ID charset (`^[a-v0-9]+$`). The `gcs` prefix ensures the ID begins with a letter. The `::` separator prevents collisions across different calendar/event ID combinations.
- With an `instanceSuffix`, an underscore and the suffix are appended.

### Regular Events

```javascript
destEventId = _makeDestId(sourceCalendarId, sourceEvent.id)
```

### Exception Instances

```javascript
destInstanceId = _makeDestId(sourceCalendarId, recurringEventId) + '_' + sourceSuffix
```

See §6.2 for suffix derivation (slice, never split).

---

## 9. State Management

### ScriptProperties (UserProperties)

State is stored in **three** UserProperties keys, each holding a JSON object keyed by the pair key `srcId::dstId` (see `ScriptProperties`, `src/AppConfig.gs`):

| UserProperties key | Per-pair value                                   |
|--------------------|--------------------------------------------------|
| `syncToken`        | Incremental sync token for the source calendar   |
| `configHash`       | MD5 of `JSON.stringify(rules)` for the pair      |
| `syncTime`         | Epoch millis of the last successful sync         |

Keys are literally `sourceCalendarId::destinationCalendarId` (calendar IDs are not URL-encoded in state keys).

**Config hash:** `ActiveConfig.hash()` is `generateMd5Hash(JSON.stringify(this.rules))`. Caution: `JSON.stringify` serializes `RegExp` values as `{}`, so two configs differing only in a regex pattern produce identical hashes — a pure-regex change is not detected as a config change and does not force a baseline sync (see §14).

**State lifecycle** (`qualifyConfig()`):

- Active pairs: state is kept and updated after each successful sync.
- A pair whose config entry is removed or fails to resolve keeps its state for `STATE_RECLAIM_DAYS` (30) after its recorded `syncTime`, giving time to fix a renamed or re-added calendar. After that the state is dismissed — cleared from UserProperties. Replicas are left in place and reconciled by a future baseline sync.
- Pairs with no recorded `syncTime` are dismissed immediately.
- There is no persisted "managed registry" snapshot; the current `CALENDAR_CONFIG` is the source of truth each run.

### Extended Properties on Destination Events

Every destination event carries:

```json
{
  "extendedProperties": {
    "private": {
      "sourceCalendarId": "<source calendar ID>",
      "sourceEventId": "<source event ID>"
    }
  }
}
```

Used for: loop protection (§10), baseline orphan cleanup (§4.3), and traceability.

---

## 10. Loop Protection

At the top of `syncEvent()`, if `item.extendedProperties?.private?.sourceCalendarId` is set, the item is a sync replica and is skipped with `console.warn`. This prevents infinite feedback loops if a destination calendar is accidentally configured as a source.

---

## 11. Concurrency and Timeout Management

- **Lock:** `LockService.getUserLock().tryLock(SCRIPT_LOCK_TIMEOUT_MS)` (30 000 ms) — if another instance holds the lock, `main()` logs at `console.error` and exits.
- **`SCRIPT_TIMEOUT_MS`** (315 000 ms, "5m 15s") — soft deadline chosen to shut down gracefully inside Apps Script's 6-minute hard limit.
- **`SCRIPT_BASETIME`** (`src/00Init.gs`) — `Date.now()` captured at module load; the soft deadline is `SCRIPT_BASETIME + SCRIPT_TIMEOUT_MS`.
- **`scriptTimeCheck()`** (`src/Utils.gs`) — throws `SoftTimeoutError` once `Date.now()` reaches the deadline. Called before each stream and before each event's writes. `main()` catches `SoftTimeoutError`, logs a warning, and exits; the interrupted pair's state is not persisted, so the next run re-syncs it.
- **`LOOKBACK_DAYS`** (config, default `SCRIPT_DEFAULT_LOOKBACK_DAYS` = 7) — how far back baseline sync scans (`[now − LOOKBACK_DAYS, ∞)`).
- **`STATE_RECLAIM_DAYS`** (30) — grace period before stale per-pair state is dismissed.
- **Write pacing:** `_paceCalendarWrite()` (`src/CalendarApi.gs`) sleeps as needed to guarantee ≥500 ms between write operations (insert/update/remove) on the same calendar. The pacing sleep runs unconditionally and is not skipped when time is short.

---

## 12. Error Handling

| Condition                                              | Response                                                            |
|--------------------------------------------------------|---------------------------------------------------------------------|
| `HTTP 410` (`fullSyncRequired`) on incremental sync     | `incrementalSync()` returns null; caller falls back to baseline `initialSync()` |
| `404` on optimistic `calReplaceEvent()` (likely-new path) | Fall back to `calInsertEvent()`                                   |
| `409` on optimistic `calInsertEvent()` (collision)      | Fall back to `calReplaceEvent()`                                    |
| `404` on an exception's replace/remove                  | Parent-missing → on-demand master sync (§5.3)                       |
| `404`/`410` on `calRemoveEvent()` (default tolerances)  | Event already gone — ignored                                        |
| `item.status === 'cancelled'` (or rule `skip`)          | Destination replica removed                                         |
| Unknown source calendar ID in `calStreamEvents()`       | `console.warn("Calendar not found")`, returns null                  |
| Calendar reference resolution failure                   | `console.warn`, skip the pair, continue                             |
| `SoftTimeoutError`                                      | Caught in `main()`; loop aborts, state not persisted                |
| Any other error in a pair                               | Propagates; execution aborts (no per-pair recovery)                 |

---

## 13. API Requirements

- **Advanced Calendar Service** must be enabled (`appsscript.json` declares the Calendar v3 service).
- `singleEvents` must be `false` for all `Events.list` calls — `syncLoop()` forces it (`singleEvents: true` disables `syncToken` support). `syncLoop()` also forces `eventTypes: 'default'`.
- Required OAuth scopes are initialized on the first manual execution of `main()`.

---

## 14. Known Limitations

### Multi-destination fan-out

Sync tokens, config hashes, and sync times are tracked per source→destination pair (map keys like `srcId::dstId`). Fan-out — configuring the same source to sync to multiple destinations — is supported; state is preserved per pair. Operators should be aware that each pair maintains its own token and hash and should configure mappings intentionally.

### Baseline orphan cleanup

Every baseline sync ends with an orphan cleanup pass: it lists all destination events tagged with the source calendar ID (via the `privateExtendedProperty` filter) and removes any whose ID was not re-synced in the just-scanned `[now − LOOKBACK_DAYS, ∞)` window. Because destination IDs are deterministic (§8), re-synced replicas are addressed in place and always survive the pass; everything else — events deleted from the source, items that now match `skip`, and replicas older than the lookback window — is removed unconditionally. The pass runs even when nothing was re-synced in the window (e.g. a skip-all rule), so a baseline sync also acts as a complete wipe of a pair's tagged replicas.

### Removed mappings leave replicas behind

Removing a mapping from `CALENDAR_CONFIG` only dismisses the pair's state (after the `STATE_RECLAIM_DAYS` grace period); destination replicas are left in place. They are only cleaned up by a future baseline sync, which requires the pair to be re-added — there is no mechanism that scans and removes replicas for a mapping that no longer exists.

### Config-hash blind spot for regex-only changes

The config hash uses plain `JSON.stringify`, which serializes `RegExp` values as `{}`. Changing only a rule's regex (not its `prefix`/`colorId`/`skip`) therefore does not change the hash, so it is not detected as a config change and does not trigger a baseline sync.
