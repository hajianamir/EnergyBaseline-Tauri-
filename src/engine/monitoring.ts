import {
  DatasetRow,
  DatasetState,
  DriftStatus,
  LockedBaseline,
  MonitoringSnapshot,
  PredictionMonitoringPoint,
} from './types';
import { getBaselineRows, mean, normalPValueTwoSided, stdDev } from './stats';
import { deterministicHash } from './synthetic';
import { computeRegressionMetrics, predictFromModelPayload, SerializedModelPayload, TEMPORAL_FEATURE_LOOKBACK } from './modeling';
import { DOMAIN_PROFILES } from './domains';

interface PredictParamsShape {
  family: string;
  features: string[];
  coeffs: { term: string; value: number }[];
  bestTh: number;
  bestTc: number;
  colMedians: Record<string, number>;
  meanTarget: number;
  oofRmse: number;
  conformalHalfWidth: number;
  modelPayload?: SerializedModelPayload | null;
}

export function buildTemporalWarmupContext(
  requestedRows: DatasetRow[],
  trainingDataset: DatasetState,
  warmupSteps = TEMPORAL_FEATURE_LOOKBACK
): { rows: DatasetRow[]; scoreOffset: number; requestedOrder: number[] } {
  const orderedRequests = requestedRows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((a, b) => a.row.timestamp.localeCompare(b.row.timestamp) || a.originalIndex - b.originalIndex);
  if (orderedRequests.length === 0) return { rows: [], scoreOffset: 0, requestedOrder: [] };
  const firstRequestedTimestamp = orderedRequests[0].row.timestamp;
  const prefix = warmupSteps > 0
    ? trainingDataset.rows
        .filter((row) => row.timestamp < firstRequestedTimestamp)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-Math.floor(warmupSteps))
    : [];
  return {
    rows: [...prefix, ...orderedRequests.map(({ row }) => row)],
    scoreOffset: prefix.length,
    requestedOrder: orderedRequests.map(({ originalIndex }) => originalIndex),
  };
}

function evaluatePredictParamsOverRows(
  rows: DatasetRow[],
  pObj: PredictParamsShape,
  fallbackFeatures: string[],
  isParametricHint?: boolean
): number[] {
  const feats = pObj.features && pObj.features.length > 0 ? pObj.features : fallbackFeatures;
  const colMedians = pObj.colMedians ?? {};
  const payload = pObj.modelPayload;

  if (payload && payload.kind === 'ensemble_blend') {
    const preds1 = evaluatePredictParamsOverRows(rows, payload.p1 as unknown as PredictParamsShape, feats);
    const preds2 = evaluatePredictParamsOverRows(rows, payload.p2 as unknown as PredictParamsShape, feats);
    return rows.map((_, i) => payload.w1 * (preds1[i] ?? pObj.meanTarget) + payload.w2 * (preds2[i] ?? pObj.meanTarget));
  }

  if (payload && isParametricHint !== true) {
    return predictFromModelPayload(rows, payload, feats, colMedians);
  }

  const coeffs = pObj.coeffs ?? [];
  return rows.map((r) => {
    let pred = pObj.meanTarget;
    if (pObj.family === 'changepoint' && coeffs.length >= 3) {
      const tempFeat = feats[0];
      const tVal = typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat] ?? 16;
      pred =
        coeffs[0].value +
        coeffs[1].value * Math.max(0, tVal - pObj.bestTc) +
        coeffs[2].value * Math.max(0, pObj.bestTh - tVal);
      feats.slice(1).forEach((f, idx) => {
        const fv = typeof r[f] === 'number' ? (r[f] as number) : colMedians[f] ?? 0;
        pred += (coeffs[idx + 3]?.value ?? 0) * fv;
      });
    } else if (pObj.family === 'degree_day' && coeffs.length >= 3) {
      const tempFeat = feats[0];
      const tVal = typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat] ?? 16;
      pred =
        coeffs[0].value +
        coeffs[1].value * Math.max(0, tVal - pObj.bestTc) +
        coeffs[2].value * Math.max(0, pObj.bestTh - tVal);
    } else if (pObj.family === 'towt' && coeffs.length >= 5) {
      const tempFeat = feats[0];
      const tVal = typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat] ?? 16;
      const dow = new Date(r.timestamp).getUTCDay();
      const wknd = dow === 0 || dow === 6 ? 1 : 0;
      const cdd = Math.max(0, tVal - pObj.bestTc);
      const hdd = Math.max(0, pObj.bestTh - tVal);
      pred = coeffs[0].value + coeffs[1].value * wknd + coeffs[2].value * cdd + coeffs[3].value * hdd + coeffs[4].value * wknd * cdd;
      const otherFeatures = feats.filter((feature) => feature !== tempFeat && !/weekend/i.test(feature)).slice(0, 2);
      otherFeatures.forEach((feature, index) => {
        const value = typeof r[feature] === 'number' ? r[feature] as number : colMedians[feature] ?? 0;
        pred += (coeffs[index + 5]?.value ?? 0) * value;
      });
    } else if (coeffs.length >= 1) {
      pred = coeffs[0].value;
      feats.forEach((f, idx) => {
        const fv = typeof r[f] === 'number' ? (r[f] as number) : colMedians[f] ?? 0;
        pred += (coeffs[idx + 1]?.value ?? 0) * fv;
      });
    }
    return pred;
  });
}

export function predictFromLockedBaseline(
  baseline: LockedBaseline,
  rows: DatasetRow[],
  trainingDataset: DatasetState,
  alertRule: 'auto' | 'percent_10' | 'k_rmse_2' | 'outside_interval' = 'auto'
): {
  points: PredictionMonitoringPoint[];
  drift: DriftStatus;
  extrapolationSharePct: number;
  alertRuleDescription: string;
} {
  const params = baseline.candidate.predictFnParams as unknown as PredictParamsShape;
  const domainProf = DOMAIN_PROFILES[trainingDataset.domain] ?? DOMAIN_PROFILES.custom;

  const trainRows = getBaselineRows(trainingDataset);
  const featureRanges: Record<string, { min: number; max: number }> = {};
  for (const f of baseline.features) {
    const vals = trainRows.map((r) => r[f]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    featureRanges[f] = {
      min: vals.length > 0 ? Math.min(...vals) : -Infinity,
      max: vals.length > 0 ? Math.max(...vals) : Infinity,
    };
  }

  const halfWidth = params.conformalHalfWidth || params.oofRmse * 1.96;
  const oofCv = baseline.candidate.oofCvRmse;
  const pctThresh = Math.max(10, 2 * oofCv);
  const rmseThresh = 2 * Math.max(1e-6, params.oofRmse);
  let alertRuleDescription = `AUTO alert rule: |deviation| > max(10%, 2×CV(RMSE)=${pctThresh.toFixed(1)}%) with 2-step persistence`;
  if (alertRule === 'percent_10') alertRuleDescription = 'Fixed 10% deviation threshold with 2-step persistence';
  else if (alertRule === 'k_rmse_2') alertRuleDescription = `2 × OOF RMSE (±${rmseThresh.toFixed(1)}) threshold`;
  else if (alertRule === 'outside_interval') alertRuleDescription = 'Outside conformal prediction interval';

  // Temporal models receive the immediately preceding baseline rows as causal warm-up
  // context; only predictions aligned to the requested monitoring rows are scored.
  const predictionContext = buildTemporalWarmupContext(rows, trainingDataset);
  const contextPreds = evaluatePredictParamsOverRows(
    predictionContext.rows,
    params,
    baseline.features,
    baseline.candidate.isParametric && !params.modelPayload
  );
  const chronologicalPredictions = contextPreds.slice(predictionContext.scoreOffset);
  const forwardPreds = new Array<number>(rows.length).fill(params.meanTarget);
  predictionContext.requestedOrder.forEach((originalIndex, chronologicalIndex) => {
    forwardPreds[originalIndex] = chronologicalPredictions[chronologicalIndex] ?? params.meanTarget;
  });

  const points: PredictionMonitoringPoint[] = [];
  let cumDev = 0;
  let extrapCount = 0;
  let consecutiveExceed = 0;

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const r = rows[rowIdx];
    const pred = Number.isFinite(forwardPreds[rowIdx]) ? forwardPreds[rowIdx] : params.meanTarget;

    let outOfRange = false;
    for (const f of baseline.features) {
      const v = r[f];
      if (typeof v === 'number' && (v < featureRanges[f].min || v > featureRanges[f].max)) {
        outOfRange = true;
      }
    }
    if (outOfRange) extrapCount++;

    const actualRaw = r[baseline.target];
    const actual = typeof actualRaw === 'number' && Number.isFinite(actualRaw) ? Number(actualRaw.toFixed(2)) : null;
    const baseVal = Number(pred.toFixed(2));
    const lower = Number((baseVal - halfWidth).toFixed(2));
    const upper = Number((baseVal + halfWidth).toFixed(2));

    let deviation: number | null = null;
    let deviationPct: number | null = null;
    let normalizedDeviation: number | null = null;
    let rawExceed = false;

    if (actual !== null) {
      deviation = Number((actual - baseVal).toFixed(2)); // PM-5: deviation = actual - baseline
      cumDev = Number((cumDev + deviation).toFixed(2));
      deviationPct = Math.abs(baseVal) > 1e-4 ? Number(((deviation / baseVal) * 100).toFixed(2)) : null;
      normalizedDeviation = Number((deviation / Math.max(1e-6, params.oofRmse)).toFixed(2));

      if (alertRule === 'outside_interval') rawExceed = actual < lower || actual > upper;
      else if (alertRule === 'k_rmse_2') rawExceed = Math.abs(deviation) > rmseThresh;
      else if (alertRule === 'percent_10') rawExceed = deviationPct !== null ? Math.abs(deviationPct) > 10 : Math.abs(deviation) > rmseThresh;
      else rawExceed = deviationPct !== null ? Math.abs(deviationPct) > pctThresh : Math.abs(deviation) > rmseThresh;
    }

    if (rawExceed) consecutiveExceed++;
    else consecutiveExceed = Math.max(0, consecutiveExceed - 1); // Hysteresis

    points.push({
      timestamp: r.timestamp,
      actual,
      baseline: baseVal,
      deviation,
      deviationPct,
      cumulativeDeviation: actual !== null ? cumDev : null,
      normalizedDeviation,
      lower,
      upper,
      alert: consecutiveExceed >= 2 || (actual !== null && (actual < lower || actual > upper) && Math.abs(normalizedDeviation ?? 0) > 2.5),
      outOfTrainingRange: outOfRange,
    });
  }

  // Drift Detection (DR-1 Input Drift: PSI, KS, Wasserstein; DR-2 Residual Drift: CUSUM, EWMA, Page-Hinkley)
  const inputDrift = baseline.features.map((f) => {
    const trVals = trainRows.map((r) => r[f]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const monVals = rows.map((r) => r[f]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (trVals.length < 5 || monVals.length < 5) {
      return { feature: f, psi: 0, ksStat: 0, ksPValue: 1, wasserstein: 0, status: 'ok' as const };
    }
    const mn = Math.min(...trVals);
    const mx = Math.max(...trVals);
    const bins = 5;
    let psi = 0;
    if (mx > mn) {
      for (let b = 0; b < bins; b++) {
        const lo = mn + (b / bins) * (mx - mn);
        const hi = mn + ((b + 1) / bins) * (mx - mn);
        const pTr = Math.max(0.001, trVals.filter((v) => v >= lo && (b === bins - 1 ? v <= hi : v < hi)).length / trVals.length);
        const pMon = Math.max(0.001, monVals.filter((v) => v >= lo && (b === bins - 1 ? v <= hi : v < hi)).length / monVals.length);
        psi += (pMon - pTr) * Math.log(pMon / pTr);
      }
    }
    // 2-sample KS stat
    const allSorted = Array.from(new Set([...trVals, ...monVals])).sort((a, b) => a - b);
    let ksStat = 0;
    for (const v of allSorted) {
      const f1 = trVals.filter((x) => x <= v).length / trVals.length;
      const f2 = monVals.filter((x) => x <= v).length / monVals.length;
      ksStat = Math.max(ksStat, Math.abs(f1 - f2));
    }
    const ne = (trVals.length * monVals.length) / (trVals.length + monVals.length);
    const ksP = Math.max(0.0001, Math.min(1, 2 * Math.exp(-2 * ne * ksStat * ksStat)));
    const wass = Math.abs(mean(monVals) - mean(trVals)) / (stdDev(trVals) || 1);
    const status: 'ok' | 'warn' | 'drift' = psi >= 0.25 || ksStat >= 0.35 ? 'drift' : psi >= 0.1 || ksStat >= 0.2 ? 'warn' : 'ok';
    return {
      feature: f,
      psi: Number(psi.toFixed(3)),
      ksStat: Number(ksStat.toFixed(3)),
      ksPValue: Number(ksP.toFixed(4)),
      wasserstein: Number(wass.toFixed(3)),
      status,
    };
  });

  // Residual Drift (CUSUM, EWMA, Page-Hinkley)
  const validPts = points.filter((p) => p.actual !== null && p.normalizedDeviation !== null);
  const zRes = validPts.map((p) => p.normalizedDeviation!);
  let cusumPos = 0;
  let cusumNeg = 0;
  let cusumMax = 0;
  let ewma = 0;
  let ewmaExceedances = 0;
  let phSum = 0;
  let phMin = 0;
  let pageHinkleyTriggered = false;

  for (const z of zRes) {
    cusumPos = Math.max(0, cusumPos + z - 0.5);
    cusumNeg = Math.max(0, cusumNeg - z - 0.5);
    cusumMax = Math.max(cusumMax, cusumPos, cusumNeg);

    ewma = 0.25 * z + 0.75 * ewma;
    if (Math.abs(ewma) > 1.35) ewmaExceedances++;

    phSum += Math.abs(z) - 0.8;
    phMin = Math.min(phMin, phSum);
    if (phSum - phMin > 12) pageHinkleyTriggered = true;
  }

  const monActuals = validPts.map((p) => p.actual!);
  const monBase = validPts.map((p) => p.baseline);
  const rollMet = computeRegressionMetrics(monActuals, monBase);
  const zMean = zRes.length > 0 ? mean(zRes) : 0;
  const breakP = zRes.length > 5 ? normalPValueTwoSided(zMean * Math.sqrt(zRes.length)) : null;

  const hasResDrift = pageHinkleyTriggered || cusumMax > 8 || Math.abs(rollMet.nmbe) > 8;
  const hasInputDrift = inputDrift.some((d) => d.status === 'drift');
  const trafficLight: DriftStatus['trafficLight'] = hasResDrift ? 'red' : hasInputDrift || ewmaExceedances > 3 ? 'amber' : 'green';

  const recommendation =
    trafficLight === 'red'
      ? `Baseline re-validation recommended for ${domainProf.baselineNoun} (persistent residual shift detected; may indicate intervention impact or non-routine drift; locked baseline is never auto-replaced).`
      : trafficLight === 'amber'
        ? 'Monitor closely: moderate covariate shift or early EWMA signal detected.'
        : `${domainProf.baselineNoun} remains stable within expected operating envelope.`;

  return {
    points,
    extrapolationSharePct: Number(((extrapCount / Math.max(1, rows.length)) * 100).toFixed(1)),
    alertRuleDescription,
    drift: {
      target: baseline.target,
      trafficLight,
      recommendation,
      inputDrift,
      residualDrift: {
        cusumMax: Number(cusumMax.toFixed(2)),
        ewmaExceedances,
        pageHinkleyTriggered,
        rollingCvRmse: rollMet.cvRmse,
        baselineOofCvRmse: baseline.candidate.oofCvRmse,
        rollingNmbe: rollMet.nmbe,
        structuralBreakP: breakP !== null ? Number(breakP.toFixed(4)) : null,
        interpretation:
          trafficLight === 'red'
            ? `Rolling NMBE=${rollMet.nmbe.toFixed(2)}% vs baseline OOF NMBE=${baseline.candidate.oofNmbe.toFixed(2)}%. ${domainProf.deviationHintNegative}`
            : `Rolling CV(RMSE)=${rollMet.cvRmse.toFixed(2)}% vs baseline OOF=${baseline.candidate.oofCvRmse.toFixed(2)}%.`,
      },
      checkedAt: new Date().toISOString(),
    },
  };
}

export function createMonitoringSnapshot(
  baseline: LockedBaseline,
  source: 'file' | 'sql' | 'manual',
  rows: DatasetRow[],
  result: ReturnType<typeof predictFromLockedBaseline>
): MonitoringSnapshot {
  return {
    id: `snap-${baseline.target}-${Date.now()}`,
    target: baseline.target,
    baselineVersion: baseline.version,
    inputHash: deterministicHash(JSON.stringify(rows)),
    source,
    createdAt: new Date().toISOString(),
    points: result.points,
    drift: result.drift,
    extrapolationSharePct: result.extrapolationSharePct,
  };
}
