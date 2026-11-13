import React, { useMemo, useState } from 'react';
import {
  LockedBaseline,
  ModelCandidateResult,
  TargetModelingBundle,
  ThresholdProfileId,
  WeightProfile,
} from '../engine/types';
import { KatexFormula } from '../components/KatexFormula';
import { EChartBox } from '../components/EChartBox';
import { AlertTriangle, CheckCircle2, Copy, Lock, ShieldCheck } from 'lucide-react';

interface ModelingViewProps {
  targets: string[];
  activeTarget: string;
  onSelectTarget: (target: string) => void;
  modelingByTarget: Record<string, TargetModelingBundle>;
  lockedBaselines: Record<string, LockedBaseline>;
  thresholdProfile: ThresholdProfileId;
  weightProfile: WeightProfile;
  darkMode: boolean;
  onReRunTargetModeling: (target: string, profile: ThresholdProfileId, wProf: WeightProfile) => void;
  onLockBaseline: (target: string, candidate: ModelCandidateResult, note: string) => void;
  onProceedToMonitoring: () => void;
}

export const ModelingView: React.FC<ModelingViewProps> = ({
  targets,
  activeTarget,
  onSelectTarget,
  modelingByTarget,
  lockedBaselines,
  thresholdProfile,
  weightProfile,
  darkMode,
  onReRunTargetModeling,
  onLockBaseline,
  onProceedToMonitoring,
}) => {
  const bundle = modelingByTarget[activeTarget];
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [lockNote, setLockNote] = useState('');
  const [ackWarning, setAckWarning] = useState(false);
  const [copiedFormulaId, setCopiedFormulaId] = useState<string | null>(null);
  const [registerTab, setRegisterTab] = useState<'top5' | 'not_shortlisted' | 'rejected' | 'calibration'>('top5');

  const topModels = bundle?.top5 ?? [];
  const effectiveSelectedId =
    topModels.some((m) => m.id === selectedModelId) ? selectedModelId : topModels[0]?.id ?? '';
  const activeModel = bundle?.allModels.find((m) => m.id === effectiveSelectedId) ?? topModels[0];
  const locked = lockedBaselines[activeTarget];
  const noneQualified = bundle && bundle.top5.every((m) => !m.qualified);

  const oofChartOption = useMemo(() => {
    if (!activeModel) return {};
    const xs = activeModel.oofPredictions.map((p) => p.timestamp.slice(0, 10));
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { top: 0, itemWidth: 14, textStyle: { fontSize: 11 } },
      grid: { left: 56, right: 20, top: 52, bottom: 36 },
      xAxis: { type: 'category' as const, data: xs },
      yAxis: { type: 'value' as const },
      series: [
        {
          name: 'Conformal Upper',
          type: 'line' as const,
          data: activeModel.oofPredictions.map((p) => p.upper),
          lineStyle: { opacity: 0.25, type: 'dashed' as const, color: '#0369A1' },
          showSymbol: false,
        },
        {
          name: 'Conformal Lower',
          type: 'line' as const,
          data: activeModel.oofPredictions.map((p) => p.lower),
          lineStyle: { opacity: 0.25, type: 'dashed' as const, color: '#0369A1' },
          showSymbol: false,
        },
        {
          name: 'OOF Predicted',
          type: 'line' as const,
          data: activeModel.oofPredictions.map((p) => p.predicted),
          lineStyle: { width: 2, color: '#0369A1' },
          showSymbol: false,
        },
        {
          name: 'Observed Actual',
          type: 'line' as const,
          data: activeModel.oofPredictions.map((p) => p.actual),
          lineStyle: { width: 1.5, color: '#D97706' },
          showSymbol: false,
        },
      ],
    };
  }, [activeModel]);

  if (!bundle) {
    return (
      <div className="p-8 border border-slate-200 dark:border-slate-800 rounded-lg text-center text-sm text-slate-500">
        No modeling results available for {activeTarget}. Run analysis from Step 3 (TCP).
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Modeling Portfolio, Top-5 Shortlist & Baseline Lock
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Independent per-target pipelines · Blocked CV with purge gap · Conformal UQ · Explicit formulas & surrogates (SC-1..10).
          </p>
        </div>

        <div className="flex items-center gap-2">
          {Object.keys(lockedBaselines).length > 0 && (
            <button
              type="button"
              onClick={onProceedToMonitoring}
              className="px-4 py-2 text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              Open Prediction & Drift Monitoring
            </button>
          )}
        </div>
      </div>

      {/* Multi-Target Selector & Scoring Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {targets.map((t) => {
            const isLocked = Boolean(lockedBaselines[t]);
            return (
              <button
                key={t}
                type="button"
                onClick={() => onSelectTarget(t)}
                className={`px-3 py-1.5 text-xs font-mono rounded-md transition-colors inline-flex items-center gap-1.5 ${
                  t === activeTarget
                    ? 'bg-sky-700 text-white font-semibold'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                }`}
              >
                {t}
                {isLocked && <Lock className="w-3 h-3" aria-hidden="true" />}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="inline-flex items-center gap-1.5">
            <span className="text-slate-500">Thresholds:</span>
            <select
              aria-label="Threshold Profile"
              value={thresholdProfile}
              onChange={(e) =>
                onReRunTargetModeling(activeTarget, e.target.value as ThresholdProfileId, weightProfile)
              }
              className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="ashrae14">ASHRAE 14 Aligned</option>
              <option value="iso50015">ISO 50015 Aligned</option>
              <option value="custom">Custom / General</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5">
            <span className="text-slate-500">Scoring Weights:</span>
            <select
              aria-label="Weight Profile"
              value={weightProfile}
              onChange={(e) =>
                onReRunTargetModeling(activeTarget, thresholdProfile, e.target.value as WeightProfile)
              }
              className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="balanced">balanced</option>
              <option value="interpretable">interpretable</option>
              <option value="accuracy_first">accuracy_first</option>
            </select>
          </label>
        </div>
      </div>

      {/* Pipeline Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 text-xs tabular-nums">
        <div>
          <div className="text-slate-500">Target Seed (MT-4)</div>
          <div className="font-mono font-bold text-base mt-0.5">{bundle.seed}</div>
          <div className="text-[11px] text-slate-500">Purge gap: {bundle.top5[0]?.purgeGapSteps ?? 2} steps</div>
        </div>
        <div>
          <div className="text-slate-500">Selected Features (VAL-6)</div>
          <div className="font-mono font-bold text-base mt-0.5">
            {bundle.selectedFeatures.length} / {bundle.candidatePool.length}
          </div>
          <div className="text-[11px] text-slate-500 truncate" title={bundle.selectedFeatures.join(', ')}>
            {bundle.selectedFeatures.join(', ')}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Top-1 Rank Stability (±20%)</div>
          <div className="font-mono font-bold text-base mt-0.5">{bundle.top5[0]?.rankStabilityPct ?? 0}%</div>
          <div className="text-[11px] text-slate-500">
            {bundle.t11WinnerVsRunnerUp ? `DM p=${bundle.t11WinnerVsRunnerUp.dmPValue}` : 'T11 check'}
          </div>
        </div>
        <div>
          <div className="text-slate-500">Locked Baseline</div>
          <div className="font-mono font-bold text-base mt-0.5">
            {locked ? `v${locked.version} · ${locked.modelName.slice(0, 18)}` : 'Not Locked'}
          </div>
          <div className="text-[11px] text-slate-500">
            {locked ? `SHA ${locked.artifactSha256.slice(0, 10)}` : 'Select model below to lock'}
          </div>
        </div>
      </div>

      {noneQualified && (
        <div role="alert" className="border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-lg p-3 text-xs text-amber-900 dark:text-amber-200 space-y-2">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            SC-9 Notice: No model met all acceptance thresholds; showing best available fallback.
          </div>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={ackWarning}
              onChange={(e) => setAckWarning(e.target.checked)}
            />
            <span>I acknowledge the threshold limitations before locking a fallback baseline.</span>
          </label>
        </div>
      )}

      {/* Register Switcher */}
      <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        {(
          [
            ['top5', `Top-5 Shortlist (${bundle.top5.length})`],
            ['not_shortlisted', `Not Shortlisted (${bundle.qualifiedNotShortlisted.length})`],
            ['rejected', `Rejected (${bundle.rejected.length})`],
            ['calibration', 'Conformal UQ & T12 Calibration'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setRegisterTab(id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              registerTab === id
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {registerTab === 'top5' && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Top-5 Cards with Radio Selection */}
          <div className="xl:col-span-7 space-y-3">
            {bundle.top5.map((m) => {
              const isSelected = m.id === effectiveSelectedId;
              return (
                <div
                  key={m.id}
                  className={`border rounded-lg p-4 bg-white dark:bg-slate-900 transition-colors ${
                    isSelected
                      ? 'border-sky-600 ring-1 ring-sky-600'
                      : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <label className="flex items-start gap-2.5 cursor-pointer min-w-0">
                      <input
                        type="radio"
                        name={`select-model-${activeTarget}`}
                        checked={isSelected}
                        onChange={() => setSelectedModelId(m.id)}
                        className="mt-1"
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
                          #{m.rank} · {m.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          {m.isParametric ? 'Parametric Closed-Form' : 'Non-Parametric + Global Surrogate'} · Params: {m.paramCount}
                          {m.indistinguishableFromTop1 && ' · Statistically indistinguishable from #1 (T11)'}
                        </div>
                      </div>
                    </label>
                    <div className="text-right font-mono shrink-0">
                      <div className="text-xs text-slate-500">Composite Score</div>
                      <div className="text-base font-bold text-sky-700 dark:text-sky-400">{m.compositeScore}</div>
                    </div>
                  </div>

                  {/* OOF Metrics with CI */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs tabular-nums">
                    <div>
                      <span className="text-slate-500 block">OOF CV(RMSE)</span>
                      <span className="font-mono font-semibold">{m.oofCvRmse.toFixed(2)}%</span>
                      <span className="block text-[10px] text-slate-400 font-mono">
                        [{m.oofCvRmseCi[0]}, {m.oofCvRmseCi[1]}]
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">OOF NMBE</span>
                      <span className="font-mono font-semibold">{m.oofNmbe.toFixed(2)}%</span>
                      <span className="block text-[10px] text-slate-400 font-mono">
                        [{m.oofNmbeCi[0]}, {m.oofNmbeCi[1]}]
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">OOF R²</span>
                      <span className="font-mono font-semibold">{m.oofR2.toFixed(3)}</span>
                      <span className="block text-[10px] text-slate-400 font-mono">
                        Holdout: {m.holdoutR2 !== null ? m.holdoutR2.toFixed(3) : 'N/A'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Conformal Coverage</span>
                      <span className="font-mono font-semibold">
                        {(m.conformalSummary.empiricalCoverage * 100).toFixed(1)}%
                      </span>
                      <span className="block text-[10px] text-slate-400 font-mono">
                        Width ±{(m.conformalSummary.meanWidth / 2).toFixed(1)}
                      </span>
                    </div>
                  </div>

                  {/* Representation: KaTeX formula OR Non-parametric Architecture + Surrogate (SC-7) */}
                  <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                    {m.isParametric && m.latexEquation ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>Explicit Parametric Equation (KaTeX)</span>
                          {m.excelFormula && (
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard?.writeText(m.excelFormula!);
                                setCopiedFormulaId(m.id);
                              }}
                              className="text-sky-700 dark:text-sky-400 hover:underline inline-flex items-center gap-1"
                            >
                              <Copy className="w-3 h-3" aria-hidden="true" />
                              {copiedFormulaId === m.id ? 'Excel Formula Copied' : 'Copy Excel Formula'}
                            </button>
                          )}
                        </div>
                        <KatexFormula latex={m.latexEquation} />
                      </div>
                    ) : (
                      <div className="text-xs space-y-1">
                        <div className="font-mono text-slate-700 dark:text-slate-300">{m.architectureSummary}</div>
                        {m.surrogateSummary && (
                          <div className="text-slate-500 dark:text-slate-400">
                            {m.surrogateSummary.description} Surrogate fidelity R² ={' '}
                            <span className="font-mono font-semibold">{m.surrogateSummary.fidelityR2.toFixed(3)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Column: Lock Baseline Panel + OOF Fit Chart */}
          <div className="xl:col-span-5 space-y-4">
            {activeModel && (
              <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
                <h2 className="text-sm font-semibold font-display text-slate-900 dark:text-slate-100">
                  Lock Immutable Baseline for {activeTarget} (SC-10)
                </h2>
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Selected: <strong className="text-slate-900 dark:text-slate-100">{activeModel.name}</strong>
                </p>
                <label className="block text-xs">
                  <span className="text-slate-500 block mb-1">Lock Rationale / Engineering Note</span>
                  <input
                    type="text"
                    value={lockNote}
                    onChange={(e) => setLockNote(e.target.value)}
                    placeholder="e.g., Selected 5P Change-Point aligned with ASHRAE 14 criteria"
                    className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </label>
                <button
                  type="button"
                  disabled={Boolean(noneQualified && !ackWarning)}
                  onClick={() => onLockBaseline(activeTarget, activeModel, lockNote)}
                  className="w-full py-2 px-4 text-xs font-semibold bg-sky-700 hover:bg-sky-800 disabled:opacity-40 text-white rounded-lg transition-colors inline-flex items-center justify-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5" aria-hidden="true" />
                  {locked ? `Re-Lock New Version (v${locked.version + 1})` : `Lock Baseline for ${activeTarget}`}
                </button>

                {locked && (
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-xs space-y-1">
                    <div className="font-semibold text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                      Model Card (v{locked.version} · SHA {locked.artifactSha256.slice(0, 10)})
                    </div>
                    <div className="text-slate-600 dark:text-slate-400">{locked.modelCard.intendedUse}</div>
                    <div className="text-slate-500 font-mono text-[11px]">{locked.modelCard.calibrationSummary}</div>
                  </div>
                )}
              </section>
            )}

            {activeModel && (
              <EChartBox
                title={`OOF Fit & Conformal Bands: ${activeModel.name}`}
                subtitle={activeModel.t10Summary.descriptiveOnlyNote ?? `DW=${activeModel.t10Summary.durbinWatson}, Ljung-Box p=${activeModel.t10Summary.ljungBoxP}`}
                option={oofChartOption}
                height={290}
                darkMode={darkMode}
              />
            )}
          </div>
        </div>
      )}

      {registerTab === 'not_shortlisted' && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-xs text-left tabular-nums">
            <thead className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2">Rank</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2 text-right">OOF CV(RMSE)</th>
                <th className="px-3 py-2 text-right">|NMBE|</th>
                <th className="px-3 py-2 text-right">R²</th>
                <th className="px-3 py-2 text-right">Score</th>
                <th className="px-3 py-2">Gap vs #1</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {bundle.qualifiedNotShortlisted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                    All qualified models fit inside the Top-5 shortlist.
                  </td>
                </tr>
              ) : (
                bundle.qualifiedNotShortlisted.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2 font-mono">#{m.rank}</td>
                    <td className="px-3 py-2 font-medium">{m.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{m.oofCvRmse.toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right font-mono">{Math.abs(m.oofNmbe).toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right font-mono">{m.oofR2.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right font-mono">{m.compositeScore}</td>
                    <td className="px-3 py-2 font-mono text-slate-500">
                      -{(bundle.top5[0].compositeScore - m.compositeScore).toFixed(2)} pts
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}

      {registerTab === 'rejected' && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-xs text-left tabular-nums">
            <thead className="bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Family</th>
                <th className="px-3 py-2 text-right">OOF CV(RMSE)</th>
                <th className="px-3 py-2 text-right">|NMBE|</th>
                <th className="px-3 py-2">Rejection Gate Reason (SC-1 / NN Gate)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {bundle.rejected.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No models were rejected by acceptance gates.
                  </td>
                </tr>
              ) : (
                bundle.rejected.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2 font-medium">{m.name}</td>
                    <td className="px-3 py-2 font-mono">{m.family}</td>
                    <td className="px-3 py-2 text-right font-mono">{m.oofCvRmse.toFixed(2)}%</td>
                    <td className="px-3 py-2 text-right font-mono">{Math.abs(m.oofNmbe).toFixed(2)}%</td>
                    <td className="px-3 py-2 text-red-700 dark:text-red-400">{m.rejectionReason}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}

      {registerTab === 'calibration' && activeModel && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-4 text-xs">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold font-display">
              Conformal UQ Calibration Report & T12 Tests ({activeModel.name})
            </h2>
            <span className="font-mono text-slate-500">{activeModel.conformalSummary.method}</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 tabular-nums">
            <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
              <div className="text-slate-500">Nominal Coverage</div>
              <div className="text-base font-mono font-bold mt-0.5">
                {(activeModel.conformalSummary.nominalCoverage * 100).toFixed(0)}%
              </div>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
              <div className="text-slate-500">Empirical Coverage</div>
              <div className="text-base font-mono font-bold mt-0.5">
                {(activeModel.conformalSummary.empiricalCoverage * 100).toFixed(1)}%
              </div>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
              <div className="text-slate-500">Winkler Score</div>
              <div className="text-base font-mono font-bold mt-0.5">{activeModel.conformalSummary.winklerScore}</div>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
              <div className="text-slate-500">T12 Kupiec POF p</div>
              <div className="text-base font-mono font-bold mt-0.5">{activeModel.conformalSummary.kupiecPofP}</div>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded p-3">
              <div className="text-slate-500">T12 Christoffersen p</div>
              <div className="text-base font-mono font-bold mt-0.5">{activeModel.conformalSummary.christoffersenCcP}</div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 tabular-nums">
            {activeModel.conformalSummary.regimeCoverage.map((rc) => (
              <div key={rc.regime} className="border border-slate-200 dark:border-slate-800 rounded p-3">
                <div className="font-medium">{rc.regime}</div>
                <div className="font-mono text-sm font-bold mt-1">{(rc.coverage * 100).toFixed(1)}%</div>
                <div className="text-[11px] text-slate-500">n = {rc.n}</div>
              </div>
            ))}
          </div>
          <p className="text-slate-500 inline-flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />
            Honesty notice (UQ-3): Exchangeability is violated in autocorrelated time series; coverage is empirical and approximate.
          </p>
        </section>
      )}
    </div>
  );
};
