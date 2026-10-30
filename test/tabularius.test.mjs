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
      ['edit', 'b/索引.md', null, false], ['create', 'b/新.md', null, false], ['edit', '私密.md', null, true]]);
    assert.equal(built.changes[2].after, '- [笔记](../c/旧名.md)\n');
    assert.equal(built.changes[4].after, '[x](c/旧名.md)\n');
    assert.equal(built.repaired, 1);

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
  assert.deepEqual(checkParams('vllm', '{"temperature":0.6,"top_k":20,"chat_template_kwargs":{"enable_thinking":false}}').top_k, 20);
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
