# CCCR MVP specification

This archive contains the simplified, test-heavy implementation specification for **CCCR**.

CCCR = **Claude Code ↔ Codex Review**.

The MVP intentionally prioritizes a small architecture and a strong automated test suite.

The first useful milestone is:

```text
Claude Code writer
    ↓
Claude finishes
    ↓
CCCR completion hook
    ↓
Codex read-only review
    ↓
APPROVED
or
CHANGES_REQUESTED → feedback back to Claude
```

Only after that workflow is stable should the reverse direction be added:

```text
Codex writer → Claude reviewer
```

## Recommended first agent prompt

```text
Implement the next TODO feature according to docs/README.md.

Read docs/context.md, docs/testing.md, and the selected feature completely.
Inspect the repository and create a short implementation plan first.

Treat automated tests as part of the implementation, not as cleanup.
Cover the new behavior, relevant failure paths, and regression scenarios.
Use temporary Git repositories and fake Claude/Codex executables or host harnesses
where appropriate so the default test suite needs no credentials or network access.

Implement and verify only that feature.
Do not automatically continue to the next feature.

Mark the feature DONE only if its acceptance criteria pass and the relevant
automated test suite, typecheck, lint, and build all succeed.
```

Start with `docs/features/01-core.md`.

## Development

Requires Node.js ≥ 22.18 and Git.

```sh
pnpm install
pnpm test                 # all deterministic tests (no credentials, no network)
pnpm test:unit
pnpm test:integration # real temporary Git repositories
pnpm test:coverage
pnpm typecheck
pnpm lint             # Biome lint + format check; `pnpm format` to fix
pnpm build            # emits dist/
pnpm check            # typecheck + lint + test + build
```
