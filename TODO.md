# TODO

## Open Questions

### Sync token behavior with multiple destinations from the same source

Sync tokens are keyed only on `sourceCalendarId` (`SYNC_TOKEN_[encodedSrc]`).
If the same source calendar is synced to two different destinations
(e.g., `srcFoo → dstBar` and `srcFoo → dstQuux`), does one pair consume or
reset the token in a way that breaks the other? Needs analysis before
supporting that configuration.

### Implement recurring exception event handling

Exception instances (source events where `item.recurringEventId` is set) are
currently copied to the destination without remapping their parent pointer.
This leaves `recurringEventId` pointing at the source master event ID, which
does not exist in the destination calendar.

Required changes in `buildDestinationEvent` (`SyncEngine.gs`):

```javascript
if (sourceEvent.recurringEventId) {
  destEvent.recurringEventId = getDestinationEventId(sourceCalendarId, sourceEvent.recurringEventId);
}
if (sourceEvent.originalStartTime) {
  destEvent.originalStartTime = sourceEvent.originalStartTime;
}
```

Also marked in `copilot-instructions.md` (Recurring Event Handling section)
with a ⚠️ NOT YET IMPLEMENTED warning.

### Consolidate duplicate page-size constants

`MAX_RESULTS_PER_PAGE = 250` (`SyncEngine.gs`) and `CALENDAR_LIST_MAX_RESULTS = 250`
(`Utils.gs`) are identical. Consolidate into a single constant in `Config.gs`
(or `Utils.gs`) and update both references.

### Loop guard in reconciliation should warn

`executeReconciliationSync` silently `continue`s when it encounters a sync
replica (loop guard). `processSyncItem` fires a `console.warn` in the same
case. Reconciliation should also warn for consistency and visibility.
