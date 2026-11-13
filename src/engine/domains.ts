import { DomainType, SamplingGranularity, ThresholdProfileId, CustomThresholds } from './types';

export interface DomainProfile {
  id: DomainType;
  label: string;
  defaultStandard: ThresholdProfileId;
  baselineNoun: string;
  deviationNoun: string;
  deviationHintNegative: string;
  deviationHintPositive: string;
  privacyNotice: string | null;
}

export interface StandardProfile {
  id: ThresholdProfileId;
  version: string;
  name: string;
  citation: string;
  applicableDomains: DomainType[];
  defaultMaxCvRmse: number;
  defaultMaxAbsNmbe: number;
  defaultMinR2: number;
  normativeNote: string;
}

export const DOMAIN_PROFILES: Record<DomainType, DomainProfile> = {
  energy: {
    id: 'energy',
    label: 'Energy & Buildings (M&V EnB / EnPI)',
    defaultStandard: 'ashrae14',
    baselineNoun: 'Energy Baseline (EnB)',
    deviationNoun: 'Energy Deviation',
    deviationHintNegative: 'Negative values indicate lower consumption than counterfactual baseline (potential ECM savings).',
    deviationHintPositive: 'Positive values indicate excess consumption above baseline.',
    privacyNotice: null,
  },
  manufacturing: {
    id: 'manufacturing',
    label: 'Manufacturing & Industrial SPC',
    defaultStandard: 'spc',
    baselineNoun: 'Process Reference Baseline',
    deviationNoun: 'Process Deviation',
    deviationHintNegative: 'Negative values indicate reduced resource intensity / lower scrap vs reference process.',
    deviationHintPositive: 'Positive values indicate upward process shift or excess variance.',
    privacyNotice: null,
  },
  water: {
    id: 'water',
    label: 'Water, Wastewater & Utilities',
    defaultStandard: 'awwa_water',
    baselineNoun: 'Hydraulic / Utility Baseline',
    deviationNoun: 'Water Balance Deviation',
    deviationHintNegative: 'Negative values indicate reduced loss/flow below expected demand baseline.',
    deviationHintPositive: 'Positive values indicate potential non-revenue water loss, leak, or surge.',
    privacyNotice: null,
  },
  healthcare: {
    id: 'healthcare',
    label: 'Healthcare & Clinical Operations',
    defaultStandard: 'healthcare_kpi',
    baselineNoun: 'Clinical KPI Baseline',
    deviationNoun: 'Performance Indicator Deviation',
    deviationHintNegative: 'Negative values indicate metrics below expected counterfactual operational load.',
    deviationHintPositive: 'Positive values indicate elevated operational utilization or resource load.',
    privacyNotice: 'Healthcare Local-Only Data Notice (DOM-3): All clinical/occupancy KPI data stays strictly on local SQLite storage with zero external transmission.',
  },
  finance: {
    id: 'finance',
    label: 'Finance, Demand & Risk Modeling',
    defaultStandard: 'basel_sr11_7',
    baselineNoun: 'Risk / Demand Benchmark',
    deviationNoun: 'Forecast Variance',
    deviationHintNegative: 'Negative values indicate realized figures below counterfactual benchmark.',
    deviationHintPositive: 'Positive values indicate realized figures exceeding benchmark expectation.',
    privacyNotice: 'Model Risk Governance Notice (SR 11-7): Validation enforces out-of-fold evaluation, holdout preservation, and drift monitoring without silent retraining.',
  },
  environment: {
    id: 'environment',
    label: 'Environmental, Emissions & Air Quality',
    defaultStandard: 'iso14064',
    baselineNoun: 'Emissions / Environmental Baseline',
    deviationNoun: 'Emissions / Concentration Anomaly',
    deviationHintNegative: 'Negative values indicate abatement / reduction relative to counterfactual baseline.',
    deviationHintPositive: 'Positive values indicate elevated emissions or concentration exceedance.',
    privacyNotice: null,
  },
  custom: {
    id: 'custom',
    label: 'Custom / General Time-Series',
    defaultStandard: 'custom',
    baselineNoun: 'Statistical Baseline',
    deviationNoun: 'Observed Deviation',
    deviationHintNegative: 'Negative values indicate observations below counterfactual model prediction.',
    deviationHintPositive: 'Positive values indicate observations above counterfactual model prediction.',
    privacyNotice: null,
  },
};

export const STANDARD_PROFILES: Record<ThresholdProfileId, StandardProfile> = {
  ashrae14: {
    id: 'ashrae14',
    version: '2014-v1',
    name: 'ASHRAE Guideline 14-2014',
    citation: 'ASHRAE Guideline 14-2014 (Measurement of Energy, Demand, and Water Savings)',
    applicableDomains: ['energy', 'water'],
    defaultMaxCvRmse: 20,
    defaultMaxAbsNmbe: 5,
    defaultMinR2: 0.70,
    normativeNote: 'Criteria aligned with ASHRAE 14 (monthly ≤15%/±5%, hourly ≤30%/±10%; daily labeled non-normative). Never claims formal certification.',
  },
  ipmvp: {
    id: 'ipmvp',
    version: 'EVO-10000-1:2022',
    name: 'IPMVP Core Concepts (EVO)',
    citation: 'IPMVP Core Concepts (EVO 10000-1) Baseline & NRE Governance',
    applicableDomains: ['energy', 'water'],
    defaultMaxCvRmse: 20,
    defaultMaxAbsNmbe: 5,
    defaultMinR2: 0.75,
    normativeNote: 'Criteria aligned with IPMVP counterfactual baseline + Non-Routine Event (NRE) adjustment documentation.',
  },
  iso50015: {
    id: 'iso50015',
    version: '2014',
    name: 'ISO 50015 / ISO 50006 (EnB)',
    citation: 'ISO 50015:2014 & ISO 50006 EnB/EnPI Uncertainty Alignment',
    applicableDomains: ['energy', 'manufacturing'],
    defaultMaxCvRmse: 20,
    defaultMaxAbsNmbe: 5,
    defaultMinR2: 0.70,
    normativeNote: 'Criteria aligned with ISO 50015 M&V baseline tolerance and ISO 50006 Energy Performance Indicator (EnPI) framing.',
  },
  spc: {
    id: 'spc',
    version: 'ISO-7870-2',
    name: 'ISO 7870 / ASTM E2587 Industrial SPC',
    citation: 'ISO 7870-2 / ASTM E2587 Statistical Process Control & Capability',
    applicableDomains: ['manufacturing'],
    defaultMaxCvRmse: 12,
    defaultMaxAbsNmbe: 3,
    defaultMinR2: 0.80,
    normativeNote: 'Tight process stability tolerance aligned with SPC control charts, CUSUM/EWMA shift detection, and Six Sigma capability checks.',
  },
  awwa_water: {
    id: 'awwa_water',
    version: 'M36-v5',
    name: 'AWWA M36 / IWA Water Balance',
    citation: 'AWWA M36 Water Audits & Loss Control Counterfactual Baseline',
    applicableDomains: ['water'],
    defaultMaxCvRmse: 18,
    defaultMaxAbsNmbe: 5,
    defaultMinR2: 0.70,
    normativeNote: 'Criteria aligned with AWWA M36 hydraulic demand & non-revenue water baseline monitoring.',
  },
  healthcare_kpi: {
    id: 'healthcare_kpi',
    version: 'AHRQ-v2',
    name: 'AHRQ / IHI Clinical Operations KPI',
    citation: 'AHRQ / IHI Operational Baseline & Quality Control Standard',
    applicableDomains: ['healthcare'],
    defaultMaxCvRmse: 22,
    defaultMaxAbsNmbe: 6,
    defaultMinR2: 0.65,
    normativeNote: 'Criteria aligned with healthcare census/throughput baseline forecasting under local-only privacy controls.',
  },
  iso14064: {
    id: 'iso14064',
    version: '2019-Pt2',
    name: 'ISO 14064-2 / GHG Protocol Baseline',
    citation: 'ISO 14064-2:2019 Project GHG Emissions & Environmental Baseline',
    applicableDomains: ['environment', 'energy'],
    defaultMaxCvRmse: 20,
    defaultMaxAbsNmbe: 5,
    defaultMinR2: 0.70,
    normativeNote: 'Criteria aligned with ISO 14064-2 baseline emissions counterfactuals and uncertainty reporting.',
  },
  basel_sr11_7: {
    id: 'basel_sr11_7',
    version: 'SR11-7',
    name: 'SR 11-7 / Model Risk Validation',
    citation: 'Federal Reserve SR 11-7 / OCC Model Risk & Backtesting Standard',
    applicableDomains: ['finance', 'custom'],
    defaultMaxCvRmse: 15,
    defaultMaxAbsNmbe: 4,
    defaultMinR2: 0.75,
    normativeNote: 'Criteria aligned with SR 11-7 independent OOF validation, holdout backtesting, conceptual soundness, and drift PSI bounds.',
  },
  custom: {
    id: 'custom',
    version: 'USER-1.0',
    name: 'Custom User-Defined Standard',
    citation: 'User-Defined Baseline Tolerance Profile',
    applicableDomains: ['energy', 'manufacturing', 'water', 'healthcare', 'finance', 'environment', 'custom'],
    defaultMaxCvRmse: 25,
    defaultMaxAbsNmbe: 8,
    defaultMinR2: 0.50,
    normativeNote: 'User-configured CV(RMSE), |NMBE|, and minimum R² acceptance gates.',
  },
};

export function resolveStandardForDomain(domain: DomainType): ThresholdProfileId {
  return DOMAIN_PROFILES[domain]?.defaultStandard ?? 'custom';
}

export function resolveThresholdLimits(
  profile: ThresholdProfileId,
  granularity: SamplingGranularity,
  custom?: CustomThresholds
): { maxCvRmse: number; maxAbsNmbe: number; minR2: number; citation: string; normativeNote: string } {
  if (profile === 'custom' && custom) {
    return {
      maxCvRmse: Math.max(0.5, custom.maxCvRmse),
      maxAbsNmbe: Math.max(0.1, custom.maxAbsNmbe),
      minR2: Math.min(0.99, Math.max(-1, custom.minR2)),
      citation: custom.label.trim() ? `${custom.label.trim()} (Custom User Bounds)` : 'Custom User-Defined Baseline Criteria',
      normativeNote: `User-defined tolerance: CV(RMSE) ≤ ${custom.maxCvRmse}%, |NMBE| ≤ ${custom.maxAbsNmbe}%, R² ≥ ${custom.minR2}.`,
    };
  }
  if (profile === 'ashrae14') {
    if (granularity === 'monthly') {
      return {
        maxCvRmse: 15,
        maxAbsNmbe: 5,
        minR2: 0.70,
        citation: 'ASHRAE Guideline 14-2014 (Monthly criteria)',
        normativeNote: 'Criteria aligned with ASHRAE 14 monthly thresholds (CV(RMSE) ≤ 15%, |NMBE| ≤ 5%).',
      };
    }
    if (granularity === 'hourly' || granularity === '15min') {
      return {
        maxCvRmse: 30,
        maxAbsNmbe: 10,
        minR2: 0.65,
        citation: 'ASHRAE Guideline 14-2014 (Hourly criteria)',
        normativeNote: 'Criteria aligned with ASHRAE 14 hourly thresholds (CV(RMSE) ≤ 30%, |NMBE| ≤ 10%).',
      };
    }
    return {
      maxCvRmse: 20,
      maxAbsNmbe: 5,
      minR2: 0.70,
      citation: 'ASHRAE Guideline 14 (Daily interpolated — non-normative)',
      normativeNote: 'Daily granularity is user/AUTO-defined and labeled non-normative per DOM-2.',
    };
  }
  const std = STANDARD_PROFILES[profile] ?? STANDARD_PROFILES.custom;
  return {
    maxCvRmse: std.defaultMaxCvRmse,
    maxAbsNmbe: std.defaultMaxAbsNmbe,
    minR2: std.defaultMinR2,
    citation: std.citation,
    normativeNote: std.normativeNote,
  };
}
