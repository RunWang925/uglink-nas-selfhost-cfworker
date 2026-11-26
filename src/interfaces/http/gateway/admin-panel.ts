import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { TrafficSnapshot } from '../../../infrastructure/monitoring/traffic-stats';
import type { NodeGatewayStoredConfig } from './node-config';

const MAX_BODY_BYTES = 262_144;

export interface AdminStatusService {
  name: string;
  nasPort: number;
  serverPort: number;
  accessMode: string;
  listening: boolean;
}

export interface AdminPanelOptions {
  port: number;
  token: string;
  getStored: () => NodeGatewayStoredConfig | null;
  applyConfig: (config: NodeGatewayStoredConfig) => { ok: true };
  getTraffic: () => TrafficSnapshot;
  logger: {
    info(event: Record<string, unknown>): void;
    error(event: Record<string, unknown>): void;
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function authorized(request: IncomingMessage, url: URL, token: string): boolean {
  const header = request.headers['x-admin-token'];
  if (typeof header === 'string' && header === token) return true;
  return url.searchParams.get('token') === token;
}

function publicConfig(config: NodeGatewayStoredConfig | null, traffic: TrafficSnapshot): Record<string, unknown> {
  if (!config) {
    return { configured: false, services: [], traffic };
  }
  return {
    configured: true,
    uglinkId: config.uglinkId,
    username: config.username,
    hasPassword: config.password.length > 0,
    sessionNamespace: config.sessionNamespace,
    trafficMonthlyThresholdGb: config.trafficMonthlyThresholdGb,
    services: config.services,
    traffic
  };
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UGLINK 自托管网关</title>
<style>
  :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #f4f8fd; color: #10233f; }
  main { max-width: 960px; margin: 0 auto; display: grid; gap: 20px; }
  h1 { margin: 0; font-size: 24px; }
  h2 { margin: 0 0 12px; font-size: 16px; }
  section { padding: 20px; border: 1px solid #dbe5f0; border-radius: 14px; background: #fff; }
  label { display: block; margin: 10px 0 4px; font-size: 13px; color: #5b7190; }
  input, select { width: 100%; max-width: 320px; padding: 8px 10px; border: 1px solid #c6d4e5; border-radius: 8px; font: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px; border-bottom: 1px solid #e6edf5; text-align: left; }
  th { color: #5b7190; font-weight: 500; font-size: 13px; }
  td input, td select { max-width: 140px; padding: 6px 8px; }
  button { padding: 8px 14px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
  button.ghost { background: #eef3fa; color: #24507c; }
  button.danger { background: #fdecec; color: #a32d2d; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .muted { color: #5b7190; font-size: 13px; }
  .warn { padding: 12px 14px; border-radius: 10px; background: #fff6e0; color: #854f0b; font-size: 14px; margin-bottom: 12px; }
  .stat { font-size: 20px; font-weight: 500; }
  .ok { color: #0f6e56; } .bad { color: #a32d2d; }
  #message { margin-top: 10px; font-size: 13px; min-height: 18px; }
  .error { color: #a32d2d; } .success { color: #0f6e56; }
</style>
</head>
<body>
<main>
  <h1>UGLINK 自托管网关</h1>
  <div id="warn"></div>

  <section>
    <h2>连接设置</h2>
    <label>UGREENlink ID</label><input id="uglinkId" placeholder="绿联远程访问 ID">
    <label>NAS 用户名</label><input id="username" autocomplete="off">
    <label>NAS 密码 <span class="muted">(留空表示不修改)</span></label><input id="password" type="password" autocomplete="new-password">
    <label>会话命名空间</label><input id="sessionNamespace" placeholder="default">
    <label>月流量预警阈值 (GB，留空不预警)</label><input id="threshold" placeholder="例如 100">
  </section>

  <section>
    <h2>端口映射 <span class="muted">— 服务器端口 → NAS 端口</span></h2>
    <table id="services">
      <thead><tr><th>名称</th><th>NAS 端口</th><th>服务器端口</th><th>访问方式</th><th>状态</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="row" style="margin-top:12px">
      <button class="ghost" id="add">添加映射</button>
      <button id="save">保存并生效</button>
      <span class="muted" id="accessHint"></span>
    </div>
    <div id="message"></div>
  </section>

  <section>
    <h2>流量统计</h2>
    <div class="row">
      <div><div class="muted">本月已用</div><div class="stat" id="monthTotal">-</div></div>
      <div><div class="muted">历史累计</div><div class="stat" id="allTotal">-</div></div>
      <div><div class="muted">统计周期</div><div class="stat" id="period">-</div></div>
    </div>
    <table style="margin-top:12px"><thead><tr><th>服务</th><th>本月接收</th><th>本月发出</th><th>合计</th></tr></thead><tbody id="trafficRows"></tbody></table>
    <p class="muted">字节数为近似值：请求/响应头按固定值估算，正文按实际流过字节计。</p>
  </section>
</main>
<script>
  var TOKEN = localStorage.getItem('uglink_admin_token') || '';
  var current = { services: [] };

  function fmt(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }
  function esc(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function setToken(token) { TOKEN = token; localStorage.setItem('uglink_admin_token', token); }
  function msg(text, kind) {
    var el = document.getElementById('message');
    el.textContent = text;
    el.className = kind || '';
  }

  function api(path, options, retried) {
    options = options || {};
    options.headers = Object.assign({ 'X-Admin-Token': TOKEN }, options.headers || {});
    if (options.body) options.headers['Content-Type'] = 'application/json';
    return fetch(path, options).then(function (response) {
      if (response.status === 401 && !retried) {
        var token = prompt('请输入管理面板访问令牌（首次运行可用 docker logs 查看）');
        if (token === null) throw new Error('未提供访问令牌');
        setToken(token);
        return api(path, options, true);
      }
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || data.errors && data.errors.join(' ') || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function serviceRow(entry, status) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td><input class="f-name" value="' + esc(entry.name || '') + '" placeholder="名称"></td>'
      + '<td><input class="f-nas" value="' + esc(entry.nasPort || '') + '" placeholder="9"></td>'
      + '<td><input class="f-server" value="' + esc(entry.serverPort || '') + '" placeholder="9001"></td>'
      + '<td><select class="f-mode"><option value="proxy"' + (entry.accessMode !== 'ticket' ? ' selected' : '') + '>直接代理</option>'
      + '<option value="ticket"' + (entry.accessMode === 'ticket' ? ' selected' : '') + '>票据入口</option></select></td>'
      + '<td class="' + (status && status.listening ? 'ok">● 监听中' : 'bad">● 未监听') + '</td>'
      + '<td><button class="danger" type="button">删除</button></td>';
    tr.querySelector('button').addEventListener('click', function () { tr.remove(); updateHint(); });
    tr.querySelectorAll('input').forEach(function (input) { input.addEventListener('change', updateHint); });
    return tr;
  }

  function readRows() {
    return Array.from(document.querySelectorAll('#services tbody tr')).map(function (tr) {
      return {
        name: tr.querySelector('.f-name').value.trim(),
        nasPort: tr.querySelector('.f-nas').value.trim(),
        serverPort: tr.querySelector('.f-server').value.trim(),
        accessMode: tr.querySelector('.f-mode').value
      };
    });
  }
  function updateHint() {
    var ports = readRows().map(function (row) { return row.serverPort; }).filter(Boolean);
    document.getElementById('accessHint').textContent = ports.length
      ? '保存后即可通过 http://服务器IP:' + ports.join(' 或 http://服务器IP:') + ' 访问'
      : '';
  }

  function renderTraffic(traffic) {
    var monthly = traffic.monthlyTotals.rx + traffic.monthlyTotals.tx;
    document.getElementById('monthTotal').textContent = fmt(monthly);
    document.getElementById('allTotal').textContent = fmt(traffic.allTime.rx + traffic.allTime.tx);
    document.getElementById('period').textContent = traffic.period;
    var rows = document.getElementById('trafficRows');
    rows.innerHTML = traffic.monthlyServices.map(function (item) {
      var total = item.rx + item.tx;
      return '<tr><td>' + esc(item.service) + '</td><td>' + fmt(item.rx) + '</td><td>' + fmt(item.tx) + '</td><td>' + fmt(total) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">暂无流量记录</td></tr>';
    var banner = document.getElementById('warn');
    if (traffic.thresholdExceeded) {
      banner.innerHTML = '<div class="warn">本月流量已超过预警阈值（' + fmt(traffic.thresholdBytes) + '），请检查是否有异常访问。</div>';
    } else {
      banner.innerHTML = '';
    }
  }

  function renderStatus(status) {
    var byName = {};
    (status.services || []).forEach(function (item) { byName[item.name] = item; });
    var tbody = document.querySelector('#services tbody');
    var rows = Array.from(tbody.querySelectorAll('tr'));
    rows.forEach(function (tr, index) {
      var name = tr.querySelector('.f-name').value.trim();
      var cell = tr.cells[4];
      var match = byName[name];
      cell.className = match && match.listening ? 'ok' : 'bad';
      cell.textContent = match && match.listening ? '● 监听中' : '● 未监听';
    });
  }

  function load() {
    return api('/api/config').then(function (data) {
      current = data;
      document.getElementById('uglinkId').value = data.uglinkId || '';
      document.getElementById('username').value = data.username || '';
      document.getElementById('sessionNamespace').value = data.sessionNamespace || 'default';
      document.getElementById('threshold').value = data.trafficMonthlyThresholdGb == null ? '' : data.trafficMonthlyThresholdGb;
      var tbody = document.querySelector('#services tbody');
      tbody.innerHTML = '';
      (data.services || []).forEach(function (entry) { tbody.appendChild(serviceRow(entry, null)); });
      if (!data.configured) {
        msg('尚未配置：请填写连接设置和端口映射后保存。');
      }
      renderTraffic(data.traffic);
      updateHint();
      return api('/api/status').then(renderStatus);
    }).catch(function (error) { msg('加载失败：' + error.message, 'error'); });
  }

  document.getElementById('add').addEventListener('click', function () {
    document.querySelector('#services tbody').appendChild(serviceRow({}, null));
    updateHint();
  });
  document.getElementById('save').addEventListener('click', function () {
    var payload = {
      uglinkId: document.getElementById('uglinkId').value.trim(),
      username: document.getElementById('username').value.trim(),
      password: document.getElementById('password').value,
      sessionNamespace: document.getElementById('sessionNamespace').value.trim() || 'default',
      trafficMonthlyThresholdGb: document.getElementById('threshold').value.trim(),
      services: readRows()
    };
    api('/api/config', { method: 'PUT', body: JSON.stringify(payload) }).then(function (data) {
      document.getElementById('password').value = '';
      msg('已保存并生效。', 'success');
      renderTraffic(data.traffic);
      return api('/api/status').then(renderStatus);
    }).catch(function (error) { msg('保存失败：' + error.message, 'error'); });
  });

  load();
  setInterval(function () {
    api('/api/status').then(function (data) { renderStatus(data); renderTraffic(data.traffic); }).catch(function () {});
  }, 10000);
</script>
</body>
</html>
`;

export function createAdminServer(options: AdminPanelOptions): Server {
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (incoming, outgoing) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      try {
        if (incoming.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          outgoing.statusCode = 200;
          outgoing.setHeader('Content-Type', 'text/html; charset=utf-8');
          outgoing.setHeader('Cache-Control', 'no-store');
          outgoing.end(PANEL_HTML);
          return;
        }

        if (!incoming.url?.startsWith('/api/')) {
          sendJson(outgoing, 404, { error: 'not found' });
          return;
        }
        if (!authorized(incoming, url, options.token)) {
          sendJson(outgoing, 401, { error: 'unauthorized' });
          return;
        }

        if (incoming.method === 'GET' && url.pathname === '/api/config') {
          sendJson(outgoing, 200, publicConfig(options.getStored(), options.getTraffic()));
          return;
        }
        if (incoming.method === 'GET' && url.pathname === '/api/status') {
          sendJson(outgoing, 200, { traffic: options.getTraffic() });
          return;
        }
        if (incoming.method === 'PUT' && url.pathname === '/api/config') {
          const body = await readBody(incoming);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            sendJson(outgoing, 400, { error: '请求体必须是合法 JSON。' });
            return;
          }
          const record = parsed as Record<string, unknown>;
          const current = options.getStored();
          if (current) {
            // Optional fields omitted from the request keep their stored value.
            if (typeof record.password !== 'string' || record.password.trim() === '') {
              record.password = current.password;
            }
            if (record.trafficMonthlyThresholdGb === undefined) {
              record.trafficMonthlyThresholdGb = current.trafficMonthlyThresholdGb;
            }
            if (typeof record.sessionNamespace !== 'string' || record.sessionNamespace.trim() === '') {
              record.sessionNamespace = current.sessionNamespace;
            }
          }
          const { validateStoredConfig } = await import('./node-config');
          const result = validateStoredConfig(record);
          if (!result.ok) {
            sendJson(outgoing, 400, { errors: result.errors });
            return;
          }
          options.applyConfig(result.config);
          sendJson(outgoing, 200, publicConfig(options.getStored(), options.getTraffic()));
          return;
        }
        sendJson(outgoing, 405, { error: 'method not allowed' });
      } catch (error) {
        options.logger.error({
          event: 'admin_request_failed',
          url: incoming.url,
          error: error instanceof Error ? error.message : String(error)
        });
        if (!outgoing.headersSent) {
          sendJson(outgoing, 500, { error: 'internal error' });
        } else {
          outgoing.destroy();
        }
      }
    })();
  });
}
