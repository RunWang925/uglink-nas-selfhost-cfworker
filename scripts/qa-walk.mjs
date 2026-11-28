// Walk every page in both route modes against the real production build.
// console :5188 + gateway :9090. Screenshots to ../../qa-shots/walk-*.
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const base = 'http://127.0.0.1:5188';
const outDir = 'E:/王睿文件/WorkBuddy/2026-11-26-22-06-48/qa-shots';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true
});
const log = (...a) => console.log('[walk]', ...a);

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });
  return { page, errs };
}

// ---------- SECURITY PROBE: can an anonymous visitor read/write APIs? ----------
{
  const { page, errs } = await newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/walk-00-setup.png`, fullPage: true });
  const probe = await page.evaluate(async () => {
    const out = {};
    const bs = await fetch('/api/bootstrap').then(r => r.json());
    out.authenticated = bs.authenticated;
    out.accessMode = bs.accessMode;
    // Try a state-changing call with the fresh session's CSRF token.
    const r = await fetch('/api/connections/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': bs.csrfToken },
      body: JSON.stringify({ accessMode: 'server' })
    });
    out.modeSetStatus = r.status;
    return out;
  });
  log('anonymous probe:', JSON.stringify(probe));
  log('setup page errors:', errs.length ? errs.join(' | ') : 'none');
  await page.close();
}

// ---------- SERVER MODE WALKTHROUGH ----------
{
  const { page, errs } = await newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // choose server route via the visible button
  const srv = page.locator('button:visible', { hasText: '自建服务' }).first();
  if (await srv.count()) { await srv.click(); await page.waitForTimeout(600); }
  const enter = page.locator('button:visible', { hasText: '进入服务器网关' }).first();
  if (await enter.count()) { await enter.click(); await page.waitForTimeout(700); }

  // configure gateway
  await page.locator('button:visible', { hasText: '线路管理' }).first().click();
  await page.waitForTimeout(500);
  const inputs = page.locator('.route-card__fields input');
  if (await inputs.count() >= 3) {
    await inputs.nth(0).fill('http://127.0.0.1:9090');
    await inputs.nth(1).fill('qa-admin-token-123');
    await inputs.nth(2).fill('qa-unlock-token-123');
    const pull = page.locator('button:visible', { hasText: '重新拉取配置' }).first();
    if (await pull.count()) { await pull.click(); await page.waitForTimeout(1000); }
  }
  await page.screenshot({ path: `${outDir}/walk-server-01-routes.png`, fullPage: true });

  const navLabels = [['服务与访问','services'],['NAS 连接','nas'],['线路管理','routes'],['权限与安全','security']];
  for (const [label, slug] of navLabels) {
    const nav = page.locator('button:visible', { hasText: label }).first();
    if (await nav.count()) {
      await nav.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${outDir}/walk-server-${slug}.png`, fullPage: true });
      log('server page:', label, '-> shot ok');
    } else {
      log('server page MISSING:', label);
    }
  }
  const navTexts = await page.locator('aside button, nav button').allTextContents().catch(() => []);
  log('server nav items:', navTexts.map(t=>t.trim()).filter(Boolean).join(' / '));
  log('server walk errors:', errs.length ? errs.join(' | ') : 'none');
  await page.close();
}

await browser.close();
log('done');
