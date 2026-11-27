import { ArrowDownUp, CheckCircle2, LoaderCircle, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { apiPost, ConsoleApiError } from '../lib/api';

interface ServerMapping {
  name: string;
  nasPort: string;
  serverPort: string;
  accessMode: 'proxy' | 'ticket';
}

interface ServerConnection {
  baseUrl: string;
  adminToken: string;
  unlockToken: string;
}

interface ServerConfigResponse {
  configured: boolean;
  uglinkId?: string;
  username?: string;
  trafficMonthlyThresholdGb?: number | null;
  services?: Array<{ name: string; nasPort: string | number; serverPort: string | number; accessMode?: string }>;
}

interface ServerStatusResponse {
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

function fmt(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function messageOf(error: unknown): string {
  if (error instanceof ConsoleApiError) return error.detail ? `${error.message}（${error.detail}）` : error.message;
  return error instanceof Error ? error.message : '发生了未知错误。';
}

export function ServerGatewayPanel({ csrfToken }: { csrfToken: string }) {
  const [connection, setConnection] = useState<ServerConnection>(loadConnection);
  const [mappings, setMappings] = useState<ServerMapping[]>([]);
  const [remote, setRemote] = useState<ServerConfigResponse>();
  const [status, setStatus] = useState<ServerStatusResponse>();
  const [busy, setBusy] = useState<'pull' | 'push' | 'status'>();
  const [message, setMessage] = useState<{ kind: 'ok' | 'bad'; text: string }>();

  const persist = useCallback((next: ServerConnection) => {
    setConnection(next);
    localStorage.setItem(CONNECTION_KEY, JSON.stringify(next));
  }, []);

  const call = useCallback(async (action: 'pull' | 'push' | 'status', config?: Record<string, unknown>) => {
    const response = await apiPost<ServerConfigResponse & ServerStatusResponse>(
      `/api/server-gateway/${action}`,
      csrfToken,
      {
        baseUrl: connection.baseUrl,
        adminToken: connection.adminToken,
        unlockToken: connection.unlockToken,
        ...(config ? { config } : {})
      }
    );
    return response;
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

  const pull = useCallback(async () => {
    setBusy('pull');
    setMessage(undefined);
    try {
      const data = await call('pull');
      setRemote(data);
      setMappings((data.services ?? []).map((entry) => ({
        name: String(entry.name ?? ''),
        nasPort: String(entry.nasPort ?? ''),
        serverPort: String(entry.serverPort ?? ''),
        accessMode: entry.accessMode === 'ticket' ? 'ticket' : 'proxy'
      })));
      setMessage({ kind: 'ok', text: '已拉取服务器当前配置，可直接修改后同步回去。' });
    } catch (error) {
      setMessage({ kind: 'bad', text: `拉取失败：${messageOf(error)}` });
    } finally {
      setBusy(undefined);
    }
  }, [call]);

  const push = useCallback(async () => {
    setBusy('push');
    setMessage(undefined);
    const config = {
      services: mappings.filter((entry) => entry.name.trim() && entry.nasPort.trim() && entry.serverPort.trim())
    };
    try {
      const data = await call('push', config);
      setRemote(data);
      setStatus((previous) => previous ? { ...previous, traffic: data.traffic } : previous);
      setMessage({ kind: 'ok', text: '已同步到服务器网关，配置即时生效。' });
    } catch (error) {
      setMessage({ kind: 'bad', text: `同步失败：${messageOf(error)}` });
    } finally {
      setBusy(undefined);
    }
  }, [call, mappings]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 15_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.baseUrl, connection.adminToken]);

  const connected = Boolean(connection.baseUrl && connection.adminToken);
  const listeningByName = new Map((status?.services ?? []).map((entry) => [entry.name, entry.listening]));

  const updateMapping = (index: number, patch: Partial<ServerMapping>) => {
    setMappings((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  };

  return (
    <div className="section-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">自托管服务器</p>
          <h1>服务器网关</h1>
          <p>管理部署在自己服务器上的网关：端口映射、访问方式与流量统计。配置在此修改后同步到服务器即时生效。</p>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel__heading panel__heading--row">
          <div className="panel__heading-text">
            <h2>连接信息</h2>
            <p>服务器网关地址与管理令牌（服务器 .env 中的 ADMIN_TOKEN / UNLOCK_TOKEN）。</p>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
          <label>服务器地址<input
            value={connection.baseUrl}
            onChange={(event) => persist({ ...connection, baseUrl: event.target.value.trim() })}
            placeholder="http://1.95.73.243:9090"
            autoComplete="off"
          /></label>
          <label>访问令牌（ADMIN_TOKEN）<input
            value={connection.adminToken}
            onChange={(event) => persist({ ...connection, adminToken: event.target.value.trim() })}
            type="password"
            autoComplete="off"
          /></label>
          <label>编辑解锁令牌（UNLOCK_TOKEN，推送必填）<input
            value={connection.unlockToken}
            onChange={(event) => persist({ ...connection, unlockToken: event.target.value.trim() })}
            type="password"
            autoComplete="off"
          /></label>
        </div>
        <div className="row" style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="button button--secondary" type="button" disabled={!connected || busy === 'pull'} onClick={() => void pull()}>
            {busy === 'pull' ? <LoaderCircle className="spin" size={15} /> : <ArrowDownUp size={15} />} 拉取当前配置
          </button>
          <button className="button button--secondary" type="button" disabled={!connected || busy === 'status'} onClick={() => void refreshStatus()}>
            {busy === 'status' ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} 刷新状态
          </button>
          {remote?.configured && <span className="muted">已连接 · UGREENlink ID <strong>{remote.uglinkId}</strong></span>}
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel__heading panel__heading--row">
          <div className="panel__heading-text">
            <h2>端口映射</h2>
            <p>每条映射：服务器端口 → NAS 端口，可单独切换访问方式。</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="button button--secondary" type="button" onClick={() => setMappings((rows) => [...rows, { name: `service-${rows.length + 1}`, nasPort: '', serverPort: '', accessMode: 'proxy' }])}>
              <Plus size={15} /> 添加映射
            </button>
            <button className="button button--primary" type="button" disabled={!connected || busy === 'push' || mappings.length === 0} onClick={() => void push()}>
              {busy === 'push' ? <LoaderCircle className="spin" size={15} /> : <Server size={15} />} 同步到服务器
            </button>
          </div>
        </div>
        <table className="service-table" role="table" aria-label="服务器网关端口映射">
          <thead>
            <tr className="service-table__head">
              <span>名称</span><span>NAS 端口</span><span>服务器端口</span><span>访问方式</span><span>状态</span><span>操作</span>
            </tr>
          </thead>
          <tbody>
            {mappings.length === 0 && (
              <tr className="empty-row"><td colSpan={6}>暂无映射。点击「拉取当前配置」读取服务器上已生效的配置，或手动添加。</td></tr>
            )}
            {mappings.map((entry, index) => (
              <tr key={`${index}-${entry.name}`} className="service-table__row">
                <td><input value={entry.name} onChange={(event) => updateMapping(index, { name: event.target.value })} aria-label="名称" /></td>
                <td><input value={entry.nasPort} onChange={(event) => updateMapping(index, { nasPort: event.target.value.replace(/\D/g, '') })} aria-label="NAS 端口" /></td>
                <td><input value={entry.serverPort} onChange={(event) => updateMapping(index, { serverPort: event.target.value.replace(/\D/g, '') })} aria-label="服务器端口" /></td>
                <td>
                  <select value={entry.accessMode} onChange={(event) => updateMapping(index, { accessMode: event.target.value as 'proxy' | 'ticket' })} aria-label="访问方式">
                    <option value="proxy">代理（地址不变）</option>
                    <option value="ticket">票据（跳绿联域名）</option>
                  </select>
                </td>
                <td className={listeningByName.get(entry.name) ? 'ok' : 'muted'}>
                  {listeningByName.has(entry.name) ? (listeningByName.get(entry.name) ? '● 监听中' : '● 未监听') : '—'}
                </td>
                <td>
                  <button className="button button--ghost" type="button" onClick={() => setMappings((rows) => rows.filter((_, i) => i !== index))} aria-label="删除映射">
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {message && (
          <p className={`muted${message.kind === 'bad' ? '' : ''}`} style={{ color: message.kind === 'bad' ? '#a32d2d' : '#0f6e56', display: 'flex', alignItems: 'center', gap: 6 }}>
            {message.kind === 'ok' && <CheckCircle2 size={14} />} {message.text}
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel__heading panel__heading--row">
          <div className="panel__heading-text">
            <h2>流量统计（服务器侧）</h2>
            <p>数据在服务器网关上统计，按月重置、重启不丢。</p>
          </div>
        </div>
        {status ? (
          <>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 10 }}>
              <div><div className="muted">本月已用</div><div className="stat">{fmt(status.traffic.monthlyTotals.rx + status.traffic.monthlyTotals.tx)}</div></div>
              <div><div className="muted">历史累计</div><div className="stat">{fmt(status.traffic.allTime.rx + status.traffic.allTime.tx)}</div></div>
              <div><div className="muted">统计周期</div><div className="stat">{status.traffic.period}</div></div>
            </div>
            {status.traffic.thresholdExceeded && (
              <p style={{ color: '#854f0b', background: '#fff6e0', borderRadius: 10, padding: '10px 14px' }}>
                本月流量已超过预警阈值（{fmt(status.traffic.thresholdBytes ?? 0)}）。
              </p>
            )}
            <table className="service-table" role="table" aria-label="服务器流量统计">
              <thead><tr className="service-table__head"><span>服务</span><span>本月接收</span><span>本月发出</span><span>合计</span></tr></thead>
              <tbody>
                {(status.traffic.monthlyServices ?? []).length === 0 && (
                  <tr className="empty-row"><td colSpan={4}>暂无流量记录。</td></tr>
                )}
                {(status.traffic.monthlyServices ?? []).map((item) => (
                  <tr key={item.service}>
                    <td>{item.service}</td><td>{fmt(item.rx)}</td><td>{fmt(item.tx)}</td><td>{fmt(item.rx + item.tx)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">填写连接信息后即可查看流量统计。</p>
        )}
      </section>
    </div>
  );
}
