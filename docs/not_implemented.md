# Not-Implemented Register (Optional [O] / Deferred Features)

| ID | Feature | Priority | Status | Notes |
|---|---|---|---|---|
| NI-001 | Optional Deep Learning Transformers (`N-BEATS`, `TFT`, `PatchTST`, `Informer`) & `CatBoost` | [O] | Not Implemented | Portfolio ships Mean, Degree-Day, MLR, Ridge, Lasso/EN, 5P Change-Point, TOWT, Random Forest, ExtraTrees, GBM, RBF-SVR, MLP, Sequence GRU-TCN, and constrained NNLS Ensemble. |
| NI-002 | Optional Statistical Tests (`Dixon Q`, `MIC`, `Hoeffding D`, `OCSB/Canova-Hansen`, `Transfer Entropy`, `Hansen Instability`, `Bayesian Online Change-Point`) | [O] | Not Implemented | Core [M] test families T1–T14 are implemented; disabled or optional tests appear explicitly in the appendix. |
| NI-003 | Automated EDA HTML Attach (`ydata-profiling` / `sweetviz`) | [S] | Deferred to Python 3.11+ build | In-app interactive EDA Atlas (F1–F9) renders all charts via ECharts directly. |
| NI-004 | ONNX Runtime Consistency Export (`onnxruntime`) & Binary `.xlsx` Formula Workbook | [S] | Partial | Exact Excel formula strings (`=B0+B1*MAX(0,B2-18)...`) are exported per parametric model; binary `.onnx` graph serialization requires `skl2onnx`/`torch.onnx` in Python 3.11+. |
| NI-005 | Windows Authenticode Signing & Ed25519 Updater Server | [M] (Release CI) | Documented in CI / `SECURITY.md` | Requires Windows code-signing certificate secrets in GitHub Actions release pipeline. |
