import { DeploymentOverlay } from './DeploymentOverlay';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Circle,
  Cloud,
  Code2,
  Eye,
  EyeOff,
  FileCheck2,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Rocket,
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
  prettyConfig,
  validateUglinkConfig,
  type ValidationCheck,
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

type Section = 'services' | 'server' | 'diagnostics' | 'security';

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
  services: { label: '服务配置', description: '统一服务列表 · NAS 服务 + Cloudflare/服务器通道', group: 'common' },
  server: { label: '线路管理', description: '线路 A（Cloudflare）/ B（服务器）连接配置 · 流量与状态', group: 'common' },
  diagnostics: { label: '故障诊断', description: 'Cloudflare 通道的运行输出、网络日志与操作记录', group: 'cloudflare' },
  security: { label: '权限与安全', description: '切换网关路线、管理凭据与数据安全', group: 'common' }
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

function CheckIcon({ check }: { check: ValidationCheck }) {
  if (check.level === 'pass') return <CheckCircle2 className="check-icon check-icon--pass" size={18} />;
  if (check.level === 'warning') return <TriangleAlert className="check-icon check-icon--warning" size={18} />;
  if (check.level === 'error') return <AlertCircle className="check-icon check-icon--error" size={18} />;
  return <Circle className="check-icon" size={18} />;
}


interface NasConnectionPanelProps {
  config: UglinkConfig;
  onChange: (config: UglinkConfig) => void;
  password: string;
  setPassword: (password: string) => void;
}

function NasConnectionPanel({ config, onChange, password, setPassword }: NasConnectionPanelProps) {
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
    </section>
  );
}

interface InspectorProps {
  validation: ValidationResponse;
  config: UglinkConfig;
}

function Inspector({ validation, config }: InspectorProps) {
  return (
    <aside className="inspector">
      <section className="inspector__section">
        <div className="inspector__heading">
          <div><p className="eyebrow">配置检查</p><h3>检查结果</h3></div>
          <span className={`score-badge${validation.valid ? ' score-badge--ok' : ''}`}>
            {validation.checks.filter((check) => check.level === 'pass').length}/{validation.checks.length}
          </span>
        </div>
        <div className="check-list">
          {validation.checks.map((check) => (
            <div className="check-row" key={check.id}>
              <CheckIcon check={check} />
              <div><strong>{check.label}</strong><p>{check.detail}</p></div>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector__section">
        <details className="config-preview">
          <summary><span><Code2 size={16} /> 待发布配置</span><ChevronRight size={16} /></summary>
          <pre>{prettyConfig(config)}</pre>
        </details>
      </section>
    </aside>
  );
}

interface SecurityPageProps {
  bootstrap: BootstrapResponse;
  config: UglinkConfig;
  resetting: boolean;
  switchingRoute: boolean;
  onReset: () => void;
  onSwitchRoute: (mode: 'cloudflare' | 'server') => void;
  onRestored: (bootstrap: BootstrapResponse) => void;
}

function SecurityPage({
  bootstrap,
  config,
  resetting,
  switchingRoute,
  onReset,
  onSwitchRoute,
  onRestored
}: SecurityPageProps) {
  const accessMode = bootstrap.accessMode;
  const cfConnected = bootstrap.providers.cloudflare.state === 'connected';
  return (
    <div className="section-page">
      <div className="page-heading">
        <div><p className="eyebrow">凭据与路线管理</p><h1>权限与安全</h1><p>切换网关路线、管理连接凭据与加密备份。</p></div>
      </div>
      <div className="security-grid">
        <section className="panel security-card">
          <span className="security-card__icon security-card__icon--blue"><Route size={21} /></span>
          <div>
            <h2>网关路线</h2>
            <p>当前使用 <strong>{accessMode === 'server' ? '自建服务器网关' : 'Cloudflare 网关'}</strong>。两种路线可随时切换，互不干扰。</p>
          </div>
          <div className="route-switch-row">
            <button
              className={`button ${accessMode === 'cloudflare' ? 'button--primary' : 'button--secondary'}`}
              type="button"
              disabled={switchingRoute || accessMode === 'cloudflare'}
              onClick={() => onSwitchRoute('cloudflare')}
            >
              {switchingRoute ? <LoaderCircle className="spin" size={15} /> : <Cloud size={15} />} Cloudflare 网关
            </button>
            <button
              className={`button ${accessMode === 'server' ? 'button--primary' : 'button--secondary'}`}
              type="button"
              disabled={switchingRoute || accessMode === 'server'}
              onClick={() => onSwitchRoute('server')}
            >
              {switchingRoute ? <LoaderCircle className="spin" size={15} /> : <HardDrive size={15} />} 自建服务器网关
            </button>
          </div>
          {accessMode === 'server' && !cfConnected && (
            <p className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
              切换到 Cloudflare 后需要填写 Account ID 与 API Token；凭据只在服务端加密保存。
            </p>
          )}
        </section>
        <section className="panel security-card">
          <span className="security-card__icon security-card__icon--orange"><Cloud size={21} /></span>
          <div>
            <h2>Cloudflare 连接</h2>
            <p>{cfConnected
              ? <>当前 Account ID 尾号 <strong>···{bootstrap.target?.accountIdSuffix}</strong>，用于发布服务并管理访问域名。</>
              : '当前未连接 Cloudflare，无需填写 Token 即可使用自建服务器网关。'}</p>
          </div>
          <ProviderBadge status={bootstrap.providers.cloudflare} full />
          <div className="security-card__actions">
            <button className="button button--secondary" type="button" disabled={resetting || switchingRoute} onClick={onReset}>
              {resetting ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} {cfConnected ? '重新配置 API Token' : '连接 Cloudflare'}
            </button>
          </div>
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
  const [section, setSection] = useState<Section>('services');
  const [config, setConfig] = useState<UglinkConfig>(() => initialConfiguration.config);
  const [savedConfig, setSavedConfig] = useState<UglinkConfig>(() => initialConfiguration.deployed);
  const [password, setPassword] = useState('');
  const [validation, setValidation] = useState<ValidationResponse>(() => validateUglinkConfig(initialConfiguration.config));
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
  const [busy, setBusy] = useState<'validate' | 'deploy'>();
  const [resettingConnection, setResettingConnection] = useState(false);
  const [switchingRoute, setSwitchingRoute] = useState(false);
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

  const localValidation = useMemo(
    () => validateUglinkConfig(config),
    [config]
  );
  const visibleValidation = validation || localValidation;
  const hasConfigChanges = !configsEqual(config, savedConfig);
  const hasChanges = hasConfigChanges || password.length > 0;
  const server = useServerGateway(bootstrap.csrfToken);
  const unifiedIssues = useMemo(
    () => validateUnifiedServices(config, server.mappings),
    [config, server.mappings]
  );
  const serverBlocked = unifiedIssues.serverChannelErrors.size > 0 || unifiedIssues.groupErrors.size > 0;
  const cfBlocked = !localValidation.valid || unifiedIssues.cfChannelErrors.size > 0;

  const changeConfig = (nextConfig: UglinkConfig) => {
    setConfig(nextConfig);
    setValidation(validateUglinkConfig(nextConfig));
  };

  const validate = async (): Promise<ValidationResponse | undefined> => {
    setBusy('validate');
    setNotice(undefined);
    try {
      const result = await apiPost<ValidationResponse>('/api/validate', bootstrap.csrfToken, { config });
      setValidation(result);
      setNotice({
        type: result.valid ? 'success' : 'error',
        message: result.valid ? '配置已通过服务器校验。' : '配置仍有需要修正的项目。'
      });
      return result;
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const deployConfiguration = async (nextConfig: UglinkConfig, mode: DeploymentMode) => {
    if (busy === 'deploy' || showDeploymentOverlay) return;
    if (mode === 'publish' && !hasChanges) return;
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
      setValidation(checked);
      if (!checked.valid) {
        setDeploymentError('配置检查未通过，尚未发布任何修改。');
        setNotice({ type: 'error', message: '配置检查未通过，尚未发布任何修改。' });
        return;
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
      } else {
        if (mode === 'publish') {
          if (!configsEqual(nextConfig, savedConfig)) skipNextPublishedHealthCheck.current = true;
          setSavedConfig(nextConfig);
          setPassword('');
        }
        setNotice({ type: 'success', message: mode === 'overwrite' ? '覆盖部署已开始。' : '发布已开始。' });
      }
    } catch (error) {
      setDeploymentError(`无法确认部署结果：${errorMessage(error)}。请检查诊断后再操作。`);
      setNotice({ type: 'error', message: errorMessage(error) });
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
    setValidation(validateUglinkConfig(savedConfig));
    setNotice({ type: 'success', message: '未发布的本地修改已撤销。' });
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

  const switchRoute = async (mode: 'cloudflare' | 'server') => {
    if (mode === accessMode || switchingRoute) return;
    if (mode === 'cloudflare' && !target) {
      const confirmed = window.confirm('切换到 Cloudflare 网关需要填写 Account ID 与 API Token，是否继续？');
      if (!confirmed) return;
    }
    setSwitchingRoute(true);
    setNotice(undefined);
    try {
      await apiPost<BootstrapResponse>('/api/connections/mode', bootstrap.csrfToken, { accessMode: mode });
      onConnectionReset();
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      setSwitchingRoute(false);
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
      setValidation(validateUglinkConfig(snapshot.draft || snapshot.deployed));
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
    { id: 'services', icon: ServerCog },
    { id: 'server', icon: HardDrive },
    { id: 'diagnostics', icon: TriangleAlert },
    { id: 'security', icon: ShieldCheck }
  ];
  // In server-only mode hide the Cloudflare-dependent panels so a self-hosted
  // user never sees empty/broken CF screens. The unified service list, route
  // management and security always remain.
  const navItems = isServerMode
    ? allNavItems.filter((item) => item.id === 'services' || item.id === 'server' || item.id === 'security')
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
            : <><span>自建路线</span><ChevronRight size={14} /><strong>服务器网关</strong></>}
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
              : <><div><span className="health-dot health-dot--ok" /><strong>自建服务器网关</strong></div><small>IP:端口直连 · 无需域名</small></>}
          </div>
        </aside>

        <main className={`app-main${section === 'services' ? ' app-main--editor' : ''}`}>
          {section === 'services' ? (
            <>
              <div className="editor-main">
                <div className="page-heading page-heading--compact">
                  <div>
                    <p className="eyebrow">统一服务列表</p>
                    <h1>服务配置</h1>
                    <p>一行一个 NAS 服务；展开后管理它的 Cloudflare（A）与服务器（B）访问通道。修改先进草稿，保存时分别发布。</p>
                  </div>
                  <span className={`dirty-state${hasChanges || server.dirty ? ' dirty-state--changed' : ''}`}>
                    <span />{hasChanges || server.dirty ? '有未保存修改' : '当前无修改'}
                  </span>
                </div>
                {target && (
                  <NasConnectionPanel
                    config={config}
                    onChange={changeConfig}
                    password={password}
                    setPassword={setPassword}
                  />
                )}
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
              </div>
              {target && <Inspector validation={visibleValidation} config={config} />}
            </>
          ) : section === 'server' ? (
            <RouteManagerPanel
              csrfToken={bootstrap.csrfToken}
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
              switchingRoute={switchingRoute}
              onReset={() => void resetConnection()}
              onSwitchRoute={(mode) => void switchRoute(mode)}
              onRestored={() => window.location.reload()}
            />
          ) : null}
        </main>
      </div>

      {section === 'services' && (
        <footer className="action-bar">
          <div className="action-bar__status">
            {visibleValidation.valid && !unifiedIssues.hasErrors ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span><strong>{visibleValidation.valid && !unifiedIssues.hasErrors ? '配置可以保存' : '配置需要修正'}</strong><small>{hasChanges || server.dirty ? 'A 路线发布到 Cloudflare，B 路线同步到服务器' : '当前没有待保存修改'}</small></span>
          </div>
          <div className="action-bar__buttons">
            {target && (
              <>
                <button className="button button--ghost" type="button" onClick={reset} disabled={!hasChanges || Boolean(busy)}><RefreshCw size={15} /> 撤销</button>
                <button className="button button--secondary" type="button" onClick={() => void validate()} disabled={Boolean(busy)}>
                  {busy === 'validate' ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />} 检查配置
                </button>
                <button className="button button--primary" type="button" onClick={() => void deployConfiguration(config, 'publish')} disabled={!hasChanges || cfBlocked || Boolean(busy)}>
                  {busy === 'deploy' ? <LoaderCircle className="spin" size={16} /> : <Rocket size={16} />} 发布更改 · CF
                </button>
              </>
            )}
            <button
              className={target ? 'button button--secondary' : 'button button--primary'}
              type="button"
              onClick={() => void server.push()}
              disabled={!server.connected || !server.dirty || serverBlocked || server.busy === 'push'}
              title={serverBlocked ? '列表存在待修正项，修正后才能同步' : !server.connected ? '请先到线路管理配置线路 B' : undefined}
            >
              {server.busy === 'push' ? <LoaderCircle className="spin" size={16} /> : <HardDrive size={16} />} 同步到服务器
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
