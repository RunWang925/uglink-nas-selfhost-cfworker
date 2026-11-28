import { platformContext, type ExternalRequestContext } from './request-context';
import { connectCloudflare } from '../../../application/console/connection-service';
import { createBackupService } from '../../../application/console/backup-service';
import { createConfigurationService } from '../../../application/console/configuration-service';
import type {
  BackupPassphraseRequest,
  BackupRestoreRequest,
  BootstrapResponse,
  CloudflareConnectionRequest,
  ConfigurationImportRequest,
  DeployRequest,
  ProviderStatus
} from '../../../application/console/contracts';
import { createDeploymentService } from '../../../application/console/deployment-service';
import { ApplicationError } from '../../../application/common/application-error';
import type { UglinkConfig } from '../../../domain/configuration/model';
import type { DeploymentJob, DiagnosticEntry, ServiceHealth } from '../../../domain/deployment/model';
import { validateUglinkConfig } from '../../../domain/configuration/validation';
import { ProxyAuthenticationError } from '../../../domain/proxy/errors';
import { MemoryTtlCache } from '../../../infrastructure/persistence/memory-ttl-cache';
import { verifyUgreenCredentials, type UgreenSessionRuntime } from '../../../infrastructure/ugreen/session-service';
import {
  cloudflareConnectionProvider,
  createCloudflareDeploymentProvider
} from '../../../infrastructure/cloudflare/api-client';
import { createRuntimeLogStream } from '../../../infrastructure/cloudflare/runtime-log-stream';
import { createContainerLogStream } from '../../../infrastructure/logging/container-log-stream';
import { httpServiceHealthChecker } from '../../../infrastructure/health/http-service-health-checker';
import {
  applySessionCookie,
  assertCsrf,
  getOrCreateSession,
  saveSession,
  type AccessMode,
  type SessionHandle
} from '../../../infrastructure/persistence/console-session';
import { createKvDeploymentJobRepository } from '../../../infrastructure/persistence/kv-deployment-job-repository';
import { createKvDiagnosticLogRepository } from '../../../infrastructure/persistence/kv-diagnostic-log-repository';
import { createKvConfigurationRepository } from '../../../infrastructure/persistence/kv-configuration-repository';
import { portableBackupCipher } from '../../../infrastructure/security/portable-backup';
import { randomToken } from '../../../infrastructure/security/session-crypto';
import {
  getAuthState,
  setConsolePassword,
  verifyConsolePassword
} from '../../../infrastructure/security/console-auth';
import { redactDeployment, redactDiagnostic, redactHealth } from '../../../domain/logging/redact-records';
import { apiError, assertSameOrigin, json, readJson } from '../http';
import type { ConsoleWorkerEnv } from './environment';

function safeDiagnostic(entry: DiagnosticEntry, session: SessionHandle): DiagnosticEntry {
  return redactDiagnostic(entry, [session.data.cloudflare?.apiToken ?? '']);
}

function safeHealth(service: ServiceHealth, session: SessionHandle): ServiceHealth {
  return redactHealth(service, [session.data.cloudflare?.apiToken ?? '']);
}

function safeDeployment(job: DeploymentJob, session: SessionHandle): DeploymentJob {
  return redactDeployment(job, [session.data.cloudflare?.apiToken ?? '']);
}

function providerStatus(connected: boolean, label?: string, detail?: string): ProviderStatus {
  return connected
    ? { state: 'connected', ...(label ? { label } : {}), ...(detail ? { detail } : {}) }
    : { state: 'disconnected' };
}

function nasAuthenticationMessage(apiCode: ProxyAuthenticationError['apiCode']): string {
  if (typeof apiCode === 'number') {
    switch (apiCode) {
      case 1003:
      case 1205:
        return '用户名或密码错误。';
      case 1120:
        return '账号已锁定，请稍后再试。';
      case 1113:
        return '当前登录来源受限，请稍后再试。';
      case 1000:
      case 1001:
        return '账号已被停用。';
      case 1206:
        return '密码已过期，请先在绿联账号中修改。';
      default:
        return `绿联登录失败（代码 ${apiCode}）。`;
    }
  }
  switch (apiCode) {
    case 'otp_required':
      return '登录需要验证码，请先处理绿联账号的安全验证。';
    case 'backoff':
      return '登录尝试过于频繁，请约 5 分钟后再试。';
    case 'timeout':
      return '连接绿联服务超时，请稍后重试。';
    case 'unavailable':
      return '绿联认证服务暂不可用，请稍后重试。';
    default:
      return '绿联登录验证失败，请核对凭据。';
  }
}

function connectionProvider(env: ConsoleWorkerEnv) {
  return {
    ...cloudflareConnectionProvider,
    connect(accountId: string, apiToken: string) {
      env.CONTAINER_LOGS?.registerSecrets([apiToken]);
      return cloudflareConnectionProvider.connect(accountId, apiToken);
    }
  };
}

async function bootstrap(env: ConsoleWorkerEnv, session: SessionHandle): Promise<BootstrapResponse> {
  const { state: authState } = await getAuthState(env, session.data);
  // Before a password is configured (needs_setup) the console is open, so it
  // behaves as unlocked. Only a set-but-not-unlocked session is gated.
  const unlocked = authState !== 'locked';
  // While the console is locked, never leak the stored Cloudflare target,
  // configuration, or pending service list.
  const connection = unlocked ? session.data.cloudflare : undefined;
  const target = unlocked ? session.data.target : undefined;
  const cloudflareReady = Boolean(connection && target);
  // Sessions created before access routes existed may lack accessMode. Infer
  // the route so returning users keep their previous behaviour.
  const accessMode = session.data.accessMode
    ?? (cloudflareReady ? 'cloudflare' : 'setup');
  const authenticated = unlocked && (accessMode === 'server'
    ? true
    : accessMode === 'cloudflare' && cloudflareReady);
  const cloudflare = providerStatus(
    Boolean(connection),
    connection?.account.name,
    target ? `服务 · ${target.workerName}` : undefined
  );
  const configuration = unlocked && target
    ? await createConfigurationService(
      createKvConfigurationRepository(env.CONSOLE_SESSIONS, target)
    ).read()
    : undefined;
  return {
    title: env.CONSOLE_TITLE || 'UGLINK Control',
    authenticated,
    accessMode,
    authState,
    csrfToken: session.data.csrfToken,
    providers: { cloudflare },
    ...(unlocked && session.data.pendingCloudConfiguration ? {
      cloudConfiguration: {
        serviceCount: session.data.pendingCloudConfiguration.services.length
      }
    } : {}),
    ...(unlocked && target && configuration ? {
      target: {
        ...target,
        accountIdSuffix: target.accountId.slice(-6)
      },
      configuration
    } : {})
  };
}

function deploymentService(env: ConsoleWorkerEnv, session: SessionHandle) {
  const connection = session.data.cloudflare;
  const target = session.data.target;
  if (!connection || !target) {
    throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
  }
  return createDeploymentService({
    target,
    provider: createCloudflareDeploymentProvider(connection.apiToken),
    jobs: createKvDeploymentJobRepository(env.CONSOLE_SESSIONS, session.id, [connection.apiToken]),
    diagnostics: createKvDiagnosticLogRepository(env.CONSOLE_SESSIONS, session.id, target, [connection.apiToken]),
    configuration: createKvConfigurationRepository(env.CONSOLE_SESSIONS, target),
    health: httpServiceHealthChecker,
    tokens: { create: randomToken }
  });
}

async function connect(
  env: ConsoleWorkerEnv,
  session: SessionHandle,
  request: CloudflareConnectionRequest
): Promise<BootstrapResponse> {
  const result = await connectCloudflare(request, connectionProvider(env));
  session.data.cloudflare = result.connection;
  session.data.target = result.target;
  session.data.accessMode = 'cloudflare';
  if (result.deployedConfiguration) {
    session.data.pendingCloudConfiguration = result.deployedConfiguration;
  } else {
    delete session.data.pendingCloudConfiguration;
  }
  await saveSession(env, session);
  return bootstrap(env, session);
}

const AUTH_ENDPOINTS = new Set(['/api/auth/setup', '/api/auth/login', '/api/auth/logout']);

async function route(request: Request, env: ConsoleWorkerEnv, session: SessionHandle, context: ExternalRequestContext): Promise<Response> {
  const { pathname } = new URL(request.url);

  // ---- Access password endpoints (available regardless of lock state) ----
  if (request.method === 'POST' && pathname === '/api/auth/setup') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const { state } = await getAuthState(env, session.data);
    if (state !== 'needs_setup') {
      throw new ApplicationError(409, 'auth_already_set', '访问密码已设置，无需重复设置。');
    }
    const body = await readJson<{ password?: string }>(request, 4_096);
    await setConsolePassword(env, body.password ?? '');
    session.data.authValidAt = Date.now();
    await saveSession(env, session);
    return json(await bootstrap(env, session));
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const { state } = await getAuthState(env, session.data);
    if (state === 'needs_setup') {
      throw new ApplicationError(409, 'auth_not_set', '尚未设置访问密码。');
    }
    const body = await readJson<{ password?: string }>(request, 4_096);
    if (!await verifyConsolePassword(env, body.password ?? '')) {
      throw new ApplicationError(401, 'invalid_password', '访问密码错误，请重试。');
    }
    session.data.authValidAt = Date.now();
    await saveSession(env, session);
    return json(await bootstrap(env, session));
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    delete session.data.authValidAt;
    await saveSession(env, session);
    return json({ status: 'ok' });
  }

  if (request.method === 'POST' && pathname === '/api/auth/change-password') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request, 2_048);
    const current = body.currentPassword ?? '';
    const next = body.newPassword ?? '';
    if (!current || !next) {
      throw new ApplicationError(400, 'missing_password', '请填写当前密码和新密码。');
    }
    if (next.length < 6) {
      throw new ApplicationError(422, 'password_too_short', '新密码至少需要 6 个字符。');
    }
    if (!(await verifyConsolePassword(env, current))) {
      throw new ApplicationError(401, 'invalid_password', '当前密码不正确。');
    }
    const record = await setConsolePassword(env, next);
    // Keep this session unlocked; every other session is now stale.
    session.data.authValidAt = record.changedAt;
    await saveSession(env, session);
    return json(await bootstrap(env, session));
  }

  if (request.method === 'GET' && pathname === '/api/bootstrap') {
    return json(await bootstrap(env, session));
  }

  // ---- Gate: once a password is set, every other API requires an unlocked
  // session. Before setup (needs_setup) everything stays open so the user can
  // complete first-time configuration and set the password. ----
  if (!AUTH_ENDPOINTS.has(pathname)) {
    const { state } = await getAuthState(env, session.data);
    if (state === 'locked') {
      throw new ApplicationError(401, 'console_locked', '控制台已锁定，请先输入访问密码。');
    }
  }

  if (request.method === 'POST' && pathname === '/api/connections/cloudflare') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<CloudflareConnectionRequest>(request, 8_192);
    return json(await connect(env, session, body));
  }

  if (request.method === 'POST' && pathname === '/api/connections/mode') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<{ accessMode?: string }>(request, 1_024);
    if (body.accessMode !== 'cloudflare' && body.accessMode !== 'server') {
      throw new ApplicationError(400, 'invalid_access_mode', '访问路线必须是 cloudflare 或 server。');
    }
    // Switching to server-only must not leave a stale CF target that would
    // re-enable CF-dependent panels; switching to cloudflare without a live
    // connection simply lands back on the connect screen.
    session.data.accessMode = body.accessMode as AccessMode;
    await saveSession(env, session);
    return json(await bootstrap(env, session));
  }

  if (request.method === 'POST' && pathname === '/api/nas/verify') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<{ id?: string; username?: string; password?: string }>(request, 4_096);
    const id = body.id?.trim() ?? '';
    const username = body.username?.trim() ?? '';
    const password = body.password ?? '';
    if (!id || !username || !password) {
      throw new ApplicationError(400, 'missing_nas_credentials', '请填写 UGREENlink ID、登录用户名和密码。');
    }
    const runtime: UgreenSessionRuntime = {
      uglinkId: id,
      username,
      password,
      sessionNamespace: 'verify',
      cache: new MemoryTtlCache()
    };
    try {
      await verifyUgreenCredentials(runtime);
      return json({ ok: true });
    } catch (error) {
      if (error instanceof ProxyAuthenticationError) {
        throw new ApplicationError(422, String(error.apiCode), nasAuthenticationMessage(error.apiCode));
      }
      throw error;
    }
  }

  if (request.method === 'POST' && pathname === '/api/validate') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    deploymentService(env, session);
    const body = await readJson<{ config?: UglinkConfig }>(request);
    return json(validateUglinkConfig(body.config));
  }

  if (request.method === 'POST' && pathname === '/api/configuration/draft') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const target = session.data.target;
    if (!target) throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    const body = await readJson<ConfigurationImportRequest>(request);
    const service = createConfigurationService(createKvConfigurationRepository(env.CONSOLE_SESSIONS, target));
    return json(await service.saveDraft(body.config));
  }

  if (request.method === 'POST' && pathname === '/api/configuration/cloud/import') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const target = session.data.target;
    const cloudConfiguration = session.data.pendingCloudConfiguration;
    if (!target || !cloudConfiguration) {
      throw new ApplicationError(409, 'cloudflare_configuration_unavailable', '没有等待导入的 Cloudflare 配置。');
    }
    await createConfigurationService(
      createKvConfigurationRepository(env.CONSOLE_SESSIONS, target)
    ).saveDeployed(cloudConfiguration);
    delete session.data.pendingCloudConfiguration;
    await saveSession(env, session);
    return json(await bootstrap(env, session));
  }

  if (request.method === 'POST' && pathname === '/api/configuration/cloud/dismiss') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    delete session.data.pendingCloudConfiguration;
    await saveSession(env, session);
    return json({ ok: true });
  }

  if (request.method === 'POST' && pathname === '/api/deploy') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<DeployRequest>(request);
    return json(safeDeployment(await deploymentService(env, session).createDeployment(body), session), { status: 202 });
  }

  if (request.method === 'POST' && pathname === '/api/services/health') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<{ config?: UglinkConfig }>(request);
    const health = await deploymentService(env, session).checkPublishedServices(body.config);
    return json({ ...health, services: health.services.map((service) => safeHealth(service, session)) });
  }

  if (request.method === 'GET' && pathname === '/api/diagnostics') {
    return json({ entries: (await deploymentService(env, session).listDiagnostics()).map((entry) => safeDiagnostic(entry, session)) });
  }

  if (request.method === 'POST' && pathname === '/api/diagnostics/stream') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const connection = session.data.cloudflare;
    const target = session.data.target;
    if (!connection || !target) {
      throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    }
    return createRuntimeLogStream({ apiToken: connection.apiToken, target, signal: request.signal });
  }

  if (request.method === 'POST' && pathname === '/api/diagnostics/container-stream') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    if (!session.data.cloudflare || !session.data.target) {
      throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    }
    return createContainerLogStream({ source: env.CONTAINER_LOGS, signal: request.signal,
      afterId: request.headers.get('last-event-id') ?? undefined });
  }

  if (request.method === 'POST' && pathname === '/api/backups/export') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const connection = session.data.cloudflare;
    const target = session.data.target;
    if (!connection || !target) {
      throw new ApplicationError(401, 'cloudflare_not_connected', '请先配置 Cloudflare API Token。');
    }
    const body = await readJson<BackupPassphraseRequest>(request, 4_096);
    const configurationRepository = createKvConfigurationRepository(env.CONSOLE_SESSIONS, target);
    const diagnostics = createKvDiagnosticLogRepository(env.CONSOLE_SESSIONS, session.id, target);
    const configuration = await createConfigurationService(configurationRepository).read();
    const backup = createBackupService(portableBackupCipher, connectionProvider(env));
    return json(await backup.exportBackup({
      connection,
      target,
      configuration: {
        version: 1,
        deployed: configuration.deployed,
        ...(configuration.draft ? { draft: configuration.draft } : {}),
        updatedAt: configuration.updatedAt
      },
      diagnostics: await diagnostics.list(100)
    }, body.passphrase));
  }

  if (request.method === 'POST' && pathname === '/api/backups/restore') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<BackupRestoreRequest>(request, 1_048_576);
    const backup = createBackupService(portableBackupCipher, connectionProvider(env));
    const restored = await backup.restoreBackup(body.backup, body.passphrase);
    session.data.cloudflare = restored.connection;
    session.data.target = restored.target;
    const configuration = createConfigurationService(
      createKvConfigurationRepository(env.CONSOLE_SESSIONS, restored.target)
    );
    const diagnostics = createKvDiagnosticLogRepository(
      env.CONSOLE_SESSIONS,
      session.id,
      restored.target,
      [restored.connection.apiToken]
    );
    await Promise.all([
      configuration.replace(restored.configuration),
      diagnostics.replace(restored.diagnostics),
      saveSession(env, session)
    ]);
    return json(await bootstrap(env, session));
  }

  const deploymentMatch = pathname.match(/^\/api\/deployments\/([A-Za-z0-9_-]{12,80})$/u);
  if (request.method === 'GET' && deploymentMatch?.[1]) {
    return json(safeDeployment(await deploymentService(env, session).refreshDeployment(deploymentMatch[1]), session));
  }

  if (request.method === 'POST' && pathname === '/api/connections/cloudflare/reset') {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    delete session.data.cloudflare;
    delete session.data.target;
    delete session.data.pendingCloudConfiguration;
    // Returning to the connect screen requires no active route.
    if (session.data.accessMode === 'cloudflare') delete session.data.accessMode;
    await saveSession(env, session);
    return json({ ok: true });
  }

  if (request.method === 'POST' && pathname.startsWith('/api/server-gateway/')) {
    assertSameOrigin(request, context.externalOrigin);
    assertCsrf(request, session);
    const body = await readJson<ServerGatewayProxyRequest>(request, 262_144);
    const action = pathname.slice('/api/server-gateway/'.length);
    return json(await proxyServerGateway(action, body));
  }
  throw new ApplicationError(404, 'not_found', '找不到这个 API。');
}

interface ServerGatewayProxyRequest {
  baseUrl?: string;
  adminToken?: string;
  unlockToken?: string;
  config?: Record<string, unknown>;
}

const SERVER_GATEWAY_ACTIONS = new Set(['pull', 'push', 'status']);

async function proxyServerGateway(action: string, body: ServerGatewayProxyRequest): Promise<unknown> {
  if (!SERVER_GATEWAY_ACTIONS.has(action)) {
    throw new ApplicationError(404, 'not_found', '未知的网关操作。');
  }
  const base = (body.baseUrl ?? '').trim().replace(/\/+$/u, '');
  if (!base || !/^https?:\/\/[^\s/]+(?::\d+)?$/iu.test(base)) {
    throw new ApplicationError(400, 'invalid_base_url', '服务器地址必须是 http(s)://主机[:端口] 形式，且不含路径。');
  }
  if (!body.adminToken?.trim()) {
    throw new ApplicationError(400, 'missing_token', '缺少服务器网关访问令牌。');
  }
  const headers: Record<string, string> = {
    'X-Admin-Token': body.adminToken.trim(),
    Accept: 'application/json'
  };
  let path = '/api/status';
  let init: { method: 'GET' | 'PUT'; body?: string } = { method: 'GET' };
  if (action === 'pull') {
    path = '/api/config';
  } else if (action === 'push') {
    if (!body.unlockToken?.trim()) {
      throw new ApplicationError(400, 'missing_unlock', '缺少服务器网关编辑解锁令牌。');
    }
    path = '/api/config';
    // The gateway validates the full stored config, so merge the pushed
    // services over the currently stored credentials instead of requiring
    // the console to re-send them.
    const currentResponse = await fetch(`${base}/api/config`, { headers, signal: AbortSignal.timeout(15_000) });
    const currentConfig = await currentResponse.json().catch(() => ({}) as Record<string, unknown>);
    const merged = { ...(currentConfig as Record<string, unknown>), ...(body.config ?? {}) };
    delete (merged as Record<string, unknown>).traffic;
    delete (merged as Record<string, unknown>).configured;
    delete (merged as Record<string, unknown>).hasPassword;
    init = { method: 'PUT', body: JSON.stringify(merged) };
    headers['Content-Type'] = 'application/json';
    headers['X-Admin-Unlock'] = body.unlockToken.trim();
  }
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ApplicationError(502, 'server_gateway_unreachable',
      `无法连接服务器网关：${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = await response.json().catch(() => ({}) as Record<string, unknown>);
  if (!response.ok) {
    const detail = typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `HTTP ${response.status}`;
    throw new ApplicationError(response.status === 401 || response.status === 403 ? 403 : 502,
      'server_gateway_error', `服务器网关拒绝请求：${detail}`);
  }
  return payload;
}

export async function handleConsoleRequest(request: Request, env: ConsoleWorkerEnv, context: ExternalRequestContext): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/api/health') return json({ status: 'ok' });
  // Custom browser-origin headers must never become usable cross-origin.
  if (request.method === 'OPTIONS') return json({ error: { code: 'method_not_allowed', message: '不支持跨来源访问。' } }, { status: 405 });
  const cookieOptions = { secure: context.secureCookies, refresh: request.method === 'GET' && pathname === '/api/bootstrap' };
  let session: SessionHandle | undefined;
  try {
    session = await getOrCreateSession(request, env, {
      origin: context.externalOrigin,
      bindOrigin: context.source === 'browser'
    });
    env.CONTAINER_LOGS?.registerSecrets([session.data.cloudflare?.apiToken ?? '']);
    return applySessionCookie(request, await route(request, env, session, context), session, cookieOptions);
  } catch (error) {
    const response = apiError(error);
    return session ? applySessionCookie(request, response, session, cookieOptions) : response;
  }
}

export default {
  async fetch(request: Request, env: ConsoleWorkerEnv): Promise<Response> {
    return handleConsoleRequest(request, env, platformContext(request));
  }
} satisfies ExportedHandler<ConsoleWorkerEnv>;
