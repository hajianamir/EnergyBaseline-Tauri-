# EnergyBaseline Security Threat Model & Privacy Architecture

## 1. Offline-First & Zero-Telemetry Guarantee
- **No Cloud / No Telemetry (G-10):** Zero outbound telemetry, analytics, or LLM API calls.
- **No Localhost HTTP Server (ARC-7):** Communication between the Tauri 2 shell and Python sidecar occurs strictly via NDJSON over OS stdin/stdout pipes.

## 2. Threat Surfaces & Mitigations

| Threat Vector | Mitigation | Implementation |
|---|---|---|
| **Malicious IPC / Unauthorized Command Invocation** | Compile-time RPC method allowlist (`SCR-7`), 1 MiB NDJSON frame cap (`IPC-1`), explicit non-wildcard Tauri capability ACL (`ARC-1`), strict CSP (`ARC-2`). | `src-tauri/src/lib.rs`, `src-tauri/capabilities/main.json`, `src-tauri/tauri.conf.json` |
| **SQL Injection / Destructive External DB Queries** | `sqlglot.parse` AST validation + lexical guard allowing single-statement `SELECT`/`WITH...SELECT`/`UNION`/`INTERSECT`/`EXCEPT` only; rejects stacked `;`, DDL/DML, `SELECT INTO`, `xp_cmdshell`, `LOAD_FILE`, `INTO OUTFILE`, `COPY`, `ATTACH`, `PRAGMA`. | `sidecar/energybaseline/sql/guard.py`, `src/engine/sqlGuard.ts` |
| **Credential Leakage** | External DB credentials reside exclusively in Windows Credential Manager/DPAPI (`keyring`) and are masked in all logs (`mask_url_credentials`) and excluded from `.ebproj` archives and reports. | `sidecar/energybaseline/config/settings.py`, `src/engine/report.ts` |
| **Untrusted Model Artifact Deserialization** | Parametric baselines export JSON coefficients/equations; non-parametric artifacts require SHA-256 verification before loading and warn when imported from external `.ebproj` containers (`PER-6`). | `src/engine/modeling.ts`, `src/engine/report.ts` |
| **Sidecar Process Orphan / Stdout Corruption** | Windows Job Object (`processGroup: true` / `KILL_ON_JOB_CLOSE`), stdin EOF graceful shutdown (`LIF-1`), stdout fd duplication isolating stray `print()` calls to stderr (`IPC-2`). | `sidecar/energybaseline/ipc/protocol.py`, `src-tauri/src/lib.rs` |
