// vim: set ft=javascript ts=2 sw=2 et:

// Load bearing in timeCheck; ala perl's $^T
const SCRIPT_BASETIME = Date.now();

// Gracefully shutdown after 5m 15s execution
// (Google free environment provides 6m execution)
const SCRIPT_TIMEOUT_MS = 315000;

// How long to wait for concurency lock
const SCRIPT_LOCK_TIMEOUT_MS = 30000;

// How long (in days) to hold stored sync state for a pair that no longer
// resolves to an active config, giving time to fix a renamed or re-added
// calendar before the pair's state is dismissed.
const STATE_RECLAIM_DAYS = 30;

// Namespace root — generic/cross-cutting symbols live here;
// production engine functions and cal* wrappers stay flat.
const GCS = { Config: {}, Utils: {}, Rules: {} };
