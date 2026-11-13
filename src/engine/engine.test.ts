import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRowsToTargetGranularity,
  generateSyntheticDataset,
  validateGranularityTransition,
} from './synthetic';
import { executeGuardedLocalSql, validateReadOnlySql } from './sqlGuard';
import {
  buildDefaultVsgForTarget,
  computeEdaAndMining,
  createDefaultTcpConfig,
  reevaluateTestResults,
  runDiagnosticsSuite,
  validateVsgConflict,
} from './stats';
import { createLockedBaseline, runTargetModelingPipeline } from './modeling';
import { predictFromLockedBaseline } from './monitoring';
import { buildDeterministicReportModel, verifyReportNarrativeConsistency } from './report';

test('Synthetic ground-truth generator is deterministic for a fixed seed', () => {
  const ds1 = generateSyntheticDataset('energy_mv', 42);
  const ds2 = generateSyntheticDataset('energy_mv', 42);
  assert.equal(ds1.sha256, ds2.sha256);
  assert.equal(ds1.rows.length, 365);
  assert.deepEqual(ds1.rows[0], ds2.rows[0]);
});

test('DAT-3 refuses coarser-to-finer disaggregation with DATA_REFUSED', () => {
  const check = validateGranularityTransition('daily', 'hourly');
  assert.equal(check.ok, false);
  assert.match(check.message, /DATA_REFUSED/);

  const ds = generateSyntheticDataset('energy_mv', 42);
  const aggRes = aggregateRowsToTargetGranularity(ds.rows, ds.columns, 'daily', 'monthly');
  assert.equal(aggRes.refusalError, null);
  assert.equal(aggRes.rows.length, 12);
});

test('PM-3 SQL guard rejects DDL/DML/stacked queries and accepts valid SELECT', () => {
  const benign = [
    'SELECT timestamp, outdoor_temp_c FROM baseline_monitoring_view LIMIT 50',
    'WITH cte AS (SELECT * FROM baseline_monitoring_view) SELECT * FROM cte',
    'SELECT timestamp FROM a UNION SELECT timestamp FROM b',
  ];
  for (const q of benign) {
    assert.equal(validateReadOnlySql(q).allowed, true, `Should allow: ${q}`);
  }

  const malicious = [
    'DROP TABLE users',
    'SELECT * FROM t; DELETE FROM t',
    'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x',
    'SELECT * INTO backup_tbl FROM t',
    "SELECT xp_cmdshell('dir')",
    'SELECT LOAD_FILE("/etc/passwd")',
    'PRAGMA table_info(users)',
    'ATTACH DATABASE "x.db" AS x',
    'SELECT * FROM t INTO OUTFILE "/tmp/x"',
  ];
  for (const q of malicious) {
    assert.equal(validateReadOnlySql(q).allowed, false, `Should reject: ${q}`);
  }

  const ds = generateSyntheticDataset('energy_mv', 42);
  const execOk = executeGuardedLocalSql('SELECT * FROM baseline_monitoring_view LIMIT 10', ds.rows);
  assert.equal(execOk.ok, true);
  assert.equal(execOk.rows.length, 10);
});

test('VSG enforces MT-2 leakage exclusion and TCP what-if flips decisions without recompute', () => {
  const ds = generateSyntheticDataset('energy_mv', 42);
  const vsgRes = buildDefaultVsgForTarget(ds, 'kwh_total', '2026-01-01T00:00:00Z');
  // main_meter_proxy_kwh shares energy unit family & |r|>=0.99 -> AUTO excluded
  assert.equal(vsgRes.entries.main_meter_proxy_kwh.state, 'exclude');
  assert.equal(vsgRes.entries.site_code_const.state, 'exclude');

  const kwhCol = ds.columns.find((c) => c.name === 'kwh_total')!;
  const kwhProf = vsgRes.profiles.find((p) => p.name === 'kwh_total')!;
  const conflict = validateVsgConflict(kwhCol, kwhProf, 'kwh_total', 'force_include');
  assert.ok(conflict && conflict.includes('Integrity violation'));

  const tcp = createDefaultTcpConfig(ds);
  const tests = runDiagnosticsSuite(ds, 'kwh_total', vsgRes.entries, tcp, 42);
  assert.ok(tests.length >= 6);

  // What-if re-evaluation: change alpha from 0.05 to 0.001 without recomputing test statistics
  const stricterTcp = { ...tcp, alpha: 0.001, correctionMethod: 'bonferroni' as const };
  const reeval = reevaluateTestResults(tests, stricterTcp);
  assert.equal(reeval.length, tests.length);
  for (let i = 0; i < tests.length; i++) {
    assert.equal(reeval[i].statistic, tests[i].statistic);
    assert.equal(reeval[i].pRaw, tests[i].pRaw);
  }
});

test('Multi-target modeling, Top-5, Lock, Monitoring deviation, Drift & Report consistency pass', () => {
  const ds = generateSyntheticDataset('energy_mv', 42);
  const tcp = createDefaultTcpConfig(ds);
  const vsg1 = buildDefaultVsgForTarget(ds, 'kwh_total', '2026-01-01T00:00:00Z');
  const vsg2 = buildDefaultVsgForTarget(ds, 'chilled_water_tons', '2026-01-01T00:00:00Z');

  const bundle1 = runTargetModelingPipeline(ds, 'kwh_total', vsg1.entries, tcp, 42, 'ashrae14');
  const bundle2 = runTargetModelingPipeline(ds, 'chilled_water_tons', vsg2.entries, tcp, 42, 'ashrae14');

  assert.notEqual(bundle1.seed, bundle2.seed);
  assert.ok(bundle1.top5.length >= 3);
  assert.ok(bundle1.top5[0].oofCvRmse < 12, `Expected accurate Top-1 fit, got ${bundle1.top5[0].oofCvRmse}%`);
  assert.ok(bundle1.rejected.some((r) => r.isNeuralNet), 'NN Gate should explicitly evaluate/reject NN if not >5% better');

  const locked = createLockedBaseline(
    ds,
    bundle1.top5[0],
    vsg1.entries,
    tcp,
    'ashrae14',
    0,
    'Unit test lock',
    bundle1.seed
  );

  // Predict on reporting window (contains planted -215 kWh/day ECM savings!)
  const reportingRows = ds.rows.filter((r) => r.timestamp >= ds.temporal.reportingStart);
  const mon = predictFromLockedBaseline(locked, reportingRows, ds, 'auto');
  assert.equal(mon.points.length, reportingRows.length);
  // Deviation = Actual - Baseline should be predominantly negative during planted savings
  const avgDev = mon.points.reduce((a, p) => a + (p.deviation ?? 0), 0) / mon.points.length;
  assert.ok(avgDev < -100, `Expected negative deviation from planted -215 savings, got ${avgDev}`);
  assert.ok(['amber', 'red'].includes(mon.drift.trafficLight));

  // Report consistency check (RPT-4 / G-9)
  const eda1 = computeEdaAndMining(ds, 'kwh_total', vsg1.entries, tcp, 42);
  const tests1 = runDiagnosticsSuite(ds, 'kwh_total', vsg1.entries, tcp, 42);
  const report = buildDeterministicReportModel({
    dataset: ds,
    vsgByTarget: { kwh_total: vsg1.entries, chilled_water_tons: vsg2.entries },
    tcp,
    testsByTarget: { kwh_total: tests1 },
    edaByTarget: { kwh_total: eda1 },
    modelingByTarget: { kwh_total: bundle1, chilled_water_tons: bundle2 },
    lockedBaselines: { kwh_total: locked },
    snapshots: [],
    autoLogs: vsg1.autoLogs,
    auditLog: [],
    seed: 42,
  });
  const consistency = verifyReportNarrativeConsistency(report);
  assert.equal(consistency.ok, true, consistency.mismatches.join('; '));
});
