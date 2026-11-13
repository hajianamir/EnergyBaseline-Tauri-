# Remediation status

Updated: 2026-11-13 (UTC)

**State legend:** Phases are `Passed` only with automated and physical evidence; `Started — acceptance gated on Phase 1` means implementation/tests are committed but physical acceptance remains; `In progress` means implementation has started but regression tests are not yet committed; `Not started` means untouched. Findings are `Fixed — regression-test-only` only after implementation/tests pass CI, then remain physical-acceptance pending; `In progress` means tests are not yet committed. Phase 10 remains `Open — acceptance pending` until the final physical record exists.

**Wave sequencing:** The active mission supersedes the older Phase 1 note below only for starting Wave 1 Phases 2, 5, and 6. Phase 3 and 4 wait for committed Wave 1 regression tests; Phases 7 and 8 wait for committed Wave 2 tests. Phase 1, F-01, F-14, and Phase 10 remain open for their required acceptance evidence.

## Phase ledger

| Phase | Scope | State | Commit | Tests | Notes |
|---|---|---|---|---|---|
| 0 | Repository hygiene, package-manager/lockfile consistency, and build bootstrap | Passed — `src-tauri/Cargo.lock` is tracked and CI enforces locked tests/builds on Windows and Linux; latest completed CI is run `43463729769`. Bundle icons are present and configured. | `35cdc9b`, `6f07f0f`, `238eb2d`, `e7477c4`, `752240f`, `24e11ab`, `43dc5b6`, `3adbc47`, `dcc4772`, `ebf5025`, `e7842f4`, `10829e4`, `8e35aa6`, `ca5382e` | CI `43463729769`: committed Cargo.lock consumed by locked Rust tests/builds on Windows and Linux; npm lint, engine tests, frontend build, Python tests, and Tauri no-bundle path passed. The generated-lockfile bootstrap job is removed. | The npm lock includes platform-specific optional packages. Both workflows now explicitly set the Node cache dependency path to the root `package-lock.json`; the CI-only Tauri override clears the frozen-sidecar resource glob; private RPC handlers resolve the earlier duplicate macro issue. |
| 1 | Tauri and sidecar runtime | In progress — latest CI `43463729769` runs Linux MockRuntime RPC loop tests, including the updated `rpc_cancel` dispatch assertion, while Windows runs **non-integration Rust unit tests only** (including the Job Object crash-guard test). Windows does not run the MockRuntime RPC loop tests: the `tauri/test`-enabled Windows test binary exited `0xc0000139` before tests in run `43434508275`; the missing loader entry point is still unidentified and tracked as F-14. Phase 1/M-1 is **not accepted**: the required interactive Windows force-termination/orphan check is pending. | `ac817c5`, `1eeebb3`, `ea7bce9`, `9983209`, `7f85578`, `a880d59`, `8e35aa6`, `b44df14` | Local Python sidecar tests: 16 passed, 1 PyInstaller-only skip; parity checker: 25 business methods. CI `43463729769`: Linux/Windows lint, engine/Python tests, locked Rust tests/builds, Tauri no-bundle build, and Windows PyInstaller handshake/EOF, NSIS install, resource/IPC smoke all passed. Installer artifact `EnergyBaseline-Windows-NSIS-M1` (artifact `14057359462`) is available. | **Phase 1 closes runtime plumbing only, not the analysis path.** Analysis/model/statistics still run in frontend TypeScript; `analysis.run` remains an explicit stub and `sql.run_query` is non-executing. The sidecar uses Rust `ShellExt::shell().command(...).spawn()` with its resolved executable path; the webview `shell:allow-spawn` permission was unused for this path and has been removed. The pending manual Windows check in `docs/manual_windows_runtime_check.md` must verify installed readiness and the actual force-termination/orphan behavior; CI package smoke is not a substitute. IPC schema generation, restart/resume checkpoints, updater shutdown integration, and full DB-1..DB-11 migration/external-driver validation remain open. Do not start Phase 2, Phase 3, or Phase 6 before their gates; do not start M0/data work. |
| 2 | Analytical validity | In progress | `2a0a69c` (F-03) | F-03 CI run `43473845466` passed; F-13 is still uncommitted (20 full-suite tests pass locally). | Phase 2 remains in progress until F-13 tests are committed and CI passes; physical acceptance is still required before Passed. |
| 3 | Truthful statistics | Not started | — | — | Wave 2 starts only after Wave 1 regression tests are committed. |
| 4 | Governance and integrity | Not started | — | — | Wave 2 starts after Phase 2/3 regression tests are committed. |
| 5 | Security | Not started | — | — | Wave 1.2 follows committed Phase 2 tests; physical acceptance remains gated. |
| 6 | Persistence and `.ebproj` | Not started | — | — | Wave 1.3; implement sidecar handlers/tests only, with no frontend persistence before Phase 1 acceptance. |
| 7 | Reporting | Not started | — | — | Wave 3 starts only after Wave 2 regression tests are committed. |
| 8 | Regression and CI tests | Not started | — | — | Wave 3 follows Wave 2; installed-Windows E2E does not replace physical acceptance. |
| 9 | Release evidence | Not started | — | — | — |
| 10 | Final acceptance gate | Open — acceptance pending | — | — | `docs/physical_acceptance_plan.md` is the gated single-session Windows plan; retain physical records for every phase before claiming completion. |

## P1 review gate

| Review item | State | Evidence / remaining acceptance |
|---|---|---|
| P1 #1 — tracked Cargo lockfile | Addressed | `src-tauri/Cargo.lock` is committed; CI run `43463729769` used it with `--locked` for Windows and Linux tests/builds. |
| P1 #2 — Rust/Python RPC allowlist parity | Addressed | `scripts/check_rpc_allowlist.py` passed in CI run `43463729769` and reports 25 matching business methods. `rpc_cancel` is separately control-allowlisted; its production-dispatch regression passed in the Python tests and Linux MockRuntime cancellation integration test. |
| P1 #5 — Windows shell-crash/orphan test | **Open** | `docs/manual_windows_runtime_check.md` has not been executed. It now points to the latest installer artifact `14057359462` from run `43463729769`. A manual PASS must show every captured app/sidecar descendant gone within five seconds after force-terminating the verified desktop process. |
| P1 #7 — Rust sidecar RPC regression coverage | Automated coverage added, platform-limited | CI run `43463729769` passes the Linux MockRuntime bridge against the production Python protocol, JSON-RPC error preservation, and cancellation; the fixture asserts the separately allowlisted `rpc_cancel` reaches production `dispatch_rpc`. Windows CI runs non-integration Rust unit tests only (including Job Object cleanup), not the MockRuntime RPC loop tests. The `tauri/test`-enabled Windows test executable previously exited `0xc0000139` before tests; the exact loader entry point remains unidentified (F-14). |

## Finding ledger

The F-01–F-13 identifiers and their detailed acceptance criteria remain those in the original remediation specification. No finding is marked fixed until its implementation, regression test, and required phase gate have passed.

| Finding | State | Commit | Test | Notes |
|---|---|---|---|---|
| F-01 | Open — acceptance pending | — | Required manual Windows force-termination/orphan check not run | Do not mark fixed/accepted until the installed desktop test passes. |
| F-02 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-03 | Fixed — regression-test-only | `2a0a69c` | F-03-only engine suite 15/15; lint/build passed; CI run `43473845466` passed. | Physical Windows acceptance remains pending; Phase 2 is not Passed. |
| F-04 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-05 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-06 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-07 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-08 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-09 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-10 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-11 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-12 | Not started | — | — | Pending its specified phase and acceptance criteria. |
| F-13 | In progress | — | `npm run test:engine` (20/20), `npm run lint`, `npm run build`, and `git diff --check` pass locally; commit and CI pending. | Phase 2 multivariate VIF, approximate-statistic labels, Granger, TWFE DiD, and corrected Mann–Kendall. |
| F-14 | Open — unresolved Windows test-loader failure | — | Windows `tauri/test`-enabled Rust test executable exited `0xc0000139` (`STATUS_ENTRYPOINT_NOT_FOUND`) before running tests in CI run `43434508275`; Windows non-integration tests pass | The Actions annotation confirms the loader status but does not identify the missing symbol or module. An opt-in Windows `workflow_dispatch` diagnostic (`diagnose_tauri_test_loader=true`) records the test binary's `dumpbin /dependents` and `/imports`, launch exit code, and recent Application Error events; it has not been run. Dispatch was attempted but GitHub returned HTTP 403 `Resource not accessible by integration`, so the diagnostic needs an authorized workflow-dispatch action or manual GitHub trigger. Keep Linux MockRuntime RPC loop tests and Windows non-integration tests clearly distinguished. This finding is separate from, and does not satisfy, the pending installed-desktop crash/orphan test. |
| STAT-01 | Not started | — | — | Time-ordered validation, forward folds, and training-fold-only preprocessing/selection. |
| STAT-02 | Not started | — | — | Calibration thresholds need source, edition, interval, and domain qualification; do not universalize them. |
| STAT-03 | Not started | — | — | Replace proxy or hard-coded values presented as computed statistical metrics. |
| STAT-04 | Not started | — | — | Replace FNV-based values labeled SHA-256 with the claimed cryptographic digest. |
| STAT-05 | Not started | — | — | Preserve seeds; document method changes and bump `engine_version` when numeric outputs change. |
