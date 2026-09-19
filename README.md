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

## Using CCC Review in Claude Code (Claude writer → Codex reviewer)

Requirements: Node.js ≥ 22.18 on `PATH` (the hooks run the TypeScript sources
directly), Git, and an authenticated Codex CLI (`codex login`).

### Install locally

Either load the plugin for one session:

```sh
claude --plugin-dir /path/to/cccr
```

or install it through the bundled local marketplace:

```text
/plugin marketplace add /path/to/cccr
/plugin install cccr@cccr-local
```

### Use

Plugin commands are namespaced by Claude Code, so the command is `/cccr:cccr`:

```text
/cccr:cccr on [task description]   # arm review for this session, record Git baseline
/cccr:cccr status                  # active?, round n/3, last verdict/error, baseline
/cccr:cccr off                     # disarm
```

Then work with Claude normally. Every time Claude finishes a turn, the Stop hook
runs one Codex review round:

- `APPROVED` → Claude stops; you see a CCC Review message.
- `CHANGES_REQUESTED` → Claude is blocked from stopping and receives the findings
  (`CCC-001`, …) with instructions to evaluate, fix or reject them and report
  back; its next completion triggers the next round.
- `NEEDS_HUMAN`, 3 rounds without approval, or any Codex failure (missing
  binary, auth error, non-zero exit, timeout, invalid output) → review stops
  and you get a message. A failure is never treated as approval.

Sessions where review was not turned on are not affected.

### How it works

| Piece | Claude Code extension point |
| --- | --- |
| `/cccr:cccr on\|off\|status` | `skills/cccr/SKILL.md` (`disable-model-invocation`) + `UserPromptExpansion` hook (matcher `^(cccr:)?cccr$`), which handles the command and blocks the expansion (no model turn, no shell built from arguments) |
| Task context | `UserPromptSubmit` hook records user prompts while review is active (plus text after `on`) |
| Review trigger | `Stop` hook (`timeout: 1800` s); `{"decision":"block","reason":…}` returns findings to Claude; `last_assistant_message` is the writer's report |

Codex is invoked as executable + argv, prompt on stdin:

```text
codex exec --sandbox read-only -c approval_policy="never" --cd <repo root> --ephemeral \
  --color never --output-schema <strict schema> --output-last-message <file> -
```

Codex runs in its own process group; at the timeout the whole group is killed and the review fails. The result file is parsed and strictly validated; an empty/invalid result is an error.

Configuration (environment of the Claude Code process):

| Variable | Default |
| --- | --- |
| `CCCR_CODEX_BIN` | `codex` |
| `CCCR_CODEX_TIMEOUT_MS` | `1200000` (20 min) |
| `CCCR_STATE_DIR` | `${CLAUDE_PLUGIN_DATA}`, else `~/.cccr` |

State: `tasks/<taskId>.json` (round, verdict, baseline), `sessions/<sessionId>.json`
(task id, recorded prompts), `claims/<taskId>/<hash>` (completion events already reviewed).

### Known limitations

- The implementation plan is not passed to Codex: Claude Code exposes no
  documented, stable way to read it (the transcript format is undocumented).
- Duplicate Stop deliveries are detected by the final assistant message: a
  completion whose message is identical to an already reviewed one is not
  reviewed again (Claude simply stops).
- Pre-existing dirty files are listed for Codex, but not attributed line by line.
- The exact `command_name` Claude Code reports for a plugin skill is not
  documented; both `cccr` and `cccr:cccr` are accepted.

### Manual smoke test (real Claude + Codex, consumes usage)

Never run this in a repository you care about.

```sh
tmp=$(mktemp -d) && cd "$tmp" && git init -q && printf 'export const add = (a, b) => a - b;\n' > math.js \
  && git add . && git -c user.name=t -c user.email=t@t commit -qm init
claude --plugin-dir /path/to/cccr
```

1. `/cccr:cccr on Fix add() in math.js and add a node:test test for it` → "enabled", baseline shown.
2. Ask Claude to do the task. When it finishes, Codex reviews (may take minutes).
3. Expect either an approval message, or Claude continuing with `CCC-00x` findings and a re-review.
4. `/cccr:cccr status` shows the round and last verdict; `git status` shows only Claude's edits (no commits/stashes by CCC Review).
5. Failure path: `CCCR_CODEX_BIN=/nonexistent claude --plugin-dir /path/to/cccr`, turn on, finish a task → "Codex review FAILED — the change is NOT approved".

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
