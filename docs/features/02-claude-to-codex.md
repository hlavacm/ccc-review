# 02 — Claude Code Writer → Codex Reviewer

## Status

TODO

## Objective

Deliver the first genuinely useful CCCR workflow:

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
/cccr on
/cccr off
/cccr status
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

- [ ] Plugin/integration can be installed locally.
- [ ] Review only runs when explicitly enabled.
- [ ] Enabling records a Git baseline.
- [ ] Claude can implement normally.
- [ ] Claude completion triggers one logical Codex review round.
- [ ] Valid Codex approval lets Claude finish.
- [ ] Codex findings return to the same Claude task/session where the API permits.
- [ ] Claude can fix findings and trigger a second review.
- [ ] Loop stops at max 3 rounds.
- [ ] Codex timeout/failure/invalid output is not approval.
- [ ] Duplicate Stop/re-entry behavior has an automated regression test.
- [ ] Fake Codex adapter tests exercise real subprocess invocation.
- [ ] Full deterministic suite runs without credentials/network.
- [ ] `status` shows whether review is active and current round.
- [ ] At least one optional/manual real-world smoke test procedure is documented.

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
