import { proxyFailureCode } from '../../domain/proxy/errors';
import {
  parseServiceMap,
  requestHostname,
  resolveServiceRoute,
  type ServiceRoute
} from '../../domain/proxy/routing';
import type {
  GatewayLogger,
  ProxySessionService,
  ProxyTicketReuseService,
  ProxyTicketService,
  ProxyTransport
} from './ports';

const HEALTH_PATH = '/.well-known/uglink-worker-health';
const TICKET_PATH = '/__uglink/ticket';
const TICKET_SCRIPT_PATH = '/__uglink/ticket.js';
const VISITOR_COOKIE = 'uglink_v';
const REUSE_TTL_DISPLAY = '30 分钟';
const REPLAY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HTML_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://*.ug.link https://*.ugdocker.link; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff'
};
const TICKET_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'NAS 登录凭据无效。',
  account_locked: 'NAS 账号已被锁定。',
  login_source_blocked: '当前登录来源被 NAS 限制。',
  account_blocked: 'NAS 账号暂时无法登录。',
  password_expired: 'NAS 登录密码已经过期。',
  otp_required: '当前账号启用了二次验证，暂不支持绿联跳转模式。',
  authentication_backoff: '另一位访问者正在登录绿联，页面会自动重试，无需手动刷新。',
  authentication_timeout: '登录 NAS 超时，请稍后再试。',
  authentication_unavailable: '暂时无法连接 NAS，请稍后再试。',
  authentication_failed: '登录 NAS 失败，请稍后再试。'
};
const TICKET_RETRY_MAX = 20;
const TICKET_RETRY_DELAY_SECONDS = 15;

export interface GatewayRuntime {
  serviceMap: string;
  setupMode: boolean;
}

export interface GatewayDependencies {
  sessions: ProxySessionService;
  tickets: ProxyTicketService;
  ticketReuse: ProxyTicketReuseService;
  transport: ProxyTransport;
  logger: GatewayLogger;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlResponse(request: Request, html: string, status = 200): Response {
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: HTML_HEADERS
  });
}

function readVisitorId(request: Request): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)uglink_v=([a-zA-Z0-9-]{8,64})/u);
  return match?.[1] ?? null;
}

function visitorIdFor(request: Request): { id: string; isNew: boolean } {
  const existing = readVisitorId(request);
  return existing ? { id: existing, isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

function visitorCookie(request: Request, visitorId: string): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${VISITOR_COOKIE}=${visitorId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
}

function ticketRedirect(location: string, request: Request, visitorId: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      'Cache-Control': 'no-store',
      Location: location,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Set-Cookie': visitorCookie(request, visitorId)
    }
  });
}

function ticketPage(
  request: Request,
  hostname: string,
  error?: string,
  status = 200,
  options: {
    force?: boolean;
    autoRetry?: { attempt: number; max: number; delaySeconds: number };
  } = {}
): Response {
  const message = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';
  const autoRetry = options.autoRetry;
  const action = autoRetry
    ? `${TICKET_PATH}?retry=${autoRetry.attempt}`
    : options.force ? `${TICKET_PATH}?force=1` : TICKET_PATH;
  const retryHint = autoRetry
    ? `<p class="retry-status" id="retry-status" role="status">另一位访问者正在登录绿联，约 <span id="retry-countdown">${autoRetry.delaySeconds}</span> 秒后自动重试（第 ${autoRetry.attempt}/${autoRetry.max} 次），无需手动刷新。</p>`
    : '';
  return htmlResponse(request, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>打开 NAS 服务</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; color: #10233f; background: #f4f8fd; }
    main { width: min(100%, 520px); padding: 40px; border: 1px solid #dbe5f0; border-radius: 28px; background: #fff; box-shadow: 0 24px 70px rgba(24, 52, 88, 0.1); }
    .eyebrow { margin: 0 0 12px; color: #5b7190; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(28px, 6vw, 40px); line-height: 1.12; }
    p { color: #5b7190; line-height: 1.7; }
    strong { color: #10233f; overflow-wrap: anywhere; }
    form { margin: 28px 0 18px; }
    button { width: 100%; min-height: 52px; border: 0; border-radius: 16px; color: #fff; background: #2563eb; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .hint { margin-bottom: 0; font-size: 13px; }
    .error { padding: 12px 14px; border-radius: 12px; color: #9f2d20; background: #fff1ee; font-size: 14px; }
    .retry-status { padding: 12px 14px; border-radius: 12px; color: #1d4ed8; background: #eff5ff; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">UGLINK WORKER</p>
    <h1>打开 NAS 服务</h1>
    <p><strong>${escapeHtml(hostname)}</strong> 使用绿联跳转。点击后会签发一次性登录链接，并跳转到绿联中继域名。</p>
    ${message}
    ${retryHint}
    <form method="post" action="${action}" id="ticket-form"${autoRetry ? ` data-auto-retry-delay="${autoRetry.delaySeconds}" data-auto-retry-attempt="${autoRetry.attempt}" data-auto-retry-max="${autoRetry.max}"` : ''}>
      <button type="submit">打开服务</button>
    </form>
    <p class="hint">同一设备 ${REUSE_TTL_DISPLAY} 内重复打开会直接复用跳转，无需重新登录；换设备或链接失效时点此<a href="/?force=1">强制重新签发</a>。</p>
  </main>
  <script src="${TICKET_SCRIPT_PATH}" defer></script>
</body>
</html>`, status);
}

function ticketFailureResponse(request: Request, hostname: string, error: unknown): Response {
  const code = proxyFailureCode(error) ?? 'ticket_unavailable';
  const message = TICKET_ERROR_MESSAGES[code] ?? '暂时无法签发登录链接，请稍后再试。';
  const response = ticketPage(request, hostname, message, 502);
  response.headers.set('X-UGLINK-Error', code);
  return response;
}

function ticketBackoffResponse(
  request: Request,
  hostname: string,
  attempt: number
): Response {
  const response = ticketPage(
    request,
    hostname,
    TICKET_ERROR_MESSAGES.authentication_backoff,
    503,
    {
      autoRetry: {
        attempt,
        max: TICKET_RETRY_MAX,
        delaySeconds: TICKET_RETRY_DELAY_SECONDS
      }
    }
  );
  response.headers.set('X-UGLINK-Error', 'authentication_backoff');
  return response;
}

function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;

  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return true;

  try {
    return new URL(origin).origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

async function ticketIssuanceResponse(
  request: Request,
  hostname: string,
  route: ServiceRoute,
  dependencies: GatewayDependencies
): Promise<Response> {
  if (request.method !== 'POST') {
    const response = ticketPage(request, hostname, '请从入口页点击“打开服务”重新签发。', 405);
    response.headers.set('Allow', 'POST');
    return response;
  }
  if (isCrossOrigin(request)) {
    const response = ticketPage(request, hostname, '请求来源校验失败，请从服务入口页重新打开后再试。', 403);
    response.headers.set('X-UGLINK-Error', 'invalid_origin');
    return response;
  }

  const { id: visitorId } = visitorIdFor(request);
  const url = new URL(request.url);
  const force = url.searchParams.has('force');
  const retryAttemptRaw = Number(url.searchParams.get('retry') ?? '0');
  const retryAttempt = Number.isFinite(retryAttemptRaw) && retryAttemptRaw > 0
    ? Math.floor(retryAttemptRaw)
    : 0;
  try {
    if (!force) {
      const cached = await dependencies.ticketReuse.get(visitorId, route.port);
      if (cached) {
        dependencies.logger.info({ event: 'ticket_reused', hostname, port: route.port });
        return ticketRedirect(cached, request, visitorId);
      }
    }
    const ticket = await dependencies.tickets.issue(route.port);
    await dependencies.ticketReuse.put(visitorId, route.port, ticket.url);
    return ticketRedirect(ticket.url, request, visitorId);
  } catch (error) {
    dependencies.logger.error({
      event: 'ticket_issue_failed',
      hostname,
      port: route.port,
      attempt: retryAttempt,
      error: error instanceof Error ? error.message : String(error)
    });
    // Backoff pages auto-retry so the visitor does not need to refresh manually.
    if (proxyFailureCode(error) === 'authentication_backoff' && retryAttempt < TICKET_RETRY_MAX) {
      const response = ticketBackoffResponse(request, hostname, retryAttempt + 1);
      response.headers.set('Set-Cookie', visitorCookie(request, visitorId));
      return response;
    }
    const response = ticketFailureResponse(request, hostname, error);
    response.headers.set('Set-Cookie', visitorCookie(request, visitorId));
    return response;
  }
}

function canReplayAutomatically(request: Request): boolean {
  return REPLAY_SAFE_METHODS.has(request.method) && request.body === null;
}

function jsonResponse(request: Request, value: unknown, status = 200): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(value), { status, headers });
}

function setupResponse(request: Request): Response {
  return jsonResponse(request, {
    status: 'setup_required',
    message: 'Configure uglink.config.json and deploy again.'
  });
}

function proxySessionResponse(request: Request, retryable: boolean): Response {
  const status = retryable ? 503 : 502;
  const code = retryable ? 'proxy_session_expired' : 'proxy_session_unavailable';
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-UGLINK-Error': code
  });
  if (retryable) headers.set('Retry-After', '0');
  const body = request.method === 'HEAD' ? null : JSON.stringify({
    error: code,
    message: retryable
      ? 'UGREEN proxy session expired. Retry the request.'
      : 'UGREEN proxy session could not be established.'
  });
  return new Response(body, { status, headers });
}

export async function handleGatewayRequest(
  request: Request,
  runtime: GatewayRuntime,
  dependencies: GatewayDependencies
): Promise<Response> {
  let services: Map<string, ServiceRoute>;
  try {
    services = parseServiceMap(runtime.serviceMap);
  } catch (error) {
    dependencies.logger.error({
      event: 'invalid_service_map',
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response('Worker service configuration is invalid', { status: 500 });
  }

  const hostname = requestHostname(request);
  const route = resolveServiceRoute(services, hostname);
  const setupMode = runtime.setupMode || services.size === 0;
  const pathname = new URL(request.url).pathname;

  if (pathname === HEALTH_PATH) {
    return jsonResponse(request, {
      status: 'ok',
      mode: setupMode ? 'setup' : 'active',
      hostnameConfigured: Boolean(route),
      serviceCount: services.size
    });
  }
  if (setupMode) return setupResponse(request);
  if (!route) return new Response('Service not configured for this hostname', { status: 404 });

  if (route.accessMode === 'ticket') {
    if (pathname === TICKET_SCRIPT_PATH) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
      }
      return new Response(request.method === 'HEAD' ? null : [
        '// Auto-submit the ticket form so visitors land directly on the relay.',
        '// Error pages include a .error element and skip auto-submission,',
        '// except backoff pages marked with data-auto-retry-delay: those show a',
        '// countdown and resubmit automatically while the throttle window passes.',
        'var form = document.getElementById("ticket-form");',
        'if (!document.querySelector(".error")) {',
        '  if (form) form.submit();',
        '} else if (form && form.dataset.autoRetryDelay) {',
        '  var delay = parseInt(form.dataset.autoRetryDelay, 10) || 15;',
        '  var attempt = parseInt(form.dataset.autoRetryAttempt, 10) || 1;',
        '  var max = parseInt(form.dataset.autoRetryMax, 10) || 20;',
        '  var status = document.getElementById("retry-status");',
        '  var counter = document.getElementById("retry-countdown");',
        '  if (attempt > max) {',
        '    if (status) status.textContent = "多次自动重试仍未成功，请稍后手动点击下方按钮再试。";',
        '  } else {',
        '    var left = delay;',
        '    var timer = setInterval(function () {',
        '      left -= 1;',
        '      if (counter) counter.textContent = String(Math.max(left, 0));',
        '      if (left <= 0) { clearInterval(timer); form.submit(); }',
        '    }, 1000);',
        '  }',
        '}'
      ].join('\n'), {
        status: 200,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/javascript; charset=utf-8',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    }
    if (pathname === TICKET_PATH) {
      return ticketIssuanceResponse(request, hostname, route, dependencies);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const force = new URL(request.url).searchParams.has('force');
      return ticketPage(request, hostname, undefined, 200, { force });
    }
    return new Response('Method not allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }
    });
  }

  const port = route.port;
  try {
    let session = await dependencies.sessions.get(port);
    let response: Response;
    try {
      response = await dependencies.transport.send(request, session);
    } catch {
      await dependencies.sessions.invalidate(port);
      dependencies.logger.info({ event: 'proxy_upstream_unavailable', hostname, port, method: request.method });
      if (!canReplayAutomatically(request)) return proxySessionResponse(request, false);
      session = await dependencies.sessions.refresh(port);
      try {
        response = await dependencies.transport.send(request, session);
      } catch (error) {
        await dependencies.sessions.invalidate(port);
        throw error;
      }
    }

    if (dependencies.transport.isSessionExpired(response, session)) {
      await response.body?.cancel();
      dependencies.logger.info({ event: 'proxy_session_expired', hostname, port, method: request.method });

      if (!canReplayAutomatically(request)) {
        await dependencies.sessions.invalidate(port);
        return proxySessionResponse(request, true);
      }

      session = await dependencies.sessions.refresh(port);
      try {
        response = await dependencies.transport.send(request, session);
      } catch (error) {
        await dependencies.sessions.invalidate(port);
        throw error;
      }
      if (dependencies.transport.isSessionExpired(response, session)) {
        await response.body?.cancel();
        await dependencies.sessions.invalidate(port);
        return proxySessionResponse(request, false);
      }
    }
    return response;
  } catch (error) {
    const failureCode = proxyFailureCode(error);
    dependencies.logger.error({
      event: 'proxy_request_failed',
      hostname,
      port,
      error: error instanceof Error ? error.message : String(error)
    });
    return new Response('Upstream proxy request failed', {
      status: 502,
      headers: failureCode ? { 'X-UGLINK-Error': failureCode } : undefined
    });
  }
}
