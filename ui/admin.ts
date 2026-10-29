export {};
interface User { id: string; username: string; role: 'admin' | 'user'; disabled: boolean; mustChangePassword: boolean }
interface Rebuild { deviceId: string; until: number; started: number | null }
interface Vault { id: string; name: string; state: string; syncPath: string; ownerId?: string; owner?: string; rebuild: Rebuild | null }
interface Retired { name: string; retiredAt: number; partial: boolean; diskBytes: number }
interface Device { id: string; name: string; revoked: number; expiresAt: number }
interface Session { user: User; csrf: string }
interface Overview { users: number; activeUsers: number; vaults: number; devices: number; requests: number; proxyRequests: number; activeProxyConnections: number; uptimeSeconds: number }
interface Usage { diskBytes: number; activeBytes: number; documents: number; deletedDocuments: number }
interface Audit { id: number; occurredAt: number; actor: string; action: string; targetId: string }
const app = document.querySelector<HTMLDivElement>('#app')!;
let session: Session | undefined;
let section = 'overview';
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const brand = '<div class="brand"><span class="brand-mark">T</span><div><strong>Tabularium</strong><small>笔记同步服务器</small></div></div>';
const bytes = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
const date = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const errorMessages: Record<string, string> = {
  'Invalid username or password': '用户名或密码不正确。', 'Invalid current password': '当前密码不正确。',
  'Username already exists': '此用户名已存在。', 'CouchDB unavailable': '笔记存储服务暂时不可用，请检查服务器状态。',
  'Vault usage unavailable': '暂时无法读取此笔记库的用量。', 'Too many requests': '操作过于频繁，请稍后再试。',
  'Administrator required': '此操作需要管理员权限。', 'Enabled owner not found': '请选择有效且已启用的账户。',
  'Confirmation does not match the vault name': '输入的名称与笔记库名称不一致。', 'Active device not found': '请选择未撤销且未过期的设备。',
  'A rebuild is already in progress': '已有正在进行的重建，请先结束或撤销。', 'No retired database to revert to': '没有可以切回的旧数据库。',
};
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-csrf-token': session.csrf } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, errorMessages[result.error] ?? result.error);
  return result as T;
}
function message(text: string, error = false) {
  const target = document.querySelector<HTMLDivElement>('#message')!;
  target.className = error ? 'notice error' : 'notice'; target.textContent = text; target.hidden = false;
}
async function run(action: () => Promise<void>) {
  try { await action(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401 && session) { session = undefined; login(); message('登录已失效，请重新登录。', true); }
    else message(error instanceof Error ? error.message : '操作失败。', true);
  }
}
function button(id: string, action: () => Promise<void>) {
  document.getElementById(id)!.addEventListener('click', event => {
    const control = event.currentTarget as HTMLButtonElement;
    control.disabled = true;
    void run(action).finally(() => { control.disabled = false; });
  });
}
function form(id: string, action: (data: FormData) => Promise<void>) {
  document.querySelector<HTMLFormElement>(`#${id}`)!.addEventListener('submit', event => {
    event.preventDefault(); const target = event.currentTarget as HTMLFormElement;
    const submit = target.querySelector<HTMLButtonElement>('button[type=submit]')!; submit.disabled = true;
    void run(() => action(new FormData(target))).finally(() => { submit.disabled = false; });
  });
}
const input = (label: string, name: string, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" required ${extra}></label>`;
function login() {
  app.innerHTML = `<div class="login-page"><div class="login-box">${brand}<div class="card"><p class="eyebrow">SERVER CONSOLE</p><h1>登录服务器</h1><p>管理账户、笔记库和同步设备。</p><div id="message" role="status" hidden></div><form id="login" class="stack">${input('用户名', 'username', 'text', 'autocomplete="username"')}${input('密码', 'password', 'password', 'autocomplete="current-password"')}<button class="primary" type="submit">登录</button></form></div><small>账户由服务器管理员创建。</small></div></div>`;
  form('login', async data => {
    session = await api<Session>('/web-session', 'POST', Object.fromEntries(data));
    section = session.user.mustChangePassword ? 'password' : session.user.role === 'admin' ? 'overview' : 'vaults';
    await render();
  });
}
function shell(title: string, subtitle: string) {
  const user = session!.user;
  const items = user.mustChangePassword ? [['password', '修改初始密码']] : [
    ...(user.role === 'admin' ? [['overview', '运行概览']] : []), ['vaults', '笔记库'],
    ...(user.role === 'admin' ? [['users', '账户'], ['audit', '操作记录']] : []), ['password', '修改密码'],
  ];
  app.innerHTML = `<aside class="sidebar">${brand}<nav aria-label="管理导航">${items.map(([key, label]) => `<button data-section="${key}" ${key === section ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav><div class="account"><div><strong>${escape(user.username)}</strong><br><small>${user.role === 'admin' ? '管理员' : '普通用户'}</small></div><button id="logout">退出登录</button></div></aside><main class="main"><header class="page-head"><div><p class="eyebrow">TABULARIUM / MANAGEMENT</p><h1>${title}</h1><p>${subtitle}</p></div><button id="refresh">刷新</button></header><div id="message" role="status" hidden></div><div id="content"></div></main>`;
  for (const nav of document.querySelectorAll<HTMLButtonElement>('[data-section]')) nav.addEventListener('click', () => {
    section = nav.dataset.section!; void run(render);
  });
  button('refresh', render);
  button('logout', async () => { await api('/web-session', 'DELETE'); session = undefined; login(); });
}
function content(html: string) { document.getElementById('content')!.innerHTML = html; }
const badge = (state: string) => `<span class="badge ${state === 'ready' ? '' : 'warn'}">${({ ready: '可同步', failed: '创建失败', provisioning: '创建中' } as Record<string, string>)[state] ?? escape(state)}</span>`;
async function render() {
  if (!session) { login(); return; }
  if (session.user.mustChangePassword) section = 'password';
  if (section === 'password') { passwordPage(); return; }
  if (section === 'overview') await overviewPage();
  if (section === 'users') await usersPage();
  if (section === 'vaults') await vaultsPage();
  if (section === 'audit') await auditPage();
}
function passwordPage() {
  shell(session!.user.mustChangePassword ? '修改初始密码' : '修改密码', '登录密码用于服务器账户，与笔记解密口令相互独立。');
  content(`<section class="card"><form id="password" class="stack">${input('当前密码', 'currentPassword', 'password', 'autocomplete="current-password"')}${input('新密码', 'password', 'password', 'minlength="12" autocomplete="new-password"')}${input('确认新密码', 'confirmation', 'password', 'minlength="12" autocomplete="new-password"')}<small>至少 12 个字符。修改后其他管理会话将退出。</small><button class="primary" type="submit">保存密码</button></form></section>`);
  form('password', async data => {
    if (data.get('password') !== data.get('confirmation')) { message('两次输入的新密码不一致。', true); return; }
    await api('/me/password', 'PUT', { currentPassword: data.get('currentPassword'), password: data.get('password') });
    session!.user.mustChangePassword = false; section = session!.user.role === 'admin' ? 'overview' : 'vaults'; await render(); message('密码已更新。');
  });
}
async function overviewPage() {
  shell('运行概览', '查看这台服务器的资源与同步状态。');
  const metrics = await api<Overview>('/admin/overview');
  const health = await fetch('/health/ready');
  content(`<div class="stats">${[['账户', metrics.users], ['笔记库', metrics.vaults], ['有效设备凭据', metrics.devices], ['当前复制连接', metrics.activeProxyConnections]].map(([name, value]) => `<div class="card stat"><span>${name}</span><strong>${value}</strong></div>`).join('')}</div><div class="split"><section class="card"><h2>服务状态</h2><dl class="details"><dt>笔记存储</dt><dd><span class="badge ${health.ok ? '' : 'warn'}">${health.ok ? '正常' : '暂不可用'}</span></dd><dt>运行时长</dt><dd>${Math.floor(metrics.uptimeSeconds / 60)} 分钟</dd><dt>已启用账户</dt><dd>${metrics.activeUsers}</dd></dl></section><section class="card"><h2>本次运行</h2><dl class="details"><dt>HTTP 请求</dt><dd>${metrics.requests}</dd><dt>复制请求</dt><dd>${metrics.proxyRequests}</dd></dl><small>请求统计在服务器重启后重新计数。</small></section></div>`);
}
async function usersPage() {
  shell('账户', '创建账户，管理用户的服务器访问权限。');
  const users = await api<User[]>('/users');
  content(`<section class="card"><h2>创建账户</h2><form id="create-user" class="inline-form">${input('用户名', 'username', 'text', 'maxlength="128" autocomplete="off"')}${input('初始密码', 'password', 'password', 'minlength="12" autocomplete="new-password"')}<button type="submit" class="primary">创建账户</button></form><small>新用户首次登录时需要修改初始密码。</small></section><section class="card table-wrap"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${users.map(u => `<tr><td>${escape(u.username)}</td><td>${u.role === 'admin' ? '管理员' : '普通用户'}</td><td><span class="badge ${u.disabled ? 'off' : ''}">${u.disabled ? '已禁用' : '已启用'}</span></td><td>${u.id === session!.user.id ? '当前账户' : `<button id="user-${u.id}" class="${u.disabled ? '' : 'danger'}">${u.disabled ? '启用' : '禁用'}</button>`}</td></tr>`).join('')}</tbody></table></section>`);
  form('create-user', async data => { await api('/users', 'POST', Object.fromEntries(data)); await usersPage(); message('账户已创建，请将初始密码单独交给用户。'); });
  for (const user of users.filter(u => u.id !== session!.user.id)) button(`user-${user.id}`, async () => {
    if (!user.disabled && !confirm(`禁用 ${user.username} 将中断其设备同步。继续？`)) return;
    await api(`/users/${user.id}`, 'PATCH', { disabled: !user.disabled }); await usersPage();
  });
}
async function vaultsPage() {
  shell('笔记库', '每个笔记库独立存储，设备凭据仅能访问所属笔记库。');
  const admin = session!.user.role === 'admin';
  const vaults = await api<Vault[]>(admin ? '/admin/vaults' : '/vaults');
  const users = admin ? await api<User[]>('/users') : [];
  content(`<section class="card"><h2>创建笔记库</h2><form id="create-vault" class="inline-form">${input('笔记库名称', 'name', 'text', 'maxlength="128"')}${admin ? `<label><span id="owner-label">所属账户</span><select name="ownerId" aria-labelledby="owner-label">${users.filter(u => !u.disabled).map(u => `<option value="${u.id}">${escape(u.username)}</option>`).join('')}</select></label>` : ''}<button class="primary" type="submit">创建笔记库</button></form></section><section class="card table-wrap">${vaults.length ? `<table><thead><tr><th>笔记库</th>${admin ? '<th>所属账户</th>' : ''}<th>状态</th><th>操作</th></tr></thead><tbody>${vaults.map(v => `<tr><td><button class="link" id="vault-${v.id}">${escape(v.name)}</button></td>${admin ? `<td>${escape(v.owner!)}</td>` : ''}<td>${badge(v.state)}</td><td><button id="details-${v.id}">管理设备</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">还没有笔记库。创建一个即可连接同步客户端。</div>'}</section>`);
  form('create-vault', async data => { await api(admin ? '/admin/vaults' : '/vaults', 'POST', Object.fromEntries(data)); await vaultsPage(); message('笔记库已创建。'); });
  for (const vault of vaults) for (const prefix of ['vault-', 'details-']) button(prefix + vault.id, () => vaultPage(vault));
}
async function vaultPage(vault: Vault) {
  shell(escape(vault.name), '连接客户端、查看设备并管理同步权限。');
  const admin = session!.user.role === 'admin';
  const owner = !admin || vault.ownerId === session!.user.id;
  const base = `${admin ? '/admin' : ''}/vaults/${vault.id}`;
  const devices = await api<Device[]>(`${base}/devices`);
  const rebuildCard = owner && vault.state === 'ready' ? await rebuildSection(vault.id, devices) : '';
  content(`<div class="actions"><button id="back">返回笔记库</button></div><br><section class="card"><h2>连接信息</h2><dl class="details"><dt>服务地址</dt><dd>${escape(location.origin)}/sync</dd><dt>笔记库 ID</dt><dd class="mono">${vault.id}</dd><dt>状态</dt><dd>${badge(vault.state)}</dd></dl><p>在兼容客户端中启用加密，各设备使用相同的笔记解密口令。</p>${vault.state !== 'ready' ? '<button id="retry">重试创建</button>' : ''}${admin ? '<button id="usage">查看数据库用量</button><div id="usage-result"></div>' : ''}</section>${owner && vault.state === 'ready' ? `<section class="card"><h2>添加同步设备</h2><form id="issue-device" class="inline-form">${input('设备名称', 'name', 'text', 'placeholder="例如：工作电脑" maxlength="128"')}<button class="primary" type="submit">签发凭据</button></form></section>` : '<p>设备凭据由笔记库所有者登录后签发。</p>'}<div id="new-secret"></div><section class="card table-wrap"><h2>同步设备</h2>${devices.length ? `<table><thead><tr><th>设备</th><th>状态</th><th>过期时间</th><th>操作</th></tr></thead><tbody>${devices.map(d => `<tr><td>${escape(d.name)}</td><td><span class="badge ${d.revoked || d.expiresAt <= Date.now() ? 'off' : ''}">${d.revoked ? '已撤销' : d.expiresAt <= Date.now() ? '已过期' : '可访问'}</span></td><td>${date(d.expiresAt)}</td><td>${d.revoked ? '—' : `<button class="danger" id="revoke-${d.id}">撤销</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">还没有设备。</div>'}</section>${rebuildCard}`);
  button('back', vaultsPage);
  if (rebuildCard) bindRebuild(vault, devices);
  if (vault.state !== 'ready') button('retry', async () => { await api(`${base}/provision`, 'POST', {}); await vaultsPage(); });
  if (admin) button('usage', async () => {
    const usage = await api<Usage>(`${base}/usage`);
    document.getElementById('usage-result')!.innerHTML = `<br><dl class="details"><dt>数据库磁盘占用</dt><dd>${bytes(usage.diskBytes)}</dd><dt>活动数据</dt><dd>${bytes(usage.activeBytes)}</dd><dt>数据库文档</dt><dd>${usage.documents}</dd></dl><small>包含分块、修订和数据库开销，不代表笔记原文大小。</small>`;
  });
  if (owner && vault.state === 'ready') form('issue-device', async data => {
    const credential = await api<{ username: string; password: string; expiresAt: number }>(`/vaults/${vault.id}/devices`, 'POST', Object.fromEntries(data));
    await vaultPage(vault);
    const target = document.getElementById('new-secret')!;
    target.innerHTML = `<section class="card secret"><h2>保存设备凭据</h2><p>密码仅显示这一次。关闭或离开页面后，服务器不会再次提供它。</p><div class="stack"><label>设备用户名<input readonly id="credential-user"></label><label>设备密码<input readonly id="credential-password"></label><small>有效期至 ${date(credential.expiresAt)}</small><button id="close-secret">已保存，关闭</button></div></section>`;
    document.querySelector<HTMLInputElement>('#credential-user')!.value = credential.username;
    document.querySelector<HTMLInputElement>('#credential-password')!.value = credential.password;
    button('close-secret', async () => { target.replaceChildren(); });
  });
  for (const device of devices.filter(d => !d.revoked)) button(`revoke-${device.id}`, async () => {
    if (!confirm(`撤销 ${device.name} 后，其同步连接会立即断开。继续？`)) return;
    await api(`${base}/devices/${device.id}`, 'DELETE'); await vaultPage(vault);
  });
}
let retired: Retired[] = [];
let rebuild: Rebuild | null = null;
async function rebuildSection(vaultId: string, devices: Device[]) {
  rebuild = (await api<Vault>(`/vaults/${vaultId}`)).rebuild;
  retired = await api<Retired[]>(`/vaults/${vaultId}/databases`);
  const active = devices.filter(d => !d.revoked && d.expiresAt > Date.now());
  const deviceName = (id: string) => escape(devices.find(d => d.id === id)?.name ?? id);
  const status = rebuild
    ? `<dl class="details"><dt>授权设备</dt><dd>${deviceName(rebuild.deviceId)}</dd><dt>授权截止</dt><dd>${date(rebuild.until)}</dd><dt>状态</dt><dd>${rebuild.started ? '重建中，其他设备暂停同步' : '等待该设备发起重建'}</dd></dl><button id="rebuild-end">结束重建</button>`
    : active.length
      ? `<form id="rebuild-arm" class="inline-form"><label><span id="rebuild-device-label">设备</span><select name="deviceId" aria-labelledby="rebuild-device-label">${active.map(d => `<option value="${d.id}">${escape(d.name)}</option>`).join('')}</select></label>${input('输入笔记库名称确认', 'confirm', 'text', 'autocomplete="off" maxlength="128"')}<button class="primary" type="submit">授权 15 分钟</button></form>`
      : '<div class="empty">没有可以授权的设备。</div>';
  const revertTarget = retired.find(r => !r.partial);
  const list = retired.length ? `<h3>保留的旧数据库</h3><table><thead><tr><th>退役时间</th><th>占用</th><th>内容</th><th>操作</th></tr></thead><tbody>${retired.map((r, i) => `<tr><td>${date(r.retiredAt)}</td><td>${bytes(r.diskBytes)}</td><td>${r.partial ? '未完成的重建' : '完整'}</td><td>${r === revertTarget ? '<button id="rebuild-revert">切回此库</button> ' : ''}<button class="danger" id="retired-${i}">删除</button></td></tr>`).join('')}</tbody></table>` : '';
  return `<section class="card table-wrap"><h2>重建笔记库</h2><p>更换加密设置或清理远端数据时使用。授权一台设备后，在该设备的客户端中执行重建远端。原数据库会保留，可以切回；重建完成后，其他设备需要重新获取。</p>${status}${list}</section>`;
}
function bindRebuild(vault: Vault, devices: Device[]) {
  const reload = () => vaultPage(vault);
  if (rebuild) button('rebuild-end', async () => {
    if (rebuild!.started && !confirm('重建设备尚未完成时结束，其他设备会连接到未完成的数据库。继续？')) return;
    await api(`/vaults/${vault.id}/rebuild`, 'DELETE'); await reload(); message('重建已结束。');
  });
  else if (devices.some(d => !d.revoked && d.expiresAt > Date.now())) form('rebuild-arm', async data => {
    await api(`/vaults/${vault.id}/rebuild`, 'POST', Object.fromEntries(data)); await reload(); message('已授权，请在 15 分钟内在该设备上执行重建远端。');
  });
  if (retired.some(r => !r.partial)) button('rebuild-revert', async () => {
    const name = prompt('切回旧数据库后，已从新数据库重新获取的设备需要再次重新获取。输入笔记库名称确认：');
    if (name === null) return;
    await api(`/vaults/${vault.id}/rebuild/revert`, 'POST', { confirm: name }); await reload(); message('已切回旧数据库。');
  });
  retired.forEach((r, i) => button(`retired-${i}`, async () => {
    if (!confirm('删除后无法恢复这个数据库。继续？')) return;
    await api(`/vaults/${vault.id}/databases/${r.name}`, 'DELETE'); await reload(); message('旧数据库已删除。');
  }));
}
const actions: Record<string, string> = { 'user.create': '创建账户', 'user.disable': '禁用账户', 'user.enable': '启用账户', 'user.password-change': '修改密码', 'vault.create': '创建笔记库', 'vault.provision': '完成建库', 'device.issue': '签发设备', 'device.revoke': '撤销设备',
  'vault.rebuild-arm': '授权重建', 'vault.rebuild-end': '结束重建', 'vault.rebuild-switch': '重建切换数据库', 'vault.rebuild-complete': '重建完成', 'vault.rebuild-revert': '撤销重建', 'vault.database-delete': '删除旧数据库' };
async function auditPage() {
  shell('操作记录', '最近 100 条管理动作，记录不包含密码或笔记内容。');
  const events = await api<Audit[]>('/admin/audit');
  content(`<section class="card table-wrap"><table><thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>对象 ID</th></tr></thead><tbody>${events.map(event => `<tr><td>${date(event.occurredAt)}</td><td>${escape(event.actor)}</td><td>${escape(actions[event.action] ?? event.action)}</td><td class="mono">${escape(event.targetId)}</td></tr>`).join('')}</tbody></table></section>`);
}
login();
void run(async () => {
  try { session = await api<Session>('/web-session'); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return; throw error; }
  section = session.user.role === 'admin' ? 'overview' : 'vaults'; await render();
});
