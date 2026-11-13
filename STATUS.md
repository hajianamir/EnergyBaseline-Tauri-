# Remediation status

Updated: 2026-11-13 (UTC)

## Phase ledger

| Phase | Scope | State | Commit | Tests | Notes |
|---|---|---|---|---|---|
| 0 | Repository hygiene, package-manager/lockfile consistency, and build bootstrap | In progress — run `43416666367` passed Windows install/lint/engine/frontend build but failed Windows Python tests; Linux reached native Cargo build and failed because the configured sidecar resource glob is absent in CI. Remediation is in `24e11ab` and remains unverified. | `35cdc9b` (bootstrap), `6f07f0f` (metadata claims), `238eb2d`, `e7477c4`, and `24e11ab` (CI diagnostics) | Local clean `npm ci`, audit, lint, engine tests, Vite build, and Python tests: Pass. Linux CI frontend and Python steps: Pass; native Cargo build: Failed. Windows CI install, TypeScript lint/engine tests, and frontend build: Pass; Python sidecar tests: Failed. | npm lock regenerated cleanly with all TypeScript platform variants. CI adds a test-only Tauri config to clear the absent frozen-sidecar resource glob. Windows Python failure detail and updated Cargo build result are pending. Cargo.lock remains generated in CI, not yet committed. Do not start Phase 1 until both OS gates pass with checked-in locks. |
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
