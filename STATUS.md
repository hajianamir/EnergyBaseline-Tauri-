# Remediation status

Updated: 2026-11-13 (UTC)

## Phase ledger

| Phase | Scope | State | Commit | Tests | Notes |
|---|---|---|---|---|---|
| 0 | Repository hygiene, package-manager/lockfile consistency, and build bootstrap | Passed — `src-tauri/Cargo.lock` is tracked and CI enforces locked tests/builds on Windows and Linux; latest completed CI is run `43459781814`. Bundle icons are present and configured. | `35cdc9b`, `6f07f0f`, `238eb2d`, `e7477c4`, `752240f`, `24e11ab`, `43dc5b6`, `3adbc47`, `dcc4772`, `ebf5025`, `e7842f4`, `10829e4`, `8e35aa6` | CI `43459781814`: committed Cargo.lock consumed by locked Rust tests/builds on Windows and Linux; npm lint, engine tests, frontend build, Python tests, and Tauri no-bundle path passed. The generated-lockfile bootstrap job is removed. | The npm lock includes platform-specific optional packages. The CI-only Tauri override clears the frozen-sidecar resource glob; private RPC handlers resolve the earlier duplicate macro issue. |
| 1 | Tauri and sidecar runtime | In progress — latest CI `43459781814` runs Linux MockRuntime RPC loop tests, including the updated `rpc_cancel` dispatch assertion, while Windows runs **non-integration Rust unit tests only** (including the Job Object crash-guard test). Windows does not run the MockRuntime RPC loop tests: the `tauri/test`-enabled Windows test binary exited `0xc0000139` before tests in run `43434508275`; the missing loader entry point is still unidentified and tracked as F-14. Phase 1/M-1 is **not accepted**: the required interactive Windows force-termination/orphan check is pending. | `ac817c5`, `1eeebb3`, `ea7bce9`, `9983209`, `7f85578`, `a880d59`, `8e35aa6`, `b44df14` | Local Python sidecar tests: 16 passed, 1 PyInstaller-only skip; parity checker: 25 business methods. CI `43459781814`: Linux/Windows lint, engine/Python tests, locked Rust tests/builds, Tauri no-bundle build, and Windows PyInstaller handshake/EOF, NSIS install, resource/IPC smoke all passed. Installer artifact `EnergyBaseline-Windows-NSIS-M1` (artifact `14055932314`) is available. | **Phase 1 closes runtime plumbing only, not the analysis path.** Analysis/model/statistics still run in frontend TypeScript; `analysis.run` remains an explicit stub and `sql.run_query` is non-executing. The sidecar uses Rust `ShellExt::shell().command(...).spawn()` with its resolved executable path; the webview `shell:allow-spawn` permission was unused for this path and has been removed. The pending manual Windows check in `docs/manual_windows_runtime_check.md` must verify installed readiness and the actual force-termination/orphan behavior; CI package smoke is not a substitute. IPC schema generation, restart/resume checkpoints, updater shutdown integration, and full DB-1..DB-11 migration/external-driver validation remain open. Do not start Phase 2, Phase 3, or Phase 6 before their gates; do not start M0/data work. |
| 2 | Analytical validity | Not started | — | — | Do not begin until Phase 1 is accepted and the P1 gates are addressed. |
| 3 | Truthful statistics | Not started | — | — | Do not begin before its planned gate; Phase 2 remains not started. |
| 4 | Governance and integrity | Not started | — | — | — |
| 5 | Security | Not started | — | — | — |
| 6 | Persistence and `.ebproj` | Not started | — | — | Do not begin before its planned gate. Preserve backward compatibility where feasible; schema migration is required for breaking changes. |
| 7 | Reporting | Not started | — | — | — |
| 8 | Regression and CI tests | Not started | — | — | M-1 CI covers the current cross-platform runtime/package gates; the broader requirement-level regression and end-to-end suite remains open. |
| 9 | Release evidence | Not started | — | — | — |
| 10 | Final acceptance gate | Not started | — | — | Do not claim acceptance while required platform builds, signing, or evidence remain unverified. |

## P1 review gate

| Review item | State | Evidence / remaining acceptance |
|---|---|---|
| P1 #1 — tracked Cargo lockfile | Addressed | `src-tauri/Cargo.lock` is committed; CI run `43459781814` used it with `--locked` for Windows and Linux tests/builds. |
| P1 #2 — Rust/Python RPC allowlist parity | Addressed | `scripts/check_rpc_allowlist.py` passed in CI run `43459781814` and reports 25 matching business methods. `rpc_cancel` is separately control-allowlisted; its production-dispatch regression passed in the Python tests and Linux MockRuntime cancellation integration test. |
| P1 #5 — Windows shell-crash/orphan test | **Open** | `docs/manual_windows_runtime_check.md` has not been executed. It now points to the latest installer artifact `14055932314` from run `43459781814`. A manual PASS must show every captured app/sidecar descendant gone within five seconds after force-terminating the verified desktop process. |
| P1 #7 — Rust sidecar RPC regression coverage | Automated coverage added, platform-limited | CI run `43459781814` passes the Linux MockRuntime bridge against the production Python protocol, JSON-RPC error preservation, and cancellation; the fixture asserts the separately allowlisted `rpc_cancel` reaches production `dispatch_rpc`. Windows CI runs non-integration Rust unit tests only (including Job Object cleanup), not the MockRuntime RPC loop tests. The `tauri/test`-enabled Windows test executable previously exited `0xc0000139` before tests; the exact loader entry point remains unidentified (F-14). |

## Finding ledger

The F-01–F-13 identifiers and their detailed acceptance criteria remain those in the original remediation specification. No finding is marked fixed until its implementation, regression test, and required phase gate have passed.

| Finding | State | Commit | Test | Notes |
|---|---|---|---|---|
| F-01 | Open — acceptance pending | — | Required manual Windows force-termination/orphan check not run | Do not mark fixed/accepted until the installed desktop test passes. |
| F-02 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-03 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-04 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-05 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-06 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-07 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-08 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-09 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-10 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-11 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-12 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-13 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-14 | Open — unresolved Windows test-loader failure | — | Windows `tauri/test`-enabled Rust test executable exited `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`) before running tests in CI run `43434508275`; Windows non-integration tests pass | The Actions annotation confirms the loader status but does not identify the missing symbol or module. An opt-in Windows `workflow_dispatch` diagnostic (`diagnose_tauri_test_loader=true`) records the test binary's `dumpbin /dependents` and `/imports`, launch exit code, and recent Application Error events; it has not been run. Dispatch was attempted but GitHub returned HTTP 403 `Resource not accessible by integration`, so the diagnostic needs an authorized workflow-dispatch action or manual GitHub trigger. Keep Linux MockRuntime RPC loop tests and Windows non-integration tests clearly distinguished. This finding is separate from, and does not satisfy, the pending installed-desktop crash/orphan test. |
| STAT-01 | Not started | — | — | Time-ordered validation, forward folds, and training-fold-only preprocessing/selection. |
| STAT-02 | Not started | — | — | Calibration thresholds need source, edition, interval, and domain qualification; do not universalize them. |
| STAT-03 | Not started | — | — | Replace proxy or hard-coded values presented as computed statistical metrics. |
| STAT-04 | Not started | — | — | Replace FNV-based values labeled SHA-256 with the claimed cryptographic digest. |
| STAT-05 | Not started | — | — | Preserve seeds; document method changes and bump `engine_version` when numeric outputs change. |
