---
name: heimdall-on
description: Activate Heimdall for this project. Every Write/Edit/MultiEdit is then challenged against the checklist before it lands. Optional mode — `strict` (default; blocks on failure) or `advisory` (warns but allows).
argument-hint: "[strict|advisory]"
user-invokable: true
allowed-tools: Bash(node:*)
---

# /heimdall-on — activate the write gate

Activate Heimdall. Run exactly this one command (it is pre-authorized by this command's
`allowed-tools`, so it does NOT prompt for permission — it just writes the state file and
prints a confirmation):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/toggle.js" on --dir "${CLAUDE_PROJECT_DIR}" $ARGUMENTS
```

`$ARGUMENTS` may contain `strict` (default) or `advisory`:
- **strict** — a failing `block`-severity checklist item denies the write; Claude must revise
  and retry (capped at 3 revisions, then it escalates to the user).
- **advisory** — nothing is blocked; failures come back as context.

After running, report the confirmation line the script printed (which mode is active). Do not
run any other command. The gate uses the shell (not the Write tool), so activating never
trips Heimdall itself.
