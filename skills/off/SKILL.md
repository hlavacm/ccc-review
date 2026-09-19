---
description: Turn CCC Review (Codex reviews Claude's changes) off for this session. Usage /ccc-review:off
disable-model-invocation: true
---

The CCC Review hook did not handle this command, so nothing was changed: if review
was active it is still active, NOT turned off.
Tell the user exactly that, and that the `ccc-review` plugin hooks are probably
not installed or not trusted (check `/plugin` and `/hooks`, and that
Node.js ≥ 24 is on PATH). Do nothing else.
