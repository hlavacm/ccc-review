# 04 — Codex Writer → Claude Reviewer

## Status

DONE — acceptance criteria covered by the deterministic suite. The real Claude reviewer passed `pnpm test:smoke`; the interactive Codex TUI flow (`$cccr` delivery, continuation) is not yet exercised (see limitations).

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

- [x] Codex can explicitly enable CCCR for a task.
- [x] Codex implementation completion invokes one logical Claude review round.
- [x] Claude reviewer is source-code read-only.
- [x] Approval ends the loop.
- [x] Findings continue Codex where supported.
- [x] Second-round review works.
- [x] Max-round limit works.
- [x] Claude reviewer failures never become approval.
- [x] Duplicate/re-entry lifecycle behavior is automatically tested.
- [x] Fake Claude tests exercise the real subprocess runtime.
- [x] Existing Claude→Codex workflow tests still pass.
- [x] Full deterministic suite needs no credentials/network.
- [x] Shared core did not gain scattered host-specific conditionals.

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

## Implementation notes

Verified 2026-09-19 against learn.chatgpt.com/docs/hooks, /docs/plugins, /docs/build-skills, codex-rs source (`hooks/src/schema.rs`, `events/stop.rs`, `events/user_prompt_submit.rs`, `engine/discovery.rs`, `core-plugins/src/loader.rs`), code.claude.com/docs (headless, cli-reference, permissions) and the local CLIs (codex-cli 0.155.1, Claude Code 2.1.278 `--help`).

### Codex-native extension mechanism

- Plugin manifest `.codex-plugin/plugin.json` (Codex prefers it over `.claude-plugin/`), `skills: ./codex/skills/`, `hooks: ./codex/hooks.json`. Hooks run via the shell with `PLUGIN_ROOT`/`PLUGIN_DATA` set; the user must trust them in `/hooks`.
- Activation: `$cccr on [task] | off | status` (also `$cccr:cccr`). Codex has no plugin slash commands and custom prompts are deprecated, so `UserPromptSubmit` (no matcher, sees every prompt) handles the mention and answers `{"decision":"block","reason":…}`: the user sees the reason, the model is never called. The `cccr` skill (`allow_implicit_invocation: false`) only reports that the hook did not run.
- Completion: `Stop` hook (timeout 1800 s). Findings → `{"decision":"block","reason":feedback}`, which Codex turns into a continuation prompt; other outcomes → `systemMessage`.
- Identity: `session_id` (thread) keys the session; a completion is claimed as `sha256(turn_id \0 last_assistant_message)` (exclusive create), because whether a continuation keeps `turn_id` is undocumented.

### Claude reviewer invocation

`claude auth status` preflight (`claude --version` with `ANTHROPIC_API_KEY`), then `claude -p --safe-mode --no-session-persistence --output-format json --json-schema <REVIEW_SCHEMA> --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none [--model] [--effort]`, prompt on stdin, cwd = repo root, own process group and deadline (shared `runProcess`). Read-only: no Bash/Edit/Write tools at all (a `Bash(git diff *)` rule would still allow `git diff --output=<file>`), so `describeChanges()` puts `git log`, the full changed-file list, `git diff --no-ext-diff --no-textconv <activation HEAD, or the empty tree without commits>` and untracked files into the prompt. `--safe-mode` (no plugins/hooks/MCP/CLAUDE.md, normal auth) prevents re-entering CCCR's Claude Code hooks; `plan` mode is not used (not strictly read-only with auto mode). Result: `structured_output` of the JSON result, re-validated by `parseReviewResult`.

### Differences between the host APIs

| | Claude Code | Codex |
| --- | --- | --- |
| Command | `/cccr:cccr` skill + `UserPromptExpansion` hook | `$cccr` skill mention + `UserPromptSubmit` hook |
| Completion id | none → hash of final message | `turn_id` + final message |
| Subagents | `Stop` with `agent_id` ignored | separate `SubagentStop`; prompts with `agent_id` not recorded |
| Output parsing | lenient | unknown keys / block without reason fail the hook |
| Plugin data dir | `CLAUDE_PLUGIN_DATA` | `PLUGIN_DATA` (plus `CLAUDE_PLUGIN_*`) |
| Hook trust | plugin install | explicit `/hooks` review, again after changes |

### Changes

- Shared (no behaviour change for Claude → Codex, all 208 existing tests unchanged apart from one added argument): `src/reviewers/process.ts` (from `CodexReviewer.run`), `src/reviewers/prompt.ts` (prompt + schema, optional `changes`), `src/hosts/common.ts` (activation, sessions, claims, `reviewCompletion`, history, texts named from the task's writer/reviewer). Core untouched.
- New: `ClaudeReviewer`, `describeChanges()` in `git.ts`, Codex host (`src/hosts/codex/`), Codex plugin files.
- Cross-host guard: a host only drives tasks whose `writer` is its agent, since both may share a state dir (`CCCR_STATE_DIR`; Codex also sets `CLAUDE_PLUGIN_DATA`). Codex does not load the Claude `hooks/hooks.json`: an explicit manifest `hooks` value replaces default-file discovery (developers.openai.com/codex/plugins/build).

### Automated tests added (109 new, 317 total)

- `claude-reviewer.test.ts` (29): fake `claude` through the real subprocess path: approval, changes requested, needs human; argv (read-only tools, `dontAsk`, schema, `--safe-mode`, no Bash/Edit/Write/bypass/plan, prompt only on stdin); Git changes in the prompt; ID preservation; model/effort; repo not mutated; login preflight.
- `host-scenarios.test.ts` (2 × 15): `hostScenarios()` runs the same workflow scenarios for Claude→Codex and Codex→Claude: inactive, activation + baseline, approval, findings → continuation → second round with IDs, max rounds (default and configured), needs human, duplicate and concurrent duplicate Stop, off, 4 reviewer failures, Git not mutated.
- `codex-host.test.ts` (28): `$cccr`/`$cccr:cccr`/look-alikes, unknown action, activation refusals (no Git, not logged in, missing binary), task recording (not subagent prompts or commands), `turn_id` identity, host isolation both ways, corrupt state, invalid payloads, invalid config, recovery; every output checked against Codex's allowed keys.
- `codex-workflow.test.ts` (8): manifest/skill/hooks files, Stop timeout > reviewer timeout, full flow through the exact `codex/hooks.json` commands via `/bin/sh` with `PLUGIN_ROOT`/`PLUGIN_DATA`, missing `claude` fails fast, SIGTERM of the hook kills the claude group and records `reviewer_error`, garbage stdin.
- `git.test.ts` (+8): `describeChanges` on real temp repos (commits, modified/deleted/untracked/unicode paths, clean tree, no commits, truncation, external diff/textconv never run, missing activation commit) and the no-mutation snapshot.
- Unit: prompt with collected changes; Codex → Claude texts.
- Opt-in `test/smoke/codex-to-claude.smoke.ts` (real `claude`).

### Failure paths covered

Claude reviewer: missing executable, not logged in (activation and review), hanging login check, non-zero exit (with approval on stdout), auth failure printed as the result, malformed JSON, no output, shape mismatch, approval without findings, success without `structured_output`, error subtypes, `is_error`, timeout, a result after the deadline (grandchild holding stderr), oversized stdout, abort signal. Host: corrupt task/session state, invalid payloads/session id, invalid configuration, unknown hook event, reviewer disappearing after activation. None of them approve.

### Bugs found during implementation

- A test marker for the external diff test lived in the shared temp dir and survived a mutation run, so the test failed afterwards. It now lives in the repo's own temp parent (removed on dispose). Re-checked by mutation: the test fails with `--ext-diff --textconv` and passes without.

### Fixed after Codex review of this feature (regression tests verified to fail first)

- Activation without commits followed by the writer's first commit: `describeChanges` diffed only staged + unstaged changes, so the committed content vanished (`Diff: (empty)`) for a reviewer without Git tools. It now diffs against the empty tree. The Codex prompt had the same gap (`git diff --cached` only) and now points at `git log -p` and `git diff HEAD`. `git.test.ts` "a first commit after activation without commits is in the diff", `codex-prompt.test.ts` "falls back … no commits".
- A truncated diff could hide whole changed files. The full `git diff --name-only` list now precedes the diff. `git.test.ts` "lists every changed file even when the diff is truncated".

### Commands run

- `pnpm check` (typecheck + Biome + 317 tests + build): pass.
- `ANTHROPIC_API_KEY=sk-test CODEX_API_KEY=sk-test pnpm test`: 317 pass.
- `pnpm test:coverage`: new files 98.6–100 % lines.
- Mutation checks (writer guard, `turn_id` in the claim key, `--no-ext-diff`): the corresponding tests fail.

### Real CLI smoke results

- 2026-09-19 `pnpm test:smoke` outside the development sandbox: both directions passed. The real Claude Code reviewer (Claude → `claude -p --safe-mode … --json-schema`) found the planted `multiply` bug (`CCC-001 [high] math.js:2`) in 9 s, the Stop output blocked with the finding for Codex, status showed round 1/3, and Git state was unchanged. The Claude→Codex smoke test still passes (28 s).
- Observed: the Claude reviewer wrote its summary and findings in the user's configured language (Czech) while Codex answered in English. The shared prompt now asks both reviewers to write the summary and findings in the language of the original task (else the writer's report; English when neither exists), keeping IDs, verdicts, code and paths unchanged (`codex-prompt.test.ts` "buildReviewPrompt language", incl. Czech task + English report). The Codex → Claude smoke test now uses a Czech task with an English report and asserts Czech findings: re-run 2026-09-19, passed (Claude answered in Czech, 2 findings in 9 s; Codex → English for an English task, 24 s). Not covered by a real run: an English task with the Claude reviewer, where the configured Claude Code language answered Czech before the rule existed.

### Limitations

- The real Codex TUI was not driven: whether a plugin skill mention reaches `UserPromptSubmit` as the literal text `$cccr` (vs `$cccr:cccr`) and whether a continuation keeps `turn_id` are undocumented. Both spellings are accepted, and the claim key does not depend on `turn_id` alone. Payloads follow `schema.rs`.
- Like the Claude host: a continuation that ends with a message identical to the previous one in the same turn is treated as the same completion.
