# System Design Document: Multi-Source to Single-Destination Google Calendar Sync

This document provides a comprehensive technical specification for an automated, one-way synchronization engine built inside Google Apps Script. It is optimized as a direct system prompt for generative coding assistants (Gemini Code Assist, GitHub Copilot, Claude Code).

---

## 1. System Overview & Purpose

The purpose of this script is to sync events from one or more **Source Google Calendars** into a single **Destination Google Calendar** using a hub-and-spoke model. The script runs periodically via an installable time-driven trigger.

To conserve API quotas and performance, it relies on incremental sync states (`syncToken`). It preserves the structural formatting of recurring events and applies an inline deterministic rule engine to alter or skip events based **strictly** on a string evaluation of the event's **summary (title) only**.

---

## 2. Core Constraints & Technical Parameters

* **Execution Time Limit:** 6 minutes per runtime instance (hard Google infrastructure cap).
* **Volumetric Bounds:** Scaled for up to 200 events per source calendar.
* **Time Bounds (Initial Sync):** From 7 days in the past to infinity: `[Current Time - 7 days, forward)`.
* **API Mode:** Advanced Calendar Service must be enabled (`Calendar` V3 architecture).
* **API Parameter Rules:** `singleEvents` must be set to `false`. This is a non-negotiable requirement to enable the use of `syncToken`.

---

## 3. Data Schema & Architecture

### A. Deterministic Event ID Mapping

To avoid slow database searches, all destination event IDs must be computed deterministically from the source event ID.

* **Google Event ID Constraint (Base32hex):** Target IDs must match regex `^[a-v0-9]+$`. No capitals, symbols, hyphens, or characters past `v`.
* **Algorithm:** `destId = "src" + sourceEventId.toLowerCase().replace(/[^a-v0-9]/g, "")`

### B. State Tracking via Private Extended Attributes

Every event written to the destination calendar must embed metadata in its `extendedProperties.private` object:

* `sourceCalendarId`: String identifier of the originating calendar.
* `sourceEventId`: String identifier of the original source event.

### C. Persistent Storage Configuration

Using `PropertiesService.getScriptProperties()`, track the following keys:

* `SYNC_TOKEN_[Encoded_Source_Calendar_Id]`: The string `nextSyncToken` returned by Google.
* `CONFIG_HASH`: An MD5 digest text hash of the structural configurations to automatically identify rule modifications.

---

## 4. System Configuration Specification

The script relies on a schema file (`Config.gs`) structured as follows. The rule engine evaluates the `summary` string text only:

```javascript
const CALENDAR_CONFIG = [
  {
    source: 'sportsYou Calendar ID or Email',
    destination: 'Target Calendar ID',
    rules: [
      { match: /\bEHS\b/i, prefix: '(Billy) ', colorId: '5' }, // First match wins
      { match: /\bBSS\b/i, prefix: '(Angie) ', colorId: '1' },
      { skip: true } // Catch-all option: skips everything else
    ]
  }
];

```

---

## 5. Algorithmic State Machine

### A. Core Synchronization Routing Logic

For each source calendar event processed inside the sync payload:

1. **Check Native Status:** If `item.status === 'cancelled'`, execute `Calendar.Events.remove(destCalendarId, destId)` and exit block.
2. **Evaluate Rule Engine:** Run the event's `summary` through `rules`. If `summary` is missing or empty, treat it as an empty string `''`.
* If a rule results in `skip: true`, execute `Calendar.Events.remove(destCalendarId, destId)` to clean up potential newly banned events, then exit block.
* If a rule matches mutations, append `prefix` to the summary and apply the new `colorId`.


3. **Handle Recurring Architecture (`singleEvents: false`):**
* **Master Event:** If `item.recurrence` exists, map the array directly to the destination payload object.
* **Exception Event:** If `item.recurringEventId` exists, remap the pointer to the destination parent space: `destEvent.recurringEventId = "src" + item.recurringEventId.toLowerCase().replace(/[^a-v0-9]/g, "")`. Map the original `item.originalStartTime`.


4. **Upsert Execution:** Attempt a `Calendar.Events.get(destCalendarId, destId)`. On success, execute `update()`; on a caught `404 Not Found` error, execute `insert()`.

### B. Stale Token & Config Change Reconciliation Sync

If an execution encounters an **`HTTP 410 Gone`** error (expired sync token) OR if `checkConfigChange()` yields true:

1. Do **not** perform a destructive wipe of the destination calendar.
2. Call `Calendar.Events.list()` on the source calendar for `[now - 7d, inf)` *without* a token. Pass each event's summary through the rule engine. If it passes (not skipped), add its deterministic target ID to an in-memory `AllowedSet`.
3. Query the destination calendar for all events containing the specific `extendedProperties.private.sourceCalendarId`.
4. Loop through those destination results: If a destination event's ID is **not** present in your `AllowedSet`, it represents a ghost event that was deleted or skipped while the pipeline was blind. Instantly execute `Calendar.Events.remove()`.
5. For all items remaining inside `AllowedSet`, execute a standard upsert pass to update timestamps/text content.
6. Commit the fresh `nextSyncToken` to the persistent properties database.

### C. Concurrency and Timeout Defense

1. Wrap the global execution loop inside `LockService.getScriptLock().waitLock(30000)`.
2. At the start of every calendar-specific loop block, evaluate the execution clock: `if (new Date().getTime() - START_TIME > 300000) { break; }` (5-minute safety threshold).
3. Always clear the concurrency lock inside a `finally` block to protect future run executions.

---

# Implementable Task Plan

### Phase 1: Environment Setup & Configuration Configuration

* [ ] Enable the Advanced Calendar Service (`Calendar` API v3) inside the Apps Script project.
* [ ] Build `Config.gs` detailing the `CALENDAR_CONFIG` array schema including regex rules, prefixes, color ids, and catch-all skips.
* [ ] Write a utility function `generateMd5Hash(string)` to create a string fingerprint of the configuration block.

### Phase 2: Core ID and Rule Utility Engines

* [ ] Code `getDeterministicId(sourceId)` ensuring character sanitization strictly adheres to the `^[a-v0-9]+$` base32hex restriction.
* [ ] Code `evaluateRules(summary, rules)` which takes the event summary string (defaulting to `''` if null), iterates through the array rules, evaluates the regex parameters, and returns an object detailing actions (`skip`, `prefix`, `colorId`).

### Phase 3: Token State and Time Management

* [ ] Code `checkConfigChange()` to evaluate the current configuration state against the stored configuration hash property, returning a boolean indicator.
* [ ] Write helper functions to handle getting and setting `SYNC_TOKEN_[ID]` values inside the script property database.

### Phase 4: Core Sync and Reconciliation Operations

* [ ] Code `processEventPayload(item, config, destCalendarId)` implementing the core sync logic (handling cancellations, running summary rules, mapping master rules, remapping exception parents, and executing `get` $\rightarrow$ `update`/`insert`).
* [ ] Code the `executeReconciliationSync(sourceId, destId, config)` function to manage the in-memory array differential logic when a token is invalidated or rules are modified, ensuring skipped rules are factored out of the `AllowedSet`.

### Phase 5: Execution Orchestration and Trigger Deployment

* [ ] Construct the primary runner function `orchestrateCalendarSync()`. Implement the global `LockService` routines and structural runtime clock audits.
* [ ] Wrap the calendar loop inside a robust `try...catch` sequence that intercepts `410 Gone` errors to cleanly shift into the reconciliation engine pipeline.
* [ ] Manually execute the runner once to initialize authentication scopes and verify functionality, then configure an automated 15-minute installable time-driven project trigger.
