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
      { key: 'testName', header: 'Test', width: 225 },
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
            Pre-model tests (T1–T9, T13, T14), F1–F9 EDA profiling, Data Quality Score, and Causal M&V balance.
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

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          {(
            [
              ['tests', `Tests T1–T14 (${tests.length})`],
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

      {/* KPI Summary Strip */}
      {eda && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 tabular-nums">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Data Quality Score (F9)</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {eda.dataQuality.overallScore} / 100
            </div>
            <div className="text-[11px] text-slate-500">
              Completeness {eda.dataQuality.completeness.score}%
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Significant Tests</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {sigCount} / {tests.length}
            </div>
            <div className="text-[11px] text-slate-500">{flipCount} α-sensitive flips</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Optimal Degree-Day Bases</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {eda.timeSeriesMining.optimalBaseTempHeating}°C / {eda.timeSeriesMining.optimalBaseTempCooling}°C
            </div>
            <div className="text-[11px] text-slate-500">Heating / Cooling change-points</div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Regime Stability (ARI)</div>
            <div className="text-xl font-bold font-mono text-slate-900 dark:text-slate-100 mt-0.5">
              {eda.clustering.bootstrapAri}
            </div>
            <div className="text-[11px] text-slate-500">
              Silhouette {eda.clustering.silhouette} · k={eda.clustering.k}
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
            subtitle={`KMO=${eda.pca.kmo} · Bartlett p=${eda.pca.bartlettP.toExponential(1)}`}
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
              subtitle="Drives purge gap & block-bootstrap length (TC-2 / VAL-2)"
              option={acfOption}
              height={280}
              darkMode={darkMode}
            />
            <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
              <h2 className="text-sm font-semibold font-display text-slate-900 dark:text-slate-100">
                Operating Regimes (F4) & Feature Relevance Consensus (F8)
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
                Feature consensus agreement (Kendall&apos;s W = {eda.kendallW}):
              </div>
              <div className="space-y-1.5 text-xs">
                {eda.featureRelevance.map((fr) => (
                  <div key={fr.feature} className="flex items-center justify-between font-mono border-b border-slate-100 dark:border-slate-800/70 pb-1">
                    <span>#{fr.consensusRank} {fr.feature}</span>
                    <span>MI={fr.miScore} · Perm={fr.permImportance} · Stab={fr.stabilityFreq}</span>
                  </div>
                ))}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-400 pt-2">
                Anomaly Ensemble Voting (F5): {eda.anomalies.flaggedIndices.length} points flagged under Action Policy <span className="font-mono">{eda.anomalies.policyApplied}</span>.
                {eda.timeSeriesMining.changePointTimestamp && (
                  <span className="block mt-1">
                    Structural Change-Point (F7/T9): {eda.timeSeriesMining.changePointTimestamp.slice(0, 10)} (CI: {eda.timeSeriesMining.changePointCiLow?.slice(0, 10)} to {eda.timeSeriesMining.changePointCiHigh?.slice(0, 10)})
                  </span>
                )}
              </div>
            </section>
          </div>
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
                  <div className="text-slate-500">Adjusted DiD Effect</div>
                  <div className="text-base font-mono font-bold mt-1">
                    {eda.causalMv.didEstimate} ± {(1.96 * (eda.causalMv.didSe ?? 0)).toFixed(2)}
                  </div>
                  <div className="text-[11px] text-slate-500">p = {eda.causalMv.didPValue}</div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
                  <div className="text-slate-500">Covariate SMD (Before → After)</div>
                  <div className="text-base font-mono font-bold mt-1">
                    {eda.causalMv.smdBefore} → {eda.causalMv.smdAfter}
                  </div>
                  <div className="text-[11px] text-slate-500">Kernel balancing reduction</div>
                </div>
                <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
                  <div className="text-slate-500">Refutation & Parallel Trends</div>
                  <div className="text-base font-mono font-bold mt-1">
                    PT p={eda.causalMv.parallelTrendsP} · Placebo p={eda.causalMv.placeboRefutationP}
                  </div>
                </div>
              </div>
              <p className="text-xs text-slate-700 dark:text-slate-300">{eda.causalMv.interpretation}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
