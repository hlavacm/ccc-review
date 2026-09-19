# 05 — Packaging, Documentation, and First Release

## Status

DONE — acceptance criteria covered by the deterministic suite (`test/integration/packaging.test.ts`), the opt-in install smoke test against the real CLIs, and a clean `pnpm install --frozen-lockfile && pnpm check` from a fresh copy. The GitHub Actions workflow has not run yet (no remote).

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

- [x] Fresh clone can be built/tested from documented steps.
- [x] Full deterministic suite runs without credentials/network.
- [x] Claude→Codex installation is documented and tested.
- [x] Codex→Claude installation is documented and tested.
- [x] Both workflows have short copyable examples.
- [x] Testing strategy is documented.
- [x] Security/privacy limitations are documented.
- [x] Uninstall instructions exist.
- [x] Local state/secrets are not packaged.
- [x] All unit/integration/workflow tests pass.
- [x] Typecheck/lint/format/build pass.
- [x] Optional real CLI smoke tests are clearly separated from default tests.

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

## Implementation notes

Verified 2026-09-19 with the local CLIs (Claude Code 2.1.278, codex-cli 0.155.1: `claude plugin --help`, `claude plugin validate`, `codex plugin --help`, `codex plugin marketplace add --help`) by installing into throwaway `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.

### Install paths

| | Install | Upgrade | Uninstall |
| --- | --- | --- | --- |
| Claude Code | `claude plugin marketplace add <clone>` + `claude plugin install cccr@cccr-local` (cache `<config>/plugins/cache/cccr-local/cccr/<version>`) | `marketplace update` + `plugin update` when the version changed; same version: uninstall + install | `claude plugin uninstall cccr@cccr-local` + `marketplace remove cccr-local` |
| Codex | `codex plugin marketplace add <clone>` + `codex plugin add cccr@cccr-local` (cache `$CODEX_HOME/plugins/cache/cccr-local/cccr/<version>`), then trust the hooks in `/hooks` | `git pull` + `codex plugin add cccr@cccr-local` again (re-copies) | `codex plugin remove cccr@cccr-local` + `marketplace remove cccr-local` |

Both CLIs copy a local-path marketplace directory as-is, untracked files included (observed: `node_modules/`, `dist/`, `.claude/`), so the README says to install from a clean clone. The hooks need only Node ≥ 22.18: `src/` imports nothing but `node:*` and relative modules.

### Fixed during this feature (regression tests verified to fail first)

- README told Codex users to run `codex plugin add cccr`; Codex rejects it (`plugin requires --marketplace unless passed as <plugin>@<marketplace>`). Now `cccr@cccr-local`; `packaging.test.ts` checks every `codex plugin add|remove` line against the manifests.
- After Codex review of this feature: the runtime-import check missed side-effect `import "pkg"` (also into `test/`), and the packaged-state check missed extension-less `claims/<taskId>/<hash>` files. Both fixed and mutation-tested (side-effect package import, side-effect import of `test/fixtures`, dynamic `import("pkg")`, a planted claim file).
- Running a single smoke test as `pnpm test:smoke --test-name-pattern=…` does not filter (Node ignores options after the file glob) and would run the usage-consuming smoke tests. Added `pnpm test:smoke:install` instead; the README test only allows existing scripts.

### Tests

- `test/integration/packaging.test.ts` (14): MIT license, version equal in `package.json` and both plugin manifests; packaged files (`git ls-files --cached --others --exclude-standard`) contain no `node_modules`/`dist`/`coverage`, `.cccr/`, `.env*`, keys, `.claude/settings.local.json` or task/session/claim/history state; no credential patterns in any packaged file; `src/` imports only `node:*` and modules inside `src/` (no npm dependency, no test code); `fake` files only under `test/`; README tagline, required sections, every `pnpm <script>` it mentions exists, every `CCCR_*` variable read in `src/` is documented, install/uninstall ids match the manifests. A copy of exactly the packaged files (no `node_modules`) runs both plugins through their `hooks.json` command lines: Claude→Codex and Codex→Claude approval, and a reviewer exiting 3 with an APPROVED result is an error that stops the task, not approval. Each hygiene check was mutation-tested (planted token, npm/test import, version mismatch, stray `fake` file, unignored state file, wrong README command).
- `test/helpers/plugin-hooks.ts`: shared hook runner/package copy, now also used by `claude-workflow.test.ts` and `codex-workflow.test.ts` (replacing two copies).
- `test/smoke/install.smoke.ts` (`pnpm test:smoke:install`, opt-in, no credentials/model; skipped without the CLIs): `claude plugin validate`, then the README's install, run of the installed hooks with fake reviewers, and uninstall for both CLIs. Claude Code upgrade: same version → `plugin update` keeps the old copy, uninstall + install picks up the change; version bump → `marketplace update` + `plugin update` installs the new version, and its hooks run. Codex upgrade: `plugin add` again re-copies. Passed locally.
- `.github/workflows/ci.yml`: `pnpm install --frozen-lockfile && pnpm check` on Node 22.18 and 24, no secrets.

Suite: 331 deterministic tests (103 unit, 228 integration), all passing; `pnpm check` passes. The same 331 pass in a copy of the packaged files with no `node_modules`, an empty `HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR`, a minimal environment and no network.

### Limitations

- 2026-09-19: `pnpm install --frozen-lockfile && pnpm check` passed in a fresh copy of the packaged files (pnpm 12.4.2, Node 26.9: 331/331 tests, typecheck, Biome, build), run outside the development sandbox with `set -e`. The GitHub Actions workflow has not run yet (no remote).
- The interactive TUIs (Claude Code `/cccr:cccr`, Codex `$cccr` and `/hooks` trust) are covered by hook-level tests and the install smoke test, not by a scripted TUI session.
- Runtime messages still say `CCC Review`.

### Ideas for v2 (only if real use asks for them)

- Publish the marketplace from GitHub (`claude plugin marketplace add owner/repo`, `codex plugin marketplace add owner/repo`) and tag releases with `claude plugin tag`.
- Pass the writer's plan once a host exposes it.
- Per-repository configuration if the environment variables turn out to be too coarse.
