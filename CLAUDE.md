# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

CCC Review (Claude Code ↔ Codex Review): one coding agent writes, the other independently reviews real repository changes, and findings go back to the writer in a bounded loop. The first milestone is Claude Code writer → Codex reviewer; the reverse direction comes later.

The spec in `docs/` is normative, and `docs/testing.md` governs testing. Development goes feature by feature through `docs/features/0N-*.md`, in numeric order. Before implementing, read `docs/README.md`, `docs/context.md`, `docs/testing.md` and the whole feature file. Implement only that feature and do not continue to the next one automatically. Mark a feature `DONE` only when its acceptance criteria pass and every relevant success and failure path has automated coverage.

## Commands

The package manager is pnpm. Node ≥ 22.18 runs `.ts` directly via native type stripping, so tests need no build step.

```sh
pnpm check              # typecheck + lint + test + build (the completion gate)
pnpm test               # all deterministic tests
pnpm test:unit
pnpm test:integration   # real temporary Git repositories
pnpm test:coverage
pnpm typecheck          # tsc --noEmit over src + test
pnpm lint               # biome check (lint + format); `pnpm format` to fix
pnpm build              # tsc -p tsconfig.build.json → dist/
```

Single test file or single test:

```sh
node --import ./test/setup.ts --test test/unit/review-loop.test.ts
node --import ./test/setup.ts --test --test-name-pattern="max rounds" "test/**/*.test.ts"
```

Always pass `--import ./test/setup.ts`. It isolates every git process, including git spawned by production code, from the developer's global/system git config and global excludes file. Without it, git tests can depend on the machine.

## Architecture

- `src/core/` is the shared core and must stay host-agnostic. It may import only `node:*` builtins and sibling core modules; `test/unit/core-boundary.test.ts` enforces this. Claude Code / Codex hook or CLI code belongs outside core, in host and reviewer adapters (`src/hosts/`, `src/reviewers/`).
  - `types.ts`: the review model (`Verdict`, `Finding`, `ReviewResult`, `GitBaseline`) and the `Reviewer` interface. `parseReviewResult()` strictly validates untrusted reviewer output.
  - `review-loop.ts`: `runReviewRound(state, reviewer, context?)` runs **one** round per writer completion; the host calls it from its completion hook. It is pure with respect to its input state, and the caller persists the returned state. Invariants:
    - every reviewer call increments `round`, so the loop always terminates;
    - reviewer output is re-validated;
    - any throw or invalid output becomes `reviewer_error` and deactivates the task, never approval;
    - once `round >= maxRounds` (default 3), the reviewer is not called again.
  - `state.ts`: append-only review history `<dir>/<taskId>.jsonl` (`appendHistory`/`readHistory`). Versioned `TaskState`, persisted as `<dir>/<taskId>.json` with an atomic tmp + rename write. `loadState` returns `undefined` when the file is missing and throws `StateError` when it is corrupt, never a silent default. The host chooses the state directory.
- `src/git.ts`: `captureBaseline(cwd)` records the repository root, HEAD (`null` when there are no commits), branch (`null` when detached) and parsed `status --porcelain=v1 -z`. It must never mutate the repo or run programs the repo configures: it runs with `--no-optional-locks` and `-c core.fsmonitor=false`, uses argv-only `execFile` (no shell) and strips only the EOL from output (paths may contain spaces).
- `src/reviewers/codex.ts`: `CodexReviewer` spawns `codex exec --sandbox read-only …` (argv only, prompt on stdin, strict `--output-schema`, result read from `--output-last-message`). `check()` runs `codex login status` first (unauthenticated `exec` retries forever instead of failing; with `CODEX_API_KEY` only `codex --version`). SIGTERM/SIGINT/SIGHUP of the hook kill the codex group and fail the review, so the round is recorded and the task stopped. It runs codex in its own process group with its own deadline: settle-once, the deadline wins over a late `close`/exit 0, the whole group is SIGKILLed (not spawn's `timeout`, which stays armed after a spawn error and hangs the hook). `buildReviewPrompt` is pure.
- `src/hosts/claude-code/`: the plugin's hook code. `cli.ts <command|prompt-submit|stop>` → `runHook` in `hooks.ts`, which never throws: errors become `systemMessage` (or a blocked command), never block/approve. `handleStop` claims each completion (`sha256(last_assistant_message)`, exclusive `wx` create) so a duplicate/concurrent Stop never starts a second round. The plugin itself is the repo root: `.claude-plugin/`, `hooks/hooks.json`, `skills/ccc-review/SKILL.md`; the command is `/ccc-review:ccc-review on|off|status`. Hook matchers made only of letters/digits/`_-,| ` are exact-string matches in Claude Code, hence the `^(ccc-review:)?ccc-review$` regex.
- `src/hosts/common.ts`: the host-side workflow both hosts share (activation, sessions, claims, `reviewCompletion`, history, writer/user texts derived from the task's writer/reviewer). A host only drives tasks whose `writer` is its own agent. Unreadable state never wedges a session: `on` replaces it, `off` resets the session.
- `src/hosts/codex/`: the Codex plugin hooks (`.codex-plugin/plugin.json` → `codex/hooks.json`, `codex/skills/ccc-review`). `UserPromptSubmit` handles `$ccc-review on|off|status` (blocked, never reaches the model) and records the task; `Stop` claims `sha256(turn_id \0 last_assistant_message)`. Codex rejects unknown output keys and a block without a reason.
- `src/reviewers/claude.ts`: `ClaudeReviewer` runs `claude -p --safe-mode … --tools Read,Grep,Glob --permission-mode dontAsk --json-schema …` after `claude auth status`. No shell tool, so `describeChanges()` in `git.ts` puts the Git changes in the prompt. `process.ts` (process group, deadline, abort) and `prompt.ts` (prompt, schema) are shared by both reviewers.
- `test/helpers/`: `TemporaryGitRepository` (real temp repos), `FakeReviewer` (scripted results or throws, and records requests), `FakeCodex`/`FakeClaude` (real executables wrapping `test/fixtures/fake-*.ts` via `FakeCli`; scripted steps, records argv/stdin/cwd), `CodexHostHarness`, `hostScenarios()` (workflow scenarios run for both directions), `ClaudeHostHarness` (realistic hook payloads), temp-dir utils. `test/integration/claude-workflow.test.ts` runs the exact `hooks.json` commands as subprocesses. `plugin-hooks.ts` runs a `hooks.json` command line like the hosts do and lists/copies the packaged files (`git ls-files --cached --others --exclude-standard`); `test/integration/packaging.test.ts` runs both plugins from such a clean copy (no `node_modules`) and guards release hygiene and README/package consistency. `test/smoke/install.smoke.ts` (`pnpm test:smoke:install`, no credentials) installs/upgrades/uninstalls with the real CLIs into throwaway `CLAUDE_CONFIG_DIR`/`CODEX_HOME`.

## Rules from the spec that shape code

- Reviewer failure, timeout, invalid JSON or a missing executable is never `APPROVED`, and each such path needs an automated test.
- No automatic commit, stash, reset, checkout, rebase or push. The reviewer must not modify source code.
- Spawn processes as executable + argv, never with concatenated shell strings.
- Review activation is explicit (e.g. `/ccc-review on|off|status`); inactive sessions are unaffected.
- The default suite must not need Claude/Codex credentials or network access. Use real temp Git repos for Git behavior and fake reviewer executables / host harnesses for integrations, driven through the production subprocess path. Real-CLI smoke tests are opt-in only.
- Every fixed bug gets a regression test when practical.
- Before touching Claude Code or Codex APIs, verify current official docs; don't rely on remembered CLI flags.
- Don't pre-build: plugin frameworks, semantic finding dedup, migrations, locking, services, MCP servers or UI.
