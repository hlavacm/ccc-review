# 02 — Claude Code Writer → Codex Reviewer

## Status

DONE

## Objective

Deliver the first genuinely useful CCC Review workflow:

> Claude Code implements → Codex reviews → feedback returns to Claude → bounded re-review loop.

This is the MVP milestone.

## Dependencies

- `01-core.md`

## Required reading

- `docs/context.md`
- `docs/testing.md`

## Research first

Verify current official documentation for:

### Claude Code

- plugin format,
- command/skill registration,
- completion/Stop hook,
- hook input/output,
- how a hook can block completion and return feedback,
- recursion/re-entry indicator,
- session/task identity,
- availability of the last assistant message,
- practical access to task/plan context.

### Codex CLI

- non-interactive invocation,
- read-only/sandbox mode,
- approval settings,
- structured JSON/schema output,
- model/reasoning options if relevant,
- exit codes and failures.

Use current official documentation, not assumptions.

## Requirements

### Activation

Implement explicit activation for the current Claude Code task/session.

Prefer native UX equivalent to:

```text
/ccc-review on
/ccc-review off
/ccc-review status
```

If current Claude plugin APIs make another syntax more natural, use that and document it.

When activated:

- create a task ID,
- record Git baseline,
- associate current session where available.

### Context

Pass Codex:

- original user task if reliably available,
- Claude implementation plan if reliably available,
- Claude final implementation report / last message,
- baseline metadata,
- previous findings if this is another round.

If the plan cannot be obtained reliably with current APIs, do not invent it.

Document the limitation and continue with the best reliable context.

### Codex review

Invoke Codex non-interactively.

Codex must be instructed to:

- inspect the actual repository,
- inspect relevant Git changes,
- not modify source code,
- compare with task/plan/report,
- focus on material issues,
- return structured JSON.

Do not paste the entire diff into the prompt when Codex can inspect the repository directly.

### Minimal review schema

Use something equivalent to:

```json
{
  "verdict": "APPROVED | CHANGES_REQUESTED | NEEDS_HUMAN",
  "summary": "string",
  "findings": [
    {
      "id": "CCC-001",
      "severity": "high | medium | low",
      "file": "optional/path",
      "line": 123,
      "message": "concrete problem and evidence"
    }
  ]
}
```

`file` and `line` may be optional.

### Feedback to Claude

On `CHANGES_REQUESTED`, block/continue Claude using the documented host lifecycle mechanism.

Tell Claude to:

- independently evaluate each finding,
- fix valid findings,
- reject invalid findings with reasoning,
- run relevant verification,
- preserve finding IDs,
- produce an updated implementation report.

Then re-review.

### Termination

Stop when:

- Codex returns valid `APPROVED`,
- Codex returns `NEEDS_HUMAN`,
- max review rounds is reached,
- reviewer infrastructure fails and safe continuation is not possible.

Default maximum: 3 review rounds.

## Safety

Already required:

- Codex cannot modify source code.
- Codex failure is never approval.
- No automatic commits/stashes/resets.
- Do not invoke shell using concatenated user/model text.
- Inactive Claude sessions are unaffected.

## Automated testing requirements

Follow `docs/testing.md`.

### Fake Codex executable

Create a fake Codex executable used through the same subprocess code path as production.

It must support scenarios such as:

- valid approval,
- valid changes requested,
- needs human,
- malformed JSON,
- non-zero exit,
- timeout,
- stderr output.

### Host/hook tests

Use realistic fake Claude hook payloads/harnesses.

Cover:

- inactive completion,
- activation,
- first-round approval,
- findings returned to Claude,
- second-round approval,
- max rounds,
- invalid reviewer output,
- reviewer non-zero exit,
- timeout,
- duplicate/re-entrant Stop hook.

### Workflow integration

At least one deterministic integration test must exercise:

```text
temporary Git repo
→ armed Claude host harness
→ completion event
→ fake Codex process
→ validated review result
→ allow/block decision
→ persisted round/state
```

The test suite must require no real Claude/Codex credentials.

## Acceptance criteria

- [x] Plugin/integration can be installed locally.
- [x] Review only runs when explicitly enabled.
- [x] Enabling records a Git baseline.
- [x] Claude can implement normally.
- [x] Claude completion triggers one logical Codex review round.
- [x] Valid Codex approval lets Claude finish.
- [x] Codex findings return to the same Claude task/session where the API permits.
- [x] Claude can fix findings and trigger a second review.
- [x] Loop stops at max 3 rounds.
- [x] Codex timeout/failure/invalid output is not approval.
- [x] Duplicate Stop/re-entry behavior has an automated regression test.
- [x] Fake Codex adapter tests exercise real subprocess invocation.
- [x] Full deterministic suite runs without credentials/network.
- [x] `status` shows whether review is active and current round.
- [x] At least one optional/manual real-world smoke test procedure is documented.

## Non-goals

Do not build the reverse Codex→Claude direction yet.

Do not build sophisticated finding fingerprinting or perfect dirty-change attribution.

## Completion report

Include:

- exact Claude extension points used,
- exact Codex invocation/safety controls used,
- automated tests added,
- failure paths covered,
- installation,
- example workflow,
- commands run and results,
- known API limitations.

## Implementation notes

Docs verified 2026-09-19 (code.claude.com hooks / plugins / plugins-reference / plugin-marketplaces / skills; `codex exec --help` of codex-cli 0.155.1, learn.chatgpt.com non-interactive docs and openai/codex source).

### Claude extension points used

- Plugin at the repo root: `.claude-plugin/plugin.json` (`name: ccc-review`), `.claude-plugin/marketplace.json` (`hlavacm`, source `./`), `hooks/hooks.json`, `skills/ccc-review/SKILL.md`. `claude plugin validate` passes.
- Activation: plugin skills are always namespaced, so the command is `/ccc-review:ccc-review on [task] | off | status`. A `UserPromptExpansion` hook (matcher `^(ccc-review:)?ccc-review$`; a bare `ccc-review` is an exact-string match and would miss the namespaced `ccc-review:ccc-review`) handles it from the JSON payload (`command_name`, `command_args`, `session_id`, `cwd`) and returns `{"decision":"block","reason":…}` so the result is shown to the user without a model turn and without building a shell command from user text. The skill (`disable-model-invocation: true`) is only a fallback telling the user review is NOT active if the hook did not run.
- Task context: `UserPromptSubmit` (`prompt`) records user prompts while active; text after `on` is recorded too.
- Review: `Stop` hook, `timeout: 1800` s. `last_assistant_message` is the writer report. `CHANGES_REQUESTED` → `{"decision":"block","reason":<findings + instructions>}` (same session continues). Other outcomes → `systemMessage` only. `stop_hook_active` is deliberately not a guard (re-review after a block is the loop); termination comes from `maxRounds` (3) and Claude Code's own 8-block cap.
- Session identity: `session_id` → `sessions/<id>.json` → `taskId`.

### Codex invocation / safety

`codex exec --sandbox read-only -c approval_policy="never" --cd <root> --ephemeral --color never --output-schema <strict schema> --output-last-message <file> -`, spawned as executable + argv, prompt on stdin, stdout ignored, stderr tail (4 KB) kept for messages. Codex runs in its own process group; at the deadline (default 20 min, `CCC_REVIEW_CODEX_TIMEOUT_MS`) the whole group is SIGKILLed and the review fails immediately, without waiting for streams to close, and a result arriving later is ignored. Missing binary, non-zero exit (incl. auth), timeout, missing/empty/invalid JSON output and shape mismatch are errors → core `reviewer_error` → task deactivated, never approved. The prompt forbids file and Git mutation; CCC Review itself only runs read-only `git` for the baseline.

State lives in `CCC_REVIEW_STATE_DIR` / `${CLAUDE_PLUGIN_DATA}` / `~/.ccc-review` (not inside `.git`, so the repository is never written): `tasks/`, `sessions/`, `claims/`.

### Bugs found and fixed (with regression tests)

- Node's `spawn({ timeout })` timer is only cleared on exit, so a spawn error (missing `codex`) kept the Stop hook process alive for the whole Codex timeout. Fixed with an own timer cleared on `error` and `close`; regression: `claude-workflow.test.ts` "missing codex binary fails fast" (verified to fail with the old code).
- (Found in Codex review) The `UserPromptExpansion` matcher `ccc-review` is an exact-string match, so `/ccc-review:ccc-review` never reached the hook. Fixed to `^(ccc-review:)?ccc-review$`; regression: `claude-workflow.test.ts` evaluates the matcher by the documented rules for both names and unrelated commands, and the workflow test now dispatches commands through the matcher (both verified to fail with the old matcher).
- (Found in Codex review) The timeout waited for `close`, which a grandchild holding stderr delayed, and a parent exiting 0 after the deadline was approved. Fixed: settle-once with the deadline winning, process-group kill, stderr destroyed; regressions in `codex-reviewer.test.ts` "timeout is enforced when a grandchild holds stderr open" and "a result arriving after the deadline is not approval" (both reproduced the bug before the fix and assert the grandchild is killed).

### Tests added

- `test/unit/codex-prompt.test.ts` — prompt contract, no invented context, dirty baseline incl. renames/odd names, previous findings + ID continuation, strict-schema compatibility.
- `test/unit/claude-feedback.test.ts` — writer feedback text, outcome → hook output (block only on `changes_requested`).
- `test/unit/review-loop.test.ts` — context pass-through.
- `test/integration/codex-reviewer.test.ts` — fake `codex` via the real subprocess path: approve, changes (null file/line), needs human, argv/stdin/cwd contract, previous findings, temp dir cleanup, malformed JSON, shape mismatch, missing findings, empty/no output, non-zero exit + stderr, auth-like failure, timeout kill, timeout with a grandchild holding stderr, late result after the deadline, missing executable, huge stderr (failure and success).
- `test/integration/claude-host.test.ts` — host harness with realistic payloads + real adapter + fake codex + real temp repo/state: inactive session, other sessions, activation + baseline, non-repo, repeated on/off/status/unknown, approval, changes → second-round approval (task/report/previous findings reach Codex), max rounds, needs human, invalid/shape/non-zero/timeout/missing-binary ≠ approval, sequential and concurrent duplicate Stop (verified to fail without the claim), subagent Stop ignored, corrupt task/session state, invalid payloads, invalid config, no Git mutation.
- `test/integration/claude-workflow.test.ts` — runs the exact `hooks.json` commands as subprocesses: temp repo → armed host → Stop → fake codex → block → Stop → approve → persisted state; missing-binary regression; garbage stdin + bad config; manifest sanity; command matcher selection.

### Known API limitations

- No documented, stable access to Claude's plan (transcript format undocumented) → the plan is not sent.
- Claude Code gives no completion event id; duplicates are identified by `last_assistant_message`, so an identical final message is not reviewed twice.
- `command_name` format for plugin skills is not documented; `ccc-review` and `ccc-review:ccc-review` are both accepted.
- Installation into a real Claude Code session and a real Codex review are covered only by the documented manual smoke test (README), since they need credentials.
