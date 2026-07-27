# Environment Deployment Plan (`envs/<env>` + staged `dist/`)

This document captures the environment/deployment planning notes previously kept in session state so future sessions and non-Copilot tooling can review and critique the approach.

## Goal

Provide a safe, minimal-dependency deployment/testing workflow for clasp that supports multiple environments without changing end-user calendar configuration semantics.

## Context

1. Runtime is Google Apps Script; source of truth remains `src/`.
2. Deployments should target explicit environments (test/prod/etc.).
3. Environment content may be materialized externally and copied into repo workspace as needed.
4. Default behavior should include tests unless an environment explicitly excludes them.

## Assessed Direction

Use a folder contract under `envs/<env>/` plus deterministic build staging to `dist/<env>/`.

### Why this fits

1. Keeps environment-specific concerns isolated and auditable.
2. Supports explicit production safety markers.
3. Avoids introducing deployment environment fields into `CALENDAR_CONFIG`.
4. Stays compatible with a plain Node.js script using built-in modules only.

## Environment Contract

Each environment directory:

`envs/<env>/`

1. `scriptId` (required; single-line Apps Script target ID)
2. `Config.gs` (required; env-specific runtime config)
3. `PRODUCTION` (optional touchfile; enables production guard)
4. `EXCLUDE_TESTS` (optional touchfile; if present, omit tests)
5. `account` (optional; expected account hint/diagnostic metadata)

### Contract clarifications

1. Prefer the name `scriptId` over `projectId` to match clasp targeting semantics.
2. `account` is warning-only metadata in v1 (never a hard block).
3. Keep env runtime config out of version control. `envs/<env>/Config.gs` should be locally materialized (or generated from secret-managed input) and ignored by git, with optional committed example templates for structure only.

## Staging Model

For every env-targeted command, generate `dist/<env>/` from scratch:

1. Copy application code from `src/`.
2. Overlay `envs/<env>/Config.gs` as `dist/<env>/Config.gs`.
3. Include tests by default.
4. Exclude tests only when `envs/<env>/EXCLUDE_TESTS` exists.
5. Generate `dist/<env>/.clasp.json` using `scriptId` and `rootDir: "."`.

`dist/` remains ephemeral output, not source of truth.

## Safety Model

1. `--env` is required for env workflow commands.
2. If `envs/<env>/PRODUCTION` exists, block target-affecting commands unless `--allow-production` is supplied.
3. Blocked commands must fail non-zero and print clear context (env + scriptId + required override).
4. Root `.clasp.json` must not be mutated by the env workflow.

## Suggested Command Surface

Minimal command set (via Node wrapper script):

1. `prepare --env <env>`
2. `push --env <env>`
3. `run --env <env> --function <fn>`
4. `clasp --env <env> -- <clasp args>`

## Implementation Phases

### Phase 1: Parse and validate env contract

1. Validate env directory and required files.
2. Validate non-empty `scriptId`.
3. Apply test-default behavior (`EXCLUDE_TESTS` opt-out).

### Phase 2: Deterministic dist build

1. Clean and regenerate `dist/<env>/`.
2. Copy `src/`, overlay env `Config.gs`, generate `.clasp.json`.
3. Apply include/exclude tests logic.

### Phase 3: Guarded command execution

1. Enforce required `--env`.
2. Enforce `PRODUCTION` + `--allow-production` guard.
3. Provide actionable error messages.

### Phase 4: Documentation updates

1. Document `envs/<env>/` contract.
2. Document default-include-tests behavior.
3. Document production guard and override.
4. Document position of legacy direct root `clasp push` flow.

### Phase 5: Optional hardening

1. Better account diagnostics from `account` file (warning-only).
2. Optional `clasp run` readiness/fallback messaging.

## Risks and Mitigations

1. Wrong production target -> hard block with `PRODUCTION` marker + explicit override.
2. Missing/incorrect env files -> fail fast before clasp operations.
3. Operator confusion about test inclusion -> explicit docs + `EXCLUDE_TESTS` marker.

## Go/No-Go Checks

1. Missing required env files fail before any clasp action.
2. Tests are included when `EXCLUDE_TESTS` is absent.
3. Production-marked envs are blocked without `--allow-production`.
4. Env workflow does not mutate root `.clasp.json`.
5. End-user `CALENDAR_CONFIG` semantics remain unchanged (calendar name/ID based).

## Open Decisions

1. Is `clasp run` mandatory for v1, or is manual IDE execution acceptable first?
2. Should legacy direct root `clasp push` remain documented or be discouraged?
