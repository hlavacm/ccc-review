# CCCR — MVP Context

## Name

**CCCR**

Expanded name:

> **Claude Code ↔ Codex Review**

---

## Purpose

CCCR automates a workflow that already works manually:

1. one coding agent plans and implements a task,
2. another coding agent independently reviews the real repository changes,
3. review findings are returned to the first agent,
4. the writer fixes valid findings or rejects invalid ones with reasoning,
5. review repeats until approval or a bounded stop condition.

The initial implementation target is:

```text
Claude Code writer → Codex reviewer
```

The architecture should make the reverse direction possible later:

```text
Codex writer → Claude reviewer
```

---

## MVP philosophy

Do not over-engineer.

The first version should prove that this loop is useful in daily development.

A small reliable implementation with strong automated tests is better than a highly generalized framework.

---

## Minimal architecture

Use a structure conceptually similar to:

```text
src/
├── core/
│   ├── types
│   ├── review-loop
│   └── state
│
├── reviewers/
│   ├── codex
│   └── claude        # added later
│
├── hosts/
│   ├── claude-code
│   └── codex         # added later
│
└── git
```

Exact names may differ.

The important boundary is:

```text
shared core
    ↑
host adapter + reviewer adapter
```

The core must not know Claude Code hook details or Codex hook details.

---

## Review model

A minimal shared result is enough:

```ts
type Verdict =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "NEEDS_HUMAN";

interface Finding {
  id: string;
  severity: "high" | "medium" | "low";
  file?: string;
  line?: number;
  message: string;
}

interface ReviewResult {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}
```

This can evolve later if real use requires richer fields.

---

## Finding IDs

For the MVP, simple per-task IDs are sufficient:

```text
CCC-001
CCC-002
CCC-003
```

When reviewing again, instruct the reviewer to preserve the existing ID when referring to the same unresolved issue.

Do not build semantic fingerprinting or sophisticated cross-round deduplication yet.

---

## Review loop

Default behavior:

```text
round = 1

review

APPROVED
    → finish

CHANGES_REQUESTED
    → return findings to writer
    → writer fixes/rejects
    → review again

NEEDS_HUMAN
    → stop and report

round >= 3
    → stop and report
```

A simple explicit implementation is enough.

Do not introduce a state-machine framework unless the implementation genuinely needs one.

The review-loop logic is critical and requires strong automated branch coverage.

---

## Git baseline

At review activation, record at least:

```text
repository root
HEAD SHA
branch if available
git status --porcelain (or better machine-readable equivalent)
```

Repositories may already be dirty.

Do not assume all uncommitted changes belong to the writer.

For the MVP, perfect line-level attribution of pre-existing changes is not required.

The reviewer prompt should explicitly say that pre-existing dirty state may exist.

Do not create hidden commits or automatically stash/reset files.

Git behavior should be tested using real temporary Git repositories rather than only mocks.

---

## Reviewer behavior

The external reviewer should:

- inspect the actual repository,
- inspect Git changes,
- compare implementation with the original task,
- compare with the implementation plan if available,
- compare with the writer's implementation report,
- inspect relevant surrounding code,
- report material issues only,
- provide concrete evidence,
- not modify source code.

Material issues include:

- correctness bugs,
- regressions,
- security issues,
- data loss risk,
- concurrency problems,
- API contract violations,
- materially missing error handling,
- materially missing tests,
- implementation claims contradicted by the repository.

Avoid:

- style preferences,
- trivial formatting,
- unrelated refactors,
- speculative findings,
- micro-optimizations.

---

## Writer behavior after findings

The writer should be told:

1. Evaluate every finding independently.
2. Do not assume reviewer feedback is automatically correct.
3. Fix valid findings.
4. Reject invalid findings with concrete reasoning.
5. Run relevant verification.
6. Produce an updated implementation report.
7. Preserve finding IDs when discussing them.

Example:

```text
CCC-001: fixed
Reason: ...
Verification: ...

CCC-002: rejected
Reason: ...
```

---

## Structured output

Prefer native structured JSON output from the reviewer CLI.

Do not parse arbitrary prose if the reviewer supports JSON/schema output.

A reviewer process error, invalid JSON, timeout, missing executable, or authentication failure must never become `APPROVED`.

Each such failure path should have deterministic automated coverage.

---

## Explicit activation

CCCR must not run for every session by default.

Use an explicit host-native activation mechanism.

Preferred Claude Code UX if current APIs support it naturally:

```text
/cccr on
/cccr off
/cccr status
```

Codex may use a different native command/skill syntax.

Equivalent semantics matter more than identical syntax.

---

## Security minimum

Already in the MVP:

- reviewer source-code read-only mode,
- no shell command concatenation,
- spawn processes with executable + argv,
- max 3 review rounds,
- reviewer error ≠ approval,
- no automatic Git mutation,
- explicit activation.

Anything beyond this should be driven by observed need.

These invariants should be protected by regression tests where practical.

---

## Compatibility

Claude Code and Codex change frequently.

Before implementing their integrations, verify current official documentation.

Do not implement against remembered CLI flags if current docs differ.

Keep product-specific invocation code concentrated in its adapter so it can be changed later.

---

## Testing philosophy

Testing is a first-class design requirement.

Prefer:

- pure unit tests for loop/state logic,
- real temporary Git repositories for Git behavior,
- fake external executables for reviewer adapters,
- realistic fake host payloads/harnesses for lifecycle integration,
- workflow tests that exercise real production components together.

Do not make the default suite depend on paid model calls.

See `docs/testing.md`.

---

## Non-goals for MVP

Do not build yet:

- generic multi-agent orchestration,
- semantic finding fingerprints,
- sophisticated finding lifecycle database,
- multi-machine concurrency,
- generalized migration framework,
- web dashboard,
- remote service,
- MCP server,
- automatic commits,
- CI platform,
- perfect attribution of dirty repository changes,
- extensive plugin marketplace packaging before basic local use works.
