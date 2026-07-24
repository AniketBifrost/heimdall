#!/usr/bin/env node
'use strict';
/*
 * Heimdall — PreToolUse orchestrator (type: "command", zero-dependency).
 *
 * Fires before every Write / Edit / MultiEdit. Deterministic scaffolding around a
 * single LLM judgment call:
 *
 *   dormant?  -> allow          (no .claude/.heimdall-active)
 *   disabled? -> allow          (HEIMDALL_DISABLE / HEIMDALL_SUBPROCESS / ignore)
 *   trivial?  -> allow          (<5 changed lines, no dep/secret/public-API surface)
 *   otherwise -> load checklist.yaml, keep entries matching this change, ask a fast
 *                headless `claude -p` to judge, then map findings -> decision by a
 *                FIXED rule (the model never decides block/allow itself):
 *                  dependency-currency finding  -> ask
 *                  block-severity fail (strict) -> deny  (capped at 3 retries -> ask)
 *                  warn-only / advisory mode    -> allow + additionalContext
 *
 * Fail-open everywhere: any parse/spawn/timeout error allows the write. A broken gate
 * must never brick the edit loop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../scripts/lib');

const PLUGIN_ROOT = path.join(__dirname, '..');
const MAX_CONTENT_CHARS = 12000;
const ATTEMPT_CAP = 3;

// ── emit a PreToolUse decision and exit (always 0; JSON carries the verdict) ──
function decide(permissionDecision, reason, extra) {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision,
    permissionDecisionReason: reason,
  };
  if (extra && extra.additionalContext) hookSpecificOutput.additionalContext = extra.additionalContext;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
}
const allow = (reason, extra) => decide('allow', reason || 'heimdall: allowed', extra);

// ── per-file revision counter (persisted across hook processes) ──────────────
function attemptsPath(cwd) {
  return path.join(cwd, '.claude', '.heimdall-attempts.json');
}
function readAttempts(cwd) {
  try { return JSON.parse(fs.readFileSync(attemptsPath(cwd), 'utf8')); } catch (_) { return {}; }
}
function writeAttempts(cwd, obj) {
  try {
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(attemptsPath(cwd), JSON.stringify(obj));
  } catch (_) { /* best-effort */ }
}

function main(input) {
  // Never gate our own judgment subprocess, or an explicitly disabled session.
  if (process.env.HEIMDALL_DISABLE === '1' || process.env.HEIMDALL_SUBPROCESS === '1') return allow('heimdall: disabled');

  const toolName = input.tool_name || '';
  if (!/^(Write|Edit|MultiEdit)$/.test(toolName)) return allow('heimdall: tool not gated');

  const cwd = input.cwd || process.cwd();
  const state = lib.readState(cwd);
  if (!state.active) return allow('heimdall: dormant');

  const change = lib.extractChange(toolName, input.tool_input);
  if (lib.isIgnored(cwd, change.filePath)) return allow('heimdall: path ignored');

  const fileType = lib.detectFileType(change.filePath, change.content);
  const conditions = lib.detectConditions(change.filePath, change.content, fileType);

  // Triviality escape hatch — fast path, no model call (the common case in bulk edits).
  if (lib.isTrivial(change, conditions)) {
    return allow('heimdall: trivial change', {
      additionalContext: 'Heimdall (trivial fast-path): confirm this edit is necessary and minimal; full challenge skipped.',
    });
  }

  // Load + filter the checklist.
  let items;
  try {
    const yamlText = fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'checklist.yaml'), 'utf8');
    items = lib.filterChecklist(lib.parseChecklist(yamlText), conditions);
  } catch (_) {
    return allow('heimdall: checklist unreadable (fail-open)');
  }
  if (!items.length) return allow('heimdall: no checklist items apply');

  // Render the challenge prompt.
  const verdict = judge({ mode: state.mode, fileType, conditions, items, toolName, change });
  if (!verdict) return allow('heimdall: judge unavailable (fail-open)');

  return route({ cwd, state, fileType, items, verdict, filePath: change.filePath });
}

// ── build prompt, call the fast headless model, parse structured findings ────
function judge(ctx) {
  let template;
  try {
    template = fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'challenge-prompt.md'), 'utf8');
  } catch (_) { return null; }

  const checklistBlock = ctx.items.map((it) =>
    `- ${it.id} [${it.severity}] ${it.title}: ${it.question}`).join('\n');
  const content = (ctx.change.content || '').slice(0, MAX_CONTENT_CHARS);

  const prompt = template
    .replace(/{{MODE}}/g, ctx.mode)
    .replace(/{{FILE_TYPE}}/g, ctx.fileType)
    .replace(/{{CONDITIONS}}/g, Array.from(ctx.conditions).join(', '))
    .replace(/{{TOOL_NAME}}/g, ctx.toolName)
    .replace(/{{FILE_PATH}}/g, ctx.change.filePath || '(unknown)')
    .replace(/{{CHECKLIST}}/g, checklistBlock)
    .replace(/{{CONTENT}}/g, content);

  const model = process.env.HEIMDALL_MODEL || 'haiku';
  const timeoutMs = Math.max(10, parseInt(process.env.HEIMDALL_TIMEOUT || '90', 10)) * 1000;

  // Prompt goes in via a temp file on stdin — no arg-length or shell-escaping hazard.
  let tmp;
  try {
    tmp = path.join(os.tmpdir(), `gk-prompt-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, prompt);
  } catch (_) { return null; }

  let stdout = '';
  try {
    const res = spawnSync(`claude -p --model ${model} --output-format text < "${tmp}"`, {
      shell: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: Object.assign({}, process.env, { HEIMDALL_SUBPROCESS: '1', HEIMDALL_DISABLE: '1' }),
      encoding: 'utf8',
    });
    if (res.status !== 0 || !res.stdout) return null;
    stdout = res.stdout;
  } catch (_) {
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }

  return parseVerdict(stdout);
}

// pull the last balanced {...} object out of the model's text and validate it
function parseVerdict(text) {
  const obj = extractLastJsonObject(text);
  if (!obj || typeof obj !== 'object') return null;
  const failed = Array.isArray(obj.failed) ? obj.failed.filter((f) => f && f.id) : [];
  const verdict = obj.verdict === 'revise' || obj.verdict === 'ask' || obj.verdict === 'approve'
    ? obj.verdict : (failed.length ? 'revise' : 'approve');
  return { verdict, failed, notes: obj.notes || '' };
}

function extractLastJsonObject(text) {
  const s = String(text || '');
  let depth = 0, start = -1, best = null, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { best = JSON.parse(s.slice(start, i + 1)); } catch (_) { /* keep scanning */ }
        start = -1;
      }
    }
  }
  return best;
}

// ── deterministic findings -> permissionDecision (the model never decides this) ──
function route(ctx) {
  const { cwd, state, fileType, items, verdict, filePath } = ctx;
  const key = filePath || '(unknown)';
  const attempts = readAttempts(cwd);

  const result = lib.mapDecision({
    mode: state.mode,
    fileType,
    items,
    failed: verdict.failed,
    attemptCount: attempts[key] || 0,
    attemptCap: ATTEMPT_CAP,
  });

  // persist the counter the pure mapper computed
  attempts[key] = result.reset ? 0 : result.nextAttemptCount;
  writeAttempts(cwd, attempts);

  return decide(result.permissionDecision, result.reason,
    result.additionalContext ? { additionalContext: result.additionalContext } : undefined);
}

// ── stdin plumbing (fail-open on everything) ─────────────────────────────────
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw || '{}'); } catch (_) { return allow('heimdall: unparseable input (fail-open)'); }
  try { main(input); } catch (_) { return allow('heimdall: internal error (fail-open)'); }
});
