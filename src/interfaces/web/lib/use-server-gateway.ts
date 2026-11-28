import { useCallback, useEffect, useRef, useState } from 'react';
import { apiPost, ConsoleApiError } from './api';

export interface ServerMapping {
  name: string;
  nasPort: string;
  serverPort: string;
  accessMode: 'proxy' | 'ticket';
}

export interface ServerConnection {
  baseUrl: string;
  adminToken: string;
  unlockToken: string;
}

export interface ServerConfigResponse {
  configured: boolean;
  uglinkId?: string;
  username?: string;
  trafficMonthlyThresholdGb?: number | null;
  services?: Array<{ name: string; nasPort: string | number; serverPort: string | number; accessMode?: string }>;
}

export interface ServerStatusResponse {
  traffic: {
    monthlyTotals: { rx: number; tx: number };
    allTime: { rx: number; tx: number };
    period: string;
    monthlyServices: Array<{ service: string; rx: number; tx: number }>;
    thresholdExceeded: boolean;
    thresholdBytes?: number;
  };
  services?: Array<{ name: string; listening: boolean }>;
}

const CONNECTION_KEY = 'uglink_server_gateway_connection';

function loadConnection(): ServerConnection {
  try {
    const raw = localStorage.getItem(CONNECTION_KEY);
    if (raw) return JSON.parse(raw) as ServerConnection;
  } catch {
    // Ignore malformed stored data.
  }
  return { baseUrl: '', adminToken: '', unlockToken: '' };
}

function normalizeMappings(rows: ServerMapping[]): string {
  return JSON.stringify(rows
    .filter((row) => row.name.trim() && row.nasPort.trim() && row.serverPort.trim())
    .map((row) => ({ ...row, name: row.name.trim(), nasPort: row.nasPort.trim(), serverPort: row.serverPort.trim() })));
}

export function messageOf(error: unknown): string {
  if (error instanceof ConsoleApiError) return error.detail ? `${error.message}（${error.detail}）` : error.message;
  return error instanceof Error ? error.message : '发生了未知错误。';
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function useServerGateway(csrfToken: string) {
  const [connection, setConnection] = useState<ServerConnection>(loadConnection);
  const [mappings, setMappings] = useState<ServerMapping[]>([]);
  const [remote, setRemote] = useState<ServerConfigResponse>();
  const [status, setStatus] = useState<ServerStatusResponse>();
  const [busy, setBusy] = useState<'pull' | 'push' | 'status'>();
  const [message, setMessage] = useState<{ kind: 'ok' | 'bad'; text: string }>();
  const [pulled, setPulled] = useState(false);
  const baseline = useRef<string>(normalizeMappings([]));
  const baselineRows = useRef<ServerMapping[]>([]);
  const autoPull = useRef(false);

  const persistConnection = useCallback((next: ServerConnection) => {
    setConnection(next);
    localStorage.setItem(CONNECTION_KEY, JSON.stringify(next));
  }, []);

  const call = useCallback(async (action: 'pull' | 'push' | 'status', config?: Record<string, unknown>) => {
    return apiPost<ServerConfigResponse & ServerStatusResponse>(
      `/api/server-gateway/${action}`,
      csrfToken,
      {
        baseUrl: connection.baseUrl,
        adminToken: connection.adminToken,
        unlockToken: connection.unlockToken,
        ...(config ? { config } : {})
      }
    );
  }, [connection, csrfToken]);

  const refreshStatus = useCallback(async () => {
    if (!connection.baseUrl || !connection.adminToken) return;
    setBusy('status');
    try {
      const data = await call('status');
      setStatus({ traffic: data.traffic, services: data.services });
    } catch (error) {
      setMessage({ kind: 'bad', text: `获取状态失败：${messageOf(error)}` });
    } finally {
      setBusy(undefined);
    }
  }, [call, connection]);

  const applyRemote = useCallback((data: ServerConfigResponse) => {
    setRemote(data);
    const rows = (data.services ?? []).map((entry) => ({
      name: String(entry.name ?? ''),
      nasPort: String(entry.nasPort ?? ''),
      serverPort: String(entry.serverPort ?? ''),
      accessMode: entry.accessMode === 'ticket' ? 'ticket' as const : 'proxy' as const
    }));
    setMappings(rows);
    baseline.current = normalizeMappings(rows);
    baselineRows.current = rows;
  }, []);

  const pull = useCallback(async (silent = false) => {
    setBusy('pull');
    if (!silent) setMessage(undefined);
    try {
      const data = await call('pull');
      applyRemote(data);
      setPulled(true);
      if (!silent) setMessage({ kind: 'ok', text: '已拉取服务器当前配置，可直接修改后同步回去。' });
    } catch (error) {
      if (!silent) setMessage({ kind: 'bad', text: `拉取失败：${messageOf(error)}` });
    } finally {
      setBusy(undefined);
    }
  }, [applyRemote, call]);

  const push = useCallback(async (): Promise<boolean> => {
    setBusy('push');
    setMessage(undefined);
    const config = {
      services: mappings.filter((entry) => entry.name.trim() && entry.nasPort.trim() && entry.serverPort.trim())
    };
    try {
      const data = await call('push', config);
      applyRemote(data);
      setStatus((previous) => previous ? { ...previous, traffic: data.traffic } : previous);
      setMessage({ kind: 'ok', text: '已同步到服务器网关，配置即时生效。' });
      return true;
    } catch (error) {
      setMessage({ kind: 'bad', text: `同步失败：${messageOf(error)}` });
      return false;
    } finally {
      setBusy(undefined);
    }
  }, [applyRemote, call, mappings]);

  const resetMappings = useCallback(() => {
    setMappings(baselineRows.current);
    setMessage(undefined);
  }, []);

  const connected = Boolean(connection.baseUrl && connection.adminToken);

  // Pull the server's live mappings once on mount so the unified service list
  // reflects what is actually deployed, and keep the status fresh.
  useEffect(() => {
    if (!connected || autoPull.current) return undefined;
    autoPull.current = true;
    void pull(true);
    return undefined;
  }, [connected, pull]);

  useEffect(() => {
    if (!connected) return undefined;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 15_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.baseUrl, connection.adminToken]);

  const dirty = normalizeMappings(mappings) !== baseline.current;

  const listeningByName = new Map((status?.services ?? []).map((entry) => [entry.name, entry.listening]));

  return {
    connection,
    persistConnection,
    mappings,
    setMappings,
    remote,
    status,
    busy,
    message,
    setMessage,
    pulled,
    connected,
    dirty,
    listeningByName,
    pull,
    push,
    resetMappings,
    refreshStatus
  };
}

export type ServerGatewayState = ReturnType<typeof useServerGateway>;
