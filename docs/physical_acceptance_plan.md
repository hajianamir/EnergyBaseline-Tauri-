SINGLE-SESSION PHYSICAL ACCEPTANCE
==================================

**Status:** Plan only. Do not execute until the release gates below are satisfied.

Environment: physical Windows 10 or 11 x64, normal interactive desktop session, disposable user profile, no other EnergyBaseline instances.

## Inputs and evidence

- Installer artifact from the **final accepted commit**. Record its GitHub Actions run, package-windows artifact ID, file name, byte size, and SHA-256. Do not use an installer downloaded from the F-14 diagnostic run; its diagnostic artifact is separate from the installer.
- Full transcript: Windows edition/version/build and architecture, desktop session/profile, startup time, every PASS/FAIL line, captured process IDs and parent IDs, measured elapsed times, installer artifact ID, and exact commit hash. Retain screenshots or command output for observations that cannot be reconstructed from the transcript. Redact usernames and other sensitive paths.
- Record the application version and whether Windows reports the installer as signed. An unsigned installer is expected; note the status but do not fail solely because it is unsigned.

### Release gates — do not run early

This single-session plan is the only permitted supersession of the separate Phase 1 crash/orphan check. Otherwise, Phase 1 and F-01 must first have a separately recorded PASS per `docs/manual_windows_runtime_check.md`. A combined run must explicitly say it supersedes that check, use the final accepted commit's Windows installer (artifact `14057359462` or newer), and preserve the same process-tree evidence and pass criteria from that manual check.

Before execution:

1. The final accepted source commit must have green required CI, including the Windows package-windows installer job. The installer must be built from that exact commit.
2. All applicable phases must have committed, passing regression tests and CI evidence. In the ledger, implementation with committed automated evidence but no physical acceptance remains **Started — acceptance gated on Phase 1**; the phrase **Fixed — regression-test-only** is reserved for findings, not phase states.
3. F-01 through F-14 must each be **Fixed — regression-test-only** or have its explicit acceptance gate closed with evidence. In particular, F-14 requires an opt-in `workflow_dispatch` run with `diagnose_tauri_test_loader: true` and inspection of its diagnostic output; no speculative loader workaround is a substitute.
4. Phase 5 security and Phase 6 persistence regression suites must pass on the final source tree.
5. Phase 1, F-01, Phase 10, and any other acceptance-pending state must not be inferred from CI alone. Do not mark any phase **Passed** until its required physical evidence has been recorded. Phase 10 requires physical acceptance records for all phases.

Do not run this plan merely because CI produced an installer. Do not run it until all gates above are met, or until the run is explicitly approved as the combined Phase 1/Phase 10 supersession.

## Single-session transcript header

```text
Date/time (UTC):
Operator:
Windows edition / version / build / architecture:
Interactive desktop session confirmed (yes/no):
Disposable profile confirmed (yes/no):
Other EnergyBaseline instances confirmed absent (yes/no):
Final source commit:
CI run URL / run ID:
package-windows installer artifact ID:
Installer file name / byte size / SHA-256:
Signature status (unsigned is expected; record only):
Application version:
Session log path (redacted):
```

## Steps (run all steps in one session, in order)

For every numbered step, record `PASS` or `FAIL`, a timestamp, the observation, and evidence location. A blocked or unrecorded step is not a pass.

1. **Clean installer install.** Install the recorded final-commit artifact in the disposable profile. Record the installer size and signature status. Unsigned is expected and is not itself a failure. Confirm the install completes without a prior EnergyBaseline installation or process.
2. **Launch and sidecar readiness.** Launch the installed app from the normal desktop. Record launch-to-window time and launch-to-Ready time. Confirm the sidecar reaches Ready within 10 seconds; capture the visible Ready state and relevant non-sensitive application log lines.
3. **Built-in dataset integrity.** Load the built-in synthetic `energy_mv` dataset. Record its displayed row count and SHA-256. Independently calculate SHA-256 from the canonical dataset bytes used by the application, and confirm both the independent result and the value shown in the UI match. Record the exact hashing input/canonicalization used.
4. **VSG conflict rejection.** Accept the VSG Candidate Pool. Attempt `force_include` on the known conflicting column `main_meter_proxy_kwh`. Confirm the UI rejects the change and the application/audit log records the rejection; capture both.
5. **TCP preregistration and post-lock change.** Lock the TCP with pre-registered settings. Attempt a post-lock configuration change (for example, change alpha). Confirm `postHocModified = true` and that the resulting report identifies `post_hoc` provenance.
6. **Diagnostics through the sidecar.** Run diagnostics. Confirm T1–T14 are executed by the Phase 3 sidecar path and retain the request/response or other verifiable sidecar evidence. Confirm any `approximate: true` labels are visible in the UI. Record any test that is correctly unavailable because the data do not satisfy its documented design prerequisites; do not count an unavailable test as executed.
7. **Model training and cryptographic locks.** Train the model portfolio and lock a baseline. Lock a different model and compare the two artifact SHA-256 values. Confirm they differ and record both values and model IDs.
8. **Prediction and drift.** Run prediction/monitoring. Spot-check five rows by computing `Deviation = Actual − Baseline` from the on-screen values. Record row timestamps and calculations. Confirm a drift traffic-light state is displayed and record it.
9. **Complete `.ebproj` archive.** Export `.ebproj`. Inspect the ZIP contents and confirm `nonRoutineEvents`, monitoring snapshots, run history, and audit events are present. Record entry names, sizes, and the tool/command used for inspection without editing the archive.
10. **HTML escaping.** Add a dataset name containing `<script>` (for example, `<script>alert(1)</script>`), export the HTML report, and inspect the output. Confirm the user-controlled string is escaped as text and is not emitted as an executable script or unescaped markup.
11. **Graceful close.** Close the application normally. Confirm the app and sidecar exit and that no orphaned sidecar process remains. Record captured PIDs, parent PIDs, and observation time.
12. **Persistence restore.** Reopen the app. Confirm the previous workspace is restored from persistence, including the relevant dataset/run state. Record the visible restoration evidence.
13. **Forced termination and process-tree cleanup.** Follow the process identity checks, recursive process-tree capture, and PowerShell `Stop-Process` procedure in `docs/manual_windows_runtime_check.md` without weakening it. Verify exactly one test sidecar and its `EnergyBaseline.exe` parent; capture names, PIDs, parent PIDs, and executable paths; force-terminate only the verified app PID. Confirm every captured app/sidecar descendant exits within five seconds and no `energybaseline_sidecar.exe` remains. Record the target PID, captured descendant PIDs, command output, termination timestamp, and measured time to zero descendants. This step preserves the existing Phase 1 evidence requirement; CI package smoke is not a substitute.
14. **Audit-chain verification after forced exit.** Reopen the app after Step 13. Confirm the persisted audit trail hash chain verifies and that no tampered-archive warning or silent repair occurred. Record the result and the verification evidence.

## Acceptance record

```text
Step 1 — PASS/FAIL — evidence:
Step 2 — PASS/FAIL — evidence:
Step 3 — PASS/FAIL — evidence:
Step 4 — PASS/FAIL — evidence:
Step 5 — PASS/FAIL — evidence:
Step 6 — PASS/FAIL — evidence:
Step 7 — PASS/FAIL — evidence:
Step 8 — PASS/FAIL — evidence:
Step 9 — PASS/FAIL — evidence:
Step 10 — PASS/FAIL — evidence:
Step 11 — PASS/FAIL — evidence:
Step 12 — PASS/FAIL — evidence:
Step 13 — PASS/FAIL — evidence:
Step 14 — PASS/FAIL — evidence:

Overall result: PASS / FAIL / BLOCKED
Operator notes:
Evidence directory (redacted):
Exact installer artifact ID and final commit hash re-confirmed:
```

A step fails if its required observation is absent, contradicts the expected behavior, or cannot be tied to the recorded final commit/artifact. Do not infer success from CI alone. Any failed or blocked step leaves the corresponding phase/finding open and unaccepted; rerun only after documenting the cause and fixing the implementation or test setup.
