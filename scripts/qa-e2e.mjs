// E2E test against the real production build:
//   console (dist/node-console) on :8788  +  node-gateway on :9090
// Flow: server-only setup -> configure gateway -> NAS verify (fake creds,
// expect clean failure) -> add record -> save -> pull/status -> traffic.
import { chromium } from 'playwright-core';

const consoleBase = 'http://127.0.0.1:8788';
const outDir = 'E:/王睿文件/WorkBuddy/2026-11-26-22-06-48/qa-shots';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const log = (...a) => console.log('[e2e]', ...a);
const shot = (name) => page.screenshot({ path: `${outDir}/e2e-${name}.png`, fullPage: true });

await page.goto(consoleBase, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await shot('01-setup');
log('setup screen loaded, version badge:', await page.locator('.brand__meta, [class*=brand]').first().textContent().catch(() => '(n/a)'));

// 1. Choose server-only access mode
const serverBtn = page.locator('button:visible', { hasText: '自建服务' }).first();
if (await serverBtn.count()) {
  await serverBtn.click();
  await page.waitForTimeout(800);
  log('chose server-only mode');
  const enterBtn = page.locator('button:visible', { hasText: '进入服务器网关' }).first();
  if (await enterBtn.count()) {
    await enterBtn.click();
    await page.waitForTimeout(1000);
    log('entered server gateway');
  }
} else {
  log('(no explicit server-only button, continuing)');
}
await shot('02-after-mode');

// 2. Route manager: fill gateway connection and pull
await page.locator('button:visible', { hasText: '线路管理' }).first().click();
await page.waitForTimeout(600);
await shot('03-routes-empty');
const inputs = page.locator('.route-card__fields input');
log('route fields count:', await inputs.count());
await inputs.nth(0).fill('http://127.0.0.1:9090');
await inputs.nth(1).fill('qa-admin-token-123');
await inputs.nth(2).fill('qa-unlock-token-123');
await page.locator('button:visible', { hasText: '重新拉取配置' }).first().click();
await page.waitForTimeout(1200);
await shot('04-routes-pulled');
log('routes after pull:', (await page.locator('.route-manager-card').allTextContents()).map(t => t.slice(0, 60)));

// 3. NAS connection: fake credentials -> expect clear failure message
const nasNav = page.locator('button:visible', { hasText: 'NAS 连接' });
if (await nasNav.count()) {
  await nasNav.first().click();
  await page.waitForTimeout(600);
  await shot('05-nas-page');
  const nasFields = page.locator('input:visible');
  const texts = await page.locator('label:visible').allTextContents();
  log('nas labels:', texts.filter(t => t.trim()).slice(0, 8));
}

// 4. Services page: add a record (server route available now)
await page.locator('button:visible', { hasText: '服务与访问' }).first().click();
await page.waitForTimeout(800);
await shot('04b-services');
log('services page text:', (await page.locator('.app-main').textContent()).replace(/\s+/g, ' ').slice(0, 400));
const addBtn = page.locator('button:visible', { hasText: '添加记录' }).first();
log('添加记录 count:', await page.locator('button', { hasText: '添加记录' }).count(), 'visible:', await addBtn.count(), 'disabled:', await addBtn.count() ? await addBtn.isDisabled() : 'n/a');
await addBtn.click({ timeout: 8000 }).catch((e) => log('添加记录 click failed:', e.message.split('\n')[0]));
await page.waitForTimeout(400);
const routeOptions = await page.evaluate(() => {
  const select = document.querySelector('.route-select');
  return select ? Array.from(select.querySelectorAll('option')).map((o) => o.textContent).join(', ') : '(none)';
});
log('draft route options (server configured):', routeOptions);
await page.locator('.entry-row--draft input').first().fill('openlist');
const portInput = page.locator('.entry-row--draft input').nth(1);
await portInput.fill('5244');
await page.waitForTimeout(300);
await shot('05-draft');
// listen port auto-filled? fill explicitly if empty
const listen = page.locator('.entry-row--draft .field-listen input');
if (await listen.count() && !(await listen.inputValue())) await listen.fill('15244');
await page.locator('button:visible', { hasText: '完成' }).first().click();
await page.waitForTimeout(500);
await shot('06-record-added');

// 5. Save changes -> push mappings to gateway
const saveBtn = page.locator('button:visible', { hasText: '保存更改' }).first();
await saveBtn.click();
await page.waitForTimeout(3000);
await shot('07-saved');
const noticeText = await page.locator('.action-bar__status, .notice, [class*=notice]').first().textContent().catch(() => '');
log('save notice:', noticeText.replace(/\s+/g, ' ').slice(0, 200));
log('body after save:', (await page.locator('body').textContent()).replace(/\s+/g, ' ').slice(200, 500));

// 6. Verify gateway actually applied the mapping and serve the service port
await page.waitForTimeout(1500);
const statusResp = await fetch('http://127.0.0.1:9090/api/status', { headers: { 'X-Admin-Token': 'qa-admin-token-123' } }).then((r) => r.json());
log('gateway status services:', JSON.stringify(statusResp.services));
const serverPort = statusResp.services?.[0]?.serverPort ?? 5244;
try {
  const visitor = await fetch(`http://127.0.0.1:${serverPort}/`, { redirect: 'manual' });
  const html = await visitor.text();
  log(`visitor GET :${serverPort} -> HTTP ${visitor.status}`);
  log('visitor page snippet:', html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 220));
  await page.goto(`http://127.0.0.1:${serverPort}/`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(800);
  await shot('08-ticket-page');
} catch (e) {
  log(`visitor GET :${serverPort} failed:`, e.message.split('\n')[0]);
}
const trafficResp = await fetch('http://127.0.0.1:9090/api/status', { headers: { 'X-Admin-Token': 'qa-admin-token-123' } }).then((r) => r.json());
log('gateway traffic period:', trafficResp.traffic?.period);

await page.waitForTimeout(1000);
console.log('[e2e] browser errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
