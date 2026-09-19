# 04 — Codex Writer → Claude Reviewer

## Status

TODO

## Objective

Add the reverse direction using the existing small core:

> Codex implements → Claude reviews → feedback returns to Codex.

Do not rewrite the architecture.

Reuse the same review loop and result model.

## Dependencies

- `03-stabilize-claude-to-codex.md`

## Required reading

- `docs/context.md`
- `docs/testing.md`

## Research first

Verify current official documentation for:

### Codex as host

- plugin/extension mechanism,
- commands/skills,
- completion lifecycle hooks,
- how completion can be blocked/continued,
- session/task identity,
- available final-message/context fields,
- recursion/re-entry behavior.

### Claude Code as reviewer CLI

- non-interactive execution,
- safe/read-only/plan permission mode,
- JSON/structured output capabilities,
- model/effort options if relevant,
- failure semantics.

Do not assume symmetry with Claude Code.

## Requirements

1. Implement a Codex host adapter using native current APIs.
2. Add explicit activation/status/disable through Codex-native UX.
3. Record the same minimal Git baseline.
4. Implement `ClaudeReviewer`.
5. Claude reviewer must not modify source code.
6. Use the same shared `ReviewResult`.
7. Use the same max-round logic.
8. On findings, return feedback to the active Codex task using current supported continuation semantics.
9. Preserve `CCC-###` IDs across the task where practical.
10. Keep host-specific code outside core.

## Important principle

Equivalent semantics do not require identical syntax.

If Claude Code naturally uses:

```text
/cccr on
```

and Codex naturally uses a skill or different command mechanism, use the native mechanism.

Do not build compatibility hacks just to make command syntax identical.

## Automated testing requirements

Follow `docs/testing.md`.

### Fake Claude executable

Provide a fake Claude reviewer executable with the same scenario classes as fake Codex:

- approval,
- changes requested,
- needs human,
- malformed output,
- non-zero exit,
- timeout.

Exercise it through the real subprocess path.

### Codex host harness

Use realistic fake Codex lifecycle payloads/harnesses.

Cover:

- inactive task,
- activation,
- first review,
- findings continuation,
- second review,
- max rounds,
- duplicate/re-entry lifecycle event,
- reviewer failure.

### Shared workflow scenarios

Reuse common workflow scenario fixtures where practical rather than duplicating all logic separately.

The test suite must prove that adding the reverse direction did not regress Claude→Codex.

## Acceptance criteria

- [ ] Codex can explicitly enable CCC Review for a task.
- [ ] Codex implementation completion invokes one logical Claude review round.
- [ ] Claude reviewer is source-code read-only.
- [ ] Approval ends the loop.
- [ ] Findings continue Codex where supported.
- [ ] Second-round review works.
- [ ] Max-round limit works.
- [ ] Claude reviewer failures never become approval.
- [ ] Duplicate/re-entry lifecycle behavior is automatically tested.
- [ ] Fake Claude tests exercise the real subprocess runtime.
- [ ] Existing Claude→Codex workflow tests still pass.
- [ ] Full deterministic suite needs no credentials/network.
- [ ] Shared core did not gain scattered host-specific conditionals.

## Non-goals

Do not redesign feature 02 solely to make both integrations visually identical.

## Completion report

Document:

- Codex-native extension mechanism,
- Claude reviewer invocation,
- differences between host APIs,
- automated tests added,
- failure paths covered,
- commands run/results,
- any unavoidable limitations.
