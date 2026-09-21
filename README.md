<div align="center">

<img src="assets/icon/512x512.png" alt="CCC Review logo: Claude Code and Codex reviewing each other" width="220">

# CCC Review

**Claude Code ↔ Codex Review**

Use Claude Code to implement and Codex to review,
or Codex to implement and Claude Code to review.

[![CI](https://github.com/hlavacm/ccc-review/actions/workflows/ci.yml/badge.svg)](https://github.com/hlavacm/ccc-review/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.1-blue)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2024-339933?logo=nodedotjs&logoColor=white)](#requirements)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](#claude-code-claude-writes-codex-reviews)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-412991)](#codex-codex-writes-claude-code-reviews)

[TL;DR](#tldr) ·
[What it is](#what-it-is-and-why) ·
[Install](#install) ·
[Usage](#usage) ·
[Configuration](#configuration) ·
[Security](#security-and-privacy)

</div>

---

## TL;DR

Two coding agents check each other: one writes, the other reviews the real
changes in your repository, and the findings go straight back to the writer.

**1. Install** (once):

```sh
# You work in Claude Code, Codex reviews
claude plugin marketplace add hlavacm/ccc-review
claude plugin install ccc-review@hlavacm

# You work in Codex, Claude Code reviews (then approve the hooks in /hooks)
codex plugin marketplace add hlavacm/ccc-review
codex plugin add ccc-review@hlavacm
```

**2. Use:**

| | In Claude Code | In Codex |
| --- | --- | --- |
| Review every finished turn | `/ccc-review:on <task>` | `$ccc-review on <task>` |
| Second opinion on finished work | `/ccc-review:current` | `$ccc-review current` |
| Status / stop | `/ccc-review:status` · `/ccc-review:off` | `$ccc-review status` · `$ccc-review off` |

The reviewer is read-only, the loop stops after 3 rounds, and a reviewer that
fails is an error, never an approval. You need macOS or Linux, Git,
Node.js ≥ 24, and both CLIs installed and logged in.

## What it is and why

A second, independent model catches the bugs the first one talked itself
past. Many people already do this by hand: let one agent implement, then copy
the task, the diff and the agent's report to another agent, ask "is this
right?", and paste the answer back. It works, and it is tedious.

**CCC Review automates exactly that loop, inside the agent you already use.** It is
a plugin for Claude Code and for Codex. You keep working with your agent as
usual; when it finishes, the other agent is started in the background,
read-only, looks at what really changed in the repository, and its findings
come back into your session.

- 🔁 **Both directions**: Claude Code writes and Codex reviews, or the other
  way around.
- 🧭 **Bounded**: one review per finished turn, at most 3 rounds, no runaway
  loops.
- 🔒 **Read-only reviewer**: it cannot edit your code, and CCC Review never
  commits, stashes, resets or pushes.
- 🚫 **Failure is never approval**: a missing CLI, expired login, timeout or
  malformed answer is an error, not a pass.
- 🎯 **Opt-in**: nothing happens until you run a CCC Review command in that
  session.
- 🪶 **Nothing to build**: the hooks run on Node.js directly; no
  `npm install`.

## How it works

```mermaid
flowchart LR
    on(["on"]) --> write["Writer implements"]
    write --> done["Writer finishes a turn"]
    done --> review["Reviewer round n<br/>read-only"]
    review -->|APPROVED| ok(["✅ done"])
    review -->|CHANGES_REQUESTED| findings["Findings CCC-001… go back to the writer"]
    findings --> write
    review -->|NEEDS_HUMAN| human(["🧑 you decide"])
    review -->|"round n = 3"| max(["⏹ stop and report"])
    review -->|any failure| err(["⚠️ error, never approval"])
```

- The **writer** is the agent you work with. It implements, and it judges
  every finding itself: it fixes the valid ones and rejects the others with a
  reason. The reviewer's feedback is advice, not orders.
- The **reviewer** is the other agent, started headless and read-only. It
  looks at the real repository, not at a pasted diff, and answers with a
  verdict (`APPROVED`, `CHANGES_REQUESTED` or `NEEDS_HUMAN`) and findings with
  stable IDs (`CCC-001`, `CCC-002`, …).
- **Git is the source of truth.** At `on`, CCC Review notes the current `HEAD` and
  which files were already changed. The reviewer sees everything since then,
  commits included, and is told that files changed before `on` may not be the
  writer's.

## Requirements

- macOS or Linux, Git, and Node.js ≥ 24 on `PATH`.
- **Claude writes, Codex reviews**: Claude Code with plugin support, and the
  Codex CLI logged in with `codex login` (or `CODEX_API_KEY`).
- **Codex writes, Claude reviews**: the Codex CLI with plugin hooks, and
  Claude Code logged in with `claude auth login` (or `ANTHROPIC_API_KEY`).

`on` and `current` first check that the reviewer CLI exists and is logged in,
and refuse to start otherwise.

Developed with Claude Code 2.1.278, codex-cli 0.155.1 and Node.js 26; CI runs
the test suite on Node.js 24.

## Install

The repository is both a Claude Code plugin and a Codex plugin, and it ships a
marketplace named `hlavacm` that both CLIs read.

### Claude Code (Claude writes, Codex reviews)

```sh
claude plugin marketplace add hlavacm/ccc-review
claude plugin install ccc-review@hlavacm
```

Restart Claude Code. Inside Claude Code, `/plugin marketplace add …` and
`/plugin install ccc-review@hlavacm` work too. To try it for one session without
installing, clone the repository and run `claude --plugin-dir <clone>`.

### Codex (Codex writes, Claude Code reviews)

```sh
codex plugin marketplace add hlavacm/ccc-review
codex plugin add ccc-review@hlavacm
```

Codex runs plugin hooks only after you trust them: start Codex, open `/hooks`
and approve the CCC Review `UserPromptSubmit` and `Stop` hooks. Do it again after
every update that changes them.

<details>
<summary><b>Install from a local clone instead</b></summary>

```sh
git clone https://github.com/hlavacm/ccc-review ~/.local/share/ccc-review
claude plugin marketplace add ~/.local/share/ccc-review
codex plugin marketplace add ~/.local/share/ccc-review
```

Then install `ccc-review@hlavacm` as above. A local-path marketplace installs a
copy of the whole directory, untracked files included, so use a clean clone,
not a development checkout with `node_modules/` or `dist/`.

</details>

## Upgrade

**Claude Code** caches an installed plugin by version, so an update arrives
when a new version is released:

```sh
claude plugin marketplace update hlavacm
claude plugin update ccc-review@hlavacm
```

Restart Claude Code afterwards. To pick up changes without a version bump
(from a local clone), uninstall and install again.

**Codex** copies the plugin again on every `add`, after the marketplace has
been refreshed (`marketplace add` does not refresh one that is already added):

```sh
codex plugin marketplace upgrade hlavacm
codex plugin add ccc-review@hlavacm
```

For a local clone, `git pull` first and skip `marketplace upgrade`. Then
review the changed hooks again in `/hooks`.

## Uninstall

Run `/ccc-review:off` or `$ccc-review off` in active sessions first, then:

```sh
claude plugin uninstall ccc-review@hlavacm
claude plugin marketplace remove hlavacm
codex plugin remove ccc-review@hlavacm
codex plugin marketplace remove hlavacm
```

Finally delete the state directory: `CCC_REVIEW_STATE_DIR` if you set it, otherwise
the plugin data directory (`${CLAUDE_PLUGIN_DATA}` for Claude Code,
`${PLUGIN_DATA}` for Codex), otherwise `~/.ccc-review`. `status` of a task prints
the exact paths.

## Usage

The commands are the same in both hosts; only the spelling differs. Claude
Code names plugin commands `/<plugin>:<command>`. Codex has no plugin slash
commands, so there you type the `$ccc-review` skill followed by the action.

| Command | In Claude Code | In Codex |
| --- | --- | --- |
| Review every finished turn | `/ccc-review:on [task]` | `$ccc-review on [task]` |
| One-off audit of what is already done | `/ccc-review:current [note]` | `$ccc-review current [note]` |
| Show state, round and history | `/ccc-review:status` | `$ccc-review status` |
| Stop reviewing | `/ccc-review:off` | `$ccc-review off` |

Type the command at the very start of the message. The answer comes from
CCC Review itself and starts with `CCC Review:`; the agent does not see `on`, `off` or
`status` at all.

### Use case 1: review while the agent works (`on`)

You are about to give your agent a task and want every result checked.

1. Turn review on and say what the task is. This does not start the agent.
2. Ask for the work in a normal message.
3. Every time the agent finishes, the reviewer runs. If it finds something,
   your agent gets the findings, fixes or rejects them, and is reviewed again,
   up to 3 rounds.

In Claude Code:

```text
> /ccc-review:on Add multiply(a, b) to math.js with a test
CCC Review: enabled. Codex will review when Claude finishes.

> Add multiply(a, b) to math.js with a test.
… Claude edits math.js and finishes …
CCC Review round 1/3: Codex requested changes.
- CCC-001 [high] math.js:2: multiply returns a + b instead of a * b
… Claude continues by itself: "CCC-001: fixed — … Verification: node --test" …
CCC Review: Codex APPROVED (round 2/3). multiply is correct and tested.
```

In Codex:

```text
> $ccc-review on Fix add() in math.js and add a test
CCC Review: enabled. Claude will review when Codex finishes.

> Fix add() in math.js and add a test.
… Codex edits math.js and finishes; "CCC Review: Claude is reviewing" …
CCC Review: Claude APPROVED (round 1/3). add() is fixed and tested.
```

The text after `on`, and everything you type while review is on, is the task
the reviewer checks the work against. Commits the agent makes are reviewed
too.

### Use case 2: second opinion on work that is already done (`current`)

The agent has planned and implemented something, nothing was armed, the
changes are not committed yet, and you want an independent audit.

```text
> /ccc-review:current please check the error handling        (Claude Code)
> $ccc-review current please check the error handling        (Codex)

… the agent writes down the task, its plan and its report, and finishes …
CCC Review audit: Codex requested changes.
- CCC-001 [high] api.ts:41: …
… the agent presents the findings with its own opinion and changes nothing …
```

- The agent first writes the task, its plan and its report for the reviewer,
  because only the agent knows them. That message and the real Git changes go
  to the reviewer.
- It covers **uncommitted changes only** (staged, unstaged, untracked) and
  treats all of them as the agent's work. With a clean tree it is refused.
- The result always comes back through the agent, which tells you the
  verdict: approval, findings, or that the review failed.
- It is **one round**: you get the findings, nothing is fixed automatically,
  and you decide what happens next ("fix CCC-001"). Run it again after fixing
  if you like.
- It is refused while `on` is active in the session.

### Use case 3: see what is going on, or stop (`status`, `off`)

```text
> /ccc-review:status                                          (Claude Code)
> $ccc-review status                                          (Codex)
CCC Review: status: active
round: 1/3
last verdict: CHANGES_REQUESTED — multiply adds instead of multiplying.
history:
  2026-09-20 08:23:38 on
  2026-09-20 08:25:11 round 1: CHANGES_REQUESTED — 1 finding(s): CCC-001
```

`off` stops reviewing in this session; the next finished turn is not
reviewed. To switch it off in the middle of a task, interrupt the agent first
(Esc), run `off`, then tell the agent to continue.

### What to expect

- **One round per finished turn.** A turn delivered twice never starts a
  second round.
- **A turn that changed nothing is not reviewed** and costs no round, so an
  agent that only asks you a question is not pushed on by the reviewer. (This
  needs a clean tree at `on`; see [Known limitations](#known-limitations).)
- **After round 3** without approval, review stops and you get the last
  findings. Change the limit with `CCC_REVIEW_MAX_ROUNDS`.
- **Any reviewer problem** (CLI missing, not logged in, timeout, invalid
  answer) stops the review with a `CCC Review error`. It is never approval.
- **To abort a running review**, interrupt the agent (Esc). The reviewer
  process is killed, the round is recorded as failed, and `on` starts again.

<details>
<summary><b>Troubleshooting</b></summary>

| What you see | Fix |
| --- | --- |
| The agent answers your command instead of CCC Review | the command must start the message: no leading space, and type it rather than paste it if your terminal wraps pasted text |
| `$ccc-review on` does nothing in Codex | the hooks are not trusted yet: open `/hooks` |
| `codex executable not found: codex — install the Codex CLI or set CCC_REVIEW_CODEX_BIN` | install Codex or point `CCC_REVIEW_CODEX_BIN` at it (same for `claude` / `CCC_REVIEW_CLAUDE_BIN`) |
| `Codex is not logged in — run \`codex login\`` | `codex login` or `CODEX_API_KEY`; for Claude, `claude auth login` or `ANTHROPIC_API_KEY` |
| `nothing to audit: there are no uncommitted changes` | `current` looks at uncommitted work only; for committed work use `on` before the task |
| `… timed out after 20 min — raise CCC_REVIEW_CODEX_TIMEOUT_MS …` | raise the timeout, but keep it under the Stop hook's 30 min |
| `… returned invalid JSON: …` / `an invalid review: …` | usually transient; the excerpt shows what the reviewer produced |
| `… exited with code N: <last stderr lines>` | read the stderr lines; auth errors add the login hint |
| `CCC Review error: corrupt state file …` on every prompt | run `on` to start a fresh task or `off` to reset the session |

</details>

## Configuration

Optional. Set environment variables for the process that runs the writer: for
Claude Code, for example, the `env` block of `~/.claude/settings.json`; for
Codex, the shell that starts `codex`. An invalid value is reported as a
`CCC Review error` and never approves.

```json
{ "env": { "CCC_REVIEW_MAX_ROUNDS": "2", "CCC_REVIEW_CODEX_REASONING_EFFORT": "high" } }
```

| Variable | Default | Direction |
| --- | --- | --- |
| `CCC_REVIEW_MAX_ROUNDS` | `3` (read at `on`) | both |
| `CCC_REVIEW_STATE_DIR` | Claude Code: `${CLAUDE_PLUGIN_DATA}`, Codex: `${PLUGIN_DATA}`, else `~/.ccc-review` | both |
| `CCC_REVIEW_CODEX_BIN` | `codex` | Claude → Codex |
| `CCC_REVIEW_CODEX_TIMEOUT_MS` | `1200000` (20 min; the Stop hook allows 30) | Claude → Codex |
| `CCC_REVIEW_CODEX_MODEL` | Codex's configured model (`-m`) | Claude → Codex |
| `CCC_REVIEW_CODEX_REASONING_EFFORT` | Codex's configured effort; `minimal`, `low`, `medium`, `high`, `xhigh` | Claude → Codex |
| `CCC_REVIEW_CLAUDE_BIN` | `claude` | Codex → Claude |
| `CCC_REVIEW_CLAUDE_TIMEOUT_MS` | `1200000` (20 min; the Stop hook allows 30) | Codex → Claude |
| `CCC_REVIEW_CLAUDE_MODEL` | Claude Code's configured model (`--model`) | Codex → Claude |
| `CCC_REVIEW_CLAUDE_EFFORT` | Claude Code's default; `low`, `medium`, `high`, `xhigh`, `max` | Codex → Claude |

<details>
<summary><b>State files</b></summary>

- `tasks/<taskId>.json`: round, verdict, baseline.
- `history/<taskId>.jsonl`: append-only log of `on`, each round, errors and
  `off`.
- `sessions/<sessionId>.json`: task id and recorded prompts.
- `claims/<taskId>/<hash>`: completions already reviewed, removed when the
  task ends.

</details>

<details>
<summary><b>Exact reviewer invocations</b></summary>

Both reviewers are spawned as executable + argument list with the prompt on
stdin, in their own process group with their own deadline.

```text
codex exec --sandbox read-only -c approval_policy="never" [-c model_reasoning_effort="…"] [-m <model>] \
  --cd <repo root> --ephemeral --color never --output-schema <strict schema> --output-last-message <file> -

claude -p --safe-mode --no-session-persistence --output-format json --json-schema <schema> \
  --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none [--model M] [--effort E]
```

`--safe-mode` loads no CLAUDE.md, plugins, hooks or MCP servers, so the
nested Claude cannot re-enter CCC Review's own hooks. Claude has no shell, so CCC Review
collects the Git changes itself (read-only `git log`, the changed-file list,
`git diff --no-ext-diff --no-textconv` and untracked files) and puts them in
the prompt.

</details>

## Security and privacy

In short:

- The reviewer **cannot change your code**: Codex runs in its read-only
  sandbox with approvals off, and Claude gets only Read/Grep/Glob, with no
  shell, plugins, hooks or MCP servers.
- CCC Review **never commits, stashes, resets, checks out, rebases or pushes**, and it
  starts processes as executable + arguments, never through a shell string.
- A reviewer failure is **never approval**.
- Your task, the writer's report and the changes **are sent to the reviewer's
  model provider** (OpenAI for Codex, Anthropic for Claude Code). Nothing goes
  anywhere else, and state stays outside the repository.

What read-only does **not** mean:

- **Codex can read outside the repository.** Its sandbox blocks writes and
  network access, not reads: the Codex reviewer can read any file your user
  account can read, and may quote it in a finding. The Claude reviewer has
  file tools only and no shell.
- **Secrets in changed files are sent.** A credential in a changed tracked
  file is part of the diff. Do not review changes you would not paste into a
  chat with that provider.
- **State is stored unencrypted.** Your recorded prompts and the findings are
  plain files in the state directory (kept at mode `0700`) until you delete
  them.

<details>
<summary><b>Exactly what the reviewer receives</b></summary>

- **The task**: the text after `on` or `current`, and your prompts while
  review is on (last 12 000 characters).
- **The writer's report**: its final message (last 12 000 characters). With
  `current` that message also contains the writer's own account of the task
  and its plan; otherwise the plan is not available to CCC Review and is not sent.
- **Git metadata**: repository root, branch, activation `HEAD`, and the paths
  that were already changed at `on` (up to 50).
- **The changes and any file the reviewer reads**: Codex runs
  `git diff`/`git log` and reads files itself; Claude gets `git log`, the
  changed-file list, the diff (up to 200 000 characters) and the untracked
  files in the prompt, and reads other files with its file tools.
- **Previous findings** and verdicts of the same task.

</details>

## Known limitations

- Windows is not supported (POSIX process groups and `/dev/null`); WSL works.
- `current` audits uncommitted changes only, not commits or branches.
- The writer's plan reaches the reviewer only through `current`, where the
  writer writes it down itself. Neither host gives hooks a documented way to
  read it.
- "A turn that changed nothing is not reviewed" is applied only when it can be
  proven: the tree was clean at `on`, `HEAD` is the same and the tree is clean
  now. If files were already changed at `on`, every finished turn is reviewed,
  including one where the writer only asks a question.
- Files that were already changed at `on` are listed for the reviewer but not
  attributed line by line.

<details>
<summary><b>Notes on undocumented host behaviour</b></summary>

- A completion is identified by its final message (in Codex, `turn_id` plus
  final message), so an identical completion delivered again is not reviewed
  twice.
- Claude Code does not document the `command_name` a hook gets for a plugin
  skill. Claude Code 2.1.278 sends `ccc-review:on` (and nothing for built-in
  commands such as `/status`), and that is what the hook accepts; if a later
  version changes it, the skill tells you that review was NOT enabled.
- Codex does not document how a skill mention reaches the hook. codex-cli
  0.155.1 delivers the literal `$ccc-review …` (also `$ccc-review:ccc-review …`). It does
  not load the skill text for a typed mention, so for `current` the hook
  itself tells Codex what to write.
- The interactive TUIs are covered by hook-level tests, smoke tests and a
  manual check, not by an automated TUI session.

</details>

## Testing

For contributors. You need Node.js ≥ 24, Git and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm check             # typecheck + lint (Biome, incl. format) + all tests + build
```

The default suite needs no credentials and no network, and never touches your
repositories or your Git configuration: it uses real temporary Git
repositories and fake `codex`/`claude` executables driven through the
production subprocess code.

<details>
<summary><b>All commands and the opt-in smoke tests</b></summary>

| Command | What runs |
| --- | --- |
| `pnpm test` | every deterministic test: no credentials, no network, no real Claude/Codex |
| `pnpm test:all` | same as `pnpm test` |
| `pnpm test:unit` | review loop, state, result validation, prompts, core boundary |
| `pnpm test:integration` | real temporary Git repositories, fake `codex`/`claude` executables, hook harnesses, the exact `hooks.json` commands, packaging |
| `pnpm test:coverage` | `pnpm test` with Node's coverage report |
| `pnpm typecheck` / `pnpm lint` / `pnpm format` / `pnpm build` | tsc, Biome check, Biome fix, emit `dist/` |

`test/setup.ts` isolates every git process and removes `CODEX_API_KEY` /
`ANTHROPIC_API_KEY` from the environment. Fake reviewer executables live only
in `test/`.

`pnpm test:smoke` and `pnpm test:smoke:install` are **not** part of
`pnpm test`. They use your real Claude Code and Codex installations, but only
in disposable temporary repositories and directories.

- `pnpm test:smoke` runs every smoke test, including the two that have the
  real reviewers review a planted bug. These **need credentials and consume
  model usage**.
- `pnpm test:smoke:install` installs the plugin from a clean copy into
  throwaway Claude Code and Codex config directories with the commands
  documented above, runs the installed hooks against fake reviewers, then
  upgrades and uninstalls. It needs no credentials and uses no model, and it
  is skipped when `claude` or `codex` is not installed.

</details>

## License

[MIT](LICENSE) © Martin Hlaváč. See the [changelog](CHANGELOG.md) for release
notes.
