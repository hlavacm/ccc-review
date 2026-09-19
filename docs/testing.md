# CCCR — Automated Testing Strategy

## Goal

CCCR must have a strong automated test suite.

Automated tests are part of the implementation, not optional follow-up work.

A feature is not complete merely because the implementation works manually.

Every feature must include automated tests for its behavior and relevant failure modes.

---

## Testing principles

Tests should primarily verify observable behavior and contracts rather than implementation details.

Prefer deterministic tests that:

- require no real Claude credentials,
- require no real Codex credentials,
- require no network access,
- do not depend on timing-sensitive sleeps,
- do not modify the developer's real repositories,
- can run repeatedly from a clean checkout,
- fail clearly when a contract is broken.

Real Claude/Codex smoke tests may exist, but they must be optional and separate from the default automated suite.

---

## Required test layers

### 1. Unit tests

Use unit tests for pure or mostly pure logic.

Examples:

- review-loop decisions,
- max-round handling,
- verdict handling,
- state serialization,
- configuration,
- finding ID handling,
- prompt construction,
- error classification.

These tests should be fast and deterministic.

Critical review-loop branches should receive especially strong coverage.

---

### 2. Git integration tests

Git behavior must be tested against real temporary Git repositories.

Create temporary repositories during tests rather than mocking Git output where practical.

Cover at least:

- clean repository,
- dirty tracked files,
- staged changes when applicable,
- untracked files,
- file creation,
- modification,
- deletion where relevant,
- branch changes where relevant,
- unusual filenames.

Tests must prove that CCCR does not mutate Git state unexpectedly.

Never run these tests against the developer's active repository.

---

### 3. Reviewer adapter contract tests

Claude and Codex reviewer adapters must be testable without real model calls.

Provide fake reviewer executables that emulate:

- successful approval,
- changes requested,
- needs human,
- malformed JSON,
- schema/shape mismatch,
- non-zero exit,
- timeout,
- excessive output where limits exist,
- authentication-like failure.

The adapter should execute the fake binary through the same subprocess path used in production.

Do not bypass the real process-runtime code merely to simplify tests.

---

### 4. Host integration tests

Lifecycle integrations must be tested using realistic fake hook payloads or host harnesses.

Test at least:

- inactive task/session,
- activation,
- first completion event,
- approval,
- changes requested,
- continuation,
- second review round,
- max-round termination,
- duplicate lifecycle invocation,
- recursion/re-entry guard,
- reviewer failure.

The most important lifecycle invariant is:

> One logical completion event must not accidentally start multiple review rounds.

This requires an explicit regression test.

---

### 5. Workflow integration tests

Test complete CCCR flows using as much production code as practical:

- temporary Git repository,
- fake host/hook harness,
- fake reviewer executable,
- real shared core,
- real state persistence,
- real subprocess runtime.

Minimum automated scenarios:

#### Approval

```text
writer finishes
→ reviewer approves
→ task completes
```

#### Changes then approval

```text
writer finishes
→ reviewer requests changes
→ writer continues
→ second review approves
→ task completes
```

#### Bounded loop

```text
writer finishes
→ reviewer repeatedly requests changes
→ max review rounds reached
→ loop terminates safely
```

#### Reviewer failure

```text
writer finishes
→ reviewer process fails
→ task is NOT approved
```

#### Duplicate completion event

```text
host emits equivalent completion event twice
→ at most one logical review round is created
```

These tests should exercise the real orchestration path rather than reproducing the logic in test-only helpers.

---

## Both directions

Once both directions exist, the automated suite must cover:

```text
Claude writer → Codex reviewer
Codex writer  → Claude reviewer
```

Important shared workflow behavior should not be tested in only one direction unless it is genuinely host-specific.

The reverse direction should reuse shared scenario fixtures where practical.

---

## Failure-path requirement

For infrastructure code, failure paths are as important as happy paths.

Every external boundary should have automated failure coverage.

Examples:

- executable not found,
- malformed reviewer output,
- reviewer timeout,
- non-zero process exit,
- corrupt state file,
- invalid configuration,
- Git command failure where practical,
- repeated hook invocation,
- unsupported external API/capability where detectable.

The invariant:

> Infrastructure failure must never accidentally become approval.

This must have explicit automated regression coverage.

---

## Regression tests

Every confirmed bug should receive an automated regression test whenever practical.

Preferred workflow:

1. reproduce the bug with a failing test,
2. fix the implementation,
3. verify the new test passes,
4. keep the test permanently.

Do not fix recurring lifecycle, state, subprocess, or review-loop bugs without adding regression coverage unless automation is genuinely impossible.

If impossible, document why.

---

## Test doubles

Prefer purpose-built test doubles over extensive mocking.

Useful infrastructure may include:

```text
FakeReviewer
FakeHost
FakeCodexExecutable
FakeClaudeExecutable
TemporaryGitRepository
TemporaryStateDirectory
```

Mocks are acceptable for small unit boundaries.

Major workflow tests should exercise real production components together.

---

## Fake reviewer executables

Fake Claude/Codex executables are especially important.

They should be able to:

- inspect received argv,
- inspect stdin/input files when applicable,
- emit configured valid structured output,
- emit malformed output,
- exit non-zero,
- sleep long enough to trigger timeout,
- emit stderr,
- simulate missing capabilities if needed.

This validates the actual subprocess integration without consuming model usage.

---

## Real CLI smoke tests

Optional smoke tests may invoke real Claude Code and Codex installations.

These tests must:

- be opt-in,
- never run automatically in normal CI/default tests,
- clearly state that credentials/usage may be consumed,
- use a disposable temporary repository,
- never operate on the developer's active working repository.

They are supplementary.

They do not replace deterministic automated tests.

---

## Test commands

The repository should expose clear commands equivalent to:

```text
test
test:unit
test:integration
test:all
```

Exact package-manager syntax may differ.

The default `test` command should run all deterministic tests that require no external credentials.

If useful:

```text
test:smoke
```

may exist for opt-in real CLI checks.

---

## Completion gate

A feature may be marked `DONE` only when:

- new behavior has automated coverage,
- relevant failure modes have automated coverage,
- all existing deterministic tests pass,
- type checking passes,
- linting passes,
- formatting checks pass,
- build passes where applicable.

Manual verification alone is insufficient when automation is practical.

---

## Coverage

Do not optimize for an arbitrary coverage percentage at the expense of useful tests.

Coverage tooling may be used to identify obviously untested code.

Behavioral coverage is more important than a global number.

Critical code should receive strong branch coverage:

- review-loop termination,
- lifecycle re-entry protection,
- reviewer result validation,
- infrastructure error handling,
- Git baseline logic,
- state persistence around review rounds.

If coverage thresholds are introduced, keep them targeted and meaningful rather than chasing 100%.

---

## CI expectation

The complete deterministic automated suite should eventually be suitable for running on every pull request.

It must not require:

- Claude credentials,
- Codex credentials,
- network access,
- a pre-existing Git repository,
- developer-specific files,
- access to the developer's actual home project state.

The project should be testable from a clean checkout.

---

## Test reporting

At the end of every feature implementation, report:

- tests added,
- success paths covered,
- failure paths covered,
- regression tests added,
- commands executed,
- results,
- intentionally untested behavior and why.

Do not simply report "tests pass" without stating what was tested.
