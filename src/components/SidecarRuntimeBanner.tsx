import React from 'react';
import { CheckCircle2, CircleHelp, LoaderCircle, RefreshCw, XCircle } from 'lucide-react';
import type { SidecarProgress, SidecarUiStatus } from '../lib/sidecarRuntime';

interface SidecarRuntimeBannerProps {
  status: SidecarUiStatus;
  progress: SidecarProgress | null;
  checking: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

export const SidecarRuntimeBanner: React.FC<SidecarRuntimeBannerProps> = ({
  status,
  progress,
  checking,
  onRetry,
  onCancel,
}) => {
  const isReady = status.state === 'ready';
  const isFailed = status.state === 'failed';
  const isPreview = status.state === 'web-preview';
  const memoryFallback = status.db?.fallback_tier === 'memory_sqlite';
  const databaseUnhealthy = isReady && status.db?.ok === false;
  const isDegraded = isReady && (status.db?.fallback === true || status.db?.writable === false);
  const isCritical = isFailed || memoryFallback || databaseUnhealthy;
  const theme = isCritical
    ? 'border-rose-300 bg-rose-50 text-rose-950 dark:border-rose-900/70 dark:bg-rose-950/40 dark:text-rose-100'
    : isDegraded
      ? 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200'
      : isReady
        ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-200'
        : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300';

  return (
    <div
      role={isCritical ? 'alert' : 'status'}
      aria-live={isCritical ? 'assertive' : 'polite'}
      className={`shrink-0 border-b px-4 py-1.5 text-[11px] ${theme}`}
    >
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center gap-x-2 gap-y-1">
        {isReady && !isCritical ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : isCritical ? (
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : isPreview ? (
          <CircleHelp className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
        )}
        <span className="font-semibold">
          {isReady
            ? memoryFallback
              ? 'Desktop sidecar online · VOLATILE IN-MEMORY STORAGE'
              : databaseUnhealthy
                ? 'Desktop sidecar online · database health failed'
                : isDegraded
                  ? 'Desktop sidecar online · storage fallback'
                  : 'Desktop sidecar online'
            : isFailed
              ? 'Desktop sidecar unavailable'
              : isPreview
                ? 'Browser preview · desktop sidecar not connected'
                : 'Starting desktop sidecar…'}
        </span>
        {status.db?.fallback && <span>· SQLite fallback: {status.db.fallback_tier ?? 'active'}</span>}
        {status.db?.warning && <span className="truncate">· {status.db.warning}</span>}
        {checking && progress && (
          <span className="font-mono">
            · {progress.stage ?? 'status'} {typeof progress.percent === 'number' ? `${progress.percent}%` : ''}
          </span>
        )}
        {status.message && isFailed && (
          <span className="min-w-0 flex-1 truncate" title={status.message}>
            · {status.message}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {checking && !isPreview && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-1.5 py-0.5 underline-offset-2 hover:underline"
            >
              Cancel check
            </button>
          )}
          {isFailed && (
            <button
              type="button"
              onClick={onRetry}
              disabled={checking}
              className="inline-flex items-center gap-1 rounded border border-current/30 px-2 py-0.5 font-semibold disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
