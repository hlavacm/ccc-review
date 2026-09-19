---
description: Turn CCC Review on for this session, so Codex reviews Claude's changes every time Claude finishes. Usage /ccc-review:on [task description]
argument-hint: "[task description]"
disable-model-invocation: true
---

The CCC Review hook did not handle this command, so nothing was changed and
Codex review is NOT active.
Tell the user exactly that, and that the `ccc-review` plugin hooks are probably
not installed or not trusted (check `/plugin` and `/hooks`, and that
Node.js ≥ 24 is on PATH). Do nothing else.
