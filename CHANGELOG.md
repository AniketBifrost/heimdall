# Changelog

## 0.1.0

Initial release.

- `PreToolUse` hook on `Write|Edit|MultiEdit`, dormant until `/heimdall-on`.
- `type: "command"` Node orchestrator: deterministic gate (state, triviality escape hatch,
  file-type routing, marker-based conditions, per-file 3-retry cap, fail-open) wrapping a
  fast headless `claude -p` judgment call.
- Extensible `checklist.yaml` (61 gatekeepers: universal + backend + frontend), read
  and filtered at runtime; edit the YAML to add/remove/reweight without touching code.
- Marker-gated conditions so each check fires only in its context: `data_access` (EF/ORM/SQL),
  `external_call` (outbound HttpClient/REST), `blocking_async` (`.Result`/`.Wait()`),
  `di_registration`, `cors_config`, `client_storage` (localStorage/cookie), `rxjs` (Angular) —
  on top of `new_dependency` / `concurrency` / `cache` / `public_api` / `cloud_deploy`.
  Added API-contract (DTO-not-entity, status codes, bounded pagination, mass-assignment),
  data-access (query efficiency, transactions), resilience (sync-over-async, outbound-call
  resilience, CORS, DI lifetime), and Angular/RxJS + client-token-storage gatekeepers.
- `strict` (deny on block-severity failure) and `advisory` (warn-only) modes.
- `ask` path for dependency upgrades — only the user approves a new/bumped package.
- Commands: `/heimdall-on [strict|advisory]`, `/heimdall-off`, `/heimdall-status`.
- Tuning via `HEIMDALL_MODEL`, `HEIMDALL_TIMEOUT`, `HEIMDALL_DISABLE`, and
  `.heimdallignore`.
- `RESEARCH_FINDINGS.md` documents the Phase 0 survey and the hook-mechanism decision.
