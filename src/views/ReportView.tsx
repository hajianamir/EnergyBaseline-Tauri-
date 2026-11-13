import React, { useMemo, useState } from 'react';
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
} from '../engine/types';
import {
  buildDeterministicReportModel,
  computeRunDiff,
  verifyReportNarrativeConsistency,
} from '../engine/report';
import { CheckCircle2, Download, GitCompare } from 'lucide-react';

interface ReportViewProps {
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
  runHistory: RunArchiveEntry[];
  seed: number;
}

export const ReportView: React.FC<ReportViewProps> = ({
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
  runHistory,
  seed,
}) => {
  const [depth, setDepth] = useState<'Executive' | 'Standard' | 'Full Technical'>('Standard');
  const [companyName, setCompanyName] = useState('EnergyBaseline Metrology Lab');
  const [showDiff, setShowDiff] = useState(false);

  const report = useMemo(
    () =>
      buildDeterministicReportModel({
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
      }),
    [dataset, vsgByTarget, tcp, testsByTarget, edaByTarget, modelingByTarget, lockedBaselines, snapshots, autoLogs, auditLog, seed]
  );

  const consistency = useMemo(() => verifyReportNarrativeConsistency(report), [report]);

  const visibleSections = useMemo(() => {
    const order = { Executive: 0, Standard: 1, 'Full Technical': 2 };
    return report.sections.filter((s) => order[s.depthMin] <= order[depth]);
  }, [report.sections, depth]);

  const runDiffRows = useMemo(() => {
    if (runHistory.length < 2) return [];
    return computeRunDiff(runHistory[1], runHistory[0]);
  }, [runHistory]);

  const exportJsonReport = () => {
    const blob = new Blob([JSON.stringify({ companyName, depth, ...report }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `energybaseline_report_${depth.toLowerCase().replace(/\s+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportHtmlReport = () => {
    const htmlBody = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${companyName} — EnergyBaseline Report</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;color:#0f172a}h1,h2{color:#0369a1}table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:12px}th,td{border:1px solid #cbd5e1;padding:6px;text-align:left}</style></head><body><h1>${companyName} — M&V Baseline Report (${depth})</h1><p>Dataset: ${report.datasetName} (SHA-256: ${report.datasetSha256}) · Seed: ${report.seed}</p>${visibleSections
      .map(
        (s) =>
          `<section><h2>${s.title}</h2><p><strong>Purpose:</strong> ${s.purpose}</p><p><strong>Method:</strong> ${s.method}</p><p><strong>Settings:</strong> ${s.settingsUsed}</p><p><strong>Results:</strong> ${s.resultsSummary}</p><p><strong>Interpretation:</strong> ${s.interpretation}</p><p><strong>Decision Impact:</strong> ${s.decisionImpact}</p><p><strong>Caveats:</strong> ${s.caveats}</p></section>`
      )
      .join('')}</body></html>`;
    const blob = new Blob([htmlBody], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `energybaseline_report_${depth.toLowerCase().replace(/\s+/g, '_')}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 font-display tracking-tight">
            Deterministic Technical Report & Audit
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Single-source JSON report model (REP-1) · Zero LLM narrative · Every cited metric verified against artifacts (G-9 / RPT-4).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDiff(!showDiff)}
            disabled={runHistory.length < 2}
            className="px-3 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <GitCompare className="w-3.5 h-3.5" aria-hidden="true" />
            Report Diff ({runHistory.length} runs)
          </button>
          <button
            type="button"
            onClick={exportJsonReport}
            className="px-3 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export JSON Model
          </button>
          <button
            type="button"
            onClick={exportHtmlReport}
            className="px-4 py-2 text-xs font-semibold bg-sky-700 hover:bg-sky-800 text-white rounded-lg inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            Export HTML Report
          </button>
        </div>
      </div>

      {/* Controls & Narrative Verification Banner */}
      <div className="flex flex-wrap items-center justify-between gap-4 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2">
            <span className="text-slate-500">Depth (RPT-2):</span>
            <select
              aria-label="Report Depth"
              value={depth}
              onChange={(e) => setDepth(e.target.value as typeof depth)}
              className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="Executive">Executive (Summary)</option>
              <option value="Standard">Standard</option>
              <option value="Full Technical">Full Technical</option>
            </select>
          </label>
          <label className="inline-flex items-center gap-2">
            <span className="text-slate-500">Organization:</span>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 w-52"
            />
          </label>
        </div>

        <div className="inline-flex items-center gap-1.5 font-mono text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>
            RPT-4 Artifact Consistency: {consistency.ok ? 'PASS (0 mismatches)' : `${consistency.mismatches.length} mismatch`}
          </span>
        </div>
      </div>

      {/* Report Diff Viewer (UX-12) */}
      {showDiff && runHistory.length >= 2 && (
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 space-y-3 text-xs">
          <h2 className="text-sm font-semibold font-display">
            Run Comparison Diff ({runHistory[1].runId} → {runHistory[0].runId})
          </h2>
          <table className="w-full text-left tabular-nums">
            <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
              <tr>
                <th className="py-1.5">Target</th>
                <th className="py-1.5">Metric / Setting</th>
                <th className="py-1.5">Previous Run</th>
                <th className="py-1.5">Latest Run</th>
                <th className="py-1.5">Delta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
              {runDiffRows.map((d, i) => (
                <tr key={i}>
                  <td className="py-1.5 font-mono">{d.target}</td>
                  <td className="py-1.5">{d.field}</td>
                  <td className="py-1.5 font-mono">{d.valueA}</td>
                  <td className="py-1.5 font-mono">{d.valueB}</td>
                  <td className="py-1.5 font-mono font-semibold text-sky-700 dark:text-sky-400">{d.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Hyperlinked TOC */}
      <nav aria-label="Report Table of Contents" className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-4 text-xs">
        <div className="font-semibold text-slate-800 dark:text-slate-200 mb-2">Table of Contents ({visibleSections.length} sections)</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {visibleSections.map((s) => (
            <a key={s.id} href={`#rpt-${s.id}`} className="text-sky-700 dark:text-sky-400 hover:underline">
              {s.title}
            </a>
          ))}
        </div>
      </nav>

      {/* Report Sections (8-part standard template RPT-1) */}
      <div className="space-y-4">
        {visibleSections.map((sec) => (
          <section
            key={sec.id}
            id={`rpt-${sec.id}`}
            className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-5 space-y-2.5 text-xs"
          >
            <h2 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
              {sec.title}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-slate-700 dark:text-slate-300">
              <div><strong>Purpose:</strong> {sec.purpose}</div>
              <div><strong>Method:</strong> {sec.method}</div>
              <div><strong>Settings Used:</strong> <span className="font-mono">{sec.settingsUsed}</span></div>
              <div><strong>Decision Impact:</strong> {sec.decisionImpact}</div>
            </div>
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
              <strong>Results:</strong> <span className="font-mono">{sec.resultsSummary}</span>
            </div>
            <div>
              <strong>Deterministic Interpretation:</strong> {sec.interpretation}
            </div>
            <div className="text-slate-500 dark:text-slate-400">
              <strong>Caveats & Assumptions:</strong> {sec.caveats}
            </div>
            {sec.tableRows && sec.tableRows.length > 0 && (
              <div className="overflow-x-auto pt-2">
                <table className="w-full text-left border-t border-slate-200 dark:border-slate-800 tabular-nums">
                  <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300">
                    <tr>
                      {Object.keys(sec.tableRows[0]).map((col) => (
                        <th key={col} className="px-2.5 py-1.5 font-semibold">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                    {sec.tableRows.slice(0, 15).map((r, rIdx) => (
                      <tr key={rIdx}>
                        {Object.values(r).map((val, cIdx) => (
                          <td key={cIdx} className="px-2.5 py-1.5 font-mono">{String(val)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}

        {/* Glossary & How to Read (RPT-6) */}
        <section className="border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900 p-5 space-y-3 text-xs">
          <h2 className="text-base font-bold font-display text-slate-900 dark:text-slate-100">
            How to Read This Report & Statistical Glossary
          </h2>
          <ul className="list-disc pl-5 space-y-1 text-slate-700 dark:text-slate-300">
            {report.howToRead.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
            {report.glossary.map((g) => (
              <div key={g.term}>
                <strong className="font-mono text-slate-900 dark:text-slate-100">{g.term}:</strong>{' '}
                <span className="text-slate-600 dark:text-slate-400">{g.definition}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
