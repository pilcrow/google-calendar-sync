# Rate Limit Exceeded

## Summary
During `orchestrateCalendarSync`, rapid `events.delete` calls against a single destination calendar triggered Google Calendar API `Rate Limit Exceeded`, causing the sync run to abort mid-pair.

## Remediation Plan
1. Add per-write pacing (e.g., short `Utilities.sleep(...)`) around mutation-heavy operations.
2. Wrap write/delete calls in targeted exponential backoff retry for rate-limit errors only.
3. Prefer smaller, sequential batches (if batching is ever added) with delays between batches.
