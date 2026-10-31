import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGateway } from '../dist/server.js';
const exec = promisify(execFile);

test('server console in real Chromium', { timeout: 180_000 }, async t => {
  const runId = `console-${Date.now()}`;
  const results = resolve('../../test-runs', runId); await mkdir(results, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'tabularium-console-'));
  const password = randomBytes(24).toString('hex');
  const compose = (...args) => exec('docker', ['compose', '-f', resolve('../../deploy/test/compose.yaml'), '-p', runId, ...args], {
    env: { ...process.env, BASELINE_PASSWORD: password }, timeout: 90_000,
  });
  let gateway, browser;
  const report = { runId, scenarios: [], status: 'running' };
  try {
    await compose('up', '-d', '--wait');
    const port = (await compose('port', 'couchdb', '5984')).stdout.trim();
    gateway = await createGateway({ database: join(temp, 'app.sqlite'), bootstrapUser: 'admin', bootstrapPassword: password, origins: [],
      couch: { url: `http://${port}`, adminUser: 'baseline', adminPassword: password, syncUser: 'tabularium', syncPassword: randomBytes(24).toString('hex') } });
    const url = await gateway.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    const login = async (page, username, password, path = '/') => {
      await page.goto(url + path); await page.getByLabel('用户名', { exact: true }).fill(username);
      await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
    };
    const changePassword = async (page, currentPassword, password) => {
      await page.getByLabel('当前密码', { exact: true }).fill(currentPassword);
      await page.getByLabel('新密码', { exact: true }).fill(password);
      await page.getByLabel('确认新密码', { exact: true }).fill(password);
      await page.getByRole('button', { name: '保存密码' }).click();
    };
    const confirmDialog = async (page, action, name) => {
      const dialog = page.getByRole('dialog');
      if (name !== undefined) await dialog.getByRole('textbox').fill(name);
      await dialog.getByRole('button', { name: action, exact: true }).click();
    };
    // One sign-in page for every path of the application, without a language selector.
    for (const path of ['/', '/admin/', '/account/', '/tabularius/']) {
      await page.goto(url + path);
      await expect(page.getByRole('heading', { name: '登录服务器' })).toBeVisible();
      await expect(page.getByLabel('语言')).toHaveCount(0);
    }
    assert.equal((await fetch(`${url}/admin.js`)).status, 404);
    assert.equal((await fetch(`${url}/app/app.js`)).status, 200);
    report.scenarios.push('one-sign-in-page-for-every-path');

    // Three interface languages: an English browser gets English; the only selector is in account settings, Interface.
    const la = (await import('../dist/public/messages.js')).catalogues.la;
    {
      const english = await browser.newContext({ locale: 'en-GB' });
      const visitor = await english.newPage();
      await visitor.goto(url);
      await expect(visitor.getByRole('heading', { name: 'Sign in to the server' })).toBeVisible();
      await english.close();
    }
    await login(page, 'admin', password, '/admin/');
    await expect(page.getByRole('heading', { name: '修改初始密码' })).toBeVisible();
    await changePassword(page, password, 'admin-browser-password');
    await expect(page.getByRole('heading', { name: '管理', exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('heading', { name: '管理', exact: true })).toBeVisible();
    await expect(page.getByLabel('语言')).toHaveCount(0);
    const cookies = await context.cookies();
    assert.equal(cookies.find(c => c.name === 'tabularium_session').httpOnly, true);
    assert.equal(cookies.find(c => c.name === 'tabularium_session').sameSite, 'Strict');
    // Browser storage holds only display preferences, never the session.
    const stored = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
    assert(stored.every(key => ['tabularium-theme', 'tabularium-language'].includes(key)), JSON.stringify(stored));
    await page.screenshot({ path: join(results, 'overview.png'), fullPage: true });
    report.scenarios.push('login-change-password-refresh-and-httpOnly-session');

    await page.getByRole('link', { name: /admin/ }).click();
    await page.getByRole('link', { name: '界面', exact: true }).click();
    await expect(page.getByLabel('语言')).toHaveCount(1);
    await page.getByLabel('语言').selectOption('la');
    await expect(page.getByRole('link', { name: la['nav.home'], exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: la['account.interface'], exact: true })).toHaveAttribute('aria-current', 'page');
    await page.getByRole('link', { name: la['nav.tabularius'] }).click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'la');
    assert(!/\p{Extended_Pictographic}/u.test(await page.evaluate(() => document.body.innerText)), 'no emoji on the page');
    await page.getByRole('link', { name: /admin/ }).click();
    await page.getByRole('link', { name: la['account.interface'], exact: true }).click();
    await page.getByLabel(la['language.label']).selectOption('zh');
    await expect(page.getByRole('link', { name: '首页', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '书记员', exact: true })).toBeVisible();
    report.scenarios.push('three-languages-one-selector-in-account-settings');

    // Colour theme: sakura until the account chooses another, then kept on the account; notices are toasts.
    await expect(page.getByRole('button', { name: /樱粉/ })).toHaveAttribute('aria-pressed', 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'sakura');
    await page.getByRole('button', { name: /森林/ }).click();
    await expect(page.locator('.toasts .toast', { hasText: '已切换配色。' })).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);
    await page.reload(); await expect(page.getByRole('button', { name: /森林/ })).toHaveAttribute('aria-pressed', 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);
    // A custom recipe: previewed while it is adjusted, kept after saving.
    await page.getByRole('button', { name: /自定义/ }).click();
    await page.getByLabel('主色').fill('#2a7fbf');
    await page.getByLabel('深色').check();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'custom');
    await page.getByRole('button', { name: '保存配色方案' }).click();
    await expect(page.locator('.toasts .toast', { hasText: '已切换配色。' })).toBeVisible();
    await page.reload(); await expect(page.getByRole('button', { name: /自定义/ })).toHaveAttribute('aria-pressed', 'true');
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.side, getComputedStyle(document.documentElement).getPropertyValue('--recipe-accent').trim()]), ['custom', 'dark', '#2a7fbf']);
    await page.screenshot({ path: join(results, 'custom-theme.png') });
    await page.getByRole('button', { name: /薰衣草/ }).click();
    await expect(page.getByRole('button', { name: /薰衣草/ })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: join(results, 'lavender-theme.png') });
    await page.getByRole('button', { name: /樱粉/ }).click();
    await expect(page.getByRole('button', { name: /樱粉/ })).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: join(results, 'sakura-theme.png') });
    report.scenarios.push('theme-kept-on-the-account');

    await page.goto(url + '/admin/users');
    await page.getByLabel('用户名', { exact: true }).fill('alice');
    await page.getByLabel('初始密码', { exact: true }).fill('alice-initial-password');
    await page.getByRole('button', { name: '创建账户', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'alice', exact: true })).toBeVisible();
    await page.getByRole('link', { name: '笔记库', exact: true }).click();
    await page.getByLabel('笔记库名称', { exact: true }).fill('团队笔记');
    await page.getByLabel('所属账户', { exact: true }).selectOption({ label: 'alice' });
    await page.getByRole('button', { name: '创建笔记库', exact: true }).click();
    await page.getByRole('link', { name: '团队笔记', exact: true }).click();
    await expect(page.getByRole('button', { name: '签发凭据' })).toHaveCount(0);
    await page.getByRole('button', { name: '查看数据库用量' }).click();
    await expect(page.locator('#usage-result')).toContainText('数据库磁盘占用');
    report.scenarios.push('admin-creates-account-and-owned-vault-and-reads-usage');

    const aliceContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const alice = await aliceContext.newPage(); alice.on('pageerror', e => errors.push(e.message));
    await login(alice, 'alice', 'alice-initial-password');
    await changePassword(alice, 'alice-initial-password', 'alice-browser-password');
    await expect(alice.getByRole('heading', { name: '团队笔记' })).toBeVisible();
    await expect(alice.getByRole('link', { name: '管理', exact: true })).toHaveCount(0);
    await alice.goto(url + '/admin/');
    await expect(alice.getByRole('heading', { name: '需要管理员权限' })).toBeVisible();
    assert.equal(await alice.evaluate(async () => (await fetch('/api/v1/admin/vaults')).status), 403);
    assert.equal(await alice.evaluate(async () => (await fetch('/api/v1/users')).status), 403);
    await alice.goto(url + '/');
    await alice.getByRole('link', { name: '管理设备' }).click();
    await alice.getByLabel('设备名称', { exact: true }).fill('Alice 的电脑');
    await alice.getByRole('button', { name: '签发凭据' }).click();
    await expect(alice.getByLabel('设备密码', { exact: true })).toBeVisible();
    const deviceUser = await alice.getByLabel('设备用户名', { exact: true }).inputValue();
    const secret = await alice.getByLabel('设备密码', { exact: true }).inputValue();
    const vaultId = await alice.locator('.details dd.mono').textContent();
    assert(secret.length > 30);
    const auth = `Basic ${Buffer.from(`${deviceUser}:${secret}`).toString('base64')}`;
    const connected = await fetch(`${url}/sync/${vaultId}`, { headers: { authorization: auth } });
    assert.equal(connected.status, 200); await connected.arrayBuffer();
    const csrf = await alice.evaluate(async () => (await fetch('/api/v1/vaults', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'forged' }) })).status);
    assert.equal(csrf, 403);
    await alice.getByRole('button', { name: '已保存，关闭' }).click();
    await expect(alice.getByLabel('设备密码', { exact: true })).toHaveCount(0);
    await alice.screenshot({ path: join(results, 'mobile-devices.png'), fullPage: true });
    assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await alice.reload(); await expect(alice.getByRole('cell', { name: 'Alice 的电脑', exact: true })).toBeVisible();
    await expect(alice.getByLabel('设备密码', { exact: true })).toHaveCount(0);
    report.scenarios.push('mobile-owner-issues-one-time-device-and-role-csrf-boundaries');

    await alice.getByLabel('设备', { exact: true }).selectOption({ label: 'Alice 的电脑' });
    await alice.getByRole('button', { name: '授权 15 分钟' }).click();
    await expect(alice.getByRole('dialog').getByRole('button', { name: '授权 15 分钟' })).toBeDisabled();
    await confirmDialog(alice, '授权 15 分钟', '团队笔记');
    await expect(alice.getByText('等待该设备发起重建')).toBeVisible();
    await alice.screenshot({ path: join(results, 'mobile-rebuild.png'), fullPage: true });
    assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await alice.getByRole('button', { name: '结束重建' }).click();
    await expect(alice.getByRole('button', { name: '授权 15 分钟' })).toBeVisible();
    report.scenarios.push('owner-opens-and-ends-rebuild-window');

    await alice.goto(url + '/account/kindle');
    await expect(alice.getByText('服务器尚未配置发信，请联系管理员。')).toBeVisible();
    await alice.getByLabel('Kindle 地址', { exact: true }).fill('alice@gmail.com');
    await alice.getByRole('button', { name: '保存' }).click();
    await expect(alice.getByText('请填写 Kindle 的推送邮箱地址。')).toBeVisible();
    await alice.getByLabel('Kindle 地址', { exact: true }).fill('alice@kindle.com');
    await alice.getByRole('button', { name: '保存' }).click();
    await expect(alice.getByText('Kindle 地址已保存。')).toBeVisible();
    assert.equal(await alice.getByLabel('Kindle 地址', { exact: true }).inputValue(), 'alice@kindle.com');
    assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    report.scenarios.push('owner-sets-kindle-address');

    await page.goto(url + '/admin/vaults');
    await page.getByRole('link', { name: '团队笔记', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Alice 的电脑', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await confirmDialog(page, '撤销');
    // Revoked devices leave the list and are folded away below it.
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0);
    await page.getByText('已撤销或已过期的设备（1）', { exact: true }).click();
    await expect(page.getByText('已撤销', { exact: true })).toBeVisible();
    const revoked = await fetch(`${url}/sync/${vaultId}`, { headers: { authorization: auth } });
    assert.equal(revoked.status, 401); await revoked.arrayBuffer();
    await page.getByRole('link', { name: '操作记录', exact: true }).click();
    await expect(page.getByRole('cell', { name: '撤销设备', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '授权重建', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '结束重建', exact: true })).toBeVisible();
    assert.equal((await page.locator('body').innerText()).includes(secret), false);
    report.scenarios.push('admin-revocation-and-audit');

    await page.getByRole('link', { name: '账户', exact: true }).click();
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'alice', exact: true }) }).getByRole('button', { name: '禁用' }).click();
    await confirmDialog(page, '禁用');
    await expect(page.getByText('已禁用', { exact: true })).toBeVisible();
    await alice.reload();
    await expect(alice.getByRole('heading', { name: '登录服务器' })).toBeVisible();
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '登录服务器' })).toBeVisible();
    assert.equal((await context.cookies()).some(c => c.name === 'tabularium_session'), false);
    assert.deepEqual(errors, []);
    report.scenarios.push('disable-account-and-logout');
    report.status = 'passed';
    console.log(`PASS ${report.scenarios.length} browser workflows; screenshots: ${results}`);
  } catch (error) { report.status = 'failed'; report.error = String(error); throw error; }
  finally {
    if (browser) await browser.close();
    if (gateway) await gateway.close();
    await compose('down', '-v'); await rm(temp, { recursive: true });
    await writeFile(join(results, 'report.json'), JSON.stringify(report, null, 2));
  }
});
