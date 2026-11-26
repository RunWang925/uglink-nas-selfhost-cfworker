import { readFileSync, writeFileSync } from 'node:fs';

export type NodeAccessMode = 'proxy' | 'ticket';

export interface NodeServiceEntry {
  /** Display label, also used as the traffic-stats key. */
  name: string;
  /** Web service port inside the NAS (the Docker published port). */
  nasPort: number;
  /** Public port opened on the self-hosted server. */
  serverPort: number;
  accessMode: NodeAccessMode;
}

export interface NodeGatewayStoredConfig {
  uglinkId: string;
  username: string;
  password: string;
  sessionNamespace: string;
  /** Monthly traffic alert threshold in GB; null disables the alert. */
  trafficMonthlyThresholdGb: number | null;
  services: NodeServiceEntry[];
}

export interface NodeGatewayConfig {
  uglinkId: string;
  username: string;
  password: string;
  sessionNamespace: string;
  setupMode: boolean;
  host: string;
  serviceMap: Record<string, { port: string; accessMode: NodeAccessMode; listen?: number }>;
}

export interface ValidatedConfig {
  ok: true;
  config: NodeGatewayStoredConfig;
}

export interface InvalidConfig {
  ok: false;
  errors: string[];
}

const PORT_PATTERN = /^\d{1,5}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asPort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && PORT_PATTERN.test(value)) return Number(value);
  return null;
}

function validPort(port: number): boolean {
  return port >= 1 && port <= 65535;
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function emptyStoredConfig(): NodeGatewayStoredConfig {
  return {
    uglinkId: '',
    username: '',
    password: '',
    sessionNamespace: 'default',
    trafficMonthlyThresholdGb: null,
    services: []
  };
}

export function validateStoredConfig(value: unknown): ValidatedConfig | InvalidConfig {
  const errors: string[] = [];
  const source = isRecord(value) ? value : {};
  const uglinkId = normalizeName(source.uglinkId);
  const username = normalizeName(source.username);
  const password = typeof source.password === 'string' ? source.password : '';
  const sessionNamespace = normalizeName(source.sessionNamespace) || 'default';

  if (!uglinkId) errors.push('UGREENlink ID 不能为空。');
  if (!username) errors.push('NAS 用户名不能为空。');
  if (!password) errors.push('NAS 密码不能为空。');

  let thresholdGb: number | null = null;
  if (source.trafficMonthlyThresholdGb !== undefined && source.trafficMonthlyThresholdGb !== null && source.trafficMonthlyThresholdGb !== '') {
    const parsed = typeof source.trafficMonthlyThresholdGb === 'number'
      ? source.trafficMonthlyThresholdGb
      : Number(source.trafficMonthlyThresholdGb);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push('月流量阈值必须是不小于 0 的数字（GB），留空表示不预警。');
    } else {
      thresholdGb = parsed;
    }
  }

  const services: NodeServiceEntry[] = [];
  const seenNames = new Set<string>();
  const seenPorts = new Set<number>();
  const rawServices = Array.isArray(source.services) ? source.services : [];
  rawServices.forEach((raw, index) => {
    const label = `服务 #${index + 1}`;
    if (!isRecord(raw)) {
      errors.push(`${label}：格式不正确。`);
      return;
    }
    const name = normalizeName(raw.name) || `service-${index + 1}`;
    if (name.length > 64) {
      errors.push(`${label}：名称过长。`);
      return;
    }
    if (seenNames.has(name)) {
      errors.push(`${label}：名称 "${name}" 重复。`);
      return;
    }
    const nasPort = asPort(raw.nasPort);
    if (nasPort === null || !validPort(nasPort)) {
      errors.push(`${label}：NAS 端口无效（1-65535）。`);
      return;
    }
    const serverPort = asPort(raw.serverPort);
    if (serverPort === null || !validPort(serverPort)) {
      errors.push(`${label}：服务器端口无效（1-65535）。`);
      return;
    }
    if (seenPorts.has(serverPort)) {
      errors.push(`${label}：服务器端口 ${serverPort} 重复。`);
      return;
    }
    const accessMode = raw.accessMode === 'ticket' ? 'ticket' : 'proxy';
    seenNames.add(name);
    seenPorts.add(serverPort);
    services.push({ name, nasPort, serverPort, accessMode });
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: { uglinkId, username, password, sessionNamespace, trafficMonthlyThresholdGb: thresholdGb, services }
  };
}

export function loadStoredConfig(path: string): NodeGatewayStoredConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const result = validateStoredConfig(parsed);
  if (!result.ok) {
    throw new Error(`Node gateway config is invalid: ${result.errors.join(' ')}`);
  }
  return result.config;
}

export function saveStoredConfig(path: string, config: NodeGatewayStoredConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Map stored config to the runtime shape (one listen port per service). */
export function configFromStored(config: NodeGatewayStoredConfig, host: string): NodeGatewayConfig {
  const serviceMap: NodeGatewayConfig['serviceMap'] = {};
  for (const service of config.services) {
    serviceMap[service.name] = {
      port: String(service.nasPort),
      accessMode: service.accessMode,
      listen: service.serverPort
    };
  }
  return {
    uglinkId: config.uglinkId,
    username: config.username,
    password: config.password,
    sessionNamespace: config.sessionNamespace || 'default',
    setupMode: false,
    host,
    serviceMap
  };
}

/** Headless bootstrap from environment variables (no config file). */
export function configFromEnv(env: NodeJS.ProcessEnv, host: string): NodeGatewayConfig {
  const serviceMap: NodeGatewayConfig['serviceMap'] = {};
  const raw = env.SERVICE_MAP;
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('SERVICE_MAP must be valid JSON');
    }
    if (isRecord(parsed)) {
      for (const [hostname, entry] of Object.entries(parsed)) {
        const value = isRecord(entry) ? entry : { port: entry };
        const port = asPort(value.port);
        if (port === null || !validPort(port)) {
          throw new Error(`SERVICE_MAP has an invalid port for ${hostname}`);
        }
        const listen = value.listen !== undefined ? asPort(value.listen) : null;
        serviceMap[hostname] = {
          port: String(port),
          accessMode: value.accessMode === 'ticket' ? 'ticket' : 'proxy',
          ...(listen !== null && validPort(listen) ? { listen } : {})
        };
      }
    }
  }
  const requireEnv = (name: string): string => {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} is required when CONFIG_FILE is not set`);
    }
    return value.trim();
  };
  return {
    uglinkId: requireEnv('UGLINK_ID'),
    username: requireEnv('USERNAME'),
    password: requireEnv('PASSWORD'),
    sessionNamespace: env.SESSION_NAMESPACE?.trim() || 'default',
    setupMode: env.SETUP_MODE === 'true',
    host,
    serviceMap
  };
}
