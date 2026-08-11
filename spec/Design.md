# Design: Google Calendar Sync

Authoritative technical reference for the Google Apps Script calendar sync engine.

---

## 1. Architecture

### Hub-and-Spoke

Multiple source calendars sync one-way into one or more destination calendars. Each source→destination pair is configured independently in `CALENDAR_CONFIG`. Pairs are processed sequentially within each trigger execution.

### File Structure

Apps Script loads `.gs` files in alphabetical order into a single shared global namespace:

| File           | Role                                                                          |
|----------------|-------------------------------------------------------------------------------|
| `Config.gs`    | Human-editable configuration (loaded first; constants available globally)     |
| `Main.gs`      | Orchestration entry point and incremental sync                                |
| `RuleEngine.gs`| Rule evaluation                                                               |
| `SyncEngine.gs`| Core event processing and reconciliation                                      |
| `Utils.gs`     | ID generation, timing, properties access, calendar resolution                 |

`Config.gs` is gitignored (contains personal calendar IDs). `Config.gs.example` is the committed template and must be kept in structural sync with `Config.gs`.

### Coding Conventions

All repository-owned `.gs` files must include this vim modeline as line 1:

```javascript
// vim: set ft=javascript ts=2 sw=2 et:
```

Avoid inline comments that restate what the code already clearly expresses.

---

## 2. Configuration

`Config.gs` declares:

```javascript
const API_PAGE_SIZE = 250;      // Optional override (max 250)

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

`API_PAGE_SIZE` is optional. If it is undefined, runtime falls back to `DEFAULT_API_PAGE_SIZE` (250). The value is used for all `Calendar.Events.list` and `Calendar.CalendarList.list` calls.

---

## 3. Calendar Reference Resolution

`source` and `destination` may be either a calendar ID or a display name (the effective name shown in the Google Calendar UI: `summaryOverride` when set, otherwise `summary`). Resolution happens at runtime via `resolveCalendarConfig()`:

1. If the reference exactly matches a known calendar ID, it is used as-is.
2. If it matches exactly one display name, that calendar's ID is used.
3. If it is ambiguous (multiple calendars share the name) or not found, the pair is **skipped with `console.warn`**; remaining pairs continue.

---

## 4. Sync Flow

### 4.1 Entry Point

`orchestrateCalendarSync()` (Main.gs):

1. Acquires a script lock (`LockService.getScriptLock().tryLock(LOCK_TIMEOUT_MS)`). If the lock cannot be acquired, logs a warning and exits.
2. Resolves all calendar references once via `resolveCalendarConfig()`.
3. Computes removed mappings by diffing the current resolved set against the previously managed pair/source registry. If any configured mapping fails resolution, removal cleanup and registry updates are skipped for safety in that run.
4. Cleans removed mappings by deleting destination events tagged with the removed source in the removed destination.
5. Iterates over active resolved pairs, calling `syncCalendarPair()` for each. Stops if the 5-minute timeout threshold is reached.
6. On successful completion, clears stale state (`SYNC_TOKEN_*`, `CONFIG_HASH_*`) for removed mappings and persists the new managed registry snapshot.
7. Releases the lock in a `finally` block.

### 4.2 Incremental Sync (normal path)

`performIncrementalSync()` uses the stored `syncToken` to fetch only changed events since the last run. For each page of results, calls `processSyncItem()`. Persists the new `syncToken` only on successful completion (no timeout) and logs duration + event metrics (`# added, # updated, # deleted`).

If no `syncToken` is stored (first run for this source), delegates to `syncSourceWindow()` instead.

### 4.3 Reconciliation Sync

Triggered by:
- `HTTP 410 Gone` — sync token expired
- Rules change detected with a stored sync token — `checkCalendarPairConfigChange()` returns true and a sync token exists. If rules changed but no sync token is stored, the code falls through to `syncSourceWindow()`, which upserts current source events, removes in-window items that now match `skip`, and writes the new config hash, but **skips orphan cleanup**.

`executeReconciliationSync()`:

1. Builds an **AllowedSet** of destination event IDs for all source events in the `[now − LOOKBACK_DAYS, ∞)` window that pass current rules (not cancelled, not skip-filtered).
2. Queries the destination calendar for all events tagged with the source calendar ID (via `privateExtendedProperty` filter).
3. Removes any destination event whose ID is not in the AllowedSet (orphan cleanup — deleted events, newly skip-filtered events).
4. Calls `syncSourceWindow()` with the same `timeMin` to upsert all surviving source events and capture a fresh `syncToken`.

**Invariant:** Reconciliation never performs a destructive wipe of the destination calendar.

### 4.4 Source Window Sync

`syncSourceWindow()` (SyncEngine.gs) performs a tokenless `[now − LOOKBACK_DAYS, ∞)` scan:

- Per page, partitions events into masters and exceptions, then processes masters first, exceptions second (see §6).
- Persists the fresh `syncToken` and updates the config hash only on successful completion (no timeout).
- Logs duration + event metrics.

---

## 5. Event Processing

### 5.1 `processSyncItem()`

1. **Loop guard:** If `item.extendedProperties?.private?.sourceCalendarId` is set, the event is a sync replica — log a warning and return. (See §10.)
2. **Exception routing:** If `item.recurringEventId` is set, delegate to `processExceptionSyncItem()`.
3. **Cancellation:** If `item.status === 'cancelled'`, remove the destination event (ignore 404/410).
4. **Rule evaluation:** Run `evaluateRules(item.summary, config.rules)`. If `skip`, remove the destination event (ignore 404/410).
5. **Upsert:** Build destination payload via `buildDestinationEvent()`. Attempt `Calendar.Events.get()`; on success use `update()`, on 404 use `insert()`.

### 5.2 `buildDestinationEvent()` — Outbound Field Allowlist

Only the following fields are written to destination events. Arbitrary source fields must not be added; many Calendar API fields are read-only or server-set.

| Field                          | Notes                                         |
|--------------------------------|-----------------------------------------------|
| `summary`                      | Rule prefix prepended                         |
| `description`, `location`      | Copied as-is                                  |
| `start`, `end`                 | `date`/`dateTime`/`timeZone` are the only keys (all writable), so copying the object as-is is equivalent to a sub-field allowlist. Omit the field when the source value is empty or absent; never send `{}`. |
| `transparency`, `visibility`   | Copied as-is                                  |
| `colorId`                      | From rule result; omitted if rule returns null|
| `recurrence`                   | Master events only (shallow copy of array)    |
| `extendedProperties.private`   | `sourceCalendarId`, `sourceEventId`           |

`recurringEventId` and `originalStartTime` are intentionally excluded: destination instances are addressed by their computed ID (§6.2), so neither field belongs in a payload. The event-level fields the allowlist genuinely guards against are the read-only/server-set ones — `id`, `etag`, `created`, `updated`, `creator`, `organizer`, `htmlLink`, `hangoutLink`, `iCalUID` — plus `attendees`, which is deliberately not copied. (The API schema marks `recurringEventId`/`originalStartTime` Immutable, with conflicting `events.insert` annotations; see `spec/google-api-notes.md`.)

---

## 6. Recurring Event Handling

### 6.1 Master Events

Recognized by the presence of `item.recurrence`. The `recurrence` array is copied directly to the destination payload. Processed by `processSyncItem()`.

### 6.2 Exception Events

Recognized by the presence of `item.recurringEventId`. Handled by `processExceptionSyncItem()`.

**Destination instance ID computation:**
Google Calendar instance IDs follow the format `<masterId>_<timestamp>`. The destination instance ID is:

```
destInstanceId = destMasterId + '_' + sourceSuffix
```

where `destMasterId = getDestinationEventId(sourceCalendarId, item.recurringEventId)` and `sourceSuffix = item.id.slice(item.recurringEventId.length + 1)`. The `getDestinationInstanceId()` utility encapsulates this.

The suffix must be derived by slicing at `recurringEventId.length + 1`, never by splitting the ID on `_`: source event IDs (e.g. imported `c_...` IDs) can themselves contain underscores, and a split-based derivation corrupts both the master prefix and the timestamp suffix.

**Instances are updated, never inserted.**
Once the destination master series exists, every destination instance is derived from it and addressable by its computed ID `destMasterId_<timestamp>` — `events.get()` resolves the ID even for instances never materialized as exceptions, and `Calendar.Events.update()` on that ID materializes the exception without needing `recurringEventId`/`originalStartTime` in the body (empirically verified; see `spec/google-api-notes.md`, "Empirically verified API behaviors"). This is what the existing working engine does: `processExceptionSyncItem()` (`src/SyncEngine.gs`) updates the computed instance ID directly and has no insert path for exceptions. The API's base32hex custom-ID charset (`[a-v0-9]`, no underscores) constrains only IDs the caller supplies to `insert()` — Google-generated instance IDs contain underscores, so the charset is not the operative constraint here; an exception needs no custom ID because it is addressed as an instance of the destination master. `insert()` is used only for non-exception events, with a deterministic `gcs`-prefixed ID. The destination master must therefore exist before any exception is synced (see below). A skipped or cancelled exception is removed from the destination by its computed instance ID — matching `processExceptionSyncItem()`'s cancel/skip path — never updated or inserted. A cancelled source exception arrives as a sparse sync item (no `summary`/`start`/`end`), but its `id` and `recurringEventId` are present, so the computed instance ID is still derivable.

**On-demand master sync:**
Before updating the destination exception, `processExceptionSyncItem()` verifies the destination master exists via `Calendar.Events.get()`. If the master is absent (404):

1. Fetches the source master directly by ID (`item.recurringEventId`).
2. Evaluates the master's summary against rules. If skip-filtered, the exception is also skipped.
3. Calls `processSyncItem()` on the source master to create it on the destination.

**Sort order (masters before exceptions):**
In `syncSourceWindow()`, each page of results is partitioned into masters and exceptions buckets; masters are processed first. This ordering guarantee is per page (not global across pages); the on-demand master sync path handles cross-page master/exception ordering.

**Exception rule evaluation:**
Each exception's summary is evaluated independently — the master's rule result is not inherited:

- If the exception's summary matches the same rule as the master (common for reschedules that don't change the title), the same prefix and color apply.
- If no rule matches the exception summary, `colorId` is omitted and the destination instance inherits the series color from the destination master.
- If the exception's summary matches a different rule than the master, that rule's prefix/color apply.
- If the destination master is absent and the on-demand fetch reveals the source master is skip-filtered, the exception is also skipped — regardless of the exception's own summary.

---

## 7. Rule Engine

`evaluateRules(summary, rules)` (RuleEngine.gs):

- A missing or `null` summary is treated as `''`.
- Rules are evaluated in order; the first matching rule wins.
- A rule with no `match` field is a catch-all that always matches.
- Returns `{ skip: boolean, prefix: string, colorId: string|null }`.

| Rule property | Type          | Effect                                          |
|---------------|---------------|-------------------------------------------------|
| `match`       | RegExp        | Tested against summary; omit for catch-all      |
| `skip`        | boolean       | If true, event is not synced                    |
| `prefix`      | string        | Prepended to summary on destination             |
| `colorId`     | number/string | Overrides event color; coerced to string        |

---

## 8. Deterministic ID Mapping

### Regular Events

```javascript
destEventId = 'gcs' + md5(sourceCalendarId + '::' + sourceEventId)
```

MD5 hex output (`[0-9a-f]`) is a strict subset of Google's base32hex event ID charset (`^[a-v0-9]+$`). The `gcs` prefix ensures the ID begins with a letter. The `::` separator prevents collisions across different calendar/event ID combinations.

Do not use the superseded `"src" + base32hex-strip` formula — it risks collisions.

### Exception Instances

```javascript
destInstanceId = destMasterId + '_' + sourceSuffix
```

See §6.2 for derivation.

`sourceSuffix` is derived by slicing at the master ID length, never by splitting the source ID on `_` (source IDs can contain underscores; see §6.2).

---

## 9. State Management

### PropertiesService (UserProperties)

| Key                                              | Value                                       |
|--------------------------------------------------|---------------------------------------------|
| `SYNC_TOKEN_<encodedSourceCalendarId>`           | Incremental sync token for a source calendar|
| `CONFIG_HASH_<encodedSrc>_<encodedDest>`         | MD5 of normalized rules for a calendar pair |
| `MANAGED_CALENDAR_REGISTRY_V1`                   | JSON snapshot of managed pairs/sources      |

Keys use `encodeURIComponent()` on calendar IDs.

`MANAGED_CALENDAR_REGISTRY_V1` is initialized from a successful run of the current configuration. Removal cleanup depends on this snapshot, so mappings removed before the registry is first initialized are not inferred retroactively.

**Config hash computation:** Rules are normalized before hashing via `normalizeConfigForHash()`, which converts RegExp values to their `toString()` representation and sorts object keys for deterministic ordering. Plain `JSON.stringify` is not used alone because it silently drops RegExp values.

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

Used for: loop protection (§10), reconciliation orphan detection, and traceability.

---

## 10. Loop Protection

At the top of `processSyncItem()`, if `item.extendedProperties?.private?.sourceCalendarId` is set, the event is a sync replica and is skipped with `console.warn`. This prevents infinite feedback loops if a destination calendar is accidentally configured as a source.

A parallel check in `executeReconciliationSync()` emits the same warning with an `"in reconciliation"` suffix to distinguish the call site in logs.

---

## 11. Concurrency and Timeout Management

- **Script lock:** `LockService.getScriptLock().tryLock(LOCK_TIMEOUT_MS)` (30 000 ms) — if another instance holds the lock, the current execution exits immediately with a warning.
- **`EXECUTION_TIMEOUT_MS`** (300 000 ms) — 5-minute safety threshold within Apps Script's 6-minute hard limit.
- **`LOOKBACK_DAYS`** (7) — how far back source-side tokenless sync and reconciliation AllowedSet queries look. Events older than 7 days are not directly scanned in tokenless source-window sync.
- **`EXECUTION_START_MS`** — set at module load time. Used only for timeout checks via `hasExecutionTimeRemainingMs()`, not for user-visible elapsed time (which uses a locally captured `Date.now()` after lock acquisition).
- **`hasExecutionTimeRemainingMs(minimumRemainingMs)`** — returns false if the remaining execution budget is less than `minimumRemainingMs`.
- **`WRITE_PACING_DELAY_MS`** (500 ms) — inserted after each calendar write API call to reduce quota pressure. Skipped if insufficient time remains.

---

## 12. Error Handling

| Condition                               | Response                                                           |
|-----------------------------------------|--------------------------------------------------------------------|
| `HTTP 410 Gone`                         | Sync token expired — trigger reconciliation sync                   |
| `HTTP 404 Not Found` on event get       | Event absent from destination — use `insert()` instead of `update()` |
| `HTTP 404/410` on event remove          | Event already gone — silently ignored                              |
| `item.status === 'cancelled'`           | Remove from destination calendar                                   |
| Calendar reference resolution failure   | `console.warn`, skip the pair, continue with remaining pairs       |
| Unexpected error in `syncCalendarPair()`| Logged at `console.error`; remaining pairs continue                |

---

## 13. API Requirements

- **Advanced Calendar Service** must be enabled in the Apps Script project (Services → Calendar API).
- `singleEvents` must be `false` for all `Events.list` calls. `singleEvents: true` disables `syncToken` support.
- Required OAuth scopes are initialized on first manual execution of `orchestrateCalendarSync()`.

---

## 14. Known Limitations

### Multi-destination fan-out

Sync tokens and config hashes are tracked per source→destination pair (e.g. keys like `SYNC_TOKEN_<encodedSrc>_<encodedDest>`). Fan-out — configuring the same source to sync to multiple destinations — is supported; state is preserved per pair. Operators should be aware that each pair maintains its own token and hash and should configure mappings intentionally.

### Full-sync orphan cleanup

`initialSync()` runs an orphan cleanup pass after every full sync: it lists all destination events tagged with the source calendar ID (via the `privateExtendedProperty` filter) and removes any whose ID was not re-synced in the just-scanned `[now − LOOKBACK_DAYS, ∞)` window. Because destination IDs are deterministic (§8), re-synced replicas are addressed in place and always survive the pass; everything else — events deleted from the source, items that now match `skip`, and replicas older than the lookback window — is removed unconditionally. The pass runs even when nothing was re-synced in the window (e.g. a skip-all rule), so a full sync also acts as a complete wipe of a pair's tagged replicas.
