# Copilot Instructions: Google Calendar Sync

This is a Google Apps Script project that implements one-way calendar synchronization from multiple source calendars to a single destination calendar.

## Build, Test, and Deploy

This project uses Google Apps Script as its runtime environment. There is no traditional build/test pipeline.

**Deployment:**
- Code is deployed directly to Google Apps Script using the Apps Script IDE or `clasp` CLI
- After deployment, manually execute the `orchestrateCalendarSync()` function once to initialize authentication scopes
- Set up an installable time-driven trigger to run `orchestrateCalendarSync()` every 15 minutes

**Testing:**
- No automated test suite is configured
- Test by manually running `orchestrateCalendarSync()` in the Apps Script IDE and checking the Execution Log

## Architecture Overview

### Hub-and-Spoke Model

The system uses a **hub-and-spoke architecture** where multiple source calendars sync to a single destination calendar. Each sync relationship is defined in `Config.gs`.

### Key Design Principles

1. **Incremental Sync with Tokens**: Uses Google Calendar API v3's `syncToken` mechanism to avoid re-processing unchanged events
2. **Deterministic ID Mapping**: Destination event IDs are computed from source IDs using the formula: `"src" + sourceId.toLowerCase().replace(/[^a-v0-9]/g, "")` to avoid database lookups
3. **Recurring Event Preservation**: Must use `singleEvents: false` to preserve recurring event structure and enable `syncToken` support
4. **Rule-Based Filtering**: Events are filtered and modified based on their summary text only

### File Structure

Apps Script loads `.gs` files alphabetically into a single global namespace. The recommended structure is:

- **`Config.gs`**: Human-editable configuration (calendar mappings, rules, constants)
- **`Main.gs`**: Orchestration layer with `orchestrateCalendarSync()` entry point
- **`SyncEngine.gs`**: Core API logic for processing events and reconciliation
- **`RuleEngine.gs`**: Text-based rule evaluation (regex matching, prefixes, skipping)
- **`Utils.gs`**: Deterministic helpers (ID generation, MD5 hashing, properties access)

### State Management

**PropertiesService** stores:
- `SYNC_TOKEN_[EncodedSourceCalendarId]`: Incremental sync tokens per source calendar
- `CONFIG_HASH`: MD5 hash of configuration to detect rule changes

**Extended Properties** on destination events store:
- `extendedProperties.private.sourceCalendarId`: Origin calendar identifier
- `extendedProperties.private.sourceEventId`: Original source event ID

### Sync States

1. **Normal Incremental Sync**: Processes changes since last `syncToken`
2. **Reconciliation Sync**: Triggered by `HTTP 410 Gone` (expired token) or config changes
   - Queries source calendar for past 7 days forward
   - Builds "AllowedSet" of events that pass current rules
   - Removes destination events not in AllowedSet (cleanup of deleted/now-skipped events)
   - Does NOT perform destructive wipes

## Critical Conventions

### Event ID Constraints

Google Calendar event IDs must match regex `^[a-v0-9]+$` (base32hex). The deterministic ID function must:
- Prefix with `"src"`
- Convert to lowercase
- Strip all non-base32hex characters: `sourceId.toLowerCase().replace(/[^a-v0-9]/g, "")`

### Loop Protection

**CRITICAL**: Always check for sync metadata at the top of `processSyncItem()`:

```javascript
if (item.extendedProperties?.private?.sourceCalendarId) {
  Logger.log(`Loop Guard: Skipping event "${item.summary}" - is a sync replica`);
  return;
}
```

This prevents infinite feedback loops if a destination calendar is accidentally used as a source.

### Recurring Event Handling

- **Master events**: Copy `item.recurrence` array directly to destination payload
- **Exception events**: Remap `recurringEventId` to destination space using the deterministic ID function, preserve `originalStartTime`
- **NEVER use `singleEvents: true`** - this breaks `syncToken` support

### Rule Engine Semantics

Rules in `Config.gs` are evaluated in order against the event summary (title) only:
- First matching rule wins
- If summary is `null` or missing, treat as empty string `''`
- `skip: true` causes event to be filtered out (and removed from destination if it exists)
- Matched rules can add a `prefix` to summary and change `colorId`

Example:
```javascript
rules: [
  { match: /\bEHS\b/i, prefix: '(Billy) ', colorId: '5' },
  { match: /\bBSS\b/i, prefix: '(Angie) ', colorId: '1' },
  { skip: true } // Catch-all: skip everything else
]
```

### Concurrency & Timeout Management

- Wrap execution in `LockService.getScriptLock().waitLock(30000)`
- Release lock in `finally` block
- Track start time and break loops at 5-minute mark: `if (new Date().getTime() - START_TIME > 300000) { break; }`
- Hard Apps Script limit: 6 minutes per execution

### Error Handling

- `HTTP 410 Gone`: Expired sync token → trigger reconciliation sync
- `404 Not Found` on event get: Event doesn't exist → use `insert()` instead of `update()`
- `status === 'cancelled'`: Remove from destination calendar

## API Requirements

- Advanced Calendar Service (`Calendar` API v3) must be enabled in Apps Script project settings
- Required OAuth scopes are initialized on first manual execution

## Code Review

All code changes must be reviewed before committing or merging to main — by the developer, a collaborator, or a Copilot sub-agent (e.g. the `code-review` agent). Do not commit unreviewed changes.

## Git Commit Conventions

All commits must include Copilot as co-author. Add this trailer to every commit message:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Design Documentation

See `/spec` directory for comprehensive technical specifications:
- **Design-and-Task-Plan.md**: System design, constraints, algorithms, and implementation phases
- **File-Structure.md**: Detailed rationale for file organization
- **Addenda-Loop-Protection.md**: Loop prevention guard clause details

**Important**: The spec documents were created through iterative conversation with Gemini and may contain:
- Inconsistencies in function/variable names (e.g., `processEventPayload` vs `processSyncItem`)
- Magic numbers in sample code that should be extracted to named constants in `Config.gs`

Treat specs as design guidance rather than exact implementation. Establish consistent naming conventions when implementing and replace all magic numbers (e.g., `300000` ms, `7` days) with descriptive constants.
