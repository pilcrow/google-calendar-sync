# TODO

## Testing

### qualifyConfig has no unit tests

`qualifyConfig()` (`src/AppConfig.gs`) implements a large decision tree — active,
ambiguous, absurd, zero-match, duplicate-key, and `STATE_RECLAIM_DAYS` stale-state
dismissal — but nothing exercises it in a test. `Test.gs` deliberately avoids
project code (Calendar API probes only), and no harness covers `qualifyConfig` or
the `RuntimeConfig`/`ActiveConfig`/`InactiveConfig` classes. Add unit tests for
the classifier before relying on its behavior.

## Open Questions

### Feature? Destination self-heal implementation follow-up

Self-heal design details now live in `spec/destination-self-heal.md`.
Use that spec as the implementation checklist for destination-delta monitoring,
recovery behavior, and rollout/migration steps.

### Feature? sync deletion keyword

Extend CALENDAR_CONFIG to support a new configuration directive which would
clear state and clear any replicas previously synced from that source/dest
pair. (e.g., `delete: true`)
