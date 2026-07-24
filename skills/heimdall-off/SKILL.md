---
name: heimdall-off
description: Deactivate Heimdall for this project. The hook stays installed but goes dormant — Write/Edit/MultiEdit are no longer challenged.
user-invokable: true
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# /heimdall-off — deactivate the write gate

Deactivate Heimdall. Run exactly this one command (pre-authorized by `allowed-tools`, so it
does NOT prompt — it removes the state file and confirms):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/toggle.js" off --dir "${CLAUDE_PROJECT_DIR}"
```

Report the confirmation line. Do not run any other command. The gate is now dormant (still
installed); edits are no longer challenged until /heimdall-on.
