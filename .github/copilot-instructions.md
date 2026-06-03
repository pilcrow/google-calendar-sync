# Copilot Instructions: Google Calendar Sync

One-way Google Calendar synchronization via Google Apps Script. For usage and setup, see [README.md](../README.md). For architecture and implementation reference, see [spec/Design.md](../spec/Design.md).

## Build, Test, and Deploy

This project uses Google Apps Script as its runtime environment. There is no traditional build/test pipeline.

**Deployment:**
- Code is deployed directly to Google Apps Script using the Apps Script IDE or `clasp` CLI
- After deployment, manually execute the `orchestrateCalendarSync()` function once to initialize authentication scopes
- Set up an installable time-driven trigger to run `orchestrateCalendarSync()` every 15 minutes

**Testing:**
- No automated test suite is configured
- Test by manually running `orchestrateCalendarSync()` in the Apps Script IDE and checking the Execution Log

## Code Review

All code changes must be reviewed before committing or merging to main — by the developer, a collaborator, or a Copilot sub-agent (e.g. the `code-review` agent). This applies to all changes, including one-liners. Do not commit unreviewed changes.

When selecting a review model, match depth to the change: Haiku for small/simple changes; Sonnet or Opus for architectural or multi-file changes.

## Git Commit Conventions

All commits must include Copilot as co-author. Add this trailer to every commit message:

```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```
