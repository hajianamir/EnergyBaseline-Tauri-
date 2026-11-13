import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SidecarDatabaseStatus {
  ok?: boolean;
  url_masked?: string;
  fallback?: boolean;
  fallback_tier?: string;
  writable?: boolean;
  warning?: string | null;
}

export interface SidecarUiStatus {
  state: 'stopped' | 'starting' | 'ready' | 'failed' | 'stopping' | 'web-preview' | string;
  message?: string | null;
  logPath?: string;
  db?: SidecarDatabaseStatus | null;
}

export interface SidecarProgress {
  request_id?: string | number | null;
  target?: string;
  stage?: string;
  percent?: number;
  test_id?: string;
}

interface SystemStatusResponse {
  db?: SidecarDatabaseStatus;
  log_path?: string;
}

const previewStatus: SidecarUiStatus = {
  state: 'web-preview',
  message: 'The Python sidecar is available only in the Tauri desktop application.',
};

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'Sidecar health check failed. See the sidecar log for details.';
}

function makeRequestId(): string {
  return `system-status-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

export function useSidecarRuntime() {
  const [status, setStatus] = useState<SidecarUiStatus>({ state: 'starting' });
  const [progress, setProgress] = useState<SidecarProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const requestIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  const checkStatus = useCallback(async () => {
    if (!isTauri()) {
      setStatus(previewStatus);
      setChecking(false);
      return;
    }
    const id = makeRequestId();
    requestIdRef.current = id;
    if (mountedRef.current) {
      setChecking(true);
      setProgress({ target: 'system', stage: 'status', percent: 0 });
      setStatus((previous) => ({ ...previous, state: 'starting', message: null }));
    }
    try {
      const result = await invoke<SystemStatusResponse>('rpc_call', {
        method: 'system.status',
        params: {},
        id,
      });
      if (mountedRef.current) {
        setStatus({
          state: 'ready',
          db: result.db ?? null,
          logPath: result.log_path,
          message: null,
        });
      }
    } catch (error) {
      if (mountedRef.current) {
        const message = errorMessage(error);
        setStatus((previous) => message.startsWith('CANCELLED:')
          ? { ...previous, state: 'ready', message: null }
          : { ...previous, state: 'failed', message });
      }
    } finally {
      if (requestIdRef.current === id) requestIdRef.current = null;
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  const cancelCheck = useCallback(async () => {
    const id = requestIdRef.current;
    if (!id || !isTauri()) return;
    try {
      await invoke('rpc_cancel', { id });
    } catch (error) {
      if (mountedRef.current) {
        setStatus((previous) => ({ ...previous, message: errorMessage(error) }));
      }
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    mountedRef.current = true;
    if (!isTauri()) {
      setStatus(previewStatus);
      return () => {
        disposed = true;
        mountedRef.current = false;
      };
    }

    let unlistenState: UnlistenFn | undefined;
    let unlistenProgress: UnlistenFn | undefined;
    void (async () => {
      try {
        const stateListener = await listen<SidecarUiStatus>('sidecar-state', (event) => {
          if (!disposed) setStatus(event.payload);
        });
        if (disposed) {
          stateListener();
          return;
        }
        unlistenState = stateListener;

        const progressListener = await listen<SidecarProgress>('sidecar-progress', (event) => {
          if (!disposed) setProgress(event.payload);
        });
        if (disposed) {
          progressListener();
          return;
        }
        unlistenProgress = progressListener;
        await checkStatus();
      } catch (error) {
        if (!disposed) {
          setStatus({ state: 'failed', message: errorMessage(error) });
          setChecking(false);
        }
      }
    })();

    return () => {
      disposed = true;
      mountedRef.current = false;
      unlistenState?.();
      unlistenProgress?.();
    };
  }, [checkStatus]);

  return { status, progress, checking, checkStatus, cancelCheck };
}
