import { DeploymentOverlay } from './DeploymentOverlay';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Eye,
  EyeOff,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Route,
  ServerCog,
  ShieldCheck,
  TriangleAlert,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost, ConsoleApiError } from '../lib/api';
import type {
  BootstrapResponse,
  PersistedConfigurationState
} from '../../../application/console/contracts';
import { defaultConfig } from '../../../domain/configuration/defaults';
import {
  servicesRequiringSynchronization
} from '../../../domain/configuration/change-set';
import type { UglinkConfig } from '../../../domain/configuration/model';
import {
  configsEqual,
  validateUglinkConfig,
  type ValidationResponse
} from '../../../domain/configuration/validation';
import type {
  DeploymentJob,
  DeploymentMode,
  DiagnosticLogResponse,
  ServiceHealthResponse
} from '../../../domain/deployment/model';
import { Brand } from './Brand';
import { DiagnosticsPage } from './DiagnosticsPage';
import { DataManagement } from './DataManagement';
import { RouteManagerPanel } from './ServerGatewayPanel';
import { ProviderBadge } from './ProviderBadge';
import { UnifiedServiceList, validateUnifiedServices } from './UnifiedServiceList';
import { useServerGateway } from '../lib/use-server-gateway';

type Section = 'services' | 'access' | 'server' | 'diagnostics' | 'security';

interface DashboardProps {
  bootstrap: BootstrapResponse;
  onConnectionReset: () => void;
}

interface CloudConfigurationDialogProps {
  workerName: string;
  serviceCount: number;
  busy?: 'import' | 'dismiss';
  error?: string;
  onImport: () => void;
  onDismiss: () => void;
}

const SECTION_COPY: Record<Section, { label: string; description: string; group: 'cloudflare' | 'server' | 'common' }> = {
  access: { label: '服务与访问', description: '一个服务一个框 · 框里列出所有访问记录', group: 'common' },
  services: { label: 'NAS 连接', description: 'UGREENlink ID · 登录凭据 · 验证连接', group: 'common' },
  server: { label: '线路管理', description: 'Cloudflare 与自建服务的连接配置 · 流量与状态', group: 'common' },
  diagnostics: { label: '故障诊断', description: 'Cloudflare 路线的运行输出、网络日志与操作记录', group: 'cloudflare' },
  security: { label: '权限与安全', description: 'Cloudflare 凭据 · 本地配置备份', group: 'common' }
};

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    return error.detail ? `${error.message}（${error.detail}）` : error.message;
  }
  return error instanceof Error ? error.message : '发生了未知错误。';
}

function CloudConfigurationDialog({
  workerName,
  serviceCount,
  busy,
  error,
  onImport,
  onDismiss
}: CloudConfigurationDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-config-dialog-title">
        <div className="dialog__heading dialog__heading--decision">
          <span className="security-card__icon security-card__icon--orange"><Cloud size={21} /></span>
          <div>
            <h2 id="cloud-config-dialog-title">检测到已有配置</h2>
            <p>Cloudflare 中的 {workerName} 保存了已发布配置，是否导入当前控制台？</p>
          </div>
        </div>
        <div className="dialog__form">
          <div className="cloud-config-summary">
            <Cloud size={19} />
            <div><strong>{serviceCount} 个已发布服务</strong><p>导入后将替换当前已发布配置和本地草稿。</p></div>
          </div>
          <p className="dialog__note">API Token 和 NAS 密码不会从云端配置读取。</p>
          {error && <p className="form-error">{error}</p>}
          <div className="dialog__actions">
            <button className="button button--secondary" type="button" onClick={onDismiss} disabled={Boolean(busy)}>
              {busy === 'dismiss' && <LoaderCircle className="spin" size={16} />} 暂不导入
            </button>
            <button className="button button--primary" type="button" onClick={onImport} disabled={Boolean(busy)}>
              {busy === 'import' ? <LoaderCircle className="spin" size={16} /> : <Cloud size={16} />} 导入配置
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

interface NasVerificationResult {
  kind: 'success' | 'error';
  message: string;
}

interface NasConnectionPanelProps {
  config: UglinkConfig;
  onChange: (config: UglinkConfig) => void;
  password: string;
  setPassword: (password: string) => void;
  verifying: boolean;
  verification?: NasVerificationResult;
  onVerify: () => void;
}

function NasConnectionPanel({
  config,
  onChange,
  password,
  setPassword,
  verifying,
  verification,
  onVerify
}: NasConnectionPanelProps) {
  const [passwordVisible, setPasswordVisible] = useState(false);
  return (
    <section className="panel config-panel">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">NAS 连接</p>
          <h2>NAS 连接信息</h2>
          <p>用于连接绿联云中的 NAS 服务（两条路线共用同一台 NAS）。</p>
        </div>
        <span className="panel__meta"><LockKeyhole size={15} /> 密码不会保存在本机</span>
      </div>
      <div className="form-grid">
        <label className="field field--wide">
          <span>UGREENlink ID <em>UGLINK_ID</em></span>
          <input
            value={config.uglink.id}
            onChange={(event) => onChange({
              ...config,
              uglink: { ...config.uglink, id: event.target.value }
            })}
            placeholder="例如 northedge"
            autoComplete="off"
          />
          <small>即 https://ug.link/ 后的设备 ID；运行时会自动发现当前中继地址。</small>
        </label>
        <label className="field">
          <span>登录用户名 <em>USERNAME</em></span>
          <input
            value={config.uglink.username}
            onChange={(event) => onChange({
              ...config,
              uglink: { ...config.uglink, username: event.target.value }
            })}
            placeholder="NAS 登录用户名"
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span>登录密码 <em>PASSWORD</em></span>
          <div className="password-field">
            <input
              id="nas-password"
              type={passwordVisible ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="首次发布时填写"
              autoComplete="new-password"
            />
            <button
              className="password-field__toggle"
              type="button"
              aria-label={passwordVisible ? '隐藏密码' : '显示密码'}
              aria-pressed={passwordVisible}
              aria-controls="nas-password"
              title={passwordVisible ? '隐藏密码' : '显示密码'}
              onClick={(event) => {
                event.preventDefault();
                setPasswordVisible((visible) => !visible);
              }}
            >
              {passwordVisible
                ? <EyeOff size={17} aria-hidden="true" />
                : <Eye size={17} aria-hidden="true" />}
            </button>
          </div>
          <small>首次发布时必填；以后留空则保留当前密码。</small>
        </label>
      </div>
      <div className="nas-verify">
        <button className="button button--primary" type="button" disabled={verifying} onClick={onVerify}>
          {verifying ? <LoaderCircle className="spin" size={16} /> : null} ✔ 验证连接
        </button>
        <span className="muted nas-verify__note">
          验证会用上面的凭据登录一次绿联 NAS；因绿联有登录保护，请勿频繁点击（每次约间隔 5 分钟）。
        </span>
      </div>
      {verification && (
        <div className={`verify-result verify-result--${verification.kind}`} role="status">
          <span className="verify-result__icon">{verification.kind === 'success' ? '✓' : '!'}</span>
          <div>
            <strong>{verification.kind === 'success' ? '连接成功' : '连接失败'}</strong>
            <p>{verification.message}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function SetupGuide({ onConfigureRoute, onConnectNas }: { onConfigureRoute: () => void; onConnectNas: () => void }) {
  return (
    <section className="panel setup-guide">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">首次配置引导</p>
          <h2>先完成下面两步，再回来添加服务</h2>
          <p>顺序是：配置访问路线 → 连接绿联 NAS → 添加服务。第 2 步不依赖第 1 步。</p>
        </div>
      </div>
      <div className="setup-guide__steps">
        <div className="setup-step">
          <span className="setup-step__num">1</span>
          <div className="setup-step__txt">
            <strong>配置访问路线</strong>
            <p>选择通过 Cloudflare、自建服务，或两者都配置。服务最终走哪条线取决于这里。</p>
          </div>
          <button className="button button--secondary button--compact" type="button" onClick={onConfigureRoute}>前往「线路管理」</button>
        </div>
        <div className="setup-step">
          <span className="setup-step__num">2</span>
          <div className="setup-step__txt">
            <strong>连接绿联 NAS</strong>
            <p>填写 UGREENlink ID 与登录账号，可用「验证连接」确认凭据有效。此步只连绿联官方接口，不依赖第 1 步。</p>
          </div>
          <button className="button button--secondary button--compact" type="button" onClick={onConnectNas}>前往「NAS 连接」</button>
        </div>
        <div className="setup-step is-locked">
          <span className="setup-step__num">3</span>
          <div className="setup-step__txt">
            <strong>添加服务</strong>
            <p>上面两步完成后，这里会变成正常的服务列表，点「添加记录」即可。</p>
          </div>
          <span className="setup-step__lock">🔒 待前两步完成</span>
        </div>
      </div>
    </section>
  );
}

interface SecurityPageProps {
  bootstrap: BootstrapResponse;
  config: UglinkConfig;
  resetting: boolean;
  onReset: () => void;
  onRestored: (bootstrap: BootstrapResponse) => void;
}

function SecurityPage({ bootstrap, config, resetting, onReset, onRestored }: SecurityPageProps) {
  const cfConnected = bootstrap.providers.cloudflare.state === 'connected';
  return (
    <div className="section-page">
      <div className="page-heading">
        <div><p className="eyebrow">凭据与数据</p><h1>权限与安全</h1><p>管理 Cloudflare 凭据与本地配置的加密备份。</p></div>
      </div>
      <div className="security-grid">
        <section className="panel security-card">
          <span className="security-card__icon security-card__icon--orange"><Cloud size={21} /></span>
          <div>
            <h2>Cloudflare 连接</h2>
            <p>{cfConnected
              ? <>当前 Account ID 尾号 <strong>···{bootstrap.target?.accountIdSuffix}</strong>，用于发布走 Cloudflare 路线的服务并管理访问域名。</>
              : '当前未连接 Cloudflare，可随时连接后发布走 Cloudflare 路线的服务。'}</p>
          </div>
          <ProviderBadge status={bootstrap.providers.cloudflare} full />
          <div className="security-card__actions">
            {cfConnected ? (
              <button className="button button--ghost" type="button" disabled={resetting} onClick={onReset}>
                {resetting ? <LoaderCircle className="spin" size={15} /> : <Cloud size={15} />} 断开 Cloudflare
              </button>
            ) : (
              <button className="button button--secondary" type="button" disabled={resetting} onClick={onReset}>
                {resetting ? <LoaderCircle className="spin" size={15} /> : <Cloud size={15} />} 连接 Cloudflare
              </button>
            )}
          </div>
          {cfConnected && (
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              Token 只在服务端加密保存。需要更换凭据请到「线路管理」点重新配置，这里只做断开。
            </p>
          )}
        </section>
        <DataManagement
          csrfToken={bootstrap.csrfToken}
          config={config}
          onRestored={onRestored}
        />
      </div>
    </div>
  );
}

export function Dashboard({ bootstrap, onConnectionReset }: DashboardProps) {
  const accessMode = bootstrap.accessMode;
  const isServerMode = accessMode === 'server';
  const target = bootstrap.target;
  const initialConfiguration = useMemo(() => {
    const deployed = bootstrap.configuration?.deployed || defaultConfig();
    return {
      deployed,
      config: bootstrap.configuration?.draft || deployed
    };
  }, [bootstrap.configuration]);
  const initialHasPublishedServices = initialConfiguration.deployed.services.some((service) => service.enabled !== false);
  const [section, setSection] = useState<Section>('access');
  const [config, setConfig] = useState<UglinkConfig>(() => initialConfiguration.config);
  const [savedConfig, setSavedConfig] = useState<UglinkConfig>(() => initialConfiguration.deployed);
  const [password, setPassword] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<NasVerificationResult>();
  const [saving, setSaving] = useState(false);
  const [job, setJob] = useState<DeploymentJob>();
  const [showDeploymentOverlay, setShowDeploymentOverlay] = useState(false);
  const [deploymentError, setDeploymentError] = useState<string>();
  const closeDeploymentOverlay = useCallback(() => setShowDeploymentOverlay(false), []);
  const [deploymentConfig, setDeploymentConfig] = useState<UglinkConfig>();
  const [deploymentServiceHostnames, setDeploymentServiceHostnames] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [publishedHealth, setPublishedHealth] = useState<ServiceHealthResponse>();
  const [checkingHealth, setCheckingHealth] = useState(initialHasPublishedServices);
  const [healthCheckError, setHealthCheckError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticLogResponse>({ entries: [] });
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string>();
  const [focusedHostname, setFocusedHostname] = useState<string>();
  const [busy, setBusy] = useState<'deploy'>();
  const [resettingConnection, setResettingConnection] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string }>();
  const [cloudConfiguration, setCloudConfiguration] = useState(bootstrap.cloudConfiguration);
  const [cloudConfigurationBusy, setCloudConfigurationBusy] = useState<'import' | 'dismiss'>();
  const [cloudConfigurationError, setCloudConfigurationError] = useState<string>();
  const healthRequestVersion = useRef(0);
  const skipNextPublishedHealthCheck = useRef(false);
  const autosaveReady = useRef(false);
  const autosaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const hasPublishedServices = savedConfig.services.some((service) => service.enabled !== false);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [section]);

  useEffect(() => {
    if (isServerMode) return undefined;
    if (!autosaveReady.current) {
      autosaveReady.current = true;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      autosaveQueue.current = autosaveQueue.current
        .catch(() => undefined)
        .then(() => apiPost<PersistedConfigurationState>(
          '/api/configuration/draft',
          bootstrap.csrfToken,
          { config }
        ))
        .catch((error) => setNotice({
          type: 'error',
          message: `配置自动保存失败：${errorMessage(error)}`
        }));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [bootstrap.csrfToken, config]);

  const loadDiagnostics = useCallback(async (showLoading = true) => {
    if (showLoading) setDiagnosticsLoading(true);
    setDiagnosticsError(undefined);
    try {
      setDiagnostics(await apiGet<DiagnosticLogResponse>('/api/diagnostics'));
    } catch (error) {
      setDiagnosticsError(errorMessage(error));
    } finally {
      if (showLoading) setDiagnosticsLoading(false);
    }
  }, []);

  const refreshDiagnostics = useCallback(() => loadDiagnostics(false), [loadDiagnostics]);

  const checkServices = useCallback(async (publishedConfig: UglinkConfig) => {
    const requestVersion = ++healthRequestVersion.current;
    setCheckingHealth(true);
    setHealthCheckError(undefined);
    try {
      const health = await apiPost<ServiceHealthResponse>('/api/services/health', bootstrap.csrfToken, {
        config: publishedConfig
      });
      if (healthRequestVersion.current === requestVersion) setPublishedHealth(health);
      return health;
    } catch (error) {
      if (healthRequestVersion.current === requestVersion) setHealthCheckError(errorMessage(error));
      return undefined;
    } finally {
      if (healthRequestVersion.current === requestVersion) setCheckingHealth(false);
      void loadDiagnostics(false);
    }
  }, [bootstrap.csrfToken, loadDiagnostics]);

  useEffect(() => {
    if (isServerMode) return;
    if (skipNextPublishedHealthCheck.current) {
      skipNextPublishedHealthCheck.current = false;
      setCheckingHealth(false);
      return;
    }
    if (!hasPublishedServices) {
      setCheckingHealth(false);
      return;
    }
    void checkServices(savedConfig);
  }, [checkServices, hasPublishedServices, savedConfig, isServerMode]);

  useEffect(() => {
    if (section === 'diagnostics') void loadDiagnostics();
  }, [loadDiagnostics, section]);

  useEffect(() => {
    if (!job || job.phase === 'healthy' || job.phase === 'failed') return undefined;
    let active = true;
    const timer = window.setTimeout(() => {
      void apiGet<DeploymentJob>(`/api/deployments/${job.id}`)
        .then((nextJob) => active && setJob(nextJob))
        .catch((error) => {
          if (!active) return;
          const message = `无法确认部署结果：${errorMessage(error)}。请检查诊断或刷新页面确认状态。`;
          setNotice({ type: 'error', message });
          if (job.mode === 'overwrite') setDeploymentError(message);
        });
    }, 2_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [job]);

  useEffect(() => {
    if (!job) return;
    setPublishedHealth((current) => {
      const previousByHostname = new Map(
        (current?.services || []).map((service) => [service.hostname.toLowerCase(), service])
      );
      const deploymentByHostname = new Map(
        job.services.map((service) => [service.hostname.toLowerCase(), service])
      );
      const activeServices = (deploymentConfig?.services || [])
        .filter((service) => service.enabled !== false);
      return {
        checkedAt: job.updatedAt,
        services: activeServices.flatMap((service) => {
          const hostname = service.hostname.trim().toLowerCase();
          const result = deploymentByHostname.get(hostname) || previousByHostname.get(hostname);
          return result ? [result] : [];
        })
      };
    });
    if (job.phase === 'healthy' || job.phase === 'failed') void loadDiagnostics(false);
  }, [deploymentConfig, job, loadDiagnostics]);

  const visibleValidation = useMemo(() => {
    const result = validateUglinkConfig(config);
    if (target) return result;
    // Server-only mode: nothing gets published to Cloudflare, and the gateway
    // keeps its own NAS credentials, so missing console-side UGREENlink
    // credentials (their panel is hidden here) must not block saving mappings.
    const blocking = result.checks.filter((check) => check.level === 'error' && check.id !== 'uglink-id' && check.id !== 'username');
    return { valid: blocking.length === 0, checks: result.checks };
  }, [config, target]);
  const hasConfigChanges = !configsEqual(config, savedConfig);
  const hasChanges = hasConfigChanges || password.length > 0;
  const server = useServerGateway(bootstrap.csrfToken);
  const unifiedIssues = useMemo(
    () => validateUnifiedServices(config, server.mappings),
    [config, server.mappings]
  );
  const serverBlocked = unifiedIssues.serverChannelErrors.size > 0 || unifiedIssues.groupErrors.size > 0;
  const showSetupGuide = !hasPublishedServices && !target && !server.connected;

  const changeConfig = (nextConfig: UglinkConfig) => {
    setConfig(nextConfig);
  };

  const verifyNas = async () => {
    const id = config.uglink.id.trim();
    const username = config.uglink.username.trim();
    if (!id || !username) {
      setVerification({ kind: 'error', message: '请先填写 UGREENlink ID 和登录用户名。' });
      return;
    }
    if (!password.trim()) {
      setVerification({ kind: 'error', message: '需要先填密码才能验证连接。' });
      return;
    }
    setVerifying(true);
    setVerification(undefined);
    try {
      await apiPost<{ ok: true }>('/api/nas/verify', bootstrap.csrfToken, { id, username, password });
      setVerification({ kind: 'success', message: '连接成功，已用该账号完成绿联登录握手，凭据有效。' });
    } catch (error) {
      setVerification({ kind: 'error', message: errorMessage(error) });
    } finally {
      setVerifying(false);
    }
  };

  const deployConfiguration = async (nextConfig: UglinkConfig, mode: DeploymentMode): Promise<boolean> => {
    if (busy === 'deploy' || showDeploymentOverlay) return false;
    if (mode === 'publish' && !hasChanges) return true;
    setDeploymentError(undefined);
    if (mode === 'overwrite') setShowDeploymentOverlay(true);
    healthRequestVersion.current += 1;
    setCheckingHealth(false);
    setHealthCheckError(undefined);
    setBusy('deploy');
    setJob(undefined);
    setDeploymentConfig(nextConfig);
    setDeploymentServiceHostnames(new Set(
      servicesRequiringSynchronization(savedConfig, nextConfig, {
        forceAll: mode === 'overwrite' || password.length > 0
      }).map((service) => service.hostname.trim().toLowerCase())
    ));
    setNotice(undefined);
    try {
      const checked = await apiPost<ValidationResponse>('/api/validate', bootstrap.csrfToken, { config: nextConfig });
      if (!checked.valid) {
        setDeploymentError('配置检查未通过，尚未发布任何修改。');
        setNotice({ type: 'error', message: '配置检查未通过，尚未发布任何修改。' });
        return false;
      }
      const created = await apiPost<DeploymentJob>('/api/deploy', bootstrap.csrfToken, {
        config: nextConfig,
        mode,
        ...(mode === 'publish' && password ? { password } : {})
      });
      setDeploymentServiceHostnames(new Set(
        created.services.map((service) => service.hostname.trim().toLowerCase())
      ));
      setJob(created);
      void loadDiagnostics(false);
      if (created.phase === 'failed') {
        setNotice({ type: 'error', message: created.message });
        return false;
      }
      if (mode === 'publish') {
        if (!configsEqual(nextConfig, savedConfig)) skipNextPublishedHealthCheck.current = true;
        setSavedConfig(nextConfig);
        setPassword('');
      }
      return true;
    } catch (error) {
      setDeploymentError(`无法确认部署结果：${errorMessage(error)}。请检查诊断后再操作。`);
      setNotice({ type: 'error', message: errorMessage(error) });
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const inspectService = (hostname: string) => {
    setFocusedHostname(hostname);
    setSection('diagnostics');
  };

  const redeploy = () => {
    const confirmed = window.confirm('将使用当前已发布配置覆盖现有受管 Worker。是否继续？');
    if (confirmed) void deployConfiguration(savedConfig, 'overwrite');
  };

  const reset = () => {
    setConfig(savedConfig);
    setPassword('');
    server.resetMappings();
    setNotice({ type: 'success', message: '未发布的本地修改已撤销。' });
  };

  const saveAll = async () => {
    if (saving || busy || server.busy === 'push') return;
    if (unifiedIssues.hasErrors || !visibleValidation.valid) {
      setNotice({ type: 'error', message: '配置需要修正，暂不能保存。' });
      return;
    }
    setSaving(true);
    let saved = true;
    try {
      if (target && hasChanges) saved = await deployConfiguration(config, 'publish');
      if (saved && server.dirty) {
        if (!server.connected || serverBlocked) {
          setNotice({ type: 'error', message: '自建服务线路未就绪或存在待修正项，暂不能同步。' });
          saved = false;
        } else {
          saved = await server.push();
          // Surface the gateway's rejection reason here too — the detailed
          // message otherwise only appears on the route manager page.
          if (!saved && server.message?.kind === 'bad') {
            setNotice({ type: 'error', message: server.message.text });
          }
        }
      }
      if (saved) setNotice({ type: 'success', message: '已保存' });
    } finally {
      setSaving(false);
    }
  };

  const lockConsole = async () => {
    try {
      await apiPost<{ status: string }>('/api/auth/logout', bootstrap.csrfToken);
    } catch {
      // Even if the request fails, reloading re-reads auth state from server.
    }
  };

  const resetConnection = async () => {
    setResettingConnection(true);
    setNotice(undefined);
    try {
      await apiPost<{ ok: true }>('/api/connections/cloudflare/reset', bootstrap.csrfToken);
      onConnectionReset();
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      setResettingConnection(false);
    }
  };

  const importCloudConfiguration = async () => {
    setCloudConfigurationBusy('import');
    setCloudConfigurationError(undefined);
    try {
      const imported = await apiPost<BootstrapResponse>(
        '/api/configuration/cloud/import',
        bootstrap.csrfToken
      );
      const snapshot = imported.configuration;
      if (!snapshot) throw new Error('Cloudflare 配置导入后没有返回配置。');
      setSavedConfig(snapshot.deployed);
      setConfig(snapshot.draft || snapshot.deployed);
      setCloudConfiguration(undefined);
      setNotice({ type: 'success', message: 'Cloudflare 已发布配置已导入。' });
    } catch (error) {
      setCloudConfigurationError(errorMessage(error));
    } finally {
      setCloudConfigurationBusy(undefined);
    }
  };

  const dismissCloudConfiguration = async () => {
    setCloudConfigurationBusy('dismiss');
    setCloudConfigurationError(undefined);
    try {
      await apiPost<{ ok: true }>('/api/configuration/cloud/dismiss', bootstrap.csrfToken);
      setCloudConfiguration(undefined);
      setNotice({ type: 'success', message: '已保留当前控制台配置。' });
    } catch (error) {
      setCloudConfigurationError(errorMessage(error));
    } finally {
      setCloudConfigurationBusy(undefined);
    }
  };

  const allNavItems: Array<{ id: Section; icon: typeof ServerCog }> = [
    { id: 'access', icon: ServerCog },
    { id: 'services', icon: HardDrive },
    { id: 'server', icon: Route },
    { id: 'diagnostics', icon: TriangleAlert },
    { id: 'security', icon: ShieldCheck }
  ];
  // In server-only mode hide the Cloudflare-dependent panels so a self-hosted
  // user never sees empty/broken CF screens. The unified service list, route
  // management and security always remain.
  const navItems = isServerMode
    ? allNavItems.filter((item) => item.id === 'access' || item.id === 'server' || item.id === 'security')
    : allNavItems;
  const currentErrorCount = (publishedHealth?.services.filter((service) => !service.healthy).length || 0)
    + (healthCheckError ? 1 : 0);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Brand compact />
        <div className="app-header__context">
          {target
            ? <><span>{target.accountName}</span><ChevronRight size={14} /><strong>{target.workerName}</strong></>
            : <><span>自建服务</span><ChevronRight size={14} /><strong>网关</strong></>}
        </div>
        <div className="app-header__providers">
          <ProviderBadge status={bootstrap.providers.cloudflare} />
        </div>
      </header>

      <nav className="mobile-section-nav" aria-label="控制台分区">
        {navItems.map(({ id }) => (
          <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
            {SECTION_COPY[id].label}
            {id === 'diagnostics' && currentErrorCount > 0 && <em className="nav-alert-count">{currentErrorCount}</em>}
          </button>
        ))}
      </nav>

      <div className="app-layout">
        <aside className="app-sidebar">
          <nav aria-label="控制台导航">
            {navItems.map(({ id, icon: Icon }) => (
              <button key={id} type="button" className={section === id ? 'is-active' : ''} onClick={() => setSection(id)}>
                <Icon size={18} />
                <span>{SECTION_COPY[id].label}{id === 'diagnostics' && currentErrorCount > 0 && <em className="nav-alert-count">{currentErrorCount}</em>}</span>
                {section === id && <ChevronRight size={15} />}
              </button>
            ))}
          </nav>
          <div className="sidebar-target">
            <p className="eyebrow">{target ? '发布目标' : '当前路线'}</p>
            {target
              ? <><div><span className="health-dot health-dot--ok" /><strong>{target.workerName}</strong></div><small>Account ID ···{target.accountIdSuffix}</small></>
              : <><div><span className="health-dot health-dot--ok" /><strong>自建服务网关</strong></div><small>IP:端口直连 · 无需域名</small></>}
          </div>
          <button
            className="sidebar-lock"
            type="button"
            title="锁定控制台（下次打开需重新输入访问密码）"
            onClick={() => void lockConsole().then(() => window.location.reload())}
          >
            <LockKeyhole size={14} /> 锁定控制台
          </button>
        </aside>

        <main className="app-main">
          {section === 'access' ? (
            <div className="section-page">
              <div className="page-heading page-heading--compact">
                <div>
                  <p className="eyebrow">统一服务列表</p>
                  <h1>服务与访问</h1>
                  <p>每个服务一个框，框里列出它的所有访问记录；编辑后点底部「保存更改」统一发布。</p>
                </div>
                <span className={`dirty-state${hasChanges || server.dirty ? ' dirty-state--changed' : ''}`}>
                  <span />{hasChanges || server.dirty ? '有未保存修改' : '已保存'}
                </span>
              </div>
              {showSetupGuide ? (
                <SetupGuide
                  onConfigureRoute={() => setSection('server')}
                  onConnectNas={() => setSection('services')}
                />
              ) : (
                <UnifiedServiceList
                  config={config}
                  onConfigChange={changeConfig}
                  server={server}
                  cfEnabled={Boolean(target)}
                  deployedConfig={savedConfig}
                  deploymentConfig={deploymentConfig}
                  deploymentServiceHostnames={deploymentServiceHostnames}
                  job={job}
                  publishedHealth={publishedHealth}
                  deploying={busy === 'deploy'}
                  checkingHealth={checkingHealth}
                  healthCheckError={healthCheckError}
                  onInspectService={inspectService}
                />
              )}
            </div>
          ) : section === 'services' ? (
            <div className="section-page">
              <div className="page-heading">
                <div>
                  <p className="eyebrow">NAS 连接</p>
                  <h1>NAS 连接信息</h1>
                  <p>用于连接绿联云中的 NAS 服务（两条访问路线共用同一台 NAS）。</p>
                </div>
              </div>
              <NasConnectionPanel
                config={config}
                onChange={changeConfig}
                password={password}
                setPassword={setPassword}
                verifying={verifying}
                verification={verification}
                onVerify={() => void verifyNas()}
              />
            </div>
          ) : section === 'server' ? (
            <RouteManagerPanel
              server={server}
              cfStatus={bootstrap.providers.cloudflare}
              cfConnected={Boolean(target)}
              onConfigureCf={() => setSection('security')}
            />
          ) : section === 'diagnostics' ? (
            <DiagnosticsPage
              csrfToken={bootstrap.csrfToken}
              entries={diagnostics.entries}
              health={publishedHealth}
              healthError={healthCheckError}
              diagnosticsError={diagnosticsError}
              focusedHostname={focusedHostname}
              loading={diagnosticsLoading}
              checking={checkingHealth}
              deploying={busy === 'deploy'}
              canCheck={hasPublishedServices}
              job={job}
              onClearFocus={() => setFocusedHostname(undefined)}
              onCheck={() => void checkServices(savedConfig)}
              onRefresh={refreshDiagnostics}
              onRedeploy={redeploy}
            />
          ) : section === 'security' ? (
            <SecurityPage
              bootstrap={bootstrap}
              config={config}
              resetting={resettingConnection}
              onReset={() => void resetConnection()}
              onRestored={() => window.location.reload()}
            />
          ) : null}
        </main>
      </div>

      {section === 'access' && (
        <footer className="action-bar">
          <div className="action-bar__status">
            {visibleValidation.valid && !unifiedIssues.hasErrors ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span>
              <strong>{visibleValidation.valid && !unifiedIssues.hasErrors ? '配置就绪' : '配置需要修正'}</strong>
              <small>点保存后：有改动的记录自动发布到 Cloudflare / 同步到自建服务网关</small>
            </span>
          </div>
          <div className="action-bar__buttons">
            <button
              className="button button--ghost"
              type="button"
              onClick={reset}
              disabled={(!hasChanges && !server.dirty) || saving || Boolean(busy)}
            >↺ 放弃修改</button>
            <button
              className="button button--primary"
              type="button"
              onClick={() => void saveAll()}
              disabled={saving || Boolean(busy) || server.busy === 'push'}
            >
              {saving || busy ? <LoaderCircle className="spin" size={16} /> : null} 💾 保存更改
            </button>
          </div>
        </footer>
      )}

      {cloudConfiguration && (
        <CloudConfigurationDialog
          workerName={target?.workerName ?? 'uglink-worker'}
          serviceCount={cloudConfiguration.serviceCount}
          busy={cloudConfigurationBusy}
          error={cloudConfigurationError}
          onImport={() => void importCloudConfiguration()}
          onDismiss={() => void dismissCloudConfiguration()}
        />
      )}

      {showDeploymentOverlay && <DeploymentOverlay job={job} error={deploymentError} onClose={closeDeploymentOverlay} />}

      {notice && (
        <div
          className={`toast toast--${notice.type}`}
          role="status"
        >
          {notice.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(undefined)} aria-label="关闭提示"><X size={15} /></button>
        </div>
      )}
    </div>
  );
}
