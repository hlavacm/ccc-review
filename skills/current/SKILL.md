---
description: Ask Codex for a one-off independent audit of the current uncommitted changes. Nothing is fixed automatically. Usage /ccc-review:current [note for the reviewer]
argument-hint: "[note for the reviewer]"
disable-model-invocation: true
---

An independent reviewer (Codex) is about to audit the uncommitted changes in
this repository. CCC Review sends it your next final message together with the
real Git changes, so write that message now for someone who has not seen this
conversation:

1. **Task**: what the user asked for, in their words where possible.
2. **Plan**: the approach you chose and why, including decisions and trade-offs.
3. **Report**: what you actually changed (files), what you verified and how,
   and what is still open or untested.

Note from the user for the reviewer: $ARGUMENTS

Be factual and do not claim checks you did not run. Do not modify any files and
do not run anything that changes the repository. Then end your turn; the audit
starts when you finish.
