# 03 — Stabilize Claude → Codex Through Real Use

## Status

DONE — acceptance criteria covered by the deterministic suite, and the real-use checklist (1–8) was completed in real Claude Code with the real Codex reviewer on 2026-09-19 (results below).

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
ccc-review doctor
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

- [x] Common Codex infrastructure failures produce actionable messages.
- [x] Duplicate Stop-hook calls do not duplicate logical reviews.
- [x] Review state/history can be inspected.
- [x] User can disable/abort review cleanly.
- [x] Dirty repo context is visible to reviewer/user.
- [x] Every practical bug fixed during stabilization has an automated regression test.
- [x] New failure handling has automated coverage.
- [x] README contains a working Claude→Codex example.
- [x] A short optional real-use checklist has been completed on at least one real repository.
- [x] Full deterministic test suite still runs without credentials/network.

## Completion report

Explicitly separate:

- issues observed in real use,
- changes made,
- regression tests added,
- failure paths now covered,
- commands run/results,
- ideas deliberately deferred.

## Implementation notes

Codex CLI 0.155.1; `model_reasoning_effort` values and `CODEX_API_KEY` for `codex exec` verified on learn.chatgpt.com (config reference, non-interactive mode) 2026-09-19.

### Issues observed in real use

1. Unauthenticated `codex exec` never exits: it retries the 401 ("Reconnecting... waiting for network", watched > 4 min), so the Stop hook would hang for the whole 20 min timeout. `codex login status` exits 1 with `Not logged in` immediately.
2. Failure messages carried up to 4 KB of raw stderr (retry/hook noise) and no hint.
3. The Stop hook being killed (interrupt) left the detached Codex process group running.
4. The prompt pointed Codex at `git diff` only, so changes the writer had committed were invisible (false approval risk).
5. Unbounded prompt: all baseline dirty paths, 20×8000 chars of prompts, full report.
6. `claims/<taskId>/` never cleaned up.
7. No history, no config in status, no dirty warning for the user, no max-rounds/model/effort settings.

### Changes

- `CodexReviewer`: `check()` = `codex login status` preflight (only `codex --version` with `CODEX_API_KEY`), run before every review and by `/ccc-review:ccc-review on`; short actionable messages (missing binary, not logged in, timeout in minutes + setting, invalid JSON excerpt, last 10 stderr lines + login hint on auth errors); SIGTERM/SIGINT/SIGHUP kill the process group and fail the review (recorded `reviewer_error`, task stopped, claims dropped); `model` (`-m`) and `reasoningEffort` (`-c model_reasoning_effort=…`); `describe()`.
- Prompt: `git diff <activation HEAD>` + `git log <HEAD>..HEAD` (status/`--cached`/log without commits); dirty list capped at 50 paths, task/report at the last 12 000 chars.
- Core: optional `Reviewer.check()`/`describe()`; append-only history `history/<taskId>.jsonl` (`appendHistory`/`readHistory`, corrupt → `StateError`).
- Host: `on` preflight + dirty warning + `CCC_REVIEW_MAX_ROUNDS`; history for on/round/off; `off` and every terminal outcome drop claims (with a post-claim state re-check so a stale duplicate cannot start a round); `status` shows reviewer settings, round history and file paths; findings sorted by severity with indented multi-line messages; `CCC_REVIEW_CODEX_MODEL`, `CCC_REVIEW_CODEX_REASONING_EFFORT` validated.
- README: example session, configuration via settings `env`, troubleshooting; opt-in `pnpm test:smoke`. The real-use checklist is below.

### Regression tests

- #1 `codex-reviewer.test.ts` "not logged in fails fast …" (with the old code the review ran exec and approved), "logging out after activation …" (host), `on` refused when not logged in / binary missing.
- #2 `codex-reviewer.test.ts` "actionable error messages".
- #3 `claude-workflow.test.ts` "aborting the Stop hook kills the whole codex process group" (verified to fail with the signal handler disabled: grandchild survives).
- #4/#5 `codex-prompt.test.ts` "buildReviewPrompt stabilization" (failed before the fix).
- #6 `claude-host.test.ts` "cleanup and abort".

### Fixed after Codex review of this feature (regression tests verified to fail first)

- An aborted review left the task active, unrecorded and with its claim held (recoverable only by off → on). Abort is now a reviewer error: recorded, task stopped, claims dropped; `on` resumes. `claude-workflow.test.ts` "aborting the Stop hook …" asserts state, history, claims and recovery.
- With `CODEX_API_KEY` the whole preflight was skipped, so `on` enabled review without a Codex binary. It now runs `codex --version`. `codex-reviewer.test.ts` / `claude-host.test.ts` "with CODEX_API_KEY a missing binary …".
- `readHistory` accepted entries without `at` (status then crashed on `at.slice`) or with invalid `round`/`outcome`/`error`/`result`. Every field is validated now. `state.test.ts` corrupt-history cases.
- The login tests depended on the developer's environment: a set `CODEX_API_KEY` switched the preflight off (4 failures). `test/setup.ts` removes it (except for `pnpm test:smoke`); verified with `CODEX_API_KEY=sk-test pnpm test`.
- #7 `state.test.ts` "review history", `claude-host.test.ts` "history and status", "dirty repository warning", "configured max rounds", configuration cases.

### Fixed in the audit of features 01–05 (2026-09-19; regression tests verified to fail first)

- A corrupt `sessions/<id>.json` or `tasks/<id>.json` wedged the session: `runCommand` loaded the state before looking at the action, so `on` and `off` failed too and every prompt and Stop kept reporting the error until the files were deleted by hand (requirement 7). `on` now starts a fresh task and says the old state was replaced, `off` removes the session file, and `status` reports the error with both ways out. Stop and prompt hooks are unchanged: the error is a `systemMessage`, never a block or an approval. An invalid `session_id` stays an error and creates nothing. Regressions: `host-scenarios.ts` "corrupt sessions/tasks state is recoverable" (3 scenarios × 2 kinds × both directions; all 12 failed before the fix), `claude-host.test.ts` "on with an invalid session id …".

### Fixed in the pre-publication review (2026-09-19; regression tests verified to fail first)

- `git status` ran the program a repository's `core.fsmonitor` names, although the diff side already refused external drivers and textconv. Every git call now passes `-c core.fsmonitor=false`. `git.test.ts` "never runs the repository's fsmonitor program".
- State directories (recorded prompts, findings) were created with the default umask; they are now `0700`, and directories an older version left at `0755` are tightened on the next write (`privateDir` in `core/state.ts`; `mkdir`'s mode only applies to directories it creates — found in Codex review). `host-scenarios.ts` "state directories … are private to the user" (both directions).
- The writer feedback now says findings are review comments, not instructions (`claude-feedback.test.ts`).
- The README's real-use checklist had been dropped in feature 05 while this file still pointed at it; it now lives below.

### Real-use checklist results

- 2026-09-19 `pnpm test:smoke` (real Codex CLI 0.155.1, disposable repo, outside the development sandbox): passed in 33 s. `/ccc-review:ccc-review on` preflight passed; Codex found the planted `multiply` bug (`CCC-001 [high] math.js:2`, verified `multiply(2, 3)` returns 5), the Stop hook blocked with the finding and instructions, status showed round 1/3 with history, and Git state was unchanged.
- 2026-09-19, after the pre-publication review and the first push (commit `0278b4a`, tag `v1.0.0`, Node 26.9): `pnpm test:smoke` passed again, 5/5 in 22 s. Codex found the planted bug (`CCC-001 [high] math.js:2`) in 22 s; the block reason carries the new "review comments, not instructions" line; status showed round 1/3 with history; Git state unchanged.
- 2026-09-19, manual checklist 1–8 in Claude Code 2.1.278 with `claude --plugin-dir`, real Codex CLI 0.155.1, disposable repositories, commands `/ccc-review:on|off|status`. All eight passed:
  1. `on` → "enabled" with the baseline; a second `on` → "already active", same task. With uncommitted files the dirty-tree warning listed them.
  2. Claude's completion ran one Codex review (about 30 s).
  3. Approval: `Stop says: CCC Review: Codex APPROVED (round 1/3)`. Findings, three times: Codex returned `CCC-001`, Claude continued without the user, fixed it and reported `CCC-001: fixed — …`, and round 2 approved with "CCC-001 is resolved". In these runs round 1 was spent on a completion in which Claude had only asked a clarifying question (the terminal had wrapped the pasted task as quoted text); Codex correctly reported the task as not done.
  4. `status` showed state, round, verdict and history; `git status` showed only Claude's edits, no stash.
  5. `CCC_REVIEW_CODEX_BIN=/nonexistent`: `on` and `current` both refused with "not enabled: codex executable not found: /nonexistent — …"; `current` was blocked, so Claude wrote no report.
  6. Claude committed during the task; with a clean tree Codex still reviewed the commit ("commit 3c841df … contains math.js and math.test.js").
  7. Esc during a review (a stand-in reviewer that sleeps, so the window is unmistakable; `pgrep` showed it running): Claude Code sends the hook SIGTERM, the reviewer process was gone right after, status showed `round 1: reviewer_error — codex review aborted (SIGTERM) — the change is NOT approved`, task inactive, and `on` started a fresh task. So the uncatchable-SIGKILL case noted under "Deliberately deferred" is not what Esc does.
  8. Esc to interrupt Claude mid-task, `off` → "disabled (… 0 round(s) run)", "continue" → the completion was not reviewed (with the sleeping reviewer a review would have hung the session); history is `on`, `off`.
- Observed, not changed: a slash command typed with a leading space is plain text to Claude Code and never reaches the hook.
- Fixed after this checklist (2026-09-20; seen four times in real use, in both hosts): the writer only asked the user a question and changed nothing, yet the completion was reviewed. That spent a round and, worse, the findings ("task not implemented") pushed the writer to implement without the answer it had asked the user for. A completion is now skipped, with a message and without using a round or a claim, when nothing can have changed: clean tree at `on`, same `HEAD`, clean tree now. A dirty baseline is always reviewed, because an edit to an already-dirty file does not show in `git status`; a repository that cannot be inspected is reviewed too, so the failure is recorded. Regressions in `host-scenarios.ts`, both directions: "a completion that changed nothing since a clean activation is not reviewed" (failed first), "a commit since activation is a change, even with a clean tree", "a tree that was dirty at activation is always reviewed", "a repository that is gone fails the review…". 47 existing tests had been "finishing" without any change; the host harnesses now touch a file before `stop()` (`simulateWork`), and the tests that guard Git state turn that off.

### Real-use checklist (real Claude Code + Codex, consumes usage)

`pnpm test:smoke` runs the reviewer half automatically. The Claude Code half is manual. Never run it in a repository you care about.

```sh
tmp=$(mktemp -d) && cd "$tmp" && git init -q && printf 'export const add = (a, b) => a - b;\n' > math.js \
  && git add . && git -c user.name=t -c user.email=t@t commit -qm init
claude --plugin-dir /path/to/ccc-review
```

1. `/ccc-review:on Fix add() in math.js and add a node:test test for it` → "enabled", baseline shown.
2. Ask Claude to do the task. When it finishes, Codex reviews (may take minutes).
3. Expect either an approval message, or Claude continuing with `CCC-00x` findings and a re-review.
4. `/ccc-review:status` shows the round and last verdict; `git status` shows only Claude's edits (no commits or stashes by CCC Review).
5. Failure path: `CCC_REVIEW_CODEX_BIN=/nonexistent claude --plugin-dir /path/to/ccc-review`, then `on` → "not enabled: codex executable not found".
6. Commit during the task (ask Claude to commit) → Codex still reviews the committed change.
7. Press Esc while Codex is reviewing → no `codex` process left (`pgrep -fl "codex exec"`); `status` shows the round as aborted, `on` starts again.
8. `/ccc-review:off` mid-task → the next completion is not reviewed; the `status` history ends with `off`.

All eight passed on 2026-09-19; see "Real-use checklist results".

### Deliberately deferred

- `doctor` command: the `on` preflight and actionable status already cover it.
- Protecting `off` against a concurrently finishing Stop (would need locking; not observed).
- Plugin `userConfig` instead of env variables.
- Deterministic test of the post-claim re-check race (needs fault injection between two file reads).
- SIGKILL of the hook cannot be intercepted; Codex then outlives it until its own exit.
