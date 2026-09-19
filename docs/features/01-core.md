# 01 — Minimal Shared Core

## Status

DONE

## Objective

Create the small reusable foundation needed by both review directions without implementing any host plugin yet.

The core must be simple, but the behavior it owns must be strongly tested.

## Dependencies

None.

## Required reading

- `docs/context.md`
- `docs/testing.md`

## Requirements

1. Bootstrap the repository and toolchain.
2. Prefer TypeScript/Node.js unless current API research gives a strong reason not to.
3. Create a small shared core containing:
   - `Verdict`
   - `Finding`
   - `ReviewResult`
   - reviewer interface
   - minimal task/review state
   - max-round review-loop logic.
4. Add a small Git helper able to determine:
   - repository root,
   - HEAD SHA,
   - branch where available,
   - current machine-readable status.
5. Add minimal local task-state persistence.
6. State only needs enough information for:
   - task ID,
   - active/inactive,
   - writer/reviewer,
   - baseline,
   - current round,
   - previous review result.
7. Keep host-specific APIs outside core.
8. Provide deterministic project commands for test/typecheck/lint/format/build as appropriate.
9. Design the main boundaries so they can be exercised by fake reviewers and temporary repositories.

## Architecture constraints

Keep this small.

Do not implement:

- semantic finding deduplication,
- complex migrations,
- concurrency locking,
- Claude/Codex hooks,
- generic orchestration frameworks.

## Automated testing requirements

Follow `docs/testing.md`.

At minimum:

### Review loop unit tests

- approval on first review,
- changes requested then approval,
- needs human,
- max-round termination,
- reviewer error not treated as approval.

### State tests

- save/load active task,
- save/load current round,
- invalid/corrupt state fails safely.

### Git integration tests

Use real temporary Git repositories.

Cover:

- clean repository,
- dirty tracked file,
- untracked file,
- baseline/status capture does not mutate repository.

Do not mock all Git behavior.

## Acceptance criteria

- [x] Project builds.
- [x] Deterministic test suite runs without credentials/network.
- [x] Strict type checking passes.
- [x] Lint/format checks pass.
- [x] Core has no Claude Code or Codex dependency.
- [x] A fake reviewer can drive approval, changes requested, needs human, and max rounds.
- [x] Reviewer execution/error state cannot become approval.
- [x] Git helper is tested in real temporary clean and dirty repositories.
- [x] Review state can be saved and loaded.
- [x] Corrupt state behavior is tested.
- [x] New behavior has automated coverage as required by `docs/testing.md`.

## Non-goals

Everything not required for feature 02.

## Completion report

Summarize:

- chosen structure,
- core API,
- state format/location,
- automated tests added,
- failure paths covered,
- commands run and results.

## Implementation notes

- Toolchain: Node ≥ 22.18 (native TypeScript type stripping), `node:test`, TypeScript (strict, `erasableSyntaxOnly`), Biome (lint + format). Dev dependencies only.
- `src/core/types.ts` — `Verdict`, `Finding`, `ReviewResult`, `GitBaseline`, `ReviewRequest`, `Reviewer`, strict `parseReviewResult()`.
- `src/core/review-loop.ts` — `runReviewRound(state, reviewer)`: one round per writer completion; outcomes `approved | changes_requested | needs_human | max_rounds | reviewer_error | inactive`. Every reviewer call increments `round`; any reviewer throw or invalid output becomes `reviewer_error` and deactivates the task.
- `src/core/state.ts` — `TaskState` (version 1), `createTaskState()`, `saveState(dir, state)` (atomic tmp + rename to `<dir>/<taskId>.json`), `loadState(dir, taskId)` (`undefined` when missing, `StateError` when corrupt). The state directory is chosen by the host (planned for 02: `<git-common-dir>/cccr/`).
- `src/git.ts` — `captureBaseline(cwd)`: root, HEAD SHA (`null` without commits), branch (`null` when detached), parsed `git status --porcelain=v1 -z`. Runs `git` via argv only with `--no-optional-locks` so it never rewrites the index.
