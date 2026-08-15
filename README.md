# Google Calendar Sync

One-way synchronization from one or more Google Calendars into one or more destination calendars, using Google Apps Script. Events are filtered and labeled using configurable rules matched against event titles.

For architecture and implementation details, see [spec/Design.md](spec/Design.md).

## How It Works

The script is intended to run on a time-driven trigger (recommended: every 15 minutes) calling `main()` in `src/Main.gs`. Each source→destination mapping in `CALENDAR_CONFIG` is synced independently and sequentially:

1. **Incremental sync** — when a mapping has a stored sync token, only events changed since the last run are processed (Google Calendar's `syncToken`-based incremental sync).
2. **Baseline sync** — the fallback for a first run, a changed rules config, or an expired sync token. It rescans the source from `now − LOOKBACK_DAYS` (default: last 7 days) into the future, then removes destination replicas tagged for that source that were not re-synced in that window (deleted events, newly skip-filtered events, and copies older than the window).
3. Recurring events are preserved: the master series is copied and exceptions are applied to the matching destination instance.

Per-mapping state (sync token, config hash, last sync time) is stored in the script's UserProperties.

**Removing a mapping:** if you remove a mapping from `CALENDAR_CONFIG`, the script does *not* immediately delete the events it previously copied. The mapping's sync state is held for 30 days (`STATE_RECLAIM_DAYS`) in case you restore the mapping, then discarded. Previously copied events are left on the destination and are only cleaned up by a future baseline sync if the pair is re-added.

**Resolution failures:** if a configured calendar name or ID cannot be resolved (or a name matches more than one calendar), that mapping is skipped with a warning and the remaining mappings still sync. Mappings whose source and destination resolve to the same calendar are also skipped.

## Prerequisites

- A Google account with access to the source and destination calendars
- A [Google Apps Script](https://script.google.com) project (standalone)
- Optionally, [`clasp`](https://github.com/google/clasp) CLI for local development

## Setup

### 1. Copy and edit the configuration

```sh
cp src/Config.gs.example src/Config.gs
```

Edit `src/Config.gs` to specify your calendars and rules. For example:

```javascript
const CALENDAR_CONFIG = [
  {
    source: 'My Sports Calendar',      // display name or calendar ID
    destination: 'Family Calendar',    // display name or calendar ID
    rules: [
      { match: /\bVarsity\b/i, prefix: 'Abby: ', colorId: 5 },
      { match: /\bJV\b/i,      prefix: 'Bob: ',  colorId: 1 },
      { skip: true }                   // skip everything else
    ]
  }
];
```

Optional overrides (shown commented out in `src/Config.gs.example`):

- `API_PAGE_SIZE` — events fetched per API request (default 250)
- `LOOKBACK_DAYS` — how far back a baseline sync looks (default 7)

**Calendar references** may be the display name shown in the Google Calendar UI, or the raw calendar ID. If a name matches more than one calendar, the pair is skipped with a warning.

**Rule semantics:**

- Rules are evaluated in order; the first match wins
- `match` — a RegExp tested against the event title; omit for a catch-all
- `prefix` — prepended to the event title on the destination
- `colorId` — overrides the event color on the destination (see table below)
- `skip: true` — event is not synced (and removed from destination if previously synced)

**Google Calendar color IDs:**

| ID | Name      | Color        |
|----|-----------|--------------|
| 1  | Lavender  | Pale blue    |
| 2  | Sage      | Light green  |
| 3  | Grape     | Mauve        |
| 4  | Flamingo  | Pale red     |
| 5  | Banana    | Yellow       |
| 6  | Tangerine | Orange       |
| 7  | Peacock   | Cyan         |
| 8  | Graphite  | Light gray   |
| 9  | Blueberry | Blue         |
| 10 | Basil     | Green        |
| 11 | Tomato    | Bold red     |

### 2. Deploy to Apps Script

**Using clasp (recommended):**

```sh
clasp push
```

**Using the Apps Script IDE:** Create a script file for each `src/*.gs` file and paste in the contents.

### 3. Enable the Advanced Calendar Service

In the Apps Script project: **Services → Calendar API → Add**. This enables the Calendar v3 API required for advanced operations.

### 4. Authorize

In the Apps Script IDE, open `Main.gs` and run `main()` once manually. Accept the OAuth prompts to initialize all required scopes.

### 5. Set up a trigger

In the Apps Script IDE: **Triggers → Add Trigger**:

- Function: `main`
- Event source: Time-driven
- Interval: Every 15 minutes

## Limitations

- **Multi-destination support:** A source calendar may be configured to sync to multiple destinations. State is tracked per source→destination pair, and the engine preserves per-pair sync tokens and config hashes. Operators should be aware that a misconfigured mapping may require manual inspection.
- **Full syncs clean up stale replicas:** A full (baseline) sync scans the lookback window (default: last 7 days plus future) and then removes any previously-copied destination events tagged for that source that were not re-synced in that window — including copies older than the window and items that now match `skip`.
- **Removing a mapping leaves its copies behind:** copies are only cleaned up by a future baseline sync after the mapping is re-added (see "How It Works").
