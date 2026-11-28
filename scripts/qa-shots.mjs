// Quick visual QA: screenshot console sections at several widths with mocked APIs.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:5173';
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
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.addInitScript(() => {
    localStorage.setItem('uglink_server_gateway_connection', JSON.stringify({
      baseUrl: 'http://42.192.0.1:9090',
      adminToken: 'qa-admin-token',
      unlockToken: 'qa-unlock-token'
    }));
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
        providers: { cloudflare: { state: 'connected', label: 'QA Account', detail: '服务 · uglink-qa' } },
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
    if (url.pathname === '/api/nas/verify') return json(route, { ok: true });
    return json(route, { ok: true });
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/access-${width}.png`, fullPage: true });

  try {
    await page.locator('button', { hasText: '编辑' }).nth(1).click({ timeout: 4000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}/edit-b-${width}.png`, fullPage: false });
    await page.locator('button', { hasText: '完成' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(400);
    await page.locator('button', { hasText: '添加记录' }).first().click({ timeout: 4000 });
    await page.waitForTimeout(500);
    const selects = page.locator('.draft select, .entry-row--draft select');
    if (await selects.count() > 0) await selects.first().selectOption({ label: '自建服务' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${outDir}/draft-b-${width}.png`, fullPage: false });
  } catch (e) {
    console.log(`width ${width} states FAIL: ${e.message.split('\n')[0]}`);
  }
  console.log(`width ${width}: ${errors.length ? errors.join(' | ') : 'no errors'}`);
  await page.close();
}

for (const width of [1440, 1280, 1152]) await runShots(width);
console.log('done');
await browser.close();
