import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../dist/store.js';
import { chunk, search, update } from '../dist/tabularius/search.js';
import { applyMaskedEdit, createFilter, REDACTED } from '../dist/tabularius/filter.js';
import { repairLinks } from '../dist/tabularius/links.js';
import { apply, build, ProposalError } from '../dist/tabularius/proposals.js';
import { readFile, stat, utimes } from 'node:fs/promises';
import { open, seal } from '../dist/tabularius/client.js';

test('chunks follow headings, skip front matter and keep fenced headings as text', () => {
  const chunks = chunk('---\ntitle: x\n---\n# 标题\n\n导语\n\n## 安装\n\n```bash\n# 注释不是标题\napt install x\n```\n\n### 验证\n\n运行 x --version\n');
  assert.deepEqual(chunks.map(c => c.heading), ['标题', '标题 > 安装', '标题 > 安装 > 验证']);
  assert.match(chunks[1].text, /# 注释不是标题/);
  assert(!chunks.some(c => c.text.includes('title: x')));
});

test('long sections are split near 1,500 characters', () => {
  const paragraphs = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(400)).join('\n\n');
  const chunks = chunk(`## 长\n\n${paragraphs}\n`);
  assert(chunks.length >= 3);
  assert(chunks.every(c => c.text.length <= 3000));
  assert.equal(chunks.map(c => c.text).join('\n\n'), paragraphs);
});

test('masking replaces credentials and keeps the surrounding text', () => {
  const filter = createFilter('', 'ZETA-\\d+');
  const masked = filter.mask([
    'password: hunter2', '口令：天王盖地虎', 'api_key=abc123', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz end',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'ZETA-42',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', '端口 8443',
  ].join('\n'));
  for (const secret of ['hunter2', '天王盖地虎', 'abc123', 'abcdefghijklmnopqrstuvwxyz', 'AKIAABCDEFGHIJKLMNOP', 'ZETA-42', 'b3BlbnNzaC1rZXktdjEAAAAA']) assert(!masked.includes(secret), secret);
  assert.match(masked, /password: \[REDACTED\]/);
  assert.match(masked, /key \[REDACTED\] end/);
  assert.match(masked, /端口 8443/);
  assert(masked.includes(REDACTED));
});

test('exclusion globs match files and whole folders', () => {
  const filter = createFilter('私密\n*.secret.md\n日记/**\n', '');
  assert(filter.excluded('私密/a.md'));
  assert(filter.excluded('私密/深/b.md'));
  assert(filter.excluded('x.secret.md'));
  assert(filter.excluded('日记/2026/10.md'));
  assert(!filter.excluded('公开/私密.md'));
  assert(!filter.excluded('readme.md'));
});

test('sealed values open with the same key only', () => {
  const key = randomBytes(32);
  const blob = seal(key, '口令 passphrase');
  assert.equal(open(key, blob), '口令 passphrase');
  assert(!blob.includes(Buffer.from('passphrase')));
  assert.throws(() => open(randomBytes(32), blob));
});

test('index updates incrementally and search combines full text, short terms and vectors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabularius-index-'));
  const db = openStore(join(dir, 'app.sqlite'));
  try {
    db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES('u','u','x','user')").run();
    db.prepare("INSERT INTO vaults(id,owner_id,name,database_name,state) VALUES('v','u','v','d','ready')").run();
    const root = join(dir, 'vault');
    await mkdir(join(root, '运维'), { recursive: true });
    await mkdir(join(root, '.obsidian'), { recursive: true });
    await writeFile(join(root, '运维/紫藤服务器.md'), '# 紫藤服务器\n\n管理端口 8443。\n');
    await writeFile(join(root, '运维/银杏.md'), '# 银杏\n\n备份在周日。\n');
    await writeFile(join(root, '.obsidian/app.md'), '紫藤服务器 hidden\n');
    await writeFile(join(root, 'image.png'), 'binary');
    let embedded = [];
    const embedder = { model: 'm', embed: async texts => { embedded.push(...texts); return texts.map(text => Float32Array.from({ length: 4 }, (_, i) => text.includes('备份') ? (i === 0 ? 1 : 0) : (i === 1 ? 1 : 0))); } };
    const filter = createFilter('', '');
    assert.equal(await update(db, 'v', root, filter, embedder), 2);
    assert.equal(await update(db, 'v', root, filter, embedder), 0, 'unchanged notes are skipped');
    assert.equal(embedded.length, 2);

    assert.equal((await search(db, 'v', '紫藤服务器'))[0].path, '运维/紫藤服务器.md');
    assert.equal((await search(db, 'v', '银杏'))[0].path, '运维/银杏.md', 'two-character terms use a substring scan');
    // The query vector points at the backup chunk although no word matches.
    const vectorQuery = { model: 'm', embed: async texts => texts.map(() => Float32Array.from([1, 0, 0, 0])) };
    assert.equal((await search(db, 'v', 'weekly copies', vectorQuery))[0].path, '运维/银杏.md');

    await rm(join(root, '运维/银杏.md'));
    await new Promise(r => setTimeout(r, 20));
    await writeFile(join(root, '运维/紫藤服务器.md'), '# 紫藤服务器\n\n管理端口改为 9443。\n');
    assert.equal(await update(db, 'v', root, filter, embedder), 2);
    assert.deepEqual((await search(db, 'v', '9443')).map(h => h.path), ['运维/紫藤服务器.md']);
    assert.deepEqual(await search(db, 'v', '8443'), []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tabularius_files').get().n, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('edits on masked text keep the masked values', () => {
  const filter = createFilter('', '');
  const original = '## 数据库\n\n地址 db.local\npassword: hunter2\ntoken=abc123 备注\n';
  const masked = filter.mask(original);
  assert.equal(masked, `## 数据库\n\n地址 db.local\npassword: ${REDACTED}\ntoken=${REDACTED} 备注\n`);
  const edited = applyMaskedEdit(filter, original, `地址 db.local\npassword: ${REDACTED}\ntoken=${REDACTED}`, `主机 \`db.local\`\npassword: ${REDACTED}\ntoken=${REDACTED}`);
  assert.equal(edited, '## 数据库\n\n主机 `db.local`\npassword: hunter2\ntoken=abc123 备注\n');
  assert.equal(applyMaskedEdit(filter, original, `password: ${REDACTED}\n`, ''), '## 数据库\n\n地址 db.local\ntoken=abc123 备注\n');
  assert.throws(() => applyMaskedEdit(filter, original, `password: ${REDACTED}`, `password: ${REDACTED} ${REDACTED}`), /more \[REDACTED\]/);
  assert.throws(() => applyMaskedEdit(filter, original, 'password: [RED', 'x'), /cuts through/);
  assert.throws(() => applyMaskedEdit(filter, original, 'hunter2', 'x'), /not found/);
  assert.throws(() => applyMaskedEdit(filter, 'a a', 'a', 'b'), /more than once/);
});

test('links follow moved notes', () => {
  const before = new Set(['a/旧 名.md', 'b/索引.md', 'a/图.png', 'c/其他.md', 'd/旧 名.md']);
  const after = new Set(['x/新名.md', 'b/索引.md', 'a/图.png', 'c/其他.md', 'd/旧 名.md']);
  const moves = new Map([['a/旧 名.md', 'x/新名.md']]);
  const index = '[看](../a/旧%20名.md#安装) [别处](../c/其他.md) [网](https://e.com/a.md) [[a/旧 名|别名]] [[旧 名]] [[其他]]';
  assert.equal(repairLinks(index, 'b/索引.md', 'b/索引.md', moves, before, after),
    '[看](../x/新名.md#安装) [别处](../c/其他.md) [网](https://e.com/a.md) [[x/新名|别名]] [[旧 名]] [[其他]]');
  // The moved note's own relative links are recomputed from its new folder.
  assert.equal(repairLinks('![图](图.png) [b](../b/索引.md)', 'a/旧 名.md', 'x/新名.md', moves, before, after), '![图](../a/图.png) [b](../b/索引.md)');
});

test('proposals are checked against the working copy and applied without turning back modification times', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tabularius-proposal-'));
  try {
    await mkdir(join(root, 'a'), { recursive: true }); await mkdir(join(root, 'b')); await mkdir(join(root, '.livesync'));
    await writeFile(join(root, 'a/旧名.md'), '# 旧名\n\npassword: hunter2\n');
    await writeFile(join(root, 'a/附图.png'), Buffer.from([1, 2, 3]));
    await writeFile(join(root, 'b/索引.md'), '- [旧名](../a/旧名.md)\n');
    await writeFile(join(root, '私密.md'), '[x](a/旧名.md)\n');
    await writeFile(join(root, '.livesync/x.md'), 'internal');
    const old = new Date('2020-01-01');
    await utimes(join(root, 'a/旧名.md'), old, old);
    const filter = createFilter('私密.md', '');

    await assert.rejects(build(root, filter, { title: 't', changes: [
      { op: 'edit', path: 'a/旧名.md', edits: [{ old: 'nothing', new: 'x' }] },
      { op: 'create', path: 'b/索引.md', content: 'x' },
      { op: 'delete', path: '私密.md' },
      { op: 'create', path: 'n.md', content: REDACTED },
      { op: 'move', from: '../etc', to: 'x' },
    ] }), error => error instanceof ProposalError && error.message.split('\n').length === 5);

    const built = await build(root, filter, { title: '改名', summary: 's', changes: [
      { op: 'move', from: 'a', to: 'c' },
      { op: 'edit', path: 'b/索引.md', edits: [{ old: '- [旧名]', new: '- [笔记]' }] },
      { op: 'create', path: 'b/新.md', content: '新的\n' },
    ] });
    assert.deepEqual(built.changes.map(c => [c.op, c.path, c.to, c.automatic]), [
      ['move', 'a/旧名.md', 'c/旧名.md', false], ['move', 'a/附图.png', 'c/附图.png', false],
      ['edit', 'b/索引.md', null, false], ['create', 'b/新.md', null, false]]);
    assert.equal(built.changes[2].after, '- [笔记](../c/旧名.md)\n');
    // 私密.md is excluded from Tabularius: its link is not repaired either.
    assert.equal(built.repaired, 0);

    await writeFile(join(root, 'b/索引.md'), 'changed elsewhere\n');
    await assert.rejects(apply(root, built.changes), /changed\tb\/索引.md/);
    assert.equal(await readFile(join(root, 'a/旧名.md'), 'utf8'), '# 旧名\n\npassword: hunter2\n');
    await writeFile(join(root, 'b/索引.md'), '- [旧名](../a/旧名.md)\n');

    await apply(root, built.changes);
    assert.equal(await readFile(join(root, 'c/旧名.md'), 'utf8'), '# 旧名\n\npassword: hunter2\n');
    assert((await stat(join(root, 'c/旧名.md'))).mtimeMs > old.getTime() + 86_400_000);
    assert.deepEqual([...await readFile(join(root, 'c/附图.png'))], [1, 2, 3]);
    await assert.rejects(stat(join(root, 'a')));
    assert.equal(await readFile(join(root, 'b/新.md'), 'utf8'), '新的\n');
    await assert.rejects(apply(root, built.changes), /missing\t/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('model parameters are checked per provider', async () => {
  const { checkParams, ParamsError } = await import('../dist/tabularius/params.js');
  assert.deepEqual(checkParams('anthropic', '{"effort":"high","max_tokens":32000}'), { effort: 'high', max_tokens: 32000 });
  assert.deepEqual(checkParams('anthropic', ''), {});
  assert.throws(() => checkParams('anthropic', '{"temperature":0.7}'), ParamsError);
  assert.throws(() => checkParams('openai', '{"reasoning_effort":"huge"}'), /reasoning_effort/);
  assert.deepEqual(checkParams('vllm', { temperature: 0.6, top_k: 20, enable_thinking: false, stop: ['</done>'], ignore_eos: true }).top_k, 20, 'vLLM takes custom parameters');
  assert.throws(() => checkParams('vllm', { chat_template_kwargs: {} }), /cannot be set/, 'fields the server fills in are reserved');
  assert.throws(() => checkParams('vllm', { stop: ['', 'x'] }), /stop/);
  assert.throws(() => checkParams('openai', { ignore_eos: true }), /not a parameter/, 'only vLLM takes custom parameters');
  const { vllmBody } = await import('../dist/tabularius/params.js');
  assert.deepEqual(vllmBody({ temperature: 0.6, enable_thinking: false }), { temperature: 0.6, chat_template_kwargs: { enable_thinking: false } });
  assert.throws(() => checkParams('vllm', '{"top_k":1.5}'), /top_k/);
  assert.throws(() => checkParams('vllm', '[1]'), /JSON object/);
});

test('web fetch addresses follow the permission mode', async () => {
  const { addressPolicy, domainAllowed, htmlText, urlsIn } = await import('../dist/tabularius/web.js');
  const readOnly = addressPolicy('read-only', []);
  assert.equal(readOnly('93.184.216.34', 'example.com'), true);
  assert.equal(readOnly('2606:4700::1111', 'x'), true);
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.10.100', '169.254.169.254', '::1', 'fd00::1', '100.64.0.1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) assert.equal(readOnly(address, 'x'), false, address);
  const restricted = addressPolicy('restricted', ['192.168.10.0/24', 'gitlab.lan']);
  assert.equal(restricted('192.168.10.100', 'oblivaria'), true);
  assert.equal(restricted('10.0.0.9', 'gitlab.lan'), true);
  assert.equal(restricted('10.0.0.9', 'other.lan'), false);
  assert.equal(addressPolicy('full', [])('127.0.0.1', 'localhost'), true);
  // Hosts registered as forbidden are refused in every mode, by address in any spelling or by name.
  for (const mode of ['read-only', 'restricted', 'full']) {
    const policy = addressPolicy(mode, ['192.168.10.0/24', '198.18.0.0/15'], ['192.168.10.1', 'router.lan', 'fd00::1']);
    for (const [address, host] of [['192.168.10.1', 'x'], ['::ffff:192.168.10.1', 'x'], ['::ffff:c0a8:a01', 'x'], ['198.18.0.7', 'ROUTER.lan'], ['fd00:0::1', 'x']]) assert.equal(policy(address, host), false, `${mode} ${address} ${host}`);
    assert.equal(policy('93.184.216.34', 'example.com'), true, mode);
  }
  assert.equal(addressPolicy('restricted', ['192.168.10.0/24'], ['192.168.10.1'])('192.168.10.100', 'oblivaria'), true);
  assert.equal(addressPolicy('full', [], ['192.168.10.1'])('10.0.0.9', 'x'), true);
  // Every fetch connects anew: a connection left open by a fetch in full mode is not reused by one in read-only mode.
  const { fetchPage } = await import('../dist/tabularius/web.js');
  const { createServer } = await import('node:http');
  const local = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', connection: 'keep-alive' }); res.end('local page'); }).listen(0, '127.0.0.1');
  await new Promise(resolve => local.once('listening', resolve));
  const page = `http://localhost:${local.address().port}/`;
  const options = { allowed: [], blocked: [], maxUses: 5 };
  try {
    assert.equal((await fetchPage(options, addressPolicy('full', []), page)).text, 'local page');
    await assert.rejects(fetchPage(options, addressPolicy('read-only', []), page), /does not allow/);
    await assert.rejects(fetchPage(options, addressPolicy('full', [], ['localhost']), page), /does not allow/);
  } finally { local.closeAllConnections(); local.close(); }
  assert.equal(domainAllowed({ allowed: ['docs.vllm.ai'], blocked: [], maxUses: 1 }, 'https://docs.vllm.ai/en/latest'), true);
  assert.equal(domainAllowed({ allowed: ['docs.vllm.ai'], blocked: [], maxUses: 1 }, 'https://vllm.ai'), false);
  assert.equal(domainAllowed({ allowed: [], blocked: ['example.org'], maxUses: 1 }, 'https://a.example.org/x'), false);
  assert.equal(htmlText('<p>a &amp; b</p><script>x()</script><div>c&#x4e2d;</div>'), 'a & b\n\nc中');
  assert.deepEqual(urlsIn('见 https://example.com/a#x，以及 (https://b.org/c).'), ['https://example.com/a', 'https://b.org/c']);
});

test('the vLLM history drops whole exchanges from the start', async () => {
  const { fit } = await import('../dist/tabularius/providers.js');
  const question = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });
  const call = (id) => ({ role: 'assistant', parts: [{ type: 'tool_call', id, name: 'read_note', input: { path: 'x'.repeat(300) } }] });
  const result = (id) => ({ role: 'user', parts: [{ type: 'tool_result', id, content: 'y'.repeat(3000) }] });
  const history = [question('first'), call('a'), result('a'), { role: 'assistant', parts: [{ type: 'text', text: 'one' }] },
    question('second'), call('b'), result('b'), { role: 'assistant', parts: [{ type: 'text', text: 'two' }] }, question('third'), call('c'), result('c')];
  assert.equal(fit(history, 100_000), history);
  const kept = fit(history, 2000);
  assert.match(kept[0].parts[0].text, /left out/);
  assert.equal(kept[1].parts[0].text, 'third', 'the current exchange stays even when it alone is over the budget');
  assert.deepEqual(kept.slice(1), history.slice(8));
  const some = fit(history, 3500);
  assert.equal(some[1].parts[0].text, 'second');
});

test('commands are checked by permission mode', async () => {
  const { refuse } = await import('../dist/tabularius/ssh.js');
  assert.equal(refuse('read-only', 'systemctl status nginx', ''), undefined);
  assert.equal(refuse('read-only', 'docker compose logs --tail 50 server', ''), undefined);
  assert.match(refuse('read-only', 'systemctl restart nginx', ''), /read-only/);
  for (const command of ['cat a; rm b', 'cat a | sh', 'cat $(id)', 'echo x > /etc/passwd', 'cat `id`', 'ls\nrm x']) assert.match(refuse('read-only', command, ''), /shell operators/, command);
  assert.match(refuse('read-only', 'find / -name x -delete', ''), /change the host/);
  for (const command of ['ip route flush table main', 'ip addr add 10.0.0.1/24 dev eth0', 'date -s 2020-01-01', 'hostname evil', 'journalctl --vacuum-size=1',
    'git diff --output=/tmp/x', 'ss -K dst 10.0.0.1', 'tail -f /var/log/syslog', 'tail -nF 5 x', 'find / -fprint0 /tmp/x']) assert.match(refuse('read-only', command, ''), /change the host/, command);
  for (const command of ['ip addr show', 'ip route', 'date', 'hostname', 'journalctl -u nginx -n 50', 'git log -n 5', 'ss -tlnp', 'tail -n 50 /var/log/syslog']) assert.equal(refuse('read-only', command, ''), undefined, command);
  assert.equal(refuse('restricted', 'systemctl restart nginx', 'systemctl restart nginx\ndocker compose -f /opt/x/compose.yaml up -d *'), undefined);
  assert.equal(refuse('restricted', 'docker compose -f /opt/x/compose.yaml up -d --wait server', 'docker compose -f /opt/x/compose.yaml up -d *'), undefined);
  assert.match(refuse('restricted', 'systemctl restart sshd', 'systemctl restart nginx'), /allow list/);
  assert.match(refuse('restricted', 'systemctl restart nginx extra', 'systemctl restart nginx'), /allow list/);
  assert.equal(refuse('restricted', 'touch /tmp/made', 'touch /tmp/*'), undefined);
  assert.match(refuse('restricted', 'touch /etc/x', 'touch /tmp/*'), /allow list/);
  assert.match(refuse('restricted', 'touch /tmp/../etc/x', 'touch /tmp/*'), /allow list/);
  assert.equal(refuse('full', 'apt-get upgrade -y && reboot', ''), undefined);
  assert.match(refuse('full', '  ', ''), /empty/);
});

test('attachments: images by their first bytes, text files, PDFs with and without text', async () => {
  const { examine, imageType, TEXT_LIMIT } = await import('../dist/tabularius/attachments.js');
  assert.equal(imageType(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png');
  assert.equal(imageType(Buffer.from('ffd8ffe000', 'hex')), 'image/jpeg');
  assert.equal(imageType(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(imageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  // An image is what its bytes say, whatever it is called.
  assert.deepEqual(await examine(Buffer.from('89504e470d0a1a0a0000', 'hex')), { kind: 'image', mime: 'image/png' });
  assert.deepEqual(await examine(Buffer.from('﻿host: a\npassword: hunter2\n')), { kind: 'text', mime: 'text/plain', text: 'host: a\npassword: hunter2\n' });
  await assert.rejects(examine(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0xff])), /Not a text file/);
  await assert.rejects(examine(Buffer.alloc(0)), /empty/);
  const long = await examine(Buffer.from('字'.repeat(TEXT_LIMIT + 10)));
  assert.match(long.text, /\[Truncated: the file has 200010 characters\.\]$/);
  // Minimal PDFs: one with a line of text, one with only a drawing, and a broken one.
  const pdf = stream => {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let out = '%PDF-1.4\n'; const offsets = [];
    objects.forEach((object, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    return Buffer.from(`${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
  };
  assert.deepEqual(await examine(pdf('BT /F1 18 Tf 20 100 Td (Hello attachment) Tj ET')), { kind: 'text', mime: 'application/pdf', text: '[Page 1]\nHello attachment' });
  await assert.rejects(examine(pdf('0 0 1 rg 10 10 50 50 re f')), /no text layer/);
  await assert.rejects(examine(Buffer.from('%PDF-1.4 broken')), /cannot be read/);
});

test('sealed attachment bytes come back unchanged', async () => {
  const { openBytes } = await import('../dist/tabularius/client.js');
  const key = randomBytes(32);
  const bytes = randomBytes(4096);
  assert(openBytes(key, seal(key, bytes)).equals(bytes));
  assert.equal(open(key, seal(key, '文字')), '文字');
});

test('images count as a fixed number of tokens when the vLLM history is fitted', async () => {
  const { fit } = await import('../dist/tabularius/providers.js');
  const image = { type: 'image', mime: 'image/png', data: 'A'.repeat(300_000) };
  // A large encoded picture alone does not push the earlier exchange out of a 6,000-token window.
  const messages = [
    { role: 'user', parts: [{ type: 'text', text: 'first' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] },
    { role: 'user', parts: [image, { type: 'text', text: 'second' }] },
  ];
  assert.equal(fit(messages, 6000).length, 3);
});

test('each provider gets pictures in its own format and files as text', async () => {
  const { startMockProviders } = await import('../../../tests/tabularius/mock-providers.mjs');
  const { anthropic, openai, vllm } = await import('../dist/tabularius/providers.js');
  const mock = await startMockProviders();
  process.env.ANTHROPIC_BASE_URL = mock.url; process.env.OPENAI_BASE_URL = `${mock.url}/v1`;
  try {
    const messages = [{ role: 'user', parts: [{ type: 'image', mime: 'image/png', data: 'iVBORw0K' }, { type: 'text', text: 'Attached file: a.log\n\nline' }, { type: 'text', text: '紫藤服务器' }] }];
    await anthropic('claude-opus-5-5', 'k').turn('system', [], messages, () => {});
    assert.deepEqual(mock.requests.anthropic.at(-1).body.messages[0].content.slice(0, 2), [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }, { type: 'text', text: 'Attached file: a.log\n\nline' }]);
    await openai('gpt-test', 'k').turn('system', [], messages, () => {});
    assert.deepEqual(mock.requests.openai.at(-1).body.input.slice(0, 2), [
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,iVBORw0K', detail: 'auto' }] }, { role: 'user', content: 'Attached file: a.log\n\nline' }]);
    await vllm('esmeralda', `${mock.url}/vllm/v1`).turn('system', [], messages, () => {});
    assert.deepEqual(mock.requests.vllm.at(-1).body.messages.slice(1, 3), [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } }] }, { role: 'user', content: 'Attached file: a.log\n\nline' }]);
  } finally {
    delete process.env.ANTHROPIC_BASE_URL; delete process.env.OPENAI_BASE_URL;
    await mock.close();
  }
});

test('deleting a conversation deletes its attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tabularium-attachments-'));
  const db = openStore(join(dir, 'app.sqlite'));
  try {
    db.prepare("INSERT INTO users(id, username, password_hash, role) VALUES('u', 'alice', 'x', 'user')").run();
    db.prepare("INSERT INTO vaults(id, owner_id, name, database_name, state) VALUES('v', 'u', 'notes', 'db', 'ready')").run();
    db.prepare("INSERT INTO tabularius_conversations(id, user_id, vault_id, title, system, created_at, updated_at) VALUES('c', 'u', 'v', 't', '', 0, 0)").run();
    const add = (id, conversation) => db.prepare("INSERT INTO tabularius_attachments(id, user_id, vault_id, conversation_id, name, mime, kind, size, data, created_at) VALUES(?, 'u', 'v', ?, 'a.txt', 'text/plain', 'text', 1, x'00', 0)").run(id, conversation);
    add('sent', 'c'); add('unsent', null);
    db.prepare("DELETE FROM tabularius_conversations WHERE id='c'").run();
    assert.deepEqual(db.prepare('SELECT id FROM tabularius_attachments').all().map(row => row.id), ['unsent']);
  } finally { db.close(); await rm(dir, { recursive: true }); }
});

test('projects group conversations; the archive keeps them; another user reaches neither', async () => {
  const { createProjects } = await import('../dist/tabularius/projects.js');
  const dir = await mkdtemp(join(tmpdir(), 'tabularium-projects-'));
  const db = openStore(join(dir, 'app.sqlite'));
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  try {
    for (const [id, name] of [['u', 'alice'], ['w', 'eve']]) db.prepare("INSERT INTO users(id, username, password_hash, role) VALUES(?, ?, 'x', 'user')").run(id, name);
    for (const id of ['v', 'v2']) db.prepare("INSERT INTO vaults(id, owner_id, name, database_name, state) VALUES(?, 'u', 'notes', ?, 'ready')").run(id, id);
    for (const id of ['a', 'b']) db.prepare("INSERT INTO tabularius_conversations(id, user_id, vault_id, title, system, created_at, updated_at) VALUES(?, 'u', 'v', 't', '', 0, 0)").run(id);
    const projects = createProjects(db, fail);
    const alice = { id: 'u' }, eve = { id: 'w' };
    const conversation = id => db.prepare('SELECT id, vault_id, title, project_id, archived_at FROM tabularius_conversations WHERE id=?').get(id);
    const ops = projects.create('v', alice, '  运维 ');
    assert.equal(ops.name, '运维');
    assert.throws(() => projects.create('v', alice, ' '), /Invalid name/);
    projects.arrange(conversation('a'), alice, { project: ops.id, title: '紫藤  端口', archived: true });
    assert.deepEqual({ ...conversation('a') }, { id: 'a', vault_id: 'v', title: '紫藤 端口', project_id: ops.id, archived_at: conversation('a').archived_at });
    assert(conversation('a').archived_at > 0);
    projects.arrange(conversation('a'), alice, { archived: false });
    assert.equal(conversation('a').archived_at, null);
    // Another user's project, or one in another vault, cannot hold the conversation.
    const other = projects.create('v', eve, 'eve');
    const elsewhere = projects.create('v2', alice, '别处');
    assert.throws(() => projects.arrange(conversation('b'), alice, { project: other.id }), /Project not found/);
    assert.throws(() => projects.arrange(conversation('b'), alice, { project: elsewhere.id }), /Project not found/);
    assert.throws(() => projects.rename(ops.id, eve, 'x'), /Project not found/);
    assert.throws(() => projects.remove(ops.id, eve), /Project not found/);
    assert.deepEqual(projects.list('v', alice).map(p => p.name), ['运维']);
    projects.rename(ops.id, alice, '服务器');
    // Deleting the project leaves its conversation ungrouped.
    projects.remove(ops.id, alice);
    assert.equal(conversation('a').project_id, null);
    assert.equal(conversation('a').title, '紫藤 端口');
  } finally { db.close(); await rm(dir, { recursive: true }); }
});

test('user masks run in linear time and RE2-incompatible ones are refused', async () => {
  const { checkMasks } = await import('../dist/tabularius/filter.js');
  const filter = createFilter('', 'ZETA-\\d+\n(a|aa)*b');
  assert.equal(filter.mask('密码 ZETA-42 和 ZETA-7'), `密码 ${REDACTED} 和 ${REDACTED}`);
  const started = Date.now();
  filter.mask('a'.repeat(100_000));
  assert(Date.now() - started < 2000, 'an alternation under a star does not take exponential time');
  checkMasks('ZETA-\\d+\n(a|aa)*b');
  assert.throws(() => checkMasks('(a)\\1'));
  assert.throws(() => checkMasks('(?<=x)y'));
  assert.throws(() => checkMasks('x'.repeat(301)), /too long/);
});

test('Gemini, DeepSeek and Ollama: requests in their own formats, and what each must get back replayed', async () => {
  const { createServer } = await import('node:http');
  const { gemini, deepseek, ollama } = await import('../dist/tabularius/providers.js');
  const requests = { gemini: [], deepseek: [], ollama: [] };
  const sse = (res, chunks) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`); res.end(); };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const piece of req) body += piece;
    const json = body ? JSON.parse(body) : {};
    if (req.url.startsWith('/v1beta/models/gemini-test:streamGenerateContent')) {
      requests.gemini.push({ json, key: req.headers['x-goog-api-key'] });
      return sse(res, requests.gemini.length === 1
        ? [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_notes', args: { query: '紫藤' } }, thoughtSignature: 'sig-A' }] } }] }]
        : [{ candidates: [{ content: { role: 'model', parts: [{ text: '端口是 ' }] } }] },
          { candidates: [{ content: { role: 'model', parts: [{ text: '8443', thoughtSignature: 'sig-B' }] }, groundingMetadata: { webSearchQueries: ['紫藤 端口'], groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'A' } }] } }] }]);
    }
    if (req.url === '/chat/completions') {
      requests.deepseek.push(json);
      const delta = d => ({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'deepseek-test', choices: [{ index: 0, delta: d, finish_reason: null }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunks = requests.deepseek.length === 1
        ? [delta({ reasoning_content: '先查' }), delta({ reasoning_content: '笔记' }), delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"query":' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: '"紫藤"}' } }] })]
        : [delta({ reasoning_content: '有了' }), delta({ content: '8443' })];
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    if (req.url === '/api/chat') {
      requests.ollama.push(json);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const lines = requests.ollama.length === 1
        ? [{ message: { role: 'assistant', content: '', thinking: '想一想' } }, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_notes', arguments: { query: '紫藤' } } }] } }, { done: true }]
        : [{ message: { role: 'assistant', content: '8443' } }, { done: true }];
      res.end(lines.map(line => JSON.stringify(line)).join('\n') + '\n'); return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  process.env.GEMINI_BASE_URL = url; process.env.DEEPSEEK_BASE_URL = url;
  const tools = [{ name: 'search_notes', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
  const question = { role: 'user', parts: [{ type: 'text', text: '紫藤的端口？' }, { type: 'image', mime: 'image/png', data: 'iVBORw0K' }] };
  /** One tool round and the answer: the second request carries the first turn back. */
  const loop = async provider => {
    const first = await provider.turn('system', tools, [question], () => {}, { params: provider.name === 'ollama' ? { num_ctx: 65536, think: 'high' } : provider.name === 'deepseek' ? { thinking: true } : { thinking_level: 'low' } });
    const call = first.parts.find(part => part.type === 'tool_call');
    assert.equal(call.name, 'search_notes'); assert.deepEqual(call.input, { query: '紫藤' });
    let text = '';
    const second = await provider.turn('system', tools, [question, { role: 'assistant', parts: first.parts, native: first.native },
      { role: 'user', parts: [{ type: 'tool_result', id: call.id, content: '紫藤：8443' }] }], piece => { text += piece; });
    return { first, second, text };
  };
  try {
    const g = await loop(gemini('gemini-test', 'g-key'));
    assert.equal(requests.gemini[0].key, 'g-key');
    assert.deepEqual(requests.gemini[0].json.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } });
    assert.deepEqual(requests.gemini[0].json.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });
    const replayed = requests.gemini[1].json.contents;
    assert.equal(replayed[1].role, 'model');
    assert.equal(replayed[1].parts[0].thoughtSignature, 'sig-A', 'the signature goes back as it came');
    assert.deepEqual(replayed[2].parts[0].functionResponse, { id: g.first.parts.find(p => p.type === 'tool_call').id, name: 'search_notes', response: { result: '紫藤：8443' } });
    assert.equal(g.text, '端口是 8443');
    assert.deepEqual(g.second.native.content, [{ text: '端口是 8443', thoughtSignature: 'sig-B' }], 'streamed text pieces become one part with the last signature');
    assert.deepEqual(g.second.parts.filter(p => p.type !== 'text'), [{ type: 'web', name: 'web_search', input: { query: '紫藤 端口' } }, { type: 'source', url: 'https://example.com/a', title: 'A' }]);
    // Another model gets the neutral parts, with the placeholder signature.
    await gemini('gemini-test', 'g-key').turn('system', tools, [question, { role: 'assistant', parts: g.first.parts, native: { ...g.first.native, model: 'gemini-other' } }], () => {});
    assert.equal(requests.gemini[2].json.contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
    // A configured domain list turns Google Search off: the provider asks for the server's tools instead.
    assert.equal(gemini('gemini-test', 'g-key', false).nativeWeb, false);

    const d = await loop(deepseek('deepseek-test', 'd-key'));
    assert.deepEqual(requests.deepseek[0].thinking, { type: 'enabled' });
    // system, the question's text and picture, the assistant's tool call, the tool's result
    assert.equal(requests.deepseek[1].messages[3].reasoning_content, '先查笔记', 'reasoning goes back on the tool-call turn');
    assert.equal(requests.deepseek[1].messages[4].role, 'tool');
    assert.equal(d.text, '8443');

    const o = await loop(ollama('qwen-test', url, undefined, 8192));
    assert.equal(requests.ollama[0].think, 'high');
    assert.equal(requests.ollama[0].options.num_ctx, 65536, "the recipe's context length");
    assert.deepEqual(requests.ollama[0].messages[2], { role: 'user', content: '', images: ['iVBORw0K'] });
    assert.equal(requests.ollama[1].options.num_ctx, 8192, 'otherwise the given one, always sent');
    assert.equal(requests.ollama[1].messages[3].thinking, '想一想');
    assert.deepEqual(requests.ollama[1].messages[3].tool_calls, [{ function: { name: 'search_notes', arguments: { query: '紫藤' } } }]);
    assert.deepEqual(requests.ollama[1].messages[4], { role: 'tool', content: '紫藤：8443', tool_name: 'search_notes' });
    assert.equal(o.text, '8443');
  } finally {
    delete process.env.GEMINI_BASE_URL; delete process.env.DEEPSEEK_BASE_URL;
    server.close();
  }
});

test('parameters of the new providers are checked and become their request fields', async () => {
  const { checkParams, deepseekBody, geminiConfig, ollamaRequest } = await import('../dist/tabularius/params.js');
  assert.deepEqual(geminiConfig(checkParams('gemini', { temperature: 0.4, max_output_tokens: 2048, thinking_level: 'high' })), { temperature: 0.4, maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'high' } });
  assert.throws(() => checkParams('gemini', { min_p: 0.1 }), /not a parameter of gemini/);
  assert.deepEqual(deepseekBody(checkParams('deepseek', { thinking: false, max_tokens: 1024 })), { max_tokens: 1024, thinking: { type: 'disabled' } });
  assert.throws(() => checkParams('deepseek', { reasoning_effort: 'medium' }), /low, high, max/);
  assert.deepEqual(ollamaRequest(checkParams('ollama', { think: 'off', num_ctx: 16384, repeat_penalty: 1.2 })), { think: false, options: { num_ctx: 16384, repeat_penalty: 1.2 } });
  assert.throws(() => checkParams('ollama', { num_ctx: 100 }), /2048/);
});

test('a stored default prompt gets the new sortspec.md lines unless the administrator changed them', async () => {
  const { createSettings } = await import('../dist/tabularius/settings.js');
  const { DEFAULT_PROMPT, FORMER_PROMPT_LINES } = await import('../dist/tabularius/prompt.js');
  const secret = randomBytes(32);
  const former = FORMER_PROMPT_LINES.reduce((prompt, [old, current]) => prompt.replace(current, old), DEFAULT_PROMPT);
  const dir = await mkdtemp(join(tmpdir(), 'tabularius-prompt-'));
  let count = 0;
  const fresh = () => {
    const db = openStore(join(dir, `app-${count++}.sqlite`));
    createSettings(db, secret);
    return db;
  };
  const stored = (db) => JSON.parse(db.prepare("SELECT value FROM tabularius_settings WHERE key='prompt'").get().value);
  const reopen = (db, prompt) => {
    db.prepare("UPDATE tabularius_settings SET value=? WHERE key='prompt'").run(JSON.stringify(prompt));
    createSettings(db, secret);
    return stored(db);
  };
  assert.notEqual(former, DEFAULT_PROMPT);
  assert.equal(reopen(fresh(), former), DEFAULT_PROMPT);
  const edited = former.replace(FORMER_PROMPT_LINES[1][0], '- Sort order: my own rule.');
  const kept = reopen(fresh(), edited);
  assert(kept.includes('- Sort order: my own rule.'));
  assert(kept.includes(FORMER_PROMPT_LINES[0][1]));
  await rm(dir, { recursive: true, force: true });
});
