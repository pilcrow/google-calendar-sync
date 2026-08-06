# Google Apps Script / Calendar API Notes

Quick operational reference for this repository.

These notes are intentionally non-authoritative. Quotas and limits can vary by account type, Workspace settings, API, and over time. Use official Google documentation as the source of truth for exact current numbers.

## Constraints this project is built around

1. Apps Script executions have a hard runtime limit; this project targets a 5-minute safety budget (`EXECUTION_TIMEOUT_MS`) inside that limit.
2. Only one orchestration run should operate at a time (`LockService.getScriptLock()`).
3. Calendar writes are paced (`WRITE_PACING_DELAY_MS`) to reduce quota pressure.
4. Incremental sync relies on `syncToken`; token expiration (`HTTP 410`) triggers reconciliation.
5. `singleEvents` must stay `false` on `Events.list` calls so incremental sync remains supported.

See `spec/Design.md` for implementation-level behavior and invariants.

## Recurring event exception instances

- The Events resource schema marks `recurringEventId` and `originalStartTime` **Immutable**, but annotates the nested `originalStartTime.date/dateTime/timeZone` sub-fields writable; the `events.insert` reference likewise lists `originalStartTime.date/dateTime/timeZone` as writable request-body properties and does not list `recurringEventId` at all. These annotations are internally inconsistent; treat them as unreliable for the exception flow.
- An exception is created or cancelled by addressing the instance and calling `events.update()` on it (the retrieve-then-update flow the recurring-events guide documents). On a calendar where the master series exists, every instance is addressable by its ID `<masterId>_<originalStartTime>` — including instances that are still derived (not yet exceptions) — so an update on that ID materializes the exception. This project's exception flow is update-only (`processExceptionSyncItem()` in `src/SyncEngine.gs`). Inserting with `recurringEventId`/`originalStartTime` set and `id` omitted is an alternative some sync tooling uses, but the current reference does not list `recurringEventId` as a writable insert property, and this project does not rely on it. The recurring-events guide's cancel example echoes `recurringEventId`/`originalStartTime` back in the PUT body only because it sends a full instance representation.
- The base32hex custom-ID rule (`[a-v0-9]`, length 5-1024) constrains only IDs supplied by the caller to `events.insert`. Google-generated IDs are exempt and legitimately contain underscores (`<masterId>_<timestamp>`); instance IDs are therefore never provided to insert — destination instances are addressed by their computed ID and updated in place, never inserted (see Design.md §6.2).
- Instance IDs follow `<masterId>_<timestamp>`. Source event IDs can themselves contain underscores (imported `c_...` IDs), so exception suffix extraction must slice at the master ID length, not split on `_`.

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
