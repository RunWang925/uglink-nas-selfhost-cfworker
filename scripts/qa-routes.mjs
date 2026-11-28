// One-off QA: screenshot the route-manager page at narrow widths to reproduce overflow.
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';

const distDir = 'E:/王睿文件/WorkBuddy/2026-11-26-22-06-48/uglink-worker-nas/dist/client';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};
const outDir = 'E:/王睿文件/WorkBuddy/2026-11-26-22-06-48/qa-shots';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true
});

const config = {
  $schema: './uglink.config.schema.json',
  version: 2,
  uglink: { id: 'qa-device', username: 'qa-user' },
  services: [
    { name: 'openlist', hostname: 'openlist.example.com', port: 5244, enabled: true, accessMode: 'ticket' },
    { name: 'jellyfin', hostname: 'jellyfin.example.com', port: 8096, enabled: true, accessMode: 'proxy' }
  ],
  deployment: { workersDev: false, previewUrls: false }
};

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function runShots(width) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const serverConn = process.env.QA_SERVER_CONN || 'full';
  await page.addInitScript((mode) => {
    if (mode === 'none') localStorage.removeItem('uglink_server_gateway_connection');
    else localStorage.setItem('uglink_server_gateway_connection', JSON.stringify({
      baseUrl: 'http://42.192.0.1:9090',
      adminToken: 'qa-admin-token',
      unlockToken: 'qa-unlock-token'
    }));
  }, serverConn);
  // Serve static SPA from dist/client; /api/** come from mocks below.
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) return; // handled by api route
    let filePath = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    try {
      const body = await readFile(filePath);
      return route.fulfill({ status: 200, contentType: MIME[extname(filePath)] ?? 'application/octet-stream', body });
    } catch {
      // SPA fallback
      try {
        const body = await readFile(join(distDir, 'index.html'));
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
      } catch {
        return route.fulfill({ status: 404, body: 'not found' });
      }
    }
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/bootstrap') {
      return json(route, {
        title: 'UGLINK Control',
        authenticated: true,
        accessMode: 'cloudflare',
        csrfToken: 'qa-csrf',
        providers: process.env.QA_CF === 'none' ? {} : { cloudflare: { state: 'connected', label: 'QA Account', detail: '服务 · uglink-qa' } },
        target: { accountId: 'a'.repeat(32), accountName: 'QA Account', accountIdSuffix: '47c52e', workerName: 'uglink-qa' },
        configuration: { version: 1, deployed: config, updatedAt: new Date().toISOString() }
      });
    }
    if (url.pathname === '/api/validate') return json(route, { valid: true, checks: [] });
    if (url.pathname === '/api/services/health') {
      return json(route, {
        checkedAt: new Date().toISOString(),
        services: config.services.map((s) => ({
          serviceName: s.name, hostname: s.hostname, port: s.port, healthy: true,
          detail: 'Worker 已部署且域名配置正常', code: 'healthy', stage: 'worker_configuration', httpStatus: 200
        }))
      });
    }
    if (url.pathname === '/api/diagnostics') return json(route, { entries: [] });
    if (url.pathname.startsWith('/api/deployments/')) {
      return json(route, {
        id: 'qa-job', mode: 'publish', phase: 'healthy', message: '部署成功',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        services: config.services.map((s) => ({ hostname: s.hostname, state: 'healthy', detail: 'OK' }))
      });
    }
    if (url.pathname === '/api/server-gateway/pull') {
      return json(route, {
        configured: true, uglinkId: 'qa-device', username: 'qa-user', trafficMonthlyThresholdGb: 500,
        services: [
          { name: 'openlist', nasPort: 5244, serverPort: 5244, accessMode: 'ticket' },
          { name: 'jellyfin', nasPort: 8096, serverPort: 8096, accessMode: 'proxy' }
        ]
      });
    }
    if (url.pathname === '/api/server-gateway/status') {
      return json(route, {
        traffic: {
          monthlyTotals: { rx: 5.2e9, tx: 1.1e9 }, allTime: { rx: 4.2e10, tx: 1.3e10 },
          period: '2026-11', monthlyServices: [{ service: 'jellyfin', rx: 4.1e9, tx: 0.9e9 }],
          thresholdExceeded: false
        },
        services: [
          { name: 'openlist', listening: true },
          { name: 'jellyfin', listening: true }
        ]
      });
    }
    return json(route, { ok: true });
  });

  await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Navigate to 线路管理 via sidebar
  const nav = page.locator('button:visible', { hasText: '线路管理' }).first();
  await nav.click({ timeout: 5000 });
  await page.waitForTimeout(800);

  // Measure overflow
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > doc.clientWidth + 1 && r.width > 40) {
        wide.push(`${el.tagName}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
      }
    });
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      wide: wide.slice(0, 12)
    };
  });
  console.log(`width ${width}: scrollW=${metrics.scrollWidth} clientW=${metrics.clientWidth}`);
  metrics.wide.forEach((w) => console.log('  OVERFLOW:', w));

  await page.screenshot({ path: `${outDir}/routes-${width}.png`, fullPage: true });

  // Check draft route select options on the services page
  await page.locator('button:visible', { hasText: '服务与访问' }).first().click();
  await page.waitForTimeout(600);
  await page.locator('button:visible', { hasText: '添加记录' }).first().click();
  await page.waitForTimeout(400);
  const options = await page.evaluate(() => {
    const select = document.querySelector('.route-select');
    if (!select) return '(no .route-select)';
    return Array.from(select.querySelectorAll('option')).map((o) => o.textContent).join(', ');
  });
  console.log(`width ${width} draft route options: ${options}`);

  await page.close();
}

for (const width of [1920, 1440, 1053, 880]) await runShots(width);
console.log('done');
await browser.close();
