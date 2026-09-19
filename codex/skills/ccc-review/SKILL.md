---
name: ccc-review
description: Turn CCC Review (Claude Code reviews Codex's changes) on, off, or show status. Only for an explicit `$ccc-review on [task description] | off | status` typed by the user; never invoke it on your own.
---

The CCC Review hook did not handle this command, so nothing was changed and
Claude review is NOT active. Tell the user exactly that, and that the `ccc-review`
plugin hooks are probably not installed or not trusted (check `/plugins` and
`/hooks`, and that Node.js ≥ 22.18 is on PATH). Do nothing else.
