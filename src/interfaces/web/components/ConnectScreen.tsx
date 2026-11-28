import {
  ArrowRight,
  ArrowUpRight,
  ArchiveRestore,
  Check,
  Cloud,
  Database,
  HardDrive,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Route,
  ServerCog,
  ShieldCheck
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiPost, ConsoleApiError } from '../lib/api';
import type { BootstrapResponse } from '../../../application/console/contracts';
import { Brand } from './Brand';
import { BackupDialog } from './BackupDialog';

interface ConnectScreenProps {
  bootstrap: BootstrapResponse;
}

type Route = 'cloudflare' | 'server';

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  }
  return error instanceof Error ? error.message : '连接失败，请稍后重试。';
}

export function ConnectScreen({ bootstrap }: ConnectScreenProps) {
  const [route, setRoute] = useState<Route>('cloudflare');
  const [accountId, setAccountId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [workerName, setWorkerName] = useState('uglink-worker');
  const [busy, setBusy] = useState<'cloudflare' | 'server' | false>(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [restoringBackup, setRestoringBackup] = useState(false);
  const canConnect = accountId.trim().length === 32
    && apiToken.trim().length >= 20
    && workerName.trim().length > 0;

  const finish = () => {
    window.history.replaceState({}, '', '/');
    window.location.reload();
  };

  const connectCloudflare = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canConnect || busy) return;
    setBusy('cloudflare');
    setConnectionError(undefined);
    try {
      await apiPost<BootstrapResponse>('/api/connections/cloudflare', bootstrap.csrfToken, {
        accountId,
        apiToken,
        workerName
      });
      setApiToken('');
      finish();
    } catch (error) {
      setApiToken('');
      setConnectionError(errorMessage(error));
      setBusy(false);
    }
  };

  const connectServer = async () => {
    if (busy) return;
    setBusy('server');
    setConnectionError(undefined);
    try {
      await apiPost<BootstrapResponse>('/api/connections/mode', bootstrap.csrfToken, {
        accessMode: 'server'
      });
      finish();
    } catch (error) {
      setConnectionError(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <div className="connect-shell">
      <header className="connect-header">
        <Brand />
        <div className="connect-header__right">
          <span>安全管理控制台</span>
        </div>
      </header>

      <div className="connect-layout">
        <aside className="connect-rail">
          <div>
            <p className="eyebrow">初始设置</p>
            <h1>选择<br />网关路线</h1>
            <p className="connect-rail__lead">Cloudflare 与自建服务两条路线可分别配置、互不干扰。先选择一条路线开始配置。</p>
          </div>
          <ol className="setup-steps">
            <li className={route === 'cloudflare' ? 'is-current' : ''}>
              <span>1</span>
              <div><strong>选择网关路线</strong><small>Cloudflare 或 自建服务</small></div>
            </li>
            <li>
              <span>2</span>
              <div><strong>填写连接信息</strong><small>凭据只在服务端加密保存</small></div>
            </li>
            <li>
              <span>3</span>
              <div><strong>配置服务映射</strong><small>域名、端口与访问方式</small></div>
            </li>
          </ol>
          <div className="rail-security">
            <ShieldCheck size={19} />
            <p><strong>凭据保护</strong><br />所有令牌只在服务端会话中加密保存，不会写入浏览器存储。</p>
          </div>
        </aside>

        <main className="connect-main">
          <div className="connect-card">
            <div className="connect-card__heading">
              <p className="eyebrow">访问路线</p>
              <h2>你想使用哪种网关？</h2>
              <p>两种路线都基于同一套 NAS 连接配置，可到「线路管理」分别调整。</p>
            </div>

            <div className="route-picker" role="radiogroup" aria-label="网关路线">
              <button
                type="button"
                role="radio"
                aria-checked={route === 'cloudflare'}
                className={`route-card${route === 'cloudflare' ? ' is-active' : ''}`}
                onClick={() => { setRoute('cloudflare'); setConnectionError(undefined); }}
              >
                <span className="route-card__icon route-card__icon--cloud"><Cloud size={22} strokeWidth={1.9} /></span>
                <span className="route-card__body">
                  <strong>Cloudflare 网关</strong>
                  <small>借助 Cloudflare Worker 提供访问域名，支持代理模式或绿联跳转。</small>
                </span>
                <span className="route-card__check">{route === 'cloudflare' && <Check size={15} />}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={route === 'server'}
                className={`route-card${route === 'server' ? ' is-active' : ''}`}
                onClick={() => { setRoute('server'); setConnectionError(undefined); }}
              >
                <span className="route-card__icon route-card__icon--server"><HardDrive size={22} strokeWidth={1.9} /></span>
                <span className="route-card__body">
                  <strong>自建服务网关</strong>
                  <small>用自己的服务器端口直连，无需域名与 Cloudflare。</small>
                </span>
                <span className="route-card__check">{route === 'server' && <Check size={15} />}</span>
              </button>
            </div>

            {connectionError && (
              <div className="inline-alert inline-alert--error" role="alert">
                <LockKeyhole size={18} />
                <div><strong>连接没有完成</strong><p>{connectionError}</p></div>
              </div>
            )}

            {route === 'server' ? (
              <div className="server-route-panel">
                <div className="server-route-panel__lead">
                  <ServerCog size={20} />
                  <div>
                    <h3>无需 Cloudflare 凭据</h3>
                    <p>进入后打开「服务器网关」，填写服务器地址与管理令牌即可开始配置端口映射、访问方式与流量预警。</p>
                  </div>
                </div>
                <div className="security-note">
                  <LockKeyhole size={17} />
                  <p>服务器地址与令牌仅保存在当前浏览器本地；网关状态通过本机控制台代理读取。</p>
                </div>
                <div className="connect-actions">
                  <span>稍后可在「权限与安全」中补充连接 Cloudflare</span>
                  <button className="button button--primary" type="button" disabled={Boolean(busy)} onClick={() => void connectServer()}>
                    {busy === 'server' ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
                    进入服务器网关
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={(event) => void connectCloudflare(event)}>
                <div className="connection-list">
                  <article className="connection-row">
                    <span className="connection-row__logo connection-row__logo--cloudflare" aria-hidden="true">
                      <Cloud size={23} strokeWidth={1.9} />
                    </span>
                    <div className="connection-row__copy">
                      <div className="connection-row__title"><h3>Cloudflare API Token</h3></div>
                      <p>资源范围建议限定到一个账户，并仅授予 Worker 与 KV 写入权限。</p>
                    </div>
                    <a
                      className="button button--secondary"
                      href="https://dash.cloudflare.com/profile/api-tokens"
                      target="_blank"
                      rel="noreferrer"
                    >
                      创建 Token <ArrowUpRight size={15} />
                    </a>
                  </article>
                </div>

                <section className="target-picker" aria-labelledby="connection-fields-title">
                  <div>
                    <p className="eyebrow">连接信息</p>
                    <h3 id="connection-fields-title">Cloudflare 与发布目标</h3>
                  </div>
                  <div className="target-picker__fields">
                    <label className="field">
                      <span>Account ID</span>
                      <input
                        value={accountId}
                        onChange={(event) => setAccountId(event.target.value.trim().toLowerCase())}
                        placeholder="32 位 Cloudflare Account ID"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={32}
                      />
                      <small>可在 Cloudflare 账户概览中复制。</small>
                    </label>
                    <label className="field">
                      <span>服务名称</span>
                      <input
                        value={workerName}
                        onChange={(event) => setWorkerName(event.target.value.toLowerCase())}
                        placeholder="uglink-worker"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={63}
                      />
                      <small>同名 Worker 存在时，会提示导入其已发布配置。</small>
                    </label>
                    <label className="field field--wide">
                      <span>API Token</span>
                      <input
                        type="password"
                        value={apiToken}
                        onChange={(event) => setApiToken(event.target.value)}
                        placeholder="粘贴 Cloudflare API Token"
                        autoComplete="new-password"
                        spellCheck={false}
                      />
                      <small>Token 不会写入浏览器存储或日志，只会在服务端加密保存。</small>
                    </label>
                  </div>
                </section>

                <section className="resource-review" aria-labelledby="resource-review-title">
                  <div className="resource-review__heading">
                    <div><p className="eyebrow">Token 权限</p><h3 id="resource-review-title">所需权限</h3></div>
                    <span>限定目标账户</span>
                  </div>
                  <ul>
                    <li><ServerCog size={17} /><span><strong>Workers Scripts Write</strong><small>创建和更新 Worker、Secret 与访问域名</small></span><KeyRound size={15} /></li>
                    <li><Database size={17} /><span><strong>Workers KV Storage Write</strong><small>创建并绑定会话缓存命名空间</small></span><KeyRound size={15} /></li>
                    <li><Route size={17} /><span><strong>账户资源范围</strong><small>只包含上面填写的 Cloudflare 账户</small></span><KeyRound size={15} /></li>
                  </ul>
                </section>

                <div className="security-note">
                  <LockKeyhole size={17} />
                  <p>API Token 通过服务端校验后使用 AES-256-GCM 加密保存；浏览器只接收 HttpOnly 会话标识。</p>
                </div>

                <div className="connect-actions">
                  <span>连接成功后即可进入服务配置</span>
                  <button className="button button--primary" type="submit" disabled={!canConnect || Boolean(busy)}>
                    {busy === 'cloudflare' ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
                    验证并继续
                  </button>
                </div>
              </form>
            )}
            <div className="connect-restore">
              <div><strong>已经有控制台备份？</strong><p>使用备份密码恢复连接和服务配置。</p></div>
              <button className="button button--secondary" type="button" onClick={() => setRestoringBackup(true)}>
                <ArchiveRestore size={15} /> 恢复备份
              </button>
            </div>
          </div>
        </main>
      </div>
      <BackupDialog
        csrfToken={bootstrap.csrfToken}
        mode={restoringBackup ? 'restore' : undefined}
        onClose={() => setRestoringBackup(false)}
        onRestored={() => window.location.reload()}
      />
    </div>
  );
}
