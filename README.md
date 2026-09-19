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
/cccr:cccr on [task description]   # check Codex, record Git baseline, arm review
/cccr:cccr status                  # state, round n/3, reviewer settings, round history, file paths
/cccr:cccr off                     # disarm (also aborts further rounds of this task)
```

`on` refuses to arm review when Codex is missing or not logged in, and warns
when the working tree already has uncommitted changes (Codex is told they may
not be Claude's).

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

### Example

```text
> /cccr:cccr on Add multiply(a, b) to math.js with a test
CCC Review: enabled. Codex will review when Claude finishes.
status: active
task: 3f0c…
round: 0/3
baseline: /work/app @ main 1a2b3c4d5e6f, 0 pre-existing dirty path(s)

> Implement it.
… Claude edits math.js and finishes …
Stop hook: CCC Review round 1/3: Codex requested changes.
Findings:
- CCC-001 [high] math.js:2: multiply returns a + b instead of a * b
Instructions: … evaluate, fix or reject with reasoning, verify, report with IDs …
… Claude fixes it: "CCC-001: fixed — … Verification: node --test" …
CCC Review: Codex APPROVED (round 2/3). multiply is correct and tested.

> /cccr:cccr status
CCC Review: status: inactive
…
history:
  2026-09-19 10:00:00 on
  2026-09-19 10:03:12 round 1: CHANGES_REQUESTED — 1 finding(s): CCC-001
  2026-09-19 10:06:40 round 2: APPROVED
state: ~/.claude/plugins/data/cccr…/tasks/3f0c….json
log: ~/.claude/plugins/data/cccr…/history/3f0c….jsonl
```

To abort a review that is running, interrupt Claude (Esc): when the hook
process is terminated (SIGTERM/SIGINT/SIGHUP), CCC Review kills the whole Codex
process group, records the round as `reviewer_error` ("codex review aborted",
NOT approved) and stops the task. `/cccr:cccr on` starts a fresh one.

### How it works

| Piece | Claude Code extension point |
| --- | --- |
| `/cccr:cccr on\|off\|status` | `skills/cccr/SKILL.md` (`disable-model-invocation`) + `UserPromptExpansion` hook (matcher `^(cccr:)?cccr$`), which handles the command and blocks the expansion (no model turn, no shell built from arguments) |
| Task context | `UserPromptSubmit` hook records user prompts while review is active (plus text after `on`) |
| Review trigger | `Stop` hook (`timeout: 1800` s); `{"decision":"block","reason":…}` returns findings to Claude; `last_assistant_message` is the writer's report |

Codex is invoked as executable + argv, prompt on stdin, after a
`codex login status` check (with `CODEX_API_KEY`, which authenticates
`codex exec` but not `login status`, only `codex --version` is checked):

```text
codex exec --sandbox read-only -c approval_policy="never" [-c model_reasoning_effort="…"] [-m <model>] \
  --cd <repo root> --ephemeral --color never --output-schema <strict schema> --output-last-message <file> -
```

Codex runs in its own process group; at the timeout, or when the hook process
receives SIGTERM/SIGINT/SIGHUP, the whole group is killed and the review fails.
The result file is parsed and strictly validated; an empty/invalid result is an
error. The prompt points Codex at `git diff <activation HEAD>` and
`git log <activation HEAD>..HEAD`, so changes Claude committed are reviewed
too; task text and report are capped at the last 12 000 characters, the
pre-existing dirty list at 50 paths.

Configuration (environment of the Claude Code process, e.g. the `env` block of
`~/.claude/settings.json` or `.claude/settings.local.json`):

| Variable | Default |
| --- | --- |
| `CCCR_CODEX_BIN` | `codex` |
| `CCCR_CODEX_TIMEOUT_MS` | `1200000` (20 min) |
| `CCCR_MAX_ROUNDS` | `3` (read at `on`) |
| `CCCR_CODEX_MODEL` | Codex's configured model (`-m`) |
| `CCCR_CODEX_REASONING_EFFORT` | Codex's configured effort; `minimal`, `low`, `medium`, `high`, `xhigh` |
| `CCCR_STATE_DIR` | `${CLAUDE_PLUGIN_DATA}`, else `~/.cccr` |

```json
{ "env": { "CCCR_MAX_ROUNDS": "2", "CCCR_CODEX_REASONING_EFFORT": "high" } }
```

An invalid value is reported as a `CCC Review error` message and never approves.

State: `tasks/<taskId>.json` (round, verdict, baseline), `history/<taskId>.jsonl`
(one line per `on`, round result or error, `off`; append-only),
`sessions/<sessionId>.json` (task id, recorded prompts), `claims/<taskId>/<hash>`
(completion events already reviewed; removed when the task ends or is turned off).

### Troubleshooting

| Message | Fix |
| --- | --- |
| `codex executable not found: codex — install the Codex CLI or set CCCR_CODEX_BIN` | install Codex or point `CCCR_CODEX_BIN` at it |
| `Codex is not logged in — run \`codex login\`` | `codex login` (or set `CODEX_API_KEY`) |
| `codex timed out after 20 min — raise CCCR_CODEX_TIMEOUT_MS …` | raise the timeout (keep it under the Stop hook's 30 min) |
| `codex returned invalid JSON: …` / `an invalid review: …` | usually transient; the excerpt shows what Codex produced |
| `codex exited with code N: <last stderr lines>` | read the stderr lines; auth errors add the login hint |

### Known limitations

- The implementation plan is not passed to Codex: Claude Code exposes no
  documented, stable way to read it (the transcript format is undocumented).
- Duplicate Stop deliveries are detected by the final assistant message: a
  completion whose message is identical to an already reviewed one is not
  reviewed again (Claude simply stops).
- Pre-existing dirty files are listed for Codex, but not attributed line by line.
- The exact `command_name` Claude Code reports for a plugin skill is not
  documented; both `cccr` and `cccr:cccr` are accepted.

### Real-use checklist (real Claude + Codex, consumes usage)

`pnpm test:smoke` runs the Codex half automatically: a real `codex exec`
reviews a planted bug in a disposable repository through the host code
(needs `codex login`, not part of `pnpm test`). The Claude half is manual:

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
5. Failure path: `CCCR_CODEX_BIN=/nonexistent claude --plugin-dir /path/to/cccr`, turn on → "not enabled: codex executable not found".
6. Commit during the task (ask Claude to commit) → Codex still reviews the committed change.
7. Press Esc while Codex is reviewing → no `codex` process left (`pgrep -fl "codex exec"`); `status` shows the round as aborted, `on` starts again.
8. `/cccr:cccr off` mid-task → the next completion is not reviewed; `status` history ends with `off`.

## Development

Requires Node.js ≥ 22.18 and Git.

```sh
pnpm install
pnpm test                 # all deterministic tests (no credentials, no network)
pnpm test:unit
pnpm test:integration # real temporary Git repositories
pnpm test:coverage
pnpm test:smoke       # opt-in, real Codex (credentials, usage)
pnpm typecheck
pnpm lint             # Biome lint + format check; `pnpm format` to fix
pnpm build            # emits dist/
pnpm check            # typecheck + lint + test + build
```
