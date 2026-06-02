# TODO

## Open Questions

### Sync token behavior with multiple destinations from the same source

Sync tokens are keyed only on `sourceCalendarId` (`SYNC_TOKEN_[encodedSrc]`).
If the same source calendar is synced to two different destinations
(e.g., `srcFoo → dstBar` and `srcFoo → dstQuux`), does one pair consume or
reset the token in a way that breaks the other? Needs analysis before
supporting that configuration.
