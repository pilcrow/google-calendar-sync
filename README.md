# Google Calendar Sync

One-way synchronization from one or more Google Calendars into a single destination calendar, using Google Apps Script. Events are filtered and labeled using configurable rules matched against event titles.

For architecture and implementation details, see [spec/Design.md](spec/Design.md).

## How It Works

The script runs on a 15-minute time-driven trigger. It uses Google Calendar's incremental sync (`syncToken`) to process only changed events, preserving recurring event structure. Each source→destination mapping is independent and rule-driven.

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

In the Apps Script IDE, open `Main.gs` and run `orchestrateCalendarSync()` once manually. Accept the OAuth prompts to initialize all required scopes.

### 5. Set up a trigger

In the Apps Script IDE: **Triggers → Add Trigger**:
- Function: `orchestrateCalendarSync`
- Event source: Time-driven
- Interval: Every 15 minutes

## Limitations

- **One-to-one source mapping only:** The same source calendar must not appear in more than one `CALENDAR_CONFIG` entry. Sync tokens are keyed by source only, so fan-out is unsupported. The script validates this at startup and aborts if duplicates are configured.
- **Skip-filtered exception cleanup:** If a recurring event exception is later excluded by a rule change, it is removed during the next reconciliation sync (which the rule change triggers automatically), not immediately during incremental sync.
