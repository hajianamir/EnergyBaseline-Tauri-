import React, { useMemo, useRef, useState } from 'react';
import {
  AggregationMethod,
  AvailabilityFlag,
  ColumnConfig,
  ColumnRole,
  DatasetState,
  DomainType,
  QuantityType,
  SamplingGranularity,
} from '../engine/types';
import {
  aggregateRowsToTargetGranularity,
  defaultAggregationForQuantity,
  parseCsvToDataset,
  validateGranularityTransition,
} from '../engine/synthetic';
import { DataTable, SimpleColumnDef } from '../components/DataTable';
import { EChartBox } from '../components/EChartBox';
import { AlertTriangle, ArrowRight, FileUp, Plus, Sparkles, Trash2 } from 'lucide-react';

interface DataSetupViewProps {
  dataset: DatasetState;
  darkMode: boolean;
  onLoadPreset: (preset: 'energy_mv' | 'manufacturing_spc' | 'healthcare_kpi') => void;
  onReplaceDataset: (next: DatasetState, reason: string) => void;
  onProceedToVsg: () => void;
}

export const DataSetupView: React.FC<DataSetupViewProps> = ({
  dataset,
  darkMode,
  onLoadPreset,
  onReplaceDataset,
  onProceedToVsg,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [granularityError, setGranularityError] = useState<string | null>(null);
  const [nreStart, setNreStart] = useState(dataset.temporal.reportingStart.slice(0, 10));
  const [nreEnd, setNreEnd] = useState(dataset.temporal.reportingEnd.slice(0, 10));
  const [nreReason, setNreReason] = useState('');

  const targetCols = dataset.columns.filter((c) => c.role === 'target').map((c) => c.name);
  const primaryTarget = targetCols[0];

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setUploadError(null);
      const text = await file.text();
      const parsed = parseCsvToDataset(text, file.name, dataset.domain);
      onReplaceDataset(parsed, `Ingested CSV '${file.name}' (${parsed.rows.length} rows)`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to parse CSV file.');
    }
  };

  const updateColumn = (colName: string, patch: Partial<ColumnConfig>) => {
    const nextCols = dataset.columns.map((c) => {
      if (c.name !== colName) return c;
      const merged: ColumnConfig = { ...c, ...patch, roleMode: 'USER_OVERRIDE' };
      if (patch.quantityType && !patch.aggregation) {
        merged.aggregation = defaultAggregationForQuantity(patch.quantityType);
      }
      return merged;
    });
    onReplaceDataset(
      { ...dataset, columns: nextCols },
      `Updated column setup for '${colName}'`
    );
  };

  const handleGranularityChange = (nextGran: SamplingGranularity) => {
    const check = validateGranularityTransition(dataset.temporal.sourceGranularity, nextGran);
    if (!check.ok) {
      setGranularityError(check.message);
      return;
    }
    setGranularityError(null);
    const agg = aggregateRowsToTargetGranularity(
      dataset.rows,
      dataset.columns,
      dataset.temporal.sourceGranularity,
      nextGran,
      dataset.temporal.completenessThreshold
    );
    if (agg.refusalError) {
      setGranularityError(agg.refusalError);
      return;
    }
    onReplaceDataset(
      {
        ...dataset,
        rows: agg.rows,
        temporal: {
          ...dataset.temporal,
          sourceGranularity: nextGran,
          targetGranularity: nextGran,
        },
      },
      `Aggregated data from ${dataset.temporal.sourceGranularity} to ${nextGran}`
    );
  };

  const handleAddNre = () => {
    if (!nreReason.trim()) return;
    const nextEvents = [
      ...dataset.nonRoutineEvents,
      {
        id: `nre-${Date.now()}`,
        start: `${nreStart}T00:00:00.000Z`,
        end: `${nreEnd}T23:59:59.000Z`,
        reason: nreReason.trim(),
        treatment: 'flag_only' as const,
      },
    ];
    setNreReason('');
    onReplaceDataset({ ...dataset, nonRoutineEvents: nextEvents }, 'Added Non-Routine Event');
  };

  const handleDeleteNre = (id: string) => {
    onReplaceDataset(
      { ...dataset, nonRoutineEvents: dataset.nonRoutineEvents.filter((n) => n.id !== id) },
      'Removed Non-Routine Event'
    );
  };

  const previewChartOption = useMemo(() => {
    if (!primaryTarget) return {};
    const xs = dataset.rows.map((r) => r.timestamp.slice(0, 10));
    const ys = dataset.rows.map((r) => (typeof r[primaryTarget] === 'number' ? r[primaryTarget] : null));
    return {
      tooltip: { trigger: 'axis' as const },
      grid: { left: 56, right: 24, top: 24, bottom: 48 },
      dataZoom: [{ type: 'inside' as const }, { type: 'slider' as const, height: 18, bottom: 8 }],
      xAxis: { type: 'category' as const, data: xs },
      yAxis: { type: 'value' as const, name: primaryTarget },
      series: [
        {
          name: primaryTarget,
          type: 'line' as const,
          data: ys,
          showSymbol: false,
          lineStyle: { width: 1.8, color: '#0369A1' },
          markArea: {
            silent: true,
            itemStyle: { color: darkMode ? 'rgba(217,119,6,0.12)' : 'rgba(217,119,6,0.08)' },
            data: [
              [
                { name: 'Reporting Window', xAxis: dataset.temporal.reportingStart.slice(0, 10) },
                { xAxis: dataset.temporal.reportingEnd.slice(0, 10) },
              ] as [{ name: string; xAxis: string }, { xAxis: string }],
            ],
          },
        },
      ],
    };
  }, [dataset, primaryTarget, darkMode]);

  const previewColumns: SimpleColumnDef<Record<string, unknown>>[] = useMemo(() => {
    return dataset.columns.slice(0, 8).map((c) => ({
      key: c.name,
      header: `${c.name}${c.unit ? ` (${c.unit})` : ''}`,
      width: c.role === 'time' ? 185 : 130,
      align: c.dtype === 'numeric' ? 'right' : 'left',
      render: (val) => {
        if (val === null || val === undefined) return <span className="text-amber-600">NaN</span>;
        if (c.role === 'time') return String(val).slice(0, 19).replace('T', ' ');
        return typeof val === 'number' ? val.toFixed(2) : String(val);
      },
    }));
  }, [dataset.columns]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Data Ingestion & Column Setup
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            {dataset.name} · {dataset.rows.length.toLocaleString()} rows · SHA-256{' '}
            <span className="font-mono">{dataset.sha256.slice(0, 12)}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            onChange={handleFileUpload}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3.5 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <FileUp className="w-3.5 h-3.5" aria-hidden="true" />
            Import CSV
          </button>
          <button
            type="button"
            onClick={onProceedToVsg}
            disabled={targetCols.length === 0}
            className="px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 disabled:opacity-40 text-white rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            Proceed to Variable Gate (VSG)
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Built-in Synthetic Ground-Truth Presets */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display inline-flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-sky-600" aria-hidden="true" />
              Synthetic Ground-Truth Sanity Datasets & Domain Selector
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {dataset.sourceNote}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onLoadPreset('energy_mv')}
              className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                dataset.id === 'synth-energy-mv'
                  ? 'bg-sky-700 text-white border-sky-700'
                  : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              Commercial Campus M&V
            </button>
            <button
              type="button"
              onClick={() => onLoadPreset('manufacturing_spc')}
              className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                dataset.id === 'synth-mfg-spc'
                  ? 'bg-sky-700 text-white border-sky-700'
                  : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              Manufacturing Energy & Scrap
            </button>
            <button
              type="button"
              onClick={() => onLoadPreset('healthcare_kpi')}
              className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors whitespace-nowrap ${
                dataset.id === 'synth-health-kpi'
                  ? 'bg-sky-700 text-white border-sky-700'
                  : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              Hospital KPI
            </button>
          </div>
        </div>

        {dataset.domain === 'healthcare' && (
          <div className="p-3 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-xs text-amber-900 dark:text-amber-200">
            Healthcare Local-Only Data Notice (DOM-3): All patient/occupancy KPI data stays strictly on local SQLite storage with zero external transmission.
          </div>
        )}
        {uploadError && (
          <div className="p-3 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-200">
            {uploadError}
          </div>
        )}
      </section>

      {/* Temporal & Granularity Policy (DAT-3 / DAT-4) */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
            Temporal Configuration, Domain & Sampling Guard
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            UTC storage · Finer data aggregated · Coarser disaggregation refused (DAT-3)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <label className="block text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1">Domain Vocabulary (DOM-1)</span>
            <select
              value={dataset.domain}
              onChange={(e) =>
                onReplaceDataset({ ...dataset, domain: e.target.value as DomainType }, `Changed domain to ${e.target.value}`)
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="energy">Energy (M&V EnB / EnPI)</option>
              <option value="manufacturing">Manufacturing (Process Deviation)</option>
              <option value="water">Water & Utilities</option>
              <option value="healthcare">Healthcare (Performance KPI)</option>
              <option value="custom">Custom</option>
            </select>
          </label>

          <label className="block text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1">
              Target Granularity (Source: {dataset.temporal.sourceGranularity})
            </span>
            <select
              value={dataset.temporal.targetGranularity}
              onChange={(e) => handleGranularityChange(e.target.value as SamplingGranularity)}
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="15min">15-minute</option>
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>

          <label className="block text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1">Baseline Window End</span>
            <input
              type="date"
              value={dataset.temporal.baselineEnd.slice(0, 10)}
              onChange={(e) =>
                onReplaceDataset(
                  {
                    ...dataset,
                    temporal: { ...dataset.temporal, baselineEnd: `${e.target.value}T23:59:59.000Z` },
                  },
                  `Updated baseline end to ${e.target.value}`
                )
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
            />
          </label>

          <label className="block text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1">Reporting Window Start</span>
            <input
              type="date"
              value={dataset.temporal.reportingStart.slice(0, 10)}
              onChange={(e) =>
                onReplaceDataset(
                  {
                    ...dataset,
                    temporal: { ...dataset.temporal, reportingStart: `${e.target.value}T00:00:00.000Z` },
                  },
                  `Updated reporting start to ${e.target.value}`
                )
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
            />
          </label>
        </div>

        {granularityError && (
          <div
            role="alert"
            className="p-3 rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-200 flex items-center gap-2"
          >
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{granularityError}</span>
          </div>
        )}
      </section>

      {/* Column Roles, Quantity Types, Units & Availability Table */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
              Column Dictionary & Role Assignment (DAT-1 / DAT-2)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Active TARGETs ({targetCols.length}): {targetCols.join(', ') || 'Select at least 1 target'} · Column heuristics only suggest; you decide.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 font-semibold">Column</th>
                <th className="px-3 py-2 font-semibold">Dtype</th>
                <th className="px-3 py-2 font-semibold">Role</th>
                <th className="px-3 py-2 font-semibold">Quantity Type</th>
                <th className="px-3 py-2 font-semibold">Aggregation</th>
                <th className="px-3 py-2 font-semibold">Unit</th>
                <th className="px-3 py-2 font-semibold">Availability</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {dataset.columns.map((col) => (
                <tr key={col.name} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  <td className="px-3 py-2 font-mono font-medium text-slate-900 dark:text-slate-100">
                    {col.name}
                    <div className="text-[11px] font-sans text-slate-400">
                      Suggested: {col.suggestedRole} · {col.roleMode}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{col.dtype}</td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Role for ${col.name}`}
                      value={col.role}
                      onChange={(e) => updateColumn(col.name, { role: e.target.value as ColumnRole })}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    >
                      <option value="time">time</option>
                      <option value="target">target</option>
                      <option value="predictor">predictor</option>
                      <option value="static_factor">static_factor</option>
                      <option value="group">group</option>
                      <option value="weight">weight</option>
                      <option value="ignore">ignore</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Quantity type for ${col.name}`}
                      value={col.quantityType}
                      onChange={(e) => updateColumn(col.name, { quantityType: e.target.value as QuantityType })}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    >
                      <option value="flow">flow</option>
                      <option value="stock">stock</option>
                      <option value="rate">rate</option>
                      <option value="quality">quality</option>
                      <option value="index">index</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Aggregation for ${col.name}`}
                      value={col.aggregation}
                      onChange={(e) => updateColumn(col.name, { aggregation: e.target.value as AggregationMethod })}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    >
                      <option value="sum">sum</option>
                      <option value="last">last</option>
                      <option value="time_weighted_mean">time_weighted_mean</option>
                      <option value="mean">mean</option>
                      <option value="median">median</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      aria-label={`Unit for ${col.name}`}
                      value={col.unit}
                      onChange={(e) => updateColumn(col.name, { unit: e.target.value })}
                      className="w-20 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-mono"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      aria-label={`Availability for ${col.name}`}
                      value={col.availability}
                      onChange={(e) => updateColumn(col.name, { availability: e.target.value as AvailabilityFlag })}
                      className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    >
                      <option value="known_in_advance">known_in_advance</option>
                      <option value="observed_only">observed_only</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Non-Routine Events & Visual Preview */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
            Non-Routine Events (DAT-7 / IPMVP)
          </h2>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="text-xs">
              <span className="block text-slate-500 mb-1">Start</span>
              <input
                type="date"
                value={nreStart}
                onChange={(e) => setNreStart(e.target.value)}
                className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </label>
            <label className="text-xs">
              <span className="block text-slate-500 mb-1">End</span>
              <input
                type="date"
                value={nreEnd}
                onChange={(e) => setNreEnd(e.target.value)}
                className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </label>
            <label className="text-xs flex-1 min-w-[160px]">
              <span className="block text-slate-500 mb-1">Reason</span>
              <input
                type="text"
                value={nreReason}
                onChange={(e) => setNreReason(e.target.value)}
                placeholder="e.g., Chiller overhaul or floor expansion"
                className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </label>
            <button
              type="button"
              onClick={handleAddNre}
              className="px-3 py-1.5 text-xs font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded hover:opacity-90 inline-flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              Flag Event
            </button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
            {dataset.nonRoutineEvents.length === 0 ? (
              <p className="text-slate-500 py-3">No non-routine events flagged.</p>
            ) : (
              dataset.nonRoutineEvents.map((ev) => (
                <div key={ev.id} className="py-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-800 dark:text-slate-200">{ev.reason}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {ev.start.slice(0, 10)} → {ev.end.slice(0, 10)} · {ev.treatment}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteNre(ev.id)}
                    aria-label={`Remove event ${ev.reason}`}
                    className="p-1 text-slate-400 hover:text-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        {primaryTarget && (
          <EChartBox
            title={`Primary Target Series: ${primaryTarget}`}
            subtitle="Shaded region highlights the declared Reporting Window"
            option={previewChartOption}
            height={230}
            darkMode={darkMode}
          />
        )}
      </div>

      {/* Virtualized Data Grid */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
          Ingested Time-Series Preview (Virtualized TanStack Table v9)
        </h2>
        <DataTable
          data={dataset.rows as Record<string, unknown>[]}
          columns={previewColumns}
          maxHeight={280}
          exportFileName={`${dataset.id}_rows.csv`}
          searchPlaceholder="Filter timestamps or values..."
        />
      </section>
    </div>
  );
};
