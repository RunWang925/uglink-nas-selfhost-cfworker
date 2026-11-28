import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Cloud,
  HardDrive,
  LoaderCircle,
  Plus,
  Search,
  Trash2
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { UglinkConfig, UglinkService } from '../../../domain/configuration/model';
import type { DeploymentJob, ServiceHealthResponse } from '../../../domain/deployment/model';
import { normalizeHostname } from '../../../domain/configuration/validation';
import type { ServerGatewayState, ServerMapping } from '../lib/use-server-gateway';

const ACCESS_MODE_OPTIONS = [
  { value: 'proxy', label: '代理模式' },
  { value: 'ticket', label: '绿联跳转' }
] as const;

const CUSTOM_DOMAIN_STORAGE_KEY = 'uglink_server_custom_domains';
const CIRCLED_NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function sequenceLabel(index: number): string {
  return CIRCLED_NUMBERS[index - 1] ?? String(index);
}

function validPort(value: string): boolean {
  if (!/^\d{1,5}$/u.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
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

type ServiceStatusTone = 'success' | 'progress' | 'pending' | 'error' | 'neutral';

interface ServiceStatusValue {
  label: string;
  detail: string;
  tone: ServiceStatusTone;
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

function serverStatus(mapping: ServerMapping, server: ServerGatewayState): ServiceStatusValue {
  if (!server.connected) {
    return { label: '未连接', detail: '请到线路管理配置自建服务网关。', tone: 'neutral' };
  }
  const listening = server.listeningByName.get(mapping.name.trim());
  if (listening === undefined) {
    return { label: '状态未知', detail: '等待网关状态刷新。', tone: 'neutral' };
  }
  return listening
    ? { label: '已同步', detail: `网关端口 ${mapping.serverPort} 正在监听。`, tone: 'success' }
    : { label: '未同步', detail: `网关端口 ${mapping.serverPort} 尚未监听，请保存后重试。`, tone: 'error' };
}

function serviceAccessAddress(hostname: string): string | undefined {
  try {
    return `https://${normalizeHostname(hostname)}`;
  } catch {
    return undefined;
  }
}

function gatewayHost(server: ServerGatewayState): string {
  try {
    return new URL(server.connection.baseUrl).hostname;
  } catch {
    return '';
  }
}

function serverAccessAddress(mapping: ServerMapping, server: ServerGatewayState): string | undefined {
  const host = gatewayHost(server);
  const port = mapping.serverPort.trim();
  return host && port ? `http://${host}:${port}` : undefined;
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

// One record = one access route of one NAS port. Records live in a box keyed by
// the NAS port; names are independent for every record.
type EntryKind = 'cf' | 'server';

interface EntryBase {
  key: string;
  kind: EntryKind;
  index: number;
  name: string;
  port: string;
  mode: 'proxy' | 'ticket';
}

interface CfEntry extends EntryBase {
  kind: 'cf';
  service: UglinkService;
}

interface ServerEntry extends EntryBase {
  kind: 'server';
  mapping: ServerMapping;
}

type Entry = CfEntry | ServerEntry;

interface PortGroup {
  key: string;
  port: string;
  entries: Entry[];
}

function buildGroups(config: UglinkConfig, mappings: ServerMapping[]): PortGroup[] {
  const groups = new Map<string, PortGroup>();
  const ensure = (port: string): PortGroup => {
    const key = port.trim() || '(空端口)';
    let group = groups.get(key);
    if (!group) {
      group = { key, port: port.trim(), entries: [] };
      groups.set(key, group);
    }
    return group;
  };
  config.services.forEach((service, index) => {
    ensure(String(service.port ?? '')).entries.push({
      key: `cf:${index}`,
      kind: 'cf',
      index,
      name: service.name,
      port: String(service.port ?? ''),
      mode: service.accessMode ?? 'proxy',
      service
    });
  });
  mappings.forEach((mapping, index) => {
    ensure(mapping.nasPort).entries.push({
      key: `server:${index}`,
      kind: 'server',
      index,
      name: mapping.name,
      port: mapping.nasPort,
      mode: mapping.accessMode ?? 'proxy',
      mapping
    });
  });
  return [...groups.values()];
}

function entryAddress(entry: Entry, server: ServerGatewayState, customDomain: string): string | undefined {
  if (entry.kind === 'cf') return serviceAccessAddress(entry.service.hostname);
  return serverAccessAddress(entry.mapping, server) ?? (customDomain || undefined);
}

function entrySearchText(entry: Entry, server: ServerGatewayState, customDomain: string): string {
  return [
    entry.name,
    entry.port,
    entry.kind === 'cf' ? 'Cloudflare' : '自建服务',
    entry.mode === 'ticket' ? '绿联跳转' : '代理模式',
    entry.kind === 'cf' ? entry.service.hostname : serverAccessAddress(entry.mapping, server) ?? '',
    customDomain
  ].join(' ').toLowerCase();
}

function loadCustomDomains(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CUSTOM_DOMAIN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string')
    ) as Record<string, string>;
  } catch {
    return {};
  }
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
  const fail = (group: PortGroup, message: string) => {
    const list = groupErrors.get(group.key) ?? [];
    list.push(message);
    groupErrors.set(group.key, list);
  };

  const groups = buildGroups(config, mappings);
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
      serverChannelErrors.set(index, '监听端口需为 1-65535');
    } else if (serverPortSeen.has(port)) {
      serverChannelErrors.set(index, `监听端口与「${serverPortSeen.get(port)}」重复`);
    } else {
      serverPortSeen.set(port, mapping.name.trim() || '其他服务');
    }
  });

  for (const group of groups) {
    if (!validPort(group.port)) {
      fail(group, 'NAS 端口需为 1-65535');
    }
    if (group.entries.some((entry) => !entry.name.trim())) {
      fail(group, '服务名不能为空');
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
  const [editingKey, setEditingKey] = useState<string>();
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string>();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftPort, setDraftPort] = useState('');
  const [draftRoute, setDraftRoute] = useState<'cf' | 'server'>(cfEnabled ? 'cf' : 'server');
  const serverRouteAvailable = server.connected;
  const anyRouteAvailable = cfEnabled || serverRouteAvailable;
  const [draftDomain, setDraftDomain] = useState('');
  const [draftServerPort, setDraftServerPort] = useState('');
  const [draftCustomDomain, setDraftCustomDomain] = useState('');
  const [draftMode, setDraftMode] = useState<'proxy' | 'ticket'>('proxy');
  const [draftError, setDraftError] = useState<string>();
  const [customDomains, setCustomDomains] = useState<Record<string, string>>(loadCustomDomains);
  const [addedPorts, setAddedPorts] = useState<string[]>([]);

  useEffect(() => {
    try {
      window.localStorage.setItem(CUSTOM_DOMAIN_STORAGE_KEY, JSON.stringify(customDomains));
    } catch {
      // Browser storage may be unavailable; the UI keeps working in memory.
    }
  }, [customDomains]);

  // Keep the draft route selectable-only: when a route becomes unavailable
  // (e.g. self-hosted connection cleared), fall back to the other route.
  useEffect(() => {
    setDraftRoute((current) => {
      if (current === 'cf' && !cfEnabled) return serverRouteAvailable ? 'server' : 'cf';
      if (current === 'server' && !serverRouteAvailable) return 'cf';
      return current;
    });
  }, [cfEnabled, serverRouteAvailable]);

  const issues = useMemo(() => validateUnifiedServices(config, server.mappings), [config, server.mappings]);
  const groups = useMemo(() => buildGroups(config, server.mappings), [config, server.mappings]);
  const deploymentByHostname = useMemo(() => new Map(
    (job?.services || []).map((service) => [service.hostname.toLowerCase(), service])
  ), [job]);
  const publishedByHostname = useMemo(() => new Map(
    (publishedHealth?.services || []).map((service) => [service.hostname.toLowerCase(), service])
  ), [publishedHealth]);

  const customDomainOf = (entry: Entry): string => (
    entry.kind === 'server' ? customDomains[entry.mapping.serverPort.trim()] ?? '' : ''
  );
  const normalizedQuery = query.trim().toLowerCase();

  // Brand-new ports are appended after all existing boxes, no matter which
  // underlying data source (Cloudflare or self-hosted) the record came from.
  const orderedGroups = useMemo(() => {
    const rank = (port: string) => addedPorts.indexOf(port.trim());
    return [...groups].sort((left, right) => {
      const leftRank = rank(left.port);
      const rightRank = rank(right.port);
      if (leftRank >= 0 && rightRank >= 0) return leftRank - rightRank;
      if (leftRank >= 0) return 1;
      if (rightRank >= 0) return -1;
      return 0;
    });
  }, [groups, addedPorts]);

  const visibleGroups = useMemo(() => orderedGroups.map((group, index) => ({
    ...group,
    seq: index + 1,
    entries: normalizedQuery
      ? group.entries.filter((entry) => entrySearchText(entry, server, customDomainOf(entry)).includes(normalizedQuery))
      : group.entries
  })).filter((group) => group.entries.length > 0), [orderedGroups, normalizedQuery, server, customDomains]);

  const mutateCf = (mutator: (services: UglinkService[]) => UglinkService[]) => {
    onConfigChange({ ...config, services: mutator(config.services) });
  };

  const updateEntry = (entry: Entry, patch: Partial<Pick<UglinkService, 'name' | 'hostname' | 'accessMode' | 'enabled'>> | Partial<ServerMapping>) => {
    if (entry.kind === 'cf') {
      mutateCf((services) => services.map((service, index) => (
        index === entry.index ? { ...service, ...patch } : service
      )));
      return;
    }
    const current = server.mappings[entry.index];
    const nextPort = (patch as Partial<ServerMapping>).serverPort;
    if (current && nextPort !== undefined && nextPort.trim() !== current.serverPort.trim()) {
      const oldKey = current.serverPort.trim();
      const newKey = nextPort.trim();
      setCustomDomains((previous) => {
        const next = { ...previous };
        const moved = next[oldKey];
        delete next[oldKey];
        if (newKey && moved) next[newKey] = moved;
        return next;
      });
    }
    server.setMappings((rows) => rows.map((row, index) => (
      index === entry.index ? { ...row, ...patch } : row
    )));
  };

  const updateCustomDomain = (mapping: ServerMapping, value: string) => {
    const key = mapping.serverPort.trim();
    if (!key) return;
    setCustomDomains((previous) => ({ ...previous, [key]: value }));
  };

  const removeEntry = (entry: Entry) => {
    setEditingKey(undefined);
    setConfirmDeleteKey(undefined);
    if (entry.kind === 'cf') {
      mutateCf((services) => services.filter((_, index) => index !== entry.index));
      return;
    }
    const key = entry.mapping.serverPort.trim();
    if (key) {
      setCustomDomains((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
    server.setMappings((rows) => rows.filter((_, index) => index !== entry.index));
  };

  const handleDelete = (entry: Entry) => {
    if (confirmDeleteKey !== entry.key) {
      setConfirmDeleteKey(entry.key);
      return;
    }
    removeEntry(entry);
  };

  const handleDraftName = (value: string) => {
    setDraftName(value);
    if (!draftPort) {
      const match = groups.flatMap((group) => group.entries)
        .find((entry) => entry.name.trim().toLowerCase() === value.trim().toLowerCase());
      if (match) setDraftPort(match.port);
    }
  };

  const handleDraftPort = (value: string) => {
    const port = value.replace(/\D/g, '');
    setDraftPort(port);
    setDraftServerPort(port);
    if (!draftName) {
      const match = groups.flatMap((group) => group.entries)
        .find((entry) => entry.port === port && entry.name.trim());
      if (match) setDraftName(match.name);
    }
  };

  const resetDraft = () => {
    setAdding(false);
    setDraftName('');
    setDraftPort('');
    setDraftDomain('');
    setDraftServerPort('');
    setDraftCustomDomain('');
    setDraftMode('proxy');
    setDraftRoute(cfEnabled ? 'cf' : serverRouteAvailable ? 'server' : 'cf');
    setDraftError(undefined);
  };

  const finishDraft = () => {
    if (draftRoute === 'cf' && !cfEnabled) {
      setDraftError('Cloudflare 路线未配置，请先到「线路管理」配置 Account ID 与 API Token。');
      return;
    }
    if (draftRoute === 'server' && !serverRouteAvailable) {
      setDraftError('自建服务路线未配置，请先到「线路管理」填好服务器地址与访问令牌。');
      return;
    }
    const name = draftName.trim();
    const port = draftPort.replace(/\D/g, '');
    if (!name || !port) {
      setDraftError('请填写服务名称和 NAS 端口。');
      return;
    }
    if (!validPort(port)) {
      setDraftError('NAS 端口需为 1-65535。');
      return;
    }
    if (!groups.some((group) => group.port === port)) {
      setAddedPorts((previous) => [...previous, port]);
    }
    if (draftRoute === 'cf') {
      const hostname = draftDomain.trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/$/u, '');
      if (!hostname || serviceAccessAddress(hostname) === undefined) {
        setDraftError('请填写正确的访问域名（只填域名本身，例如 sub.example.com）。');
        return;
      }
      mutateCf((services) => [...services, {
        name,
        hostname,
        port: Number(port),
        enabled: true,
        accessMode: draftMode
      }]);
      resetDraft();
      return;
    }
    const listenPort = (draftServerPort || port).replace(/\D/g, '');
    if (!validPort(listenPort)) {
      setDraftError('监听端口需为 1-65535。');
      return;
    }
    server.setMappings((rows) => [...rows, {
      name,
      nasPort: port,
      serverPort: listenPort,
      accessMode: draftMode
    }]);
    const custom = draftCustomDomain.trim();
    if (custom) {
      setCustomDomains((previous) => ({ ...previous, [listenPort]: custom }));
    }
    resetDraft();
  };

  const renderRouteBadge = (entry: Entry) => (
    <span className={`route-badge ${entry.kind === 'cf' ? 'route-badge--cf' : 'route-badge--server'}`}>
      {entry.kind === 'cf' ? <Cloud size={13} /> : <HardDrive size={13} />}
      {entry.kind === 'cf' ? 'Cloudflare' : '自建服务'}
    </span>
  );

  const renderModeSelect = (entry: Entry) => (
    <select
      className="entry-select mode-select"
      value={entry.mode}
      aria-label={`${entry.name} 的访问模式`}
      onChange={(event) => updateEntry(entry, { accessMode: event.target.value as 'proxy' | 'ticket' })}
    >
      {ACCESS_MODE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );

  const renderActions = (entry: Entry, editing: boolean) => (
    editing ? (
      <>
        <button className="button button--secondary button--compact" type="button" onClick={() => {
          setEditingKey(undefined);
          setConfirmDeleteKey(undefined);
        }}>✓ 完成</button>
        <button
          className={`button button--ghost button--compact${confirmDeleteKey === entry.key ? ' button--danger' : ''}`}
          type="button"
          title="删除这条记录（需再次点击确认）"
          onBlur={() => setConfirmDeleteKey(undefined)}
          onClick={() => handleDelete(entry)}
        >
          <Trash2 size={14} /> {confirmDeleteKey === entry.key ? '确认删除' : '删除'}
        </button>
      </>
    ) : (
      <>
        <button
          className="button button--secondary button--compact"
          type="button"
          onClick={() => {
            setEditingKey(entry.key);
            setConfirmDeleteKey(undefined);
          }}
        >✎ 编辑</button>
      </>
    )
  );

  const renderReadView = (entry: Entry, seq: number) => {
    const customDomain = customDomainOf(entry);
    const address = entryAddress(entry, server, customDomain);
    const status = entry.kind === 'cf'
      ? resolveServiceStatus(
        entry.service,
        deployedConfig,
        deploymentConfig,
        deploymentServiceHostnames,
        deploymentByHostname,
        publishedByHostname,
        job,
        deploying,
        checkingHealth,
        healthCheckError
      )
      : serverStatus(entry.mapping, server);
    const entryError = entry.kind === 'cf'
      ? issues.cfChannelErrors.get(entry.index)
      : issues.serverChannelErrors.get(entry.index);
    return (
      <div className="entry-grid row-view">
        <span className="seq-tag">{sequenceLabel(seq)}</span>
        <strong className="view-name" title={entry.name}>{entry.name || '未命名'}</strong>
        <span className="port-chip">端口 {entry.port}</span>
        {renderRouteBadge(entry)}
        <span className={`addr-slot${customDomain && entry.kind === 'server' ? ' addr-slot--stack' : ''}`}>
          {address ? (
            <a
              className="addr-chip"
              href={address.startsWith('http') ? address : `https://${address}`}
              target="_blank"
              rel="noreferrer"
              title="点击打开"
            >
              {address}
            </a>
          ) : (
            <span className="muted">{entry.kind === 'cf' ? '未填写域名' : '未配置监听端口'}</span>
          )}
          {customDomain && entry.kind === 'server' && address !== customDomain && (
            <a className="addr-chip addr-chip--domain" href={customDomain} target="_blank" rel="noreferrer" title="点击打开自定义域名">
              {customDomain}
            </a>
          )}
        </span>
        <span className="mode-chip">{entry.mode === 'ticket' ? '绿联跳转' : '代理模式'}</span>
        <div className="cell-actions">
          <StatusChip
            value={status}
            onInspect={entry.kind === 'cf' && entry.service.hostname ? () => onInspectService(entry.service.hostname) : undefined}
          />
          {renderActions(entry, false)}
        </div>
        {entryError && <p className="entry-error"><AlertCircle size={13} /> {entryError}</p>}
      </div>
    );
  };

  const renderEditView = (entry: Entry, seq: number) => (
    <div className="row-edit">
      <div className="entry-grid">
        <span className="seq-tag">{sequenceLabel(seq)}</span>
        <label className="edit-field cell-name">
          <span>服务名称</span>
          <input
            value={entry.name}
            placeholder="服务名"
            aria-label={`${entry.name} 的服务名称`}
            onChange={(event) => updateEntry(entry, { name: event.target.value })}
          />
        </label>
        <label className="edit-field cell-port">
          <span>NAS 端口</span>
          <input value={entry.port} disabled aria-label="NAS 端口不可修改" />
        </label>
        {renderRouteBadge(entry)}
        {entry.kind === 'cf' ? (
          <label className="edit-field cell-address">
            <span>访问域名</span>
            <input
              value={entry.service.hostname}
              placeholder="sub.example.com"
              aria-label="访问域名"
              onChange={(event) => updateEntry(entry, { hostname: event.target.value.toLowerCase() })}
            />
          </label>
        ) : (
          <div className="cell-address address-split">
            <label className="edit-field field-ip">
              <span>服务器 IP</span>
              <span className="ip-chip" title="服务器 IP 由线路管理页统一配置">{gatewayHost(server) || '未配置'}</span>
            </label>
            <label className="edit-field field-listen">
              <span>监听端口</span>
              <input
                value={entry.mapping.serverPort}
                placeholder="例如 9091"
                inputMode="numeric"
                aria-label="监听端口"
                onChange={(event) => updateEntry(entry, { serverPort: event.target.value.replace(/\D/g, '') })}
              />
            </label>
          </div>
        )}
        <label className="edit-field cell-mode">
          <span>模式</span>
          {renderModeSelect(entry)}
        </label>
        <div className="cell-actions">
          {entry.kind === 'cf' && renderActions(entry, true)}
        </div>
      </div>
      {entry.kind === 'server' && (
        <div className="cfg-line">
          <label className="domain-h">
            <span>自定义域名（可选）</span>
            <input
              className="domain-inline"
              value={customDomainOf(entry)}
              placeholder="如 http://nas.my.com"
              aria-label="自建服务自定义域名"
              onChange={(event) => updateCustomDomain(entry.mapping, event.target.value)}
            />
          </label>
          <div className="cell-actions">{renderActions(entry, true)}</div>
        </div>
      )}
    </div>
  );

  return (
    <div className="editor-stack">
      <section className="panel services-panel">
        <div className="panel__heading panel__heading--row">
          <div>
            <p className="eyebrow">统一服务列表</p>
            <h2>服务列表</h2>
            <p>一个框 = 一个服务 · 配了 Cloudflare 就有 Cloudflare 一行，配了自建服务就有自建服务一行，都配就有两行。</p>
          </div>
          <div className="services-toolbar">
            <label className="search-field">
              <Search size={15} aria-hidden="true" />
              <input
                value={query}
                placeholder="搜索名称 / 端口 / 域名"
                aria-label="搜索服务名称、端口或域名"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              className="button button--secondary button--compact"
              type="button"
              disabled={adding || !anyRouteAvailable}
              title={anyRouteAvailable ? undefined : '请先在「线路管理」页配置 Cloudflare 或自建服务路线'}
              onClick={() => setAdding(true)}
            >
              <Plus size={15} /> 添加记录
            </button>
          </div>
        </div>

        <div className="svc-list" role="list" aria-label="服务列表">
          {groups.length === 0 && !adding && (
            <div className="empty-row"><Cloud size={20} /><span>还没有服务。点击「添加记录」，填好名称、端口和访问路线即可。</span></div>
          )}
          {visibleGroups.map((group) => {
            const seq = group.seq;
            const groupErrors = issues.groupErrors.get(group.key) ?? [];
            return (
              <div className="svc-box" role="listitem" key={group.key}>
                <div className="svc-box__rows">
                  {group.entries.map((entry) => (
                    <div className="entry-row" key={entry.key}>
                      {editingKey === entry.key ? renderEditView(entry, seq) : renderReadView(entry, seq)}
                    </div>
                  ))}
                </div>
                {groupErrors.map((error) => (
                  <p className="entry-error entry-error--group" key={error}><AlertCircle size={13} /> {error}</p>
                ))}
              </div>
            );
          })}

          {adding && !normalizedQuery && (
            <div className="svc-box svc-box--draft">
              <div className="svc-box__rows">
                <div className="entry-row entry-row--draft">
                  <div className="entry-grid">
                    <span className="seq-tag seq-tag--draft">新</span>
                    <label className="edit-field cell-name">
                      <span>服务名称</span>
                      <input value={draftName} placeholder="例如 qinglong" onChange={(event) => handleDraftName(event.target.value)} />
                    </label>
                    <label className="edit-field cell-port">
                      <span>NAS 端口</span>
                      <input value={draftPort} placeholder="5700" inputMode="numeric" onChange={(event) => handleDraftPort(event.target.value)} />
                    </label>
                    <label className="edit-field cell-route">
                      <span>线路</span>
                      <select
                        className="entry-select route-select"
                        value={draftRoute}
                        aria-label="新记录线路"
                        onChange={(event) => setDraftRoute(event.target.value as 'cf' | 'server')}
                      >
                        {cfEnabled && <option value="cf">Cloudflare</option>}
                        {serverRouteAvailable && <option value="server">自建服务</option>}
                      </select>
                    </label>
                    {draftRoute === 'cf' ? (
                      <label className="edit-field cell-address">
                        <span>访问域名</span>
                        <input
                          value={draftDomain}
                          placeholder="sub.example.com"
                          aria-label="新记录访问域名"
                          onChange={(event) => setDraftDomain(event.target.value.toLowerCase())}
                        />
                      </label>
                    ) : (
                      <div className="cell-address address-split">
                        <label className="edit-field field-ip">
                          <span>服务器 IP</span>
                          <span className="ip-chip" title="服务器 IP 由线路管理页统一配置">{gatewayHost(server) || '未配置'}</span>
                        </label>
                        <label className="edit-field field-listen">
                          <span>监听端口</span>
                          <input
                            value={draftServerPort}
                            placeholder="随 NAS 端口带出"
                            inputMode="numeric"
                            aria-label="新记录监听端口"
                            onChange={(event) => setDraftServerPort(event.target.value.replace(/\D/g, ''))}
                          />
                        </label>
                      </div>
                    )}
                    <label className="edit-field cell-mode">
                      <span>模式</span>
                      <select
                        className="entry-select mode-select"
                        value={draftMode}
                        aria-label="新记录访问模式"
                        onChange={(event) => setDraftMode(event.target.value as 'proxy' | 'ticket')}
                      >
                        {ACCESS_MODE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <div className="cell-actions">
                      <button className="button button--ghost button--compact" type="button" onClick={resetDraft}>✕ 放弃</button>
                      <button className="button button--primary button--compact" type="button" onClick={finishDraft}>✓ 完成</button>
                    </div>
                  </div>
                  {draftRoute === 'server' && (
                    <div className="domain-sub">
                      <input
                        className="domain-inline"
                        value={draftCustomDomain}
                        placeholder="自定义域名（可选）· 如 http://nas.my.com"
                        aria-label="新记录自定义域名"
                        onChange={(event) => setDraftCustomDomain(event.target.value)}
                      />
                    </div>
                  )}
                  {draftError && <p className="entry-error"><AlertCircle size={13} /> {draftError}</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        {issues.hasErrors && (
          <p className="unified-error unified-error--summary"><AlertCircle size={14} /> 列表中存在待修正项，修正后才能保存更改。</p>
        )}

        <div className="help-block">
          <div className="help-row">
            <span className="help-tag">路线</span>
            <span className="help-txt"><strong>Cloudflare</strong> 的域名需已托管到 Cloudflare，这里只填域名本身；<strong>自建服务</strong>使用线路管理页配置的服务器 IP。</span>
          </div>
          <div className="help-row">
            <span className="help-tag">模式</span>
            <span className="help-txt">
              <strong>代理模式</strong> = 全部流量经 Cloudflare / 自建服务网关转发到 NAS，地址始终是你的域名，速度受所走线路影响；
              <strong>绿联跳转</strong> = 访问自己的域名后马上跳转到绿联官方服务域名（如 *.ug.link）验证身份，之后流量直接走绿联中继、不占用你的线路流量，更安全但多一步，地址栏会变成绿联域名。
              <a
                className="help-link"
                href="https://github.com/RunWang925/uglink-nas-selfhost-cfworker/blob/main/docs/configuration.md#%E8%AE%BF%E9%97%AE%E6%96%B9%E5%BC%8F"
                target="_blank"
                rel="noreferrer"
              >详细规则</a>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
