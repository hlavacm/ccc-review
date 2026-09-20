# 06 — One-Shot Audit On Demand

## Status

DONE — acceptance criteria covered by the deterministic suite and checked in real Claude Code with the real Codex reviewer (approval and findings). `$ccc-review current` ran in the real Codex TUI too; the fix it led to (instructions from the hook) still has to be re-checked there.

## Objective

Let the user ask for an independent audit **after** the work is done, with one command:

> The writer already planned and implemented something. The user types one command. The writer packages the task, its plan and its report; the other agent audits the real uncommitted changes; the verdict and findings come back. Nothing is fixed automatically.

This is the manual habit the project automates ("Claude got this task … did this, see git and the report … is it correct and OK?"). It complements `on`, which must be armed before the work.

## Dependencies

- `05-packaging-and-docs.md`

## Required reading

- `docs/context.md`
- `docs/testing.md`

## Decisions (made by the owner, 2026-09-19)

- Command: `/ccc-review:current [note]` in Claude Code, `$ccc-review current [note]` in Codex ("review the current uncommitted changes"). Messages call the mode an audit.
- Scope: uncommitted changes only (staged, unstaged, untracked) against `HEAD`. Committed work is not audited.
- One round, no loop: the writer shows the result and changes nothing; the user decides what happens next.

## Requirements

1. The hook handles the command but, unlike `on|off|status`, does **not** block it when it succeeds: it arms a one-round audit task and lets the skill text reach the writer. The skill tells the writer to write, as its final message, the original task, its plan and its implementation report, and to change no files.
   - Why the writer writes it: a command hook gets neither the last assistant message nor the plan, prompts are only recorded while review is on, and the transcript format is undocumented. Do not read the transcript.
2. The writer's completion triggers the existing `Stop` path: one review round with that message as the report.
3. The reviewer prompt says this is an audit of **all uncommitted changes, which are the writer's work** (not "pre-existing dirty state"), and still gets the note, if any, as the task.
4. Outcomes:
   - `APPROVED` → message to the user, writer finishes.
   - `CHANGES_REQUESTED` → the findings go to the writer with the instruction to present them to the user and **not** to modify anything; the task is over (no second round, no re-review).
   - `NEEDS_HUMAN`, reviewer failure → as today; failure is never approval.
5. Refuse (blocked, with the reason, nothing armed) when: not a Git repository, the reviewer is missing or not logged in, there are no uncommitted changes, or review is already active in the session.
6. `status` shows the audit like any task; `off` cancels an armed audit.
7. Reuse the core loop (`maxRounds: 1`), claims, history and reviewers. No new state format version, no transcript parsing, no configuration.

## Automated testing requirements

Shared scenarios for both directions (`test/helpers/host-scenarios.ts`), through the real reviewer adapters and fake CLIs:

- audit of uncommitted changes → approval; the command is not blocked; the reviewer prompt carries the audit wording, the note and the writer's package,
- findings → returned once with the "present, do not modify" instruction; task inactive; a later completion is not reviewed; the reviewer ran once,
- nothing uncommitted → refused,
- review already active → refused, the active task untouched,
- reviewer missing → refused,
- reviewer failure during the audit → not approved,
- duplicate completion → one round,
- Git state never mutated.

Host-specific: command matcher/skill set (Claude Code), `$ccc-review current` reaches the model while `on|off|status` stay blocked (Codex), allowed output keys (Codex). Unit: prompt wording, audit feedback text. Packaging: README documents the command.

## Acceptance criteria

- [x] One command audits uncommitted work without arming review beforehand.
- [x] The writer's package (task, plan, report) reaches the reviewer.
- [x] Findings come back once; nothing is changed automatically; no second round.
- [x] Every refusal and failure path above is covered and never approves.
- [x] Both directions covered by shared scenarios.
- [x] Existing `on|off|status` behaviour unchanged (existing suite passes).
- [x] README documents the command and its limits.
- [x] Real-use check of the command in Claude Code recorded here.

## Non-goals

Auditing commits or branches, automatic fixing after an audit, reading the host transcript, configurable scope.

## Implementation notes

Implemented 2026-09-19. No host API was new: the command rides on the hooks verified for features 02/04 (a `UserPromptExpansion`/`UserPromptSubmit` hook that prints nothing lets the prompt through).

- `runCommand` (`src/hosts/common.ts`) returns `string | undefined`: text = the host blocks the prompt with it, `undefined` = let the prompt reach the writer. `current` shares the `on` path (baseline, reviewer preflight, corrupt-state handling) with `maxRounds: 1`, `Session.audit`, history event `audit`, and refuses a clean tree or an active task.
- The report comes from the writer: `skills/current/SKILL.md` (Claude Code) and the `current` branch of `codex/skills/ccc-review/SKILL.md` ask for task, plan and report and forbid changing files. The `Stop` path is unchanged; `ReviewContext.audit` switches one prompt paragraph ("ALL uncommitted changes … are the writer's work" instead of "ALREADY dirty").
- A one-round task with findings ends as `max_rounds` in the core; for an audit the host turns that into a block with `auditFeedback` (present, do not modify, nothing is reviewed again). The task is already inactive, so the writer's next completion is not reviewed. `status` shows `mode: audit` and no "(max rounds reached)".
- Core changes are host-agnostic: history event `audit`, `ReviewContext.audit`.

Tests (written first; 12 scenario tests failed before the implementation): `host-scenarios.ts` "one-shot audit of uncommitted work" × both directions (not blocked + approval + prompt content, findings once and no second round, clean tree refused, refused while `on` is active, failing reviewer, duplicate completion + `off`, Git not mutated); `claude-host.test.ts` (missing reviewer refused and blocked, `ccc-review:currently` ignored); `codex-host.test.ts` (`$ccc-review current` reaches the model, other commands stay blocked, refusal has only allowed keys); `claude-workflow.test.ts` (matcher ↔ skills); unit: prompt wording, `auditFeedback`, history event.

Real use (2026-09-19, Claude Code 2.1.278, real Codex, disposable repo, `claude --plugin-dir`): `/ccc-review:current zkontroluj to prosím` in a fresh session over uncommitted work (`math.js` modified, `math.test.js` untracked). The command was not blocked, the skill text reached Claude although the skill has `disable-model-invocation`, and Claude wrote Task/Plan/Report, saying plainly that it did not know the original task in this new session and had derived everything from Git; it changed no files. Codex audited the changes including the untracked file and answered in the note's language: `Codex APPROVED (round 1/1)`, 41 s in total.

Findings path, same day: a `divide = (a, b) => a * b` was planted by hand, then `/ccc-review:current přidal jsem divide(a, b), má dělit`. Claude reported that the user had made the change and that it had run no tests. Codex returned `CCC-001 [high] math.js:3` (verified by running it: `divide(6, 3)` is 18). Claude presented the finding with its own assessment, added a point Codex had not raised (division by zero), stated that it had modified no files and asked what to fix; no second review ran. Claude Code labels the returned findings "Stop hook error:", which is its wording for any blocking Stop hook. With `CCC_REVIEW_CODEX_BIN=/nonexistent`, `/ccc-review:current` was refused and blocked ("not enabled: codex executable not found"), so Claude wrote no report. Still to exercise: `$ccc-review current` in the Codex TUI.

Real Codex TUI (2026-09-20, codex-cli 0.155.1): `$ccc-review current přidal jsem divide(a, b), má dělit` was not blocked, the Claude reviewer audited the planted bug (`CCC-001 [high] math.js:3`, `CCC-002` missing test), Codex presented both findings with its own assessment and changed nothing (`git diff --stat`: only the user's two lines). But Codex said "the ccc-review skill is not available" and wrote a short review of its own instead of Task/Plan/Report: the session record shows that Codex neither lists the skill for the model (`allow_implicit_invocation: false`) nor injected its text for the typed mention. Fixed: the Codex hook now returns the instructions itself as `hookSpecificOutput.additionalContext` (supported for `UserPromptSubmit`, checked in `codex-rs/hooks/src/events/user_prompt_submit.rs`), from `auditInstructions()` in `common.ts`, which also says that the message is a report, not the writer's own review. `codex-host.test.ts` "`current` reaches the model…" asserts the exact output keys and the content. Claude Code keeps using the skill text, which worked in real use.

Limits: only uncommitted work; the task/plan part is the writer's own summary (the reviewer is told to treat the report as unverified); if the hooks are not installed the skill still makes the writer write a report and nothing follows.
