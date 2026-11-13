# Not-Implemented Register (Optional [O] / Deferred Features)

| ID | Feature | Priority | Status | Notes |
|---|---|---|---|---|
| NI-001 | Optional Deep Learning & Boosted Trees (`XGBoost`, `LightGBM`, `CatBoost`, `ResNet-MLP`, `Causal-TCN`, `N-BEATS`, `TFT`, `PatchTST`, `Informer`, `AE-Net`) | [O] | Implemented (TS Engine + Sidecar Lock) | Implemented natively in `src/engine/modeling.ts` (all gated honestly via NN Gate & Parameter Gate, with real forward inference via `SerializedModelPayload`); Python dependencies pinned in `sidecar/requirements-lock.txt`. |
| NI-002 | Optional Statistical Tests (`Dixon Q`, `MIC`, `Hoeffding D`, `Canova-Hansen`, `OCSB`, `Transfer Entropy`, `Hansen Instability`, `BOCPD`) + F5 Autoencoder & F6 Regime Rules | [O] | Implemented | Implemented and toggleable via `tcp.includeOptionalTests` in `src/engine/stats.ts` and `src/views/TcpView.tsx`. |
| NI-003 | Automated EDA HTML Attach (`ydata-profiling` / `sweetviz`) | [S] | Deferred to Python 3.11+ build | In-app interactive EDA Atlas (F1–F9) renders all charts via ECharts directly. |
| NI-004 | ONNX Runtime Consistency Export (`onnxruntime`) & Binary `.xlsx` Formula Workbook | [S] | Partial | Exact Excel formula strings (`=B0+B1*MAX(0,B2-18)...`) are exported per parametric model; binary `.onnx` graph serialization requires `skl2onnx`/`torch.onnx` in Python 3.11+. |
| NI-005 | Windows Authenticode Signing & Ed25519 Updater Server | [M] (Release CI) | Documented in CI / `SECURITY.md` | Windows NSIS + PyInstaller build pipeline added in `scripts/build-windows-nsis.ps1` and `.github/workflows/build-windows.yml`; code-signing requires Windows certificate secrets in CI. |
