# EnergyBaseline Security Threat Model & Privacy Architecture

## 1. Offline-First & Zero-Telemetry Guarantee
- **No Cloud / No Telemetry (G-10):** Zero outbound telemetry, analytics, or LLM API calls.
- **No Localhost HTTP Server (ARC-7):** Communication between the Tauri 2 shell and Python sidecar occurs strictly via NDJSON over OS stdin/stdout pipes.

## 2. Threat Surfaces & Mitigations

| Threat Vector | Mitigation | Implementation |
|---|---|---|
| **Malicious IPC / Unauthorized Command Invocation** | Compile-time RPC method allowlist (`SCR-7`), 1 MiB NDJSON frame cap (`IPC-1`), explicit non-wildcard Tauri capability ACL (`ARC-1`), CSP blocks inline scripts and style elements; inline style attributes are narrowly scoped and documented below (`ARC-2`). | `src-tauri/src/lib.rs`, `src-tauri/capabilities/main.json`, `src-tauri/tauri.conf.json` |
| **SQL Injection / Destructive External DB Queries** | `sqlglot.parse` AST validation + lexical guard allowing single-statement `SELECT`/`WITH...SELECT`/`UNION`/`INTERSECT`/`EXCEPT` only; rejects stacked `;`, DDL/DML, `SELECT INTO`, `xp_cmdshell`, `LOAD_FILE`, `INTO OUTFILE`, `COPY`, `ATTACH`, `PRAGMA`. | `sidecar/energybaseline/sql/guard.py`, `src/engine/sqlGuard.ts` |
| **Credential Leakage** | External DB credentials reside exclusively in Windows Credential Manager/DPAPI (`keyring`) and are masked in all logs (`mask_url_credentials`) and excluded from `.ebproj` archives and reports. | `sidecar/energybaseline/config/settings.py`, `src/engine/report.ts` |
| **Untrusted Model Artifact Deserialization** | Parametric baselines export JSON coefficients/equations; non-parametric artifacts require SHA-256 verification before loading and warn when imported from external `.ebproj` containers (`PER-6`). | `src/engine/modeling.ts`, `src/engine/report.ts` |
| **Sidecar Process Orphan / Stdout Corruption** | Windows Job Object (`processGroup: true` / `KILL_ON_JOB_CLOSE`), stdin EOF graceful shutdown (`LIF-1`), stdout fd duplication isolating stray `print()` calls to stderr (`IPC-2`). | `sidecar/energybaseline/ipc/protocol.py`, `src-tauri/src/lib.rs` |

## 3. Inline Style Policy Residual Risk

The desktop CSP sets `style-src 'self'` and `style-src-elem 'self'`, so inline `<style>` blocks and non-self stylesheet elements are blocked. `style-src-attr 'unsafe-inline'` remains as a narrower exception because the UI currently uses data-driven React style attributes for chart sizing, virtualized table geometry, and VSG bars; removing the attribute exception outright would break those layouts. This exception does not permit inline scripts or inline style elements.

**Mitigation plan:** keep the exception confined to `style-src-attr` (never restore `'unsafe-inline'` to `style-src`); keep style values authored by fixed UI components and derived only from bounded layout/data values; migrate app-authored dynamic styles to CSS classes or a static stylesheet where practical; before removing the remaining exception, run the installed WebView2 UI with CSP violation capture and verify ECharts, virtualized tables, and VSG bars still render correctly. Do not accept untrusted CSS or HTML as a style source.
