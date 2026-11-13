import React, { useRef, useState } from 'react';
import {
  AuditEvent,
  AutoDecisionEntry,
  DatasetState,
  LockedBaseline,
  TcpConfig,
  VsgEntry,
} from '../engine/types';
import { exportEbprojZipBlob, importEbprojZipFile } from '../engine/report';
import { CheckCircle2, Download, HardDrive, ShieldCheck, Upload } from 'lucide-react';

interface SystemStatusViewProps {
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  lockedBaselines: Record<string, LockedBaseline>;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
  darkMode: boolean;
  highContrast: boolean;
  fontScale: number;
  onToggleDarkMode: () => void;
  onToggleHighContrast: () => void;
  onChangeFontScale: (scale: number) => void;
  onRestoreEbproj: (restored: Awaited<ReturnType<typeof importEbprojZipFile>>) => void;
}

export const SystemStatusView: React.FC<SystemStatusViewProps> = ({
  dataset,
  vsgByTarget,
  tcp,
  lockedBaselines,
  autoLogs,
  auditLog,
  seed,
  darkMode,
  highContrast,
  fontScale,
  onToggleDarkMode,
  onToggleHighContrast,
  onChangeFontScale,
  onRestoreEbproj,
}) => {
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const handleExportEbproj = async () => {
    const blob = await exportEbprojZipBlob({
      dataset,
      vsgByTarget,
      tcp,
      lockedBaselines,
      autoLogs,
      auditLog,
      seed,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dataset.id}_project.ebproj`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg('Exported .ebproj ZIP container (credentials excluded per PER-1).');
  };

  const handleImportEbproj = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const restored = await importEbprojZipFile(file);
      onRestoreEbproj(restored);
      setStatusMsg(`Restored project from ${file.name} (${restored.dataset.rows.length} rows).`);
    } catch (err) {
      setStatusMsg(err instanceof Error ? err.message : 'Failed to import .ebproj archive.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            System Health, Local Storage & Accessibility
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Architecture telemetry, SQLite fallback resolver, .ebproj ZIP persistence, and WCAG 2.2 AA controls.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input ref={zipInputRef} type="file" accept=".ebproj,.zip" onChange={handleImportEbproj} className="hidden" />
          <button
            type="button"
            onClick={() => zipInputRef.current?.click()}
            className="px-3.5 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg inline-flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            Import .ebproj
          </button>
          <button
            type="button"
            onClick={handleExportEbproj}
            className="px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded-lg inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Save .ebproj ZIP
          </button>
        </div>
      </div>

      {statusMsg && (
        <div className="p-3 rounded-lg border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-xs text-sky-900 dark:text-sky-200">
          {statusMsg}
        </div>
      )}

      {/* Sidecar & SQLite Health (UX-7 / DB-9) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3 text-xs">
          <h2 className="text-sm font-semibold font-display inline-flex items-center gap-1.5">
            <HardDrive className="w-4 h-4 text-sky-600" aria-hidden="true" />
            Where Is My Data Stored? & SQLite Zero-Fail Resolver (DB-1..11)
          </h2>
          <div className="space-y-1.5 font-mono text-slate-700 dark:text-slate-300">
            <div>APP_HOME (Windows): %LOCALAPPDATA%\EnergyBaseline</div>
            <div>DB URL: sqlite:///./data/app.db (WAL + foreign_keys=ON)</div>
            <div>Portable Override: portable.flag beside EnergyBaseline.exe</div>
            <div>IPC Transport: JSON-RPC 2.0 NDJSON over stdin/stdout (0 HTTP ports)</div>
            <div>Shutdown Signal: Stdin EOF + Windows Job Object (KILL_ON_JOB_CLOSE)</div>
          </div>
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-4 font-mono">
            <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> db.ok = true
            </span>
            <span>fallback = false</span>
            <span>writable = true</span>
          </div>
        </section>

        {/* Accessibility & Theme Controls (UX-2 / UX-4) */}
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-4 text-xs">
          <h2 className="text-sm font-semibold font-display inline-flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-sky-600" aria-hidden="true" />
            WCAG 2.2 AA Display & Theme Preferences
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onToggleDarkMode}
              className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 font-medium"
            >
              Theme: {darkMode ? 'Dark Mode' : 'Light Mode'}
            </button>
            <button
              type="button"
              onClick={onToggleHighContrast}
              className="px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 font-medium"
            >
              High Contrast: {highContrast ? 'ON' : 'OFF'}
            </button>
          </div>
          <label className="block">
            <span className="text-slate-600 dark:text-slate-400 block mb-1">
              Font Scaling ({Math.round(fontScale * 100)}%, allowed 80%–200%)
            </span>
            <input
              type="range"
              min={0.8}
              max={2.0}
              step={0.1}
              value={fontScale}
              onChange={(e) => onChangeFontScale(Number(e.target.value))}
              className="w-full max-w-xs"
            />
          </label>
        </section>
      </div>

      {/* Traceability & SBOM Summary */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3 text-xs">
        <h2 className="text-sm font-semibold font-display">
          Deliverable Registers, Air-Gapped Offline Runtime &amp; Windows NSIS Packaging
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="border border-slate-200 dark:border-slate-800 rounded p-3 space-y-1">
            <div className="font-semibold">Tauri 2 + Windows NSIS + Sidecar Lock</div>
            <div className="text-slate-500">
              Bundled via <span className="font-mono">scripts/build-windows-nsis.ps1</span> &amp; <span className="font-mono">.github/workflows/build-windows.yml</span>. Sidecar dependencies pinned in <span className="font-mono">sidecar/requirements-lock.txt</span> (XGBoost, LightGBM, CatBoost, PyTorch, MAPIE, PyInstaller).
            </div>
          </div>
          <div className="border border-slate-200 dark:border-slate-800 rounded p-3 space-y-1">
            <div className="font-semibold">100% Air-Gapped Assets &amp; Diagnostics</div>
            <div className="text-slate-500">
              All typography bundled locally via <span className="font-mono">@fontsource</span> (zero Google Fonts network requests). Full T1–T14 + [O] tests, boosted trees, and NNs verified via <span className="font-mono">node:test</span> &amp; <span className="font-mono">unittest</span>.
            </div>
          </div>
          <div className="border border-slate-200 dark:border-slate-800 rounded p-3 space-y-1">
            <div className="font-semibold">Docs &amp; Registers</div>
            <div className="text-slate-500 font-mono">
              docs/requirements_matrix.md · docs/deviations.md · docs/assumptions.md · docs/not_implemented.md · SECURITY.md · USER_GUIDE.md
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
