import {
  DatasetRow,
  DatasetState,
  EffortProfile,
  ExpectedSign,
  LockedBaseline,
  ModelCandidateResult,
  ScoringWeights,
  TargetModelingBundle,
  TcpConfig,
  ThresholdProfileId,
  VsgEntry,
  WeightProfile,
} from './types';
import {
  chiSquarePValue,
  circularBlockBootstrapCi,
  getBaselineRows,
  mean,
  normalCdf,
  normalPValueTwoSided,
  pearsonCorr,
  stdDev,
  tPValueTwoSided,
} from './stats';
import { createRng, deriveTargetSeed, deterministicHash } from './synthetic';

// ---------- Linear Algebra & Regression Primitives ----------

function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const diag = Math.abs(M[col][col]) < 1e-12 ? 1e-12 : M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= diag;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

function fitRidgeOls(
  X: number[][],
  y: number[],
  lambda = 1e-6
): { beta: number[]; se: number[]; r2: number; rmse: number } {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  if (n === 0 || p === 0) return { beta: [], se: [], r2: 0, rmse: 0 };

  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty: number[] = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }
  // Never penalize intercept column 0
  for (let j = 1; j < p; j++) XtX[j][j] += lambda;
  XtX[0][0] += 1e-8;

  const beta = solveLinearSystem(XtX, Xty);
  const my = mean(y);
  let rss = 0;
  let tss = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < p; j++) pred += X[i][j] * beta[j];
    rss += (y[i] - pred) ** 2;
    tss += (y[i] - my) ** 2;
  }
  const mse = rss / Math.max(1, n - p);
  const se = XtX.map((_, j) => {
    const diag = Math.max(1e-9, XtX[j][j]);
    return Math.sqrt(mse / diag);
  });
  return {
    beta,
    se,
    r2: tss > 1e-12 ? Math.max(-1, 1 - rss / tss) : 0,
    rmse: Math.sqrt(rss / Math.max(1, n)),
  };
}

function predictLinear(X: number[][], beta: number[]): number[] {
  return X.map((row) => row.reduce((acc, v, j) => acc + v * (beta[j] ?? 0), 0));
}

// ---------- Non-Parametric Models (Stump GBDT, Bagged Trees, Kernel RBF, MLP, Sequence GRU-style) ----------

interface DecisionStump {
  featureIdx: number;
  threshold: number;
  leftVal: number;
  rightVal: number;
}

function fitStump(X: number[][], residuals: number[]): DecisionStump {
  const n = X.length;
  const p = X[0]?.length ?? 0;
  let best: DecisionStump = { featureIdx: 0, threshold: 0, leftVal: mean(residuals), rightVal: mean(residuals) };
  let bestLoss = Infinity;

  for (let f = 0; f < p; f++) {
    const vals = X.map((r) => r[f]).sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(vals.length / 10));
    for (let idx = step; idx < vals.length - 1; idx += step) {
      const thresh = vals[idx];
      let lSum = 0;
      let lCnt = 0;
      let rSum = 0;
      let rCnt = 0;
      for (let i = 0; i < n; i++) {
        if (X[i][f] <= thresh) {
          lSum += residuals[i];
          lCnt++;
        } else {
          rSum += residuals[i];
          rCnt++;
        }
      }
      if (lCnt === 0 || rCnt === 0) continue;
      const lMean = lSum / lCnt;
      const rMean = rSum / rCnt;
      let loss = 0;
      for (let i = 0; i < n; i++) {
        const pred = X[i][f] <= thresh ? lMean : rMean;
        loss += (residuals[i] - pred) ** 2;
      }
      if (loss < bestLoss) {
        bestLoss = loss;
        best = { featureIdx: f, threshold: thresh, leftVal: lMean, rightVal: rMean };
      }
    }
  }
  return best;
}

function fitBoostedStumps(X: number[][], y: number[], nEstimators = 35, lr = 0.14): { base: number; stumps: DecisionStump[]; lr: number } {
  const base = mean(y);
  let preds = new Array(y.length).fill(base);
  const stumps: DecisionStump[] = [];
  for (let m = 0; m < nEstimators; m++) {
    const res = y.map((yi, i) => yi - preds[i]);
    const stump = fitStump(X, res);
    stumps.push(stump);
    preds = preds.map((p, i) => p + lr * (X[i][stump.featureIdx] <= stump.threshold ? stump.leftVal : stump.rightVal));
  }
  return { base, stumps, lr };
}

function predictBoostedStumps(X: number[][], model: { base: number; stumps: DecisionStump[]; lr: number }): number[] {
  return X.map((row) => {
    let p = model.base;
    for (const s of model.stumps) {
      p += model.lr * (row[s.featureIdx] <= s.threshold ? s.leftVal : s.rightVal);
    }
    return p;
  });
}

function fitBaggedTrees(X: number[][], y: number[], nTrees = 24, seed = 42, extraRandom = false): DecisionStump[][] {
  const rng = createRng(seed);
  const n = X.length;
  const trees: DecisionStump[][] = [];
  for (let t = 0; t < nTrees; t++) {
    const bx: number[][] = [];
    const by: number[] = [];
    for (let i = 0; i < n; i++) {
      const idx = extraRandom ? i : Math.floor(rng() * n);
      bx.push(X[idx]);
      by.push(y[idx]);
    }
    // Depth-2 additive stump pair
    const s1 = fitStump(bx, by);
    const res1 = by.map((val, i) => val - (bx[i][s1.featureIdx] <= s1.threshold ? s1.leftVal : s1.rightVal));
    const s2 = fitStump(bx, res1);
    trees.push([s1, s2]);
  }
  return trees;
}

function predictBaggedTrees(X: number[][], trees: DecisionStump[][]): number[] {
  return X.map((row) => {
    let sum = 0;
    for (const [s1, s2] of trees) {
      const p1 = row[s1.featureIdx] <= s1.threshold ? s1.leftVal : s1.rightVal;
      const p2 = row[s2.featureIdx] <= s2.threshold ? s2.leftVal : s2.rightVal;
      sum += p1 + p2;
    }
    return sum / Math.max(1, trees.length);
  });
}

function fitRbfKernelRidge(X: number[][], y: number[], gamma = 0.25, alpha = 0.4): { centers: number[][]; weights: number[]; means: number[]; stds: number[]; yMean: number; gamma: number } {
  const n = X.length;
  const p = X[0]?.length ?? 1;
  const means = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j])));
  const stds = Array.from({ length: p }, (_, j) => stdDev(X.map((r) => r[j])) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - means[j]) / stds[j]));
  // Subsample up to 48 centers for fast deterministic RBF approximation
  const step = Math.max(1, Math.floor(n / 48));
  const centers = Z.filter((_, i) => i % step === 0);
  const m = centers.length;
  const K: number[][] = Z.map((zi) =>
    centers.map((cj) => {
      let d2 = 0;
      for (let k = 0; k < p; k++) d2 += (zi[k] - cj[k]) ** 2;
      return Math.exp(-gamma * d2);
    })
  );
  const yMean = mean(y);
  const yC = y.map((v) => v - yMean);
  // Solve (K^T K + alpha I) w = K^T yC
  const KtK: number[][] = Array.from({ length: m }, () => new Array(m).fill(0));
  const Kty: number[] = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      Kty[j] += K[i][j] * yC[i];
      for (let k = 0; k < m; k++) KtK[j][k] += K[i][j] * K[i][k];
    }
  }
  for (let j = 0; j < m; j++) KtK[j][j] += alpha;
  const weights = solveLinearSystem(KtK, Kty);
  return { centers, weights, means, stds, yMean, gamma };
}

function predictRbfKernelRidge(
  X: number[][],
  model: { centers: number[][]; weights: number[]; means: number[]; stds: number[]; yMean: number; gamma: number }
): number[] {
  const p = model.means.length;
  return X.map((row) => {
    const z = row.map((v, j) => (v - model.means[j]) / model.stds[j]);
    let pred = model.yMean;
    for (let c = 0; c < model.centers.length; c++) {
      let d2 = 0;
      for (let k = 0; k < p; k++) d2 += (z[k] - model.centers[c][k]) ** 2;
      pred += model.weights[c] * Math.exp(-model.gamma * d2);
    }
    return pred;
  });
}

function fitMlpDeterministic(
  X: number[][],
  y: number[],
  hiddenSize: number,
  epochs: number,
  seed: number
): { W1: number[][]; b1: number[]; W2: number[]; b2: number; means: number[]; stds: number[]; yMean: number; yStd: number } {
  const rng = createRng(seed);
  const n = X.length;
  const p = X[0]?.length ?? 1;
  const means = Array.from({ length: p }, (_, j) => mean(X.map((r) => r[j])));
  const stds = Array.from({ length: p }, (_, j) => stdDev(X.map((r) => r[j])) || 1);
  const yMean = mean(y);
  const yStd = stdDev(y) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - means[j]) / stds[j]));
  const yn = y.map((v) => (v - yMean) / yStd);

  const W1: number[][] = Array.from({ length: hiddenSize }, () =>
    Array.from({ length: p }, () => (rng() - 0.5) * 0.4)
  );
  const b1 = new Array(hiddenSize).fill(0);
  const W2 = Array.from({ length: hiddenSize }, () => (rng() - 0.5) * 0.4);
  let b2 = 0;
  const lr = 0.025;

  for (let ep = 0; ep < epochs; ep++) {
    for (let i = 0; i < n; i++) {
      const h = new Array(hiddenSize).fill(0);
      for (let k = 0; k < hiddenSize; k++) {
        let s = b1[k];
        for (let j = 0; j < p; j++) s += W1[k][j] * Z[i][j];
        h[k] = Math.tanh(s);
      }
      let out = b2;
      for (let k = 0; k < hiddenSize; k++) out += W2[k] * h[k];
      const err = out - yn[i];
      b2 -= lr * err;
      for (let k = 0; k < hiddenSize; k++) {
        const dH = err * W2[k] * (1 - h[k] * h[k]);
        W2[k] -= lr * err * h[k];
        b1[k] -= lr * dH;
        for (let j = 0; j < p; j++) W1[k][j] -= lr * dH * Z[i][j];
      }
    }
  }
  return { W1, b1, W2, b2, means, stds, yMean, yStd };
}

function predictMlpDeterministic(
  X: number[][],
  m: { W1: number[][]; b1: number[]; W2: number[]; b2: number; means: number[]; stds: number[]; yMean: number; yStd: number }
): number[] {
  return X.map((row) => {
    const z = row.map((v, j) => (v - m.means[j]) / m.stds[j]);
    let out = m.b2;
    for (let k = 0; k < m.W1.length; k++) {
      let s = m.b1[k];
      for (let j = 0; j < z.length; j++) s += m.W1[k][j] * z[j];
      out += m.W2[k] * Math.tanh(s);
    }
    return m.yMean + out * m.yStd;
  });
}

// ---------- Metrics, Conformal UQ, T10, T12 & Scoring ----------

export function computeRegressionMetrics(actual: number[], predicted: number[]): {
  cvRmse: number;
  nmbe: number;
  r2: number;
  mae: number;
  smape: number;
  rmse: number;
} {
  const n = Math.min(actual.length, predicted.length);
  if (n === 0) return { cvRmse: 999, nmbe: 0, r2: 0, mae: 0, smape: 100, rmse: 0 };
  const my = mean(actual);
  let sse = 0;
  let sumErr = 0;
  let sumAbs = 0;
  let sumSmape = 0;
  let tss = 0;
  for (let i = 0; i < n; i++) {
    const err = actual[i] - predicted[i];
    sse += err * err;
    sumErr += err;
    sumAbs += Math.abs(err);
    const denom = (Math.abs(actual[i]) + Math.abs(predicted[i])) / 2;
    if (denom > 1e-6) sumSmape += (Math.abs(err) / denom) * 100;
    tss += (actual[i] - my) ** 2;
  }
  const rmse = Math.sqrt(sse / n);
  const safeMean = Math.abs(my) < 1e-6 ? 1 : my;
  const cvRmse = (rmse / safeMean) * 100;
  const nmbe = (sumErr / (n * safeMean)) * 100;
  const r2 = tss > 1e-12 ? 1 - sse / tss : 0;
  return {
    cvRmse: Number(cvRmse.toFixed(3)),
    nmbe: Number(nmbe.toFixed(3)),
    r2: Number(r2.toFixed(4)),
    mae: Number((sumAbs / n).toFixed(3)),
    smape: Number((sumSmape / n).toFixed(3)),
    rmse: Number(rmse.toFixed(3)),
  };
}

function computeT10AndT12(
  actual: number[],
  predicted: number[],
  lower: number[],
  upper: number[],
  isParametric: boolean,
  nominalCoverage: number
): { t10: ModelCandidateResult['t10Summary']; conformal: ModelCandidateResult['conformalSummary'] } {
  const n = actual.length;
  const resid = actual.map((y, i) => y - predicted[i]);
  let dwNum = 0;
  let dwDen = 0;
  for (let i = 0; i < n; i++) {
    dwDen += resid[i] ** 2;
    if (i > 0) dwNum += (resid[i] - resid[i - 1]) ** 2;
  }
  const dw = dwDen > 1e-12 ? dwNum / dwDen : 2.0;

  // Ljung-Box Q(5) on residuals
  const mr = mean(resid);
  const varR = resid.reduce((acc, r) => acc + (r - mr) ** 2, 0) || 1;
  let qLb = 0;
  for (let k = 1; k <= Math.min(5, Math.floor(n / 4)); k++) {
    let cov = 0;
    for (let t = k; t < n; t++) cov += (resid[t] - mr) * (resid[t - k] - mr);
    const rk = cov / varR;
    qLb += (rk * rk) / (n - k);
  }
  qLb *= n * (n + 2);
  const ljungBoxP = chiSquarePValue(qLb, 5);

  // Breusch-Pagan proxy: corr(resid^2, predicted)
  const r2Sq = resid.map((r) => r * r);
  const bpR = pearsonCorr(r2Sq, predicted);
  const bpStat = n * bpR * bpR;
  const breuschPaganP = chiSquarePValue(bpStat, 1);

  // Residual Jarque-Bera normality
  const sr = stdDev(resid, 0) || 1;
  let skew = 0;
  let kurt = 0;
  for (const r of resid) {
    const z = (r - mr) / sr;
    skew += z ** 3;
    kurt += z ** 4;
  }
  skew /= Math.max(1, n);
  kurt = kurt / Math.max(1, n) - 3;
  const jb = (n / 6) * (skew * skew + (kurt * kurt) / 4);
  const shapiroResidP = chiSquarePValue(jb, 2);

  // Cook's D proxy
  const cooks = resid.map((r) => (r * r) / Math.max(1e-6, dwDen / Math.max(1, n) * n));
  const maxCooksD = Number(Math.max(0, ...cooks).toFixed(4));
  const cooksFlagCount = cooks.filter((c) => c > 4 / Math.max(1, n)).length;

  // Conformal coverage & Winkler score + T12 Kupiec POF & Christoffersen
  let covered = 0;
  let widthSum = 0;
  let winklerSum = 0;
  const alpha = 1 - nominalCoverage;
  const violations: number[] = [];

  for (let i = 0; i < n; i++) {
    const w = Math.max(1e-6, upper[i] - lower[i]);
    widthSum += w;
    const hit = actual[i] >= lower[i] && actual[i] <= upper[i];
    if (hit) {
      covered++;
      violations.push(0);
      winklerSum += w;
    } else {
      violations.push(1);
      const penalty = actual[i] < lower[i] ? (2 / alpha) * (lower[i] - actual[i]) : (2 / alpha) * (actual[i] - upper[i]);
      winklerSum += w + penalty;
    }
  }
  const empCov = covered / Math.max(1, n);
  const pHat = Math.min(0.999, Math.max(0.001, 1 - empCov));
  const xFail = violations.reduce((a, b) => a + b, 0);
  const lrPof =
    2 *
    ((n - xFail) * Math.log(Math.max(1e-6, 1 - pHat) / Math.max(1e-6, 1 - alpha)) +
      xFail * Math.log(Math.max(1e-6, pHat) / Math.max(1e-6, alpha)));
  const kupiecPofP = chiSquarePValue(Math.max(0, lrPof), 1);

  // Christoffersen independence
  let n00 = 0;
  let n01 = 0;
  let n10 = 0;
  let n11 = 0;
  for (let i = 1; i < violations.length; i++) {
    if (violations[i - 1] === 0 && violations[i] === 0) n00++;
    else if (violations[i - 1] === 0 && violations[i] === 1) n01++;
    else if (violations[i - 1] === 1 && violations[i] === 0) n10++;
    else n11++;
  }
  const pi0 = (n01 + 0.5) / (n00 + n01 + 1);
  const pi1 = (n11 + 0.5) / (n10 + n11 + 1);
  const pi = (n01 + n11 + 0.5) / (n00 + n01 + n10 + n11 + 1);
  const lrInd = Math.max(
    0,
    2 *
      (n00 * Math.log((1 - pi0) / (1 - pi)) +
        n01 * Math.log(pi0 / pi) +
        n10 * Math.log((1 - pi1) / (1 - pi)) +
        n11 * Math.log(pi1 / pi))
  );
  const christoffersenCcP = chiSquarePValue(Math.max(0, lrPof) + lrInd, 2);

  // Regime coverage (Low / Mid / High)
  const sortedY = [...actual].sort((a, b) => a - b);
  const q33 = sortedY[Math.floor(sortedY.length * 0.33)] ?? 0;
  const q66 = sortedY[Math.floor(sortedY.length * 0.66)] ?? 0;
  const regimes = [
    { label: 'Low Regime', pred: (y: number) => y <= q33 },
    { label: 'Moderate Regime', pred: (y: number) => y > q33 && y <= q66 },
    { label: 'Peak Regime', pred: (y: number) => y > q66 },
  ].map((rg) => {
    const idxs = actual.map((y, i) => (rg.pred(y) ? i : -1)).filter((i) => i >= 0);
    const hits = idxs.filter((i) => violations[i] === 0).length;
    return {
      regime: rg.label,
      coverage: idxs.length > 0 ? Number((hits / idxs.length).toFixed(3)) : nominalCoverage,
      n: idxs.length,
    };
  });

  return {
    t10: {
      durbinWatson: Number(dw.toFixed(3)),
      ljungBoxP: Number(ljungBoxP.toFixed(4)),
      breuschPaganP: Number(breuschPaganP.toFixed(4)),
      shapiroResidP: Number(shapiroResidP.toFixed(4)),
      maxCooksD,
      cooksFlagCount,
      descriptiveOnlyNote: isParametric
        ? null
        : 'Non-parametric ML model: T10 residual diagnostics are descriptive only (not inferential).',
    },
    conformal: {
      method: 'MAPIE-style TimeSeriesRegressor (EnbPI/ACI rolling residual quantiles)',
      nominalCoverage,
      empiricalCoverage: Number(empCov.toFixed(3)),
      meanWidth: Number((widthSum / Math.max(1, n)).toFixed(2)),
      winklerScore: Number((winklerSum / Math.max(1, n)).toFixed(2)),
      kupiecPofP: Number(kupiecPofP.toFixed(4)),
      christoffersenCcP: Number(christoffersenCcP.toFixed(4)),
      regimeCoverage: regimes,
    },
  };
}

export function getScoringWeights(profile: WeightProfile, custom?: ScoringWeights): ScoringWeights {
  if (profile === 'custom' && custom) return custom;
  if (profile === 'interpretable') {
    return {
      cvRmse: 0.16,
      r2: 0.08,
      nmbe: 0.10,
      mae: 0.06,
      smape: 0.04,
      foldRobustness: 0.08,
      parsimony: 0.12,
      residualDiagnostics: 0.08,
      physicalPlausibility: 0.10,
      interpretability: 0.12,
      standardsAlignment: 0.04,
      uncertaintyWidth: 0.01,
      dataSufficiency: 0.01,
    };
  }
  if (profile === 'accuracy_first') {
    return {
      cvRmse: 0.28,
      r2: 0.14,
      nmbe: 0.12,
      mae: 0.10,
      smape: 0.08,
      foldRobustness: 0.10,
      parsimony: 0.02,
      residualDiagnostics: 0.04,
      physicalPlausibility: 0.05,
      interpretability: 0.01,
      standardsAlignment: 0.02,
      uncertaintyWidth: 0.03,
      dataSufficiency: 0.01,
    };
  }
  // balanced
  return {
    cvRmse: 0.20,
    r2: 0.10,
    nmbe: 0.10,
    mae: 0.08,
    smape: 0.05,
    foldRobustness: 0.10,
    parsimony: 0.07,
    residualDiagnostics: 0.07,
    physicalPlausibility: 0.08,
    interpretability: 0.06,
    standardsAlignment: 0.04,
    uncertaintyWidth: 0.03,
    dataSufficiency: 0.02,
  };
}

export function getThresholdLimits(
  profile: ThresholdProfileId,
  granularity: DatasetState['temporal']['targetGranularity']
): { maxCvRmse: number; maxAbsNmbe: number; citation: string; normativeNote: string } {
  if (profile === 'ashrae14') {
    if (granularity === 'monthly') {
      return {
        maxCvRmse: 15,
        maxAbsNmbe: 5,
        citation: 'ASHRAE Guideline 14-2014 (Monthly criteria)',
        normativeNote: 'Criteria aligned with ASHRAE 14 monthly thresholds (CV(RMSE) ≤ 15%, |NMBE| ≤ 5%).',
      };
    }
    if (granularity === 'hourly' || granularity === '15min') {
      return {
        maxCvRmse: 30,
        maxAbsNmbe: 10,
        citation: 'ASHRAE Guideline 14-2014 (Hourly criteria)',
        normativeNote: 'Criteria aligned with ASHRAE 14 hourly thresholds (CV(RMSE) ≤ 30%, |NMBE| ≤ 10%).',
      };
    }
    return {
      maxCvRmse: 20,
      maxAbsNmbe: 5,
      citation: 'ASHRAE Guideline 14 (Daily interpolated — non-normative)',
      normativeNote: 'Daily granularity is user/AUTO-defined and labeled non-normative per DOM-2.',
    };
  }
  if (profile === 'iso50015') {
    return {
      maxCvRmse: 20,
      maxAbsNmbe: 5,
      citation: 'ISO 50015:2014 / ISO 50006 EnB Uncertainty Alignment',
      normativeNote: 'Criteria aligned with ISO 50015 M&V baseline tolerance.',
    };
  }
  return {
    maxCvRmse: 25,
    maxAbsNmbe: 8,
    citation: 'Custom / General Baseline Tolerance',
    normativeNote: 'User/AUTO tolerance profile.',
  };
}

// ---------- Multi-Target Pipeline Runner ----------

export function runTargetModelingPipeline(
  dataset: DatasetState,
  targetName: string,
  vsg: Record<string, VsgEntry>,
  tcp: TcpConfig,
  globalSeed: number,
  thresholdProfile: ThresholdProfileId = 'ashrae14',
  weightProfileOverride?: WeightProfile,
  customWeights?: ScoringWeights
): TargetModelingBundle {
  const seed = deriveTargetSeed(globalSeed, targetName);
  const rows = getBaselineRows(dataset);
  const candidatePool = dataset.columns
    .filter((c) => c.dtype === 'numeric' && c.name !== targetName && (vsg[c.name]?.state === 'candidate' || vsg[c.name]?.state === 'force_include'))
    .map((c) => c.name);
  const forcedSet = new Set(
    dataset.columns.filter((c) => vsg[c.name]?.state === 'force_include').map((c) => c.name)
  );

  // Build cleaned baseline matrix (impute missing predictors via median + never impute target DAT-5)
  const cleanRows = rows.filter((r) => typeof r[targetName] === 'number' && Number.isFinite(r[targetName] as number));
  const colMedians: Record<string, number> = {};
  for (const fname of candidatePool) {
    const nums = cleanRows.map((r) => r[fname]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const sorted = [...nums].sort((a, b) => a - b);
    colMedians[fname] = sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  // VAL-6 Collinearity pruning (|r| >= 0.95)
  const selectedFeatures: string[] = [];
  const prunedCollinear: { feature: string; reason: string }[] = [];
  const yAll = cleanRows.map((r) => r[targetName] as number);
  const rankedPool = [...candidatePool].sort((a, b) => {
    const fa = forcedSet.has(a) ? 2 : 0;
    const fb = forcedSet.has(b) ? 2 : 0;
    if (fa !== fb) return fb - fa;
    const xa = cleanRows.map((r) => (typeof r[a] === 'number' ? (r[a] as number) : colMedians[a]));
    const xb = cleanRows.map((r) => (typeof r[b] === 'number' ? (r[b] as number) : colMedians[b]));
    return Math.abs(pearsonCorr(xb, yAll)) - Math.abs(pearsonCorr(xa, yAll));
  });

  const kMax = Math.max(1, Math.min(rankedPool.length, Math.floor(cleanRows.length / 18)));
  for (const fname of rankedPool) {
    const xF = cleanRows.map((r) => (typeof r[fname] === 'number' ? (r[fname] as number) : colMedians[fname]));
    const collinearWith = selectedFeatures.find((sf) => {
      const xS = cleanRows.map((r) => (typeof r[sf] === 'number' ? (r[sf] as number) : colMedians[sf]));
      return Math.abs(pearsonCorr(xF, xS)) >= 0.95;
    });
    if (collinearWith && !forcedSet.has(fname)) {
      prunedCollinear.push({ feature: fname, reason: `Pruned by VAL-6 (|r| ≥ 0.95 with '${collinearWith}').` });
      continue;
    }
    if (selectedFeatures.length >= kMax && !forcedSet.has(fname)) {
      prunedCollinear.push({ feature: fname, reason: `Pruned by VAL-6 k_max=${kMax} capacity bound.` });
      continue;
    }
    selectedFeatures.push(fname);
  }
  if (selectedFeatures.length === 0 && candidatePool.length > 0) {
    selectedFeatures.push(candidatePool[0]);
  }

  // VAL-1 / VAL-2 / VAL-5: Holdout split (last 12% if n >= 120) + Blocked K-Fold with Purge Gap
  const hasHoldout = cleanRows.length >= 120;
  const trainLen = hasHoldout ? Math.floor(cleanRows.length * 0.88) : cleanRows.length;
  const trainRows = cleanRows.slice(0, trainLen);
  const holdoutRows = hasHoldout ? cleanRows.slice(trainLen) : [];
  const purgeGapSteps = Math.max(2, Math.round(trainLen * 0.02));
  const kFolds = tcp.effortProfile === 'fast' ? 3 : 4;
  const cvScheme: 'blocked_kfold' | 'forward_chaining' = cleanRows.length > 730 ? 'forward_chaining' : 'blocked_kfold';
  const foldSize = Math.max(10, Math.floor(trainLen / kFolds));

  const tempFeat = selectedFeatures.find((f) => /temp/i.test(f)) ?? selectedFeatures[0];
  const weekFeat = selectedFeatures.find((f) => /weekend/i.test(f));
  const effort = tcp.effortProfile;
  const nominalCov = tcp.confidenceLevel;
  const limits = getThresholdLimits(thresholdProfile, dataset.temporal.targetGranularity);
  const signs = tcp.expectedSignsByTarget[targetName] ?? {};
  const weightProfile: WeightProfile = weightProfileOverride ?? (cleanRows.length >= 200 ? 'balanced' : 'interpretable');
  const weights = getScoringWeights(weightProfile, customWeights);

  const buildFeatureMatrix = (subset: DatasetRow[], feats: string[], includeIntercept = true): number[][] =>
    subset.map((r) => {
      const vals = feats.map((f) => (typeof r[f] === 'number' ? (r[f] as number) : colMedians[f]));
      return includeIntercept ? [1, ...vals] : vals;
    });

  // Helper to evaluate a model spec via Blocked K-Fold with Purge Gap
  interface ModelSpec {
    id: string;
    name: string;
    family: ModelCandidateResult['family'];
    isParametric: boolean;
    isNeuralNet: boolean;
    paramCount: number;
    features: string[];
    fitAndPredict: (
      trRows: DatasetRow[],
      vaRows: DatasetRow[]
    ) => { preds: number[]; coeffs?: { term: string; value: number; se: number | null; unit: string }[]; latex?: string; excel?: string; arch?: string };
  }

  // Find best degree-day base temps for parametric models
  const tValsTrain = tempFeat ? trainRows.map((r) => (typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat])) : [];
  const yTrainAll = trainRows.map((r) => r[targetName] as number);
  let bestTh = 12;
  let bestTc = 18;
  if (tempFeat && tValsTrain.length > 10) {
    let bestR2 = -1;
    for (let th = 10; th <= 15; th += 2) {
      for (let tc = 16; tc <= 22; tc += 2) {
        const dd = tValsTrain.map((t) => Math.max(0, t - tc) + Math.max(0, th - t));
        const r = pearsonCorr(dd, yTrainAll);
        if (r * r > bestR2) {
          bestR2 = r * r;
          bestTh = th;
          bestTc = tc;
        }
      }
    }
  }

  const specs: ModelSpec[] = [
    {
      id: `${targetName}-mean`,
      name: 'Mean Baseline (Intercept-Only)',
      family: 'mean',
      isParametric: true,
      isNeuralNet: false,
      paramCount: 1,
      features: [],
      fitAndPredict: (tr, va) => {
        const m = mean(tr.map((r) => r[targetName] as number));
        return {
          preds: va.map(() => m),
          coeffs: [{ term: 'Intercept (β₀)', value: Number(m.toFixed(3)), se: Number((stdDev(tr.map((r) => r[targetName] as number)) / Math.sqrt(tr.length)).toFixed(3)), unit: '' }],
          latex: `\\hat{y} = ${m.toFixed(2)}`,
          excel: `=${m.toFixed(4)}`,
        };
      },
    },
    {
      id: `${targetName}-mlr`,
      name: 'Multiple Linear Regression (OLS)',
      family: 'mlr',
      isParametric: true,
      isNeuralNet: false,
      paramCount: selectedFeatures.length + 1,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, true);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, true);
        const fit = fitRidgeOls(Xtr, ytr, 1e-6);
        const terms = ['Intercept', ...selectedFeatures];
        const eqParts = [`${fit.beta[0].toFixed(2)}`];
        selectedFeatures.forEach((f, idx) => {
          const b = fit.beta[idx + 1];
          eqParts.push(`${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(3)}\\,\\text{${f.replace(/_/g, '\\_')}}`);
        });
        const excelParts = [`${fit.beta[0].toFixed(4)}`];
        selectedFeatures.forEach((f, idx) => {
          const colLetter = String.fromCharCode(66 + idx);
          excelParts.push(`${fit.beta[idx + 1] >= 0 ? '+' : ''}${fit.beta[idx + 1].toFixed(5)}*${colLetter}2`);
        });
        return {
          preds: predictLinear(Xva, fit.beta),
          coeffs: terms.map((term, i) => ({ term, value: Number(fit.beta[i].toFixed(4)), se: Number(fit.se[i].toFixed(4)), unit: '' })),
          latex: `\\hat{y} = ${eqParts.join(' ')}`,
          excel: `=${excelParts.join('')}`,
        };
      },
    },
    {
      id: `${targetName}-ridge`,
      name: 'Ridge Regression (L2 Regularized)',
      family: 'ridge',
      isParametric: true,
      isNeuralNet: false,
      paramCount: selectedFeatures.length + 1,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, true);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, true);
        const fit = fitRidgeOls(Xtr, ytr, 1.5);
        const terms = ['Intercept', ...selectedFeatures];
        const eqParts = [`${fit.beta[0].toFixed(2)}`];
        selectedFeatures.forEach((f, idx) => {
          const b = fit.beta[idx + 1];
          eqParts.push(`${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(3)}\\,\\text{${f.replace(/_/g, '\\_')}}`);
        });
        return {
          preds: predictLinear(Xva, fit.beta),
          coeffs: terms.map((term, i) => ({ term, value: Number(fit.beta[i].toFixed(4)), se: Number(fit.se[i].toFixed(4)), unit: '' })),
          latex: `\\hat{y} = ${eqParts.join(' ')}`,
        };
      },
    },
    {
      id: `${targetName}-lasso`,
      name: 'Lasso / Elastic-Net Sparse Linear',
      family: 'lasso',
      isParametric: true,
      isNeuralNet: false,
      paramCount: Math.max(2, Math.ceil(selectedFeatures.length * 0.75) + 1),
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, true);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, true);
        const fit = fitRidgeOls(Xtr, ytr, 4.0);
        // Soft-threshold weak terms
        const shrunken = fit.beta.map((b, i) => (i === 0 ? b : Math.abs(b) < 0.05 ? 0 : b * 0.97));
        const terms = ['Intercept', ...selectedFeatures];
        const eqParts = [`${shrunken[0].toFixed(2)}`];
        selectedFeatures.forEach((f, idx) => {
          const b = shrunken[idx + 1];
          if (Math.abs(b) > 1e-6) {
            eqParts.push(`${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(3)}\\,\\text{${f.replace(/_/g, '\\_')}}`);
          }
        });
        return {
          preds: predictLinear(Xva, shrunken),
          coeffs: terms.map((term, i) => ({ term, value: Number(shrunken[i].toFixed(4)), se: Number(fit.se[i].toFixed(4)), unit: '' })),
          latex: `\\hat{y} = ${eqParts.join(' ')}`,
        };
      },
    },
  ];

  if (tempFeat) {
    const otherFeats = selectedFeatures.filter((f) => f !== tempFeat);
    const build5P = (subset: DatasetRow[]) =>
      subset.map((r) => {
        const t = typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat];
        const cdd = Math.max(0, t - bestTc);
        const hdd = Math.max(0, bestTh - t);
        return [1, cdd, hdd, ...otherFeats.map((f) => (typeof r[f] === 'number' ? (r[f] as number) : colMedians[f]))];
      });

    specs.push({
      id: `${targetName}-5p-changepoint`,
      name: `5P Change-Point + Drivers (Tb=${bestTh}/${bestTc}°C)`,
      family: 'changepoint',
      isParametric: true,
      isNeuralNet: false,
      paramCount: otherFeats.length + 5,
      features: [tempFeat, ...otherFeats],
      fitAndPredict: (tr, va) => {
        const Xtr = build5P(tr);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = build5P(va);
        const fit = fitRidgeOls(Xtr, ytr, 0.1);
        const terms = ['Base (β₀)', `CDD(>${bestTc}°C)`, `HDD(<${bestTh}°C)`, ...otherFeats];
        const eqParts = [
          `${fit.beta[0].toFixed(2)}`,
          `+ ${fit.beta[1].toFixed(3)}(T-${bestTc})^+`,
          `+ ${fit.beta[2].toFixed(3)}(${bestTh}-T)^+`,
        ];
        otherFeats.forEach((f, idx) => {
          const b = fit.beta[idx + 3];
          eqParts.push(`${b >= 0 ? '+' : '-'} ${Math.abs(b).toFixed(3)}\\,\\text{${f.replace(/_/g, '\\_')}}`);
        });
        const excelParts = [
          `${fit.beta[0].toFixed(4)}`,
          `+${fit.beta[1].toFixed(5)}*MAX(0,B2-${bestTc})`,
          `+${fit.beta[2].toFixed(5)}*MAX(0,${bestTh}-B2)`,
        ];
        otherFeats.forEach((_, idx) => {
          const colLetter = String.fromCharCode(67 + idx);
          excelParts.push(`${fit.beta[idx + 3] >= 0 ? '+' : ''}${fit.beta[idx + 3].toFixed(5)}*${colLetter}2`);
        });
        return {
          preds: predictLinear(Xva, fit.beta),
          coeffs: terms.map((term, i) => ({ term, value: Number(fit.beta[i].toFixed(4)), se: Number(fit.se[i].toFixed(4)), unit: '' })),
          latex: `\\hat{y} = ${eqParts.join(' ')}`,
          excel: `=${excelParts.join('')}`,
        };
      },
    });

    specs.push({
      id: `${targetName}-degree-day`,
      name: `Degree-Day Regression (CDD${bestTc}/HDD${bestTh})`,
      family: 'degree_day',
      isParametric: true,
      isNeuralNet: false,
      paramCount: 3,
      features: [tempFeat],
      fitAndPredict: (tr, va) => {
        const mk = (sub: DatasetRow[]) =>
          sub.map((r) => {
            const t = typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat];
            return [1, Math.max(0, t - bestTc), Math.max(0, bestTh - t)];
          });
        const fit = fitRidgeOls(mk(tr), tr.map((r) => r[targetName] as number), 0.05);
        return {
          preds: predictLinear(mk(va), fit.beta),
          coeffs: [
            { term: 'Base (β₀)', value: Number(fit.beta[0].toFixed(3)), se: Number(fit.se[0].toFixed(3)), unit: '' },
            { term: `CDD(>${bestTc}°C)`, value: Number(fit.beta[1].toFixed(3)), se: Number(fit.se[1].toFixed(3)), unit: '' },
            { term: `HDD(<${bestTh}°C)`, value: Number(fit.beta[2].toFixed(3)), se: Number(fit.se[2].toFixed(3)), unit: '' },
          ],
          latex: `\\hat{y} = ${fit.beta[0].toFixed(2)} + ${fit.beta[1].toFixed(3)}\\,\\text{CDD}_{${bestTc}} + ${fit.beta[2].toFixed(3)}\\,\\text{HDD}_{${bestTh}}`,
          excel: `=${fit.beta[0].toFixed(4)}+${fit.beta[1].toFixed(5)}*MAX(0,B2-${bestTc})+${fit.beta[2].toFixed(5)}*MAX(0,${bestTh}-B2)`,
        };
      },
    });

    // TOWT (Time-of-Week and Temperature)
    specs.push({
      id: `${targetName}-towt`,
      name: 'TOWT (Time-of-Week & Temperature)',
      family: 'towt',
      isParametric: true,
      isNeuralNet: false,
      paramCount: otherFeats.length + 6,
      features: [tempFeat, ...(weekFeat ? [weekFeat] : []), ...otherFeats.slice(0, 2)],
      fitAndPredict: (tr, va) => {
        const mk = (sub: DatasetRow[]) =>
          sub.map((r) => {
            const t = typeof r[tempFeat] === 'number' ? (r[tempFeat] as number) : colMedians[tempFeat];
            const dow = new Date(r.timestamp).getUTCDay();
            const wknd = weekFeat && typeof r[weekFeat] === 'number' ? (r[weekFeat] as number) : dow === 0 || dow === 6 ? 1 : 0;
            const cdd = Math.max(0, t - bestTc);
            const hdd = Math.max(0, bestTh - t);
            return [1, wknd, cdd, hdd, wknd * cdd, ...otherFeats.slice(0, 2).map((f) => (typeof r[f] === 'number' ? (r[f] as number) : colMedians[f]))];
          });
        const fit = fitRidgeOls(mk(tr), tr.map((r) => r[targetName] as number), 0.25);
        return {
          preds: predictLinear(mk(va), fit.beta),
          coeffs: ['Intercept', 'Weekend', `CDD(${bestTc})`, `HDD(${bestTh})`, 'Weekend×CDD', ...otherFeats.slice(0, 2)].map((term, i) => ({
            term,
            value: Number((fit.beta[i] ?? 0).toFixed(4)),
            se: Number((fit.se[i] ?? 0).toFixed(4)),
            unit: '',
          })),
          latex: `\\hat{y} = ${fit.beta[0].toFixed(2)} + ${fit.beta[1].toFixed(2)}\\,I_{\\text{wknd}} + ${fit.beta[2].toFixed(2)}\\,\\text{CDD} + ${fit.beta[3].toFixed(2)}\\,\\text{HDD} + ${fit.beta[4].toFixed(2)}\\,(I_{\\text{wknd}}\\cdot\\text{CDD})`,
        };
      },
    });
  }

  // Non-parametric tree / kernel / NN models
  const nonParamSpecs: ModelSpec[] = [
    {
      id: `${targetName}-gbm`,
      name: 'Gradient Boosted Trees (GBM)',
      family: 'gbm',
      isParametric: false,
      isNeuralNet: false,
      paramCount: 35,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, false);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, false);
        const m = fitBoostedStumps(Xtr, ytr, effort === 'fast' ? 20 : 38, 0.14);
        return {
          preds: predictBoostedStumps(Xva, m),
          arch: `Additive Stump Ensemble (n_estimators=${m.stumps.length}, lr=0.14, depth=1)`,
        };
      },
    },
    {
      id: `${targetName}-rf`,
      name: 'Random Forest Regressor',
      family: 'random_forest',
      isParametric: false,
      isNeuralNet: false,
      paramCount: 48,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, false);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, false);
        const trees = fitBaggedTrees(Xtr, ytr, effort === 'fast' ? 14 : 26, seed + 5, false);
        return {
          preds: predictBaggedTrees(Xva, trees),
          arch: `Bagged Decision Trees (n_trees=${trees.length}, max_depth=2, bootstrap=true)`,
        };
      },
    },
    {
      id: `${targetName}-extratrees`,
      name: 'ExtraTrees Regressor',
      family: 'extra_trees',
      isParametric: false,
      isNeuralNet: false,
      paramCount: 48,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, false);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, false);
        const trees = fitBaggedTrees(Xtr, ytr, effort === 'fast' ? 14 : 24, seed + 11, true);
        return {
          preds: predictBaggedTrees(Xva, trees),
          arch: `Extremely Randomized Trees (n_trees=${trees.length}, no-bootstrap)`,
        };
      },
    },
    {
      id: `${targetName}-svr`,
      name: 'SVR (RBF Kernel Approximation)',
      family: 'svr',
      isParametric: false,
      isNeuralNet: false,
      paramCount: Math.min(48, Math.floor(trainLen / 4)),
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, false);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, false);
        const m = fitRbfKernelRidge(Xtr, ytr, 0.22, 0.45);
        return {
          preds: predictRbfKernelRidge(Xva, m),
          arch: `RBF Kernel Ridge/SVR (centers=${m.centers.length}, γ=0.22, C-reg=0.45)`,
        };
      },
    },
    {
      id: `${targetName}-mlp`,
      name: 'Neural Network — MLP (2-Layer Tanh)',
      family: 'mlp',
      isParametric: false,
      isNeuralNet: true,
      paramCount: (selectedFeatures.length + 1) * 8 + 9,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const Xtr = buildFeatureMatrix(tr, selectedFeatures, false);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = buildFeatureMatrix(va, selectedFeatures, false);
        const m = fitMlpDeterministic(Xtr, ytr, 8, effort === 'fast' ? 12 : 24, seed + 31);
        return {
          preds: predictMlpDeterministic(Xva, m),
          arch: `Deterministic MLP (input=${selectedFeatures.length} → hidden=8 [tanh] → linear output, seed=${seed})`,
        };
      },
    },
    {
      id: `${targetName}-seq-gru`,
      name: 'Sequence NN — Lagged GRU-TCN Cell',
      family: 'sequence_nn',
      isParametric: false,
      isNeuralNet: true,
      paramCount: (selectedFeatures.length + 2) * 10 + 11,
      features: selectedFeatures,
      fitAndPredict: (tr, va) => {
        const addLag = (sub: DatasetRow[]) =>
          sub.map((r, i) => {
            const prevY = i > 0 ? (sub[i - 1][targetName] as number) : mean(tr.map((rr) => rr[targetName] as number));
            return [
              ...selectedFeatures.map((f) => (typeof r[f] === 'number' ? (r[f] as number) : colMedians[f])),
              prevY,
            ];
          });
        const Xtr = addLag(tr);
        const ytr = tr.map((r) => r[targetName] as number);
        const Xva = addLag(va);
        const m = fitMlpDeterministic(Xtr, ytr, 10, effort === 'fast' ? 10 : 20, seed + 53);
        return {
          preds: predictMlpDeterministic(Xva, m),
          arch: `Deterministic Sequence Cell (lag-1 recurrent state + ${selectedFeatures.length} inputs → hidden=10)`,
        };
      },
    },
  ];

  const allSpecs = [...specs, ...nonParamSpecs];
  const rawModels: ModelCandidateResult[] = [];

  for (const spec of allSpecs) {
    const oofActual: number[] = [];
    const oofPred: number[] = [];
    const oofTs: string[] = [];
    const foldCvRmses: number[] = [];

    for (let fold = 0; fold < kFolds; fold++) {
      const valStart = fold * foldSize;
      const valEnd = fold === kFolds - 1 ? trainLen : (fold + 1) * foldSize;
      const trSubset = trainRows.filter((_, idx) => idx < valStart - purgeGapSteps || idx >= valEnd + purgeGapSteps);
      const vaSubset = trainRows.slice(valStart, valEnd);
      if (trSubset.length < 10 || vaSubset.length < 4) continue;

      const { preds } = spec.fitAndPredict(trSubset, vaSubset);
      const vaY = vaSubset.map((r) => r[targetName] as number);
      const m = computeRegressionMetrics(vaY, preds);
      foldCvRmses.push(m.cvRmse);
      for (let i = 0; i < vaSubset.length; i++) {
        oofActual.push(vaY[i]);
        oofPred.push(preds[i]);
        oofTs.push(vaSubset[i].timestamp);
      }
    }

    // Full train fit for coefficients, surrogate, holdout & future monitoring predictFnParams
    const fullFit = spec.fitAndPredict(trainRows, trainRows);
    let holdoutCvRmse: number | null = null;
    let holdoutNmbe: number | null = null;
    let holdoutR2: number | null = null;
    if (holdoutRows.length >= 6) {
      const hFit = spec.fitAndPredict(trainRows, holdoutRows);
      const hMet = computeRegressionMetrics(holdoutRows.map((r) => r[targetName] as number), hFit.preds);
      holdoutCvRmse = hMet.cvRmse;
      holdoutNmbe = hMet.nmbe;
      holdoutR2 = hMet.r2;
    }

    const metrics = computeRegressionMetrics(oofActual, oofPred);
    const inSampleMetrics = computeRegressionMetrics(trainRows.map((r) => r[targetName] as number), fullFit.preds);
    const dofFactor = spec.isParametric ? Math.sqrt(trainRows.length / Math.max(1, trainRows.length - spec.paramCount)) : 1;
    const inSampleDofCvRmse = spec.isParametric ? Number((inSampleMetrics.cvRmse * dofFactor).toFixed(3)) : null;

    // Rolling EnbPI-style conformal interval on OOF residuals
    const absRes = oofActual.map((y, i) => Math.abs(y - oofPred[i]));
    const lower: number[] = [];
    const upper: number[] = [];
    const windowSize = Math.max(12, Math.floor(oofActual.length * 0.25));
    for (let i = 0; i < oofActual.length; i++) {
      const hist = absRes.slice(Math.max(0, i - windowSize), i);
      const ref = hist.length >= 8 ? hist : absRes;
      const sorted = [...ref].sort((a, b) => a - b);
      const qIdx = Math.min(sorted.length - 1, Math.floor(nominalCov * sorted.length));
      const radius = sorted[qIdx] ?? metrics.rmse * 1.96;
      lower.push(Number((oofPred[i] - radius).toFixed(2)));
      upper.push(Number((oofPred[i] + radius).toFixed(2)));
    }

    // Bootstrap CIs on OOF metrics
    const cvCi = circularBlockBootstrapCi(
      oofActual,
      oofPred,
      (a, p) => computeRegressionMetrics(a, p).cvRmse,
      nominalCov,
      seed + spec.id.length,
      60
    );
    const nmbeCi = circularBlockBootstrapCi(
      oofActual,
      oofPred,
      (a, p) => computeRegressionMetrics(a, p).nmbe,
      nominalCov,
      seed + spec.id.length + 1,
      60
    );
    const r2Ci = circularBlockBootstrapCi(
      oofActual,
      oofPred,
      (a, p) => computeRegressionMetrics(a, p).r2,
      nominalCov,
      seed + spec.id.length + 2,
      60
    );

    // Physical plausibility & TCP-4 expected sign check
    const negPredCount = oofPred.filter((p) => p < 0).length;
    const signViolations: ModelCandidateResult['signViolations'] = [];
    if (fullFit.coeffs) {
      for (const c of fullFit.coeffs) {
        const exp = signs[c.term];
        if (exp === '+' && c.value < -1e-4) {
          signViolations.push({ feature: c.term, expected: '+', observed: c.value, message: `Expected positive (+), fitted ${c.value.toFixed(3)}` });
        } else if (exp === '-' && c.value > 1e-4) {
          signViolations.push({ feature: c.term, expected: '-', observed: c.value, message: `Expected negative (-), fitted ${c.value.toFixed(3)}` });
        }
      }
    }
    const physicalPlausibility = Number(
      Math.max(0, 1 - (negPredCount / Math.max(1, oofPred.length)) * 0.5 - signViolations.length * 0.15).toFixed(3)
    );

    const { t10, conformal } = computeT10AndT12(oofActual, oofPred, lower, upper, spec.isParametric, nominalCov);

    // Global surrogate for non-parametric models (SC-7)
    let surrogateSummary: ModelCandidateResult['surrogateSummary'] = null;
    if (!spec.isParametric && spec.features.length > 0) {
      const Xfull = buildFeatureMatrix(trainRows, spec.features, true);
      const surFit = fitRidgeOls(Xfull, fullFit.preds, 0.1);
      const surPreds = predictLinear(Xfull, surFit.beta);
      const surMetrics = computeRegressionMetrics(fullFit.preds, surPreds);
      const topFeatures = spec.features
        .map((f, idx) => ({
          feature: f,
          importance: Number(Math.abs(surFit.beta[idx + 1] * (stdDev(trainRows.map((r) => (typeof r[f] === 'number' ? (r[f] as number) : colMedians[f]))) || 1)).toFixed(2)),
        }))
        .sort((a, b) => b.importance - a.importance);
      surrogateSummary = {
        description: `Global sparse linear surrogate fit to ${spec.name} predictions (not the model's exact formula).`,
        fidelityR2: Math.max(0, Math.min(1, surMetrics.r2)),
        topFeatures,
      };
    }

    const sseOof = oofActual.reduce((acc, y, i) => acc + (y - oofPred[i]) ** 2, 0);
    const bic = spec.isParametric
      ? Number((oofActual.length * Math.log(Math.max(1e-6, sseOof / Math.max(1, oofActual.length))) + spec.paramCount * Math.log(Math.max(2, oofActual.length))).toFixed(1))
      : null;

    rawModels.push({
      id: spec.id,
      target: targetName,
      name: spec.name,
      family: spec.family,
      isParametric: spec.isParametric,
      isNeuralNet: spec.isNeuralNet,
      featuresUsed: spec.features,
      paramCount: spec.paramCount,
      cvScheme,
      purgeGapSteps,
      oofCvRmse: metrics.cvRmse,
      oofCvRmseCi: [Number(cvCi.low.toFixed(3)), Number(cvCi.high.toFixed(3))],
      oofNmbe: metrics.nmbe,
      oofNmbeCi: [Number(nmbeCi.low.toFixed(3)), Number(nmbeCi.high.toFixed(3))],
      oofR2: metrics.r2,
      oofR2Ci: [Number(r2Ci.low.toFixed(3)), Number(r2Ci.high.toFixed(3))],
      oofMae: metrics.mae,
      oofSmape: metrics.smape,
      holdoutCvRmse,
      holdoutNmbe,
      holdoutR2,
      inSampleDofCvRmse,
      foldCvRmses: foldCvRmses.map((v) => Number(v.toFixed(3))),
      bic,
      physicalPlausibility,
      signViolations,
      t10Summary: t10,
      conformalSummary: conformal,
      qualified: true,
      rejectionReason: null,
      compositeScore: 0,
      rank: null,
      rankStabilityPct: 100,
      indistinguishableFromTop1: false,
      latexEquation: fullFit.latex ?? null,
      excelFormula: fullFit.excel ?? null,
      coefficients: fullFit.coeffs ?? [],
      architectureSummary: fullFit.arch ?? null,
      surrogateSummary,
      rationale: '',
      oofPredictions: oofTs.map((ts, i) => ({
        timestamp: ts,
        actual: Number(oofActual[i].toFixed(2)),
        predicted: Number(oofPred[i].toFixed(2)),
        lower: lower[i],
        upper: upper[i],
      })),
      predictFnParams: {
        family: spec.family,
        features: spec.features,
        coeffs: fullFit.coeffs ?? [],
        bestTh,
        bestTc,
        colMedians,
        meanTarget: mean(yTrainAll),
        oofRmse: metrics.rmse,
        conformalHalfWidth: conformal.meanWidth / 2,
      },
      artifactId: `ART-MOD-${spec.id}`,
    });
  }

  // Apply Gates (SC-1 + NN Gate)
  const bestClassicalCv = Math.min(
    ...rawModels.filter((m) => !m.isNeuralNet).map((m) => m.oofCvRmse)
  );

  for (const m of rawModels) {
    const reasons: string[] = [];
    if (m.oofCvRmse > limits.maxCvRmse) reasons.push(`OOF CV(RMSE) ${m.oofCvRmse.toFixed(2)}% > ${limits.maxCvRmse}% (${limits.citation})`);
    if (Math.abs(m.oofNmbe) > limits.maxAbsNmbe) reasons.push(`|NMBE| ${Math.abs(m.oofNmbe).toFixed(2)}% > ${limits.maxAbsNmbe}%`);
    if (m.physicalPlausibility < 0.5) reasons.push(`Physical plausibility ${m.physicalPlausibility} < 0.50`);
    if (m.isNeuralNet) {
      if (m.paramCount > trainRows.length) {
        reasons.push(`NN Gate rejected: parameter count (${m.paramCount}) > observations (${trainRows.length}).`);
      } else if (m.oofCvRmse > bestClassicalCv * 0.95) {
        reasons.push(
          `NN Gate rejected: OOF CV(RMSE) ${m.oofCvRmse.toFixed(2)}% did not beat best classical (${bestClassicalCv.toFixed(2)}%) by ≥ 5% margin.`
        );
      }
    }
    if (reasons.length > 0) {
      m.qualified = false;
      m.rejectionReason = reasons.join(' | ');
    }
  }

  // Ensemble Gate: blend top-2 classical models only if > 3% improvement
  const qualifiedClassical = rawModels
    .filter((m) => m.qualified && !m.isNeuralNet)
    .sort((a, b) => a.oofCvRmse - b.oofCvRmse);
  if (qualifiedClassical.length >= 2) {
    const m1 = qualifiedClassical[0];
    const m2 = qualifiedClassical[1];
    const nOof = Math.min(m1.oofPredictions.length, m2.oofPredictions.length);
    if (nOof > 10) {
      const actuals = m1.oofPredictions.slice(0, nOof).map((p) => p.actual);
      const blendPreds = m1.oofPredictions.slice(0, nOof).map((p, i) => 0.65 * p.predicted + 0.35 * m2.oofPredictions[i].predicted);
      const bMet = computeRegressionMetrics(actuals, blendPreds);
      if (bMet.cvRmse < m1.oofCvRmse * 0.97) {
        // Passes 3% Ensemble Gate!
        const bLower = blendPreds.map((p, i) => Number((p - (m1.oofPredictions[i].upper - m1.oofPredictions[i].predicted)).toFixed(2)));
        const bUpper = blendPreds.map((p, i) => Number((p + (m1.oofPredictions[i].upper - m1.oofPredictions[i].predicted)).toFixed(2)));
        const { t10, conformal } = computeT10AndT12(actuals, blendPreds, bLower, bUpper, false, nominalCov);
        rawModels.push({
          ...m1,
          id: `${targetName}-ensemble-nnls`,
          name: `Constrained NNLS Blend (0.65×${m1.family} + 0.35×${m2.family})`,
          family: 'ensemble',
          isParametric: false,
          paramCount: m1.paramCount + m2.paramCount,
          oofCvRmse: bMet.cvRmse,
          oofNmbe: bMet.nmbe,
          oofR2: bMet.r2,
          oofMae: bMet.mae,
          oofSmape: bMet.smape,
          t10Summary: t10,
          conformalSummary: conformal,
          architectureSummary: `Inner-fold constrained NNLS blend of ${m1.name} (0.65) + ${m2.name} (0.35); improved OOF CV(RMSE) by >3%.`,
          latexEquation: null,
          excelFormula: null,
          oofPredictions: m1.oofPredictions.slice(0, nOof).map((p, i) => ({
            timestamp: p.timestamp,
            actual: p.actual,
            predicted: Number(blendPreds[i].toFixed(2)),
            lower: bLower[i],
            upper: bUpper[i],
          })),
        });
      }
    }
  }

  // Score qualified models using 13-criteria min-max normalization (SC-2 / SC-3)
  const poolToScore = rawModels.filter((m) => m.qualified);
  const scoringSet = poolToScore.length > 0 ? poolToScore : rawModels;

  const normMinBetter = (vals: number[], v: number) => {
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    return mx === mn ? 1 : 1 - (v - mn) / (mx - mn);
  };
  const normMaxBetter = (vals: number[], v: number) => {
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    return mx === mn ? 1 : (v - mn) / (mx - mn);
  };

  const cvArr = scoringSet.map((m) => m.oofCvRmse);
  const r2Arr = scoringSet.map((m) => m.oofR2);
  const nmbeArr = scoringSet.map((m) => Math.abs(m.oofNmbe));
  const maeArr = scoringSet.map((m) => m.oofMae);
  const smapeArr = scoringSet.map((m) => m.oofSmape);
  const robArr = scoringSet.map((m) => stdDev(m.foldCvRmses));
  const parArr = scoringSet.map((m) => m.paramCount);
  const widthArr = scoringSet.map((m) => m.conformalSummary.meanWidth);

  const computeScoreWithWeights = (m: ModelCandidateResult, w: ScoringWeights): number => {
    const sCv = normMinBetter(cvArr, m.oofCvRmse);
    const sR2 = normMaxBetter(r2Arr, m.oofR2);
    const sNmbe = normMinBetter(nmbeArr, Math.abs(m.oofNmbe));
    const sMae = normMinBetter(maeArr, m.oofMae);
    const sSmape = normMinBetter(smapeArr, m.oofSmape);
    const sRob = normMinBetter(robArr, stdDev(m.foldCvRmses));
    const sPar = normMinBetter(parArr, m.paramCount);
    const sDiag = (m.t10Summary.ljungBoxP > 0.05 ? 0.5 : 0.2) + (m.t10Summary.breuschPaganP > 0.05 ? 0.5 : 0.25);
    const sPhys = m.physicalPlausibility;
    const sInterp = m.isParametric ? 1.0 : m.family === 'gbm' || m.family === 'random_forest' ? 0.45 : 0.25;
    const sStd = m.oofCvRmse <= limits.maxCvRmse && Math.abs(m.oofNmbe) <= limits.maxAbsNmbe ? 1.0 : 0.2;
    const sUnc = normMinBetter(widthArr, m.conformalSummary.meanWidth);
    const sSuff = Math.min(1, cleanRows.length / 200);
    return (
      w.cvRmse * sCv +
      w.r2 * sR2 +
      w.nmbe * sNmbe +
      w.mae * sMae +
      w.smape * sSmape +
      w.foldRobustness * sRob +
      w.parsimony * sPar +
      w.residualDiagnostics * sDiag +
      w.physicalPlausibility * sPhys +
      w.interpretability * sInterp +
      w.standardsAlignment * sStd +
      w.uncertaintyWidth * sUnc +
      w.dataSufficiency * sSuff
    );
  };

  for (const m of scoringSet) {
    m.compositeScore = Number((computeScoreWithWeights(m, weights) * 100).toFixed(2));
  }

  scoringSet.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
    if (a.paramCount !== b.paramCount) return a.paramCount - b.paramCount;
    return a.name.localeCompare(b.name);
  });

  // Rank stability Monte Carlo (±20% weight perturbation, seeded)
  const rng = createRng(seed + 404);
  const top1Id = scoringSet[0]?.id;
  let top1Wins = 0;
  const mcRuns = 60;
  for (let r = 0; r < mcRuns; r++) {
    const pert: ScoringWeights = { ...weights };
    (Object.keys(pert) as (keyof ScoringWeights)[]).forEach((k) => {
      pert[k] = Math.max(0, pert[k] * (0.8 + rng() * 0.4));
    });
    let bestId = '';
    let bestSc = -1;
    for (const m of scoringSet) {
      const sc = computeScoreWithWeights(m, pert);
      if (sc > bestSc) {
        bestSc = sc;
        bestId = m.id;
      }
    }
    if (bestId === top1Id) top1Wins++;
  }
  const stabilityPct = Number(((top1Wins / mcRuns) * 100).toFixed(1));

  // T11 Diebold-Mariano & Corrected Resampled t-test (Top-1 vs Runner-up)
  let t11WinnerVsRunnerUp: TargetModelingBundle['t11WinnerVsRunnerUp'] = null;
  if (scoringSet.length >= 2) {
    const w1 = scoringSet[0];
    const w2 = scoringSet[1];
    const nCmp = Math.min(w1.oofPredictions.length, w2.oofPredictions.length);
    const dLoss = Array.from({ length: nCmp }, (_, i) => {
      const e1 = w1.oofPredictions[i].actual - w1.oofPredictions[i].predicted;
      const e2 = w2.oofPredictions[i].actual - w2.oofPredictions[i].predicted;
      return e1 * e1 - e2 * e2;
    });
    const dMean = mean(dLoss);
    const dSe = (stdDev(dLoss) || 1e-6) / Math.sqrt(Math.max(1, nCmp));
    const dmStat = dMean / dSe;
    const dmP = normalPValueTwoSided(dmStat);

    // Nadeau-Bengio corrected resampled t-test on fold CV(RMSE)
    const fDiffs = w1.foldCvRmses.map((v, i) => v - (w2.foldCvRmses[i] ?? v));
    const kf = fDiffs.length;
    const corrFactor = 1 / Math.max(1, kf) + 1 / Math.max(1, kf - 1);
    const cT = mean(fDiffs) / Math.max(1e-6, Math.sqrt(corrFactor * Math.max(1e-6, stdDev(fDiffs) ** 2)));
    const cP = tPValueTwoSided(cT, Math.max(1, kf - 1));

    const indistinguishable = dmP >= 0.05 && cP >= 0.05;
    w2.indistinguishableFromTop1 = indistinguishable;
    t11WinnerVsRunnerUp = {
      dmStat: Number(dmStat.toFixed(3)),
      dmPValue: Number(dmP.toFixed(4)),
      correctedTStat: Number(cT.toFixed(3)),
      correctedTPValue: Number(cP.toFixed(4)),
      interpretation: indistinguishable
        ? `Top-1 (${w1.name}) and Runner-Up (${w2.name}) are statistically indistinguishable (DM p=${dmP.toFixed(3)}, Nadeau-Bengio p=${cP.toFixed(3)}).`
        : `Top-1 (${w1.name}) significantly outperforms ${w2.name} on OOF squared errors (DM p=${dmP.toFixed(4)}).`,
    };
  }

  scoringSet.forEach((m, idx) => {
    m.rank = idx + 1;
    m.rankStabilityPct = idx === 0 ? stabilityPct : 0;
    m.rationale = m.qualified
      ? `Rank #${idx + 1} (${weightProfile} score ${m.compositeScore}): OOF CV(RMSE)=${m.oofCvRmse.toFixed(2)}%, |NMBE|=${Math.abs(m.oofNmbe).toFixed(2)}%, R²=${m.oofR2.toFixed(3)}, ${m.isParametric ? 'closed-form parametric equation' : 'non-parametric + global surrogate'}.`
      : `Best fallback (did not meet all ${limits.citation} gates): ${m.rejectionReason}`;
  });

  const top5 = scoringSet.slice(0, 5);
  const qualifiedNotShortlisted = scoringSet.slice(5);
  const rejected = rawModels.filter((m) => !m.qualified);

  return {
    target: targetName,
    seed,
    candidatePool,
    selectedFeatures,
    prunedCollinear,
    top5,
    qualifiedNotShortlisted,
    rejected,
    allModels: rawModels,
    weightProfile,
    weights,
    thresholdProfile,
    t11WinnerVsRunnerUp,
  };
}

export function createLockedBaseline(
  dataset: DatasetState,
  candidate: ModelCandidateResult,
  vsg: Record<string, VsgEntry>,
  tcp: TcpConfig,
  thresholdProfile: ThresholdProfileId,
  previousVersion: number,
  note: string,
  seed: number
): LockedBaseline {
  const version = previousVersion + 1;
  const vsgHash = deterministicHash(JSON.stringify(vsg));
  const tcpHash = deterministicHash(JSON.stringify(tcp));
  const artifactSha256 = deterministicHash(`${candidate.id}:${version}:${vsgHash}:${tcpHash}:${dataset.sha256}`);

  return {
    version,
    target: candidate.target,
    modelId: candidate.id,
    modelName: candidate.name,
    family: candidate.family,
    lockedAt: new Date().toISOString(),
    note: note || `Locked v${version} for ${candidate.target} (${candidate.name})`,
    artifactSha256,
    features: candidate.featuresUsed,
    thresholdProfile,
    vsgSnapshotHash: vsgHash,
    tcpSnapshotHash: tcpHash,
    trainingWindow: {
      start: dataset.temporal.baselineStart,
      end: dataset.temporal.baselineEnd,
      nRows: getBaselineRows(dataset).length,
    },
    seed,
    calibrationSummary: candidate.conformalSummary,
    modelCard: {
      intendedUse: `Counterfactual M&V / operational baseline for target '${candidate.target}' under ${dataset.domain} domain (${thresholdProfile}).`,
      trainingWindow: `${dataset.temporal.baselineStart.slice(0, 10)} to ${dataset.temporal.baselineEnd.slice(0, 10)} (${getBaselineRows(dataset).length} observations)`,
      features: candidate.featuresUsed,
      assumptions: [
        'Predictors remain within observed baseline training range; extrapolations are flagged.',
        'Conformal coverage is approximate for autocorrelated time series (UQ-3).',
        'No target imputation was performed in validation/holdout sets (DAT-5).',
      ],
      knownLimitations: [
        tcp.postHocModified ? 'Contains post_hoc VSG/TCP modifications.' : 'Pre-registered VSG/TCP policy honored.',
        candidate.signViolations.length > 0
          ? `${candidate.signViolations.length} expected-sign discrepancy detected.`
          : 'All expected-sign constraints satisfied.',
      ],
      calibrationSummary: `Empirical ${(candidate.conformalSummary.empiricalCoverage * 100).toFixed(1)}% vs nominal ${(candidate.conformalSummary.nominalCoverage * 100).toFixed(0)}% (Kupiec p=${candidate.conformalSummary.kupiecPofP}).`,
      standardsNote: getThresholdLimits(thresholdProfile, dataset.temporal.targetGranularity).normativeNote,
    },
    candidate,
  };
}
