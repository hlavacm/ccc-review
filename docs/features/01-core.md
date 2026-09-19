# 01 — Minimal Shared Core

## Status

TODO

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

- [ ] Project builds.
- [ ] Deterministic test suite runs without credentials/network.
- [ ] Strict type checking passes.
- [ ] Lint/format checks pass.
- [ ] Core has no Claude Code or Codex dependency.
- [ ] A fake reviewer can drive approval, changes requested, needs human, and max rounds.
- [ ] Reviewer execution/error state cannot become approval.
- [ ] Git helper is tested in real temporary clean and dirty repositories.
- [ ] Review state can be saved and loaded.
- [ ] Corrupt state behavior is tested.
- [ ] New behavior has automated coverage as required by `docs/testing.md`.

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
