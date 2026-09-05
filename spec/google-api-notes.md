# Google Apps Script / Calendar API Notes

Quick operational reference for this repository.

These notes are intentionally non-authoritative. Quotas and limits can vary by account type, Workspace settings, API, and over time. Use official Google documentation as the source of truth for exact current numbers.

## Constraints this project is built around

1. Apps Script executions have a hard runtime limit; free Google Workspace/Apps Script runs are commonly capped at about six minutes, while paid Workspace editions can allow about 30 minutes. This project targets a 5-minute safety budget (`EXECUTION_TIMEOUT_MS`) inside that limit.
2. Triggered executions can suffer a cold-start delay before the script body begins running. In our observations, startup is typically under 1 second, almost always under 10 seconds, and occasionally as high as about 40 seconds.
3. Some runs do not execute at all because Google returns a server-side execution error before the script starts. In one observed case, an execution lasted about eight minutes and logged only `"We're sorry, a server error occurred. Please wait a bit and try again."` This is infrastructure/platform failure, not a project-level timeout.
4. Only one orchestration run should operate at a time (`LockService.getScriptLock()`).
5. Calendar writes are paced (`WRITE_PACING_DELAY_MS`) to reduce quota pressure.
6. Incremental sync relies on `syncToken`; token expiration (`HTTP 410`) triggers reconciliation.
7. `singleEvents` must stay `false` on `Events.list` calls so incremental sync remains supported.

See `spec/Design.md` for implementation-level behavior and invariants.

## Recurring event exception instances

- The Events resource schema marks `recurringEventId` and `originalStartTime` **Immutable**, but annotates the nested `originalStartTime.date/dateTime/timeZone` sub-fields writable; the `events.insert` reference likewise lists `originalStartTime.date/dateTime/timeZone` as writable request-body properties and does not list `recurringEventId` at all. These annotations are internally inconsistent; treat them as unreliable for the exception flow.
- An exception is created or cancelled by addressing the instance and calling `events.update()` on it (the retrieve-then-update flow the recurring-events guide documents). On a calendar where the master series exists, every instance is addressable by its ID `<masterId>_<originalStartTime>` — including instances that are still derived (not yet exceptions) — so an update on that ID materializes the exception. This project's exception flow is update-only (`processExceptionSyncItem()` in `src/SyncEngine.gs`). Inserting with `recurringEventId`/`originalStartTime` set and `id` omitted is an alternative some sync tooling uses — empirically confirmed to work and to assign the canonical instance ID (see "Empirically verified API behaviors") — but the current reference does not list `recurringEventId` as a writable insert property, and this project does not rely on it. The recurring-events guide's cancel example echoes `recurringEventId`/`originalStartTime` back in the PUT body only because it sends a full instance representation.
- The base32hex custom-ID rule (`[a-v0-9]`, length 5-1024) constrains only IDs supplied by the caller to `events.insert`. Google-generated IDs are exempt and legitimately contain underscores (`<masterId>_<timestamp>`); instance IDs are therefore never provided to insert — destination instances are addressed by their computed ID and updated in place, never inserted (see Design.md §6.2).
- Instance IDs follow `<masterId>_<timestamp>`. Source event IDs can themselves contain underscores (imported `c_...` IDs), so exception suffix extraction must slice at the master ID length, not split on `_`.

## Empirically verified API behaviors

Confirmed against a live calendar on 2026-08-06. Evidence: `Test.gs` (repo root, standalone, not clasp-deployed) and its run log `Cal-Exceptions.log`. The exception flow in this project is built on these results.

- **Derived instances are addressable by GET.** On a calendar where the master series exists, `events.get()` resolves `<masterId>_<originalStartTime>` even for instances never materialized as exceptions, and the returned object already carries `recurringEventId`/`originalStartTime`.
- **`events.update()` on the computed instance ID materializes the exception.** No `recurringEventId`/`originalStartTime` in the body is required; the API fills them in from the instance being addressed.
- **Instance-ID timestamps are UTC.** The suffix is `<masterId>_YYYYMMDDTHHMMSSZ` in UTC. Addressing an instance with a local/display-time timestamp (e.g. `20260806T040000Z` when the display is `04:00-05:00`) 404s.
- **`update()` is a full PUT.** A partial body such as `{status:'cancelled'}` is rejected with `400 reason=required "Missing end time."`. Cancels and resurrects must send the full fetched resource with only the `status` changed.
- **`sequence` is enforced.** An update carrying a stale `sequence` (below the current value) is rejected with `400 reason=invalid` and not applied. Always re-fetch before an update; reusing an older GET snapshot to cancel/resurrect fails.
- **Removal is a soft delete.** `events.remove()` on an existing event/instance succeeds but a later `events.get()` returns `200` with `status:'cancelled'` (not 404/410). Removing the master soft-cancels the whole series the same way. Existence checks must treat `status === 'cancelled'` as absent.
- **404 vs 410.** `404 reason=notFound` means the resource (or its master) never existed. `410 reason=deleted` on remove means it was already deleted/soft-cancelled. `remove()` error tolerance must include both.
- **Read-only fields are ignored, not rejected, on update.** Sending a bogus `recurringEventId` in an update body is accepted; the server keeps the real value.
- **`insert()` refuses instance-style IDs.** Caller-supplied IDs must satisfy the base32hex charset `[a-v0-9]` (length 5-1024). Any ID containing `_` — including an otherwise-canonical `<masterId>_<timestamp>` — is rejected with `400 reason=invalid "Invalid resource id value."`. Instance IDs are never passed to `insert()`.
- **`insert()` with `recurringEventId` + `originalStartTime` and no `id` creates the exception and assigns the canonical instance ID.** A cancelled exception can be inserted the same way with `status:'cancelled'`.
- **Cancelled instances come back sparse.** In `singleEvents:false` list results (this project's sync mode), cancelled exceptions appear as separate items containing `id`, `status`, `recurringEventId`, `originalStartTime` — but no `summary`/`start`/`end`. The `id` and `recurringEventId` are still present, so the computed instance ID remains derivable.
- **List/instance queries hide cancelled instances by default.** `events.instances()` and `events.list({singleEvents:true})` omit cancelled/removed instances unless `showDeleted:true`.

### Empirically observed error codes

| Call | Condition | Code | Reason | Message |
|---|---|---|---|---|
| get/update/remove | resource (or its master) never existed | 404 | `notFound` | Not Found |
| get | no such occurrence (valid ID format) | 404 | `notFound` | Not Found |
| remove | already cancelled/removed | 410 | `deleted` | Resource has been deleted |
| get/update/remove | existed but soft-deleted | 200 | — | response `status:'cancelled'` |
| insert | underscore / instance-style id | 400 | `invalid` | Invalid resource id value. |
| update | partial body (missing `end`) | 400 | `required` | Missing end time. |
| update | stale `sequence` | 400 | `invalid` | Invalid sequence value. … Re-fetch the resource and use its sequence number … |

## Quota-aware practices for contributors

1. Prefer incremental sync with persisted state over repeated full-window scans.
2. Keep API page size high enough to reduce request count (`API_PAGE_SIZE`; default runtime fallback is 250 when unset).
3. Handle retriable quota/rate-limit errors explicitly when adding new write-heavy paths.
4. Keep idempotent deterministic IDs so retries do not create duplicates.
5. Preserve graceful timeout exits so partial progress can resume on next trigger.

## Future work: if adding webhook or web app ingestion later

The current architecture is trigger-driven, not webhook-driven. If webhook ingestion is introduced:

1. Keep request handlers fast and side-effect light.
2. Queue work and process asynchronously under the same lock/timeout discipline.
3. Add backpressure and retry behavior for burst traffic.
