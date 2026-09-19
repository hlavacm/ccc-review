# 05 — Packaging, Documentation, and First Release

## Status

TODO

## Objective

Turn the working local implementation into a clean GitHub project that is easy to install and use across repositories.

Both host integrations must be installable and documented, and the deterministic automated suite must be suitable for running from a clean checkout.

## Dependencies

- `04-codex-to-claude.md`

## Required reading

- `docs/context.md`
- `docs/testing.md`

## Requirements

### README

The root README should clearly say:

```text
CCCR
Claude Code ↔ Codex Review

Use Claude Code to implement and Codex to review,
or Codex to implement and Claude Code to review.
```

Explain:

- what problem it solves,
- writer vs reviewer roles,
- installation,
- Claude→Codex usage,
- Codex→Claude usage,
- configuration,
- status/disable commands,
- max-round behavior,
- error behavior,
- test strategy,
- limitations.

### Installation

Provide practical local installation instructions for both host integrations using current native mechanisms.

Document:

- prerequisites,
- Claude Code requirement,
- Codex requirement,
- authentication expectations,
- upgrade,
- uninstall.

### Security/privacy

Document that reviewer context may include:

- original task,
- implementation plan where available,
- implementation report,
- Git metadata,
- repository contents available to the reviewer,
- previous findings.

Explain:

- reviewer is configured as read-only for source code,
- CCCR does not auto-commit/reset/stash/push,
- reviewer failures do not count as approval.

### Configuration

Keep configuration small.

Only expose options that are genuinely useful, such as:

- max rounds,
- timeout,
- optional reviewer model/effort if supported.

Do not create a huge configuration surface.

### Test commands

Document commands equivalent to:

```text
test
test:unit
test:integration
test:all
```

If optional real-agent smoke tests exist, document them separately and clearly state that they may consume credentials/usage.

### Clean-checkout verification

The deterministic suite must run from a clean checkout without:

- Claude credentials,
- Codex credentials,
- network access,
- developer-specific state.

### Release hygiene

Ensure:

- license exists,
- local task state is ignored/not packaged,
- tests pass from a clean checkout,
- installation instructions have been smoke-tested,
- fake executables/test fixtures are packaged only where intended,
- no credentials/secrets are present.

## Acceptance criteria

- [ ] Fresh clone can be built/tested from documented steps.
- [ ] Full deterministic suite runs without credentials/network.
- [ ] Claude→Codex installation is documented and tested.
- [ ] Codex→Claude installation is documented and tested.
- [ ] Both workflows have short copyable examples.
- [ ] Testing strategy is documented.
- [ ] Security/privacy limitations are documented.
- [ ] Uninstall instructions exist.
- [ ] Local state/secrets are not packaged.
- [ ] All unit/integration/workflow tests pass.
- [ ] Typecheck/lint/format/build pass.
- [ ] Optional real CLI smoke tests are clearly separated from default tests.

## Non-goals

No hosted service, marketplace launch, website, telemetry backend, Docker requirement, or MCP server.

## Completion report

Summarize:

- install paths,
- supported/tested versions,
- automated test suite composition,
- commands run/results,
- remaining limitations,
- sensible ideas for a future v2 based on actual use.
