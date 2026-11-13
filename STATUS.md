# Remediation status

Updated: 2026-11-13 (UTC)

## Phase ledger

| Phase | Scope | State | Commit | Tests | Notes |
|---|---|---|---|---|---|
| 0 | Repository hygiene, package-manager/lockfile consistency, and build bootstrap | Passed — `src-tauri/Cargo.lock` is tracked and CI enforces it with locked tests/builds on both Windows and Linux in run `43441331640`; bundle icons are present and configured. | `35cdc9b`, `6f07f0f`, `238eb2d`, `e7477c4`, `752240f`, `24e11ab`, `43dc5b6`, `3adbc47`, `dcc4772`, `ebf5025`, `e7842f4`, `10829e4`, `8e35aa6` | CI `43441331640`: committed Cargo.lock consumed by locked Rust tests/builds on Windows and Linux; npm lint, engine tests, frontend build, Python tests, and Tauri no-bundle path passed. The generated-lockfile bootstrap job is removed. | The npm lock includes platform-specific optional packages. The CI-only Tauri override clears the frozen-sidecar resource glob; private RPC handlers resolve the earlier duplicate macro issue. |
| 1 | Tauri and sidecar runtime | In progress — CI `43441331640` passes the Linux MockRuntime sidecar RPC round-trip/error/cancellation tests, Windows default Rust unit tests (including the Job Object crash-guard test), and the Windows frozen-sidecar/installer smoke. Phase 1/M-1 is **not accepted**: the required interactive Windows force-termination/orphan check is pending. The earlier `0xc0000139` was narrowed to executing the `tauri/test`-enabled Windows test binary; Windows tests pass with that feature disabled, while Linux executes the integration tests. The missing loader entrypoint itself remains unidentified. | `ac817c5`, `1eeebb3`, `ea7bce9`, `9983209`, `7f85578`, `a880d59`, `8e35aa6` | Local Python sidecar tests: 15 passed, 1 PyInstaller-only skip; parity checker: 25 methods. CI `43441331640`: Linux/Windows lint, engine/Python tests, locked Rust tests/builds, Tauri no-bundle build, and Windows PyInstaller handshake/EOF, NSIS install, resource/IPC smoke passed. Installer artifact `EnergyBaseline-Windows-NSIS-M1` (artifact `14044724915`) is available. | **Phase 1 closes runtime plumbing only, not the analysis path.** Analysis/model/statistics still run in frontend TypeScript; `analysis.run` and other non-bootstrap RPCs remain unimplemented. `sql.run_query` remains non-executing until its guard is hardened. Still required: manual Windows check in `docs/manual_windows_runtime_check.md`, which also verifies the installed shell can launch the configured resource path. IPC schema generation, restart/resume checkpoints, updater shutdown integration, and full DB-1..DB-11 migration/external-driver validation remain open. Do not start M0/data work. |
| 2 | Analytical validity | Not started | — | — | Phase 2 TypeScript analysis work may proceed in parallel with the pending manual M-1 test, but keep this row `Not started` until Phase 1 passes and P1 items are addressed. Do not start M0/data work before that gate. |
| 3 | Truthful statistics | Not started | — | — | — |
| 4 | Governance and integrity | Not started | — | — | — |
| 5 | Security | Not started | — | — | — |
| 6 | Persistence and `.ebproj` | Not started | — | — | Preserve backward compatibility where feasible; schema migration required for breaking changes. |
| 7 | Reporting | Not started | — | — | — |
| 8 | Regression and CI tests | Not started | — | — | M-1 CI covers the current cross-platform runtime/package gates; the broader requirement-level regression and end-to-end suite remains open. |
| 9 | Release evidence | Not started | — | — | — |
| 10 | Final acceptance gate | Not started | — | — | Do not claim acceptance while required platform builds, signing, or evidence remain unverified. |

## P1 review gate

| Review item | State | Evidence / remaining acceptance |
|---|---|---|
| P1 #1 — tracked Cargo lockfile | Addressed | `src-tauri/Cargo.lock` is committed; CI run `43441331640` used it with `--locked` for Windows and Linux tests/builds. |
| P1 #2 — Rust/Python RPC allowlist parity | Addressed | `scripts/check_rpc_allowlist.py` is part of CI and reports 25 matching methods in run `43441331640`. |
| P1 #5 — Windows shell-crash/orphan test | **Open** | `docs/manual_windows_runtime_check.md` has not been executed. A manual PASS must show every captured app/sidecar descendant gone within five seconds after force-terminating the verified desktop process. |
| P1 #7 — Rust sidecar RPC regression coverage | Automated coverage added | Linux CI exercises the bridge against the production Python protocol, JSON-RPC error preservation, and cancellation; Windows default Rust tests (including Job Object cleanup) pass. The `tauri/test`-enabled Windows test executable previously exited `0xc0000139` before tests; the exact loader entrypoint is unidentified, so MockRuntime integration tests remain Linux-only. |

## Finding ledger

The F-01–F-13 identifiers and their detailed acceptance criteria remain those in the original remediation specification. No finding is marked fixed until its implementation, regression test, and required phase gate have passed.

| Finding | State | Commit | Test | Notes |
|---|---|---|---|---|
| F-01 | Not started | — | — | Pending its specified phase and acceptance criteria. |
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
| STAT-01 | Not started | — | — | Time-ordered validation, forward folds, and training-fold-only preprocessing/selection. |
| STAT-02 | Not started | — | — | Calibration thresholds need source, edition, interval, and domain qualification; do not universalize them. |
| STAT-03 | Not started | — | — | Replace proxy or hard-coded values presented as computed statistical metrics. |
| STAT-04 | Not started | — | — | Replace FNV-based values labeled SHA-256 with the claimed cryptographic digest. |
| STAT-05 | Not started | — | — | Preserve seeds; document method changes and bump `engine_version` when numeric outputs change. |
