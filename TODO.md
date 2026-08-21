# TODO

## Open questions

- **Expose the last successful sync time.** `syncTime` is already persisted per
  source→destination pair and used by the sync engine. Decide whether it also
  needs a clearer operator-facing log or status report.
- **Tighten event logging.** Review the current per-pair start/completion logs,
  operation counts, and final API-call summary to decide whether fewer, wider
  messages would be easier to read.
- **Support named colors.** Rules currently accept numeric Google Calendar
  `colorId` values only. Decide whether names such as `Tomato` should also be
  accepted and documented.
- **Document deployment staging.** `npm run push <env>` already recreates
  `publish/` before invoking `clasp push`; clarify this in the setup
  documentation if operators need the behavior called out explicitly.

## Testing gap

### Add isolated `qualifyConfig()` unit tests

`test/IntegrationTest.gs` already covers `ActiveConfig`, state dismissal,
property persistence, and end-to-end sync behavior. There is still no focused
unit suite for `GCS.Config.qualifyConfig()` and its calendar-resolution
decision tree.

Add a small, dependency-free Node test harness that loads the real
`src/AppConfig.gs` source and uses a stubbed `calIterCalendars()` seam. Cover:

- unique name and literal-ID resolution, including `summaryOverride`;
- ambiguous, missing, duplicate, and same-calendar configurations;
- bounded calendar loading and pagination;
- stale-state reclaim boundaries, including missing `syncTime`;
- observable active/remembered/removed results and warning messages;
- `ScriptProperties.load()`/`store()` round-trip behavior.

Document the test command in `README.md` when the harness exists. Do not claim
that a Node test runner is currently configured.

## Feature proposals

### Destination self-heal

Implement the destination-delta monitoring and recovery behavior described in
[spec/destination-self-heal.md](spec/destination-self-heal.md). Use that
document as the implementation and rollout checklist.

### Sync deletion directive

Extend `CALENDAR_CONFIG` with an explicit directive such as `{ delete: true }`
that clears pair state and removes replicas previously created for that
source→destination pair. Define its precedence, safety behavior, and
re-addition semantics before implementation.
