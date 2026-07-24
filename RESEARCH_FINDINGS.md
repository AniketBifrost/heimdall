# Heimdall — Phase 0 Research Findings

Research done **before** scaffolding, per the build brief. Goal: don't ship one
person's checklist — find how mature teams and existing tools gate code, and let that
shape both the checklist and the hook architecture.

---

## 1. Hook-mechanism verdict (the load-bearing decision)

**Question:** the brief assumes a `PreToolUse` hook of `type: "prompt"` (LLM-evaluated).
Does that exist in current Claude Code, and is it the right mechanism?

**Findings (from the official reference, https://code.claude.com/docs/en/hooks):**

- Claude Code hooks support **five** handler types: `command`, `http`, `mcp_tool`,
  `prompt`, and `agent` (the last marked experimental). So `type: "prompt"` **is real** —
  the brief's assumption holds.
- `type: "prompt"` fields: `prompt` (with `$ARGUMENTS` = the hook input JSON injected
  verbatim), optional `model` (defaults to a fast model), optional `timeout`
  (**default 30 s**). The model must emit the same `hookSpecificOutput` JSON as any other
  hook — there is no simpler decision channel for prompt hooks.
- PreToolUse decision schema (verified verbatim):
  ```json
  { "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow | deny | ask | defer",
      "permissionDecisionReason": "…",
      "updatedInput": { },        // optionally rewrite the tool input before it runs
      "additionalContext": "…"    // string injected into Claude's context
  } }
  ```
  Exit code `0` = no objection (does **not** auto-approve — normal permission flow still
  runs); `2` = block, stderr fed back to Claude; anything else = non-blocking error.
  `permissionDecision: "deny"` blocks even under `--dangerously-skip-permissions`.

**Decision: use `type: "command"` (a Node orchestrator), not the native `type: "prompt"`.**
Not because prompt hooks don't work — because the research below makes three requirements
that a pure prompt hook structurally *cannot* meet:

| Requirement (from research) | Pure `type:"prompt"` hook | `type:"command"` orchestrator |
| --- | --- | --- |
| Checklist lives in an external `checklist.yaml`, editable without touching hook wiring | ✗ — prompt text is static; no file I/O | ✓ — reads + filters the YAML at runtime |
| Block/allow decision **deterministic, outside the model** (ci-review-gate's #1 lesson) | ✗ — the model emits the verdict AND the decision | ✓ — model emits findings; fixed severity threshold decides block/allow |
| **Fail-open** on judge error; **triviality escape hatch**; **per-rule suppression**; **scope to the changed hunk** | ✗ — no place to run deterministic pre/post logic | ✓ — all done in code around the model call |

The orchestrator still gets **real LLM judgment** — it shells to a headless `claude -p`
with a fast model — so it is *not* a dumb regex gate. It just wraps that judgment in the
deterministic scaffolding every mature gate in the survey insists on. This also matches
this repo's own precedent: `figspec` gates a `PreToolUse` with a `type:"command"` Node
script, not a prompt hook.

> A native `type:"prompt"` variant is documented in the README as a lighter, checklist-inlined
> alternative for anyone who wants zero subprocess cost and accepts a static checklist.

---

## 2. Sources surveyed

| Source | What it is | What we took |
| --- | --- | --- |
| code.claude.com/docs/en/hooks | Official hooks reference | Handler types, PreToolUse JSON schema, exit-code semantics |
| dev.to `.../pretooluse-hook-system-for-claude-code` | Real PreToolUse guardrail in Python | Advisory-via-`additionalContext` vs block-via-exit-2 split; block destructive tool inputs |
| github.com/intrinsic-labs/ci-review-gate | Claude-as-CI-gate | **Keep the severity threshold outside the model**; structured-output contract |
| github.com/George-Paul97/ai-code-review-gatekeeper | Dependency-free rule scanner | rule-id + severity + `file:line` output shape; `--fail-on-findings` exit code |
| SonarQube "Sonar way" quality gate | Industry-default gate | **Gate on new code only**; ≥20-new-lines threshold before heavy conditions; hotspots-to-review ≠ bugs |
| securityboulevard.com (SonarQube for AI code) | Tuning gates for AI output | AI code needs *tighter* review on security-sensitive constructs |
| danger.systems / danger-js | PR-chore bot | tests-changed-with-code; lockfile/manifest drift; PR-size ceiling |
| eslint-plugin-react `no-danger` | XSS rule | Flag `dangerouslySetInnerHTML`/`v-html` w/o sanitizer (DOMPurify) |
| react.dev `exhaustive-deps` | Hooks lint | Stale-closure dep-array correctness |
| eslint-plugin-jsx-a11y | A11y lint | alt-text, form-has-label, anchor-has-content floor |
| codeant.ai / cubic.dev (false positives) | FP economics | 5–15% FP rate compounds; alert fatigue → wholesale bypass |
| jetxu-llm low-noise-code-review | Signal/noise framework | Measure noise; reserve hard blocks for high-confidence findings |

---

## 3. Heimdalls added beyond the brief's seed list

The brief's items 1–33 are the seed. Research validated these **additions** (merged into
`checklist.yaml`; each notes why it earns its place over the noise it adds):

| id | Title | Scope | Why (evidence) |
| --- | --- | --- | --- |
| `tests-with-change` | Tests changed with the code | both | Danger's canonical rule. Source touched without a test change is the single highest-signal, lowest-noise gate mature teams run. |
| `secrets-in-payload` | No hardcoded secrets in the write | both | A PreToolUse hook blocks the secret *before it hits disk* — strictly better than post-hoc CI. ai-guard scans for this; cheap and high-value. |
| `diff-scope-only` | Judge the changed hunk, not the whole file | both | Sonar "clean as you code" + top friction complaint: flagging pre-existing debt in a file merely touched trains developers to bypass the gate. Encoded as a **rule the judge must obey**, not a checklist item. |
| `no-disabled-guards` | Not silently disabling lint/type/test guards | both | DEV.to guardrail blocks `--no-verify`-style escapes; the write-side equivalent is a diff that adds `eslint-disable`, `# type: ignore`, `[SuppressMessage]`, or deletes a test. High-signal. |
| `complexity-ceiling` | Function/edit not a giant blob | both | Sonar cognitive-complexity + Danger PR-size. Catches the "one 300-line function" a yes/no checklist waves through. |
| `lockfile-drift` | Manifest changed → lockfile updated | both | Danger rule; deterministic, high-value, LLM checklists routinely miss it. |
| `react-hooks-deps` | Correct hook dependency arrays | frontend | `exhaustive-deps`; stale-closure bugs read as correct code — hard for a generic checklist to catch. |
| `a11y-floor` | Accessibility essentials | frontend | jsx-a11y basics; a11y almost never appears on a generic quality checklist yet is a hard team requirement. (Reinforces seed #21.) |
| `security-hotspot-review` | Flag security-sensitive constructs for review | backend | Sonar's hotspot model: surface crypto/auth/deserialization/injection *sinks for review* rather than only asserting a confirmed vuln. (Sharpens seed #5.) |

**Deliberately NOT added** (evaluated, rejected as low-signal-for-a-write-time gate):

- *Changelog entry required* (Danger) — release-process concern, not a per-edit concern.
- *PR title/label conventions* — belongs in CI, not a Write/Edit interceptor.
- *Coverage %/duplication density thresholds* — need a whole-repo scan; too slow and
  noisy to compute inside a per-edit hook. Left to SonarQube in CI (this repo already has
  a Sonar plugin).

---

## 4. Pitfalls the design must answer (and how it does)

| Pitfall (evidence) | Design answer |
| --- | --- |
| **False-positive tax compounds** — 5–15% FP, ~218 hrs/yr burned dismissing noise (codeant.ai) | Triviality escape hatch; `warn` vs `block` severity per item; only `block`-severity failures deny. |
| **Alert fatigue → wholesale bypass** — up to 40% of AI alerts ignored (cubic.dev) | Advisory mode ships; `block` reserved for high-confidence, high-severity items; findings are itemized + actionable, never a wall of prose. |
| **Blocking mid-edit costs 15–23 min of flow** | Gate is **command-gated** (dormant until `/heimdall-on`); trivial edits short-circuit; attempt cap = 3 then downgrade to `ask`. |
| **Model deciding "should I block?" is non-reproducible** (ci-review-gate) | The **orchestrator** maps findings→decision via a fixed rule (any unresolved `block` item in strict mode = deny). The model only supplies findings. |
| **Latency on every write** (30 s prompt-hook timeout) | Fast model by default (`HEIMDALL_MODEL`, e.g. haiku); triviality skip means most edits never call the model; per-hook timeout raised on the command hook. |
| **A broken hook must not brick the workflow** | **Fail-open**: any parse/subprocess/timeout error → `exit 0` (allow). Never fail-closed on the gate's own failure. |
| **Intentional patterns must be suppressible** | Per-rule disable via `checklist.yaml` (`enabled: false`), path opt-out via `.heimdallignore`, and a global kill via `HEIMDALL_DISABLE=1`. |
| **Don't re-litigate old code** | `diff-scope-only` rule instructs the judge to evaluate only the new/changed content in `tool_input`, not pre-existing lines. |

---

## 5. Net architecture (informed by the above)

```
Write/Edit/MultiEdit
        │  PreToolUse  (matcher: "Write|Edit|MultiEdit")
        ▼
scripts/check-active.sh ── no .claude/.heimdall-active ──▶ exit 0  (dormant)
        │ active (+ mode: strict|advisory)
        ▼
hooks/heimdall-gate.js  (type: command, Node, zero-dep)
  1. parse stdin {tool_name, tool_input, cwd}
  2. .heimdallignore / HEIMDALL_DISABLE → allow
  3. triviality: <5 changed lines, no dep/secret/public-API marker → allow
  4. detect file type (backend vs frontend) from path/extension
  5. read checklist.yaml, keep entries whose applies_when matches
  6. render challenge-prompt.md with {mode, filetype, checklist, tool_input}
  7. claude -p --model $HEIMDALL_MODEL  → structured findings JSON
  8. deterministic map: findings → permissionDecision
       - dependency-currency finding      → ask   (user approves upgrades)
       - unresolved block-severity (strict)→ deny  (itemized reason)
       - warn-only, or advisory mode       → allow + additionalContext
  9. attempt counter (per file, cap 3) → 4th → ask
  ANY ERROR at any step                    → allow (fail-open)
```
