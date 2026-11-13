import {
  AggregationMethod,
  ColumnConfig,
  ColumnRole,
  DatasetRow,
  DatasetState,
  DomainType,
  QuantityType,
  SamplingGranularity,
} from './types';

export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomNormal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function deterministicHash(input: string): string {
  // Synchronous SHA-256 keeps engine identities identical in browsers and Node tests.
  const bytes = new TextEncoder().encode(input);
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  for (let i = 0; i < 8; i++) {
    padded[paddedLength - 1 - i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
  }

  const roundConstants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  const rotateRight = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      words[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (words[i - 16] + sigma0 + words[i - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + roundConstants[i] + words[i]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    const chunk = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < state.length; i++) state[i] = (state[i] + chunk[i]) >>> 0;
  }

  return state.map((value) => value.toString(16).padStart(8, '0')).join('');
}

export function deriveTargetSeed(globalSeed: number, targetId: string): number {
  let h = globalSeed >>> 0;
  for (let i = 0; i < targetId.length; i++) {
    h = Math.imul(h ^ targetId.charCodeAt(i), 16777619) >>> 0;
  }
  return h || 1;
}

const GRANULARITY_MINUTES: Record<SamplingGranularity, number> = {
  '15min': 15,
  hourly: 60,
  daily: 1440,
  monthly: 43200,
};

export function validateGranularityTransition(
  source: SamplingGranularity,
  target: SamplingGranularity
): { ok: boolean; action: 'identity' | 'aggregate' | 'refuse'; message: string } {
  const srcMin = GRANULARITY_MINUTES[source];
  const tgtMin = GRANULARITY_MINUTES[target];
  if (srcMin === tgtMin) {
    return { ok: true, action: 'identity', message: `Native ${source} granularity retained.` };
  }
  if (srcMin < tgtMin) {
    return {
      ok: true,
      action: 'aggregate',
      message: `Finer ${source} data aggregated to ${target} using per-column quantity-type rules (DAT-2/DAT-3).`,
    };
  }
  return {
    ok: false,
    action: 'refuse',
    message: `DATA_REFUSED: Cannot disaggregate coarser ${source} observations to finer ${target} resolution (DAT-3 / DAT-5).`,
  };
}

export function defaultAggregationForQuantity(q: QuantityType): AggregationMethod {
  switch (q) {
    case 'flow':
      return 'sum';
    case 'stock':
      return 'last';
    case 'rate':
      return 'time_weighted_mean';
    case 'quality':
      return 'mean';
    case 'index':
      return 'mean';
  }
}

export function aggregateValue(values: number[], method: AggregationMethod): number | null {
  if (values.length === 0) return null;
  if (method === 'sum') return values.reduce((a, b) => a + b, 0);
  if (method === 'last') return values[values.length - 1];
  if (method === 'median') {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateRowsToTargetGranularity(
  rows: DatasetRow[],
  columns: ColumnConfig[],
  source: SamplingGranularity,
  target: SamplingGranularity,
  completenessThreshold = 0.75
): { rows: DatasetRow[]; refusalError: string | null } {
  const check = validateGranularityTransition(source, target);
  if (!check.ok) {
    return { rows, refusalError: check.message };
  }
  if (check.action === 'identity') {
    return { rows, refusalError: null };
  }

  const bucketMap = new Map<string, DatasetRow[]>();
  for (const r of rows) {
    const d = new Date(r.timestamp);
    if (Number.isNaN(d.getTime())) continue;
    let key: string;
    if (target === 'hourly') {
      key = `${d.toISOString().slice(0, 13)}:00:00.000Z`;
    } else if (target === 'daily') {
      key = `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
    } else {
      key = `${d.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    }
    const arr = bucketMap.get(key);
    if (arr) arr.push(r);
    else bucketMap.set(key, [r]);
  }

  const expectedCount = Math.max(1, Math.round(GRANULARITY_MINUTES[target] / GRANULARITY_MINUTES[source]));
  const aggregated: DatasetRow[] = [];
  const sortedKeys = Array.from(bucketMap.keys()).sort();

  for (const key of sortedKeys) {
    const bucketRows = bucketMap.get(key) ?? [];
    const out: DatasetRow = { timestamp: key };
    const bucketCoverage = Math.min(1, bucketRows.length / expectedCount);

    for (const col of columns) {
      if (col.role === 'time') continue;
      if (col.dtype === 'categorical') {
        const firstValid = bucketRows.find((br) => br[col.name] !== null && br[col.name] !== '');
        out[col.name] = firstValid ? firstValid[col.name] : null;
        continue;
      }
      const nums = bucketRows
        .map((br) => br[col.name])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (nums.length === 0 || bucketCoverage < completenessThreshold * 0.5) {
        out[col.name] = null; // DAT-4: below completeness threshold -> NaN/null, never rescaled
      } else {
        out[col.name] = Number((aggregateValue(nums, col.aggregation) ?? 0).toFixed(4));
      }
    }
    aggregated.push(out);
  }

  return { rows: aggregated, refusalError: null };
}

export type SyntheticPresetId =
  | 'energy_mv'
  | 'manufacturing_spc'
  | 'healthcare_kpi'
  | 'water_utility'
  | 'finance_demand'
  | 'environmental_aqi';

export function generateSyntheticDataset(
  preset: SyntheticPresetId = 'energy_mv',
  seed = 42
): DatasetState {
  const rng = createRng(seed);

  if (preset === 'water_utility') {
    const rows: DatasetRow[] = [];
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const ts = new Date(startMs + i * 86400_000).toISOString();
      const dow = new Date(startMs + i * 86400_000).getUTCDay();
      const isWeekend = dow === 0 || dow === 6 ? 1 : 0;
      const airTemp = Number((17 + 10 * Math.sin((2 * Math.PI * (i - 90)) / 365) + randomNormal(rng) * 2.2).toFixed(2));
      const reservoirLevelM = Number((14.2 + 1.1 * Math.cos((2 * Math.PI * i) / 365) + randomNormal(rng) * 0.25).toFixed(2));
      const activeConnections = Math.round(12400 + i * 3.5 + randomNormal(rng) * 40);
      const postLeakRepair = i >= 260 ? 1 : 0;
      const waterFlowM3 = Number(
        (
          4200 +
          0.38 * activeConnections +
          65 * Math.max(0, airTemp - 16) -
          (isWeekend ? 290 : 0) -
          (postLeakRepair ? 460 : 0) +
          randomNormal(rng) * 105
        ).toFixed(2)
      );
      rows.push({
        timestamp: ts,
        water_flow_m3: waterFlowM3,
        air_temp_c: rng() < 0.01 ? null : airTemp,
        reservoir_level_m: reservoirLevelM,
        active_connections: activeConnections,
        is_weekend: isWeekend,
        dma_phase: postLeakRepair ? 'post_leak_repair' : 'baseline_network',
      });
    }
    const columns: ColumnConfig[] = [
      { name: 'timestamp', role: 'time', suggestedRole: 'time', quantityType: 'index', aggregation: 'last', unit: 'UTC', unitFamily: 'time', availability: 'known_in_advance', dtype: 'datetime', roleMode: 'AUTO' },
      { name: 'water_flow_m3', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'm³', unitFamily: 'water_volume', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'air_temp_c', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: '°C', unitFamily: 'temperature', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'reservoir_level_m', role: 'predictor', suggestedRole: 'predictor', quantityType: 'stock', aggregation: 'last', unit: 'm', unitFamily: 'level', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'active_connections', role: 'static_factor', suggestedRole: 'static_factor', quantityType: 'stock', aggregation: 'last', unit: 'conn', unitFamily: 'customers', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'is_weekend', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'flag', unitFamily: 'schedule', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'dma_phase', role: 'group', suggestedRole: 'group', quantityType: 'index', aggregation: 'last', unit: 'label', unitFamily: 'cohort', availability: 'known_in_advance', dtype: 'categorical', roleMode: 'AUTO' },
    ];
    return {
      id: 'synth-water-utility',
      name: 'Municipal Water DMA Flow & Leak Recovery (AWWA M36)',
      domain: 'water',
      rows,
      rawRowCount: rows.length,
      sha256: deterministicHash(JSON.stringify(rows)),
      columns,
      temporal: {
        sourceGranularity: 'daily',
        targetGranularity: 'daily',
        timezone: 'UTC',
        baselineStart: rows[0].timestamp,
        baselineEnd: rows[259].timestamp,
        reportingStart: rows[260].timestamp,
        reportingEnd: rows[rows.length - 1].timestamp,
        dstPolicy: 'utc_store_flag_dst',
        completenessThreshold: 0.8,
      },
      nonRoutineEvents: [
        {
          id: 'nre-water-1',
          start: rows[260].timestamp,
          end: rows[rows.length - 1].timestamp,
          reason: 'District Metered Area Main Leak Repair (-460 m³/day planted reduction)',
          treatment: 'flag_only',
        },
      ],
      sourceNote: 'Synthetic AWWA M36 hydraulic baseline dataset (planted -460 m³/day non-revenue water recovery).',
    };
  }

  if (preset === 'finance_demand') {
    const rows: DatasetRow[] = [];
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const ts = new Date(startMs + i * 86400_000).toISOString();
      const dow = new Date(startMs + i * 86400_000).getUTCDay();
      const isWeekend = dow === 0 || dow === 6 ? 1 : 0;
      const activeUsersK = Number((85 + 14 * Math.sin((2 * Math.PI * i) / 90) + i * 0.04 + randomNormal(rng) * 2.5).toFixed(2));
      const promoSpendUsd = Number((1200 + 600 * Math.max(0, Math.sin((2 * Math.PI * i) / 30)) + randomNormal(rng) * 90).toFixed(1));
      const macroIndex = Number((102 + 3.2 * Math.cos((2 * Math.PI * i) / 180) + randomNormal(rng) * 0.6).toFixed(2));
      const postPricingShift = i >= 270 ? 1 : 0;
      const dailyTxVol = Number(
        (
          2100 +
          38.5 * activeUsersK +
          0.62 * promoSpendUsd +
          11.2 * macroIndex -
          (isWeekend ? 420 : 0) +
          (postPricingShift ? 540 : 0) +
          randomNormal(rng) * 95
        ).toFixed(2)
      );
      rows.push({
        timestamp: ts,
        daily_tx_volume: dailyTxVol,
        active_users_k: activeUsersK,
        promo_spend_usd: rng() < 0.01 ? null : promoSpendUsd,
        macro_demand_idx: macroIndex,
        is_weekend: isWeekend,
        policy_regime: postPricingShift ? 'post_tier_change' : 'baseline_pricing',
      });
    }
    const columns: ColumnConfig[] = [
      { name: 'timestamp', role: 'time', suggestedRole: 'time', quantityType: 'index', aggregation: 'last', unit: 'UTC', unitFamily: 'time', availability: 'known_in_advance', dtype: 'datetime', roleMode: 'AUTO' },
      { name: 'daily_tx_volume', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'tx', unitFamily: 'volume', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'active_users_k', role: 'predictor', suggestedRole: 'predictor', quantityType: 'stock', aggregation: 'mean', unit: 'kUsers', unitFamily: 'users', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'promo_spend_usd', role: 'predictor', suggestedRole: 'predictor', quantityType: 'flow', aggregation: 'sum', unit: 'USD', unitFamily: 'spend', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'macro_demand_idx', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'idx', unitFamily: 'macro', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'is_weekend', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'flag', unitFamily: 'schedule', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'policy_regime', role: 'group', suggestedRole: 'group', quantityType: 'index', aggregation: 'last', unit: 'label', unitFamily: 'cohort', availability: 'known_in_advance', dtype: 'categorical', roleMode: 'AUTO' },
    ];
    return {
      id: 'synth-finance-demand',
      name: 'Transaction Volume & Demand Benchmark (SR 11-7)',
      domain: 'finance',
      rows,
      rawRowCount: rows.length,
      sha256: deterministicHash(JSON.stringify(rows)),
      columns,
      temporal: {
        sourceGranularity: 'daily',
        targetGranularity: 'daily',
        timezone: 'UTC',
        baselineStart: rows[0].timestamp,
        baselineEnd: rows[269].timestamp,
        reportingStart: rows[270].timestamp,
        reportingEnd: rows[rows.length - 1].timestamp,
        dstPolicy: 'utc_store_flag_dst',
        completenessThreshold: 0.85,
      },
      nonRoutineEvents: [
        {
          id: 'nre-fin-1',
          start: rows[270].timestamp,
          end: rows[rows.length - 1].timestamp,
          reason: 'Fee Tier Launch (+540 tx/day structural lift)',
          treatment: 'flag_only',
        },
      ],
      sourceNote: 'Synthetic SR 11-7 demand/transaction risk benchmark dataset (planted +540 tx/day regime shift).',
    };
  }

  if (preset === 'environmental_aqi') {
    const rows: DatasetRow[] = [];
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const ts = new Date(startMs + i * 86400_000).toISOString();
      const dow = new Date(startMs + i * 86400_000).getUTCDay();
      const isWeekend = dow === 0 || dow === 6 ? 1 : 0;
      const windSpeedMs = Number(Math.max(0.8, 3.8 + 1.5 * Math.sin(i / 18) + randomNormal(rng) * 0.75).toFixed(2));
      const trafficIdx = Number((isWeekend ? 62 : 105 + randomNormal(rng) * 6.5).toFixed(1));
      const inversionTempC = Number((14 + 9 * Math.cos((2 * Math.PI * i) / 365) + randomNormal(rng) * 2.0).toFixed(2));
      const postScrubber = i >= 265 ? 1 : 0;
      const co2eqTons = Number(
        Math.max(
          15,
          110 +
            0.85 * trafficIdx -
            8.2 * windSpeedMs +
            2.4 * Math.max(0, 14 - inversionTempC) -
            (postScrubber ? 28 : 0) +
            randomNormal(rng) * 4.2
        ).toFixed(2)
      );
      rows.push({
        timestamp: ts,
        co2eq_tons: co2eqTons,
        traffic_idx: trafficIdx,
        wind_speed_ms: rng() < 0.015 ? null : windSpeedMs,
        ambient_temp_c: inversionTempC,
        is_weekend: isWeekend,
        abatement_phase: postScrubber ? 'post_scrubber' : 'baseline_emissions',
      });
    }
    const columns: ColumnConfig[] = [
      { name: 'timestamp', role: 'time', suggestedRole: 'time', quantityType: 'index', aggregation: 'last', unit: 'UTC', unitFamily: 'time', availability: 'known_in_advance', dtype: 'datetime', roleMode: 'AUTO' },
      { name: 'co2eq_tons', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'tCO2e', unitFamily: 'emissions', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'traffic_idx', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'idx', unitFamily: 'activity', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'wind_speed_ms', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'mean', unit: 'm/s', unitFamily: 'wind', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'ambient_temp_c', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: '°C', unitFamily: 'temperature', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'is_weekend', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'flag', unitFamily: 'schedule', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'abatement_phase', role: 'group', suggestedRole: 'group', quantityType: 'index', aggregation: 'last', unit: 'label', unitFamily: 'cohort', availability: 'known_in_advance', dtype: 'categorical', roleMode: 'AUTO' },
    ];
    return {
      id: 'synth-env-iso14064',
      name: 'Industrial Facility GHG & Emissions Baseline (ISO 14064-2)',
      domain: 'environment',
      rows,
      rawRowCount: rows.length,
      sha256: deterministicHash(JSON.stringify(rows)),
      columns,
      temporal: {
        sourceGranularity: 'daily',
        targetGranularity: 'daily',
        timezone: 'UTC',
        baselineStart: rows[0].timestamp,
        baselineEnd: rows[264].timestamp,
        reportingStart: rows[265].timestamp,
        reportingEnd: rows[rows.length - 1].timestamp,
        dstPolicy: 'utc_store_flag_dst',
        completenessThreshold: 0.8,
      },
      nonRoutineEvents: [
        {
          id: 'nre-env-1',
          start: rows[265].timestamp,
          end: rows[rows.length - 1].timestamp,
          reason: 'Stack Scrubber & Heat Recovery Abatement (-28 tCO2e/day planted)',
          treatment: 'flag_only',
        },
      ],
      sourceNote: 'Synthetic ISO 14064-2 emissions baseline dataset (planted -28 tCO2e/day abatement).',
    };
  }

  if (preset === 'manufacturing_spc') {
    const rows: DatasetRow[] = [];
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const ts = new Date(startMs + i * 86400_000).toISOString();
      const dayOfWeek = new Date(startMs + i * 86400_000).getUTCDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6 ? 1 : 0;
      const unitsProduced = Math.max(
        100,
        Math.round((isWeekend ? 420 : 980) + 120 * Math.sin((2 * Math.PI * i) / 365) + randomNormal(rng) * 45)
      );
      const ambientTempC = Number((18 + 11 * Math.sin((2 * Math.PI * (i - 80)) / 365) + randomNormal(rng) * 2.1).toFixed(2));
      const compressedAirBar = Number((6.4 + 0.15 * Math.sin(i / 14) + randomNormal(rng) * 0.08).toFixed(3));
      const lineSpeedIdx = Number((unitsProduced / 1000 + randomNormal(rng) * 0.03).toFixed(3));
      const postRetrofit = i >= 245 ? 1 : 0;
      const baseEnergy = 1850 + 2.45 * unitsProduced + 28 * Math.max(0, ambientTempC - 20) + 140 * compressedAirBar;
      const plantKwh = Number((baseEnergy * (postRetrofit ? 0.91 : 1) + randomNormal(rng) * 85).toFixed(2));
      const scrapRatePct = Number(
        Math.max(0.2, 1.45 + 0.0008 * unitsProduced + 0.12 * Math.abs(compressedAirBar - 6.4) + randomNormal(rng) * 0.18).toFixed(3)
      );
      rows.push({
        timestamp: ts,
        plant_kwh: rng() < 0.015 ? null : plantKwh,
        scrap_rate_pct: scrapRatePct,
        units_produced: unitsProduced,
        ambient_temp_c: rng() < 0.02 ? null : ambientTempC,
        compressed_air_bar: compressedAirBar,
        line_speed_idx: lineSpeedIdx,
        shift_weekend: isWeekend,
        period_group: postRetrofit ? 'reporting' : 'baseline',
      });
    }
    const columns: ColumnConfig[] = [
      { name: 'timestamp', role: 'time', suggestedRole: 'time', quantityType: 'index', aggregation: 'last', unit: 'UTC', unitFamily: 'time', availability: 'known_in_advance', dtype: 'datetime', roleMode: 'AUTO' },
      { name: 'plant_kwh', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'kWh', unitFamily: 'energy', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'scrap_rate_pct', role: 'target', suggestedRole: 'target', quantityType: 'quality', aggregation: 'mean', unit: '%', unitFamily: 'quality', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'units_produced', role: 'predictor', suggestedRole: 'predictor', quantityType: 'flow', aggregation: 'sum', unit: 'units', unitFamily: 'production', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'ambient_temp_c', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: '°C', unitFamily: 'temperature', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'compressed_air_bar', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: 'bar', unitFamily: 'pressure', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'line_speed_idx', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'idx', unitFamily: 'production', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'shift_weekend', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'flag', unitFamily: 'schedule', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'period_group', role: 'group', suggestedRole: 'group', quantityType: 'index', aggregation: 'last', unit: 'label', unitFamily: 'cohort', availability: 'known_in_advance', dtype: 'categorical', roleMode: 'AUTO' },
    ];
    return {
      id: 'synth-mfg-spc',
      name: 'Manufacturing Plant Energy & Quality (Synthetic Ground-Truth)',
      domain: 'manufacturing',
      rows,
      rawRowCount: rows.length,
      sha256: deterministicHash(JSON.stringify(rows)),
      columns,
      temporal: {
        sourceGranularity: 'daily',
        targetGranularity: 'daily',
        timezone: 'UTC',
        baselineStart: rows[0].timestamp,
        baselineEnd: rows[244].timestamp,
        reportingStart: rows[245].timestamp,
        reportingEnd: rows[rows.length - 1].timestamp,
        dstPolicy: 'utc_store_flag_dst',
        completenessThreshold: 0.8,
      },
      nonRoutineEvents: [
        {
          id: 'nre-1',
          start: rows[245].timestamp,
          end: rows[rows.length - 1].timestamp,
          reason: 'Compressor VFD Retrofit (Planted 9% Energy Reduction)',
          treatment: 'flag_only',
        },
      ],
      sourceNote: 'Synthetic ground-truth generator (planted production slope 2.45 kWh/unit, CDD>20°C slope 28, 9% post-retrofit savings).',
    };
  }

  if (preset === 'healthcare_kpi') {
    const rows: DatasetRow[] = [];
    const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const ts = new Date(startMs + i * 86400_000).toISOString();
      const dow = new Date(startMs + i * 86400_000).getUTCDay();
      const isWeekend = dow === 0 || dow === 6 ? 1 : 0;
      const outsideTemp = Number((15 + 12 * Math.sin((2 * Math.PI * (i - 95)) / 365) + randomNormal(rng) * 3.0).toFixed(2));
      const occupiedBeds = Math.round(210 + 25 * Math.cos((2 * Math.PI * i) / 365) - (isWeekend ? 18 : 0) + randomNormal(rng) * 8);
      const surgicalCases = Math.max(0, Math.round((isWeekend ? 4 : 26) + randomNormal(rng) * 3.2));
      const postOpt = i >= 260 ? 1 : 0;
      const facilityKwh = Number(
        (
          4200 +
          11.5 * occupiedBeds +
          44 * surgicalCases +
          68 * Math.max(0, outsideTemp - 18) +
          35 * Math.max(0, 14 - outsideTemp) +
          (postOpt ? -310 : 0) +
          randomNormal(rng) * 110
        ).toFixed(2)
      );
      rows.push({
        timestamp: ts,
        facility_kwh: facilityKwh,
        outside_temp_c: rng() < 0.01 ? null : outsideTemp,
        occupied_beds: occupiedBeds,
        surgical_cases: surgicalCases,
        is_weekend: isWeekend,
        cohort_group: postOpt ? 'post_chiller_tune' : 'baseline_ops',
      });
    }
    const columns: ColumnConfig[] = [
      { name: 'timestamp', role: 'time', suggestedRole: 'time', quantityType: 'index', aggregation: 'last', unit: 'UTC', unitFamily: 'time', availability: 'known_in_advance', dtype: 'datetime', roleMode: 'AUTO' },
      { name: 'facility_kwh', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'kWh', unitFamily: 'energy', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'outside_temp_c', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: '°C', unitFamily: 'temperature', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'occupied_beds', role: 'static_factor', suggestedRole: 'predictor', quantityType: 'stock', aggregation: 'last', unit: 'beds', unitFamily: 'occupancy', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'surgical_cases', role: 'predictor', suggestedRole: 'predictor', quantityType: 'flow', aggregation: 'sum', unit: 'cases', unitFamily: 'activity', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'is_weekend', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'flag', unitFamily: 'schedule', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
      { name: 'cohort_group', role: 'group', suggestedRole: 'group', quantityType: 'index', aggregation: 'last', unit: 'label', unitFamily: 'cohort', availability: 'known_in_advance', dtype: 'categorical', roleMode: 'AUTO' },
    ];
    return {
      id: 'synth-health-kpi',
      name: 'Hospital Campus Energy & Bed Occupancy (Synthetic)',
      domain: 'healthcare',
      rows,
      rawRowCount: rows.length,
      sha256: deterministicHash(JSON.stringify(rows)),
      columns,
      temporal: {
        sourceGranularity: 'daily',
        targetGranularity: 'daily',
        timezone: 'UTC',
        baselineStart: rows[0].timestamp,
        baselineEnd: rows[259].timestamp,
        reportingStart: rows[260].timestamp,
        reportingEnd: rows[rows.length - 1].timestamp,
        dstPolicy: 'utc_store_flag_dst',
        completenessThreshold: 0.8,
      },
      nonRoutineEvents: [],
      sourceNote: 'Synthetic healthcare campus dataset (local-only processing).',
    };
  }

  // Default: energy_mv — 365 days of multi-target commercial campus M&V data with planted change-points, leakage trap, and causal group
  const rows: DatasetRow[] = [];
  const startMs = Date.UTC(2025, 0, 1, 0, 0, 0);
  for (let i = 0; i < 365; i++) {
    const ts = new Date(startMs + i * 86400_000).toISOString();
    const dow = new Date(startMs + i * 86400_000).getUTCDay();
    const isWeekend = dow === 0 || dow === 6 ? 1 : 0;

    // Seasonal outside air temperature (°C)
    const outdoorTemp = Number(
      (16 + 13 * Math.sin((2 * Math.PI * (i - 100)) / 365) + randomNormal(rng) * 2.4).toFixed(2)
    );
    const relativeHumidity = Number(
      Math.min(95, Math.max(22, 58 - 0.55 * (outdoorTemp - 16) + randomNormal(rng) * 7.5)).toFixed(1)
    );
    const solarIrradiance = Number(
      Math.max(40, 420 + 210 * Math.sin((2 * Math.PI * (i - 80)) / 365) + randomNormal(rng) * 45).toFixed(1)
    );
    const occupancyPct = Number(
      Math.min(100, Math.max(5, (isWeekend ? 18 : 82) + randomNormal(rng) * 5.2)).toFixed(1)
    );

    // Planted cooling & heating degree-day physics (change points at 18°C cooling, 12°C heating)
    const cdd = Math.max(0, outdoorTemp - 18);
    const hdd = Math.max(0, 12 - outdoorTemp);
    const postEcm = i >= 265 ? 1 : 0; // Planted HVAC retro-commissioning savings in last 100 days

    let kwhTotal =
      1420 +
      46.5 * cdd +
      31.0 * hdd +
      8.4 * occupancyPct +
      2.1 * relativeHumidity +
      0.32 * solarIrradiance -
      (postEcm ? 215 : 0) +
      randomNormal(rng) * 48;

    // Planted 3 outliers in baseline
    if (i === 72 || i === 148 || i === 210) {
      kwhTotal += 520;
    }

    const chilledWaterTons =
      180 +
      28.5 * cdd +
      1.9 * occupancyPct +
      0.18 * solarIrradiance +
      (postEcm ? -55 : 0) +
      randomNormal(rng) * 18;

    // Suspected leakage column (meter sub-total highly collinear with kwh_total, same energy family)
    const mainMeterKvaProxy = Number((kwhTotal * 1.045 + randomNormal(rng) * 4.2).toFixed(2));
    // Constant column to test VSG AUTO exclusion
    const siteIdConst = 104;

    rows.push({
      timestamp: ts,
      kwh_total: Number(kwhTotal.toFixed(2)),
      chilled_water_tons: Number(Math.max(20, chilledWaterTons).toFixed(2)),
      outdoor_temp_c: rng() < 0.018 ? null : outdoorTemp,
      relative_humidity_pct: rng() < 0.012 ? null : relativeHumidity,
      solar_ghi_wm2: solarIrradiance,
      occupancy_pct: occupancyPct,
      is_weekend: isWeekend,
      main_meter_proxy_kwh: mainMeterKvaProxy,
      site_code_const: siteIdConst,
      ecm_phase_group: postEcm ? 'post_ecm' : 'baseline',
    });
  }

  const columns: ColumnConfig[] = [
    { name: 'timestamp', role: 'time', suggestedRole: 'time', quantityType: 'index', aggregation: 'last', unit: 'UTC', unitFamily: 'time', availability: 'known_in_advance', dtype: 'datetime', roleMode: 'AUTO' },
    { name: 'kwh_total', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'kWh', unitFamily: 'energy', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'chilled_water_tons', role: 'target', suggestedRole: 'target', quantityType: 'flow', aggregation: 'sum', unit: 'ton-hrs', unitFamily: 'cooling_energy', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'outdoor_temp_c', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: '°C', unitFamily: 'temperature', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'relative_humidity_pct', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: '%', unitFamily: 'humidity', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'solar_ghi_wm2', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'time_weighted_mean', unit: 'W/m²', unitFamily: 'irradiance', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'occupancy_pct', role: 'predictor', suggestedRole: 'predictor', quantityType: 'rate', aggregation: 'mean', unit: '%', unitFamily: 'occupancy', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'is_weekend', role: 'predictor', suggestedRole: 'predictor', quantityType: 'index', aggregation: 'mean', unit: 'flag', unitFamily: 'schedule', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'main_meter_proxy_kwh', role: 'predictor', suggestedRole: 'predictor', quantityType: 'flow', aggregation: 'sum', unit: 'kWh', unitFamily: 'energy', availability: 'observed_only', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'site_code_const', role: 'predictor', suggestedRole: 'ignore', quantityType: 'index', aggregation: 'last', unit: 'id', unitFamily: 'identifier', availability: 'known_in_advance', dtype: 'numeric', roleMode: 'AUTO' },
    { name: 'ecm_phase_group', role: 'group', suggestedRole: 'group', quantityType: 'index', aggregation: 'last', unit: 'phase', unitFamily: 'cohort', availability: 'known_in_advance', dtype: 'categorical', roleMode: 'AUTO' },
  ];

  return {
    id: 'synth-energy-mv',
    name: 'Commercial Campus M&V Multi-Target (Synthetic Ground-Truth)',
    domain: 'energy',
    rows,
    rawRowCount: rows.length,
    sha256: deterministicHash(JSON.stringify(rows)),
    columns,
    temporal: {
      sourceGranularity: 'daily',
      targetGranularity: 'daily',
      timezone: 'UTC',
      baselineStart: rows[0].timestamp,
      baselineEnd: rows[264].timestamp,
      reportingStart: rows[265].timestamp,
      reportingEnd: rows[rows.length - 1].timestamp,
      dstPolicy: 'utc_store_flag_dst',
      completenessThreshold: 0.75,
    },
    nonRoutineEvents: [
      {
        id: 'nre-hvac-1',
        start: rows[265].timestamp,
        end: rows[rows.length - 1].timestamp,
        reason: 'HVAC Retro-Commissioning ECM Activated (-215 kWh/day planted savings)',
        treatment: 'flag_only',
      },
    ],
    sourceNote:
      'Synthetic ground-truth M&V dataset: planted 5P cooling (>18°C, β=+46.5) & heating (<12°C, β=+31.0), occupancy (+8.4), leakage trap (main_meter_proxy_kwh), constant column, 3 outliers, and planted -215 kWh/day ECM savings.',
  };
}

export function parseCsvToDataset(
  csvText: string,
  fileName: string,
  domain: DomainType = 'energy'
): DatasetState {
  const cleanText = csvText.replace(/^\uFEFF/, '').trim();
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) {
    throw new Error('CSV must contain a header row and at least 2 data rows.');
  }
  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ''));
  const rows: DatasetRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(delimiter).map((p) => p.trim().replace(/^"|"$/g, ''));
    if (parts.length !== headers.length) continue;
    const row: DatasetRow = { timestamp: '' };
    headers.forEach((h, idx) => {
      const raw = parts[idx];
      if (idx === 0 || /time|date|ts/i.test(h)) {
        const parsedDate = new Date(raw);
        row[h] = Number.isNaN(parsedDate.getTime()) ? raw : parsedDate.toISOString();
        if (idx === 0) row.timestamp = String(row[h]);
      } else if (raw === '' || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'nan') {
        row[h] = null;
      } else {
        const num = Number(raw.replace(',', '.'));
        row[h] = Number.isFinite(num) ? num : raw;
      }
    });
    if (!row.timestamp) {
      row.timestamp = String(row[headers[0]] ?? `row-${i}`);
    }
    rows.push(row);
  }

  const columns: ColumnConfig[] = headers.map((h, idx) => {
    const isTime = idx === 0 || /time|date|timestamp/i.test(h);
    const sampleVals = rows.slice(0, 20).map((r) => r[h]);
    const numericCount = sampleVals.filter((v) => typeof v === 'number').length;
    const dtype: ColumnConfig['dtype'] = isTime
      ? 'datetime'
      : numericCount >= sampleVals.length * 0.5
        ? 'numeric'
        : 'categorical';
    let suggestedRole: ColumnRole = 'predictor';
    if (isTime) suggestedRole = 'time';
    else if (/kwh|target|load|energy|yield|tons|output/i.test(h)) suggestedRole = 'target';
    else if (/group|cohort|phase|treatment/i.test(h)) suggestedRole = 'group';
    else if (dtype === 'categorical') suggestedRole = 'ignore';

    return {
      name: h,
      role: suggestedRole,
      suggestedRole,
      quantityType: /kwh|energy|flow|sum|units/i.test(h) ? 'flow' : 'rate',
      aggregation: /kwh|energy|flow|sum|units/i.test(h) ? 'sum' : 'mean',
      unit: isTime ? 'UTC' : '',
      unitFamily: isTime ? 'time' : 'general',
      availability: suggestedRole === 'target' ? 'observed_only' : 'known_in_advance',
      dtype,
      roleMode: 'AUTO',
    };
  });

  // Detect source granularity from first two valid timestamps
  let sourceGranularity: SamplingGranularity = 'daily';
  if (rows.length >= 2) {
    const t0 = new Date(rows[0].timestamp).getTime();
    const t1 = new Date(rows[1].timestamp).getTime();
    const diffMin = Math.abs(t1 - t0) / 60000;
    if (diffMin <= 20) sourceGranularity = '15min';
    else if (diffMin <= 90) sourceGranularity = 'hourly';
    else if (diffMin <= 2000) sourceGranularity = 'daily';
    else sourceGranularity = 'monthly';
  }

  const splitIdx = Math.max(1, Math.floor(rows.length * 0.72));

  return {
    id: `csv-${deterministicHash(fileName + rows.length).slice(0, 8)}`,
    name: fileName,
    domain,
    rows,
    rawRowCount: rows.length,
    sha256: deterministicHash(csvText),
    columns,
    temporal: {
      sourceGranularity,
      targetGranularity: sourceGranularity,
      timezone: 'UTC',
      baselineStart: rows[0].timestamp,
      baselineEnd: rows[splitIdx - 1].timestamp,
      reportingStart: rows[splitIdx].timestamp,
      reportingEnd: rows[rows.length - 1].timestamp,
      dstPolicy: 'utc_store_flag_dst',
      completenessThreshold: 0.75,
    },
    nonRoutineEvents: [],
    sourceNote: `Imported CSV (${rows.length} rows, ${columns.length} columns).`,
  };
}
