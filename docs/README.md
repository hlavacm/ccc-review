# CCCR — Development Guide

## Project

**CCCR — Claude Code ↔ Codex Review**

CCCR automates independent code review between Claude Code and Codex.

The architecture should support both directions:

- Claude Code writer → Codex reviewer
- Codex writer → Claude reviewer

However, the MVP should be implemented incrementally.

The first useful product milestone is:

> **Claude Code writer → Codex reviewer**

Do not delay that milestone by building every future abstraction first.

---

## Development approach

This specification is intentionally small.

Prefer:

- simple code,
- native host APIs,
- a small shared core,
- structured reviewer output,
- deterministic termination,
- strong automated tests,
- useful behavior over theoretical completeness.

Avoid solving problems before they are observed in real use.

Automated testing is part of the implementation. It is not optional follow-up work.

---

## Required reading

Before implementing any feature:

1. Read `docs/context.md`.
2. Read `docs/testing.md`.
3. Read the selected feature completely.
4. Inspect the current repository.
5. Verify current official Claude Code or Codex documentation if the feature touches their APIs.
6. Create a short implementation plan.
7. Implement only that feature.
8. Add or update the required automated tests.
9. Run the relevant automated test suite and project verification.
10. Inspect the resulting Git diff.
11. Fix issues discovered during verification.
12. Mark the feature `DONE` only when all acceptance criteria pass.

---

## Feature order

Implement features in numeric order unless explicitly instructed otherwise:

1. `01-core.md`
2. `02-claude-to-codex.md`
3. `03-stabilize-claude-to-codex.md`
4. `04-codex-to-claude.md`
5. `05-packaging-and-docs.md`

The project should already be genuinely useful after feature 02.

---

## Scope discipline

Do not automatically implement later features early.

Small prerequisites are acceptable when necessary, but do not pre-build:

- generalized plugin frameworks,
- complex state migration systems,
- semantic finding databases,
- distributed locking,
- web UI,
- services,
- MCP servers,
- cloud backends,
- elaborate compatibility frameworks.

If real usage later proves one of these necessary, add it then.

---

## Core rules

These rules apply throughout the project:

1. The active coding agent is the writer.
2. The other agent is the reviewer.
3. The reviewer must not modify source code.
4. Git/repository state is the source of truth.
5. Reviewer feedback is advisory; the writer evaluates it.
6. Reviewer failure is never approval.
7. Review loops must terminate.
8. Default maximum review rounds: 3.
9. Review activation must be explicit.
10. Do not automatically commit, reset, stash, checkout, rebase, or push.
11. Host-specific code stays outside the small shared core.
12. Use native Claude Code / Codex extension APIs instead of forcing identical integrations.
13. New behavior requires automated coverage.
14. Relevant failure paths require automated coverage.
15. A manually verified feature without automated coverage is not complete unless automation is genuinely impossible and the limitation is documented.

---

## Testing policy

`docs/testing.md` is normative.

The default test suite should:

- require no Claude credentials,
- require no Codex credentials,
- require no network access,
- not touch the developer's real repositories,
- use temporary Git repositories where Git behavior matters,
- use fake reviewer executables and host harnesses for integration tests.

Real Claude/Codex tests are optional smoke tests and do not replace deterministic automated tests.

---

## Definition of done

A feature is `DONE` only when:

- all acceptance criteria pass,
- new behavior has automated coverage,
- relevant success and failure paths have automated coverage,
- every practical bug fix has a regression test,
- all relevant automated tests pass,
- type checking passes,
- linting passes,
- formatting checks pass,
- build succeeds where applicable,
- the Git diff has been reviewed,
- no known correctness regression remains.

Manual verification alone is insufficient when the behavior can reasonably be automated.

---

## Suggested agent prompt

```text
Implement the next TODO feature according to docs/README.md.

Read docs/context.md, docs/testing.md, and the selected feature completely.
Inspect the repository and create a plan before implementation.

Treat testability as part of the design.
Implement the feature together with strong automated coverage of:
- the main behavior,
- relevant failure paths,
- regression cases.

Use real temporary Git repositories for Git behavior and fake Claude/Codex
executables or host harnesses for agent integration so the default suite
does not require credentials or network access.

Run the relevant unit/integration tests, typecheck, lint, formatting checks,
and build. Inspect the Git diff and fix discovered problems.

Mark the feature DONE only if its acceptance criteria and verification pass.
Do not continue automatically to the next feature.

At the end report:
- what was implemented,
- automated tests added,
- failure paths covered,
- commands executed and results,
- anything intentionally left untested and why.
```
