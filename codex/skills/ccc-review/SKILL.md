---
name: ccc-review
description: CCC Review (Claude Code reviews Codex's changes). Only for an explicit `$ccc-review on [task description] | current [note] | off | status` typed by the user; never invoke it on your own.
---

If the user's message is `$ccc-review current …`: an independent reviewer
(Claude Code) is about to audit the uncommitted changes in this repository.
CCC Review sends it your next final message together with the real Git
changes, so write that message now for someone who has not seen this
conversation:

1. **Task**: what the user asked for, in their words where possible.
2. **Plan**: the approach you chose and why, including decisions and trade-offs.
3. **Report**: what you actually changed (files), what you verified and how,
   and what is still open or untested.

Include any note the user wrote after `current`. Be factual and do not claim
checks you did not run. Do not modify any files and do not run anything that
changes the repository. Then end your turn; the audit starts when you finish.

For any other `$ccc-review` command: the CCC Review hook did not handle it, so
nothing was changed and Claude review is NOT active. Tell the user exactly
that, and that the `ccc-review` plugin hooks are probably not installed or not
trusted (check `/plugins` and `/hooks`, and that Node.js ≥ 24 is on PATH). Do
nothing else.
