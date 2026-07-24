#!/usr/bin/env node
'use strict';
/*
 * Heimdall activation toggle — writes/removes the per-project state file that the
 * PreToolUse hook reads. Runs via a single `node` invocation so the slash commands
 * can pre-authorize it with `allowed-tools: Bash(node:*)` — no permission prompt,
 * cross-platform (no mkdir/printf/rm shelling).
 *
 *   node toggle.js on   [--dir <projectDir>] [strict|advisory]
 *   node toggle.js off  [--dir <projectDir>]
 *   node toggle.js status [--dir <projectDir>]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const action = (args[0] || 'status').toLowerCase();

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const dir = argVal('--dir') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const claudeDir = path.join(dir, '.claude');
const stateFile = path.join(claudeDir, '.heimdall-active');
const attemptsFile = path.join(claudeDir, '.heimdall-attempts.json');
const rest = args.slice(1).join(' ');
const mode = /\badvisory\b/i.test(rest) ? 'advisory' : 'strict';

try {
  if (action === 'on') {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(stateFile, mode);
    try { fs.unlinkSync(attemptsFile); } catch (_) { /* fresh */ }
    console.log(`Heimdall: ACTIVE (${mode}) — every Write/Edit/MultiEdit is now challenged ` +
      `against the checklist before it lands. Trivial edits (<5 lines, no dep/secret/public-API) ` +
      `pass instantly. Turn off with /heimdall-off.`);
  } else if (action === 'off') {
    try { fs.unlinkSync(stateFile); } catch (_) { /* already off */ }
    try { fs.unlinkSync(attemptsFile); } catch (_) { /* none */ }
    console.log('Heimdall: OFF — hook is dormant (still installed). Re-enable with /heimdall-on [strict|advisory].');
  } else {
    let s = null;
    try { s = fs.readFileSync(stateFile, 'utf8').trim(); } catch (_) { /* off */ }
    console.log(s ? `Heimdall: ACTIVE (mode: ${s})` : 'Heimdall: OFF (dormant)');
    console.log('Model:   ' + (process.env.HEIMDALL_MODEL || 'haiku (default)'));
    console.log('Disable: ' + (process.env.HEIMDALL_DISABLE || 'unset'));
    console.log('Timeout: ' + (process.env.HEIMDALL_TIMEOUT || '90') + 's');
  }
} catch (e) {
  console.error('Heimdall toggle error: ' + e.message);
  process.exit(1);
}
