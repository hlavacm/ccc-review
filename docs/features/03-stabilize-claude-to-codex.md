# 03 — Stabilize Claude → Codex Through Real Use

## Status

TODO

## Objective

Make the already-working Claude→Codex workflow comfortable and reliable for daily local use.

This feature should respond to actual weaknesses in feature 02 rather than introduce speculative architecture.

Every confirmed bug fixed during this feature should receive a regression test whenever practical.

## Dependencies

- `02-claude-to-codex.md`

## Required reading

- `docs/context.md`
- `docs/testing.md`

## Requirements

Review feature 02 through real/manual use and improve the highest-value issues.

At minimum cover:

1. useful error messages when Codex is:
   - missing,
   - unauthenticated,
   - timed out,
   - returning invalid output.
2. robust re-entry/Stop-hook behavior,
3. useful status output,
4. readable review feedback formatting,
5. compact reviewer prompts,
6. simple persistent review history/log,
7. predictable task cleanup/disable behavior,
8. dirty repository warning/context,
9. sensible configuration for:
   - max rounds,
   - timeout,
   - model/reasoning options only if current CLI supports them.

Add a simple diagnostic command only if it is actually useful, e.g.:

```text
cccr doctor
```

or host-native equivalent.

## Automated testing requirements

1. Reproduce each confirmed bug with a failing automated test before or alongside the fix where practical.
2. Keep every such test as a regression test.
3. Extend fake Codex scenarios for every newly handled failure mode.
4. Add workflow tests for any lifecycle/state bug.
5. Keep default tests credential-free and network-free.
6. Do not replace deterministic tests with manual smoke testing.

## Keep it simple

Do not use this feature as permission to build:

- semantic finding databases,
- generic plugin abstractions,
- remote services,
- complex locks unless a real bug requires them,
- large compatibility frameworks.

Fix observed failure modes.

## Acceptance criteria

- [ ] Common Codex infrastructure failures produce actionable messages.
- [ ] Duplicate Stop-hook calls do not duplicate logical reviews.
- [ ] Review state/history can be inspected.
- [ ] User can disable/abort review cleanly.
- [ ] Dirty repo context is visible to reviewer/user.
- [ ] Every practical bug fixed during stabilization has an automated regression test.
- [ ] New failure handling has automated coverage.
- [ ] README contains a working Claude→Codex example.
- [ ] A short optional real-use checklist has been completed on at least one real repository.
- [ ] Full deterministic test suite still runs without credentials/network.

## Completion report

Explicitly separate:

- issues observed in real use,
- changes made,
- regression tests added,
- failure paths now covered,
- commands run/results,
- ideas deliberately deferred.
