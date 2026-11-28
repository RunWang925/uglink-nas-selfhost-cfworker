// Measure rects of key elements on the route-manager page.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const distDir = 'E:/王睿文件/WorkBuddy/2026-11-26-22-06-48/uglink-worker-nas/dist/client';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1053, height: 800 } });
await page.addInitScript(() => {
  localStorage.setItem('uglink_server_gateway_connection', JSON.stringify({
    baseUrl: 'http://42.192.0.1:9090', adminToken: 't', unlockToken: 't'
  }));
});
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  let p = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  try {
    const body = await readFile(p);
    return route.fulfill({ status: 200, contentType: MIME[extname(p)] ?? 'application/octet-stream', body });
  } catch {
    return route.fulfill({ status: 404, body: 'x' });
  }
});
// minimal bootstrap so we reach the main UI
const config = { version: 2, uglink: { id: 'qa', username: 'qa' }, services: [], deployment: {} };
await page.route('**/api/bootstrap', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
  title: 'QA', authenticated: true, accessMode: 'cloudflare', csrfToken: 'qa-csrf',
  providers: { cloudflare: { state: 'connected', label: 'QA', detail: 'd' } },
  target: { accountId: 'a'.repeat(32), accountName: 'QA', accountIdSuffix: '47c52e', workerName: 'uglink-qa' },
  configuration: { version: 1, deployed: config, updatedAt: new Date().toISOString() }
}) }));

await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('button:visible', { hasText: '线路管理' }).first().click();
await page.waitForTimeout(800);

const rects = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return `${sel}: (none)`;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return `${sel}: left=${Math.round(r.left)} right=${Math.round(r.right)} w=${Math.round(r.width)} display=${cs.display}`;
  };
  return [
    pick('.app-main'),
    pick('.section-page'),
    pick('.route-manager-grid'),
    ...Array.from(document.querySelectorAll('.route-manager-card')).map((el, i) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return `card${i}: left=${Math.round(r.left)} right=${Math.round(r.right)} w=${Math.round(r.width)} cols=${cs.gridTemplateColumns && ''}`;
    }),
    pick('.route-manager-grid'),
    `grid columns: ${getComputedStyle(document.querySelector('.route-manager-grid')).gridTemplateColumns}`,
    ...Array.from(document.querySelectorAll('.panel')).map((el, i) => {
      const r = el.getBoundingClientRect();
      return `panel${i}: left=${Math.round(r.left)} right=${Math.round(r.right)} w=${Math.round(r.width)}`;
    })
  ].join('\n');
});
console.log(rects);
await browser.close();
