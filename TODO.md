# TODO

## Open Questions

### Sync token behavior with multiple destinations from the same source

Sync tokens remain keyed only on `sourceCalendarId` (`SYNC_TOKEN_[encodedSrc]`).
Fan-out from a single source to multiple destinations is intentionally unsupported,
and configuration validation now aborts startup if a source appears in more than one
`CALENDAR_CONFIG` entry.

### Optimize reconciliation source interrogation to a single list pass

`executeReconciliationSync()` currently lists the source window to build `AllowedSet`,
then later calls `syncSourceWindow()` which lists the same source window again for
upserts and token refresh. Consider a one-pass source listing approach that builds
the allowed set and reuses captured source items for post-orphan-cleanup upserts.

### Destination self-heal implementation follow-up

Self-heal design details now live in `spec/destination-self-heal.md`.
Use that spec as the implementation checklist for destination-delta monitoring,
recovery behavior, and rollout/migration steps.
