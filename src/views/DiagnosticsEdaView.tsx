import React, { useMemo, useState } from 'react';
import {
  DatasetState,
  EdaTargetSummary,
  StatisticalTestResult,
} from '../engine/types';
import { DataTable, SimpleColumnDef } from '../components/DataTable';
import { EChartBox } from '../components/EChartBox';
import { ArrowRight } from 'lucide-react';

interface DiagnosticsEdaViewProps {
  dataset: DatasetState;
  targets: string[];
  activeTarget: string;
  onSelectTarget: (target: string) => void;
  testsByTarget: Record<string, StatisticalTestResult[]>;
  edaByTarget: Record<string, EdaTargetSummary>;
  darkMode: boolean;
  onProceedToModeling: () => void;
}

export const DiagnosticsEdaView: React.FC<DiagnosticsEdaViewProps> = ({
  dataset,
  targets,
  activeTarget,
  onSelectTarget,
  testsByTarget,
  edaByTarget,
  darkMode,
  onProceedToModeling,
}) => {
  const [subTab, setSubTab] = useState<'tests' | 'eda' | 'mining' | 'causal'>('tests');
  const tests = testsByTarget[activeTarget] ?? [];
  const eda = edaByTarget[activeTarget];

  const sigCount = tests.filter(
    (t) => t.decision === 'reject_h0' || t.decision === 'practical_significant'
  ).length;
  const flipCount = tests.filter((t) => t.decisionFlips).length;

  const testColumns: SimpleColumnDef<StatisticalTestResult & Record<string, unknown>>[] = useMemo(
    () => [
      { key: 'familyId', header: 'Fam', width: 76 },
      {
        key: 'testName',
        header: 'Test',
        width: 245,
        render: (v, r) => (
          <span>
            {r.isOptionalTest && (
              <span className="font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-400 mr-1.5">[O]</span>
            )}
            {r.approximate && (
              <span className="font-mono text-[10px] font-semibold uppercase text-amber-700 dark:text-amber-400 mr-1.5">Approx.</span>
            )}
            {String(v)}
          </span>
        ),
      },
      { key: 'variable', header: 'Variable', width: 155 },
      {
        key: 'statistic',
        header: 'Stat',
        width: 90,
        align: 'right',
        render: (v, r) => (v !== null ? `${Number(v).toFixed(3)}` : '—'),
      },
      {
        key: 'pRaw',
        header: 'p (raw)',
        width: 95,
        align: 'right',
        render: (v) => (typeof v === 'number' ? v.toExponential(2) : '—'),
      },
      {
        key: 'pAdjusted',
        header: 'p (adj)',
        width: 95,
        align: 'right',
        render: (v) => (typeof v === 'number' ? v.toExponential(2) : '—'),
      },
      {
        key: 'effectSize',
        header: 'Effect',
        width: 90,
        align: 'right',
        render: (v, r) => (typeof v === 'number' ? `${v.toFixed(3)}` : '—'),
      },
      {
        key: 'decision',
        header: 'Decision',
        width: 185,
        render: (v) => (
          <span
            className={`font-mono ${
              v === 'practical_significant' || v === 'reject_h0'
                ? 'text-sky-700 dark:text-sky-400 font-semibold'
                : v === 'not_run'
                  ? 'text-slate-400'
                  : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            {String(v)}
          </span>
        ),
      },
      {
        key: 'decisionFlips',
        header: 'α-Sensitive (0.01/0.05/0.10)',
        width: 215,
        render: (v, r) =>
          v ? (
            <span className="text-amber-700 dark:text-amber-400 font-medium">
              FLIPS ({r.decisionAt001} / {r.decisionAt005} / {r.decisionAt010})
            </span>
          ) : (
            <span className="text-slate-500">Stable</span>
          ),
      },
      { key: 'interpretation', header: 'Interpretation & Action', width: 320 },
    ],
    []
  );

  // ECharts Correlation Heatmap (F2)
  const corrHeatmapOption = useMemo(() => {
    if (!eda || eda.correlations.length === 0) return {};
    const vars = Array.from(new Set(eda.correlations.flatMap((c) => [c.varA, c.varB])));
    const dataPts: [number, number, number][] = [];
    for (let i = 0; i < vars.length; i++) {
      for (let j = 0; j < vars.length; j++) {
        if (i === j) {
          dataPts.push([i, j, 1]);
        } else {
          const match = eda.correlations.find(
            (c) => (c.varA === vars[i] && c.varB === vars[j]) || (c.varA === vars[j] && c.varB === vars[i])
          );
          dataPts.push([i, j, match ? match.pearson : 0]);
        }
      }
    }
    return {
      tooltip: { position: 'top' as const },
      grid: { left: 120, right: 24, top: 18, bottom: 112 },
      xAxis: { type: 'category' as const, data: vars, axisLabel: { rotate: 28, fontSize: 10 } },
      yAxis: { type: 'category' as const, data: vars, axisLabel: { fontSize: 10 } },
      visualMap: {
        min: -1,
        max: 1,
        calculable: true,
        orient: 'horizontal' as const,
        left: 'center',
        bottom: 2,
        inRange: { color: ['#DC2626', '#F8FAFC', '#0369A1'] },
      },
      series: [
        {
          name: 'Pearson r',
          type: 'heatmap' as const,
          data: dataPts,
          label: {
            show: true,
            formatter: (p: { value?: unknown }) => {
              const arr = Array.isArray(p.value) ? p.value : [];
              return Number(arr[2] ?? 0).toFixed(2);
            },
            fontSize: 10,
          },
        },
      ],
    };
  }, [eda]);

  // ECharts Target-Ranked Correlation Bar with CI (F2)
  const targetCorrOption = useMemo(() => {
    if (!eda) return {};
    const targetPairs = eda.correlations.filter((c) => c.varA === activeTarget || c.varB === activeTarget);
    const labels = targetPairs.map((c) => (c.varA === activeTarget ? c.varB : c.varA));
    return {
      tooltip: { trigger: 'axis' as const },
      grid: { left: 130, right: 24, top: 24, bottom: 32 },
      xAxis: { type: 'value' as const, min: -1, max: 1 },
      yAxis: { type: 'category' as const, data: labels },
      series: [
        {
          name: 'Pearson r',
          type: 'bar' as const,
          data: targetPairs.map((c) => c.pearson),
          itemStyle: { color: '#0369A1' },
        },
        {
          name: 'Distance Corr',
          type: 'bar' as const,
          data: targetPairs.map((c) => c.distCorr),
          itemStyle: { color: '#D97706' },
        },
      ],
    };
  }, [eda, activeTarget]);

  // ECharts ACF/PACF (F7)
  const acfOption = useMemo(() => {
    if (!eda) return {};
    const lags = eda.timeSeriesMining.acf.map((_, i) => `L${i}`);
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { top: 0 },
      grid: { left: 48, right: 20, top: 32, bottom: 32 },
      xAxis: { type: 'category' as const, data: lags },
      yAxis: { type: 'value' as const, min: -1, max: 1 },
      series: [
        { name: 'ACF', type: 'bar' as const, data: eda.timeSeriesMining.acf, itemStyle: { color: '#0369A1' } },
        { name: 'PACF', type: 'line' as const, data: eda.timeSeriesMining.pacf, itemStyle: { color: '#D97706' } },
      ],
    };
  }, [eda]);

  // ECharts PCA Scree (F3)
  const pcaOption = useMemo(() => {
    if (!eda) return {};
    const pcs = eda.pca.explainedVarianceRatio.map((_, i) => `PC${i + 1}`);
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { top: 0 },
      grid: { left: 48, right: 24, top: 32, bottom: 32 },
      xAxis: { type: 'category' as const, data: pcs },
      yAxis: { type: 'value' as const, max: 1 },
      series: [
        { name: 'Individual Variance', type: 'bar' as const, data: eda.pca.explainedVarianceRatio, itemStyle: { color: '#0369A1' } },
        { name: 'Cumulative', type: 'line' as const, data: eda.pca.cumulativeVarianceRatio, itemStyle: { color: '#059669' } },
      ],
    };
  }, [eda]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Diagnostics Suite, EDA Atlas & Data Mining
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Pre-model core [M] &amp; extended [O] tests (T1–T14), F1–F9 EDA &amp; mining (autoencoder + target-tercile rules), in-app Data Quality Index, and Causal balance.
          </p>
        </div>

        <button
          type="button"
          onClick={onProceedToModeling}
          className="px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          Proceed to Modeling & Top-5
          <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Target & Sub-view Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          {targets.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onSelectTarget(t)}
              className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors ${
                t === activeTarget
                  ? 'bg-sky-700 text-white font-semibold'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {eda && <span className="text-[11px] text-slate-500 font-mono">Engine v{eda.engine_version} · Target seed {eda.seed}</span>}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          {(
            [
              ['tests', `Tests T1–T14 + [O] (${tests.length})`],
              ['eda', 'Correlation & PCA (F2–F3)'],
              ['mining', 'Regimes & TS Mining (F4–F9)'],
              ['causal', 'Causal M&V (T14)'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSubTab(id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                subTab === id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
          </div>
        </div>
      </div>

      {/* KPI Summary Strip */}
      {eda && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 tabular-nums">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">In-app Data Quality Index (F9)</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {eda.dataQuality.overallScore === null ? 'Not computed' : `${eda.dataQuality.overallScore} / 100`}
            </div>
            <div className="text-[11px] text-slate-500">
              Completeness {eda.dataQuality.completeness.score === null ? '—' : `${eda.dataQuality.completeness.score}%`} · Type {eda.dataQuality.consistency.score === null ? '—' : `${eda.dataQuality.consistency.score}%`} · Order {eda.dataQuality.temporalOrder.score === null ? '—' : `${eda.dataQuality.temporalOrder.score}%`}
            </div>
            <div className="text-[11px] text-slate-500">Descriptive in-app index; not a validated quality standard</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Significant Tests</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {sigCount} / {tests.length}
            </div>
            <div className="text-[11px] text-slate-500">{flipCount} α-sensitive flips</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Grid-Searched Degree-Day Bases</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {eda.timeSeriesMining.optimalBaseTempHeating === null ? '—' : `${eda.timeSeriesMining.optimalBaseTempHeating}°C`} / {eda.timeSeriesMining.optimalBaseTempCooling === null ? '—' : `${eda.timeSeriesMining.optimalBaseTempCooling}°C`}
            </div>
            <div className="text-[11px] text-slate-500">1°C grid; squared Pearson-correlation heuristic</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Bootstrap Tercile-Cut Stability (ARI)</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {eda.clustering.bootstrapAri === null ? 'Not estimable' : eda.clustering.bootstrapAri}
            </div>
            <div className="text-[11px] text-slate-500">
              Target-value terciles · Silhouette {eda.clustering.silhouette ?? '—'} · k={eda.clustering.k}
            </div>
          </div>
        </div>
      )}

      {subTab === 'tests' && (
        <div className="space-y-4">
          <DataTable
            data={tests as (StatisticalTestResult & Record<string, unknown>)[]}
            columns={testColumns}
            maxHeight={420}
            exportFileName={`diagnostics_${activeTarget}.csv`}
            searchPlaceholder="Filter test family, variable, or decision..."
          />
        </div>
      )}

      {subTab === 'eda' && eda && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <EChartBox
              title="Clustered Correlation Matrix (Pearson r)"
              subtitle="Candidate Pool variables · Full CI and adjusted p-values in table below"
              option={corrHeatmapOption}
              height={320}
              darkMode={darkMode}
            />
            <EChartBox
              title={`Target-Ranked Dependence: ${activeTarget}`}
              subtitle="Linear Pearson vs nonlinear Distance Correlation (F2)"
              option={targetCorrOption}
              height={320}
              darkMode={darkMode}
            />
          </div>

          <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold font-display">
              Correlation & Dependence Atlas (Circular Block-Bootstrap CI & Adjusted p-Values)
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left tabular-nums">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-3 py-2">Variable Pair</th>
                    <th className="px-3 py-2 text-right">Pearson r</th>
                    <th className="px-3 py-2 text-right">Spearman ρ</th>
                    <th className="px-3 py-2 text-right">Kendall τ</th>
                    <th className="px-3 py-2 text-right">Dist Corr</th>
                    <th className="px-3 py-2 text-right">MI</th>
                    <th className="px-3 py-2 text-right">CI</th>
                    <th className="px-3 py-2 text-right">p (adj)</th>
                    <th className="px-3 py-2">Nonlinearity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                  {eda.correlations.map((c, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-mono">{c.varA} ↔ {c.varB}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.pearson.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.spearman.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.kendall.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.distCorr.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">{c.mutualInfo.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right font-mono">[{c.ciLow}, {c.ciHigh}]</td>
                      <td className="px-3 py-2 text-right font-mono">{c.pAdjusted.toExponential(2)}</td>
                      <td className="px-3 py-2">{c.nonlinearityFlag ? 'Nonlinear signal' : 'Linear'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <EChartBox
            title="PCA Scree & Cumulative Variance (F3)"
            subtitle={`KMO=${eda.pca.kmo === null ? 'not computed' : eda.pca.kmo} · Bartlett p=${eda.pca.bartlettP === null ? 'not computed' : eda.pca.bartlettP.toExponential(1)} · ${eda.pca.adequacyMethod}`}
            option={pcaOption}
            height={260}
            darkMode={darkMode}
          />
        </div>
      )}

      {subTab === 'mining' && eda && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <EChartBox
              title="Autocorrelation (ACF & PACF)"
              subtitle={eda.timeSeriesMining.acfAvailable ? 'Sample ACF; PACF via Levinson–Durbin recursion' : 'Not estimable: at least 4 finite, non-constant target observations are required'}
              option={acfOption}
              height={280}
              darkMode={darkMode}
            />
            <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
              <h2 className="text-sm font-semibold font-display text-slate-900 dark:text-slate-100">
                Target-Value Terciles (F4) & Univariate Associations (F8)
              </h2>
              <div className="grid grid-cols-3 gap-3 text-xs tabular-nums">
                {eda.clustering.regimeMeans.map((rm) => (
                  <div key={rm.regime} className="border border-slate-200 dark:border-slate-800 rounded p-2.5">
                    <div className="font-medium text-slate-800 dark:text-slate-200">{rm.label}</div>
                    <div className="font-mono text-base font-bold mt-1">{rm.targetMean}</div>
                    <div className="text-[11px] text-slate-500">n = {rm.count}</div>
                  </div>
                ))}
              </div>
              <div className="text-xs text-slate-500 pt-1">
                Ranked by univariate 8-bin mutual-information estimate (not model importance or consensus); fewer than 8 paired observations or constant inputs are not ranked:
              </div>
              <div className="space-y-1.5 text-xs">
                {eda.featureRelevance.map((fr) => (
                  <div key={fr.feature} className="flex items-center justify-between font-mono border-b border-slate-100 dark:border-slate-800/70 pb-1">
                    <span>{fr.miRank === null ? '—' : `#${fr.miRank}`} {fr.feature}</span>
                    <span>MI₈={fr.miScore ?? 'not computed'} · |Pearson r|={fr.absolutePearson ?? 'not computed'}</span>
                  </div>
                ))}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-400 pt-2">
                Anomaly Ensemble Voting (F5): {eda.anomalies.flaggedIndices.length} points flagged (incl. {eda.anomalies.autoencoderFlagCount} bottleneck autoencoder votes) under Action Policy{' '}
                <span className="font-mono">{eda.anomalies.policyApplied}</span>.
                {eda.timeSeriesMining.changePointTimestamp && (
                  <span className="block mt-1">
                    Structural Change-Point (F7/T9): {eda.timeSeriesMining.changePointTimestamp.slice(0, 10)} (point estimate only; no confidence interval computed)
                  </span>
                )}
              </div>
            </section>
          </div>

          {eda.regimeRules.length > 0 && (
            <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-sm font-semibold font-display">
                Target-Tercile Association Rules (F6 Data Mining)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left tabular-nums">
                  <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                    <tr>
                      <th className="px-3 py-2">Association Rule</th>
                      <th className="px-3 py-2 text-right">Support %</th>
                      <th className="px-3 py-2 text-right">Confidence %</th>
                      <th className="px-3 py-2 text-right">Lift</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                    {eda.regimeRules.map((rr, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-2 font-mono">{rr.rule}</td>
                        <td className="px-3 py-2 text-right font-mono">{rr.supportPct.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right font-mono">{rr.confidencePct.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right font-mono">{rr.lift.toFixed(2)}×</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <details className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4">
            <summary className="text-sm font-semibold cursor-pointer">Metric methods and assumptions</summary>
            <ul className="mt-3 list-disc pl-5 space-y-2 text-xs text-slate-600 dark:text-slate-400">
              {eda.methodAssumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}
            </ul>
          </details>
        </div>
      )}

      {subTab === 'causal' && eda && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-5 space-y-4">
          <h2 className="text-sm font-semibold font-display text-slate-900 dark:text-slate-100">
            Causal M&V Mode — IPMVP Option C/D & T14 Balance Diagnostics
          </h2>
          {!eda.causalMv.available ? (
            <p className="text-xs text-slate-500">
              {eda.causalMv.interpretation} Assign a column with role <span className="font-mono">group</span> in Step 1 to unlock Causal M&V.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-xs tabular-nums">
                <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
                  <div className="text-slate-500">Group Column</div>
                  <div className="text-base font-mono font-bold mt-1">{eda.causalMv.groupColumn}</div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
                  <div className="text-slate-500">Two-Way FE DiD Effect</div>
                  <div className="text-base font-mono font-bold mt-1">
                    {eda.causalMv.didEstimate} ± {(1.96 * (eda.causalMv.didSe ?? 0)).toFixed(2)}
                  </div>
                  <div className="text-[11px] text-slate-500">p = {eda.causalMv.didPValue}</div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
                  <div className="text-slate-500">Pre-Treatment Covariate SMD</div>
                  <div className="text-base font-mono font-bold mt-1">
                    {eda.causalMv.smdBefore ?? 'not computed'}
                  </div>
                  <div className="text-[11px] text-slate-500">No matching weights applied; after-match SMD is not claimed.</div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
                  <div className="text-slate-500">Refutation & Parallel Trends</div>
                  <div className="text-base font-mono font-bold mt-1">
                    PT p={eda.causalMv.parallelTrendsP} · Placebo p={eda.causalMv.placeboRefutationP}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {eda.causalMv.parallelTrendsMethod === 'linear_pretrend_hac_fallback'
                      ? 'Linear pre-trend HAC fallback'
                      : eda.causalMv.parallelTrendsMethod === 'event_study_leads_joint_hac'
                        ? 'Joint event-study lead HAC test'
                        : 'Pre-trend method unavailable'}
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300">{eda.causalMv.interpretation}</p>
              {(eda.causalMv.eventStudy ?? []).length > 0 && (
                <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-left text-slate-500">
                      <tr>
                        <th className="px-3 py-2">Event time (periods)</th>
                        <th className="px-3 py-2 text-right">TWFE estimate</th>
                        <th className="px-3 py-2 text-right">HAC SE</th>
                        <th className="px-3 py-2 text-right">p-value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {(eda.causalMv.eventStudy ?? []).map((period) => (
                        <tr key={period.relativePeriod}>
                          <td className="px-3 py-2 font-mono">{period.relativePeriod}</td>
                          <td className="px-3 py-2 text-right font-mono">{period.estimate.toFixed(3)}</td>
                          <td className="px-3 py-2 text-right font-mono">{period.standardError?.toFixed(3) ?? '—'}</td>
                          <td className="px-3 py-2 text-right font-mono">{period.pValue?.toExponential(2) ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
};
