import React, { useMemo, useRef, useState } from 'react';
import {
  DatasetState,
  InclusionState,
  TcpConfig,
  VariablePreTestProfile,
  VsgEntry,
} from '../engine/types';
import { validateVsgConflict } from '../engine/stats';
import { AlertTriangle, ArrowRight, CheckCircle2, Copy, Download, ShieldAlert, Upload } from 'lucide-react';

interface VsgViewProps {
  dataset: DatasetState;
  targets: string[];
  activeTarget: string;
  onSelectTarget: (target: string) => void;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  profilesByTarget: Record<string, VariablePreTestProfile[]>;
  tcp: TcpConfig;
  hasResultsYet: boolean;
  vsgGateAccepted: boolean;
  onUpdateVsgEntry: (target: string, colName: string, state: InclusionState) => void;
  onBulkUpdateVsg: (target: string, updates: Record<string, InclusionState>, label: string) => void;
  onCopySelection: (fromTarget: string, toTarget: string) => void;
  onImportPreset: (target: string, jsonText: string) => void;
  onAcceptAndLockGate: () => void;
}

export const VsgView: React.FC<VsgViewProps> = ({
  dataset,
  targets,
  activeTarget,
  onSelectTarget,
  vsgByTarget,
  profilesByTarget,
  tcp,
  hasResultsYet,
  vsgGateAccepted,
  onUpdateVsgEntry,
  onBulkUpdateVsg,
  onCopySelection,
  onImportPreset,
  onAcceptAndLockGate,
}) => {
  const presetInputRef = useRef<HTMLInputElement>(null);
  const [patternFilter, setPatternFilter] = useState('');
  const [presetMsg, setPresetMsg] = useState<string | null>(null);

  const entries = vsgByTarget[activeTarget] ?? {};
  const profiles = profilesByTarget[activeTarget] ?? [];

  const candidateCount = Object.values(entries).filter(
    (e) => e.state === 'candidate' || e.state === 'force_include'
  ).length;
  const analysisOnlyCount = Object.values(entries).filter((e) => e.state === 'analysis_only').length;
  const enabledFamilyCount = Object.values(tcp.families).filter((f) => f.enabled && f.phase === 'pre_model').length;
  const estimatedTests = (candidateCount + analysisOnlyCount + 1) * enabledFamilyCount;
  const conflicts = Object.values(entries).filter((e) => e.conflict !== null);

  const handleBulkSelectRole = (role: string, targetState: InclusionState) => {
    const updates: Record<string, InclusionState> = {};
    for (const col of dataset.columns) {
      if (col.role === role && col.name !== activeTarget && col.role !== 'target' && col.role !== 'time') {
        updates[col.name] = targetState;
      }
    }
    onBulkUpdateVsg(activeTarget, updates, `Bulk set role=${role} → ${targetState}`);
  };

  const handleInvert = () => {
    const updates: Record<string, InclusionState> = {};
    for (const col of dataset.columns) {
      if (col.name === activeTarget || col.role === 'target' || col.role === 'time') continue;
      const cur = entries[col.name]?.state ?? 'candidate';
      updates[col.name] = cur === 'candidate' || cur === 'force_include' ? 'exclude' : 'candidate';
    }
    onBulkUpdateVsg(activeTarget, updates, 'Inverted predictor inclusion');
  };

  const handleExportPreset = () => {
    const payload = {
      schema: 'energybaseline.vsg.preset.v1',
      target: activeTarget,
      exportedAt: new Date().toISOString(),
      states: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.state])),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vsg_preset_${activeTarget}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setPresetMsg(`Saved VSG preset for ${activeTarget}.`);
  };

  const filteredCols = useMemo(() => {
    const q = patternFilter.trim().toLowerCase();
    return dataset.columns.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [dataset.columns, patternFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Variable Selection Gate (VSG)
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Review and govern the Candidate Pool per target before any inferential test runs (PIPE-1 / VSG-1..8).
          </p>
        </div>

        <button
          type="button"
          onClick={onAcceptAndLockGate}
          disabled={candidateCount === 0}
          className="px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 disabled:opacity-40 text-white rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          {vsgGateAccepted ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              Gate Accepted · Proceed to TCP
            </>
          ) : (
            <>
              Accept & Lock Candidate Pool
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      {/* Multi-Target Switcher & Live Impact Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-2">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            Active Target Pipeline (MT-1)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onSelectTarget(t)}
                className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors ${
                  t === activeTarget
                    ? 'bg-sky-700 text-white font-semibold'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Candidate Pool defines analyzed & eligible variables; Selected Features are chosen later inside CV folds (PIPE-2).
          </p>
        </section>

        <section className="lg:col-span-2 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Live Impact Preview (VSG-3)
            </h2>
            <span className="text-xs font-mono text-slate-500">
              Provenance: {hasResultsYet ? 'post_hoc (results visible)' : 'pre_registered (pre-test)'}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs tabular-nums">
            <div>
              <div className="text-slate-500 dark:text-slate-400">Model Candidates</div>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-slate-100">{candidateCount}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Analysis-Only</div>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-slate-100">{analysisOnlyCount}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Est. Diagnostic Tests</div>
              <div className="text-lg font-bold font-mono text-slate-900 dark:text-slate-100">{estimatedTests}</div>
            </div>
            <div>
              <div className="text-slate-500 dark:text-slate-400">Compute Estimate</div>
              <div className="text-sm font-mono text-slate-900 dark:text-slate-100 mt-1">
                Fast ~0.3s · Full ~1.2s
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Conflicts & Non-Disableable Integrity Alerts */}
      {conflicts.length > 0 && (
        <div
          role="alert"
          className="border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-lg p-3 text-xs text-amber-900 dark:text-amber-200 space-y-1"
        >
          <div className="font-semibold flex items-center gap-1.5">
            <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            Non-Disableable Integrity Conflicts Detected (VSG-6 / MT-2)
          </div>
          {conflicts.map((c) => (
            <div key={c.columnName} className="font-mono">
              {c.columnName}: {c.conflict}
            </div>
          ))}
        </div>
      )}

      {/* Bulk Toolbar & Presets (VSG-4) */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={patternFilter}
            onChange={(e) => setPatternFilter(e.target.value)}
            placeholder="Filter column name..."
            aria-label="Filter column name"
            className="px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-44"
          />
          <button
            type="button"
            onClick={() => handleBulkSelectRole('predictor', 'candidate')}
            className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            All Predictors → Candidate
          </button>
          <button
            type="button"
            onClick={handleInvert}
            className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Invert Selection
          </button>
          {targets.length > 1 && (
            <button
              type="button"
              onClick={() => {
                const other = targets.find((t) => t !== activeTarget);
                if (other) onCopySelection(other, activeTarget);
              }}
              className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
            >
              <Copy className="w-3 h-3" aria-hidden="true" />
              Copy from {targets.find((t) => t !== activeTarget)}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={presetInputRef}
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              onImportPreset(activeTarget, await f.text());
              setPresetMsg(`Loaded preset from ${f.name}`);
            }}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => presetInputRef.current?.click()}
            className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
          >
            <Upload className="w-3 h-3" aria-hidden="true" />
            Load Preset
          </button>
          <button
            type="button"
            onClick={handleExportPreset}
            className="px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1"
          >
            <Download className="w-3 h-3" aria-hidden="true" />
            Save Preset
          </button>
        </div>
      </div>

      {presetMsg && <div className="text-xs text-sky-700 dark:text-sky-400">{presetMsg}</div>}

      {/* Per-Variable Gate Table */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 font-semibold">Variable</th>
                <th className="px-3 py-2 font-semibold">Role · Avail</th>
                <th className="px-3 py-2 font-semibold text-right">Missing %</th>
                <th className="px-3 py-2 font-semibold text-right">Unique</th>
                <th className="px-3 py-2 font-semibold text-right">r(target)</th>
                <th className="px-3 py-2 font-semibold">Distribution</th>
                <th className="px-3 py-2 font-semibold">Inclusion State</th>
                <th className="px-3 py-2 font-semibold">Resolution & Provenance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {filteredCols.map((col) => {
                const entry = entries[col.name];
                const prof = profiles.find((p) => p.name === col.name);
                const isIntegrityLocked = col.name === activeTarget || col.role === 'target' || col.role === 'time';
                const maxBin = prof ? Math.max(1, ...prof.histogramBins) : 1;

                return (
                  <tr key={col.name} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 font-mono font-medium text-slate-900 dark:text-slate-100">
                      {col.name}
                      {col.unit && <span className="text-slate-400 ml-1">({col.unit})</span>}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                      {col.role} · {col.availability === 'known_in_advance' ? 'forward' : 'observed'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {prof ? `${(prof.missingRate * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {prof?.uniqueCount ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {prof?.corrWithTarget !== null && prof?.corrWithTarget !== undefined
                        ? prof.corrWithTarget.toFixed(3)
                        : '—'}
                    </td>
                    <td className="px-3 py-2">
                      {prof && prof.histogramBins.length > 0 ? (
                        <div className="flex items-end gap-0.5 h-5 w-20" aria-label={`Histogram for ${col.name}`}>
                          {prof.histogramBins.map((b, i) => (
                            <div
                              key={i}
                              className="flex-1 bg-sky-600/75 dark:bg-sky-400/75 rounded-t-[1px]"
                              style={{ height: `${Math.max(12, Math.round((b / maxBin) * 100))}%` }}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        aria-label={`Inclusion state for ${col.name}`}
                        value={entry?.state ?? 'candidate'}
                        disabled={isIntegrityLocked}
                        onChange={(e) => {
                          const nextState = e.target.value as InclusionState;
                          if (prof) {
                            const conf = validateVsgConflict(col, prof, activeTarget, nextState);
                            if (conf && (col.name === activeTarget || col.role === 'target' || col.role === 'time')) {
                              return;
                            }
                          }
                          onUpdateVsgEntry(activeTarget, col.name, nextState);
                        }}
                        className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 disabled:opacity-50"
                      >
                        <option value="force_include">force_include</option>
                        <option value="candidate">candidate</option>
                        <option value="analysis_only">analysis_only</option>
                        <option value="exclude">exclude</option>
                      </select>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-slate-600 dark:text-slate-400 max-w-sm">
                      <div className="font-medium text-slate-800 dark:text-slate-200">
                        {entry?.mode} · {entry?.provenance}
                      </div>
                      <div className="line-clamp-2" title={entry?.reason}>
                        {entry?.reason}
                      </div>
                      {prof?.leakageReason && entry?.reason !== prof.leakageReason && (
                        <div className="text-amber-700 dark:text-amber-400 inline-flex items-center gap-1 mt-0.5">
                          <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                          <span className="truncate" title={prof.leakageReason}>
                            {prof.leakageReason}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
