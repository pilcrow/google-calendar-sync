# TODO

## Open Questions

### Sync token behavior with multiple destinations from the same source

Sync tokens remain keyed only on `sourceCalendarId` (`SYNC_TOKEN_[encodedSrc]`).
Fan-out from a single source to multiple destinations is intentionally unsupported,
and configuration validation now aborts startup if a source appears in more than one
`CALENDAR_CONFIG` entry.

### Handle skip-filtered exception instances previously synced to destination

If an exception instance is excluded by rules, the corresponding destination exception
instance is removed. Rule changes are reconciled by reconciliation sync, which also
removes now-disallowed synced exceptions.

### Optimize reconciliation source interrogation to a single list pass

`executeReconciliationSync()` currently lists the source window to build `AllowedSet`,
then later calls `syncSourceWindow()` which lists the same source window again for
upserts and token refresh. Consider a one-pass source listing approach that builds
the allowed set and reuses captured source items for post-orphan-cleanup upserts.
