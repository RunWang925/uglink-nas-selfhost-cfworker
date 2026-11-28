// Integrated E2E: password setup -> server mode -> gateway -> add service -> save -> verify.
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:5188';
const outDir = 'E:/王睿文件/WorkBuddy/2026-11-26-22-06-48/qa-shots';
const log = (...a) => console.log('[integrated]', ...a);
const b = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true });
const c = await b.newContext({ baseURL: base, extraHTTPHeaders: { 'X-Uglink-Console-Origin': base }, viewport: { width: 1440, height: 900 } });
const page = await c.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 1. set password via UI
await page.locator('#auth-password').fill('Integrated123');
await page.locator('#auth-confirm').fill('Integrated123');
await page.locator('.auth-card__submit').click();
await page.waitForTimeout(700);
log('1 after setup h1:', await page.locator('h1').first().textContent());

// 2. choose server route
const srv = page.locator('button:visible', { hasText: '自建服务' }).first();
if (await srv.count()) { await srv.click(); await page.waitForTimeout(500); }
const enter = page.locator('button:visible', { hasText: '进入服务器网关' }).first();
if (await enter.count()) { await enter.click(); await page.waitForTimeout(700); }
log('2 after route h1:', await page.locator('h1').first().textContent());

// 3. configure gateway
await page.locator('button:visible', { hasText: '线路管理' }).first().click();
await page.waitForTimeout(500);
const inputs = page.locator('.route-card__fields input');
if (await inputs.count() >= 3) {
  await inputs.nth(0).fill('http://127.0.0.1:9090');
  await inputs.nth(1).fill('qa-admin-token-123');
  await inputs.nth(2).fill('qa-unlock-token-123');
  const pull = page.locator('button:visible', { hasText: '重新拉取配置' }).first();
  if (await pull.count()) { await pull.click(); await page.waitForTimeout(1200); }
}
log('3 gateway connected:', (await page.locator('body').textContent()).includes('已连接'));

// 4. add a service record
await page.locator('button:visible', { hasText: '服务与访问' }).first().click();
await page.waitForTimeout(500);
const addBtn = page.locator('button:visible', { hasText: '添加记录' }).first();
log('4 add-record button present:', await addBtn.count() > 0);
if (await addBtn.count()) {
  await addBtn.click(); await page.waitForTimeout(400);
  // fill draft: name + nas port (first two text inputs in the draft row)
  const draftInputs = page.locator('.entry-row input:visible, .entry-grid input:visible');
  log('4 draft inputs:', await draftInputs.count());
}

// 5. lock button present in dashboard
log('5 lock button present:', await page.locator('.sidebar-lock').count() > 0);
await page.screenshot({ path: `${outDir}/integrated-final.png`, fullPage: true });

log('browser errors:', errors.length ? errors.join(' | ') : 'none');
await c.close(); await b.close();
log('done');
