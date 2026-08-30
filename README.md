# Google Calendar Sync

A Google Apps Script that copies events one way from source calendars to
destination calendars. Rules can prefix, recolor, or skip events based on their
titles.

## What it does

Run `main()` from a time-driven trigger (every 15 minutes is recommended).
Mappings are processed sequentially. An unexpected error can abort the current
run, so later mappings may wait until the next trigger.

- **Incremental sync:** after the first successful sync, a stored Google
  Calendar sync token limits processing to changed events.
- **Baseline sync:** the first run, a rules change, or an expired token scans
  `LOOKBACK_DAYS` into the past and all future events. It then removes tagged
  destination copies that were not found in that window, including deleted or
  newly skipped events and copies older than the window.
- **Recurring events:** recurring masters and modified or cancelled instances
  are synchronized.
- **Per-pair state:** sync tokens, configuration hashes, and last successful
  sync times are stored in Apps Script UserProperties.

If a calendar name is missing or ambiguous, only that mapping is skipped with a
warning. A source and destination that resolve to the same calendar are also
skipped.

Removing a mapping does **not** delete its existing destination copies. State is
held for 30 days (`STATE_RECLAIM_DAYS`) so a renamed or removed mapping can be
restored; after that, the state is discarded and the copies remain until the
mapping is re-added and a baseline sync reconciles them.

## Prerequisites

- A Google account with access to every source and destination calendar.
- A standalone Google Apps Script project for the environment you will run.
- For CLI deployment: Git, Node.js/npm, and [`clasp`](https://github.com/google/clasp)
  (installed by this project's npm dependencies).

## Production setup

### 1. Get the project and install dependencies

From a local checkout:

```sh
npm install
npx clasp login
```

`npx clasp login` authenticates the Google account that owns or can edit the
target Apps Script project. The deployment command below uses the local clasp
dependency installed by npm.

### 2. Create or choose a standalone Apps Script project

Create a project at [script.google.com](https://script.google.com) and copy its
script ID from **Project Settings**. Save that ID in:

```text
envs/<env>/scriptId
```

For a production deployment, use `envs/prod`. Keep production and test
projects separate. Do not run the integration test suite against production.

### 3. Configure calendars and rules

Create the environment configuration:

```sh
cp envs/prod/Config.gs.example envs/prod/Config.gs
```

Edit `envs/prod/Config.gs`:

```javascript
const CALENDAR_CONFIG = [
  {
    source: 'My Sports Calendar',
    destination: 'Family Calendar',
    rules: [
      { match: /\bVarsity\b/i, prefix: 'Abby: ', colorId: 5 },
      { match: /\bJV\b/i,      prefix: 'Bob: ',  colorId: 1 },
      { skip: true }
    ]
  }
];
```

`source` and `destination` may be calendar IDs or display names. A name is
matched against both the calendar's title and its user-specific
`summaryOverride`; use an ID when names are not unique.

Rules are evaluated in order and the first match wins:

- `match` is a regular expression tested against the event title. Omit it for
  a catch-all rule.
- `prefix` is prepended to the destination title.
- `colorId` is a numeric Google Calendar color ID.
- `skip: true` prevents synchronization and removes a previously synced copy
  during a baseline sync.

Optional settings in `Config.gs`:

- `API_PAGE_SIZE` — events per API request; default `250` (maximum `250`).
- `LOOKBACK_DAYS` — days of history included by a baseline sync; default `7`.

Changing `LOOKBACK_DAYS` changes the scope of baseline cleanup. It does not
change incremental-sync behavior.

### 4. Deploy

With npm and clasp:

```sh
npm run push prod
```

The command recreates `publish/`, stages `src/*.gs` plus the selected
environment's `Config.gs`, and pushes that staged project to the script ID in
`envs/prod/scriptId`. Test environments marked with an `envs/<env>/TEST` file
also receive the `test/` directory and that environment's `TestConfig.gs`.

The generated `publish/` directory is temporary and ignored by Git.

Alternatively, in the Apps Script IDE, create one file for each `src/*.gs` file
and copy the contents of the selected environment's `Config.gs` into
`Config.gs`.

### 5. Enable the Apps Script API

CLI deployment also requires the Apps Script API. Enable it in the Google
account settings at
[script.google.com/home/usersettings](https://script.google.com/home/usersettings).

### 6. Enable the Calendar API

The repository manifest already declares the Calendar v3 advanced service. In
the Apps Script editor, open **Services**, choose **Add a service**, and add
**Calendar API**. If Google prompts you to enable the corresponding Google
Cloud API, enable it for the project.

### 7. Authorize and verify a first run

In the Apps Script editor, select `main` and click **Run**. Accept the requested
permissions. Review the execution log and confirm that the expected number of
pairs completed without resolution or API errors.

Check the destination calendar for copied events, prefixes, colors, and
recurring instances. The script records per-pair operation counts and a final
API-call summary in the execution log.

### 8. Schedule synchronization

In **Triggers → Add Trigger**, configure:

- Function: `main`
- Event source: **Time-driven**
- Interval: **Every 15 minutes**

## Google Calendar color IDs

| ID | Name | Color |
|---:|---|---|
| 1 | Lavender | Pale blue |
| 2 | Sage | Light green |
| 3 | Grape | Mauve |
| 4 | Flamingo | Pale red |
| 5 | Banana | Yellow |
| 6 | Tangerine | Orange |
| 7 | Peacock | Cyan |
| 8 | Graphite | Light gray |
| 9 | Blueberry | Blue |
| 10 | Basil | Green |
| 11 | Tomato | Bold red |

## Operational notes and limitations

- A source can sync to multiple destinations. State is tracked separately for
  each source-to-destination pair.
- A baseline sync removes only destination events tagged as copies from that
  source. It does not remove unrelated events created manually.
- A baseline sync can remove managed copies that are outside the configured
  lookback window or now match `skip`.
- Removed mappings leave their copies behind as described above; there is no
  automatic cleanup for a mapping that no longer exists.
- The script uses a lock and a soft execution-time limit. If a run stops before
  completion, the next trigger retries unfinished work.

## Developer notes

The source is in `src/`; environment-specific configuration is in `envs/`.

```sh
npm run prep-dist prod  # stage without pushing
npm run push prod       # stage and push with clasp
npm run clean           # remove generated publish/
```

For architecture and state details, see [spec/Design.md](spec/Design.md).
Integration tests live in [test/IntegrationTest.gs](test/IntegrationTest.gs)
and should run only in a non-production Apps Script project.
