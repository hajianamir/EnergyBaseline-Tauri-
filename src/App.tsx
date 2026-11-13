import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AuditEvent,
  AutoDecisionEntry,
  DatasetState,
  EdaTargetSummary,
  InclusionState,
  LockedBaseline,
  ModelCandidateResult,
  MonitoringSnapshot,
  RunArchiveEntry,
  StatisticalTestResult,
  TargetModelingBundle,
  TcpConfig,
  TestFamilyId,
  ThresholdProfileId,
  VariablePreTestProfile,
  VsgEntry,
  WeightProfile,
} from './engine/types';
import {
  deterministicHash,
  generateSyntheticDataset,
} from './engine/synthetic';
import {
  buildDefaultVsgForTarget,
  computeEdaAndMining,
  createDefaultTcpConfig,
  runDiagnosticsSuite,
  validateVsgConflict,
} from './engine/stats';
import {
  createLockedBaseline,
  runTargetModelingPipeline,
} from './engine/modeling';
import { importEbprojZipFile } from './engine/report';
import { DataSetupView } from './views/DataSetupView';
import { VsgView } from './views/VsgView';
import { TcpView } from './views/TcpView';
import { DiagnosticsEdaView } from './views/DiagnosticsEdaView';
import { ModelingView } from './views/ModelingView';
import { MonitoringView } from './views/MonitoringView';
import { ReportView } from './views/ReportView';
import { SystemStatusView } from './views/SystemStatusView';
import { CommandPalette, PaletteAction } from './components/CommandPalette';
import { AutoInspectorDrawer } from './components/AutoInspectorDrawer';
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Command,
  Cpu,
  Database,
  FileText,
  Filter,
  HardDrive,
  Lock,
  Menu,
  Moon,
  PanelRightOpen,
  Sliders,
  Sun,
  X,
} from 'lucide-react';

type StageId =
  | 'data'
  | 'vsg'
  | 'tcp'
  | 'diagnostics'
  | 'modeling'
  | 'monitoring'
  | 'report'
  | 'status';

interface StageMeta {
  id: StageId;
  step: string;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}

const STAGES: StageMeta[] = [
  { id: 'data', step: '01', label: 'Data & Columns', shortLabel: 'Data', icon: Database },
  { id: 'vsg', step: '02', label: 'Variable Gate (VSG)', shortLabel: 'VSG', icon: Filter },
  { id: 'tcp', step: '03', label: 'Test Policy (TCP)', shortLabel: 'TCP', icon: Sliders },
  { id: 'diagnostics', step: '04', label: 'Diagnostics & EDA', shortLabel: 'Stats', icon: BarChart3 },
  { id: 'modeling', step: '05', label: 'Modeling & Top-5', shortLabel: 'Models', icon: Cpu },
  { id: 'monitoring', step: '06', label: 'Prediction & Drift', shortLabel: 'Drift', icon: Activity },
  { id: 'report', step: '07', label: 'Report & Audit', shortLabel: 'Report', icon: FileText },
  { id: 'status', step: '08', label: 'System & Storage', shortLabel: 'System', icon: HardDrive },
];

function initializeWorkspaceFromDataset(ds: DatasetState) {
  const targetNames = ds.columns.filter((c) => c.role === 'target').map((c) => c.name);
  const vsgByTarget: Record<string, Record<string, VsgEntry>> = {};
  const profilesByTarget: Record<string, VariablePreTestProfile[]> = {};
  const scopeMatrixByTarget: Record<string, Record<string, TestFamilyId[]>> = {};
  const autoLogs: AutoDecisionEntry[] = [];
  const nowIso = new Date().toISOString();

  for (const t of targetNames) {
    const built = buildDefaultVsgForTarget(ds, t, nowIso);
    vsgByTarget[t] = built.entries;
    profilesByTarget[t] = built.profiles;
    autoLogs.push(...built.autoLogs);
    scopeMatrixByTarget[t] = {};
    for (const [colName, entry] of Object.entries(built.entries)) {
      scopeMatrixByTarget[t][colName] = [...entry.scopeFamilies];
    }
  }

  const tcp = createDefaultTcpConfig(ds);
  autoLogs.push({
    id: `auto-tcp-init-${ds.id}`,
    settingKey: 'tcp.defaults',
    value: `alpha=${tcp.alpha}, corr=${tcp.correctionMethod}, rule=${tcp.decisionRule}`,
    signals: `n=${ds.rows.length}, domain=${ds.domain}`,
    rule: 'TCP-AUTO Domain Initialization',
    mode: 'AUTO',
    target: 'GLOBAL',
    timestamp: nowIso,
  });

  return {
    targetNames,
    vsgByTarget,
    profilesByTarget,
    scopeMatrixByTarget,
    tcp,
    autoLogs,
  };
}

export default function App() {
  const [seed] = useState<number>(42);
  const [initialBoot] = useState(() => {
    const ds = generateSyntheticDataset('energy_mv', 42);
    const init = initializeWorkspaceFromDataset(ds);
    return { ds, ...init };
  });

  const [dataset, setDataset] = useState<DatasetState>(initialBoot.ds);
  const [activeTarget, setActiveTarget] = useState<string>(initialBoot.targetNames[0] ?? '');
  const [vsgByTarget, setVsgByTarget] = useState<Record<string, Record<string, VsgEntry>>>(
    initialBoot.vsgByTarget
  );
  const [profilesByTarget, setProfilesByTarget] = useState<Record<string, VariablePreTestProfile[]>>(
    initialBoot.profilesByTarget
  );
  const [scopeMatrixByTarget, setScopeMatrixByTarget] = useState<
    Record<string, Record<string, TestFamilyId[]>>
  >(initialBoot.scopeMatrixByTarget);
  const [tcp, setTcp] = useState<TcpConfig>(initialBoot.tcp);

  const [vsgGateAccepted, setVsgGateAccepted] = useState<boolean>(false);
  const [tcpGateAccepted, setTcpGateAccepted] = useState<boolean>(false);

  const [testsByTarget, setTestsByTarget] = useState<Record<string, StatisticalTestResult[]>>({});
  const [edaByTarget, setEdaByTarget] = useState<Record<string, EdaTargetSummary>>({});
  const [modelingByTarget, setModelingByTarget] = useState<Record<string, TargetModelingBundle>>({});
  const [thresholdProfile, setThresholdProfile] = useState<ThresholdProfileId>(
    initialBoot.ds.domain === 'manufacturing' ? 'spc' : 'ashrae14'
  );
  const [weightProfile, setWeightProfile] = useState<WeightProfile>('balanced');

  const [lockedBaselines, setLockedBaselines] = useState<Record<string, LockedBaseline>>({});
  const [snapshots, setSnapshots] = useState<MonitoringSnapshot[]>([]);
  const [runHistory, setRunHistory] = useState<RunArchiveEntry[]>([]);
  const [autoLogs, setAutoLogs] = useState<AutoDecisionEntry[]>(initialBoot.autoLogs);
  const [auditLog, setAuditLog] = useState<AuditEvent[]>(() => [
    {
      id: `aud-boot-${Date.now()}`,
      timestamp: new Date().toISOString(),
      stage: 'Data & Columns',
      action: 'Dataset Loaded',
      actor: 'SYSTEM',
      detail: `${initialBoot.ds.name} (${initialBoot.ds.rows.length} rows, ${initialBoot.targetNames.length} targets, sha=${initialBoot.ds.sha256.slice(0, 10)})`,
    },
  ]);

  const [stage, setStage] = useState<StageId>('data');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);

  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [highContrast, setHighContrast] = useState<boolean>(false);
  const [fontScale, setFontScale] = useState<number>(1);
  const [gateNotice, setGateNotice] = useState<string | null>(null);

  const targets = useMemo(
    () => dataset.columns.filter((c) => c.role === 'target').map((c) => c.name),
    [dataset.columns]
  );

  useEffect(() => {
    if (targets.length > 0 && !targets.includes(activeTarget)) {
      setActiveTarget(targets[0]);
    }
  }, [targets, activeTarget]);

  // Sync Tailwind dark mode, high contrast, and font scaling
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', darkMode);
    root.classList.toggle('high-contrast', highContrast);
    root.style.setProperty('--ui-scale', String(fontScale));
  }, [darkMode, highContrast, fontScale]);

  // Global Ctrl+K / Cmd+K and Escape shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setPaletteOpen(false);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const appendAudit = useCallback(
    (stageLabel: string, action: string, actor: AuditEvent['actor'], detail: string) => {
      setAuditLog((prev) => [
        {
          id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          stage: stageLabel,
          action,
          actor,
          detail,
        },
        ...prev,
      ]);
    },
    []
  );

  const hasResultsYet = Object.keys(testsByTarget).length > 0;
  const analysisReady = vsgGateAccepted && tcpGateAccepted && hasResultsYet;
  const monitoringReady = Object.keys(lockedBaselines).length > 0;

  const isStageLocked = useCallback(
    (s: StageId): { locked: boolean; reason?: string } => {
      if (s === 'diagnostics' || s === 'modeling' || s === 'report') {
        if (!vsgGateAccepted) {
          return { locked: true, reason: 'Accept Step 2 Variable Selection Gate (VSG) first.' };
        }
        if (!tcpGateAccepted || !hasResultsYet) {
          return { locked: true, reason: 'Lock Step 3 Test Policy (TCP) and run analysis first.' };
        }
      }
      if (s === 'monitoring' && !monitoringReady) {
        return { locked: true, reason: 'Lock at least one target baseline in Step 5 Modeling first.' };
      }
      return { locked: false };
    },
    [vsgGateAccepted, tcpGateAccepted, hasResultsYet, monitoringReady]
  );

  const navigateToStage = useCallback(
    (nextStage: StageId) => {
      const check = isStageLocked(nextStage);
      if (check.locked) {
        setGateNotice(check.reason ?? 'Previous pipeline gate is required.');
        return;
      }
      setGateNotice(null);
      setStage(nextStage);
      setMobileNavOpen(false);
    },
    [isStageLocked]
  );

  // Dataset replacement (upload, preset, column edit, aggregation, NRE)
  const handleReplaceDataset = useCallback(
    (nextDs: DatasetState, reason: string, preserveGates = false) => {
      const init = initializeWorkspaceFromDataset(nextDs);
      setDataset(nextDs);
      setVsgByTarget(init.vsgByTarget);
      setProfilesByTarget(init.profilesByTarget);
      setScopeMatrixByTarget(init.scopeMatrixByTarget);
      setTcp(init.tcp);
      setAutoLogs((prev) => [...init.autoLogs, ...prev.slice(0, 80)]);
      setThresholdProfile(nextDs.domain === 'manufacturing' ? 'spc' : 'ashrae14');
      if (init.targetNames.length > 0) {
        setActiveTarget((cur) => (init.targetNames.includes(cur) ? cur : init.targetNames[0]));
      }
      if (!preserveGates) {
        setVsgGateAccepted(false);
        setTcpGateAccepted(false);
        setTestsByTarget({});
        setEdaByTarget({});
        setModelingByTarget({});
        setLockedBaselines({});
        setSnapshots([]);
      }
      appendAudit('Data & Columns', 'Dataset Updated', 'USER', reason);
    },
    [appendAudit]
  );

  const handleLoadPreset = useCallback(
    (preset: 'energy_mv' | 'manufacturing_spc' | 'healthcare_kpi') => {
      const ds = generateSyntheticDataset(preset, seed);
      handleReplaceDataset(ds, `Loaded synthetic benchmark '${ds.name}' (seed=${seed})`, false);
    },
    [seed, handleReplaceDataset]
  );

  // VSG Updates
  const handleUpdateVsgEntry = useCallback(
    (target: string, colName: string, requestedState: InclusionState) => {
      const col = dataset.columns.find((c) => c.name === colName);
      const prof = (profilesByTarget[target] ?? []).find((p) => p.name === colName);
      if (!col || !prof) return;

      const conflict = validateVsgConflict(col, prof, target, requestedState);
      const nowIso = new Date().toISOString();
      const phase = hasResultsYet ? 'post_test' : 'pre_test';
      const provenance = hasResultsYet ? 'post_hoc' : 'pre_registered';

      setVsgByTarget((prev) => {
        const targetMap = { ...(prev[target] ?? {}) };
        const existing = targetMap[colName];
        targetMap[colName] = {
          ...(existing ?? {
            columnName: colName,
            scopeFamilies: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'],
          }),
          columnName: colName,
          state: requestedState,
          mode: 'USER_OVERRIDE',
          phase,
          provenance,
          reason:
            conflict ??
            `User set '${colName}' to '${requestedState}' (${phase} / ${provenance}).`,
          rule: 'VSG User Override',
          timestamp: nowIso,
          conflict,
          scopeFamilies:
            requestedState === 'exclude'
              ? []
              : existing?.scopeFamilies?.length
                ? existing.scopeFamilies
                : ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'],
        };
        return { ...prev, [target]: targetMap };
      });

      setAutoLogs((prev) => [
        {
          id: `override-vsg-${target}-${colName}-${Date.now()}`,
          settingKey: `vsg.${target}.${colName}`,
          value: requestedState,
          signals: `phase=${phase}, provenance=${provenance}${conflict ? ', CONFLICT' : ''}`,
          rule: 'VSG Manual Override',
          mode: 'USER_OVERRIDE',
          target,
          timestamp: nowIso,
        },
        ...prev,
      ]);
      appendAudit(
        'Variable Gate (VSG)',
        `Set ${colName} -> ${requestedState}`,
        'USER',
        `Target ${target} (${provenance})`
      );
    },
    [dataset.columns, profilesByTarget, hasResultsYet, appendAudit]
  );

  const handleBulkUpdateVsg = useCallback(
    (target: string, updates: Record<string, InclusionState>, label: string) => {
      const nowIso = new Date().toISOString();
      const phase = hasResultsYet ? 'post_test' : 'pre_test';
      const provenance = hasResultsYet ? 'post_hoc' : 'pre_registered';
      const profiles = profilesByTarget[target] ?? [];

      setVsgByTarget((prev) => {
        const targetMap = { ...(prev[target] ?? {}) };
        for (const [colName, requestedState] of Object.entries(updates)) {
          const col = dataset.columns.find((c) => c.name === colName);
          const prof = profiles.find((p) => p.name === colName);
          if (!col || !prof) continue;
          const conflict = validateVsgConflict(col, prof, target, requestedState);
          if (conflict && requestedState !== 'exclude') {
            // Respect integrity gate on bulk actions
            continue;
          }
          const existing = targetMap[colName];
          targetMap[colName] = {
            ...(existing ?? {
              columnName: colName,
              scopeFamilies: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'],
            }),
            columnName: colName,
            state: requestedState,
            mode: 'USER_OVERRIDE',
            phase,
            provenance,
            reason: `Bulk action '${label}' (${phase})`,
            rule: 'VSG Bulk Action',
            timestamp: nowIso,
            conflict: null,
            scopeFamilies:
              requestedState === 'exclude'
                ? []
                : existing?.scopeFamilies?.length
                  ? existing.scopeFamilies
                  : ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'],
          };
        }
        return { ...prev, [target]: targetMap };
      });
      appendAudit('Variable Gate (VSG)', 'Bulk Update', 'USER', `${target}: ${label}`);
    },
    [dataset.columns, profilesByTarget, hasResultsYet, appendAudit]
  );

  const handleCopySelection = useCallback(
    (fromTarget: string, toTarget: string) => {
      const sourceEntries = vsgByTarget[fromTarget];
      if (!sourceEntries) return;
      const nowIso = new Date().toISOString();
      setVsgByTarget((prev) => {
        const copied: Record<string, VsgEntry> = {};
        const profiles = profilesByTarget[toTarget] ?? [];
        for (const col of dataset.columns) {
          if (col.name === toTarget || col.role === 'target') {
            copied[col.name] = prev[toTarget]?.[col.name] ?? sourceEntries[col.name];
            continue;
          }
          const src = sourceEntries[col.name];
          const prof = profiles.find((p) => p.name === col.name);
          if (!src || !prof) continue;
          const conflict = validateVsgConflict(col, prof, toTarget, src.state);
          copied[col.name] = {
            ...src,
            state: conflict ? 'exclude' : src.state,
            conflict,
            timestamp: nowIso,
            reason: conflict
              ? `Copied from ${fromTarget} blocked by integrity rule: ${conflict}`
              : `Copied from ${fromTarget}`,
          };
        }
        return { ...prev, [toTarget]: copied };
      });
      appendAudit('Variable Gate (VSG)', 'Copy Selection', 'USER', `${fromTarget} -> ${toTarget}`);
    },
    [vsgByTarget, profilesByTarget, dataset.columns, appendAudit]
  );

  const handleImportPreset = useCallback(
    (target: string, jsonText: string) => {
      const parsed = JSON.parse(jsonText) as { entries?: Record<string, InclusionState> };
      if (!parsed.entries || typeof parsed.entries !== 'object') {
        throw new Error('Preset JSON must contain an "entries" object.');
      }
      handleBulkUpdateVsg(target, parsed.entries, 'Imported VSG JSON Preset');
    },
    [handleBulkUpdateVsg]
  );

  const handleAcceptVsgGate = useCallback(() => {
    setVsgGateAccepted(true);
    setGateNotice(null);
    appendAudit(
      'Variable Gate (VSG)',
      'Candidate Pool Accepted',
      'USER',
      `Locked VSG candidate pools across ${targets.length} target(s)`
    );
    setStage('tcp');
  }, [targets.length, appendAudit]);

  // TCP Updates & Analysis Runner
  const handleUpdateTcp = useCallback(
    (next: TcpConfig, logDetail: string) => {
      setTcp(next);
      appendAudit('Test Policy (TCP)', 'Policy Updated', 'USER', logDetail);
    },
    [appendAudit]
  );

  const handleToggleScopeMatrix = useCallback(
    (target: string, colName: string, famId: TestFamilyId) => {
      setScopeMatrixByTarget((prev) => {
        const tMap = { ...(prev[target] ?? {}) };
        const current = new Set(tMap[colName] ?? []);
        if (current.has(famId)) current.delete(famId);
        else current.add(famId);
        tMap[colName] = Array.from(current);
        return { ...prev, [target]: tMap };
      });
    },
    []
  );

  const handleLockAndRunAnalysis = useCallback(() => {
    const nowIso = new Date().toISOString();
    const lockedTcp: TcpConfig = {
      ...tcp,
      preRegistered: true,
      preRegistrationTimestamp: tcp.preRegistrationTimestamp ?? nowIso,
      preRegistrationHash:
        tcp.preRegistrationHash ??
        deterministicHash(JSON.stringify({ alpha: tcp.alpha, corr: tcp.correctionMethod, rule: tcp.decisionRule, families: tcp.families })),
    };
    setTcp(lockedTcp);
    setTcpGateAccepted(true);
    setGateNotice(null);

    const nextTests: Record<string, StatisticalTestResult[]> = {};
    const nextEda: Record<string, EdaTargetSummary> = {};
    const nextModeling: Record<string, TargetModelingBundle> = {};
    const runSummary: RunArchiveEntry['summaryByTarget'] = {};

    for (const t of targets) {
      const targetVsg = vsgByTarget[t] ?? {};
      const testRes = runDiagnosticsSuite(dataset, t, targetVsg, lockedTcp, seed);
      const edaRes = computeEdaAndMining(dataset, t, targetVsg, lockedTcp, seed);
      const modelRes = runTargetModelingPipeline(
        dataset,
        t,
        targetVsg,
        lockedTcp,
        seed,
        thresholdProfile,
        weightProfile
      );
      nextTests[t] = testRes;
      nextEda[t] = edaRes;
      nextModeling[t] = modelRes;

      const top1 = modelRes.top5[0];
      const sigTests = testRes.filter(
        (r) => r.decision === 'reject_h0' || r.decision === 'practical_significant'
      ).length;
      runSummary[t] = {
        topModelName: top1?.name ?? 'N/A',
        oofCvRmse: top1?.oofCvRmse ?? 0,
        oofNmbe: top1?.oofNmbe ?? 0,
        oofR2: top1?.oofR2 ?? 0,
        features: top1?.featuresUsed ?? [],
        significantTestsCount: sigTests,
      };
    }

    setTestsByTarget(nextTests);
    setEdaByTarget(nextEda);
    setModelingByTarget(nextModeling);
    setRunHistory((prev) => [
      {
        runId: `run-${prev.length + 1}-${lockedTcp.preRegistrationHash?.slice(0, 6) ?? '000000'}`,
        timestamp: nowIso,
        seed,
        effortProfile: lockedTcp.effortProfile,
        alpha: lockedTcp.alpha,
        correctionMethod: lockedTcp.correctionMethod,
        summaryByTarget: runSummary,
      },
      ...prev,
    ]);

    appendAudit(
      'Test Policy (TCP)',
      'Pre-Registration Locked & Pipeline Executed',
      'SYSTEM',
      `Targets=[${targets.join(', ')}], alpha=${lockedTcp.alpha}, correction=${lockedTcp.correctionMethod}, effort=${lockedTcp.effortProfile}`
    );
    setStage('diagnostics');
  }, [tcp, targets, vsgByTarget, dataset, seed, thresholdProfile, weightProfile, appendAudit]);

  const handleReRunTargetModeling = useCallback(
    (target: string, profile: ThresholdProfileId, wProf: WeightProfile) => {
      setThresholdProfile(profile);
      setWeightProfile(wProf);
      const targetVsg = vsgByTarget[target] ?? {};
      const updated = runTargetModelingPipeline(
        dataset,
        target,
        targetVsg,
        tcp,
        seed,
        profile,
        wProf
      );
      setModelingByTarget((prev) => ({ ...prev, [target]: updated }));
      appendAudit(
        'Modeling & Top-5',
        `Re-scored ${target}`,
        'USER',
        `Threshold=${profile}, WeightProfile=${wProf}`
      );
    },
    [vsgByTarget, dataset, tcp, seed, appendAudit]
  );

  const handleLockBaseline = useCallback(
    (target: string, candidate: ModelCandidateResult, note: string) => {
      const prevVersion = lockedBaselines[target]?.version ?? 0;
      const targetVsg = vsgByTarget[target] ?? {};
      const locked = createLockedBaseline(
        dataset,
        candidate,
        targetVsg,
        tcp,
        thresholdProfile,
        prevVersion,
        note,
        seed
      );
      setLockedBaselines((prev) => ({ ...prev, [target]: locked }));
      appendAudit(
        'Modeling & Top-5',
        `Locked Baseline v${locked.version}`,
        'USER',
        `${target}: ${locked.modelName} (CV-RMSE=${candidate.oofCvRmse.toFixed(2)}%, sha=${locked.artifactSha256.slice(0, 10)})`
      );
    },
    [lockedBaselines, vsgByTarget, dataset, tcp, thresholdProfile, seed, appendAudit]
  );

  const handleSaveSnapshot = useCallback(
    (snap: MonitoringSnapshot) => {
      setSnapshots((prev) => [snap, ...prev]);
      appendAudit(
        'Prediction & Drift',
        `Saved Monitoring Snapshot (${snap.source})`,
        'USER',
        `${snap.target} v${snap.baselineVersion}: ${snap.points.length} pts, drift=${snap.drift.trafficLight.toUpperCase()}`
      );
    },
    [appendAudit]
  );

  const handleRestoreEbproj = useCallback(
    (restored: Awaited<ReturnType<typeof importEbprojZipFile>>) => {
      const init = initializeWorkspaceFromDataset(restored.dataset);
      setDataset(restored.dataset);
      setVsgByTarget(restored.vsgByTarget ?? init.vsgByTarget);
      setProfilesByTarget(init.profilesByTarget);
      setScopeMatrixByTarget(init.scopeMatrixByTarget);
      setTcp(restored.tcp);
      setLockedBaselines(restored.lockedBaselines ?? {});
      setAutoLogs(restored.autoLogs ?? init.autoLogs);
      setAuditLog(restored.auditLog ?? []);
      setVsgGateAccepted(true);
      setTcpGateAccepted(restored.tcp.preRegistered);
      if (restored.tcp.preRegistered) {
        const nextTests: Record<string, StatisticalTestResult[]> = {};
        const nextEda: Record<string, EdaTargetSummary> = {};
        const nextModeling: Record<string, TargetModelingBundle> = {};
        for (const t of init.targetNames) {
          const targetVsg = restored.vsgByTarget?.[t] ?? init.vsgByTarget[t] ?? {};
          nextTests[t] = runDiagnosticsSuite(restored.dataset, t, targetVsg, restored.tcp, restored.seed);
          nextEda[t] = computeEdaAndMining(restored.dataset, t, targetVsg, restored.tcp, restored.seed);
          nextModeling[t] = runTargetModelingPipeline(
            restored.dataset,
            t,
            targetVsg,
            restored.tcp,
            restored.seed,
            thresholdProfile,
            weightProfile
          );
        }
        setTestsByTarget(nextTests);
        setEdaByTarget(nextEda);
        setModelingByTarget(nextModeling);
      }
      appendAudit('System & Storage', 'Restored .ebproj Archive', 'USER', restored.dataset.name);
    },
    [thresholdProfile, weightProfile, appendAudit]
  );

  const paletteActions: PaletteAction[] = useMemo(() => {
    const navActions: PaletteAction[] = STAGES.map((st, idx) => {
      const check = isStageLocked(st.id);
      return {
        id: `nav-${st.id}`,
        label: `${idx + 1}. ${st.label}${check.locked ? ' (Locked)' : ''}`,
        category: 'Navigate Stage',
        disabled: check.locked,
        onExecute: () => navigateToStage(st.id),
      };
    });
    const targetActions: PaletteAction[] = targets.map((t) => ({
      id: `target-${t}`,
      label: `Switch active target to ${t}`,
      category: 'Target Context',
      onExecute: () => setActiveTarget(t),
    }));
    const utilActions: PaletteAction[] = [
      {
        id: 'toggle-dark',
        label: darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode',
        category: 'Appearance',
        onExecute: () => setDarkMode((d) => !d),
      },
      {
        id: 'toggle-inspector',
        label: inspectorOpen ? 'Close AUTO Inspector' : 'Open AUTO Resolutions & Audit Drawer',
        category: 'Workspace',
        onExecute: () => setInspectorOpen((o) => !o),
      },
      {
        id: 'toggle-hc',
        label: highContrast ? 'Disable High Contrast Mode' : 'Enable High Contrast Mode',
        category: 'Accessibility',
        onExecute: () => setHighContrast((h) => !h),
      },
    ];
    return [...navActions, ...targetActions, ...utilActions];
  }, [isStageLocked, navigateToStage, targets, darkMode, inspectorOpen, highContrast]);

  const currentStageMeta = STAGES.find((s) => s.id === stage) ?? STAGES[0];

  // Contextual single primary CTA in header (only on stages without an inline header CTA)
  const headerCta = useMemo(() => {
    if (stage === 'modeling' && monitoringReady) {
      return {
        label: 'Prediction & Drift',
        onClick: () => navigateToStage('monitoring'),
      };
    }
    if (stage === 'monitoring') {
      return {
        label: 'View Report',
        onClick: () => navigateToStage('report'),
      };
    }
    return null;
  }, [stage, monitoringReady, navigateToStage]);

  return (
    <div className="min-h-screen h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 overflow-hidden">
      {/* Top Bar (3-zone, compact <= 56px) */}
      <header className="h-14 shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 sm:px-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={() => setMobileNavOpen((o) => !o)}
            aria-label="Toggle navigation menu"
            className="lg:hidden p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
          >
            {mobileNavOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display font-bold text-sm tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap">
              EnergyBaseline
            </span>
            <span className="text-slate-300 dark:text-slate-700 hidden sm:inline">/</span>
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate hidden sm:inline">
              {currentStageMeta.step}. {currentStageMeta.label}
            </span>
          </div>
          <span className="hidden xl:inline text-[11px] font-mono text-slate-500 dark:text-slate-400 border-l border-slate-200 dark:border-slate-800 pl-2.5 truncate">
            {dataset.name} · {dataset.rows.length} rows · seed={seed}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {targets.length > 0 && (
            <label className="hidden md:flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <span className="text-[11px] text-slate-500 whitespace-nowrap">Target:</span>
              <select
                aria-label="Active Target"
                value={activeTarget}
                onChange={(e) => setActiveTarget(e.target.value)}
                className="text-xs font-mono border border-slate-200 dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-950 max-w-[140px]"
              >
                {targets.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            title="Command Palette (Ctrl+K)"
            className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Command className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="font-mono text-[11px]">Ctrl+K</span>
          </button>

          <button
            type="button"
            onClick={() => setInspectorOpen((o) => !o)}
            aria-label="Toggle AUTO Resolutions & Audit Inspector"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded whitespace-nowrap shrink-0 transition-colors ${
              inspectorOpen
                ? 'border-sky-600 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <PanelRightOpen className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden lg:inline">Inspector</span>
          </button>

          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-1.5 border border-slate-200 dark:border-slate-700 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 shrink-0"
          >
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>

          {headerCta && (
            <button
              type="button"
              onClick={headerCta.onClick}
              className="px-3 py-1.5 text-xs font-medium bg-sky-700 hover:bg-sky-800 text-white rounded whitespace-nowrap shrink-0"
            >
              {headerCta.label}
            </button>
          )}
        </div>
      </header>

      {/* Main Workspace Split: Left Stepper + Active View + Right Inspector */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* Desktop Collapsible Sidebar & Mobile Drawer */}
        <aside
          aria-label="Guided Pipeline Stepper"
          className={`${
            mobileNavOpen
              ? 'fixed inset-y-14 left-0 z-40 w-60 flex'
              : 'hidden lg:flex'
          } ${
            sidebarCollapsed ? 'lg:w-16' : 'lg:w-60'
          } flex-col border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 transition-all duration-150`}
        >
          <div className="p-2.5 flex items-center justify-between border-b border-slate-100 dark:border-slate-800">
            {!sidebarCollapsed && (
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400 px-1.5">
                M&V Workflow
              </span>
            )}
            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden lg:inline-flex p-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto p-2 space-y-1">
            {STAGES.map((st) => {
              const Icon = st.icon;
              const check = isStageLocked(st.id);
              const isActive = stage === st.id;
              return (
                <button
                  key={st.id}
                  type="button"
                  title={check.locked ? check.reason : st.label}
                  onClick={() => navigateToStage(st.id)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-left text-xs transition-colors ${
                    isActive
                      ? 'bg-sky-50 dark:bg-sky-950/50 text-sky-800 dark:text-sky-200 font-semibold border border-sky-200 dark:border-sky-800'
                      : check.locked
                        ? 'text-slate-400 dark:text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-not-allowed'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {!sidebarCollapsed && (
                    <div className="flex-1 min-w-0 flex items-center justify-between gap-1.5">
                      <span className="truncate whitespace-nowrap">
                        {st.step}. {st.label}
                      </span>
                      {check.locked && <Lock className="w-3 h-3 shrink-0 opacity-70" aria-hidden="true" />}
                    </div>
                  )}
                </button>
              );
            })}
          </nav>

          {!sidebarCollapsed && (
            <div className="p-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
              <div className="flex items-center justify-between font-mono">
                <span>VSG Gate</span>
                <span className={vsgGateAccepted ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                  {vsgGateAccepted ? 'LOCKED' : 'OPEN'}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono">
                <span>TCP Policy</span>
                <span className={tcp.preRegistered ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
                  {tcp.preRegistered ? 'PRE-REG' : 'DRAFT'}
                </span>
              </div>
              <div className="flex items-center justify-between font-mono">
                <span>Baselines</span>
                <span className="tabular-nums">
                  {Object.keys(lockedBaselines).length}/{targets.length}
                </span>
              </div>
            </div>
          )}
        </aside>

        {/* Backdrop for mobile nav */}
        {mobileNavOpen && (
          <div
            className="fixed inset-0 top-14 z-30 bg-slate-950/40 lg:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}

        {/* Active View Content */}
        <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
          <div className="max-w-7xl mx-auto space-y-4">
            {gateNotice && (
              <div
                role="alert"
                className="px-4 py-2.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-900 dark:text-amber-200 flex items-center justify-between gap-3"
              >
                <span>{gateNotice}</span>
                <button
                  type="button"
                  onClick={() => setGateNotice(null)}
                  className="text-amber-700 dark:text-amber-300 hover:underline shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

            {stage === 'data' && (
              <DataSetupView
                dataset={dataset}
                darkMode={darkMode}
                onLoadPreset={handleLoadPreset}
                onReplaceDataset={(next, reason) => handleReplaceDataset(next, reason, false)}
                onProceedToVsg={() => setStage('vsg')}
              />
            )}

            {stage === 'vsg' && (
              <VsgView
                dataset={dataset}
                targets={targets}
                activeTarget={activeTarget}
                onSelectTarget={setActiveTarget}
                vsgByTarget={vsgByTarget}
                profilesByTarget={profilesByTarget}
                tcp={tcp}
                hasResultsYet={hasResultsYet}
                vsgGateAccepted={vsgGateAccepted}
                onUpdateVsgEntry={handleUpdateVsgEntry}
                onBulkUpdateVsg={handleBulkUpdateVsg}
                onCopySelection={handleCopySelection}
                onImportPreset={handleImportPreset}
                onAcceptAndLockGate={handleAcceptVsgGate}
              />
            )}

            {stage === 'tcp' && (
              <TcpView
                dataset={dataset}
                activeTarget={activeTarget}
                tcp={tcp}
                existingTests={testsByTarget[activeTarget] ?? []}
                onUpdateTcp={handleUpdateTcp}
                onToggleScopeMatrix={handleToggleScopeMatrix}
                scopeMatrixByTarget={scopeMatrixByTarget}
                onLockAndRunAnalysis={handleLockAndRunAnalysis}
              />
            )}

            {stage === 'diagnostics' && (
              <DiagnosticsEdaView
                dataset={dataset}
                targets={targets}
                activeTarget={activeTarget}
                onSelectTarget={setActiveTarget}
                testsByTarget={testsByTarget}
                edaByTarget={edaByTarget}
                darkMode={darkMode}
                onProceedToModeling={() => navigateToStage('modeling')}
              />
            )}

            {stage === 'modeling' && (
              <ModelingView
                targets={targets}
                activeTarget={activeTarget}
                onSelectTarget={setActiveTarget}
                modelingByTarget={modelingByTarget}
                lockedBaselines={lockedBaselines}
                thresholdProfile={thresholdProfile}
                weightProfile={weightProfile}
                darkMode={darkMode}
                onReRunTargetModeling={handleReRunTargetModeling}
                onLockBaseline={handleLockBaseline}
                onProceedToMonitoring={() => navigateToStage('monitoring')}
              />
            )}

            {stage === 'monitoring' && (
              <MonitoringView
                dataset={dataset}
                lockedBaselines={lockedBaselines}
                snapshots={snapshots}
                darkMode={darkMode}
                onSaveSnapshot={handleSaveSnapshot}
              />
            )}

            {stage === 'report' && (
              <ReportView
                dataset={dataset}
                vsgByTarget={vsgByTarget}
                tcp={tcp}
                testsByTarget={testsByTarget}
                edaByTarget={edaByTarget}
                modelingByTarget={modelingByTarget}
                lockedBaselines={lockedBaselines}
                snapshots={snapshots}
                autoLogs={autoLogs}
                auditLog={auditLog}
                runHistory={runHistory}
                seed={seed}
              />
            )}

            {stage === 'status' && (
              <SystemStatusView
                dataset={dataset}
                vsgByTarget={vsgByTarget}
                tcp={tcp}
                lockedBaselines={lockedBaselines}
                autoLogs={autoLogs}
                auditLog={auditLog}
                seed={seed}
                darkMode={darkMode}
                highContrast={highContrast}
                fontScale={fontScale}
                onToggleDarkMode={() => setDarkMode((d) => !d)}
                onToggleHighContrast={() => setHighContrast((h) => !h)}
                onChangeFontScale={setFontScale}
                onRestoreEbproj={handleRestoreEbproj}
              />
            )}
          </div>
        </main>

        {/* Right Slide-in AUTO Inspector & Audit Drawer */}
        <AutoInspectorDrawer
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          autoLogs={autoLogs}
          auditLog={auditLog}
        />
      </div>

      {/* Ctrl+K Command Palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
    </div>
  );
}
