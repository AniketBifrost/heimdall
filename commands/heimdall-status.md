---
name: heimdall-status
description: Show whether Heimdall is active for this project, in which mode, and the key tuning env vars.
user-invokable: true
allowed-tools: Bash(node:*)
---

# /heimdall-status — is the gate on?

Run exactly this one command (pre-authorized by `allowed-tools`, so it does NOT prompt):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/toggle.js" status --dir "${CLAUDE_PROJECT_DIR}"
```

Report the result to the user in one line.
