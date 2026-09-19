# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-19

First release.

### Added

- **Claude Code writer → Codex reviewer**: a Claude Code plugin with the
  `/cccr:cccr on|off|status` command. Every time Claude finishes a turn, a
  read-only `codex exec` reviews the real repository changes and the findings
  go back to Claude.
- **Codex writer → Claude Code reviewer**: a Codex plugin with the
  `$cccr on|off|status` command. Every time Codex finishes a turn, a
  read-only `claude -p` reviews the changes and the findings go back to Codex.
- Structured verdicts (`APPROVED`, `CHANGES_REQUESTED`, `NEEDS_HUMAN`) with
  stable finding IDs (`CCC-001`, …) preserved across rounds.
- Bounded loop: at most 3 rounds by default (`CCCR_MAX_ROUNDS`), and one
  round per completion even when a completion event is delivered twice.
- Every reviewer failure (missing binary, no login, non-zero exit, timeout,
  invalid output, abort) stops the review and is never treated as approval.
- Git baseline at activation (root, `HEAD`, branch, dirty paths). CCCR never
  commits, stashes, resets, checks out, rebases or pushes.
- Configuration through a small set of environment variables: rounds,
  timeouts, reviewer binary, model and effort, state directory.
- Installation through the bundled `cccr-local` marketplace for both CLIs.
- A deterministic test suite that needs no credentials or network (real
  temporary Git repositories, fake `claude`/`codex` executables, host
  harnesses), plus opt-in smoke tests against the real CLIs.

[1.0.0]: https://github.com/hlavacm/ccc-review/releases/tag/v1.0.0
