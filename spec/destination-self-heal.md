# Destination Self-Heal: Replica Undo

Design for automatically detecting and reverting user-initiated changes to synced replicas on destination calendars.

---

## 1. Problem

The sync engine is strictly source→destination. When a user edits or deletes a synced replica on the destination calendar, the script has no visibility into that mutation and cannot revert it. The replica drifts out of sync with the source of truth until the next source-side change happens to overwrite it.

### Scope of changes to detect and revert

| Change type | User action | Current behavior |
|---|---|---|
| Field edit | User changes summary, time, location, etc. | Destination stays edited until next source change |
| Soft delete | User deletes event; Google retains cancelled tombstone | Destination stays cancelled |
| Recurrence — master | User edits master RRULE or fields | Destination stays edited |
| Recurrence — instance | User edits "Just this event" on a series | Destination forked exception stays edited |

**Deliberately out of scope:** hard deletes (user deletes; Google purges the event entirely). A purged event loses its `extendedProperties`, which are the sole recovery coordinate in this design (D1). See §4.

### Design goals

1. Detect destination-side mutations via a destination incremental sync token.
2. Revert user edits by overwriting with source-of-truth data.
3. Restore soft-deleted replicas by patching status back to `confirmed`.
4. Handle recurrence masters and single-instance exceptions.
5. Classify most deltas locally — without a per-event source read — using a content hash stamped on every replica at write time.
6. Never infer delta authorship from write history alone; classify by comparing actual content (see D3).

---

## 2. Design Decisions

### D1: Extended properties are the sole recovery path; hard delete is out of scope

**Decision:** Every replica continues to carry `extendedProperties.private.sourceCalendarId` and `sourceEventId`. These properties are the routing signal and coordinate source for all repair paths. If the properties are absent, the event is either not ours or has been hard-deleted; both cases are skipped. No secondary recovery mechanism (e.g., reversible destination IDs) is built.

**Load-bearing assumption:** Google retains `extendedProperties.private` on soft-deleted (cancelled) events. Every soft-delete repair depends on this and it must be validated empirically before rollout (§10, V1).

### D2: One destination incremental sync token per destination calendar

**Decision:** Track one destination sync token per destination calendar, monitored once per run after all source syncs complete. Multiple source calendars feeding the same destination share this single token.

**Rationale:** Google issues sync tokens per calendar, not per mapping. The delta feed interleaves mutations of replicas from all contributing sources; attribution per mapping is unnecessary because each event's own `sourceCalendarId` property names the source to consult.

### D3: Source-first ordering; no authorship inference

**Decision:** Run all source incremental syncs first, then the destination delta pass. The destination pass classifies each delta **by content**, never by asking "did my own source-sync write touch this event earlier in the run?"

**Rejected alternative:** maintaining an in-memory set of destination event IDs written by this run's source sync and skipping those IDs in the delta feed. This is a time-of-check-to-time-of-use defect: the feed proves only *that* an event changed since the token, not *who* changed it. A user mutation landing between the source sync's write and the delta `Events.list` call collapses into the same deduplicated feed entry as the script's own write; skipping on membership would advance the token past evidence of a real mutation, making the drift permanent and silent. The vulnerable window is not microseconds — write pacing (≥500 ms/write) and multi-pair sequencing expose early-written events for minutes, and mass exposure recurs on every baseline backfill.

Content comparison subsumes the optimization safely: a delta whose recomputed content hash equals the stored hash needs no source probe regardless of who wrote it; anything else enters repair.

### D4: Content-hash change detection stamped at write time

**Decision:** Persist `extendedProperties.private.replicaHash` on every replica: a digest of the replica's *managed-field projection* as sent. During the delta pass, recompute the digest from the delta item's body and compare. Equal ⇒ the artifact is in the last-written state ⇒ skip locally with zero API calls. Unequal or missing ⇒ divergence ⇒ repair queue. The hash is embedded atomically in every upsert payload (see Phase 1 for why a post-write patch is not viable).

**Hash domain:** exactly the outbound allowlist of `buildDestReplica()` — post-rule `summary`, `description`, `location`, `start`, `end`, `transparency`, `visibility`, `colorId`, `recurrence`, `status`. Consequences:

- Anything outside the domain (attendees, reminders, guest settings) mutates freely without tripping repair — consistent with §8 "no selective field revert", since repairs overwrite only these fields anyway.
- This is why the event `etag` is *not* used: etags flip on any modification including unmanaged ones, generating probes that a semantic compare then wastes. The content-scoped digest is precisely as sensitive as the managed domain.

**Round-trip stability is the risk concentration.** Google normalizes payloads on ingest (`dateTime` reformats, echoed fields), so a digest computed from the payload *sent* can mismatch every future read-back, producing phantom repairs. Two mandatory mitigations:

1. **Canonicalization neutralizes format noise** (Phase 1): times parsed to epoch-millis, sorted-key serialization, order-normalized arrays — most ingest normalization vanishes before hashing.
2. **Verify-then-refresh convergence** (Case A step 4): a mismatch triggers the normal source probe and semantic compare; on equality, refresh the stored hash from the read-back via `events.patch`. Each residual normalization quirk costs one probe + one patch per affected event per source-driven rewrite — bounded, never churning.

### D5: Cancelled events bypass hashing

**Decision:** Any delta item with `status === "cancelled"` routes directly to the source probe. Its body may be sparse (cancelled instances especially), so its digest is meaningless; and a cancellation cannot be attributed locally anyway — the source must answer whether the event still exists (user delete ⇒ restore; source delete ⇒ leave gone).

### D6: Token advancement discipline

**Decision:** Never advance a sync token unless the phase that consumes it completed successfully. Advance the destination token only **after** all repair writes for that calendar are committed. Advancing past uncommitted repairs loses them permanently; advancing late merely re-lists and re-compares, which is idempotent.

### D7: Optional in-run ETag fast path

**Optimization:** Record the ETag returned by every destination insert or
update performed during the current run, keyed by destination calendar and
event ID. When an active event in the destination delta feed has an exact ETag
match, skip hash recomputation and source verification: the write observed by
the feed is the script's latest known write. Keep the hash path as the
fallback for events not written in this run, missing ETags, or mismatched
ETags. Cancelled items still bypass local classification and follow D5.

This is strictly an optimization, not an authorship or recovery mechanism.
ETags are opaque resource versions: a user edit after the script write should
produce a mismatch, but a user edit after the delta-list snapshot can still
race with a corrective write (L1). The in-memory map is discarded after the
run and must retain the newest ETag if an event is written more than once.
The API wrappers therefore need to return the inserted/updated resource (or
its ETag); absent or unreliable response ETags must conservatively fall back
to hash comparison.

---

## 3. Implementation

### Phase 1: Replica Content Hash

#### Canonical projection and digest

```javascript
// GCS.Utils (proposed)
function canonicalReplicaProjection(event) {}  // managed fields, normalized
function hashReplicaEvent(event) {}            // generateMd5Hash(canonical form)
```

Canonicalization requirements — the correctness of the whole mechanism rests on these:

| Rule | Detail |
|---|---|
| Serializer | Fixed, sorted-key encoding over the projection object. Never `JSON.stringify` of the raw API resource. |
| Fields | Exactly the `buildDestReplica()` allowlist (D4). Nothing added, nothing dropped. |
| Times | `dateTime` parsed to epoch-millis integer; `date` kept as ISO date string; `timeZone` as its own string field. Parsing — not string comparison — is what absorbs Google's `dateTime` reformats. |
| Scalars | `colorId` coerced to string; booleans/numbers as-is; absent fields omitted uniformly. |
| Arrays | `recurrence` copied and order-normalized (sorted) before serialization. |
| Excluded | `id`, `etag`, `kind`, `created`, `updated`, `htmlLink`, `iCalUID`, `creator`, `organizer`, `sequence`, `reminders`, `attendees`, `extendedProperties` themselves. |

Digest: `GCS.Utils.generateMd5Hash` over the canonical string. MD5 is acceptable — this is a change detector, not a security control.

API limits (per the extended properties guide): property keys max 44 chars, values max 1024 chars; violations are silently dropped/truncated. `replicaHash` (11 / 32 chars) fits trivially. A silently dropped hash degrades safely: it surfaces as a missing-hash divergence, which verifies clean and converges.

#### Storage lifecycle

**The hash rides the upsert payload itself.** `buildDestReplica()` gains an optional precomputed hash and always emits the complete private map:

```
payload = buildDestReplica(sourceEvent, config)
payload.extendedProperties.private.replicaHash = hashReplicaEvent(projection(payload))
upsert via calInsertEvent / calReplaceEvent              // zero extra writes
```

Why not hash the API response and patch it afterwards? Two documented behaviors force this choice:

1. `events.update` **replaces the entire `extendedProperties` object** — any key absent from the payload is deleted. A replica whose hash was attached by a later patch would lose it on the next source-driven full update, forcing a probe-and-refresh cycle on every such change.
2. A post-write patch doubles paced writes per replica change for state that the next update destroys anyway.

Consequences of sent-form hashing:

- Every upsert ships the complete `{sourceCalendarId, sourceEventId, replicaHash}` set atomically.
- If Google's normalization differs from our canonical form for some event, every sighting mismatches until Case A step 4 refreshes the stored hash from the read-back (via `events.patch`, which merges per-key and preserves sibling private properties). The next full update re-embeds a sent-form hash, so quirky events pay one probe + one patch per source-driven rewrite. V2 measures how often this occurs; V3 gates the overhead.
- Removal (source-cancelled replicas) needs no hash maintenance; tombstones bypass hashing (D5).
- Repair-path corrective writes embed fresh hashes identically.

**Property schema on every replica**

```json
{
  "extendedProperties": {
    "private": {
      "sourceCalendarId": "<source calendar ID>",
      "sourceEventId": "<source event ID>",
      "replicaHash": "<md5 hex>"
    }
  }
}
```

Legacy replicas predating this feature lack `replicaHash`; their first delta sighting classifies as divergence, verifies clean against source, and converges. No migration is required.

---

### Phase 2: Destination Delta Pass

After all source syncs for the run complete successfully, execute `performDestinationDeltaPass(destinationCalendarIds)`:

1. Fetch the stored destination sync token for the calendar. If none exists, skip processing this run and acquire an initial token instead (§10, V4).
2. `Calendar.Events.list(destCalId, { syncToken, singleEvents: false, showDeleted: true })`, paging to exhaustion.
3. For each delta item, classify locally:

```
a. No private.sourceCalendarId in extendedProperties?
      → not a managed replica → skip                       [limitation L3/L4 apply]

b. status === "cancelled"?
      → queue as TOMBSTONE (hash logic bypassed, D5)

c. active item has an exact in-memory ETag recorded for
   (destination calendar ID, item.id)?
      → skip (ETag fast path, D7)

d. else recompute hashReplicaEvent(item) and compare to stored replicaHash
      → equal    → self-written or coincidentally identical → skip (debug log)
      → unequal
        or replicaHash missing                             → queue as DIVERGENCE
```

4. Process the repair queue (Phase 3).
5. Persist the fresh destination token only after every queued repair for this calendar has committed (D6).

**HTTP 410 Gone:** clear the stored token; mark the calendar as requiring operator attention; optionally establish a fresh baseline token. Mutations between the lost token and the new baseline are unrecoverable from deltas alone (§8, L6).

---

### Phase 3: Resolution Logic

#### Execution ordering within a run

```
1. Source syncs (existing)          → corrections written; source tokens advanced on completion
2. Destination delta pass (new)     → local classification; repairs; destination token advanced on completion
```

Because source corrections land before the delta snapshot, they appear in the feed with hashes that already match (written via Phase 1's flow) and are skipped locally — the common case costs zero source reads.

#### Repair queue processing

Coordinates come from `extendedProperties.private` (D1). Classification precedence: resolve instance signals (Case D) before generic handling, because instance IDs carry an underscore suffix that must be interpreted before tombstone/divergence logic reconstructs coordinates.

**Case A — divergence on a confirmed replica (user edit)**

1. Extract `(sourceCalendarId, sourceEventId)` from extended properties.
2. `Calendar.Events.get(sourceCalendarId, sourceEventId)`.
3. Source absent, cancelled, or now rule-skipped ⇒ remove the destination replica if present.
4. Source present and active ⇒ rebuild the payload via `buildDestReplica()` and semantically compare against the current destination body:
   - Fields equal ⇒ false-positive hash miss (normalization quirk or stale legacy hash): props-only patch refreshing `replicaHash` from the read-back. No content write.
   - Fields differ ⇒ overwrite via `update()`/`patch()`, then refresh `replicaHash`.

**Case B — tombstone (soft delete)**

1. Extract coordinates from extended properties (survival assumed per D1).
2. Probe the source.
3. Source absent, cancelled, or skip-filtered ⇒ nothing to restore; ensure the replica stays absent. This is also the terminal state for source-initiated cancellations surfacing in the feed — one source read each, accepted (D5).
4. Source present and active ⇒ patch `{status: "confirmed"}` plus refreshed mutable fields, then refresh `replicaHash`.

**Case C — recurring master modification**

Detection: `recurrence` array present on the item.

1. Fetch the source master.
2. Compare `recurrence` and mutable fields.
3. Any divergence ⇒ overwrite the destination master through `buildDestReplica()` (allowlist and rule application reused verbatim), then refresh `replicaHash`.

Instances are individually hashed and individually repaired; nothing inherits from the master at repair time except series color via normal rule absence.

**Case D — single instance exception**

Detection: ID contains `_`, or the resource carries `recurringEventId`.

1. Split the destination ID at the first underscore: `<masterPortion>_<suffix>`.
2. Recover `(sourceCalendarId, sourceMasterEventId)` from the instance's own extended properties.
3. Reconstruct `sourceInstanceId = sourceMasterEventId + '_' + suffix`; `Events.get` it.
4. Source has an exception at that slot ⇒ compare fields; update to match if they differ.
5. Source has **no** exception (the user forked a local edit) ⇒ do not keep a synthetic destination exception: canonicalize the series by removing the destination master and rebuilding it from source (master + live source exceptions), restoring true master-inheritance semantics for the slot.

#### Loop prevention

Corrective writes bump the event, so they reappear in the next run's feed — or the current run's, if they precede the `Events.list` call. Either way the recomputed hash equals the freshly stored hash and the item is skipped locally. Compare-before-write (Case A step 4) guarantees convergence even for false positives. No loop-prevention flags exist or are needed.

#### Token advancement caveat

If the destination token were advanced before repairs commit and the run then died, the repairs would be lost with the evidence already consumed. Hence D6: token persistence strictly follows repair commits, per calendar.

---

## 4. Out of Scope: Hard Delete

When a user hard-deletes a replica, Google purges `extendedProperties` with the event. With no properties there is no source coordinate, and destination event IDs are opaque MD5 digests — deliberately not reversible (D1). Consequences, accepted:

- A hard-deleted replica is not restored automatically. It remains absent until the source event next changes (source sync recreates it deterministically) or an operator runs a mapping-removal/re-add cycle, which repopulates within the source window (`LOOKBACK_DAYS` + future) using deterministic IDs.
- The delta pass detects the condition cheaply: a `v`-less disappearance is simply never seen again; nothing is logged per-event beyond the initial observation. Operators investigating missing replicas should check the source calendar directly.
- Should hard-delete recovery become a requirement, the candidate mechanism is a reversible destination ID encoding `(sourceCalendarId, sourceEventId)` surviving property purges; it is intentionally deferred as it complicates ID generation for a rare, operator-recoverable failure mode.

---

## 5. Interruption and Timeout Analysis

All operations are idempotent: deterministic IDs, compare-before-write, hash refreshes that derive from read-backs.

| Interrupt point | Source token | Dest token | Data loss? | Recovery |
|---|---|---|---|---|
| Source sync mid-page | Not advanced | Not advanced | No | Reprocess from last source token |
| Source sync complete | Advanced | Not advanced | No | Delta pass runs next; source-written replicas hash-match and skip locally |
| Delta pass mid-repairs | Advanced | Not advanced | No | Committed repairs stand; next pass re-lists, recomputes, finds match, skips |
| Delta pass complete | Advanced | Advanced | No | Clean state |
| Hard kill / crash | As above | As above | No | Lock released via `finally`; next run resumes from last tokens |

Notes:

- **Source completes, delta pass times out** (most common partial failure): next run's source sync finds an empty delta; the delta pass replays the previous interval, hash-skips everything the source sync wrote, finishes remaining repairs, advances the token.
- **Timeout inside a repair** (between source probe and corrective write): token held; next run redoes the probe and the compare-before-write finds either divergence (repair executes) or equality (skip). No duplication.
- Apps Script's 6-minute hard kill behaves as a timeout: the `finally` block releases the lock; state reflects completed phases only. The 5-minute soft deadline exists to avoid reaching the hard kill.

---

## 6. API Budget Impact

| Scenario | Cost per run |
|---|---|
| Steady state (no changes anywhere) | 1 × `Events.list` per destination calendar; zero reads/writes beyond |
| N source-changed events | Normal source-sync writes only (hashes ride the payload); **zero source probes** for well-normalized replicas |
| M user-edited replicas | M source `get`s + ≤ M corrective writes (hash embedded) |
| K tombstones in feed | K source `get`s + ≤ K restores |
| Bulk vandalism (hundreds of edits) | Pacing-bound (~500 writes/run at 500 ms); token held on overflow, remainder processed next run |

Normalization-quirky replicas add one source probe + one hash-refresh patch per source-driven rewrite until Google's stored form matches our canonical projection (D4); V2/V3 quantify how rare that population is.

---

## 7. State and Event Properties

- **Destination sync token:** one incremental sync token per destination calendar, persisted alongside existing per-pair state and governed by the same advance-on-success discipline. Exact storage keys follow the current implementation conventions and are intentionally unspecified here.
- **Source-pair state:** unchanged (`syncToken`, config hash, sync time per pair).
- **Extended properties:** unchanged except for the added `replicaHash` (Phase 1 schema). These remain the sole recovery coordinates (D1).

---

## 8. Known Limitations

**L1 — Post-snapshot race (inherent, accepted).** A user edit landing after the delta `Events.list` snapshot but before the corrective write commits is overwritten by the repair, token advances, edit lost. Window is seconds; closing it requires conditional writes (`If-Match`/ETag), which the Apps Script Advanced Service client does not expose.

**L2 — Concurrent change: source wins.** If source and user modify the same event in one interval, the source sync runs first and its write stands; the delta pass then hash-matches and skips. Correct for a source-authoritative system.

**L3 — Deletion of inherited occurrences goes undetected.** Deleting an occurrence that was never forked on the destination makes Google synthesize a *cancelled* instance with a sparse body and no extended properties; classification (a) sees an untagged event and skips. Such slots heal lazily on the next source-side touch of the series. Detection would require recognizing `<managedMasterId>_` prefixes against masters seen this run — noted as possible future tightening, not implemented.

**L4 — Series splits are half-managed.** A UI "this and following" edit splits the source series into two masters; the new master arrives on the destination with an unfamiliar deterministic ID and no properties, so it is skipped as unmanaged while the original series remains managed. Pre-existing exposure independent of the hash mechanism; flagged for a dedicated design if it matters operationally.

**L5 — No selective field revert.** Repairs overwrite the full managed field set from source; there is no merge of "user changed description, source changed time." Intentional: source is authoritative.

**L6 — Destination token reset gap.** After a 410 and fresh baseline, destination mutations between old and new tokens are unrecoverable from deltas. Treat as an operational condition requiring the manual remap runbook if strong guarantees are needed.

**L7 — Hash false positives converge, bounded.** A normalization-induced mismatch costs at most one source probe plus one hash-refresh patch per occurrence (Case A step 4). Because full updates re-embed sent-form hashes, a persistently quirky field type pays once per source-driven rewrite of that event, not once ever. Unbounded churn indicates a canonicalization bug, to be caught by V2.

---

## 9. Design Critique and Required Revisions

The design is directionally compatible with the existing engine, but it is not
yet implementation-ready. The following issues must be resolved before code
work begins.

### Blocking findings

**C1 — Partial-run commit semantics are unspecified.** `main()` in
`src/Main.gs` catches `SoftTimeoutError`, retains the in-memory updates made
by completed pairs, and then unconditionally stores them. That is a valid
policy for completed source pairs, but the design does not define the
corresponding policy for a destination calendar: a destination token must
never be persisted past unprocessed deltas, while a completed repair phase may
be committed. Choose and specify one transaction boundary: either stage all
state and commit only after the complete run, or persist independently
completed phases with explicit per-calendar/per-pair status. Update D6, §5,
and the implementation sequence to match that choice.

**C2 — Cleanup and exception semantics are not explicit.** The current
`main()` releases the lock only on its normal path, although Apps Script
releases execution-scoped locks when the invocation terminates. The design's
statement that a `finally` block releases the lock is therefore not true until
orchestration is changed. Specify a `try/finally` for deterministic cleanup
and define what state is committed when an unexpected exception propagates.

**C3 — Destination state has no concrete schema or ownership lifecycle.**
`ScriptProperties.ConfigPairStateKeys` currently contains only `syncToken`,
`configHash`, and `syncTime`, all keyed by `sourceId::destinationId`.
Destination tokens are keyed by destination calendar, so §7 must specify the
new property key, JSON shape, initialization marker, last-success timestamp,
410/reset marker, and how stale state is retained or dismissed when multiple
pairs share a destination. A destination token must remain while at least one
active or reclaimable mapping references that destination.

**C4 — Required API operations are not implemented or wrapped.** The current
`CalendarApi.gs` has no `calPatchEvent`, no destination-token reset handling,
and `calStreamEvents()` only treats 404 as an unknown calendar; it does not
expose a way to distinguish a destination `410` from a source token failure.
Specify wrapper signatures, request bodies, return values, tolerated status
codes, pagination behavior, and whether a patch response or a follow-up get is
the source of the refreshed hash. Do not rely on undocumented claims that
`events.update` replaces or `events.patch` merges extended-property maps:
make V1/V3 executable against the Advanced Calendar service and record the
observed behavior.

### High-risk findings

**H1 — The sent-form hash contract is underspecified at nested-field level.**
The implementation currently shallow-copies `start` and `end`, and omits
null-valued fields. The canonical projection must state exact behavior for
missing versus null keys, `date` versus `dateTime`, absent/present `timeZone`,
unknown nested keys, status transitions, and recurrence-line ordering. It must
also define how a hash is refreshed after a write when the API response
normalizes the payload. Otherwise a false-positive can recur after every
source rewrite, not merely once.

**H2 — The repair queue needs an explicit current-resource strategy.** A
delta item is a snapshot, while a repair can race with another edit. Define
whether Case A compares against the delta item or performs a destination
`get` immediately before writing, and define the behavior for destination 404,
410, and a source event that is cancelled or missing. The accepted race in L1
must be stated as a deliberate last-write-wins policy, not presented as
lossless recovery.

**H3 — Recurring-instance canonicalization is a separate, expensive operation.**
Case D's "remove master and rebuild master plus live exceptions" requires
source enumeration, can exceed the five-minute soft deadline, and can
interact with other source pairs sharing the destination. Either constrain it
to a bounded helper with explicit pagination/timeout semantics or defer it to a
follow-up design. A single-instance repair must not silently perform an
unbounded series rewrite.

**H4 — Initial-token acquisition has a non-trivial cost and gap.** Establishing
a destination token without a prior token requires an unscoped destination
list, which may enumerate the entire calendar. The design must state whether
the first run intentionally performs no repairs, how the resulting
`nextSyncToken` is persisted, what happens if token acquisition times out, and
that mutations before that baseline are unrecoverable. The same policy is
required after 410.

**H5 — Source-first optimization has a narrow precondition.** Hash-skipping
source-written deltas is safe only when every source write (insert, update,
repair, and resurrection) embeds a valid hash and the destination feed returns
the managed fields required to recompute it. If either condition fails, the
item must be queued for source verification. State this fallback explicitly;
do not describe the optimization as universally zero-read.

**H6 — ETag fast path is conditional.** The optional D7 optimization requires
insert/update wrappers to return a trustworthy ETag and the destination list
feed to expose the current ETag. It must compare the exact calendar/event
pair, retain the latest value for repeated writes, and never apply to
cancelled or untagged items. A matching ETag can skip local hash work, but
cannot close the post-snapshot race in L1.

### Non-blocking but required documentation fixes

**N1 — Align terminology with the repository.** Use `main()`, `initialSync()`,
`incrementalSync()`, `calStreamEvents()`, and `GCS.Config.ScriptProperties`
consistently. The existing `TestPlan.md` still contains older names and
state-key expectations; the new cases must identify the exact integration
helpers and properties they inspect.

**N2 — Separate empirical gates from automated assertions.** V1–V4 are live
Advanced Calendar Service probes, while TP-SH cases are regression scenarios.
Document the required fixture cleanup, API response evidence, and the
minimum number of consecutive runs for idempotence. A local `npm test` result
cannot validate this feature because no automated suite exists.

**N3 — Make operational gaps actionable.** L3, L4, and L6 should link to a
runbook action: inspect the source, force a mapping baseline, or acknowledge
the destination-token reset window. "Operator attention" without a concrete
recovery step is insufficient for a production rollout.

### Required pre-implementation decisions

1. Select the state transaction model required by C1 and define the commit
   matrix for source-pair state and destination-calendar state.
2. Specify the destination-token property schema, retention rules, initial
   token acquisition, and 410 reset procedure.
3. Confirm Advanced Calendar Service behavior for cancelled-event patching,
   extended-property replacement/merge, list/get serialization, and 410
   responses using the existing `test/Test.gs` style of empirical probes.
4. Bound or defer recurring-instance series canonicalization (H3).
5. Decide whether to implement D7; if enabled, add wrapper return-value and
   repeated-write handling to the implementation contract.
6. Revise TP-SH-008 and add scenarios for partial source completion,
   destination-token initialization/reset, shared-destination stale-state
   retention, lock release on unexpected errors, and hash refresh after
   normalized read-back.

---

## 10. Validation Plan

### Empirical gates (must pass before rollout)

| ID | Item | Why load-bearing |
|---|---|---|
| V1 | `extendedProperties.private` survives user-initiated soft delete — single events *and* forked instances; characterize which body fields survive on cancelled resources | D1 and Case B assume property survival; D5 assumes sparsity |
| V2 | Round-trip hash stability: `H(read-back t) == H(read-back t+Δ)` across timed/all-day/DST-crossing/timezoned events, plain and recurring masters, prefixed summaries; confirm `Events.list` and `Events.get` serializations agree | Phantom-divergence prevention (D4, L7) |
| V3 | Confirm `events.patch` merges per-key (sibling private properties survive a hash-only patch); measure the sent-form phantom-divergence rate and the resulting probe+patch overhead | Phase 1 storage lifecycle and L7 bounds rest on both behaviors |
| V4 | Initial-token policy: first run (and post-410) skips delta processing and records a baseline token after source syncs complete; document that pre-baseline mutations are out of reach | Phase 2 step 1, L6 |

### TestPlan additions

| ID | Priority | Scenario | Expected outcome |
|---|---|---|---|
| TP-SH-001 | P0 | User edits summary/time/location on a replica | Reverted to source state next run; hash refreshed; following run logs skip with zero writes |
| TP-SH-002 | P0 | User soft-deletes a replica | Restored to `confirmed` with source fields next run |
| TP-SH-003 | P1 | User edits a replica, then restores identical values | Hash-equal ⇒ skipped locally, zero API writes |
| TP-SH-004 | P0 | Source cancel + user delete of the same replica in one interval, exercised in both orders | Final state: replica absent; no oscillation across two runs |
| TP-SH-005 | P0 | User edits recurring master RRULE/fields | Master reverted next run |
| TP-SH-006 | P0 | User forks/edits a single instance ("Just this event") | Instance matched to source exception, or series canonicalized when no source exception exists |
| TP-SH-007 | P1 | User deletes an inherited (never-forked) occurrence | Documented limitation L3 behavior: no immediate repair, heals on next series touch |
| TP-SH-008 | P1 | Injected timeout during delta pass repairs | Token retained; next run completes repairs; no duplicate corrective writes |
| TP-SH-009 | P0 | Two sources sharing one destination; edits to replicas of each | Both detected and repaired independently via shared destination token |
| TP-SH-010 | P2 | User adds attendees/reminders to a replica (unmanaged fields) | No repair triggered; hash stable across runs |
| TP-SH-011 | P1 | Legacy replica lacking `replicaHash` surfaces in feed | Verifies clean, converges via props-only refresh, no content write |
| TP-SH-012 | P2 | User hard-deletes a replica | Accepted gap (§4): not restored automatically; deterministic recreation on next source change |
