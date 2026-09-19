---
description: Turn CCC Review (Codex reviews Claude's changes) on, off, or show status. Usage /cccr:cccr on [task description] | off | status
argument-hint: on [task description] | off | status
disable-model-invocation: true
---

The CCC Review hook did not handle this command, so nothing was changed and
Codex review is NOT active. Tell the user exactly that, and that the `cccr`
plugin hooks are probably not installed or not trusted (check `/plugin` and
`/hooks`, and that Node.js ≥ 22.18 is on PATH). Do nothing else.
