# CCCR

Claude Code ↔ Codex Review

Use Claude Code to implement and Codex to review,
or Codex to implement and Claude Code to review.

## Why

A second, independent model catches bugs the first one talked itself past.
Doing that by hand means copying the task, the diff and the writer's report to
the other agent and pasting its findings back. CCCR automates that loop inside
the agent you already use: when the writer finishes a turn, the other agent
reviews the real repository changes, and its findings go back to the writer
until the reviewer approves or a bounded stop condition is reached.

## How it works

- **Writer**: the agent you are working with (Claude Code or Codex). It plans,
  implements, and evaluates the findings: it fixes valid ones and rejects
  invalid ones with reasoning. Reviewer feedback is advisory.
- **Reviewer**: the other agent, run headless and read-only against the
  repository. It returns a structured verdict: `APPROVED`,
  `CHANGES_REQUESTED` or `NEEDS_HUMAN`, plus findings with stable IDs
  (`CCC-001`, `CCC-002`, …).

```text
/cccr on  →  writer works  →  writer finishes a turn
          →  reviewer round n
               APPROVED           → writer stops, you get a message
               CHANGES_REQUESTED  → findings go back to the writer, which continues
               NEEDS_HUMAN        → review stops, you get a message
               round n = 3        → review stops, you get a message (no 4th round)
               any failure        → review stops with an error; never approval
```

Review runs only in sessions where you turned it on. Git is the source of
truth: at `on` CCCR records the repository root, `HEAD`, branch and
`git status`; the reviewer is told that already dirty files may not be the
writer's. CCCR never commits, stashes, resets, checks out, rebases or pushes.

Messages from the hooks are prefixed `CCC Review`.

## Requirements

- macOS or Linux, Git, Node.js ≥ 22.18 on `PATH` (the hooks run the
  TypeScript sources directly; no `pnpm install` and no build are needed to
  use the plugin; the runtime has no npm dependencies).
- **Claude writes, Codex reviews**: Claude Code with plugin support, and the
  Codex CLI authenticated with `codex login` (or `CODEX_API_KEY`).
- **Codex writes, Claude reviews**: the Codex CLI with plugin hooks, and
  Claude Code authenticated with `claude auth login` (or `ANTHROPIC_API_KEY`).

`/cccr on` checks that the reviewer CLI exists and is logged in
(`codex login status` / `claude auth status`; with an API key only
`--version`) and refuses to enable review otherwise.

Tested with Claude Code 2.1.278, codex-cli 0.155.1 and Node.js 22.18–26.

## Install

The repository is both a Claude Code plugin (`.claude-plugin/`) and a Codex
plugin (`.codex-plugin/`), and ships a marketplace named `cccr-local` that
both CLIs read. Clone it to a dedicated directory:

```sh
git clone <repository-url> ~/.local/share/cccr
```

A local-path marketplace installs a copy of the whole directory, including
untracked files, so install from a clean clone rather than from a development
checkout (with `node_modules/`, `dist/`, …).

### Claude Code (Claude writes, Codex reviews)

```sh
claude plugin marketplace add ~/.local/share/cccr
claude plugin install cccr@cccr-local
```

Restart Claude Code. The same works from inside Claude Code with
`/plugin marketplace add …` and `/plugin install cccr@cccr-local`. To try it
for one session without installing: `claude --plugin-dir ~/.local/share/cccr`.

### Codex (Codex writes, Claude Code reviews)

```sh
codex plugin marketplace add ~/.local/share/cccr
codex plugin add cccr@cccr-local
```

Codex does not run plugin hooks until you trust them: start Codex, open
`/hooks` and approve the CCCR `UserPromptSubmit` and `Stop` hooks (again after
every update that changes them).

## Usage

### Claude → Codex

Plugin commands are namespaced by Claude Code, so the command is `/cccr:cccr`:

```text
/cccr:cccr on [task description]   # check Codex, record Git baseline, arm review
/cccr:cccr status                  # state, round n/3, reviewer settings, history, file paths
/cccr:cccr off                     # disarm (also stops further rounds of this task)
```

Example:

```text
> /cccr:cccr on Add multiply(a, b) to math.js with a test
CCC Review: enabled. Codex will review when Claude finishes.

> Implement it.
… Claude edits math.js and finishes …
Stop hook: CCC Review round 1/3: Codex requested changes.
Findings:
- CCC-001 [high] math.js:2: multiply returns a + b instead of a * b
… Claude: "CCC-001: fixed — … Verification: node --test" …
CCC Review: Codex APPROVED (round 2/3). multiply is correct and tested.
```

To abort a running review, interrupt Claude (Esc): CCCR kills the whole Codex
process group, records the round as `reviewer_error` (not approved) and stops
the task. `/cccr:cccr on` starts a fresh one.

### Codex → Claude

Codex has no plugin slash commands; the command is the `$cccr` skill mention,
which the `UserPromptSubmit` hook handles and blocks (it never reaches the
model). `$cccr:cccr …` works too.

```text
$cccr on [task description]   # check Claude, record Git baseline, arm review
$cccr status                  # state, round n/3, reviewer settings, history
$cccr off                     # disarm
```

Example:

```text
> $cccr on Fix add() in math.js and add a node:test test
CCC Review: enabled. Claude will review when Codex finishes.

> Do it.
… Codex edits math.js and finishes; the Stop hook runs Claude …
CCC Review round 1/3: Claude requested changes. (Codex continues with the findings)
… Codex: "CCC-001: fixed …" …
CCC Review: Claude APPROVED (round 2/3).
```

### Rounds, stop conditions and errors

- Every writer completion while review is on runs exactly one round; a
  duplicate or concurrent completion event never starts a second one.
- After round 3 (`CCCR_MAX_ROUNDS`) without approval, review stops and you get
  the last findings; the writer is not blocked again.
- A missing reviewer binary, failed login, non-zero exit, timeout, invalid
  JSON or an invalid review is an error: the round is recorded as
  `reviewer_error`, review stops, and you get a `CCC Review error` message.
  It is never treated as approval.
- `status` shows the round, last verdict, history, and where the state is.

## Configuration

Environment variables, set for the process that runs the writer (for Claude
Code e.g. the `env` block of `~/.claude/settings.json`; for Codex the shell
that starts `codex`). Invalid values are reported as a `CCC Review error` and
never approve.

| Variable | Default | Direction |
| --- | --- | --- |
| `CCCR_MAX_ROUNDS` | `3` (read at `on`) | both |
| `CCCR_STATE_DIR` | Claude Code: `${CLAUDE_PLUGIN_DATA}`, Codex: `${PLUGIN_DATA}`, else `~/.cccr` | both |
| `CCCR_CODEX_BIN` | `codex` | Claude → Codex |
| `CCCR_CODEX_TIMEOUT_MS` | `1200000` (20 min; the Stop hook allows 30) | Claude → Codex |
| `CCCR_CODEX_MODEL` | Codex's configured model (`-m`) | Claude → Codex |
| `CCCR_CODEX_REASONING_EFFORT` | Codex's configured effort; `minimal`, `low`, `medium`, `high`, `xhigh` | Claude → Codex |
| `CCCR_CLAUDE_BIN` | `claude` | Codex → Claude |
| `CCCR_CLAUDE_TIMEOUT_MS` | `1200000` (20 min; the Stop hook allows 30) | Codex → Claude |
| `CCCR_CLAUDE_MODEL` | Claude Code's configured model (`--model`) | Codex → Claude |
| `CCCR_CLAUDE_EFFORT` | Claude Code's default; `low`, `medium`, `high`, `xhigh`, `max` | Codex → Claude |

```json
{ "env": { "CCCR_MAX_ROUNDS": "2", "CCCR_CODEX_REASONING_EFFORT": "high" } }
```

State files: `tasks/<taskId>.json` (round, verdict, baseline),
`history/<taskId>.jsonl` (append-only: `on`, each round, errors, `off`),
`sessions/<sessionId>.json` (task id, recorded prompts),
`claims/<taskId>/<hash>` (completions already reviewed; removed when the task
ends).

## Security and privacy

What the reviewer receives, and therefore what is sent to its model provider
(OpenAI for Codex, Anthropic for Claude Code):

- the original task: the text after `on` and your prompts while review is on
  (last 12 000 characters),
- the implementation plan: not available to CCCR in either host, so not sent,
- the writer's implementation report (its final message, last 12 000
  characters),
- Git metadata: repository root, branch, activation `HEAD`, already dirty
  paths (up to 50),
- the changes and any repository content the reviewer reads: Codex runs
  `git diff`/`git log` and reads files itself; Claude gets `git log`, the
  changed-file list, the diff (up to 200 000 characters) and untracked files
  in the prompt and reads other files with its Read/Grep/Glob tools,
- previous findings and verdicts of the same task.

Guarantees:

- The reviewer is read-only for source code: Codex runs as
  `codex exec --sandbox read-only -c approval_policy="never" …`; Claude runs as
  `claude -p --safe-mode --tools Read,Grep,Glob --permission-mode dontAsk …`
  (no shell, no edit tools, no plugins/hooks/MCP servers).
- CCCR does not commit, stash, reset, check out, rebase or push.
- Processes are spawned as executable + argument list, never via a shell
  string; prompts go on stdin.
- A reviewer failure is never approval.
- State stays outside the repository (see `CCCR_STATE_DIR`); nothing is sent
  anywhere except to the reviewer CLI you configured.

## Upgrade

**Claude Code** caches an installed plugin by its version, so an update is
picked up when the version changed:

```sh
git -C ~/.local/share/cccr pull
claude plugin marketplace update cccr-local
claude plugin update cccr@cccr-local
```

For changes without a version bump, uninstall and install again (see below).
Restart Claude Code afterwards.

**Codex** re-copies the plugin on every `add`:

```sh
git -C ~/.local/share/cccr pull
codex plugin add cccr@cccr-local
```

Then review the changed hooks again in `/hooks`.

## Uninstall

First run `/cccr:cccr off` / `$cccr off` in active sessions, and note the
state location that `status` prints.

```sh
claude plugin uninstall cccr@cccr-local
claude plugin marketplace remove cccr-local
codex plugin remove cccr@cccr-local
codex plugin marketplace remove cccr-local
```

Then delete the state directory `status` showed (`~/.cccr` or the plugin data
directory, unless you set `CCCR_STATE_DIR`) and the clone.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `codex executable not found: codex — install the Codex CLI or set CCCR_CODEX_BIN` | install Codex or point `CCCR_CODEX_BIN` at it (same for `claude` / `CCCR_CLAUDE_BIN`) |
| `Codex is not logged in — run \`codex login\`` | `codex login` or `CODEX_API_KEY`; for Claude `claude auth login` or `ANTHROPIC_API_KEY` |
| `… timed out after 20 min — raise CCCR_CODEX_TIMEOUT_MS …` | raise the timeout, keep it under the Stop hook's 30 min |
| `… returned invalid JSON: …` / `an invalid review: …` | usually transient; the excerpt shows what the reviewer produced |
| `… exited with code N: <last stderr lines>` | read the stderr lines; auth errors add the login hint |
| `$cccr on` does nothing in Codex | the hooks are not trusted yet: open `/hooks` |

## Known limitations

- The implementation plan is not passed to the reviewer: neither host exposes
  a documented, stable way to read it.
- A completion is identified by its final message (Codex: `turn_id` + final
  message); an identical completion redelivered is not reviewed twice.
- Already dirty files are listed for the reviewer, not attributed line by line.
- Claude Code does not document the exact `command_name` of a plugin skill;
  both `cccr` and `cccr:cccr` are accepted.
- Codex does not document whether the TUI delivers a skill mention as the
  literal `$cccr`; if the hook does not handle it, the `cccr` skill tells you
  review was NOT enabled.
- The interactive Codex TUI flow (`$cccr` delivery, continuation after
  findings) is covered by hook-level tests and the real reviewer smoke test,
  not by an automated TUI session.
- The plugin's own hook messages still say `CCC Review`.

## Testing

Requires Node.js ≥ 22.18, Git and pnpm. From a fresh clone:

```sh
pnpm install --frozen-lockfile
pnpm check             # typecheck + lint (Biome, incl. format) + all tests + build
```

| Command | What runs |
| --- | --- |
| `pnpm test` | every deterministic test: no credentials, no network, no real Claude/Codex |
| `pnpm test:all` | same as `pnpm test` |
| `pnpm test:unit` | review loop, state, result validation, prompts, core boundary |
| `pnpm test:integration` | real temporary Git repositories, fake `codex`/`claude` executables through the production subprocess code, hook harnesses, the exact `hooks.json` commands, packaging |
| `pnpm test:coverage` | `pnpm test` with Node's coverage report |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` / `pnpm build` | tsc, Biome check, Biome fix, emit `dist/` |

The suite never touches your repositories or your Git configuration
(`test/setup.ts` isolates every git process) and removes `CODEX_API_KEY` /
`ANTHROPIC_API_KEY` from its environment. Fake reviewer executables live only
in `test/`.

### Optional real-CLI smoke tests

`pnpm test:smoke` and `pnpm test:smoke:install` are **not** part of
`pnpm test`. They use your real Claude Code and Codex installations, only in
disposable temporary repositories and directories:

- `pnpm test:smoke` runs every smoke test, including
  `test/smoke/claude-to-codex.smoke.ts` and `codex-to-claude.smoke.ts`, which
  review a planted bug with the real reviewers: they **need credentials and
  consume model usage**.
- `pnpm test:smoke:install` runs only `test/smoke/install.smoke.ts`: it
  installs the plugin from a clean copy into throwaway Claude Code / Codex
  config directories (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) with the commands
  documented above, runs the installed hooks against fake reviewers, upgrades
  and uninstalls. It needs no credentials and uses no model; it is skipped
  when `claude` or `codex` is not installed.

## License

MIT, see [LICENSE](LICENSE).
