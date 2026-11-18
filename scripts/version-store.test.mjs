import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureVersion, inspectVersion, listVersions, restoreVersion, recoverVersionTransaction, withProjectLock } from '../server/version-store.mjs';
import { readChat, saveChat, listChats } from '../server/chat-store.mjs';

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wds-versions-'));
  const put = async (rel, data) => { const file = path.join(dir, rel); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };
  const get = (rel) => fs.readFile(path.join(dir, rel), 'utf8');
  try {
    await put('index.html', '<html>原始页面</html>'); await put('project.json', JSON.stringify({ name: '初始工程', kind: 'raw' }));
    await fn({ dir, put, get });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
test('Full checkpoints restore source, binary assets, raw state and history, remove new files and preserve chats', () => fixture(async ({ dir, put, get }) => {
  const image = Buffer.from([0, 255, 128, 7, 240, 0, 11]);
  await put('assets/image.bin', image); await put('original/index.html', '原稿');
  for (const rel of ['.raw-edits.json', '.raw-deck.json', '.raw-timeline.json', '.history.json']) await put(rel, '{"before":true}');
  await saveChat(dir, 'default', { messages: [{ role: 'user', content: '对话完整保留' }] });
  const before = await captureVersion(dir, { label: '初始版本' });
  await fs.rm(path.join(dir, 'assets'), { recursive: true }); await put('assets', '目录变成文件');
  await put('index.html', '新页面'); await put('project.json', '{"name":"新名字"}');
  await put('.raw-edits.json', '[]'); await put('new/deep.js', '新增');
  const changes = await inspectVersion(dir, before.id);
  assert(changes.changes.some((f) => f.path === 'new/deep.js' && f.action === 'remove'));
  const restored = await restoreVersion(dir, before.id);
  assert.equal(await get('index.html'), '<html>原始页面</html>');
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets/image.bin')), image);
  assert.equal(JSON.parse(await get('project.json')).name, '初始工程');
  for (const rel of ['.raw-edits.json', '.raw-deck.json', '.raw-timeline.json', '.history.json']) assert.equal(await get(rel), '{"before":true}');
  await assert.rejects(() => get('new/deep.js'), { code: 'ENOENT' });
  assert.equal((await readChat(dir)).messages[0].content, '对话完整保留');
  assert(restored.backup.id); assert.equal((await listVersions(dir)).length, 2);
  // A restore itself can be undone, including file/directory type changes.
  await restoreVersion(dir, restored.backup.id);
  assert.equal(await get('index.html'), '新页面'); assert.equal(await get('assets'), '目录变成文件');
  assert.equal(await get('new/deep.js'), '新增');
}));
test('Identical file and conversation blobs are deduplicated without pruning checkpoints', () => fixture(async ({ dir }) => {
  await captureVersion(dir); const initial = await fs.readdir(path.join(dir, '.versions/blobs'));
  for (let i = 0; i < 35; i++) await captureVersion(dir, { label: '第' + i + '轮' });
  assert.deepEqual(await fs.readdir(path.join(dir, '.versions/blobs')), initial);
  assert.equal((await listVersions(dir)).length, 36);
}));
test('Conversation rewind preserves future messages in an accessible named branch and keeps the checkpoint self reference', () => fixture(async ({ dir, put }) => {
  const beforeChat = { messages: [{ role: 'user', content: '第一轮', turnId: 'turn-1', versions: { test: { before: 'baseline' } } }, { role: 'assistant', content: '第一轮完成' }], summary: null, skills: ['design'] };
  const version = await captureVersion(dir, { kind: 'after', label: '第一轮之后', conversation: { projectId: 'test', sessionId: 'default', turnId: 'turn-1', phase: 'after' }, chat: beforeChat });
  const future = [...beforeChat.messages, { role: 'user', content: '第二轮' }, { role: 'assistant', content: '第二轮完成' }];
  await saveChat(dir, 'default', { messages: future, summary: { through: 2, text: '第二轮的摘要' } });
  await put('index.html', '未来页面');
  const result = await restoreVersion(dir, version.id, { rewindConversation: true });
  assert.equal((await readChat(dir)).messages.length, 2);
  assert.equal((await readChat(dir)).messages[0].versions.test.after, version.id);
  assert.equal((await readChat(dir)).summary, null);
  const archived = await readChat(dir, result.conversation.archivedSession);
  assert.deepEqual(archived.messages, future); assert.equal(archived.summary.through, 2);
  assert((await listChats(dir)).chats.some((c) => c.id === result.conversation.archivedSession && c.title.startsWith('回退前分支')));
  await restoreVersion(dir, result.backup.id, { rewindConversation: true });
  assert.deepEqual((await readChat(dir)).messages, future);
}));
test('Legacy HTML backups are honestly scoped and do not change assets, raw patches or conversations', () => fixture(async ({ dir, put, get }) => {
  await put('.versions/2026-11-13T02-44-00-123Z.html', '历史 HTML');
  await put('assets/new.png', '素材'); await put('.raw-edits.json', '当前补丁');
  const versions = await listVersions(dir), legacy = versions.find((v) => v.kind === 'legacy');
  assert(legacy); assert.equal(legacy.fileCount, 1); assert.equal(legacy.hasConversation, false);
  assert.equal((await inspectVersion(dir, legacy.id)).changes.length, 1);
  await assert.rejects(() => restoreVersion(dir, legacy.id, { rewindConversation: true }), /没有对应的对话/);
  await restoreVersion(dir, legacy.id);
  assert.equal(await get('index.html'), '历史 HTML'); assert.equal(await get('assets/new.png'), '素材'); assert.equal(await get('.raw-edits.json'), '当前补丁');
}));
test('Missing or corrupted snapshot data fails before any live project file is changed', () => fixture(async ({ dir, put, get }) => {
  const v = await captureVersion(dir); await put('index.html', '保留当前工程');
  const manifest = JSON.parse(await get('.versions/manifests/' + v.id + '.json'));
  await put('.versions/blobs/' + manifest.files['index.html'].hash, '损坏的数据');
  await assert.rejects(() => restoreVersion(dir, v.id), /校验失败/);
  assert.equal(await get('index.html'), '保留当前工程'); assert.equal((await listVersions(dir)).length, 1);
}));
test('Invalid IDs and manifest paths cannot address outside the project or overwrite conversations', () => fixture(async ({ dir, put, get }) => {
  for (const id of ['../escape', 'v-../../', '', 'legacy-../outside']) await assert.rejects(() => restoreVersion(dir, id), /ID 无效/);
  const v = await captureVersion(dir), rel = '.versions/manifests/' + v.id + '.json', data = JSON.parse(await get(rel));
  for (const invalid of ['../outside', '.chat.json', '.chats/x.json', '.versions/x', 'C:/outside', 'assets/../../outside', 'assets\\x', 'assets/x:stream']) {
    await put(rel, JSON.stringify({ ...data, files: { [invalid]: data.files['index.html'] } }));
    await assert.rejects(() => restoreVersion(dir, v.id), /路径无效/);
    assert.equal(await get('index.html'), '<html>原始页面</html>');
  }
}));
test('Project links are rejected before capture or restore can affect their target', () => fixture(async ({ dir, put, get }) => {
  const v = await captureVersion(dir), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'wds-version-link-'));
  try {
    await fs.writeFile(path.join(outside, 'keep.txt'), '保留');
    await fs.symlink(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => captureVersion(dir), /工程含链接/);
    await assert.rejects(() => restoreVersion(dir, v.id), /工程含链接/);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), '保留'); assert.equal(await get('index.html'), '<html>原始页面</html>');
  } finally { await fs.rm(path.join(dir, 'linked'), { force: true, recursive: true }); await fs.rm(outside, { recursive: true, force: true }); }
}));
test('Interrupted directory swaps are recovered from the transaction journal', () => fixture(async ({ dir, put, get }) => {
  await captureVersion(dir);
  const id = 'v-mock-123456abcdef';
  await put('.versions/transactions/' + id + '/old/index.html', '<html>原始页面</html>');
  await put('index.html', '交换时的临时状态'); await put('new-file.txt', '尚未提交的新增');
  await put('.versions/transaction.json', JSON.stringify({ id, names: ['index.html', 'new-file.txt', 'project.json'], original: ['index.html', 'project.json'] }));
  await recoverVersionTransaction(dir);
  assert.equal(await get('index.html'), '<html>原始页面</html>');
  assert.equal(JSON.parse(await get('project.json')).name, '初始工程');
  await assert.rejects(() => get('new-file.txt'), { code: 'ENOENT' });
  await recoverVersionTransaction(dir);
}));
test('Project operations serialize and the queue survives a failed request', () => fixture(async ({ dir }) => {
  const order = [];
  const first = withProjectLock(dir, async () => { order.push(1); await new Promise((r) => setTimeout(r, 15)); order.push(2); throw new Error('expected'); });
  const second = withProjectLock(dir, async () => { order.push(3); return 'done'; });
  await assert.rejects(() => first, /expected/); assert.equal(await second, 'done'); assert.deepEqual(order, [1, 2, 3]);
}));

const denied = (code = 'EPERM') => Object.assign(new Error('simulated file sharing violation'), { code });
const transactionSource = (file, phase) => String(file).split(path.sep).includes(phase) && String(file).includes(path.sep + 'transactions' + path.sep);

test('Restore never renames asset directories or rewrites unchanged locked assets', t => fixture(async ({ dir, put, get }) => {
  await put('assets/locked.bin', 'unchanged asset');
  const version = await captureVersion(dir), asset = path.join(dir, 'assets/locked.bin');
  const originalStat = await fs.stat(asset);
  await put('index.html', 'current source');
  const rename = fs.rename.bind(fs), copy = fs.copyFile.bind(fs), unlink = fs.unlink.bind(fs);
  let directoryRenames = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (source === path.join(dir, 'assets')) { directoryRenames++; throw denied(); }
    if (source === asset || target === asset) throw denied();
    return rename(source, target);
  });
  t.mock.method(fs, 'copyFile', async (source, target) => { if (target === asset) throw denied(); return copy(source, target); });
  t.mock.method(fs, 'unlink', async target => { if (target === asset) throw denied(); return unlink(target); });
  await restoreVersion(dir, version.id);
  assert.equal(directoryRenames, 0);
  assert.equal(await get('index.html'), '<html>原始页面</html>');
  assert.equal(await get('assets/locked.bin'), 'unchanged asset');
  assert.equal((await fs.stat(asset)).mtimeMs, originalStat.mtimeMs);
}));

test('Transient file sharing violations retry before installing a changed file', t => fixture(async ({ dir, put, get }) => {
  const version = await captureVersion(dir); await put('index.html', 'current');
  const rename = fs.rename.bind(fs); let attempts = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (transactionSource(source, 'next') && target === path.join(dir, 'index.html') && ++attempts < 3) throw denied('EBUSY');
    return rename(source, target);
  });
  await restoreVersion(dir, version.id);
  assert.equal(attempts, 3); assert.equal(await get('index.html'), '<html>原始页面</html>');
}));

test('Files denying rename but permitting writes restore through verified copying', t => fixture(async ({ dir, put, get }) => {
  await put('assets/image.bin', 'old bytes'); const version = await captureVersion(dir);
  await put('assets/image.bin', 'new bytes');
  const rename = fs.rename.bind(fs), copy = fs.copyFile.bind(fs); let copies = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (transactionSource(source, 'next') && target === path.join(dir, 'assets/image.bin')) throw denied();
    return rename(source, target);
  });
  t.mock.method(fs, 'copyFile', async (source, target) => { copies++; return copy(source, target); });
  await restoreVersion(dir, version.id);
  assert.equal(copies, 1); assert.equal(await get('assets/image.bin'), 'old bytes');
  await assert.rejects(() => get('.versions/transaction.json'), { code: 'ENOENT' });
}));

test('A late write failure restores all earlier writes and keeps future conversation in its backup branch', t => fixture(async ({ dir, put, get }) => {
  await put('assets/image.bin', 'old asset');
  const past = { messages: [{ role: 'user', content: 'past' }] };
  const version = await captureVersion(dir, { conversation: { projectId: 'test', sessionId: 'default' }, chat: past });
  await put('assets/image.bin', 'future asset'); await put('index.html', 'future page'); await put('new/notes.txt', 'future notes');
  const future = { messages: [{ role: 'user', content: 'future' }] }; await saveChat(dir, 'default', future);
  const rename = fs.rename.bind(fs), copy = fs.copyFile.bind(fs); let installedAssets = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (transactionSource(source, 'next') && target === path.join(dir, 'index.html')) throw denied();
    if (transactionSource(source, 'next') && target === path.join(dir, 'assets/image.bin')) installedAssets++;
    return rename(source, target);
  });
  t.mock.method(fs, 'copyFile', async (source, target) => {
    if (transactionSource(source, 'next') && target === path.join(dir, 'index.html')) throw denied();
    return copy(source, target);
  });
  await assert.rejects(() => restoreVersion(dir, version.id, { rewindConversation: true }), e => e.status === 409 && /已恢复回退前的完整工程/.test(e.message));
  assert.equal(installedAssets, 1); assert.equal(await get('assets/image.bin'), 'future asset');
  assert.equal(await get('index.html'), 'future page'); assert.equal(await get('new/notes.txt'), 'future notes');
  assert.deepEqual((await readChat(dir)).messages, future.messages);
  const backup = (await listVersions(dir)).find(v => v.kind === 'backup'); assert(backup?.hasConversation);
  const branch = (await listChats(dir)).chats.find(c => c.id.startsWith('branch-')); assert(branch);
  assert.deepEqual((await readChat(dir, branch.id)).messages, future.messages);
  await assert.rejects(() => get('.versions/transaction.json'), { code: 'ENOENT' });
}));

test('Blocked rollback retains its durable journal and can be recovered repeatedly after releasing the lock', t => fixture(async ({ dir, put, get }) => {
  await put('assets/image.bin', 'old asset'); const version = await captureVersion(dir);
  await put('assets/image.bin', 'future asset'); await put('index.html', 'future page');
  const rename = fs.rename.bind(fs), copy = fs.copyFile.bind(fs); let locked = true;
  const blocks = (source, target) => locked && ((transactionSource(source, 'next') && target === path.join(dir, 'index.html'))
    || (transactionSource(source, 'rollback') && target === path.join(dir, 'assets/image.bin')));
  t.mock.method(fs, 'rename', async (source, target) => { if (blocks(source, target)) throw denied(); return rename(source, target); });
  t.mock.method(fs, 'copyFile', async (source, target) => { if (blocks(source, target)) throw denied(); return copy(source, target); });
  await assert.rejects(() => restoreVersion(dir, version.id), e => e.status === 409 && /恢复日志已保留/.test(e.message));
  const journal = JSON.parse(await get('.versions/transaction.json')); assert.equal(journal.schema, 2);
  assert.equal(await get('assets/image.bin'), 'old asset');
  locked = false; await recoverVersionTransaction(dir); await recoverVersionTransaction(dir);
  assert.equal(await get('assets/image.bin'), 'future asset'); assert.equal(await get('index.html'), 'future page');
  await assert.rejects(() => get('.versions/transaction.json'), { code: 'ENOENT' });
}));

test('Interrupted file reconciliation recovers directory type changes, deleted files and empty directories', () => fixture(async ({ dir, put, get }) => {
  await put('assets/image.bin', 'before image'); await put('document', 'before file');
  await fs.mkdir(path.join(dir, 'empty'));
  const version = await captureVersion(dir), baseline = JSON.parse(await get('.versions/manifests/' + version.id + '.json'));
  await fs.rm(path.join(dir, 'assets'), { recursive: true }); await put('assets', 'incomplete file');
  await fs.unlink(path.join(dir, 'document')); await put('document/nested.txt', 'incomplete directory');
  await put('new/deep.txt', 'uncommitted'); await put('index.html', 'incomplete page'); await fs.rmdir(path.join(dir, 'empty'));
  const before = Object.fromEntries(Object.entries(baseline.files).filter(([rel]) => rel !== 'project.json'));
  await put('.versions/transaction.json', JSON.stringify({ schema: 2, id: 'v-mock-123456abcdef', before,
    paths: [...Object.keys(before), 'assets', 'document/nested.txt', 'new/deep.txt'], beforeDirectories: ['assets', 'empty'], afterDirectories: ['document', 'new'] }));
  await recoverVersionTransaction(dir); await recoverVersionTransaction(dir);
  assert.equal(await get('assets/image.bin'), 'before image'); assert.equal(await get('document'), 'before file');
  assert.equal(await get('index.html'), '<html>原始页面</html>'); assert((await fs.stat(path.join(dir, 'empty'))).isDirectory());
  await assert.rejects(() => get('new/deep.txt'), { code: 'ENOENT' });
}));

test('Legacy recovery restores moved assets in place, including nested private-looking names', t => fixture(async ({ dir, put, get }) => {
  const id = 'v-mock-123456abcdef';
  await put('.versions/transactions/' + id + '/old/assets/image.bin', 'before image');
  await put('.versions/transactions/' + id + '/old/assets/.chat.json', 'ordinary nested asset');
  await put('.versions/transactions/' + id + '/old/assets/.git/data', 'ordinary nested data');
  await put('assets/image.bin', 'incomplete image'); await put('assets/new.txt', 'uncommitted');
  await put('.versions/transaction.json', JSON.stringify({ id, names: ['assets', 'index.html', 'project.json'], original: ['assets', 'index.html', 'project.json'] }));
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (source, target) => {
    if ((await fs.lstat(source)).isDirectory()) throw denied();
    return rename(source, target);
  });
  await recoverVersionTransaction(dir);
  assert.equal(await get('assets/image.bin'), 'before image'); assert.equal(await get('assets/.chat.json'), 'ordinary nested asset');
  assert.equal(await get('assets/.git/data'), 'ordinary nested data'); await assert.rejects(() => get('assets/new.txt'), { code: 'ENOENT' });
}));

test('Invalid transaction paths and conflicting rollback structures fail before live writes', () => fixture(async ({ dir, put, get }) => {
  const version = await captureVersion(dir), baseline = JSON.parse(await get('.versions/manifests/' + version.id + '.json'));
  await put('index.html', 'keep current');
  const base = { schema: 2, id: 'v-mock-123456abcdef', before: { 'index.html': baseline.files['index.html'] }, paths: ['index.html'], beforeDirectories: [], afterDirectories: [] };
  for (const patch of [{ paths: ['index.html', '../outside'] }, { beforeDirectories: ['index.html'] }, { afterDirectories: ['new/deep'] }]) {
    await put('.versions/transaction.json', JSON.stringify({ ...base, ...patch }));
    await assert.rejects(() => recoverVersionTransaction(dir), /路径无效|结构冲突/);
    assert.equal(await get('index.html'), 'keep current');
  }
}));

test('Legacy HTML-only transaction recovery accepts unrelated roots in the original list', () => fixture(async ({ dir, put, get }) => {
  const id = 'v-mock-123456abcdef';
  await put('.versions/transactions/' + id + '/old/index.html', 'before page');
  await put('index.html', 'uncommitted page'); await put('assets/image.bin', 'unchanged image');
  await put('.versions/transaction.json', JSON.stringify({ id, names: ['index.html'], original: ['index.html', 'project.json', 'assets'] }));
  await recoverVersionTransaction(dir);
  assert.equal(await get('index.html'), 'before page'); assert.equal(await get('assets/image.bin'), 'unchanged image');
  assert.equal(JSON.parse(await get('project.json')).name, '初始工程');
}));

test('Windows handles denying delete sharing allow unchanged and writable asset restores', { skip: process.platform !== 'win32', timeout: 20000 }, () => fixture(async ({ dir, put, get }) => {
  await put('assets/image.bin', 'before image'); const version = await captureVersion(dir);
  await put('assets/image.bin', 'future image'); await put('index.html', 'future page');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$file=[IO.File]::Open($env:WDS_LOCK_ASSET,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null } finally { $file.Dispose() }'],
    { windowsHide: true, env: { ...process.env, WDS_LOCK_ASSET: path.join(dir, 'assets/image.bin') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let timeout;
  try {
    await Promise.race([once(child.stdout, 'data').then(([data]) => assert.match(data.toString(), /ready/)),
      once(child, 'exit').then(([code]) => { throw new Error('Lock helper exited early: ' + code); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Lock helper did not become ready')), 10000); })]);
    clearTimeout(timeout);
    await assert.rejects(() => fs.rename(path.join(dir, 'assets'), path.join(dir, 'moved-assets')), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code));
    await restoreVersion(dir, version.id);
    assert.equal(await get('assets/image.bin'), 'before image'); assert.equal(await get('index.html'), '<html>原始页面</html>');
    // A second restore leaves the still-open, unchanged asset alone.
    await put('index.html', 'future again'); await restoreVersion(dir, version.id);
    assert.equal(await get('assets/image.bin'), 'before image');
  } finally {
    clearTimeout(timeout); const exited = once(child, 'exit'); child.stdin.end('\n');
    if (child.exitCode === null) await exited;
  }
}));
