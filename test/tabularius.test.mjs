import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openStore } from '../dist/store.js';
import { chunk, search, update } from '../dist/tabularius/search.js';
import { createFilter, REDACTED } from '../dist/tabularius/filter.js';
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
