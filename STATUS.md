# Remediation status

Updated: 2026-11-13 (UTC)

## Phase ledger

| Phase | Scope | State | Commit | Tests | Notes |
|---|---|---|---|---|---|
| 0 | Repository hygiene, package-manager/lockfile consistency, and build bootstrap | In progress — run `43417791078`: Windows failed only `test_no_env_uses_app_home` because it compared short/long Windows temp paths; Linux failed on duplicate Tauri command-macro symbols. Fixes `3adbc47` and `dcc4772` are committed but need CI validation. | `35cdc9b`, `6f07f0f`, `238eb2d`, `e7477c4`, `752240f`, `24e11ab`, `43dc5b6`, `3adbc47`, `dcc4772` | Local clean `npm ci`, audit, lint, engine tests, Vite build, and all 9 Python tests: Pass. Linux CI frontend and Python steps: Pass; native Cargo build: Failed (duplicate command macros). Windows CI install/lint/engine/frontend: Pass; Python test failure was the path assertion described above. | `package-lock.json` now records all platform variants. CI overrides Tauri bundle resources for no-bundle compile. The Windows test compares resolved paths; RPC commands are private to the Tauri shell. Cargo.lock has been generated in CI but is not committed; extraction and validation remain pending. Phase 1 remains blocked. |
| 1 | Tauri and sidecar runtime | Blocked by Phase 0 gate | — | — | — |
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
