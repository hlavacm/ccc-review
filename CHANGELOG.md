# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-20

First release.

### Added

- **Claude Code writer → Codex reviewer**: a Claude Code plugin with the
  commands `/ccc-review:on`, `/ccc-review:current`, `/ccc-review:status` and `/ccc-review:off`.
- **Codex writer → Claude Code reviewer**: a Codex plugin with the command
  `$ccc-review on|current|status|off`.
- **Review as you go** (`on`): every time the writer finishes a turn, the
  other agent reviews the real repository changes, read-only, and its
  findings go back to the writer, which fixes or rejects them and is reviewed
  again.
- **Audit after the work** (`current`): the writer writes down the task, its
  plan and its report, and the other agent audits the uncommitted changes
  once. Findings are shown; nothing is fixed automatically.
- Structured verdicts (`APPROVED`, `CHANGES_REQUESTED`, `NEEDS_HUMAN`) with
  stable finding IDs (`CCC-001`, …) preserved across rounds.
- Bounded loop: at most 3 rounds by default (`CCC_REVIEW_MAX_ROUNDS`), and one
  round per completion even when a completion event is delivered twice.
- A completion that changed nothing since a clean activation (the writer only
  asked a question) is not reviewed and uses no round.
- Every reviewer failure (missing binary, no login, non-zero exit, timeout,
  invalid output, abort) stops the review and is never treated as approval.
- An unreadable state file never wedges a session: `on` starts a fresh task and
  `off` resets the session.
- Git baseline at activation (root, `HEAD`, branch, dirty paths). CCC Review never
  commits, stashes, resets, checks out, rebases or pushes.
- Security: the reviewer cannot edit code (Codex in its read-only sandbox,
  Claude with Read/Grep/Glob only and no shell); processes are started as
  executable + arguments, never through a shell; Git is called so that it
  runs no program configured by the repository (external diff, textconv,
  fsmonitor); state directories are private to the user (`0700`).
- Configuration through a small set of environment variables: rounds,
  timeouts, reviewer binary, model and effort, state directory.
- Installation through the bundled `hlavacm` marketplace for both CLIs.
- Requirements: macOS or Linux, Git and Node.js ≥ 24; no runtime
  dependencies and no build step.
- A deterministic test suite that needs no credentials or network (real
  temporary Git repositories, fake `claude`/`codex` executables, host
  harnesses), plus opt-in smoke tests against the real CLIs.

[1.0.0]: https://github.com/hlavacm/ccc-review/releases/tag/v1.0.0
