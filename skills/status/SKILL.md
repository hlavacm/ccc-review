---
description: Show whether CCC Review (Codex reviews Claude's changes) is active, the current round and the review history. Usage /ccc-review:status
disable-model-invocation: true
---

The CCC Review hook did not handle this command, so nothing was changed and
the review status is NOT known.
Tell the user exactly that, and that the `ccc-review` plugin hooks are probably
not installed or not trusted (check `/plugin` and `/hooks`, and that
Node.js ≥ 24 is on PATH). Do nothing else.
