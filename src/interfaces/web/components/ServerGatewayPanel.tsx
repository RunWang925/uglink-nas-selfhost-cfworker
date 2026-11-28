import { ArrowDownUp, Cloud, HardDrive, RefreshCw, Route } from 'lucide-react';
import type { ProviderStatus } from '../../../application/console/contracts';
import { formatBytes, useServerGateway } from '../lib/use-server-gateway';

interface RouteManagerPanelProps {
  csrfToken: string;
  cfStatus: ProviderStatus;
  cfConnected: boolean;
  onConfigureCf: () => void;
}

export function RouteManagerPanel({ csrfToken, cfStatus, cfConnected, onConfigureCf }: RouteManagerPanelProps) {
  const server = useServerGateway(csrfToken);
  const traffic = server.status?.traffic;

  return (
    <div className="section-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">双路线连接</p>
          <h1>线路管理</h1>
          <p>Cloudflare 与自建服务两条路线各自独立配置，可只配一条，也可以都配。服务走哪条线，取决于该线路是否已配置。</p>
        </div>
      </div>

      <div className="route-manager-grid">
        <section className="panel route-manager-card">
          <div className="route-manager-card__head">
            <span className="route-badge route-badge--cf"><Cloud size={13} /> Cloudflare</span>
            <span className="route-manager-card__state">
              <span className={`health-dot ${cfConnected ? 'health-dot--ok' : 'health-dot--pending'}`} />
              {cfConnected ? '已连接' : '未配置'}
            </span>
          </div>
          <p className="muted">通过 Cloudflare Worker 提供域名访问（代理模式 / 绿联跳转）。配置 Account ID 与 API Token 后即可发布走此路线的服务。</p>
          {cfConnected && cfStatus.detail && <p className="route-manager-card__detail">{cfStatus.detail}</p>}
          <div className="route-card__actions">
            <button className="button button--secondary" type="button" onClick={onConfigureCf}>
              <Route size={15} /> {cfConnected ? '查看 / 重新配置' : '去配置 Cloudflare'}
            </button>
          </div>
        </section>

        <section className="panel route-manager-card">
          <div className="route-manager-card__head">
            <span className="route-badge route-badge--server"><HardDrive size={13} /> 自建服务</span>
            <span className="route-manager-card__state">
              <span className={`health-dot ${server.connected ? 'health-dot--ok' : 'health-dot--pending'}`} />
              {server.connected ? '已连接' : '未配置'}
            </span>
          </div>
          <p className="muted">通过自己服务器上的网关 IP:端口直连访问（代理模式 / 绿联跳转）。地址与令牌保存在本浏览器，不会上传。</p>
          {server.remote?.configured && server.remote.uglinkId && (
            <p className="route-manager-card__detail">UGREENlink ID · {server.remote.uglinkId}</p>
          )}
          <div className="route-card__fields">
            <label>服务器地址<input
              value={server.connection.baseUrl}
              onChange={(event) => server.persistConnection({ ...server.connection, baseUrl: event.target.value.trim() })}
              placeholder="http://1.95.73.243:9090"
              autoComplete="off"
            /></label>
            <label>访问令牌（ADMIN_TOKEN）<input
              value={server.connection.adminToken}
              onChange={(event) => server.persistConnection({ ...server.connection, adminToken: event.target.value.trim() })}
              type="password"
              autoComplete="off"
            /></label>
            <label>编辑解锁令牌（UNLOCK_TOKEN）<input
              value={server.connection.unlockToken}
              onChange={(event) => server.persistConnection({ ...server.connection, unlockToken: event.target.value.trim() })}
              type="password"
              autoComplete="off"
            /></label>
          </div>
          <div className="route-card__actions">
            <button className="button button--secondary" type="button" disabled={!server.connected || server.busy === 'pull'} onClick={() => void server.pull()}>
              {server.busy === 'pull' ? <ArrowDownUp className="spin" size={15} /> : <ArrowDownUp size={15} />} 重新拉取配置
            </button>
            <button className="button button--secondary" type="button" disabled={!server.connected || server.busy === 'status'} onClick={() => void server.refreshStatus()}>
              {server.busy === 'status' ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />} 刷新状态
            </button>
          </div>
          {server.message && (
            <p className="muted" style={{ color: server.message.kind === 'bad' ? '#a32d2d' : '#0f6e56' }}>{server.message.text}</p>
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel__heading panel__heading--row">
          <div className="panel__heading-text">
            <h2>自建服务流量统计</h2>
            <p>数据在服务器网关上统计，按月重置、重启不丢。Cloudflare 路线的流量由 Cloudflare 承担，不经过你的服务器。</p>
          </div>
        </div>
        {traffic ? (
          <>
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 10 }}>
              <div><div className="muted">本月已用</div><div className="stat">{formatBytes(traffic.monthlyTotals.rx + traffic.monthlyTotals.tx)}</div></div>
              <div><div className="muted">历史累计</div><div className="stat">{formatBytes(traffic.allTime.rx + traffic.allTime.tx)}</div></div>
              <div><div className="muted">统计周期</div><div className="stat">{traffic.period}</div></div>
            </div>
            {traffic.thresholdExceeded && (
              <p style={{ color: '#854f0b', background: '#fff6e0', borderRadius: 10, padding: '10px 14px' }}>
                本月流量已超过预警阈值（{formatBytes(traffic.thresholdBytes ?? 0)}）。
              </p>
            )}
            <table className="service-table" role="table" aria-label="服务器流量统计">
              <thead>
                <tr className="service-table__head"><th scope="col">服务</th><th scope="col">本月接收</th><th scope="col">本月发出</th><th scope="col">合计</th></tr>
              </thead>
              <tbody>
                {(traffic.monthlyServices ?? []).length === 0 && (
                  <tr className="empty-row"><td colSpan={4}>暂无流量记录。</td></tr>
                )}
                {(traffic.monthlyServices ?? []).map((item) => (
                  <tr key={item.service}>
                    <td>{item.service}</td><td>{formatBytes(item.rx)}</td><td>{formatBytes(item.tx)}</td><td>{formatBytes(item.rx + item.tx)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">配置自建服务的服务器地址与访问令牌后即可查看流量统计。</p>
        )}
      </section>
    </div>
  );
}
