import React, { useMemo, useRef, useState } from 'react';
import {
  DatasetRow,
  DatasetState,
  LockedBaseline,
  MonitoringSnapshot,
} from '../engine/types';
import { createMonitoringSnapshot, predictFromLockedBaseline } from '../engine/monitoring';
import { executeGuardedLocalSql } from '../engine/sqlGuard';
import { getReportingRows, mean } from '../engine/stats';
import { parseCsvToDataset } from '../engine/synthetic';
import { EChartBox } from '../components/EChartBox';
import { DataTable, SimpleColumnDef } from '../components/DataTable';
import { AlertTriangle, Database, FileUp, Lock, Play, ShieldAlert } from 'lucide-react';

interface MonitoringViewProps {
  dataset: DatasetState;
  lockedBaselines: Record<string, LockedBaseline>;
  snapshots: MonitoringSnapshot[];
  darkMode: boolean;
  onSaveSnapshot: (snap: MonitoringSnapshot) => void;
}

export const MonitoringView: React.FC<MonitoringViewProps> = ({
  dataset,
  lockedBaselines,
  snapshots,
  darkMode,
  onSaveSnapshot,
}) => {
  const lockedTargets = Object.keys(lockedBaselines);
  const [selectedTarget, setSelectedTarget] = useState<string>(lockedTargets[0] ?? '');
  const activeTarget = lockedTargets.includes(selectedTarget) ? selectedTarget : lockedTargets[0] ?? '';
  const baseline = activeTarget ? lockedBaselines[activeTarget] : undefined;

  const [inputMode, setInputMode] = useState<'reporting_window' | 'sql' | 'manual' | 'file'>('reporting_window');
  const [alertRule, setAlertRule] = useState<'auto' | 'percent_10' | 'k_rmse_2' | 'outside_interval'>('auto');
  const [sqlText, setSqlText] = useState(
    `SELECT * FROM baseline_monitoring_view WHERE timestamp >= '${dataset.temporal.reportingStart.slice(0, 10)}' LIMIT 100`
  );
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [sqlGuardNote, setSqlGuardNote] = useState<string | null>(null);
  const [manualVals, setManualVals] = useState<Record<string, string>>({});
  const [manualActual, setManualActual] = useState<string>('');
  const [customRows, setCustomRows] = useState<DatasetRow[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reportingRows = useMemo(() => getReportingRows(dataset), [dataset]);
  const activeRows = customRows ?? reportingRows;

  const predictionResult = useMemo(() => {
    if (!baseline || activeRows.length === 0) return null;
    return predictFromLockedBaseline(baseline, activeRows, dataset, alertRule);
  }, [baseline, activeRows, dataset, alertRule]);

  const handleRunGuardedSql = () => {
    const res = executeGuardedLocalSql(sqlText, dataset.rows, 200);
    if (!res.ok) {
      setSqlError(res.error ?? 'SQL rejected by PM-3 guard.');
      setSqlGuardNote(null);
      return;
    }
    setSqlError(null);
    setSqlGuardNote(res.guard.reason);
    setCustomRows(res.rows);
  };

  const handleManualPredict = () => {
    if (!baseline) return;
    const row: DatasetRow = {
      timestamp: new Date().toISOString(),
      [baseline.target]: manualActual.trim() === '' ? null : Number(manualActual),
    };
    for (const f of baseline.features) {
      row[f] = Number(manualVals[f] ?? 18);
    }
    setCustomRows([row]);
  };

  const handleFileMonitoring = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const parsed = parseCsvToDataset(await f.text(), f.name, dataset.domain);
    setCustomRows(parsed.rows);
  };

  const chartOption = useMemo(() => {
    if (!predictionResult) return {};
    const xs = predictionResult.points.map((p) => p.timestamp.slice(0, 10));
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { top: 0, itemWidth: 14, textStyle: { fontSize: 11 } },
      grid: { left: 56, right: 20, top: 54, bottom: 36 },
      xAxis: { type: 'category' as const, data: xs },
      yAxis: { type: 'value' as const },
      series: [
        {
          name: 'Conformal Upper',
          type: 'line' as const,
          data: predictionResult.points.map((p) => p.upper),
          lineStyle: { opacity: 0.3, type: 'dashed' as const, color: '#0369A1' },
          showSymbol: false,
        },
        {
          name: 'Conformal Lower',
          type: 'line' as const,
          data: predictionResult.points.map((p) => p.lower),
          lineStyle: { opacity: 0.3, type: 'dashed' as const, color: '#0369A1' },
          showSymbol: false,
        },
        {
          name: 'Counterfactual Baseline',
          type: 'line' as const,
          data: predictionResult.points.map((p) => p.baseline),
          lineStyle: { width: 2, color: '#0369A1' },
          showSymbol: false,
        },
        {
          name: 'Observed Actual',
          type: 'line' as const,
          data: predictionResult.points.map((p) => p.actual),
          lineStyle: { width: 2, color: '#D97706' },
          showSymbol: false,
        },
      ],
    };
  }, [predictionResult]);

  const devChartOption = useMemo(() => {
    if (!predictionResult) return {};
    const xs = predictionResult.points.map((p) => p.timestamp.slice(0, 10));
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { top: 0, itemWidth: 14, textStyle: { fontSize: 11 } },
      grid: { left: 56, right: 20, top: 54, bottom: 36 },
      xAxis: { type: 'category' as const, data: xs },
      yAxis: { type: 'value' as const, name: 'A − B', nameGap: 14 },
      series: [
        {
          name: 'Deviation (Actual − Baseline)',
          type: 'bar' as const,
          data: predictionResult.points.map((p) => p.deviation),
          itemStyle: {
            color: (p: { value?: unknown }) => (Number(p.value ?? 0) < 0 ? '#059669' : '#DC2626'),
          },
        },
      ],
    };
  }, [predictionResult]);

  if (!baseline) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-10 text-center space-y-2">
        <Lock className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
        <h2 className="text-base font-semibold font-display text-slate-900 dark:text-slate-100">
          Prediction & Monitoring Locked (PM-1)
        </h2>
        <p className="text-xs text-slate-500 max-w-md mx-auto">
          Lock at least one target baseline in Step 5 (Modeling & Top-5) to unlock counterfactual prediction, alerts, and drift monitoring for that target.
        </p>
      </div>
    );
  }

  const validDevs = predictionResult?.points.map((p) => p.deviation).filter((d): d is number => d !== null) ?? [];
  const totalCumDev = validDevs.reduce((a, b) => a + b, 0);
  const avgDev = validDevs.length > 0 ? mean(validDevs) : 0;
  const alertCount = predictionResult?.points.filter((p) => p.alert).length ?? 0;

  const pointColumns: SimpleColumnDef<Record<string, unknown>>[] = [
    { key: 'timestamp', header: 'Timestamp', width: 120, render: (v) => String(v).slice(0, 10) },
    { key: 'baseline', header: 'Baseline', width: 100, align: 'right' },
    { key: 'actual', header: 'Actual', width: 100, align: 'right' },
    { key: 'deviation', header: 'Dev (A−B)', width: 110, align: 'right' },
    { key: 'deviationPct', header: 'Dev %', width: 90, align: 'right' },
    { key: 'cumulativeDeviation', header: 'Cum Dev', width: 110, align: 'right' },
    { key: 'lower', header: 'Conf Low', width: 100, align: 'right' },
    { key: 'upper', header: 'Conf High', width: 100, align: 'right' },
    {
      key: 'alert',
      header: 'Alert',
      width: 90,
      render: (v) => (v ? <span className="text-red-600 font-semibold">ALERT</span> : 'OK'),
    },
  ];

  const tl = predictionResult?.drift.trafficLight ?? 'green';
  const tlText = tl === 'red' ? 'RED — RE-VALIDATION RECOMMENDED' : tl === 'amber' ? 'AMBER — WATCH COVARIATES' : 'GREEN — STABLE';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Prediction, Deviation & Drift Monitoring
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Locked Baseline: <span className="font-mono">{baseline.target} v{baseline.version}</span> ({baseline.modelName}) · Deviation = Actual − Baseline (PM-5).
          </p>
        </div>

        <div className="flex items-center gap-2">
          {predictionResult && (
            <button
              type="button"
              onClick={() =>
                onSaveSnapshot(
                  createMonitoringSnapshot(
                    baseline,
                    inputMode === 'sql' ? 'sql' : inputMode === 'manual' ? 'manual' : 'file',
                    activeRows,
                    predictionResult
                  )
                )
              }
              className="px-3.5 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              Save Snapshot ({snapshots.length})
            </button>
          )}
        </div>
      </div>

      {/* Target & Source Mode Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {lockedTargets.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSelectedTarget(t)}
              className={`px-3 py-1.5 text-xs font-mono rounded-md ${
                t === activeTarget ? 'bg-sky-700 text-white font-semibold' : 'bg-slate-100 dark:bg-slate-800'
              }`}
            >
              {t} (v{lockedBaselines[t].version})
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs">
            {(
              [
                ['reporting_window', 'Reporting Window'],
                ['sql', 'Guarded SQL (PM-3)'],
                ['manual', 'Manual Entry'],
                ['file', 'Upload File'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setInputMode(id);
                  if (id === 'reporting_window') setCustomRows(null);
                }}
                className={`px-2.5 py-1 rounded-md whitespace-nowrap ${
                  inputMode === id ? 'bg-white dark:bg-slate-900 font-semibold shadow-sm' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <select
            aria-label="Alert Rule"
            value={alertRule}
            onChange={(e) => setAlertRule(e.target.value as typeof alertRule)}
            className="px-2.5 py-1.5 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="auto">Alert: AUTO max(10%, 2×CV)</option>
            <option value="percent_10">Alert: ±10%</option>
            <option value="k_rmse_2">Alert: ±2×RMSE</option>
            <option value="outside_interval">Alert: Outside Conformal</option>
          </select>
        </div>
      </div>

      {/* Mode-Specific Input Panels */}
      {inputMode === 'sql' && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold font-display inline-flex items-center gap-1.5">
              <Database className="w-4 h-4 text-sky-600" aria-hidden="true" />
              Guarded Read-Only SQL Input (PM-3)
            </h2>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() =>
                  setSqlText(`SELECT * FROM baseline_monitoring_view WHERE timestamp >= '${dataset.temporal.reportingStart.slice(0, 10)}' LIMIT 60`)
                }
                className="text-sky-700 dark:text-sky-400 hover:underline"
              >
                Load Valid SELECT
              </button>
              <button
                type="button"
                onClick={() => setSqlText('SELECT * FROM baseline_monitoring_view; DROP TABLE users;')}
                className="text-red-700 dark:text-red-400 hover:underline"
              >
                Test Stacked DROP Attack
              </button>
            </div>
          </div>
          <textarea
            rows={2}
            aria-label="Read-only SQL query"
            value={sqlText}
            onChange={(e) => setSqlText(e.target.value)}
            className="w-full p-2.5 text-xs font-mono rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950"
          />
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleRunGuardedSql}
              className="px-3.5 py-1.5 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded inline-flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              Validate & Execute Query
            </button>
            {sqlGuardNote && <span className="text-xs text-emerald-700 dark:text-emerald-400">{sqlGuardNote}</span>}
          </div>
          {sqlError && (
            <div role="alert" className="p-2.5 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-200 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{sqlError}</span>
            </div>
          )}
        </section>
      )}

      {inputMode === 'manual' && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3 text-xs">
          <h2 className="text-sm font-semibold font-display">Manual Single-Point Prediction (PM-4)</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {baseline.features.map((f) => (
              <label key={f} className="block">
                <span className="text-slate-500 font-mono block mb-1">{f}</span>
                <input
                  type="number"
                  value={manualVals[f] ?? '22'}
                  onChange={(e) => setManualVals({ ...manualVals, [f]: e.target.value })}
                  className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-slate-500 font-mono block mb-1">Observed {baseline.target} (opt)</span>
              <input
                type="number"
                value={manualActual}
                onChange={(e) => setManualActual(e.target.value)}
                placeholder="Optional actual"
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={handleManualPredict}
            className="px-3.5 py-1.5 text-xs font-semibold bg-sky-700 text-white rounded"
          >
            Compute Prediction
          </button>
        </section>
      )}

      {inputMode === 'file' && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 flex items-center justify-between text-xs">
          <span>Upload a reporting-period CSV matching training columns ({baseline.features.join(', ')}).</span>
          <input ref={fileRef} type="file" accept=".csv" onChange={handleFileMonitoring} className="hidden" />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded inline-flex items-center gap-1.5"
          >
            <FileUp className="w-3.5 h-3.5" aria-hidden="true" />
            Choose CSV
          </button>
        </section>
      )}

      {/* Monitoring KPIs & Drift Traffic Light (DR-1..5) */}
      {predictionResult && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 text-xs tabular-nums">
            <div>
              <div className="text-slate-500">Cumulative Deviation (A−B)</div>
              <div className="text-xl font-mono font-bold mt-0.5">{totalCumDev.toFixed(1)}</div>
              <div className="text-[11px] text-slate-500">Avg {avgDev.toFixed(2)} / step</div>
            </div>
            <div>
              <div className="text-slate-500">Alerts Triggered</div>
              <div className="text-xl font-mono font-bold mt-0.5">{alertCount} / {predictionResult.points.length}</div>
              <div className="text-[11px] text-slate-500 truncate">{predictionResult.alertRuleDescription}</div>
            </div>
            <div>
              <div className="text-slate-500">Extrapolation Share (PM-2)</div>
              <div className="text-xl font-mono font-bold mt-0.5">{predictionResult.extrapolationSharePct}%</div>
              <div className="text-[11px] text-slate-500">Rows outside training range</div>
            </div>
            <div>
              <div className="text-slate-500">Drift Traffic Light (DR-3)</div>
              <div
                className={`text-sm font-mono font-bold mt-1 ${
                  tl === 'red' ? 'text-red-600' : tl === 'amber' ? 'text-amber-600' : 'text-emerald-600'
                }`}
              >
                {tlText}
              </div>
              <div className="text-[11px] text-slate-500">Never auto-retrains (DR-4)</div>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <div className="font-semibold text-slate-900 dark:text-slate-100">
                {predictionResult.drift.recommendation}
              </div>
              <div className="text-slate-600 dark:text-slate-400 mt-0.5">
                {predictionResult.drift.residualDrift.interpretation} · CUSUM max={predictionResult.drift.residualDrift.cusumMax} · EWMA exceedances={predictionResult.drift.residualDrift.ewmaExceedances} · Page-Hinkley={String(predictionResult.drift.residualDrift.pageHinkleyTriggered)}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <EChartBox
              title="Counterfactual Baseline vs Observed Actual"
              subtitle="Dashed lines show conformal prediction interval"
              option={chartOption}
              height={300}
              darkMode={darkMode}
            />
            <EChartBox
              title="Period Deviation (Actual − Baseline)"
              subtitle="Negative bars indicate lower usage than counterfactual baseline"
              option={devChartOption}
              height={300}
              darkMode={darkMode}
            />
          </div>

          {/* Input Drift Breakdown (DR-1) */}
          <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-x-auto">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
              Predictor Input Drift Diagnostics (PSI, 2-Sample KS, Wasserstein)
            </div>
            <table className="w-full text-xs text-left tabular-nums">
              <thead className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-3 py-2">Predictor</th>
                  <th className="px-3 py-2 text-right">PSI</th>
                  <th className="px-3 py-2 text-right">KS Stat</th>
                  <th className="px-3 py-2 text-right">KS p-Value</th>
                  <th className="px-3 py-2 text-right">Wasserstein (z)</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                {predictionResult.drift.inputDrift.map((d) => (
                  <tr key={d.feature}>
                    <td className="px-3 py-2 font-mono">{d.feature}</td>
                    <td className="px-3 py-2 text-right font-mono">{d.psi.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono">{d.ksStat.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono">{d.ksPValue.toFixed(4)}</td>
                    <td className="px-3 py-2 text-right font-mono">{d.wasserstein.toFixed(3)}</td>
                    <td className="px-3 py-2 font-mono font-semibold">{d.status.toUpperCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <DataTable
            data={predictionResult.points as unknown as Record<string, unknown>[]}
            columns={pointColumns}
            maxHeight={300}
            exportFileName={`monitoring_${baseline.target}_v${baseline.version}.csv`}
            searchPlaceholder="Filter monitoring timestamps..."
          />
        </>
      )}
    </div>
  );
};
