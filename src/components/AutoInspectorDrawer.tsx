import React from 'react';
import { AutoDecisionEntry, AuditEvent } from '../engine/types';
import { X } from 'lucide-react';

interface AutoInspectorDrawerProps {
  open: boolean;
  onClose: () => void;
  autoLogs: AutoDecisionEntry[];
  auditLog: AuditEvent[];
}

export const AutoInspectorDrawer: React.FC<AutoInspectorDrawerProps> = ({
  open,
  onClose,
  autoLogs,
  auditLog,
}) => {
  if (!open) return null;

  return (
    <aside
      aria-label="AUTO Resolutions and Audit Inspector"
      className="w-80 xl:w-96 border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col shrink-0 h-full overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-display">
            AUTO Resolutions & Audit
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {autoLogs.length} resolutions · {auditLog.length} events
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        <section>
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
            AUTO & Override Resolutions (Sorted by Target)
          </h3>
          <div className="space-y-2.5">
            {autoLogs.slice(0, 40).map((entry) => (
              <div
                key={entry.id}
                className="border border-slate-200 dark:border-slate-800 rounded p-2.5 text-xs space-y-1 bg-slate-50/50 dark:bg-slate-950/50"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-medium text-slate-900 dark:text-slate-100 truncate">
                    {entry.settingKey}
                  </span>
                  <span
                    className={`font-mono text-[11px] shrink-0 ${
                      entry.mode === 'AUTO' ? 'text-sky-700 dark:text-sky-400' : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {entry.mode}
                  </span>
                </div>
                <div className="text-slate-700 dark:text-slate-300 font-medium">
                  Value: <span className="font-mono">{entry.value}</span>
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  {entry.signals} · {entry.rule}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-slate-200 dark:border-slate-800 pt-4">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
            Recent Audit Trail
          </h3>
          <div className="space-y-2">
            {auditLog.slice(0, 25).map((ev) => (
              <div key={ev.id} className="text-xs border-b border-slate-100 dark:border-slate-800/70 pb-2">
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                  <span>
                    {ev.stage} · {ev.actor}
                  </span>
                  <span className="font-mono">{ev.timestamp.slice(11, 19)}</span>
                </div>
                <div className="text-slate-800 dark:text-slate-200 font-medium mt-0.5">{ev.action}</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">{ev.detail}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
};
