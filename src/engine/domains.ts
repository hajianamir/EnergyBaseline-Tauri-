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
    normativeNote: 'ASHRAE 14-2014 is the profile reference. Monthly/hourly thresholds below are encoded as app gates but have not been independently source-verified in this build; daily is non-normative. No gate claims certification.',
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
    normativeNote: 'Application-defined default gates; the cited IPMVP reference is contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not an IPMVP compliance claim.',
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
    normativeNote: 'Application-defined default gates; the cited ISO references are contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not an ISO compliance claim.',
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
    normativeNote: 'Application-defined default gates; the cited ISO/ASTM references are contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not an SPC compliance claim.',
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
    normativeNote: 'Application-defined default gates; the cited AWWA reference is contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not an AWWA compliance claim.',
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
    normativeNote: 'Application-defined default gates; the cited AHRQ/IHI reference is contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not a clinical-standard compliance claim.',
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
    normativeNote: 'Application-defined default gates; the cited ISO reference is contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not an ISO compliance claim.',
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
    normativeNote: 'Application-defined default gates; the cited SR 11-7/OCC references are contextual only. This build has not verified a source-to-threshold mapping or interval-specific numeric criteria. Not a regulatory compliance claim.',
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

/** Use Custom rather than applying the hourly ASHRAE gate to unverified 15-minute data. */
export function resolveThresholdProfileForDataset(
  domain: DomainType,
  granularity: SamplingGranularity
): ThresholdProfileId {
  const profile = resolveStandardForDomain(domain);
  return profile === 'ashrae14' && granularity === '15min' ? 'custom' : profile;
}

export function resolveThresholdLimits(
  profile: ThresholdProfileId,
  granularity: SamplingGranularity,
  custom?: CustomThresholds
): { maxCvRmse: number; maxAbsNmbe: number; minR2: number; citation: string; version: string; normativeNote: string } {
  if (profile === 'custom' && custom) {
    const maxCvRmse = Math.max(0.5, custom.maxCvRmse);
    const maxAbsNmbe = Math.max(0.1, custom.maxAbsNmbe);
    const minR2 = Math.min(0.99, Math.max(-1, custom.minR2));
    return {
      maxCvRmse,
      maxAbsNmbe,
      minR2,
      citation: custom.label.trim() ? `${custom.label.trim()} (Custom User Bounds)` : 'Custom User-Defined Baseline Criteria',
      version: STANDARD_PROFILES.custom.version,
      normativeNote: `User-defined ${granularity} tolerance: CV(RMSE) ≤ ${maxCvRmse}%, |NMBE| ≤ ${maxAbsNmbe}%, R² ≥ ${minR2}.`,
    };
  }
  if (profile === 'custom') {
    throw new Error('Custom threshold values are required when the Custom profile is selected.');
  }
  if (profile === 'ashrae14') {
    if (granularity === '15min') {
      throw new Error('ASHRAE Guideline 14-2014 interval-specific thresholds for 15-minute data are not verified in this build; select a Custom threshold profile.');
    }
    if (granularity === 'monthly') {
      return {
        maxCvRmse: 15,
        maxAbsNmbe: 5,
        minR2: 0.70,
        citation: 'ASHRAE Guideline 14-2014 (Monthly criteria)',
        version: STANDARD_PROFILES.ashrae14.version,
        normativeNote: 'ASHRAE 14-2014 monthly values are encoded as an app gate (CV(RMSE) ≤ 15%, |NMBE| ≤ 5%); source text has not been independently verified in this build. Not a certification claim.',
      };
    }
    if (granularity === 'hourly') {
      return {
        maxCvRmse: 30,
        maxAbsNmbe: 10,
        minR2: 0.65,
        citation: 'ASHRAE Guideline 14-2014 (Hourly criteria)',
        version: STANDARD_PROFILES.ashrae14.version,
        normativeNote: 'ASHRAE 14-2014 hourly values are encoded as an app gate (CV(RMSE) ≤ 30%, |NMBE| ≤ 10%); source text has not been independently verified in this build. Not a certification claim.',
      };
    }
    return {
      maxCvRmse: 20,
      maxAbsNmbe: 5,
      minR2: 0.70,
      citation: 'ASHRAE Guideline 14-2014 (daily app default — non-normative)',
      version: STANDARD_PROFILES.ashrae14.version,
      normativeNote: 'The daily CV(RMSE), |NMBE|, and R² gate is an application-defined fallback, not a verified ASHRAE daily threshold. It is non-normative and does not imply certification.'
    };
  }
  const std = STANDARD_PROFILES[profile] ?? STANDARD_PROFILES.custom;
  return {
    maxCvRmse: std.defaultMaxCvRmse,
    maxAbsNmbe: std.defaultMaxAbsNmbe,
    minR2: std.defaultMinR2,
    citation: std.citation,
    version: std.version,
    normativeNote: std.normativeNote,
  };
}
