export type ColumnRole =
  | 'time'
  | 'target'
  | 'predictor'
  | 'static_factor'
  | 'group'
  | 'weight'
  | 'ignore';

export type QuantityType = 'flow' | 'stock' | 'rate' | 'quality' | 'index';

export type AggregationMethod = 'sum' | 'last' | 'time_weighted_mean' | 'mean' | 'median';

export type AvailabilityFlag = 'known_in_advance' | 'observed_only';

export type InclusionState = 'force_include' | 'candidate' | 'analysis_only' | 'exclude';

export type DomainType =
  | 'energy'
  | 'manufacturing'
  | 'water'
  | 'healthcare'
  | 'finance'
  | 'environment'
  | 'custom';

export type ThresholdProfileId =
  | 'ashrae14'
  | 'ipmvp'
  | 'iso50015'
  | 'spc'
  | 'awwa_water'
  | 'healthcare_kpi'
  | 'iso14064'
  | 'basel_sr11_7'
  | 'custom';

export interface CustomThresholds {
  maxCvRmse: number;
  maxAbsNmbe: number;
  minR2: number;
  label: string;
}

export type SamplingGranularity = '15min' | 'hourly' | 'daily' | 'monthly';

export type EffortProfile = 'fast' | 'standard' | 'thorough';

export type MultipleTestingMethod = 'none' | 'bonferroni' | 'holm' | 'bh' | 'by';

export type CorrectionFamilyScope =
  | 'per_test_per_target'
  | 'per_target'
  | 'global'
  | 'per_variable';

export type DecisionRule = 'p_only' | 'p_and_effect_size' | 'ci_based' | 'equivalence';

export type GateRole = 'informational' | 'warning' | 'gating';

export type ActionPolicy = 'flag_only' | 'ask_user' | 'auto_apply';

export type ExpectedSign = '+' | '-' | 'free' | 'non_monotonic';

export type SettingMode = 'AUTO' | 'USER_OVERRIDE';

export type SelectionPhase = 'pre_test' | 'post_test';

export type ProvenanceStatus = 'pre_registered' | 'post_hoc';

export type TestFamilyId =
  | 'T1'
  | 'T2'
  | 'T3'
  | 'T4'
  | 'T5'
  | 'T6'
  | 'T7'
  | 'T8'
  | 'T9'
  | 'T10'
  | 'T11'
  | 'T12'
  | 'T13'
  | 'T14';

export interface ColumnConfig {
  name: string;
  role: ColumnRole;
  quantityType: QuantityType;
  aggregation: AggregationMethod;
  unit: string;
  unitFamily: string;
  availability: AvailabilityFlag;
  dtype: 'datetime' | 'numeric' | 'categorical';
  roleMode: SettingMode;
  suggestedRole: ColumnRole;
}

export interface NonRoutineEvent {
  id: string;
  start: string;
  end: string;
  reason: string;
  treatment: 'exclude' | 'flag_only' | 'adjust';
}

export interface TemporalConfig {
  sourceGranularity: SamplingGranularity;
  targetGranularity: SamplingGranularity;
  timezone: string;
  baselineStart: string;
  baselineEnd: string;
  reportingStart: string;
  reportingEnd: string;
  dstPolicy: 'utc_store_flag_dst' | 'drop_ambiguous' | 'keep_all';
  completenessThreshold: number;
}

export interface DatasetRow {
  timestamp: string;
  [key: string]: string | number | null;
}

export interface DatasetState {
  id: string;
  name: string;
  domain: DomainType;
  rows: DatasetRow[];
  rawRowCount: number;
  sha256: string;
  columns: ColumnConfig[];
  temporal: TemporalConfig;
  nonRoutineEvents: NonRoutineEvent[];
  sourceNote: string;
  refusalError?: string | null;
}

export interface VariablePreTestProfile {
  name: string;
  dtype: 'datetime' | 'numeric' | 'categorical';
  unit: string;
  missingCount: number;
  missingRate: number;
  uniqueCount: number;
  mean: number | null;
  std: number | null;
  min: number | null;
  max: number | null;
  variance: number | null;
  isConstant: boolean;
  isNearConstant: boolean;
  corrWithTarget: number | null;
  leakageSuspicion: 'none' | 'high_corr_same_unit' | 'high_corr_diff_unit' | 'observed_only_in_forward';
  leakageReason: string | null;
  histogramBins: number[];
}

export interface VsgEntry {
  columnName: string;
  state: InclusionState;
  mode: SettingMode;
  phase: SelectionPhase;
  provenance: ProvenanceStatus;
  reason: string;
  rule: string;
  timestamp: string;
  conflict: string | null;
  scopeFamilies: TestFamilyId[];
}

export interface AutoDecisionEntry {
  id: string;
  settingKey: string;
  value: string;
  signals: string;
  rule: string;
  mode: SettingMode;
  target: string;
  timestamp: string;
}

export interface TestFamilyConfig {
  id: TestFamilyId;
  name: string;
  phase: 'pre_model' | 'post_model' | 'causal_group';
  enabled: boolean;
  gateRole: GateRole;
  actionPolicy: ActionPolicy;
  alphaOverride: number | null;
  correctionOverride: MultipleTestingMethod | null;
  alternative: 'two-sided' | 'greater' | 'less';
  maxLagsRule: 'schwert' | 'aic' | 'bic' | 'fixed';
  fixedLags: number;
  deterministicTerm: 'n' | 'c' | 'ct' | 'ctt';
  minSampleSize: number;
  effectThresholdSmall: number;
  effectThresholdMedium: number;
  tostMargin: number;
  bootstrapReplicates: number;
  dependencies: TestFamilyId[];
  costEstimateMs: number;
  whyKeepHint: string;
}

export interface TcpConfig {
  alpha: number;
  alphaPreset: 'strict_0.01' | 'standard_0.05' | 'exploratory_0.10' | 'custom';
  confidenceLevel: number; // 0.80, 0.90, 0.95, 0.99
  correctionMethod: MultipleTestingMethod;
  correctionScope: CorrectionFamilyScope;
  decisionRule: DecisionRule;
  effortProfile: EffortProfile;
  outlierActionPolicy: ActionPolicy;
  includeOptionalTests: boolean;
  preRegistered: boolean;
  preRegistrationHash: string | null;
  preRegistrationTimestamp: string | null;
  postHocModified: boolean;
  families: Record<TestFamilyId, TestFamilyConfig>;
  expectedSignsByTarget: Record<string, Record<string, ExpectedSign>>;
  mode: SettingMode;
}

export interface StatisticalTestResult {
  id: string;
  target: string;
  variable: string;
  familyId: TestFamilyId;
  testName: string;
  isOptionalTest?: boolean;
  /** True when this build uses an in-app approximation rather than a delegated reference implementation. */
  approximate?: boolean;
  statistic: number | null;
  statisticName: string;
  df: string | null;
  pRaw: number | null;
  pAdjusted: number | null;
  effectSize: number | null;
  effectSizeName: string | null;
  ciLow: number | null;
  ciHigh: number | null;
  ciMethod: string;
  nUsed: number;
  assumptionsChecked: string;
  assumptionStatus: 'met' | 'switched_robust' | 'violated' | 'not_run_user' | 'skipped_min_n';
  decision: 'reject_h0' | 'fail_to_reject' | 'practical_significant' | 'stat_only_not_practical' | 'equivalent' | 'not_run';
  decisionAt001: string;
  decisionAt005: string;
  decisionAt010: string;
  decisionFlips: boolean;
  interpretation: string;
  downstreamAction: string;
  mode: SettingMode;
  cacheKey: string;
  artifactId: string;
}

export interface CorrelationEntry {
  varA: string;
  varB: string;
  pearson: number;
  spearman: number;
  kendall: number;
  distCorr: number;
  mutualInfo: number;
  partialCorr: number;
  ciLow: number;
  ciHigh: number;
  ciMethod: string;
  pRaw: number;
  pAdjusted: number;
  nUsed: number;
  nonlinearityFlag: boolean;
}

export interface DataQualityBreakdown {
  overallScore: number;
  completeness: { score: number; weight: number; detail: string };
  validity: { score: number; weight: number; detail: string };
  consistency: { score: number; weight: number; detail: string };
  timeliness: { score: number; weight: number; detail: string };
  uniqueness: { score: number; weight: number; detail: string };
  perVariable: {
    name: string;
    completenessPct: number;
    outlierPct: number;
    zeroOrNegPct: number;
    qualityScore: number;
  }[];
}

export interface EdaTargetSummary {
  target: string;
  dataQuality: DataQualityBreakdown;
  correlations: CorrelationEntry[];
  pca: {
    explainedVarianceRatio: number[];
    cumulativeVarianceRatio: number[];
    featureNames: string[];
    loadingsPC1: number[];
    loadingsPC2: number[];
    kmo: number;
    bartlettP: number;
  };
  clustering: {
    k: number;
    silhouette: number;
    daviesBouldin: number;
    calinskiHarabasz: number;
    bootstrapAri: number;
    regimeLabels: number[];
    regimeMeans: { regime: number; count: number; targetMean: number; label: string }[];
  };
  anomalies: {
    flaggedIndices: number[];
    timestamps: string[];
    scores: number[];
    voteCounts: number[];
    autoencoderFlagCount: number;
    policyApplied: ActionPolicy;
  };
  regimeRules: {
    rule: string;
    regimeLabel: string;
    supportPct: number;
    confidencePct: number;
    lift: number;
  }[];
  timeSeriesMining: {
    spectralEntropy: number;
    trendStrength: number;
    seasonalStrength: number;
    optimalBaseTempHeating: number;
    optimalBaseTempCooling: number;
    changePointIndex: number | null;
    changePointTimestamp: string | null;
    changePointCiLow: string | null;
    changePointCiHigh: string | null;
    acf: number[];
    pacf: number[];
  };
  featureRelevance: {
    feature: string;
    miScore: number;
    anovaF: number;
    permImportance: number;
    stabilityFreq: number;
    shapMeanAbs: number;
    consensusRank: number;
  }[];
  kendallW: number;
  causalMv: {
    available: boolean;
    groupColumn: string | null;
    treatedMean: number | null;
    controlMean: number | null;
    didEstimate: number | null;
    didSe: number | null;
    didPValue: number | null;
    smdBefore: number | null;
    smdAfter: number | null;
    parallelTrendsP: number | null;
    parallelTrendsMethod?: 'event_study_leads_joint_hac' | 'linear_pretrend_hac_fallback';
    placeboRefutationP: number | null;
    eventStudy?: {
      relativePeriod: number;
      estimate: number;
      standardError: number | null;
      pValue: number | null;
    }[];
    interpretation: string;
  };
}

export type WeightProfile = 'balanced' | 'interpretable' | 'accuracy_first' | 'custom';

export interface ScoringWeights {
  cvRmse: number;
  r2: number;
  nmbe: number;
  mae: number;
  smape: number;
  foldRobustness: number;
  parsimony: number;
  residualDiagnostics: number;
  physicalPlausibility: number;
  interpretability: number;
  standardsAlignment: number;
  uncertaintyWidth: number;
  dataSufficiency: number;
}

export interface ModelCandidateResult {
  id: string;
  target: string;
  name: string;
  family:
    | 'mean'
    | 'degree_day'
    | 'mlr'
    | 'ridge'
    | 'lasso'
    | 'elastic_net'
    | 'changepoint'
    | 'towt'
    | 'random_forest'
    | 'extra_trees'
    | 'gbm'
    | 'xgboost'
    | 'lightgbm'
    | 'catboost'
    | 'svr'
    | 'mlp'
    | 'resnet_mlp'
    | 'sequence_nn'
    | 'causal_tcn'
    | 'nbeats'
    | 'tft'
    | 'patchtst'
    | 'informer'
    | 'ae_net'
    | 'ensemble';
  isParametric: boolean;
  isNeuralNet: boolean;
  featuresUsed: string[];
  paramCount: number;
  cvScheme: 'blocked_kfold' | 'forward_chaining';
  purgeGapSteps: number;
  oofCvRmse: number;
  oofCvRmseCi: [number, number];
  oofNmbe: number;
  oofNmbeCi: [number, number];
  oofR2: number;
  oofR2Ci: [number, number];
  oofMae: number;
  oofSmape: number;
  holdoutCvRmse: number | null;
  holdoutNmbe: number | null;
  holdoutR2: number | null;
  inSampleDofCvRmse: number | null;
  foldCvRmses: number[];
  bic: number | null;
  physicalPlausibility: number;
  signViolations: { feature: string; expected: ExpectedSign; observed: number; message: string }[];
  t10Summary: {
    durbinWatson: number;
    ljungBoxP: number;
    breuschPaganP: number;
    shapiroResidP: number;
    maxCooksD: number;
    cooksFlagCount: number;
    descriptiveOnlyNote: string | null;
  };
  conformalSummary: {
    method: string;
    nominalCoverage: number;
    empiricalCoverage: number;
    meanWidth: number;
    winklerScore: number;
    kupiecPofP: number;
    christoffersenCcP: number;
    regimeCoverage: { regime: string; coverage: number; n: number }[];
  };
  qualified: boolean;
  rejectionReason: string | null;
  compositeScore: number;
  rank: number | null;
  rankStabilityPct: number;
  indistinguishableFromTop1: boolean;
  latexEquation: string | null;
  excelFormula: string | null;
  coefficients: { term: string; value: number; se: number | null; unit: string }[];
  architectureSummary: string | null;
  surrogateSummary: {
    description: string;
    fidelityR2: number;
    topFeatures: { feature: string; importance: number }[];
  } | null;
  rationale: string;
  oofPredictions: {
    timestamp: string;
    actual: number;
    predicted: number;
    lower: number;
    upper: number;
  }[];
  predictFnParams: Record<string, unknown>;
  artifactId: string;
}

export interface LockedBaseline {
  version: number;
  target: string;
  modelId: string;
  modelName: string;
  family: string;
  lockedAt: string;
  note: string;
  artifactSha256: string;
  features: string[];
  thresholdProfile: ThresholdProfileId;
  vsgSnapshotHash: string;
  tcpSnapshotHash: string;
  trainingWindow: { start: string; end: string; nRows: number };
  seed: number;
  calibrationSummary: ModelCandidateResult['conformalSummary'];
  modelCard: {
    intendedUse: string;
    trainingWindow: string;
    features: string[];
    assumptions: string[];
    knownLimitations: string[];
    calibrationSummary: string;
    standardsNote: string;
  };
  candidate: ModelCandidateResult;
}

export interface TargetModelingBundle {
  target: string;
  seed: number;
  candidatePool: string[];
  selectedFeatures: string[];
  prunedCollinear: { feature: string; reason: string }[];
  top5: ModelCandidateResult[];
  qualifiedNotShortlisted: ModelCandidateResult[];
  rejected: ModelCandidateResult[];
  allModels: ModelCandidateResult[];
  weightProfile: WeightProfile;
  weights: ScoringWeights;
  thresholdProfile: ThresholdProfileId;
  limits: { maxCvRmse: number; maxAbsNmbe: number; minR2: number; citation: string; normativeNote: string };
  t11WinnerVsRunnerUp: {
    dmStat: number;
    dmPValue: number;
    dmHacLag?: number;
    hlnFactor?: number;
    correctedTStat: number;
    correctedTPValue: number;
    interpretation: string;
  } | null;
}

export interface PredictionMonitoringPoint {
  timestamp: string;
  actual: number | null;
  baseline: number;
  deviation: number | null;
  deviationPct: number | null;
  cumulativeDeviation: number | null;
  normalizedDeviation: number | null;
  lower: number;
  upper: number;
  alert: boolean;
  outOfTrainingRange: boolean;
}

export interface DriftStatus {
  target: string;
  trafficLight: 'green' | 'amber' | 'red';
  recommendation: string;
  inputDrift: {
    feature: string;
    psi: number;
    ksStat: number;
    ksPValue: number;
    wasserstein: number;
    status: 'ok' | 'warn' | 'drift';
  }[];
  residualDrift: {
    cusumMax: number;
    ewmaExceedances: number;
    pageHinkleyTriggered: boolean;
    rollingCvRmse: number;
    baselineOofCvRmse: number;
    rollingNmbe: number;
    structuralBreakP: number | null;
    interpretation: string;
  };
  checkedAt: string;
}

export interface MonitoringSnapshot {
  id: string;
  target: string;
  baselineVersion: number;
  inputHash: string;
  source: 'file' | 'sql' | 'manual';
  createdAt: string;
  points: PredictionMonitoringPoint[];
  drift: DriftStatus;
  extrapolationSharePct: number;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  stage: string;
  action: string;
  actor: 'USER' | 'AUTO' | 'SYSTEM';
  detail: string;
}

export interface RunArchiveEntry {
  runId: string;
  timestamp: string;
  seed: number;
  effortProfile: EffortProfile;
  alpha: number;
  correctionMethod: MultipleTestingMethod;
  summaryByTarget: Record<
    string,
    {
      topModelName: string;
      oofCvRmse: number;
      oofNmbe: number;
      oofR2: number;
      features: string[];
      significantTestsCount: number;
    }
  >;
}
