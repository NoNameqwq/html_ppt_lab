import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectBranches } from '../server/project-branches.mjs';
import { captureVersion, readVersionChat } from '../server/version-store.mjs';
import { readChat, saveChat, listChats } from '../server/chat-store.mjs';
import { createProjectBranches } from '../app/js/core/project-branches.js';
import { createBackend } from '../app/js/standalone/backend.js';

const chat = label => ({ messages: [{ role: 'user', id: label, content: label }, { role: 'assistant', content: 'Reply ' + label }], skills: [] });
async function disk(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wds-branches-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ id: 'demo', name: 'Demo' }));
  await fs.writeFile(path.join(dir, 'index.html'), 'original');
  await fs.mkdir(path.join(dir, 'assets'));
  await fs.writeFile(path.join(dir, 'assets/picture.bin'), Buffer.from([0, 255, 3]));
  await saveChat(dir, 'default', chat('early'));
  const version = await captureVersion(dir, { conversation: { projectId: 'demo', sessionId: 'default' }, chat: chat('early') });
  return { dir, version, branches: projectBranches(dir, 'demo') };
}

test('Historical forks and repeated switches preserve independent files, assets, edits and conversations', async t => {
  const { dir, version, branches } = await disk(t);
  await fs.writeFile(path.join(dir, 'index.html'), 'source future');
  await fs.writeFile(path.join(dir, '.raw-timeline.json'), 'source timeline');
  await saveChat(dir, 'default', chat('future'));
  const fork = await branches.fork({ sourceSessionId: 'default', versionId: version.id, name: 'Alternative' });
  const branch = fork.active;
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'original');
  assert.equal((await readChat(dir, branch)).messages[0].content, 'early');
  assert.equal((await readChat(dir, 'default')).messages[0].content, 'future');
  await fs.writeFile(path.join(dir, 'index.html'), 'branch design');
  await fs.writeFile(path.join(dir, 'assets/picture.bin'), Buffer.from([4, 5]));
  await fs.writeFile(path.join(dir, '.raw-timeline.json'), 'branch timeline');
  await saveChat(dir, branch, chat('branch future'));
  await branches.switch({ sourceSessionId: branch, sessionId: 'default' });
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'source future');
  assert.equal(await fs.readFile(path.join(dir, '.raw-timeline.json'), 'utf8'), 'source timeline');
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets/picture.bin')), Buffer.from([0, 255, 3]));
  assert.equal((await readChat(dir, 'default')).messages[0].content, 'future');
  await branches.switch({ sourceSessionId: 'default', sessionId: branch });
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'branch design');
  assert.equal(await fs.readFile(path.join(dir, '.raw-timeline.json'), 'utf8'), 'branch timeline');
  assert.deepEqual(await fs.readFile(path.join(dir, 'assets/picture.bin')), Buffer.from([4, 5]));
  assert.equal((await readChat(dir, branch)).messages[0].content, 'branch future');
  assert.equal((await branches.list()).branches.length, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')).id, 'demo');
});

test('Rewind replaces the active transcript and project without creating a future conversation branch', async t => {
  const { dir, version, branches } = await disk(t);
  const origin = { sessionId: 'source', versionId: version.id };
  await saveChat(dir, 'default', { ...chat('early'), title: 'Active title', origin,
    messages: [...chat('early').messages, ...chat('future').messages], summary: { through: 4, text: 'future' } });
  await fs.writeFile(path.join(dir, 'index.html'), 'future');
  await fs.writeFile(path.join(dir, 'future.html'), 'removed on rewind');
  const rename = fs.rename.bind(fs);
  const lockedFiles = new Set([path.join(dir, '.chat.json'), path.join(dir, '.versions', 'branches.json')]);
  t.mock.method(fs, 'rename', async (source, target) => {
    if (lockedFiles.delete(target)) throw Object.assign(new Error('Temporary file lock'), { code: 'EPERM' });
    return rename(source, target);
  });
  const result = await branches.rewind({ sourceSessionId: 'default', versionId: version.id });
  assert.equal(lockedFiles.size, 0);
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'original');
  await assert.rejects(fs.stat(path.join(dir, 'future.html')), { code: 'ENOENT' });
  const restored = await readChat(dir, 'default');
  assert.deepEqual(restored.messages, chat('early').messages);
  assert.equal(restored.summary, null);
  assert.equal(restored.title, 'Active title');
  assert.deepEqual(restored.origin, origin);
  assert.equal(result.branches[0].head, version.id);
  assert.equal((await listChats(dir)).chats.length, 1);
  assert.equal((await branches.list()).branches.length, 1);
});

test('Empty conversation forks keep the project and remain empty after switching away and back', async t => {
  const { dir, branches } = await disk(t);
  const fork = await branches.fork({ sourceSessionId: 'default', name: 'New conversation', empty: true });
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'original');
  assert.deepEqual((await readChat(dir, fork.active)).messages, []);
  await branches.switch({ sourceSessionId: fork.active, sessionId: 'default' });
  await branches.switch({ sourceSessionId: 'default', sessionId: fork.active });
  assert.deepEqual((await readChat(dir, fork.active)).messages, []);
  assert.equal((await branches.list()).active, fork.active);
  await assert.rejects(branches.switch({ sourceSessionId: 'default', sessionId: fork.active }), /已切换/);
  await assert.rejects(branches.fork({ sourceSessionId: '../invalid' }), /ID 无效/);
});

test('Failed branch commits roll back files, active pointer and conversation; journals recover after restart', async t => {
  const { dir } = await disk(t);
  let state = null, failCommit = true, failRecovery = true;
  const adapter = {
    projectId: 'demo', readState: async () => structuredClone(state),
    writeState: async value => {
      if (state?.pending && !value.pending && failCommit) { failCommit = false; throw Error('Commit interrupted'); }
      state = structuredClone(value);
    },
    readChat: id => readChat(dir, id), saveChat: (id, value) => saveChat(dir, id, value),
    deleteChat: id => fs.rm(path.join(dir, '.chats', id + '.json'), { force: true }),
    capture: options => captureVersion(dir, options), readVersionChat: id => readVersionChat(dir, id),
    restore: async (id, options) => {
      if (state?.pending && id === state.pending.rollback && failRecovery) { failRecovery = false; throw Error('Temporary file lock'); }
      const { restoreVersion } = await import('../server/version-store.mjs'); return restoreVersion(dir, id, options);
    },
  };
  const branches = createProjectBranches(adapter);
  await assert.rejects(branches.fork({ sourceSessionId: 'default', name: 'Failed branch' }), /恢复日志/);
  assert(state.pending);
  await createProjectBranches(adapter).recover();
  assert(!state.pending); assert.equal(state.active, 'default'); assert.equal(state.items.length, 1);
  assert.equal(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), 'original');
  assert.equal((await readChat(dir, 'default')).messages[0].content, 'early');
  assert.equal((await listChats(dir)).chats.length, 1);
});

test('Standalone branch APIs persist independent state and rewind only the active conversation', async () => {
  const p = { meta: { id: 'demo', name: 'Demo' }, files: { 'index.html': 'early', 'assets/picture.bin': 'data:application/octet-stream;base64,AA==' }, chats: { default: chat('early') }, versions: [] };
  const state = { settings: { providers: [], agent: {} }, projects: { demo: p }, templates: {}, imports: {} };
  let persisted;
  const bundle = { resources: {}, skills: [] };
  let backend = createBackend({ state, persist: async () => { persisted = structuredClone(state); } }, bundle, fetch);
  const call = async (route, body) => { const res = await backend.fetch('/api/projects/demo' + route, { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await res.json(); assert(res.ok, JSON.stringify(data)); return data; };
  const early = (await call('/versions', { chat: chat('early'), conversation: { sessionId: 'default', projectId: 'demo' } })).version;
  p.files['index.html'] = 'future'; p.chats.default = chat('future');
  const fork = await call('/branches', { sourceSessionId: 'default', versionId: early.id, name: 'Alternative' });
  assert.equal(p.files['index.html'], 'early'); assert.equal(p.chats[fork.active].messages[0].content, 'early');
  p.files['index.html'] = 'branch future'; p.chats[fork.active] = chat('branch future');
  await call('/branches/switch', { sourceSessionId: fork.active, sessionId: 'default' });
  assert.equal(p.files['index.html'], 'future'); assert.equal(p.chats.default.messages[0].content, 'future');
  backend = createBackend({ state: persisted, persist: async () => {} }, bundle, fetch);
  assert.equal((await call('/branches')).active, 'default');
  await call('/branches/rewind', { sourceSessionId: 'default', versionId: early.id });
  assert.equal(backend.state.projects.demo.files['index.html'], 'early');
  assert.deepEqual(backend.state.projects.demo.chats.default.messages, chat('early').messages);
  assert.equal(Object.keys(backend.state.projects.demo.chats).length, 2);
});
