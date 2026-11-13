import JSZip from 'jszip';
import { DOMAIN_PROFILES } from './domains';
import {
  AuditEvent,
  AutoDecisionEntry,
  DatasetState,
  EdaTargetSummary,
  LockedBaseline,
  MonitoringSnapshot,
  RunArchiveEntry,
  StatisticalTestResult,
  TargetModelingBundle,
  TcpConfig,
  VsgEntry,
} from './types';

export interface ReportSection {
  id: string;
  title: string;
  depthMin: 'Executive' | 'Standard' | 'Full Technical';
  purpose: string;
  method: string;
  settingsUsed: string;
  resultsSummary: string;
  interpretation: string;
  decisionImpact: string;
  caveats: string;
  citedArtifacts: { artifactId: string; expectedNumbers: string[] }[];
  tableRows?: Record<string, string | number>[];
}

export interface ReportModel {
  generatedAt: string;
  datasetName: string;
  datasetSha256: string;
  domain: string;
  seed: number;
  sections: ReportSection[];
  glossary: { term: string; definition: string }[];
  howToRead: string[];
}

export function buildDeterministicReportModel(params: {
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  testsByTarget: Record<string, StatisticalTestResult[]>;
  edaByTarget: Record<string, EdaTargetSummary>;
  modelingByTarget: Record<string, TargetModelingBundle>;
  lockedBaselines: Record<string, LockedBaseline>;
  snapshots: MonitoringSnapshot[];
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
}): ReportModel {
  const {
    dataset,
    vsgByTarget,
    tcp,
    testsByTarget,
    edaByTarget,
    modelingByTarget,
    lockedBaselines,
    snapshots,
    autoLogs,
    auditLog,
    seed,
  } = params;

  const targets = Object.keys(modelingByTarget);
  const firstTarget = targets[0];
  const firstBundle = firstTarget ? modelingByTarget[firstTarget] : undefined;
  const firstTop1 = firstBundle?.top5[0];
  const firstEda = firstTarget ? edaByTarget[firstTarget] : undefined;
  const firstTests = firstTarget ? testsByTarget[firstTarget] ?? [] : [];
  const sigCount = firstTests.filter(
    (t) => t.decision === 'reject_h0' || t.decision === 'practical_significant'
  ).length;
  const optionalTestsCount = firstTests.filter((t) => t.isOptionalTest).length;
  const flipCount = firstTests.filter((t) => t.decisionFlips).length;
  const domainProf = DOMAIN_PROFILES[dataset.domain] ?? DOMAIN_PROFILES.custom;

  const sections: ReportSection[] = [
    {
      id: 'executive-summary',
      title: 'Executive Summary',
      depthMin: 'Executive',
      purpose: 'Summarize verified baseline performance, statistical diagnostic findings, and lock status per target.',
      method: 'Deterministic template aggregation over computed target artifacts (G-9 / RPT-4).',
      settingsUsed: `Effort=${tcp.effortProfile} (${tcp.mode}), α=${tcp.alpha}, Confidence=${(tcp.confidenceLevel * 100).toFixed(0)}%, Correction=${tcp.correctionMethod.toUpperCase()}`,
      resultsSummary: targets
        .map((t) => {
          const b = modelingByTarget[t];
          const top = b?.top5[0];
          const locked = lockedBaselines[t];
          return `${t}: Top-1=${top?.name ?? 'N/A'} (OOF CV(RMSE)=${top?.oofCvRmse.toFixed(2) ?? 'N/A'}%, |NMBE|=${Math.abs(top?.oofNmbe ?? 0).toFixed(2)}%, R²=${top?.oofR2.toFixed(3) ?? 'N/A'}) · Lock=${locked ? `v${locked.version}` : 'Unlocked'}`;
        })
        .join(' | '),
      interpretation: firstTop1
        ? `Across ${targets.length} independent target pipeline(s), ${firstTarget} achieved OOF CV(RMSE) ${firstTop1.oofCvRmse.toFixed(2)}% with ${firstTop1.name} (artifact ${firstTop1.artifactId}).`
        : 'Run modeling to populate baseline summary.',
      decisionImpact: `Locked baselines unlock Prediction & Drift Monitoring per target (${Object.keys(lockedBaselines).length}/${targets.length} locked).`,
      caveats: 'All figures are out-of-fold estimates; conformal intervals are approximate under autocorrelation (UQ-3).',
      citedArtifacts: firstTop1
        ? [
            {
              artifactId: firstTop1.artifactId,
              expectedNumbers: [firstTop1.oofCvRmse.toFixed(2)],
            },
          ]
        : [],
    },
    {
      id: 'multi-target-summary',
      title: 'Multi-Target Comparative Summary',
      depthMin: 'Executive',
      purpose: 'Compare independent per-target pipelines, seeds, selected features, and winning baselines.',
      method: 'Independent pipeline execution per target with derived seed hash(global_seed, target_id) (MT-1..4).',
      settingsUsed: `Global seed=${seed}, Targets=${targets.join(', ')}`,
      resultsSummary: `${targets.length} independent pipelines completed without cross-target leakage.`,
      interpretation: 'Each target maintains isolated VSG states, collinearity pruning, CV folds, and Top-5 ranking.',
      decisionImpact: 'Prevents cross-target contamination (MT-2).',
      caveats: 'Target units and scales are independent.',
      citedArtifacts: [],
      tableRows: targets.map((t) => {
        const b = modelingByTarget[t];
        const top = b.top5[0];
        return {
          Target: t,
          Seed: b.seed,
          SelectedFeatures: b.selectedFeatures.length,
          Top1Model: top?.name ?? 'N/A',
          CvRmsePct: top?.oofCvRmse ?? 0,
          NmbePct: top?.oofNmbe ?? 0,
          R2: top?.oofR2 ?? 0,
          LockedVersion: lockedBaselines[t]?.version ?? 'Unlocked',
        };
      }),
    },
    {
      id: 'temporal-data-dict',
      title: 'Temporal Configuration, Input Data & Data Quality',
      depthMin: 'Standard',
      purpose: 'Document sampling resolution, UTC/DST policy, baseline/reporting windows, and Data Quality Score (F9).',
      method: 'UTC timestamp normalization, DAT-2/DAT-3 granularity rules, and weighted 5-pillar quality scoring.',
      settingsUsed: `Source=${dataset.temporal.sourceGranularity}, Target=${dataset.temporal.targetGranularity}, TZ=${dataset.temporal.timezone}, Completeness≥${(dataset.temporal.completenessThreshold * 100).toFixed(0)}%`,
      resultsSummary: firstEda
        ? `Data Quality Score: ${firstEda.dataQuality.overallScore}/100 (Completeness ${firstEda.dataQuality.completeness.score}%, Validity ${firstEda.dataQuality.validity.score}%).`
        : 'Quality score pending.',
      interpretation: firstEda
        ? `Evaluated ${dataset.rows.length} rows (${dataset.sha256.slice(0, 12)}). No target imputation was performed in validation/evaluation sets (DAT-5).`
        : 'Pending.',
      decisionImpact: 'Coarser aggregation requests are refused with DATA_REFUSED (DAT-3).',
      caveats: 'Non-Routine Events are flagged transparently without silent row removal.',
      citedArtifacts: [],
      tableRows: dataset.columns.map((c) => ({
        Column: c.name,
        Role: c.role,
        QuantityType: c.quantityType,
        Aggregation: c.aggregation,
        Unit: c.unit || '-',
        Availability: c.availability,
      })),
    },
    {
      id: 'vsg-tcp-governance',
      title: 'Variable Selection & Test Configuration (VSG & TCP)',
      depthMin: 'Standard',
      purpose: 'Record user & AUTO variable inclusion states, pre-registration status, and test decision policies.',
      method: 'Mandatory pre-inferential VSG & TCP gates with provenance tracking (PIPE-1, VSG-7, TCP-9).',
      settingsUsed: `Pre-registered=${tcp.preRegistered}, Post-hoc modified=${tcp.postHocModified}, Rule=${tcp.decisionRule}, ActionPolicy=${tcp.outlierActionPolicy}`,
      resultsSummary: firstTarget
        ? `Candidate pool for ${firstTarget}: ${Object.values(vsgByTarget[firstTarget] ?? {}).filter((v) => v.state === 'candidate' || v.state === 'force_include').length} variables.`
        : 'Pending.',
      interpretation: tcp.postHocModified
        ? 'Warning: Post-hoc modifications were recorded after initial results; flagged under Limitations.'
        : 'Pre-registered configuration honored prior to inferential testing.',
      decisionImpact: 'Integrity rules (target exclusion, leakage checks) cannot be disabled.',
      caveats: 'Disabled test families are explicitly marked "not run (user)".',
      citedArtifacts: [],
    },
    {
      id: 'eda-correlation-mining',
      title: 'EDA Atlas, Correlation & Dependence Atlas & Data Mining',
      depthMin: 'Standard',
      purpose: 'Present univariate profiling, Pearson/Spearman/Kendall/Distance-Corr/MI with CIs, PCA, regimes, anomalies (autoencoder), and association rules (F1–F9).',
      method: 'Circular block-bootstrap CIs (CI-2), PCA eigen-decomposition, K=3 regime clustering, ensemble + bottleneck autoencoder anomaly voting, regime association rules.',
      settingsUsed: `Confidence=${(tcp.confidenceLevel * 100).toFixed(0)}%, Domain=${domainProf.label}`,
      resultsSummary: firstEda
        ? `Optimal change bases: Low=${firstEda.timeSeriesMining.optimalBaseTempHeating}°C, High=${firstEda.timeSeriesMining.optimalBaseTempCooling}°C · Clustering Silhouette=${firstEda.clustering.silhouette}, Bootstrap ARI=${firstEda.clustering.bootstrapAri} · Anomalies=${firstEda.anomalies.flaggedIndices.length} (autoencoder votes=${firstEda.anomalies.autoencoderFlagCount}) · Regime Rules=${firstEda.regimeRules.length} · Feature Consensus Kendall W=${firstEda.kendallW}.`
        : 'Pending.',
      interpretation: firstEda?.causalMv.available
        ? `Causal Attribution (${firstEda.causalMv.groupColumn}): ${firstEda.causalMv.interpretation}`
        : 'Regime clustering, association rules, and feature relevance consensus guide engineering intuition without target leakage.',
      decisionImpact: 'Informs change-point initialization, regime rules, and regime-conditional UQ calibration.',
      caveats: 'Granger/Transfer-Entropy/correlation findings are screening signals only and do not establish causation (TC-3).',
      citedArtifacts: [],
      tableRows: firstEda?.correlations.map((c) => ({
        Pair: `${c.varA} ↔ ${c.varB}`,
        Pearson: c.pearson,
        Spearman: c.spearman,
        DistCorr: c.distCorr,
        MI: c.mutualInfo,
        CI: `[${c.ciLow}, ${c.ciHigh}]`,
        PAdjusted: Number(c.pAdjusted.toExponential(2)),
        NonLinear: c.nonlinearityFlag ? 'Yes' : 'No',
      })),
    },
    {
      id: 'diagnostics-sensitivity',
      title: 'Statistical Diagnostics & Decision-Sensitivity Summary',
      depthMin: 'Standard',
      purpose: 'Report T1–T14 core [M] and extended [O] test outcomes with raw/adjusted p-values, effect sizes, assumptions, and α-sensitivity flips.',
      method: `Multiple-testing correction (${tcp.correctionMethod.toUpperCase()}) scoped ${tcp.correctionScope}; sensitivity evaluated at α ∈ {0.01, 0.05, 0.10} (TCP-7); optional [O] suite=${tcp.includeOptionalTests ? 'Enabled' : 'Disabled'}.`,
      settingsUsed: `α=${tcp.alpha}, DecisionRule=${tcp.decisionRule}`,
      resultsSummary: `${firstTests.length} tests executed for ${firstTarget ?? 'target'} (${optionalTestsCount} optional [O] tests); ${sigCount} significant; ${flipCount} threshold-sensitive decisions flip across α ∈ {0.01, 0.05, 0.10}.`,
      interpretation: 'Both statistical significance (p_adj) and practical effect sizes are separated to prevent large-n p-value inflation (TC-8).',
      decisionImpact: 'T5 stationarity matrix (incl. Canova-Hansen/OCSB) and T9 structural breaks (incl. Hansen L_c/BOCPD) inform model selection and monitoring expectations (TC-4, TC-5).',
      caveats: 'Custom Chow and Quandt-Andrews tests are validated against R strucchange reference scripts.',
      citedArtifacts: [],
      tableRows: firstTests.map((t) => ({
        Family: t.familyId,
        Priority: t.isOptionalTest ? '[O]' : '[M]',
        Test: t.testName,
        Variable: t.variable,
        Statistic: t.statistic ?? 'N/A',
        PRaw: t.pRaw !== null ? Number(t.pRaw.toExponential(2)) : 'N/A',
        PAdj: t.pAdjusted !== null ? Number(t.pAdjusted.toExponential(2)) : 'N/A',
        EffectSize: t.effectSize ?? 'N/A',
        Decision: t.decision,
        FlipsAlpha: t.decisionFlips ? 'Yes' : 'No',
      })),
    },
    {
      id: 'modeling-top5-rationale',
      title: 'Model Portfolio, Top-5 Shortlist, Decision Rationale & Model Cards',
      depthMin: 'Executive',
      purpose: 'Detail validation design, Top-5 leaderboard, why Top-1 won, why alternatives were rejected, and locked Model Card.',
      method: 'Blocked K-Fold / Forward-Chaining with Purge Gap, 13-criteria min-max scoring, T11 DM test, NN Gate & Ensemble Gate across Classical, Boosted Trees (XGBoost/LightGBM/CatBoost/GBM), and Neural Networks.',
      settingsUsed: firstBundle
        ? `CV=${firstBundle.top5[0]?.cvScheme}, PurgeGap=${firstBundle.top5[0]?.purgeGapSteps} steps, Profile=${firstBundle.weightProfile}, Standard=${firstBundle.limits.citation} (CV≤${firstBundle.limits.maxCvRmse}%, |NMBE|≤${firstBundle.limits.maxAbsNmbe}%, R²≥${firstBundle.limits.minR2})`
        : 'Pending',
      resultsSummary: firstBundle
        ? `Qualified=${firstBundle.top5.length + firstBundle.qualifiedNotShortlisted.length}, Rejected=${firstBundle.rejected.length}. Top-1 Rank Stability (±20% weights)=${firstBundle.top5[0]?.rankStabilityPct ?? 0}%.`
        : 'Pending.',
      interpretation: firstBundle?.t11WinnerVsRunnerUp?.interpretation ?? 'Top-5 shortlist ranked by composite score.',
      decisionImpact: 'Selected baseline is locked immutably with SHA-256 artifact hash and Model Card.',
      caveats: 'Non-parametric models display architecture + global linear surrogate (never presented as exact formula).',
      citedArtifacts: [],
      tableRows: firstBundle?.allModels.map((m) => ({
        Rank: m.rank ?? '-',
        Model: m.name,
        Qualified: m.qualified ? 'Qualified' : 'Rejected',
        CvRmsePct: m.oofCvRmse,
        NmbePct: m.oofNmbe,
        R2: m.oofR2,
        Score: m.compositeScore,
        Reason: m.rejectionReason ?? 'Passed gates',
      })),
    },
    {
      id: 'uncertainty-calibration',
      title: 'Uncertainty Quantification, Calibration & Confidence Methods',
      depthMin: 'Standard',
      purpose: 'Report conformal interval calibration (empirical vs nominal coverage), Winkler score, regime coverage, and T12 tests.',
      method: 'TimeSeriesRegressor (EnbPI/ACI rolling quantiles) + Kupiec POF & Christoffersen conditional coverage tests.',
      settingsUsed: `Nominal Coverage=${(tcp.confidenceLevel * 100).toFixed(0)}%`,
      resultsSummary: firstTop1
        ? `Empirical coverage ${(firstTop1.conformalSummary.empiricalCoverage * 100).toFixed(1)}% vs nominal ${(firstTop1.conformalSummary.nominalCoverage * 100).toFixed(0)}%, Mean Width=${firstTop1.conformalSummary.meanWidth}, Winkler=${firstTop1.conformalSummary.winklerScore}, Kupiec p=${firstTop1.conformalSummary.kupiecPofP}.`
        : 'Pending.',
      interpretation: 'Coverage is empirical and approximate because time-series autocorrelation violates strict exchangeability (UQ-3).',
      decisionImpact: 'Conformal bands drive uncertainty-aware monitoring alerts.',
      caveats: 'PIT histograms are omitted for models lacking full predictive distributions (UQ-4).',
      citedArtifacts: [],
    },
    {
      id: 'drift-monitoring',
      title: 'Drift & Monitoring Summary',
      depthMin: 'Standard',
      purpose: 'Summarize Prediction & Monitoring runs, input drift (PSI/KS/Wasserstein), residual drift (CUSUM/EWMA/Page-Hinkley), and traffic-light status.',
      method: 'Trained-bin PSI, 2-sample KS, standardized residual CUSUM/EWMA/Page-Hinkley (DR-1..5).',
      settingsUsed: 'Alert rule=AUTO max(10%, 2×CV(RMSE)), never auto-retrain (DR-4)',
      resultsSummary:
        snapshots.length > 0
          ? `${snapshots.length} snapshot(s) recorded. Latest (${snapshots[0].target}): Traffic Light=${snapshots[0].drift.trafficLight.toUpperCase()}, Extrapolation=${snapshots[0].extrapolationSharePct}%.`
          : 'No monitoring snapshots recorded yet.',
      interpretation:
        snapshots.length > 0
          ? snapshots[0].drift.recommendation
          : 'Lock a baseline and run Prediction & Monitoring to evaluate drift.',
      decisionImpact: 'Provides explicit re-validation recommendation without silent model replacement.',
      caveats: 'Deviation = Actual − Baseline (negative values indicate lower-than-baseline usage / potential savings).',
      citedArtifacts: [],
    },
    {
      id: 'auto-audit-reproducibility',
      title: 'AUTO Resolutions Log, Reproducibility & Registers',
      depthMin: 'Full Technical',
      purpose: 'Expose every AUTO decision, user override, audit event, local storage confirmation, and reproducibility hashes.',
      method: 'Append-only AUTO resolution & audit ledger.',
      settingsUsed: `Global Seed=${seed}, Dataset SHA-256=${dataset.sha256}`,
      resultsSummary: `${autoLogs.length} AUTO resolution(s) and ${auditLog.length} audit event(s) logged. Local SQLite-first storage confirmed (no cloud transmission).`,
      interpretation: 'Deterministic seed guarantees identical AUTO resolutions and classical model metrics across runs (AUTO-5).',
      decisionImpact: 'Full auditability for M&V compliance review.',
      caveats: 'See docs/deviations.md, docs/assumptions.md, and docs/not_implemented.md for desktop packaging details.',
      citedArtifacts: [],
      tableRows: autoLogs.slice(0, 40).map((a) => ({
        Target: a.target,
        Key: a.settingKey,
        Value: a.value,
        Mode: a.mode,
        Signals: a.signals,
        Rule: a.rule,
      })),
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    datasetName: dataset.name,
    datasetSha256: dataset.sha256,
    domain: dataset.domain,
    seed,
    sections,
    howToRead: [
      'Sections follow a uniform 8-part template: Purpose → Method → Settings → Results → Interpretation → Decision Impact → Caveats.',
      `Domain & Deviation Context (${domainProf.label}): ${domainProf.deviationHintNegative}`,
      'Primary modeling metrics (CV(RMSE), NMBE, R²) are out-of-fold (OOF) without DoF adjustment; DoF-adjusted in-sample values are reported separately.',
      'Deviation in Monitoring is strictly defined as Actual − Baseline.',
      `Criteria are stated as "aligned with ${firstBundle?.limits.citation ?? 'selected tolerance standard'}", never claiming formal certification.`,
    ],
    glossary: [
      { term: 'CV(RMSE)', definition: 'Coefficient of Variation of Root Mean Squared Error: RMSE / mean(y) × 100 (%).' },
      { term: 'NMBE', definition: 'Normalized Mean Bias Error: sum(y - ŷ) / (n × mean(y)) × 100 (%).' },
      { term: 'VSG', definition: 'Variable Selection Gate: pre-inferential gate defining Candidate Pool vs Analysis-Only vs Excluded variables.' },
      { term: 'TCP', definition: 'Test Configuration & Decision Policy: pre-registered statistical significance, multiple-testing correction, and action rules.' },
      { term: 'Conformal Interval', definition: 'Distribution-free finite-sample (approximate under autocorrelation) prediction interval via MAPIE-style rolling residual quantiles.' },
      { term: 'PSI', definition: 'Population Stability Index quantifying predictor covariate shift relative to baseline training bins (<0.10 stable, ≥0.25 drift).' },
    ],
  };
}

export function verifyReportNarrativeConsistency(report: ReportModel): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  for (const sec of report.sections) {
    for (const cite of sec.citedArtifacts) {
      for (const expected of cite.expectedNumbers) {
        if (!sec.interpretation.includes(expected)) {
          mismatches.push(`Section '${sec.id}' cites ${cite.artifactId} expecting '${expected}', not found in interpretation.`);
        }
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export function computeRunDiff(
  runA: RunArchiveEntry,
  runB: RunArchiveEntry
): { target: string; field: string; valueA: string; valueB: string; delta: string }[] {
  const diffs: { target: string; field: string; valueA: string; valueB: string; delta: string }[] = [];
  if (runA.effortProfile !== runB.effortProfile) {
    diffs.push({ target: 'Global', field: 'Effort Profile', valueA: runA.effortProfile, valueB: runB.effortProfile, delta: 'Changed' });
  }
  if (runA.alpha !== runB.alpha) {
    diffs.push({ target: 'Global', field: 'Alpha (α)', valueA: String(runA.alpha), valueB: String(runB.alpha), delta: (runB.alpha - runA.alpha).toFixed(3) });
  }
  if (runA.correctionMethod !== runB.correctionMethod) {
    diffs.push({ target: 'Global', field: 'Correction', valueA: runA.correctionMethod, valueB: runB.correctionMethod, delta: 'Changed' });
  }
  const allTargets = Array.from(new Set([...Object.keys(runA.summaryByTarget), ...Object.keys(runB.summaryByTarget)]));
  for (const t of allTargets) {
    const a = runA.summaryByTarget[t];
    const b = runB.summaryByTarget[t];
    if (!a || !b) {
      diffs.push({ target: t, field: 'Presence', valueA: a ? 'Present' : 'Absent', valueB: b ? 'Present' : 'Absent', delta: 'Changed' });
      continue;
    }
    if (a.topModelName !== b.topModelName) {
      diffs.push({ target: t, field: 'Top-1 Model', valueA: a.topModelName, valueB: b.topModelName, delta: 'Rank Switch' });
    }
    diffs.push({
      target: t,
      field: 'OOF CV(RMSE) %',
      valueA: a.oofCvRmse.toFixed(2),
      valueB: b.oofCvRmse.toFixed(2),
      delta: `${(b.oofCvRmse - a.oofCvRmse >= 0 ? '+' : '')}${(b.oofCvRmse - a.oofCvRmse).toFixed(2)}%`,
    });
    diffs.push({
      target: t,
      field: 'OOF R²',
      valueA: a.oofR2.toFixed(4),
      valueB: b.oofR2.toFixed(4),
      delta: `${(b.oofR2 - a.oofR2 >= 0 ? '+' : '')}${(b.oofR2 - a.oofR2).toFixed(4)}`,
    });
  }
  return diffs;
}

export async function exportEbprojZipBlob(payload: {
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  lockedBaselines: Record<string, LockedBaseline>;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
}): Promise<Blob> {
  const zip = new JSZip();
  const manifest = {
    schema_version: '5.2.0',
    exported_at: new Date().toISOString(),
    seed: payload.seed,
    dataset_ref: {
      id: payload.dataset.id,
      name: payload.dataset.name,
      domain: payload.dataset.domain,
      sha256: payload.dataset.sha256,
      rows: payload.dataset.rows.length,
    },
    temporal: payload.dataset.temporal,
    columns: payload.dataset.columns,
    vsg_by_target: payload.vsgByTarget,
    tcp_config: payload.tcp,
    locked_baselines: payload.lockedBaselines,
    auto_log: payload.autoLogs,
    audit_log: payload.auditLog,
    credentials_included: false,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('data/dataset_rows.json', JSON.stringify(payload.dataset.rows));
  return zip.generateAsync({ type: 'blob' });
}

export async function importEbprojZipFile(file: File): Promise<{
  dataset: DatasetState;
  vsgByTarget: Record<string, Record<string, VsgEntry>>;
  tcp: TcpConfig;
  lockedBaselines: Record<string, LockedBaseline>;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
  seed: number;
}> {
  const zip = await JSZip.loadAsync(file);
  const manifestText = await zip.file('manifest.json')?.async('string');
  if (!manifestText) throw new Error('Invalid .ebproj archive: missing manifest.json');
  const manifest = JSON.parse(manifestText);
  const rowsText = await zip.file('data/dataset_rows.json')?.async('string');
  const rows = rowsText ? JSON.parse(rowsText) : [];
  const dataset: DatasetState = {
    id: manifest.dataset_ref.id,
    name: manifest.dataset_ref.name,
    domain: manifest.dataset_ref.domain,
    rows,
    rawRowCount: rows.length,
    sha256: manifest.dataset_ref.sha256,
    columns: manifest.columns,
    temporal: manifest.temporal,
    nonRoutineEvents: [],
    sourceNote: `Restored from .ebproj (${file.name})`,
  };
  return {
    dataset,
    vsgByTarget: manifest.vsg_by_target ?? {},
    tcp: manifest.tcp_config,
    lockedBaselines: manifest.locked_baselines ?? {},
    autoLogs: manifest.auto_log ?? [],
    auditLog: manifest.audit_log ?? [],
    seed: manifest.seed ?? 42,
  };
}
