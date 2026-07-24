'use strict';
/*
 * Heimdall — shared, pure helpers (no I/O on load, zero dependencies).
 *
 * Everything here is deterministic: state/mode, file-type routing, marker-based
 * condition detection, change-size, triviality, and a small YAML-subset parser for
 * checklist.yaml. The LLM judgment lives only in heimdall-gate.js; this file is what
 * keeps the block/allow decision reproducible and outside the model.
 */

const fs = require('fs');
const path = require('path');

// ── State: is the gate active, and in which mode? ────────────────────────────
// State file: <cwd>/.claude/.heimdall-active  — its trimmed contents are the mode
// ("strict" or "advisory"). Absent file => dormant.
function readState(cwd) {
  try {
    const p = path.join(cwd, '.claude', '.heimdall-active');
    const raw = fs.readFileSync(p, 'utf8').trim().toLowerCase();
    const mode = raw === 'advisory' ? 'advisory' : 'strict';
    return { active: true, mode };
  } catch (_) {
    return { active: false, mode: 'strict' };
  }
}

// ── Extract the text actually being written, and its target path ─────────────
function extractChange(toolName, toolInput) {
  const input = toolInput || {};
  const filePath = input.file_path || input.path || input.notebook_path || '';
  let content = '';
  if (toolName === 'Write') {
    content = input.content || '';
  } else if (toolName === 'Edit') {
    content = input.new_string || '';
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    content = edits.map((e) => (e && e.new_string) || '').join('\n');
  } else {
    content = input.content || input.new_string || '';
  }
  return { filePath, content };
}

function lineCount(s) {
  if (!s) return 0;
  return s.split('\n').length;
}

// ── File type: frontend vs backend vs other ──────────────────────────────────
const FRONTEND_EXT = new Set([
  '.jsx', '.tsx', '.vue', '.svelte', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.astro',
]);
const AMBIGUOUS_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);
const BACKEND_EXT = new Set([
  '.cs', '.py', '.java', '.go', '.rb', '.php', '.rs', '.kt', '.kts', '.scala',
  '.cpp', '.cc', '.c', '.h', '.hpp', '.fs', '.vb', '.sql', '.ex', '.exs', '.clj',
]);

function detectFileType(filePath, content) {
  const p = (filePath || '').replace(/\\/g, '/').toLowerCase();
  const ext = path.extname(p);
  if (FRONTEND_EXT.has(ext)) return 'frontend';
  // Angular building blocks are ambiguous-ext .ts but unmistakably frontend —
  // by filename suffix (foo.component.ts) or by a decorator marker in content.
  const angularSuffix = /\.(component|directive|pipe|guard|resolver|module)\.(ts|js)$/.test(p);
  const angularMarker = /@Component\b|@Directive\b|@Pipe\b|@NgModule\b/.test(content || '');
  if (AMBIGUOUS_EXT.has(ext) && (angularSuffix || angularMarker)) return 'frontend';
  const inUiDir = /(^|\/)(components?|pages|views|app\/[^/]*\/(page|layout)|ui|widgets)(\/|\.)/.test(p);
  if (AMBIGUOUS_EXT.has(ext) && inUiDir) return 'frontend';
  if (BACKEND_EXT.has(ext)) return 'backend';
  if (AMBIGUOUS_EXT.has(ext)) return 'backend'; // node/server/tooling .ts/.js
  return 'other';
}

// ── Marker-based semantic conditions ─────────────────────────────────────────
const MANIFEST_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'packages.config', 'requirements.txt', 'pyproject.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'go.mod', 'go.sum', 'cargo.toml',
  'gemfile', 'composer.json', 'paket.dependencies',
]);
const PROJECT_EXT = new Set(['.csproj', '.fsproj', '.vbproj']);

const RE = {
  dependency: /PackageReference|dotnet add package|npm (?:i|install)\b|yarn add\b|pnpm add\b|pip install|<dependency>|Include="[^"]+"\s+Version=/i,
  concurrency: /\block\s*[({]|Interlocked|Task\.Run|new Thread|\bvolatile\b|Concurrent(?:Dictionary|Queue|Bag)|SemaphoreSlim|Monitor\.|\bMutex\b|Parallel\.(?:For|ForEach|Invoke)|Channel<|threading\.|asyncio\.|\bgoroutine\b|sync\.(?:Mutex|RWMutex|WaitGroup)/,
  cache: /\bRedis\b|IDistributedCache|IMemoryCache|\bMemoryCache\b|HttpContext\.Session|StackExchange\.Redis|\bISession\b|distributedcache/i,
  publicApi: /\[Http(?:Get|Post|Put|Delete|Patch)\]|\[ApiController\]|\[Route|Map(?:Get|Post|Put|Delete|Patch)\s*\(|app\.(?:get|post|put|delete|patch)\s*\(|@(?:Get|Post|Put|Delete|Patch)Mapping|@RestController/,
  cloud: /BackgroundService|IHostedService|livenessProbe|readinessProbe|kind:\s*(?:Deployment|StatefulSet|DaemonSet|Service)|FROM\s+\S+\s+AS\s+|imagePullPolicy/i,
  secret: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|client[_-]?secret|connection[_-]?string|conn[_-]?str)\s*[:=]\s*["'][^"']{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{10,}|ghp_[0-9A-Za-z]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./i,
  // ORM / SQL data-access surface
  dataAccess: /DbContext|DbSet<|\.ToListAsync|\.FirstOrDefaultAsync|\.SingleOrDefaultAsync|AsNoTracking|\.Include\(|\.ThenInclude\(|FromSql|IQueryable|\.SaveChangesAsync|SqlConnection|SqlCommand|\bDapper\b|\.Query<|\.QueryAsync|\.ExecuteAsync|MongoCollection|\.Aggregate\(/,
  // outbound external calls
  externalCall: /HttpClient|IHttpClientFactory|\.GetAsync\(|\.PostAsync\(|\.PutAsync\(|\.DeleteAsync\(|\.SendAsync\(|RestClient|RestSharp|\bWebClient\b|GrpcChannel|new HttpRequestMessage/,
  // sync-over-async blocking anti-pattern
  blockingAsync: /\.Result\b|\.Wait\(\)|\.GetAwaiter\(\)\.GetResult\(\)|Task\.WaitAll|Task\.WaitAny/,
  // DI container registration
  diReg: /\.Add(?:Singleton|Scoped|Transient)\s*[<(]|services\.Add[A-Z]|builder\.Services\.Add/,
  // CORS configuration
  cors: /AddCors|AllowAnyOrigin|WithOrigins|SetIsOriginAllowed|UseCors/,
  // browser client-side storage
  clientStorage: /localStorage|sessionStorage|document\.cookie/,
  // Angular / RxJS surface
  rxjs: /@Component\b|@Injectable\b|\bObservable<|\.subscribe\(|\.pipe\(|(?:Behavior|Replay)?Subject<|takeUntil\(|ngOnDestroy/,
};

function detectConditions(filePath, content, fileType) {
  const p = (filePath || '').replace(/\\/g, '/').toLowerCase();
  const base = path.basename(p);
  const ext = path.extname(p);
  const c = content || '';
  const set = new Set(['always']);

  if (fileType === 'frontend') set.add('frontend_change');
  if (fileType === 'backend') set.add('backend_change');

  const isManifest = MANIFEST_BASENAMES.has(base) || PROJECT_EXT.has(ext);
  if (isManifest || RE.dependency.test(c)) set.add('new_dependency');

  if (RE.concurrency.test(c)) set.add('concurrency');
  if (RE.cache.test(c)) set.add('cache');

  const inControllerPath = /(^|\/)(controllers?|api|endpoints?)(\/|$)/.test(p);
  if ((fileType === 'backend' && RE.publicApi.test(c)) || inControllerPath) set.add('public_api');

  const isInfra = base === 'dockerfile' || /(^|\/)(helm|k8s|kubernetes|deploy(ments?)?|charts?)(\/|$)/.test(p) ||
    ((ext === '.yaml' || ext === '.yml') && RE.cloud.test(c)) || RE.cloud.test(c);
  if (isInfra) set.add('cloud_deploy');

  // marker-gated backend surfaces
  if (RE.dataAccess.test(c)) set.add('data_access');
  if (RE.externalCall.test(c)) set.add('external_call');
  if (RE.blockingAsync.test(c)) set.add('blocking_async');
  if (RE.diReg.test(c)) set.add('di_registration');
  if (RE.cors.test(c)) set.add('cors_config');

  // marker-gated frontend surfaces
  if (fileType === 'frontend' && RE.clientStorage.test(c)) set.add('client_storage');
  if (fileType === 'frontend' && RE.rxjs.test(c)) set.add('rxjs');

  return set;
}

function hasSecret(content) {
  return RE.secret.test(content || '');
}

// ── Triviality escape hatch ──────────────────────────────────────────────────
// Small change, no new dependency, no security-sensitive / public-API surface.
function isTrivial(change, conditions, opts) {
  const maxLines = (opts && opts.maxLines) || 5;
  if (lineCount(change.content) > maxLines) return false;
  if (conditions.has('new_dependency')) return false;
  if (conditions.has('public_api')) return false;
  if (conditions.has('concurrency')) return false;
  if (conditions.has('blocking_async')) return false;
  if (conditions.has('external_call')) return false;
  if (conditions.has('cors_config')) return false;
  if (conditions.has('client_storage')) return false;
  if (hasSecret(change.content)) return false;
  return true;
}

// ── .heimdallignore (gitignore-lite: exact substring / glob-star match) ─────
function isIgnored(cwd, filePath) {
  try {
    const p = path.join(cwd, '.heimdallignore');
    const lines = fs.readFileSync(p, 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const target = (filePath || '').replace(/\\/g, '/');
    return lines.some((pat) => {
      const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return rx.test(target) || target.includes(pat);
    });
  } catch (_) {
    return false;
  }
}

// ── Minimal YAML-subset parser for checklist.yaml ────────────────────────────
// Supports exactly the shape this plugin ships: a top-level `checklist:` list of
// map items with single-line scalar fields. Not a general YAML parser.
function parseChecklist(yamlText) {
  const out = [];
  const lines = (yamlText || '').split('\n');
  let inList = false;
  let cur = null;
  const push = () => { if (cur && cur.id) out.push(cur); cur = null; };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!inList) {
      if (/^checklist:\s*$/.test(trimmed)) inList = true;
      continue;
    }
    const itemMatch = line.match(/^\s*-\s+(.*)$/);
    if (itemMatch) {
      push();
      cur = {};
      assignField(cur, itemMatch[1]);
      continue;
    }
    if (cur) assignField(cur, trimmed);
  }
  push();
  return out;
}

function assignField(obj, kv) {
  const m = kv.match(/^([A-Za-z_]+):\s?(.*)$/);
  if (!m) return;
  const key = m[1];
  let val = m[2];
  // strip a single layer of matching quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1).replace(/\\"/g, '"');
  }
  if (val === 'true') val = true;
  else if (val === 'false') val = false;
  obj[key] = val;
}

// keep only enabled entries whose applies_when is satisfied by the active conditions
function filterChecklist(items, conditions) {
  return items.filter((it) => {
    if (it.enabled === false) return false;
    const cond = it.applies_when || 'always';
    return conditions.has(cond);
  });
}

// ── Pure decision mapping: model findings -> permissionDecision ──────────────
// The model NEVER decides block/allow — this fixed rule does. Pure + side-effect free
// so it is unit-testable without any subprocess or file I/O.
//   opts: { mode, fileType, items, failed, attemptCount, attemptCap }
//   returns: { permissionDecision, reason, additionalContext?, nextAttemptCount, reset }
function mapDecision(opts) {
  const mode = opts.mode === 'advisory' ? 'advisory' : 'strict';
  const cap = opts.attemptCap || 3;
  const items = opts.items || [];
  const sevOf = {};
  items.forEach((it) => { sevOf[it.id] = it.severity; });

  const failed = (opts.failed || []).filter((f) => f && f.id).map((f) => ({
    id: f.id,
    title: f.title || f.id,
    severity: sevOf[f.id] || f.severity || 'warn',
    reason: f.reason || '',
  }));

  const askItems = failed.filter((f) => f.severity === 'ask');
  const blockItems = failed.filter((f) => f.severity === 'block');
  const warnItems = failed.filter((f) => f.severity === 'warn');

  const fmt = (arr) => arr.map((f, i) => `  ${i + 1}. ${f.id} (${f.title}): ${f.reason}`).join('\n');
  const header = `CHALLENGE RESULT (${mode}, ${opts.fileType || 'code'})`;

  // 1) Dependency upgrade — only the user may approve.
  if (askItems.length) {
    return {
      permissionDecision: 'ask',
      reason: `${header}: ask\nA dependency change needs your approval — do NOT auto-upgrade:\n${fmt(askItems)}` +
        (blockItems.length ? `\nAlso failing (block):\n${fmt(blockItems)}` : ''),
      nextAttemptCount: 0, reset: true,
    };
  }

  // 2) Strict + a block-severity failure — deny, with a retry cap.
  if (mode === 'strict' && blockItems.length) {
    const n = (opts.attemptCount || 0) + 1;
    if (n > cap) {
      return {
        permissionDecision: 'ask',
        reason: `${header}: unresolved after ${cap} revisions — escalating to you.\n` +
          `Still failing (block):\n${fmt(blockItems)}\nApprove to proceed as-is, or deny to keep revising.`,
        nextAttemptCount: 0, reset: true,
      };
    }
    return {
      permissionDecision: 'deny',
      reason: `${header}: revise  (attempt ${n}/${cap})\n` +
        `FAILED (block): ${blockItems.map((f) => f.id).join(', ')}\n${fmt(blockItems)}` +
        (warnItems.length ? `\nAlso (warn):\n${fmt(warnItems)}` : '') +
        `\nRevise the code to resolve the blocking items — prefer fewer, simpler lines — then retry the write.`,
      nextAttemptCount: n, reset: false,
    };
  }

  // 3) Advisory mode, or warn-only — allow, surface as context.
  if (!failed.length) {
    return { permissionDecision: 'allow', reason: `${header}: approve`, nextAttemptCount: 0, reset: true };
  }
  return {
    permissionDecision: 'allow',
    reason: `${header}: approve (with advisories)`,
    additionalContext: `${header}: allowed with advisories` +
      (mode === 'advisory' && blockItems.length ? ` (advisory mode — block items not enforced)` : '') +
      `\n${fmt([...blockItems, ...warnItems])}`,
    nextAttemptCount: 0, reset: true,
  };
}

module.exports = {
  readState, extractChange, lineCount, detectFileType, detectConditions,
  hasSecret, isTrivial, isIgnored, parseChecklist, filterChecklist, mapDecision, RE,
};
