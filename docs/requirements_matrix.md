# EnergyBaseline Requirements Traceability Matrix (v5.2)

| ID | Priority | Description | Code Implementation | Automated / Manual Verification | Status |
|---|---|---|---|---|---|
| G-1..G-11 | [M] | Offline Tauri 2 + Python sidecar, no HTTP, English + i18n-ready, no LLM narrative | `src-tauri/src/lib.rs`, `sidecar/energybaseline/main.py`, `src/i18n/index.ts`, `src/engine/report.ts` | `test_sidecar.py`, `engine.test.ts` | Implemented |
| ARC-1..ARC-7 | [M] | Explicit capability ACL, strict CSP, allowlisted RPC, no localhost HTTP | `src-tauri/capabilities/main.json`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs` | Rust source audit & compile-time allowlist | Implemented (Rust build requires Windows/cargo toolchain) |
| IPC-1..IPC-10 | [M] | NDJSON 1 MiB cap, stdout fd isolation, hello/ready handshake, progress | `sidecar/energybaseline/ipc/protocol.py`, `src-tauri/src/lib.rs` | `TestSidecarIpc.test_handshake_stray_print_isolation_and_stdin_eof` | Passed |
| LIF-1..LIF-5 | [M] | Stdin EOF graceful shutdown, Job Object `processGroup`, crash resume | `src-tauri/src/lib.rs`, `sidecar/energybaseline/ipc/protocol.py` | `TestSidecarIpc` | Passed |
| DB-1..DB-11 | [M] | Single DB resolver, `APP_HOME` SQLite fallback ladder, WAL, online backup | `sidecar/energybaseline/config/settings.py` | `TestDbResolver` (6 tests incl. CI grep) | Passed |
| DAT-1..DAT-8 | [M] | Column roles/types/units/availability, DAT-3 refusal, no target fabrication, Action Policy | `src/engine/synthetic.ts`, `src/views/DataSetupView.tsx` | `engine.test.ts` (`DATA_REFUSED`) | Passed |
| PIPE-1..PIPE-3 | [M] | Mandatory VSG & TCP gates before inferential tests; Candidate Pool vs Selected Features | `src/App.tsx`, `src/views/VsgView.tsx`, `src/views/TcpView.tsx` | Playwright E2E + `engine.test.ts` | Passed |
| VSG-1..VSG-8 | [M] | 4 states per target, pre-test profile, presets, non-disableable integrity, provenance | `src/engine/stats.ts`, `src/views/VsgView.tsx` | `engine.test.ts` | Passed |
| MT-1..MT-5 | [M] | Independent per-target pipelines, derived seeds, MT-2 leakage rules | `src/engine/modeling.ts`, `src/engine/stats.ts` | `engine.test.ts` | Passed |
| AUTO-1..AUTO-6 | [M] | AUTO decisions logged with signals/rule, deterministic seed, Fast/Standard/Thorough | `src/engine/stats.ts`, `src/components/AutoInspectorDrawer.tsx` | `engine.test.ts` | Passed |
| TCP-1..TCP-13 | [M] | Global & per-test policy, what-if re-evaluation without recompute, sensitivity table, pre-reg lock | `src/engine/stats.ts`, `src/views/TcpView.tsx` | `engine.test.ts` | Passed |
| T1..T14 | [M] | Diagnostic test catalog, TC-4 stationarity matrix, TC-5 structural breaks, T12, T14 causal M&V | `src/engine/stats.ts`, `src/engine/modeling.ts`, `tests/reference/validate_custom_tests.R` | `engine.test.ts` + R reference script | Passed |
| CI-1..CI-3 | [M] | Circular block-bootstrap & Fisher/HAC CIs with method labels | `src/engine/stats.ts`, `src/engine/modeling.ts` | `engine.test.ts` | Passed |
| F1..F9 | [M] | EDA Atlas, Correlation Atlas, PCA, KMeans regimes + ARI, anomalies, TS mining, relevance, DQS | `src/engine/stats.ts`, `src/views/DiagnosticsEdaView.tsx` | `engine.test.ts` + ECharts UI | Passed |
| VAL-1..VAL-7 | [M] | Blocked K-Fold / Forward-Chaining, purge gap, collinearity pruning, untouched holdout | `src/engine/modeling.ts` | `engine.test.ts` | Passed |
| SC-1..SC-10 | [M] | Gates, 13-criteria scoring, ±20% rank stability, KaTeX formulas, global surrogates, lock + Model Card | `src/engine/modeling.ts`, `src/views/ModelingView.tsx` | `engine.test.ts` | Passed |
| UQ-1..UQ-5 | [M] | Conformal intervals (EnbPI/ACI-style), calibration report, Kupiec & Christoffersen T12 | `src/engine/modeling.ts`, `src/views/ModelingView.tsx` | `engine.test.ts` | Passed |
| PM-1..PM-7 | [M] | Per-target unlock, File/Guarded SQL/Manual prediction, deviation = actual - baseline, alerts | `src/engine/monitoring.ts`, `src/engine/sqlGuard.ts`, `src/views/MonitoringView.tsx` | `engine.test.ts` + `test_sidecar.py` | Passed |
| DR-1..DR-5 | [M] | Input drift (PSI/KS/Wasserstein), residual drift (CUSUM/EWMA/Page-Hinkley), traffic light | `src/engine/monitoring.ts`, `src/views/MonitoringView.tsx` | `engine.test.ts` | Passed |
| PER-1..PER-6 | [M] | `.ebproj` ZIP container import/export, online SQLite backup, no credentials | `src/engine/report.ts`, `sidecar/energybaseline/config/settings.py` | `test_sidecar.py` + UI `.ebproj` | Passed |
| REP-1..REP-5, RPT-1..RPT-7 | [M] | Single JSON report model, 8-part template, artifact-ID narrative check, Report Diff, Glossary | `src/engine/report.ts`, `src/views/ReportView.tsx` | `engine.test.ts` (`verifyReportNarrativeConsistency`) | Passed |
| UX-1..UX-11 | [M] | Guided stepper, ECharts, TanStack Table v9 + Virtual, Ctrl+K, Light/Dark + High Contrast + 80-200% font scale | `src/App.tsx`, `src/components/*`, `src/views/*` | Playwright browser verification | Passed |
