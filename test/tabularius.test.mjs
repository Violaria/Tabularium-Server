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
