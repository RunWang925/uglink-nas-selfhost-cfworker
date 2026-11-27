import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Cloud,
  ExternalLink,
  HardDrive,
  LoaderCircle,
  Plus,
  Trash2,
  X
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { UglinkConfig, UglinkService } from '../../../domain/configuration/model';
import type { DeploymentJob, ServiceHealthResponse } from '../../../domain/deployment/model';
import { normalizeHostname } from '../../../domain/configuration/validation';
import type { ServerGatewayState, ServerMapping } from '../lib/use-server-gateway';
import { SelectMenu } from './SelectMenu';
import { Toggle } from './Toggle';

const ACCESS_MODE_OPTIONS = [
  { value: 'proxy', label: '代理' },
  { value: 'ticket', label: '票据' }
] as const;

type ServiceStatusTone = 'success' | 'progress' | 'pending' | 'error' | 'neutral';

interface ServiceStatusValue {
  label: string;
  detail: string;
  tone: ServiceStatusTone;
}

function compactFailureLabel(result: ServiceHealthResponse['services'][number]): string {
  const labels: Record<string, string> = {
    invalid_credentials: '密码错误',
    account_locked: '账号锁定',
    login_source_blocked: '登录受限',
    account_blocked: '账号停用',
    password_expired: '密码过期',
    otp_required: '需要验证码',
    authentication_backoff: '登录退避',
    authentication_timeout: '认证超时',
    authentication_unavailable: '认证不可用',
    authentication_failed: '认证失败',
    proxy_session_expired: '会话失效',
    proxy_session_unavailable: '会话异常',
    service_entry_timeout: '入口超时',
    service_entry_unreachable: '入口断开',
    worker_health_invalid_response: '响应异常',
    worker_hostname_unconfigured: '域名未配置'
  };
  if (result.code && labels[result.code]) return labels[result.code]!;
  if (result.httpStatus !== undefined) return `HTTP ${result.httpStatus}`;
  return '异常';
}

function resolveServiceStatus(
  service: UglinkService,
  deployedConfig: UglinkConfig,
  deploymentConfig: UglinkConfig | undefined,
  deploymentServiceHostnames: ReadonlySet<string>,
  deploymentByHostname: Map<string, DeploymentJob['services'][number]>,
  publishedByHostname: Map<string, ServiceHealthResponse['services'][number]>,
  job: DeploymentJob | undefined,
  deploying: boolean,
  checkingHealth: boolean,
  healthCheckError: string | undefined
): ServiceStatusValue {
  const hostname = service.hostname.trim().toLowerCase();
  const matchesDeployed = deployedConfig.services.some((candidate) => (
    candidate.name === service.name
    && candidate.hostname === service.hostname
    && candidate.port === service.port
    && (candidate.enabled ?? true) === (service.enabled ?? true)
    && (candidate.accessMode ?? 'proxy') === (service.accessMode ?? 'proxy')
  ));
  const matchesDeployment = deploymentConfig?.services.some((candidate) => (
    candidate.name === service.name
    && candidate.hostname === service.hostname
    && candidate.port === service.port
  )) === true;
  const synchronizedByDeployment = deploymentServiceHostnames.has(hostname);

  if (deploying && matchesDeployment && synchronizedByDeployment) {
    return { label: '发布中', detail: '正在发布这项服务。', tone: 'progress' };
  }

  if (service.enabled === false && matchesDeployed) {
    return { label: '已停用', detail: '这项服务未启用。', tone: 'neutral' };
  }

  if (checkingHealth && matchesDeployed) {
    return { label: '检查中', detail: '正在重新检查服务入口。', tone: 'progress' };
  }

  if (healthCheckError && matchesDeployed) {
    return { label: '检查失败', detail: healthCheckError, tone: 'error' };
  }

  if (job && matchesDeployment && synchronizedByDeployment) {
    if (service.enabled === false) {
      return { label: '已停用', detail: '这项服务未启用。', tone: 'neutral' };
    }
    const result = deploymentByHostname.get(hostname);
    if (result?.healthy) {
      return { label: '运行正常', detail: result.detail, tone: 'success' };
    }
    if (job.phase === 'failed') {
      return {
        label: result ? compactFailureLabel(result) : '发布失败',
        detail: result?.detail || job.message,
        tone: 'error'
      };
    }
    if (job.phase === 'healthy') {
      const retainedResult = result || publishedByHostname.get(hostname);
      if (retainedResult?.healthy) {
        return { label: '运行正常', detail: retainedResult.detail, tone: 'success' };
      }
      if (retainedResult) {
        return {
          label: compactFailureLabel(retainedResult),
          detail: retainedResult.detail,
          tone: 'error'
        };
      }
      return {
        label: '状态未变',
        detail: '本次发布没有重新检查这项未修改的服务。',
        tone: 'neutral'
      };
    }
    if (job.phase === 'checking') {
      return { label: '生效中', detail: result?.detail || job.message, tone: 'progress' };
    }
    return { label: '发布中', detail: result?.detail || job.message, tone: 'progress' };
  }

  if (!matchesDeployed) {
    return { label: '待发布', detail: '当前修改尚未发布。', tone: 'pending' };
  }
  if (service.enabled === false) {
    return { label: '已停用', detail: '这项服务未启用。', tone: 'neutral' };
  }
  const publishedResult = publishedByHostname.get(hostname);
  if (publishedResult?.healthy) {
    return { label: '运行正常', detail: publishedResult.detail, tone: 'success' };
  }
  return {
    label: publishedResult ? compactFailureLabel(publishedResult) : '检查失败',
    detail: publishedResult?.detail || '服务端没有返回这项服务的检查结果。',
    tone: 'error'
  };
}

function serviceAccessAddress(hostname: string): string | undefined {
  try {
    return `https://${normalizeHostname(hostname)}`;
  } catch {
    return undefined;
  }
}

function StatusChip({ value, onInspect }: { value: ServiceStatusValue; onInspect?: () => void }) {
  const Icon = value.tone === 'success'
    ? CheckCircle2
    : value.tone === 'error'
      ? AlertCircle
      : value.tone === 'progress'
        ? LoaderCircle
        : Circle;
  const content = (
    <>
      <Icon className={value.tone === 'progress' ? 'spin' : undefined} size={14} />
      {value.label}
    </>
  );
  if (value.tone === 'error' && onInspect) {
    return (
      <button
        className={`service-status service-status--${value.tone} service-status--interactive`}
        type="button"
        title={`${value.detail}；点击查看故障详情`}
        aria-label={`${value.label}：${value.detail}。查看故障详情`}
        onClick={onInspect}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={`service-status service-status--${value.tone}`} title={value.detail} aria-label={`${value.label}：${value.detail}`}>
      {content}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Unified service model: one row per NAS service, A/B channels nested inside.
// ---------------------------------------------------------------------------

type Channel =
  | { kind: 'cf'; index: number; service: UglinkService }
  | { kind: 'server'; index: number; mapping: ServerMapping };

interface ServiceGroup {
  key: string;
  name: string;
  nasPort: string;
  channels: Channel[];
}

function nasPortOf(channel: Channel): string {
  if (channel.kind === 'cf') return String(channel.service.port ?? '');
  return channel.mapping.nasPort.trim();
}

function groupServices(config: UglinkConfig, mappings: ServerMapping[]): ServiceGroup[] {
  const groups = new Map<string, ServiceGroup>();
  const ensure = (rawName: string): ServiceGroup => {
    const name = rawName.trim();
    const key = name.toLowerCase() || '(unnamed)';
    let group = groups.get(key);
    if (!group) {
      group = { key, name, nasPort: '', channels: [] };
      groups.set(key, group);
    }
    return group;
  };
  config.services.forEach((service, index) => {
    const group = ensure(service.name);
    group.channels.push({ kind: 'cf', index, service });
  });
  mappings.forEach((mapping, index) => {
    const group = ensure(mapping.name);
    group.channels.push({ kind: 'server', index, mapping });
  });
  for (const group of groups.values()) {
    const cf = group.channels.find((channel) => channel.kind === 'cf');
    const server = group.channels.find((channel) => channel.kind === 'server');
    group.nasPort = cf ? String((cf as { service: UglinkService }).service.port ?? '') : server ? (server as { mapping: ServerMapping }).mapping.nasPort : '';
  }
  return [...groups.values()];
}

export interface UnifiedIssues {
  groupErrors: Map<string, string[]>;
  cfChannelErrors: Map<number, string>;
  serverChannelErrors: Map<number, string>;
  hasErrors: boolean;
}

export function validateUnifiedServices(config: UglinkConfig, mappings: ServerMapping[]): UnifiedIssues {
  const groupErrors = new Map<string, string[]>();
  const cfChannelErrors = new Map<number, string>();
  const serverChannelErrors = new Map<number, string>();
  const fail = (group: ServiceGroup, message: string) => {
    const list = groupErrors.get(group.key) ?? [];
    list.push(message);
    groupErrors.set(group.key, list);
  };
  const portPattern = /^\d{1,5}$/;
  const validPort = (value: string) => {
    if (!portPattern.test(value)) return false;
    const port = Number(value);
    return port >= 1 && port <= 65535;
  };

  const groups = groupServices(config, mappings);
  const hostnameSeen = new Map<string, number>();
  const serverPortSeen = new Map<string, string>();

  config.services.forEach((service, index) => {
    const hostname = service.hostname.trim().toLowerCase();
    if (!hostname) {
      cfChannelErrors.set(index, '填写服务域名');
    } else if (serviceAccessAddress(service.hostname) === undefined) {
      cfChannelErrors.set(index, '域名格式不正确');
    } else if (hostnameSeen.has(hostname)) {
      cfChannelErrors.set(index, `域名与第 ${hostnameSeen.get(hostname)! + 1} 个服务重复`);
    } else {
      hostnameSeen.set(hostname, index);
    }
  });

  mappings.forEach((mapping, index) => {
    const port = mapping.serverPort.trim();
    if (!validPort(port)) {
      serverChannelErrors.set(index, '服务器端口需为 1-65535');
    } else if (serverPortSeen.has(port)) {
      serverChannelErrors.set(index, `端口与「${serverPortSeen.get(port)}」重复`);
    } else {
      serverPortSeen.set(port, mapping.name.trim() || '其他服务');
    }
  });

  for (const group of groups) {
    const cfChannels = group.channels.filter((channel) => channel.kind === 'cf') as Array<{ kind: 'cf'; index: number; service: UglinkService }>;
    if (!group.name.trim()) {
      fail(group, '服务名不能为空');
    }
    if (cfChannels.length > 1) {
      fail(group, `存在 ${cfChannels.length} 条同名 Cloudflare 服务，请改名或删除多余条目`);
    }
    if (!validPort(group.nasPort)) {
      fail(group, 'NAS 端口需为 1-65535');
    }
    const ports = new Set(group.channels.map(nasPortOf).filter(Boolean));
    if (group.channels.length > 1 && ports.size > 1) {
      fail(group, '两条通道的 NAS 端口不一致，同一服务必须同源');
    }
  }

  const hasErrors = groupErrors.size > 0 || cfChannelErrors.size > 0 || serverChannelErrors.size > 0;
  return { groupErrors, cfChannelErrors, serverChannelErrors, hasErrors };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface UnifiedServiceListProps {
  config: UglinkConfig;
  onConfigChange: (config: UglinkConfig) => void;
  server: ServerGatewayState;
  cfEnabled: boolean;
  deployedConfig: UglinkConfig;
  deploymentConfig?: UglinkConfig;
  deploymentServiceHostnames: ReadonlySet<string>;
  job?: DeploymentJob;
  publishedHealth?: ServiceHealthResponse;
  deploying: boolean;
  checkingHealth: boolean;
  healthCheckError?: string;
  onInspectService: (hostname: string) => void;
}

export function UnifiedServiceList({
  config,
  onConfigChange,
  server,
  cfEnabled,
  deployedConfig,
  deploymentConfig,
  deploymentServiceHostnames,
  job,
  publishedHealth,
  deploying,
  checkingHealth,
  healthCheckError,
  onInspectService
}: UnifiedServiceListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pendingRemoval, setPendingRemoval] = useState<string>();
  const [pendingChannelRemoval, setPendingChannelRemoval] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftPort, setDraftPort] = useState('');

  const issues = useMemo(() => validateUnifiedServices(config, server.mappings), [config, server.mappings]);
  const groups = useMemo(() => groupServices(config, server.mappings), [config, server.mappings]);
  const deploymentByHostname = useMemo(() => new Map(
    (job?.services || []).map((service) => [service.hostname.toLowerCase(), service])
  ), [job]);
  const publishedByHostname = useMemo(() => new Map(
    (publishedHealth?.services || []).map((service) => [service.hostname.toLowerCase(), service])
  ), [publishedHealth]);

  const toggleExpand = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const mutateCf = (mutator: (services: UglinkService[]) => UglinkService[]) => {
    onConfigChange({ ...config, services: mutator(config.services) });
  };

  const updateCf = (index: number, patch: Partial<UglinkService>) => {
    mutateCf((services) => services.map((service, i) => (i === index ? { ...service, ...patch } : service)));
  };

  const updateServer = (index: number, patch: Partial<ServerMapping>) => {
    server.setMappings((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  // Service-level edits propagate to every channel so A/B stay consistent.
  const renameService = (group: ServiceGroup, name: string) => {
    mutateCf((services) => services.map((service, i) => (
      group.channels.some((channel) => channel.kind === 'cf' && channel.index === i) ? { ...service, name } : service
    )));
    server.setMappings((rows) => rows.map((row, i) => (
      group.channels.some((channel) => channel.kind === 'server' && channel.index === i) ? { ...row, name } : row
    )));
  };

  const changeNasPort = (group: ServiceGroup, port: string) => {
    mutateCf((services) => services.map((service, i) => (
      group.channels.some((channel) => channel.kind === 'cf' && channel.index === i)
        ? { ...service, port: Number(port) || 0 }
        : service
    )));
    server.setMappings((rows) => rows.map((row, i) => (
      group.channels.some((channel) => channel.kind === 'server' && channel.index === i)
        ? { ...row, nasPort: port.replace(/\D/g, '') }
        : row
    )));
  };

  const addService = (route: 'cf' | 'server') => {
    const name = draftName.trim();
    const port = draftPort.replace(/\D/g, '');
    if (!name || !port) return;
    if (route === 'cf') {
      mutateCf((services) => [...services, {
        name,
        hostname: '',
        port: Number(port),
        enabled: true,
        accessMode: 'proxy'
      }]);
    } else {
      server.setMappings((rows) => [...rows, { name, nasPort: port, serverPort: '', accessMode: 'proxy' }]);
    }
    setExpanded((current) => new Set(current).add(name.toLowerCase()));
    setAdding(false);
    setDraftName('');
    setDraftPort('');
  };

  const addChannel = (group: ServiceGroup, route: 'cf' | 'server') => {
    if (route === 'cf') {
      mutateCf((services) => [...services, {
        name: group.name,
        hostname: '',
        port: Number(group.nasPort) || 80,
        enabled: true,
        accessMode: 'proxy'
      }]);
    } else {
      server.setMappings((rows) => [...rows, {
        name: group.name,
        nasPort: group.nasPort,
        serverPort: '',
        accessMode: 'proxy'
      }]);
    }
    setExpanded((current) => new Set(current).add(group.key));
  };

  const removeChannel = (group: ServiceGroup, channel: Channel) => {
    const token = `${group.key}:${channel.kind}`;
    if (pendingChannelRemoval !== token) {
      setPendingChannelRemoval(token);
      return;
    }
    setPendingChannelRemoval(undefined);
    if (channel.kind === 'cf') {
      mutateCf((services) => services.filter((_, i) => i !== channel.index));
    } else {
      server.setMappings((rows) => rows.filter((_, i) => i !== channel.index));
    }
  };

  const removeService = (group: ServiceGroup) => {
    if (pendingRemoval !== group.key) {
      setPendingRemoval(group.key);
      return;
    }
    setPendingRemoval(undefined);
    const cfIndexes = new Set(group.channels.filter((channel) => channel.kind === 'cf').map((channel) => (channel as { index: number }).index));
    const serverIndexes = new Set(group.channels.filter((channel) => channel.kind === 'server').map((channel) => (channel as { index: number }).index));
    mutateCf((services) => services.filter((_, i) => !cfIndexes.has(i)));
    server.setMappings((rows) => rows.filter((_, i) => !serverIndexes.has(i)));
  };

  const summaryOf = (group: ServiceGroup): ServiceStatusValue => {
    const tones: ServiceStatusTone[] = group.channels.map((channel) => {
      if (channel.kind === 'cf') {
        return resolveServiceStatus(
          channel.service,
          deployedConfig,
          deploymentConfig,
          deploymentServiceHostnames,
          deploymentByHostname,
          publishedByHostname,
          job,
          deploying,
          checkingHealth,
          healthCheckError
        ).tone;
      }
      if (!server.connected) return 'neutral';
      const listening = server.listeningByName.get(channel.mapping.name.trim());
      if (listening === undefined) return 'neutral';
      return listening ? 'success' : 'error';
    });
    if (issues.groupErrors.has(group.key)) return { label: '待修正', detail: issues.groupErrors.get(group.key)!.join('；'), tone: 'error' };
    if (tones.includes('error')) return { label: '有异常', detail: '存在通道异常，展开查看。', tone: 'error' };
    if (tones.includes('pending')) return { label: '待发布', detail: '部分修改尚未发布。', tone: 'pending' };
    if (tones.includes('progress')) return { label: '处理中', detail: '发布或检查进行中。', tone: 'progress' };
    if (tones.length > 0 && tones.every((tone) => tone === 'success')) return { label: '运行正常', detail: '所有通道正常。', tone: 'success' };
    if (tones.includes('neutral')) return { label: '部分未知', detail: '部分通道暂无状态数据。', tone: 'neutral' };
    return { label: '未配置通道', detail: '展开后添加访问通道。', tone: 'neutral' };
  };

  return (
    <div className="editor-stack">
      <section className="panel services-panel">
        <div className="panel__heading panel__heading--row">
          <div>
            <p className="eyebrow">统一服务列表</p>
            <h2>服务与访问通道</h2>
            <p>一行是一个 NAS 服务（本地端口）；展开后管理它的 Cloudflare（A）与服务器（B）访问通道。</p>
          </div>
          <button className="button button--secondary" type="button" onClick={() => setAdding((current) => !current)}>
            <Plus size={16} /> {adding ? '收起' : '添加服务'}
          </button>
        </div>

        {adding && (
          <div className="unified-add-row" role="form" aria-label="添加新服务">
            <label>服务名<input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="例如 openlist"
              aria-label="新服务名"
            /></label>
            <label>NAS 端口<input
              value={draftPort}
              onChange={(event) => setDraftPort(event.target.value.replace(/\D/g, ''))}
              placeholder="例如 5244"
              inputMode="numeric"
              aria-label="新服务 NAS 端口"
            /></label>
            <div className="unified-add-row__actions">
              {cfEnabled && (
                <button className="button button--secondary" type="button" disabled={!draftName.trim() || !draftPort} onClick={() => addService('cf')}>
                  <Cloud size={15} /> 建 A 通道（CF 域名）
                </button>
              )}
              <button className="button button--secondary" type="button" disabled={!draftName.trim() || !draftPort} onClick={() => addService('server')}>
                <HardDrive size={15} /> 建 B 通道（服务器）
              </button>
            </div>
            {!cfEnabled && <p className="muted">连接 Cloudflare 线路后即可为服务添加 A 通道。</p>}
          </div>
        )}

        <div className="unified-list" role="list" aria-label="服务列表">
          {groups.length === 0 && (
            <div className="empty-row"><Cloud size={20} /><span>还没有服务。点击「添加服务」，填服务名和 NAS 端口后选择路线。</span></div>
          )}
          {groups.map((group) => {
            const isOpen = expanded.has(group.key);
            const summary = summaryOf(group);
            const groupErrors = issues.groupErrors.get(group.key) ?? [];
            const cfChannel = group.channels.find((channel) => channel.kind === 'cf') as Channel & { kind: 'cf' } | undefined;
            const serverChannel = group.channels.find((channel) => channel.kind === 'server') as Channel & { kind: 'server' } | undefined;
            return (
              <div className={`unified-service${isOpen ? ' unified-service--open' : ''}`} role="listitem" key={group.key}>
                <div className="unified-service__head">
                  <button className="unified-service__toggle" type="button" aria-expanded={isOpen} onClick={() => toggleExpand(group.key)}>
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <label className="unified-service__name">
                    <input
                      value={group.name}
                      onChange={(event) => renameService(group, event.target.value)}
                      aria-label={`服务 ${group.name} 的名称`}
                      placeholder="服务名"
                    />
                  </label>
                  <label className="unified-service__port">
                    <span className="muted">NAS</span>
                    <input
                      value={group.nasPort}
                      onChange={(event) => changeNasPort(group, event.target.value.replace(/\D/g, ''))}
                      aria-label={`服务 ${group.name} 的 NAS 端口`}
                      placeholder="5244"
                      inputMode="numeric"
                    />
                  </label>
                  <div className="unified-service__badges">
                    {cfChannel && <span className="route-badge route-badge--cf">A · CF</span>}
                    {serverChannel && <span className="route-badge route-badge--server">B · 服务器</span>}
                  </div>
                  <StatusChip value={summary} />
                  <button
                    className={`icon-button${pendingRemoval === group.key ? ' icon-button--confirm' : ''}`}
                    type="button"
                    title={pendingRemoval === group.key ? '再次点击确认删除整个服务' : '删除服务（含所有通道）'}
                    aria-label={pendingRemoval === group.key ? '再次点击确认删除服务' : '删除服务'}
                    onClick={() => removeService(group)}
                    onBlur={() => setPendingRemoval(undefined)}
                  >
                    {pendingRemoval === group.key ? <X size={16} /> : <Trash2 size={16} />}
                  </button>
                </div>

                {isOpen && (
                  <div className="unified-service__body">
                    {groupErrors.map((error) => (
                      <p className="unified-error" key={error}><AlertCircle size={14} /> {error}</p>
                    ))}

                    {cfChannel && (
                      <div className="unified-channel unified-channel--cf">
                        <div className="unified-channel__head">
                          <span className="route-badge route-badge--cf">通道 A · Cloudflare</span>
                          <StatusChip
                            value={resolveServiceStatus(
                              cfChannel.service,
                              deployedConfig,
                              deploymentConfig,
                              deploymentServiceHostnames,
                              deploymentByHostname,
                              publishedByHostname,
                              job,
                              deploying,
                              checkingHealth,
                              healthCheckError
                            )}
                            onInspect={cfChannel.service.hostname ? () => onInspectService(cfChannel.service.hostname) : undefined}
                          />
                          <button
                            className={`icon-button${pendingChannelRemoval === `${group.key}:cf` ? ' icon-button--confirm' : ''}`}
                            type="button"
                            title={pendingChannelRemoval === `${group.key}:cf` ? '再次点击确认删除通道' : '删除 Cloudflare 通道'}
                            aria-label="删除 Cloudflare 通道"
                            onClick={() => removeChannel(group, cfChannel)}
                            onBlur={() => setPendingChannelRemoval(undefined)}
                          >
                            {pendingChannelRemoval === `${group.key}:cf` ? <X size={15} /> : <Trash2 size={15} />}
                          </button>
                        </div>
                        {issues.cfChannelErrors.has(cfChannel.index) && (
                          <p className="unified-error"><AlertCircle size={14} /> {issues.cfChannelErrors.get(cfChannel.index)}</p>
                        )}
                        <div className="unified-channel__fields">
                          <label className="unified-channel__domain">
                            <span>域名</span>
                            <div className="domain-input">
                              <Cloud size={15} />
                              <input
                                value={cfChannel.service.hostname}
                                onChange={(event) => updateCf(cfChannel.index, { hostname: event.target.value.toLowerCase() })}
                                placeholder="sub.example.com"
                                aria-label="Cloudflare 通道域名"
                              />
                            </div>
                          </label>
                          <label className="unified-channel__mode">
                            <span>访问方式</span>
                            <SelectMenu
                              value={cfChannel.service.accessMode ?? 'proxy'}
                              options={ACCESS_MODE_OPTIONS}
                              onChange={(accessMode) => updateCf(cfChannel.index, { accessMode })}
                              ariaLabel="Cloudflare 通道访问方式"
                            />
                          </label>
                          <div className="unified-channel__toggle">
                            <span>启用</span>
                            <Toggle
                              checked={cfChannel.service.enabled !== false}
                              onChange={(enabled) => updateCf(cfChannel.index, { enabled })}
                              label={`${group.name} Cloudflare 通道启用状态`}
                            />
                          </div>
                          <div className="unified-channel__address">
                            <span>入口</span>
                            {serviceAccessAddress(cfChannel.service.hostname) ? (
                              <a href={serviceAccessAddress(cfChannel.service.hostname)} target="_blank" rel="noreferrer">
                                <ExternalLink size={13} /> {serviceAccessAddress(cfChannel.service.hostname)}
                              </a>
                            ) : <span className="muted">未配置域名</span>}
                          </div>
                        </div>
                      </div>
                    )}

                    {serverChannel && (
                      <div className="unified-channel unified-channel--server">
                        <div className="unified-channel__head">
                          <span className="route-badge route-badge--server">通道 B · 服务器</span>
                          <StatusChip value={(() => {
                            if (!server.connected) return { label: '未连接服务器', detail: '请到线路管理填写服务器地址与令牌。', tone: 'neutral' as const };
                            const listening = server.listeningByName.get(serverChannel.mapping.name.trim());
                            if (listening === undefined) return { label: '状态未知', detail: '等待服务器状态刷新。', tone: 'neutral' as const };
                            return listening
                              ? { label: '监听中', detail: `服务器端口 ${serverChannel.mapping.serverPort} 正在监听。`, tone: 'success' as const }
                              : { label: '未监听', detail: `服务器端口 ${serverChannel.mapping.serverPort} 尚未监听，请确认已同步。`, tone: 'error' as const };
                          })()} />
                          <button
                            className={`icon-button${pendingChannelRemoval === `${group.key}:server` ? ' icon-button--confirm' : ''}`}
                            type="button"
                            title={pendingChannelRemoval === `${group.key}:server` ? '再次点击确认删除通道' : '删除服务器通道'}
                            aria-label="删除服务器通道"
                            onClick={() => removeChannel(group, serverChannel)}
                            onBlur={() => setPendingChannelRemoval(undefined)}
                          >
                            {pendingChannelRemoval === `${group.key}:server` ? <X size={15} /> : <Trash2 size={15} />}
                          </button>
                        </div>
                        {issues.serverChannelErrors.has(serverChannel.index) && (
                          <p className="unified-error"><AlertCircle size={14} /> {issues.serverChannelErrors.get(serverChannel.index)}</p>
                        )}
                        <div className="unified-channel__fields">
                          <label className="unified-channel__server-port">
                            <span>服务器端口</span>
                            <input
                              value={serverChannel.mapping.serverPort}
                              onChange={(event) => updateServer(serverChannel.index, { serverPort: event.target.value.replace(/\D/g, '') })}
                              placeholder="例如 9091"
                              inputMode="numeric"
                              aria-label="服务器端口"
                            />
                          </label>
                          <label className="unified-channel__mode">
                            <span>访问方式</span>
                            <SelectMenu
                              value={serverChannel.mapping.accessMode}
                              options={ACCESS_MODE_OPTIONS}
                              onChange={(accessMode) => updateServer(serverChannel.index, { accessMode })}
                              ariaLabel="服务器通道访问方式"
                            />
                          </label>
                          <div className="unified-channel__address">
                            <span>入口</span>
                            {server.connection.baseUrl && serverChannel.mapping.serverPort ? (
                              <a href={`http://${new URL(server.connection.baseUrl).host}:${serverChannel.mapping.serverPort}`} target="_blank" rel="noreferrer">
                                <ExternalLink size={13} /> {new URL(server.connection.baseUrl).hostname}:{serverChannel.mapping.serverPort}
                              </a>
                            ) : <span className="muted">{server.connection.baseUrl ? '填写服务器端口后生成' : '未配置服务器地址'}</span>}
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="unified-channel__add">
                      {cfEnabled && !cfChannel && (
                        <button className="button button--ghost" type="button" onClick={() => addChannel(group, 'cf')}>
                          <Plus size={14} /> 添加 A 通道（Cloudflare 域名）
                        </button>
                      )}
                      {!serverChannel && (
                        <button className="button button--ghost" type="button" onClick={() => addChannel(group, 'server')}>
                          <Plus size={14} /> 添加 B 通道（服务器端口）
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {issues.hasErrors && (
          <p className="unified-error unified-error--summary"><AlertCircle size={14} /> 列表中存在待修正项，修正后才能发布或同步。</p>
        )}
      </section>
    </div>
  );
}
