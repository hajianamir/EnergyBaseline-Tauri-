# EnergyBaseline User Guide

## Where Is My Data Stored?
EnergyBaseline is 100% offline and local-first:
- **Default Windows Location (`APP_HOME`):** `%LOCALAPPDATA%\EnergyBaseline\data\app.db` (SQLite in WAL mode).
- **Portable Mode:** Place a `portable.flag` file beside `EnergyBaseline.exe` to store data in `.\data\app.db`.
- **Fallback Ladder (Zero-Fail Boot):** If a configured external DB URL is unreachable, EnergyBaseline degrades cleanly to `APP_HOME\data\app.db`, then `%TEMP%\EnergyBaseline\data\app.db` (with a visible warning), and finally in-memory SQLite (with a persistent red banner).
- **Project Containers (`.ebproj`):** Self-contained ZIP archives containing `manifest.json` (dataset hash, VSG states, TCP policy, AUTO log, locked baselines, model cards) and cached data rows. **Credentials are never saved inside `.ebproj` files.**

## Mandatory Analytical Workflow
1. **Data & Column Setup:** Load CSV or a built-in synthetic ground-truth dataset; assign column roles, quantity types, units, availability (`known_in_advance` vs `observed_only`), sampling resolution, and baseline/reporting windows.
2. **Variable Selection Gate (VSG):** Review pre-test profiles and leakage flags per target, choose `force_include | candidate | analysis_only | exclude`, and accept the Candidate Pool before testing.
3. **Test Configuration & Policy (TCP):** Configure α, confidence level, multiple-testing correction (`BH`, `Holm`, `Bonferroni`, `BY`), decision rule, expected signs, and Action Policy; lock pre-registration.
4. **Diagnostics & EDA Atlas:** Inspect T1–T14 test outcomes, use **What-If Re-evaluation** to inspect α/correction sensitivity without recompute, and explore F1–F9 EDA charts and Causal M&V balance (T14).
5. **Modeling, Top-5 & Lock:** Compare parametric, tree, kernel, and neural-network models with blocked CV + purge gap, inspect KaTeX formulas and Conformal UQ calibration, and **Lock Baseline** per target.
6. **Prediction & Drift Monitoring:** Unlocked per target after baseline lock. Run File, Guarded SQL, or Manual predictions, inspect `Deviation = Actual − Baseline`, and monitor PSI/KS/CUSUM/EWMA/Page-Hinkley drift traffic lights.
