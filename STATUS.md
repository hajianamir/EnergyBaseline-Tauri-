# Remediation status

Updated: 2026-11-13 (UTC)

## Phase ledger

| Phase | Scope | State | Commit | Tests | Notes |
|---|---|---|---|---|---|
| 0 | Repository hygiene, package-manager/lockfile consistency, and build bootstrap | Passed — both platform gates are green on run `43419993779`; bundle icons are present and configured, and the generated Cargo lockfile was consumed by both locked native builds. | `35cdc9b`, `6f07f0f`, `238eb2d`, `e7477c4`, `752240f`, `24e11ab`, `43dc5b6`, `3adbc47`, `dcc4772`, `ebf5025`, `e7842f4`, `10829e4` | Local clean `npm ci`, audit, lint, engine tests, Vite build, and all 9 Python tests: Pass. CI `43419993779`: generated/uploaded Cargo.lock; Windows and Linux lint, engine tests, frontend build, Python tests, `cargo build --release --locked`, and Tauri no-bundle build: Pass. | The npm lock includes platform-specific optional packages. The CI-only Tauri override clears the frozen-sidecar resource glob; private RPC handlers resolve the earlier duplicate macro issue. `Cargo.lock` remains generated and uploaded by the CI bootstrap job rather than checked in. |
| 1 | Tauri and sidecar runtime | In progress — Phase 0 gates passed; runtime process startup, IPC readiness/correlation, and shutdown behavior are being audited. | — | — | — |
| 2 | Analytical validity | Not started | — | — | — |
| 3 | Truthful statistics | Not started | — | — | — |
| 4 | Governance and integrity | Not started | — | — | — |
| 5 | Security | Not started | — | — | — |
| 6 | Persistence and `.ebproj` | Not started | — | — | Preserve backward compatibility where feasible; schema migration required for breaking changes. |
| 7 | Reporting | Not started | — | — | — |
| 8 | Regression and CI tests | Not started | — | — | Phase 0 CI bootstrap is limited to Phase 0 acceptance and does not close this phase. |
| 9 | Release evidence | Not started | — | — | — |
| 10 | Final acceptance gate | Not started | — | — | Do not claim acceptance while required platform builds, signing, or evidence remain unverified. |

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
