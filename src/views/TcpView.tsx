import React, { useMemo, useState } from 'react';
import {
  ActionPolicy,
  CorrectionFamilyScope,
  DatasetState,
  DecisionRule,
  EffortProfile,
  ExpectedSign,
  GateRole,
  MultipleTestingMethod,
  StatisticalTestResult,
  TcpConfig,
  TestFamilyId,
} from '../engine/types';
import { reevaluateTestResults } from '../engine/stats';
import { AlertTriangle, Lock, Play, RefreshCw, ShieldCheck } from 'lucide-react';

interface TcpViewProps {
  dataset: DatasetState;
  activeTarget: string;
  tcp: TcpConfig;
  existingTests: StatisticalTestResult[];
  onUpdateTcp: (next: TcpConfig, logDetail: string) => void;
  onToggleScopeMatrix: (target: string, colName: string, famId: TestFamilyId) => void;
  scopeMatrixByTarget: Record<string, Record<string, TestFamilyId[]>>;
  onLockAndRunAnalysis: () => void;
}

export const TcpView: React.FC<TcpViewProps> = ({
  dataset,
  activeTarget,
  tcp,
  existingTests,
  onUpdateTcp,
  onToggleScopeMatrix,
  scopeMatrixByTarget,
  onLockAndRunAnalysis,
}) => {
  const [selectedFamilyId, setSelectedFamilyId] = useState<TestFamilyId>('T4');
  const [whatIfAlpha, setWhatIfAlpha] = useState<number>(tcp.alpha);
  const [whatIfCorr, setWhatIfCorr] = useState<MultipleTestingMethod>(tcp.correctionMethod);
  const [whatIfRule, setWhatIfRule] = useState<DecisionRule>(tcp.decisionRule);

  const predictors = dataset.columns.filter((c) => c.role === 'predictor' || c.role === 'static_factor');
  const familyList = Object.values(tcp.families);
  const selectedFam = tcp.families[selectedFamilyId];
  const totalCostMs = familyList.filter((f) => f.enabled).reduce((a, f) => a + f.costEstimateMs, 0);

  // Guard rails (TCP-11)
  const guardRailWarnings = useMemo(() => {
    const warns: string[] = [];
    if (tcp.alpha > 0.1) warns.push(`High α=${tcp.alpha} (> 0.10) increases Type I false-positive risk (TCP-11).`);
    if (tcp.correctionMethod === 'none' && predictors.length >= 4) {
      warns.push('Multiple-testing correction is set to NONE across multi-variable families; Benjamini-Hochberg or Holm recommended.');
    }
    if (dataset.rows.length > 5000 && tcp.decisionRule === 'p_only') {
      warns.push('n > 5,000 with p_only rule: tiny trivial effects will appear significant; prefer p_and_effect_size (TC-8).');
    }
    const grangerOn = tcp.families.T7?.enabled;
    const t5On = tcp.families.T5?.enabled;
    if (grangerOn && !t5On) {
      warns.push('T7 (Granger/Multivariate) relies on T5 (Stationarity) checks which are currently disabled.');
    }
    return warns;
  }, [tcp, predictors.length, dataset.rows.length]);

  // TCP-6 What-If Re-evaluation without recomputing test statistics
  const whatIfDiff = useMemo(() => {
    if (existingTests.length === 0) return [];
    const simTcp: TcpConfig = {
      ...tcp,
      alpha: whatIfAlpha,
      correctionMethod: whatIfCorr,
      decisionRule: whatIfRule,
    };
    const reeval = reevaluateTestResults(existingTests, simTcp);
    return existingTests
      .map((orig, i) => ({
        test: orig,
        newDecision: reeval[i].decision,
        newPAdj: reeval[i].pAdjusted,
        flipped: orig.decision !== reeval[i].decision,
      }))
      .filter((d) => d.flipped);
  }, [existingTests, tcp, whatIfAlpha, whatIfCorr, whatIfRule]);

  const setAlphaPreset = (preset: TcpConfig['alphaPreset'], val: number) => {
    onUpdateTcp(
      { ...tcp, alphaPreset: preset, alpha: val, mode: 'USER_OVERRIDE' },
      `Set global α=${val} (${preset})`
    );
    setWhatIfAlpha(val);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Test Configuration & Decision Policy (TCP)
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Configure significance, corrections, expected signs, and action policies prior to running diagnostics & modeling (PIPE-1 / TCP-1..13).
          </p>
        </div>

        <button
          type="button"
          onClick={onLockAndRunAnalysis}
          className="px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          {tcp.preRegistered ? <Play className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
          {tcp.preRegistered ? 'Run Diagnostics & Modeling' : 'Lock Pre-Registration & Run Analysis'}
        </button>
      </div>

      {/* Pre-Registration & Guard Rail Status */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-3 text-xs">
        <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
          <ShieldCheck className="w-4 h-4 text-sky-600 shrink-0" aria-hidden="true" />
          <span>
            Status:{' '}
            <strong className="font-mono">
              {tcp.preRegistered
                ? tcp.postHocModified
                  ? 'post_hoc (modified after results)'
                  : `pre_registered (${tcp.preRegistrationHash?.slice(0, 10)})`
                : 'Draft (accepting locks pre-registration)'}
            </strong>
          </span>
        </div>
        <div className="font-mono text-slate-500 dark:text-slate-400">
          Estimated T-suite runtime: ~{(totalCostMs / 1000).toFixed(2)}s · Mode: {tcp.mode}
        </div>
      </div>

      {guardRailWarnings.length > 0 && (
        <div
          role="alert"
          className="border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 rounded-lg p-3 text-xs text-amber-900 dark:text-amber-200 space-y-1"
        >
          <div className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            Statistical Guard Rails (TCP-11)
          </div>
          {guardRailWarnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}

      {/* Global Settings (TCP-1 / AUTO-6) */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
          Global Inferential & Effort Policy
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div>
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Significance Level (α = {tcp.alpha})
            </span>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ['strict_0.01', 'Strict 0.01', 0.01],
                  ['standard_0.05', 'Std 0.05', 0.05],
                  ['exploratory_0.10', 'Expl 0.10', 0.1],
                ] as const
              ).map(([key, label, val]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAlphaPreset(key, val)}
                  className={`px-2 py-1 rounded border text-[11px] font-mono ${
                    tcp.alpha === val
                      ? 'bg-sky-700 text-white border-sky-700'
                      : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="number"
              min={0.001}
              max={0.2}
              step={0.005}
              aria-label="Custom alpha value"
              value={tcp.alpha}
              onChange={(e) => {
                const v = Math.min(0.2, Math.max(0.001, Number(e.target.value) || 0.05));
                setAlphaPreset('custom', v);
              }}
              className="mt-2 w-full px-2.5 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
            />
          </div>

          <label className="block">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Confidence Level & Conformal UQ
            </span>
            <select
              value={tcp.confidenceLevel}
              onChange={(e) =>
                onUpdateTcp(
                  { ...tcp, confidenceLevel: Number(e.target.value), mode: 'USER_OVERRIDE' },
                  `Set confidence level=${e.target.value}`
                )
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
            >
              <option value={0.8}>80% (α_uq = 0.20)</option>
              <option value={0.9}>90% (α_uq = 0.10)</option>
              <option value={0.95}>95% (Default)</option>
              <option value={0.99}>99% (Strict)</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Multiple-Testing Correction
            </span>
            <select
              value={tcp.correctionMethod}
              onChange={(e) => {
                const v = e.target.value as MultipleTestingMethod;
                onUpdateTcp({ ...tcp, correctionMethod: v, mode: 'USER_OVERRIDE' }, `Set correction=${v}`);
                setWhatIfCorr(v);
              }}
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="bh">Benjamini–Hochberg (FDR)</option>
              <option value="holm">Holm–Bonferroni (FWER)</option>
              <option value="bonferroni">Bonferroni</option>
              <option value="by">Benjamini–Yekutieli</option>
              <option value="none">None (Raw p-values)</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Correction Family Scope
            </span>
            <select
              value={tcp.correctionScope}
              onChange={(e) =>
                onUpdateTcp(
                  { ...tcp, correctionScope: e.target.value as CorrectionFamilyScope, mode: 'USER_OVERRIDE' },
                  `Set correction scope=${e.target.value}`
                )
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="per_test_per_target">Per Test Family × Per Target (Default)</option>
              <option value="per_target">Per Target</option>
              <option value="per_variable">Per Variable</option>
              <option value="global">Global</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Decision Rule (TCP-12)
            </span>
            <select
              value={tcp.decisionRule}
              onChange={(e) => {
                const v = e.target.value as DecisionRule;
                onUpdateTcp({ ...tcp, decisionRule: v, mode: 'USER_OVERRIDE' }, `Set decision rule=${v}`);
                setWhatIfRule(v);
              }}
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="p_and_effect_size">p_adj &lt; α AND Effect Size (Default)</option>
              <option value="p_only">p_adj &lt; α only</option>
              <option value="ci_based">Confidence Interval excludes 0</option>
              <option value="equivalence">Equivalence (TOST margin)</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Effort Profile (AUTO-6)
            </span>
            <select
              value={tcp.effortProfile}
              onChange={(e) =>
                onUpdateTcp(
                  { ...tcp, effortProfile: e.target.value as EffortProfile, mode: 'USER_OVERRIDE' },
                  `Set effort profile=${e.target.value}`
                )
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="fast">Fast Mode (Exploratory, reduced tests/HPO)</option>
              <option value="standard">Standard Mode (Balanced)</option>
              <option value="thorough">Thorough Mode (Final baseline)</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Outlier Action Policy (DAT-8)
            </span>
            <select
              value={tcp.outlierActionPolicy}
              onChange={(e) =>
                onUpdateTcp(
                  { ...tcp, outlierActionPolicy: e.target.value as ActionPolicy, mode: 'USER_OVERRIDE' },
                  `Set outlier Action Policy=${e.target.value}`
                )
              }
              className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="flag_only">flag_only (Default, safe)</option>
              <option value="ask_user">ask_user (Prompt before adjustment)</option>
              <option value="auto_apply">auto_apply (Logged robust winsorize)</option>
            </select>
          </label>
        </div>
      </section>

      {/* Test Selection Tree + Per-Test Parameter Panel (TCP-2 / TCP-3 / TCP-5) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <section className="xl:col-span-7 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
              Test Catalog Selection Tree (T1–T14)
            </h2>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/70 max-h-[380px] overflow-y-auto">
            {familyList.map((fam) => (
              <div
                key={fam.id}
                className={`px-4 py-2.5 flex items-center justify-between gap-3 text-xs ${
                  selectedFamilyId === fam.id ? 'bg-sky-50/70 dark:bg-sky-950/30' : ''
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    aria-label={`Enable ${fam.id} ${fam.name}`}
                    checked={fam.enabled}
                    onChange={(e) => {
                      const nextFamilies = {
                        ...tcp.families,
                        [fam.id]: { ...fam, enabled: e.target.checked },
                      };
                      onUpdateTcp(
                        { ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' },
                        `${e.target.checked ? 'Enabled' : 'Disabled'} ${fam.id}`
                      );
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedFamilyId(fam.id)}
                    className="text-left min-w-0"
                  >
                    <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                      <span className="font-mono font-semibold mr-1.5">{fam.id}</span>
                      {fam.name}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {fam.phase} · ~{fam.costEstimateMs}ms · Gate: {fam.gateRole}
                    </div>
                  </button>
                </div>
                <span className="font-mono text-[11px] text-slate-500 shrink-0">
                  {fam.enabled ? 'Active' : 'not run (user)'}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Per-Test Parameter Panel (TCP-2) */}
        <section className="xl:col-span-5 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3 text-xs">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
              {selectedFam.id}: {selectedFam.name}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{selectedFam.whyKeepHint}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-slate-600 dark:text-slate-400 block mb-1">Gate Role</span>
              <select
                value={selectedFam.gateRole}
                onChange={(e) => {
                  const nextFamilies = {
                    ...tcp.families,
                    [selectedFam.id]: { ...selectedFam, gateRole: e.target.value as GateRole },
                  };
                  onUpdateTcp({ ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' }, `Set ${selectedFam.id} gate=${e.target.value}`);
                }}
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="informational">informational</option>
                <option value="warning">warning</option>
                <option value="gating">gating</option>
              </select>
            </label>

            <label className="block">
              <span className="text-slate-600 dark:text-slate-400 block mb-1">Alternative</span>
              <select
                value={selectedFam.alternative}
                onChange={(e) => {
                  const nextFamilies = {
                    ...tcp.families,
                    [selectedFam.id]: { ...selectedFam, alternative: e.target.value as 'two-sided' | 'greater' | 'less' },
                  };
                  onUpdateTcp({ ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' }, `Set ${selectedFam.id} alternative`);
                }}
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="two-sided">two-sided</option>
                <option value="greater">greater</option>
                <option value="less">less</option>
              </select>
            </label>

            <label className="block">
              <span className="text-slate-600 dark:text-slate-400 block mb-1">Min Sample Size (n)</span>
              <input
                type="number"
                min={5}
                max={200}
                value={selectedFam.minSampleSize}
                onChange={(e) => {
                  const nextFamilies = {
                    ...tcp.families,
                    [selectedFam.id]: { ...selectedFam, minSampleSize: Math.max(5, Number(e.target.value) || 12) },
                  };
                  onUpdateTcp({ ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' }, `Set ${selectedFam.id} min n`);
                }}
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </label>

            <label className="block">
              <span className="text-slate-600 dark:text-slate-400 block mb-1">Effect Threshold</span>
              <input
                type="number"
                step={0.05}
                min={0.01}
                max={2}
                value={selectedFam.effectThresholdSmall}
                onChange={(e) => {
                  const nextFamilies = {
                    ...tcp.families,
                    [selectedFam.id]: { ...selectedFam, effectThresholdSmall: Number(e.target.value) || 0.15 },
                  };
                  onUpdateTcp({ ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' }, `Set ${selectedFam.id} effect threshold`);
                }}
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </label>

            <label className="block">
              <span className="text-slate-600 dark:text-slate-400 block mb-1">Max Lags Rule</span>
              <select
                value={selectedFam.maxLagsRule}
                onChange={(e) => {
                  const nextFamilies = {
                    ...tcp.families,
                    [selectedFam.id]: { ...selectedFam, maxLagsRule: e.target.value as 'schwert' | 'aic' | 'bic' | 'fixed' },
                  };
                  onUpdateTcp({ ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' }, `Set ${selectedFam.id} lag rule`);
                }}
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="schwert">Schwert rule</option>
                <option value="aic">AIC</option>
                <option value="bic">BIC</option>
                <option value="fixed">Fixed lags</option>
              </select>
            </label>

            <label className="block">
              <span className="text-slate-600 dark:text-slate-400 block mb-1">Bootstrap Replicates</span>
              <input
                type="number"
                min={200}
                step={100}
                value={selectedFam.bootstrapReplicates}
                onChange={(e) => {
                  const nextFamilies = {
                    ...tcp.families,
                    [selectedFam.id]: { ...selectedFam, bootstrapReplicates: Math.max(200, Number(e.target.value) || 1000) },
                  };
                  onUpdateTcp({ ...tcp, families: nextFamilies, mode: 'USER_OVERRIDE' }, `Set ${selectedFam.id} bootstrap reps`);
                }}
                className="w-full px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
            </label>
          </div>
        </section>
      </div>

      {/* Expected Sign Editor (TCP-4) + Scope Matrix (TCP-8) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
            Expected-Sign & Monotonicity Constraints for {activeTarget} (TCP-4)
          </h2>
          <div className="space-y-2 text-xs">
            {predictors.map((p) => {
              const curSign = tcp.expectedSignsByTarget[activeTarget]?.[p.name] ?? 'free';
              return (
                <div key={p.name} className="flex items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800/70 pb-1.5">
                  <span className="font-mono text-slate-800 dark:text-slate-200">{p.name}</span>
                  <select
                    aria-label={`Expected sign for ${p.name}`}
                    value={curSign}
                    onChange={(e) => {
                      const nextSigns = {
                        ...tcp.expectedSignsByTarget,
                        [activeTarget]: {
                          ...(tcp.expectedSignsByTarget[activeTarget] ?? {}),
                          [p.name]: e.target.value as ExpectedSign,
                        },
                      };
                      onUpdateTcp(
                        { ...tcp, expectedSignsByTarget: nextSigns, mode: 'USER_OVERRIDE' },
                        `Set expected sign ${activeTarget}.${p.name}=${e.target.value}`
                      );
                    }}
                    className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="+">+ (Positive)</option>
                    <option value="-">− (Negative)</option>
                    <option value="free">free (Unconstrained)</option>
                    <option value="non_monotonic">non_monotonic allowed</option>
                  </select>
                </div>
              );
            })}
          </div>
        </section>

        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3 overflow-x-auto">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
            Variables × Test-Families Scope Matrix (TCP-8)
          </h2>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="py-1.5 text-left">Predictor</th>
                {(['T1', 'T2', 'T4', 'T7'] as TestFamilyId[]).map((fid) => (
                  <th key={fid} className="py-1.5 text-center font-mono">
                    {fid}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {predictors.map((p) => {
                const scoped = scopeMatrixByTarget[activeTarget]?.[p.name] ?? [];
                return (
                  <tr key={p.name}>
                    <td className="py-1.5 font-mono text-slate-800 dark:text-slate-200">{p.name}</td>
                    {(['T1', 'T2', 'T4', 'T7'] as TestFamilyId[]).map((fid) => (
                      <td key={fid} className="py-1.5 text-center">
                        <input
                          type="checkbox"
                          aria-label={`Scope ${p.name} ${fid}`}
                          checked={scoped.includes(fid)}
                          onChange={() => onToggleScopeMatrix(activeTarget, p.name, fid)}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      {/* Post-Run Instant What-If Re-Evaluation Panel (TCP-6) */}
      {existingTests.length > 0 && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display inline-flex items-center gap-1.5">
                <RefreshCw className="w-4 h-4 text-sky-600" aria-hidden="true" />
                What-If Decision Re-Evaluation (Zero Recompute · TCP-6)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Adjust α, correction, or decision rule to inspect flipped conclusions using cached statistics & raw p-values.
              </p>
            </div>
            <div className="text-xs font-mono font-semibold text-sky-700 dark:text-sky-400">
              {whatIfDiff.length} decision(s) flip under trial policy
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <label className="block">
              <span className="text-slate-500 block mb-1">Trial α</span>
              <select
                aria-label="What-if trial alpha"
                value={whatIfAlpha}
                onChange={(e) => setWhatIfAlpha(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              >
                <option value={0.001}>0.001</option>
                <option value={0.01}>0.01</option>
                <option value={0.05}>0.05</option>
                <option value={0.1}>0.10</option>
              </select>
            </label>
            <label className="block">
              <span className="text-slate-500 block mb-1">Trial Correction</span>
              <select
                aria-label="What-if trial correction"
                value={whatIfCorr}
                onChange={(e) => setWhatIfCorr(e.target.value as MultipleTestingMethod)}
                className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="none">none</option>
                <option value="bonferroni">bonferroni</option>
                <option value="holm">holm</option>
                <option value="bh">bh</option>
                <option value="by">by</option>
              </select>
            </label>
            <label className="block">
              <span className="text-slate-500 block mb-1">Trial Rule</span>
              <select
                aria-label="What-if trial rule"
                value={whatIfRule}
                onChange={(e) => setWhatIfRule(e.target.value as DecisionRule)}
                className="w-full px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="p_and_effect_size">p_and_effect_size</option>
                <option value="p_only">p_only</option>
                <option value="ci_based">ci_based</option>
                <option value="equivalence">equivalence</option>
              </select>
            </label>
          </div>

          {whatIfDiff.length > 0 && (
            <div className="overflow-x-auto border-t border-slate-100 dark:border-slate-800 pt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="py-1">Test</th>
                    <th className="py-1">Variable</th>
                    <th className="py-1">Current Decision</th>
                    <th className="py-1">What-If Decision</th>
                    <th className="py-1 text-right">Trial p_adj</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                  {whatIfDiff.map((d) => (
                    <tr key={d.test.id}>
                      <td className="py-1.5 font-medium">{d.test.testName}</td>
                      <td className="py-1.5 font-mono">{d.test.variable}</td>
                      <td className="py-1.5 font-mono">{d.test.decision}</td>
                      <td className="py-1.5 font-mono font-semibold text-amber-700 dark:text-amber-400">
                        {d.newDecision}
                      </td>
                      <td className="py-1.5 text-right font-mono">{d.newPAdj?.toExponential(2) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
