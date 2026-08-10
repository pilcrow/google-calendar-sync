// vim: set ft=javascript ts=2 sw=2 et:

// Load bearing in timeCheck; ala perl's $^T
const SCRIPT_BASETIME = Date.now();

// Gracefully shutdown after 5m 15s execution
// (Google free environment provides 6m execution)
const SCRIPT_TIMEOUT_MS = 315000;

// How long to wait for concurency lock
const SCRIPT_LOCK_TIMEOUT_MS = 30000;
