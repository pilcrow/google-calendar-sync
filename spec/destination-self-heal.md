# Destination Self-Heal: Replica Undo

Consolidated design for automatically detecting and reverting user-initiated changes to synced replicas on destination calendars.

---

## 1. Problem

The sync engine is strictly source→destination. When a user edits, soft-deletes, or hard-deletes a synced replica on the destination calendar, the script has no visibility into that mutation and cannot revert it. The replica drifts out of sync with the source of truth until the next source-side change happens to overwrite it.

### Scope of changes to detect and revert

| Change type | User action | Current behavior |
|---|---|---|
| Field edit | User changes summary, time, location, etc. | Destination stays edited until next source change |
| Soft delete | User deletes event; Google retains cancelled tombstone | Destination stays cancelled |
| Hard delete | User deletes event; Google purges it entirely | Destination event lost; no recovery path |
| Recurrence — master | User edits master RRULE or fields | Destination stays edited |
| Recurrence — instance | User edits "Just this event" on a series | Destination forked exception stays edited |

### Design goals

1. Detect all destination-side mutations via incremental sync token.
2. Revert user edits by overwriting with source-of-truth data.
3. Restore soft-deleted replicas by patching status back to `confirmed`.
4. Restore hard-deleted replicas by re-inserting from source (when possible).
5. Handle recurrence masters and single-instance exceptions.
6. Minimize redundant API calls: do not probe source for events already superseded by the normal source sync in the same run.

---

## 2. Design Decisions

### D1: Reversible destination IDs (stateless recovery)

**Decision:** Replace the one-way MD5 destination ID with a reversible encoding that decodes back to `(sourceCalendarId, sourceEventId)`.

**Rationale:** A reversible ID eliminates the need for a persistent lookup index in `PropertiesService` (which has a ~500KB limit and index-drift risk). When a hard delete purges extended properties, the destination event ID itself is the only remaining link back to the source.

**Tradeoff:** The encoding must fit Google Calendar's event ID charset (`^[a-v0-9]+$`, 32 characters) and Google's 1024-character maximum. Source IDs are typically 50–80+ characters of base64url-encoded data. The encoding will be longer than the current MD5 hash but well within limits.

### D2: Destination incremental monitoring

**Decision:** Track one destination sync token per destination calendar (not per mapping). Monitor destination deltas each run after source sync completes.

**Rationale:** One token per destination calendar is simpler than per-mapping tokens and matches how Google Calendar sync tokens work (one token covers all events on a calendar). Multiple source calendars syncing to the same destination calendar share a single destination token.

### D3: Source-first execution ordering

**Decision:** Run all source incremental syncs first, then run destination incremental sync. Destination deltas are only probed against source data for events not already touched by the source sync in the same run.

**Rationale:** This is the critical efficiency insight. The source sync already writes corrections for source-side changes. When the destination delta pass runs afterward, any event the source sync just updated/created/deleted is already in the correct state — no source probe needed. The destination pass only needs to resolve events where the destination changed but the source did not (i.e., user-initiated mutations).

**Consequence:** Source-sync corrective writes can appear in the destination delta feed in the *same* run (if those writes happen before destination `Events.list(syncToken)` is called) or on the next run. To keep the destination pass efficient, source sync must maintain an in-memory `touchedDestinationEventIds` set and the destination pass must skip IDs in that set.

### D4: Legacy ID migration is operator-driven

**Decision:** Do not implement automatic `gcs... -> v2...` migration logic. Legacy IDs remain supported only as-is. Migration to `v2` is handled operationally (see §4).

**Rationale:** Calendar event IDs are immutable; `update()` cannot rewrite a legacy ID in place. Automatic migration therefore implies insert-new/delete-old behavior, which creates duplicate-lifetime and cleanup-ordering complexity with little product value.

**Known gap:** Hard-deleted events with legacy IDs are unrecoverable until the operator performs a reset migration runbook.

### D5: Extended properties survive soft deletes

**Decision:** Assume Google Calendar retains `extendedProperties.private` on soft-deleted (cancelled) events but purges them on hard-deleted events. Use this as the routing signal between soft-delete and hard-delete recovery paths.

**Rationale:** This assumption is the basis for the Case A / Case B split in resolution logic and must be validated in the live API environment before rollout.

### D6: Token advancement discipline

**Decision:** Never advance the destination sync token unless the entire destination delta pass completes successfully (no timeout, no partial processing). Never advance the source sync token unless the entire source incremental sync completes successfully.

**Rationale:** Advancing a token past unprocessed events permanently loses those events from the delta feed. If the run is interrupted, the next run must reprocess from the last successfully persisted token. This is safe because all operations are idempotent (deterministic IDs, compare-before-write).

---

## 3. Implementation

### Phase 1: Reversible ID Encoding

#### ID format

```
v2<base32hex(sourceCalId + '|' + sourceEventId)>
```

- **`v2`**: Two-character version prefix. Signals this is a reversible ID (vs. legacy `gcs` + MD5). Always lowercase; uses only characters in `[a-v]`.
- **`base32hex(...)`**: The Google-standard Base32 encoding per RFC 4648 §7, using alphabet `A-V` and `0-9`, then lowercased to satisfy Google's `[a-v0-9]` requirement. Uses `=` padding only if necessary (Google tolerates it, but we strip it).
- **`|`**: Separator between the two source IDs (prevents prefix-collision across different calendar/event combinations). The pipe character is chosen because it cannot appear in Google Calendar IDs.

#### Encoding example

```
Source calendar ID:  "abc123@group.calendar.google.com"  (31 chars)
Source event ID:     "0v8abc123def456"                   (15 chars)
Composite:           "abc123@group.calendar.google.com|0v8abc123def456"  (47 chars)
Base32hex (lowered): ~80 chars (47 bytes × 8/5 ≈ 76 chars, plus version prefix)
Full dest ID:        "v2<m~80 chars>"                    ~82 chars total
```

Google Calendar supports event IDs up to 1024 characters. Even pessimistic source IDs (150+ chars decoded) stay well within limits.

#### Functions to add/modify in `Utils.gs`

- **`encodeReversibleId(sourceCalendarId, sourceEventId)`** — New. Concatenates with `|` separator, encodes to base32hex, lowercases, prepends `v2`.
- **`decodeReversibleId(destEventId)`** — New. Strips `v2` prefix, base32hex-decodes, splits on `|`, returns `{ sourceCalendarId, sourceEventId }`. Throws if ID is not a `v2` ID (i.e., is a legacy `gcs`+md5 ID).
- **`isReversibleId(destEventId)`** — New. Returns `true` if the ID starts with `v2`.
- **`getDestinationEventId()`** — Modified. Calls `encodeReversibleId()` instead of MD5.
- **`getDestinationInstanceId()`** — Unchanged in structure. Instance IDs remain `destMasterId + '_' + sourceSuffix`. The master portion changes format (now `v2`-encoded), but the `_` separator and suffix logic stay the same.

#### Exception instance ID format

```
destInstanceId = encodeReversibleId(sourceCalId, masterEventId) + '_' + sourceSuffix
```

where `sourceSuffix = item.id.slice(item.recurringEventId.length + 1)` (extracts the timestamp portion, e.g., `20260718T140000Z`).

The `isReversibleId()` check must also account for the underscore-suffixed form: split on `_` first, test the master portion, and decode from there.

#### Legacy ID detection

```javascript
function isLegacyId(destEventId) {
  return destEventId.startsWith('gcs');
}
```

Note: `v2` does not start with `gcs`, so the `!startsWith('v2')` guard is unnecessary.

Legacy IDs cannot be decoded. If a hard delete purges extended properties from a legacy-ID event, the event is unrecoverable.

---

### Phase 2: Destination Incremental Monitoring

#### New state keys

| Key | Value |
|---|---|
| `DEST_SYNC_TOKEN_<encodedDestCalendarId>` | Incremental sync token for a destination calendar |

One token per destination calendar. Multiple source calendars sharing a destination calendar share this token.

#### Destination delta pass

After all source syncs complete successfully for a run, execute:

```
performDestinationDeltaPass(destCalendarIds)
```

For each unique destination calendar:

1. Fetch the stored `DEST_SYNC_TOKEN_<encodedDestCalendarId>`.
2. Call `Calendar.Events.list(destCalId, { syncToken, singleEvents: false, showDeleted: true, maxResults: API_PAGE_SIZE })`.
3. Page through results. For each changed event:
   a. If `event.id` is in `touchedDestinationEventIds[destCalId]` (written earlier in this run by source sync) → skip with debug log.
   b. If `isLegacyId(event.id)` and no extended properties → legacy hard delete, unrecoverable; skip with log warning.
   c. If the event has no `extendedProperties.private.sourceCalendarId` and no `v2`-prefixed ID → it is not a synced replica; skip.
   d. If the event has `extendedProperties.private.sourceCalendarId` → it is a tagged replica; add to the repair queue.
   e. If the event has a `v2`-prefixed ID but no extended properties (hard-delete tombstone) → decode the ID to recover source coordinates; add to the repair queue.
4. Persist the new `DEST_SYNC_TOKEN_<encodedDestCalendarId>` only after all events on that calendar are processed (or skipped).

#### 410 Gone handling

If the destination sync returns `HTTP 410 Gone`:
1. Clear the `DEST_SYNC_TOKEN_*` for that calendar.
2. Mark that destination calendar as requiring operator reset migration (see §4); do not silently claim full self-heal coverage from a new baseline alone.
3. Optionally acquire a fresh baseline token for future runs, but document that destination-side mutations prior to that baseline are not recoverable from deltas alone.

---

### Phase 3: Resolution Logic

#### Execution ordering within a run

```
1. Source syncs (existing logic — per-pair incremental or reconciliation)
   → writes corrections to destination
   → advances source sync tokens on success

2. Destination delta pass (new logic — per-destination-calendar)
   → reads user-initiated mutations
   → repairs via source probe or extended-properties fast path
   → advances destination sync tokens on success
```

This ordering ensures the destination pass only probes source for events the source sync did not already handle.

#### Repair queue processing

For each event in the repair queue, classify and resolve:

**Classification precedence:** Evaluate recurring exceptions (Case D) before generic hard-delete handling (Case B), because exception IDs can also satisfy partial Case B signals.

**Case A: Soft delete or user edit to a confirmed event**

Detection: The event has `extendedProperties.private` with `sourceCalendarId` and `sourceEventId` set. The event is either:
- `status === "cancelled"` (soft delete), or
- `status === "confirmed"` but fields diverge from source (user edit).

Resolution:
1. Extract `sourceCalendarId` and `sourceEventId` from extended properties (preferred) or decode from `v2` ID (fallback).
2. Fetch the current source event: `Calendar.Events.get(sourceCalendarId, sourceEventId)`.
3. **If source event is absent or `status === "cancelled"`:** The source also deleted this event. No restoration needed — remove the destination replica if it still exists. (This is the "source already superseded" path. In the common case, the source sync already handled this, but this handles the race where source changed after the source sync's read.)
4. **If source event is skip-filtered under current rules:** Remove the destination replica.
5. **If source event is present and active:**
   - If destination `status === "cancelled"`: Patch `{ status: "confirmed" }` and update mutable fields from source.
   - If destination `status === "confirmed"` but fields diverge: Overwrite with source data via `Calendar.Events.update()` or `Calendar.Events.patch()`.
   - If fields match: No action needed (source sync already corrected, or user edit was benign).

**Case B: Hard delete (extended properties purged)**

Detection: The event has a `v2`-prefixed ID, has no `extendedProperties.private.sourceCalendarId`, and its ID is **not** an exception instance ID (`<master>_<suffix>`).

Resolution:
1. Decode the `v2` ID to recover `sourceCalendarId` and `sourceEventId`.
2. Fetch the source event.
3. If source event is absent/cancelled/skip-filtered: Nothing to restore; the event is intentionally absent.
4. If source event is present and active: Re-insert on destination using the same `v2` deterministic ID via `Calendar.Events.insert()`.

**Case C: Recurring event — master modification**

Detection: The event has `recurrence` array and either extended properties or a `v2` ID.

Resolution:
1. Fetch the source master event.
2. Compare `recurrence` array and mutable fields (`summary`, `description`, `location`, `start`, `end`).
3. If any field diverges: Overwrite the destination master with source data.
4. The existing `buildDestinationEvent()` logic handles field allowlisting and rule application.

**Case D: Recurring event — single instance exception**

Detection: The event ID contains an underscore (`_`), or the resource has `recurringEventId`.

Resolution:
1. Split the destination ID at the first underscore to extract the master portion.
2. Decode the master portion (via extended properties or `v2` decode) to recover `sourceCalendarId` and `sourceMasterEventId`.
3. Reconstruct the source instance ID: `sourceMasterEventId + '_' + sourceSuffix`.
4. Query the source for that instance: `Calendar.Events.get(sourceCalendarId, sourceInstanceId)`.
5. **If the source also has an exception at that timestamp:** Compare fields. Update destination to match if they differ.
6. **If the source has no exception (user made an unauthorized local edit):** Do not keep a synthetic destination exception indefinitely. Canonicalize the series by rebuilding the destination series state from source (master + source exceptions) so the instance returns to true master inheritance semantics.

#### Loop prevention for corrective writes

The corrective write (overwriting a user edit with source data) can appear in the destination incremental feed in the same run or the next run. The destination delta pass should:
1. See the event in the feed.
2. Skip immediately if the event ID is in `touchedDestinationEventIds` for that run.
3. Otherwise fetch the source event, compare, and skip if fields match.

The cycle terminates naturally. No special loop-prevention flag is needed beyond the comparison logic.

#### Token advancement caveat

The destination sync token must be advanced **after** all corrective writes for that calendar are committed. If the token is advanced before corrective writes, the corrective writes would appear as "new" deltas on the next run, but would be compared and found matching — harmless but wasteful. More importantly, if the token is advanced before corrective writes and the run then times out, the corrective writes are lost and the token has already moved past the events that needed repair.

**Rule:** Advance destination sync token only after all repair writes for that calendar complete successfully.

---

## 4. Migration Strategy

### Simplified approach: no automatic legacy migration

Do not add code paths that automatically migrate legacy `gcs` IDs to `v2`. Use one of these operator runbooks instead:

1. **Fresh deployment / clean destination (recommended for fastest cutover):**
   - Deploy with reversible ID logic enabled.
   - Use a new destination calendar (or fully clear existing replicas first).
   - Run sync to establish `v2`-only managed state.
   - A clean destination repopulates only the source-window scope (`LOOKBACK_DAYS` + future) on first run; older unchanged history will not be recreated immediately.

2. **Rolling mapping reset (per-source, two-run flow):**
   - Run A: remove one source→destination mapping from `CALENDAR_CONFIG`; execute a successful run so removed-mapping cleanup and state updates persist.
   - Run B: re-add that mapping; execute a successful run so destination is repopulated with `v2` IDs.
   - Repeat one mapping at a time.

### Operational caveats

- This is removed-mapping cleanup + fresh source-window sync, not automatic in-place rewrite.
- Re-add uses the configured source-window scope (`LOOKBACK_DAYS` + future), so older unchanged history may not be recreated immediately.
- If any configured mappings fail resolution in a run, removed-mapping cleanup/state updates are skipped for safety; migration progress pauses until resolution succeeds.

### Legacy gap

Events with legacy `gcs`+md5 IDs that are hard-deleted remain unrecoverable until an operator executes one of the migration runbooks above.

### Detection helpers

```javascript
function isReversibleId(destEventId) {
  return destEventId.startsWith('v2');
}

function isLegacyId(destEventId) {
  return destEventId.startsWith('gcs');
}
```

---

## 5. Timeout and Interruption Analysis

All state transitions are designed to be idempotent. The system recovers correctly from interruption at any point.

### Source sync timeout (existing behavior, unchanged)

If `performIncrementalSync()` or `syncSourceWindow()` times out mid-source-sync:
- The source sync token is **not** advanced (only advanced on full completion).
- Events processed before the timeout were written to the destination.
- The next run restarts from the last persisted token, reprocessing those events.
- The reprocessing is idempotent: `update()` overwrites with the same data; `insert()` on a 404-triggered catch does not duplicate because the deterministic ID matches the already-inserted event.

**Cost:** Some events are processed twice. Acceptable.

### Destination delta pass timeout

If `performDestinationDeltaPass()` times out mid-delta-pass:
- The destination sync token is **not** advanced.
- Events processed before the timeout had their corrective writes committed.
- The next run restarts from the last persisted destination token, reprocessing those events.
- Reprocessing is idempotent: the corrective write already matched source, so the comparison finds no divergence and skips.

**Cost:** Some corrective writes are re-evaluated (but not re-executed, since fields match). Acceptable.

### Source sync completes, destination delta pass times out

This is the most common partial-failure scenario:
- Source sync tokens are advanced (source sync completed successfully).
- Source-side corrections were written to the destination.
- Destination sync token is **not** advanced.
- Next run: source sync finds no new changes (token is current). Destination delta pass reprocesses from the last destination token.
- The source sync's corrective writes from the previous run will appear in the destination feed. The destination pass will see them, compare against source, find they match, and skip.

**No data loss. No redundant writes beyond the re-evaluation.**

### Source sync times out, destination delta pass never runs

- Source sync token is not advanced.
- Some source corrections were written to the destination.
- Destination sync token is not advanced.
- Next run: source sync restarts from the same token, reprocesses the same events (idempotent). Then destination delta pass runs normally.

**No data loss. Some source events processed twice.**

### Lock contention (concurrent run)

If a second `orchestrateCalendarSync()` invocation cannot acquire the script lock:
- It logs a warning and exits immediately.
- No state is modified.
- The first invocation continues to completion.

If the lock is somehow held by a zombie invocation (crashed without releasing):
- The lock auto-expires after `LOCK_TIMEOUT_MS` (30 seconds).
- The next invocation acquires the lock and runs normally.

### Apps Script hard kill (6-minute limit exceeded)

Apps Script terminates the execution at the 6-minute hard limit, regardless of `hasExecutionTimeRemainingMs()`. The `finally` block in `orchestrateCalendarSync()` runs `lock.releaseLock()`, so the lock is released. State is left in the same condition as a timeout:
- Tokens advanced for completed phases, not advanced for incomplete phases.
- Next run picks up from last persisted token.

**No corruption.** The `EXECUTION_TIMEOUT_MS` (5 minutes) safety threshold is designed to prevent reaching the hard kill by leaving 1 minute of buffer.

### Crash / unhandled exception

If an unhandled exception propagates to `orchestrateCalendarSync()`:
- The `finally` block releases the lock.
- State is left as-is (no tokens advanced, no registry updated).
- The next run starts fresh from the last persisted state.

**No corruption.**

### Summary of interruption safety

| Interrupt point | Source token | Dest token | Data loss? | Recovery |
|---|---|---|---|---|
| Source sync mid-page | Not advanced | Not advanced | No | Reprocess from last source token |
| Source sync complete | Advanced | Not advanced | No | Dest delta pass runs next; re-evaluates source writes |
| Dest delta mid-page | Advanced (if source complete) | Not advanced | No | Reprocess from last dest token |
| Dest delta complete | Advanced | Advanced | No | Clean state |
| Hard kill / crash | As above | As above | No | Lock released; next run from last tokens |

---

## 6. API Budget Impact

### Steady-state (no user edits)

The destination delta pass returns an empty feed (no changes since last run). Cost: 1 `Events.list` call per destination calendar per run. Negligible.

### User edit detected

For each user-edited event, the destination pass makes 1 `Events.get` call on the source calendar to fetch current source state, plus 1 `Events.update` or `Events.patch` call to revert. The existing `WRITE_PACING_DELAY_MS` (500 ms) applies to writes.

### Hard delete detected

For each hard-deleted event with a `v2` ID, the destination pass makes 1 `Events.get` on source + 1 `Events.insert` on destination.

### Worst case

If a user modifies many events between runs (e.g., bulk-edits the destination calendar), the destination pass will process each one. With the 5-minute execution budget and 500 ms pacing, the practical limit is ~500 write operations per run. If more events are modified than can be processed in one run, the destination token is not advanced and the next run continues.

---

## 7. State Management Additions

### New PropertiesService keys

| Key | Value |
|---|---|
| `DEST_SYNC_TOKEN_<encodedDestCalendarId>` | Incremental sync token for destination calendar |

Existing keys remain unchanged. The `SYNC_TOKEN_*`, `CONFIG_HASH_*`, and `MANAGED_CALENDAR_REGISTRY_V1` keys are unaffected.

### Extended properties (unchanged)

Every destination event continues to carry:

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

These serve as the primary recovery path for soft deletes and user edits (Case A). The `v2` ID is the fallback for hard deletes (Case B) when extended properties are purged.

---

## 8. Known Limitations

### Legacy hard-delete gap

Events with legacy `gcs`+md5 IDs that are hard-deleted cannot be recovered automatically. Recovery requires operator migration (§4).

### Destination token reset gap (410)

If a destination sync token expires (`410 Gone`), any destination-side mutations before the newly established baseline token are not reconstructible from delta history alone. Treat this as an operational recovery condition and use the migration runbook if strong repair guarantees are required.

### Race condition: source reads before user edits

If a user edits a destination event *after* the source sync reads the source event but *before* the source sync writes to the destination, the source sync's write overwrites the user's edit. The destination delta pass, running after the source sync, compares the now-overwritten destination against source and finds a match — the user's edit is lost.

This window is small (bounded by the source sync's write latency) and acceptable. The source sync's authoritative write is correct; the user's edit was against a stale source state.

### Concurrent source and destination changes

If both the source and the user modify the same event in the same interval, the source sync wins (it runs first). The user's edit is overwritten. This is the correct behavior for a source-authoritative system.

### No selective field revert

The current design reverts all mutable fields to source state. There is no concept of "the user changed the description but the source changed the time — merge both." This is intentional: source is authoritative, and field-level merge introduces ambiguity about user intent.

---

## 9. Open Items

1. **Empirical validation of base32hex ID length:** Construct test IDs with worst-case source IDs (longest observed in production) and confirm they fit within Google Calendar's 1024-character limit. Measure the actual encoded length.

2. **Test extended-properties behavior on soft delete:** Verify empirically that `extendedProperties.private` survives a user-initiated delete (which Google renders as a cancelled event in the API). The design assumes this is true based on Gemini's confirmation, but should be validated against the live API.

3. **Destination sync token initialization and reset policy:** The first destination delta pass (and post-410 reset) has no usable token. Approach:
   - Skip destination delta processing on the first run (no token yet).
   - After source syncs complete, acquire the initial destination token by calling `Calendar.Events.list(destCalId, { singleEvents: false, showDeleted: true, maxResults: API_PAGE_SIZE })` without a sync token (paging until `nextSyncToken`). Store that `nextSyncToken` as `DEST_SYNC_TOKEN_*`.
   - Subsequent runs use incremental sync from this baseline.
   - This baseline does **not** replay pre-baseline destination mutations; if those guarantees are required, run the operator migration flow in §4.

4. **Test plan additions:** Extend `spec/TestPlan.md` with cases for:
   - User edits destination event → reverted on next run
   - User soft-deletes destination event → restored on next run
   - User hard-deletes destination event with `v2` ID → restored on next run
   - User hard-deletes destination event with legacy ID → not restored (known gap)
   - User modifies destination recurring master → reverted
   - User modifies destination recurring exception → reverted
   - Source and user both change same event → source wins
   - Run times out during destination delta pass → next run completes repair
