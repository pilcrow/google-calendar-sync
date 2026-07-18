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
