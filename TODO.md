# TODO

## Open Questions

### Sync token behavior with multiple destinations from the same source

Sync tokens are keyed only on `sourceCalendarId` (`SYNC_TOKEN_[encodedSrc]`).
If the same source calendar is synced to two different destinations
(e.g., `srcFoo → dstBar` and `srcFoo → dstQuux`), does one pair consume or
reset the token in a way that breaks the other? Needs analysis before
supporting that configuration.

### Handle skip-filtered exception instances previously synced to destination

If an exception instance was previously synced to the destination and a subsequent
sync determines it should be skipped (by rules), `processExceptionSyncItem` currently
treats it as a no-op. Correct behavior would restore the occurrence to its unmodified
state as defined by the master series. Implementing this requires knowing which
exceptions have been synced and calling `Calendar.Events.update` with the master's
event data to reset that slot.
