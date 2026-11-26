import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { normalizeUserInstructions, userInstructionText, skillFromMarkdown, importUserSkills } from '../app/js/core/user-instructions.js';
import { createUserInstructionsForm, openUserInstructions } from '../app/js/agent/user-instructions.js';
import { buildSystemPrompt } from '../app/js/agent/prompt.js';
import { createToolExecutor } from '../app/js/agent/tools.js';
import { createBackend } from '../app/js/standalone/backend.js';

const personal = () => ({ enabled: true, prompt: 'Use precise scientific notation.', skills: [
  { id: 'user-diagram', name: 'Diagram style', content: 'Label every axis.', enabled: true },
  { id: 'user-disabled', name: 'Disabled', content: 'MUST_NOT_APPEAR', enabled: false },
] });
const file = (name, content) => ({ name: name.split('/').at(-1), webkitRelativePath: name, size: Buffer.byteLength(content), text: async () => content });

test('User instructions append to the complete built-in prompt and disabled content stays out', () => {
  const state = { settings: { agent: {} } }, ctx = { store: { get: () => state } };
  const original = buildSystemPrompt(ctx, { skillsText: 'BUNDLED_SKILL_CONTENT', reasoningEffort: 'xhigh' });
  assert.equal(userInstructionText(), '');
  state.settings.agent.userInstructions = personal();
  const customized = buildSystemPrompt(ctx, { skillsText: 'BUNDLED_SKILL_CONTENT', reasoningEffort: 'xhigh' });
  assert.equal(customized.replace(userInstructionText(personal()) + '\n\n', ''), original);
  assert(customized.includes('Use precise scientific notation.'));
  assert(customized.includes('Label every axis.'));
  assert(!customized.includes('MUST_NOT_APPEAR'));
  state.settings.agent.userInstructions.enabled = false;
  assert(!buildSystemPrompt(ctx).includes('Use precise scientific notation.'));
  state.settings.agent.userInstructions.skills[0].enabled = false;
  assert.equal(buildSystemPrompt(ctx, { skillsText: 'BUNDLED_SKILL_CONTENT', reasoningEffort: 'xhigh' }), original);
});

test('Mandatory policy lists only enabled forced skills and supports individual opt-outs from legacy settings', () => {
  const data = { ...personal(), enabled: false };
  const ctx = { store: { get: () => ({ settings: { agent: { userInstructions: normalizeUserInstructions(data) } } }) } };
  assert(!buildSystemPrompt(ctx).includes('Mandatory skill policy'));
  data.skillForceOverrides = { 'user-diagram': true, 'user-disabled': true };
  const required = buildSystemPrompt(ctx, { forcedSkillIds: ['motion-design'] });
  assert(required.includes('Required skill IDs: ["motion-design","user-diagram"]'));
  assert(required.includes('Label every axis.'));
  assert(!required.includes('MUST_NOT_APPEAR'));
  data.forceSkills = true;
  data.skillForceOverrides['user-diagram'] = false;
  assert(!buildSystemPrompt(ctx).includes('Mandatory skill policy'));
  assert(buildSystemPrompt(ctx).includes('Label every axis.'));
});

test('Validation rejects built-in IDs, duplicate IDs, empty skills and oversized UTF-8 content', () => {
  for (const skills of [[{ id: 'deck-code', name: 'Override', content: 'bad' }],
    [...personal().skills, personal().skills[0]], [{ id: 'user-a', name: ' ', content: 'ok' }],
    [{ id: 'user-a', name: 'Fine', content: ' ' }]]) assert.throws(() => normalizeUserInstructions({ skills }));
  assert.throws(() => normalizeUserInstructions({ prompt: '字'.repeat(800000) }), /2MB/);
  assert.deepEqual(normalizeUserInstructions(), { prompt: '', enabled: false, forceSkills: false, skills: [] });
});

test('Markdown imports preserve source and names; nested folders own their references independently', async () => {
  const source = '---\nname: "Science diagrams"\ndescription: Detailed SVG instructions\n---\n# Draw\nKeep all details.';
  const markdown = skillFromMarkdown(source, 'science.md');
  assert.equal(markdown.name, 'Science diagrams');
  assert.equal(markdown.desc, 'Detailed SVG instructions');
  assert.equal(markdown.content, source);
  assert(markdown.id.startsWith('user-'));
  const image = { name: 'large.png', size: 40 * 1024 * 1024, text: () => { throw Error('Must not read binary'); } };
  const imported = await importUserSkills([file('root/SKILL.md', '# Parent'), file('root/reference.md', 'PARENT_REF'),
    file('root/nested/SKILL.md', '# Child'), file('root/nested/code.js', 'CHILD_REF'), image]);
  assert.equal(imported.length, 2);
  assert(imported[0].content.includes('PARENT_REF'));
  assert(!imported[0].content.includes('CHILD_REF'));
  assert(imported[1].content.includes('CHILD_REF'));
  assert(!imported[1].content.includes('PARENT_REF'));
  assert.equal((await importUserSkills([file('A.md', '# A'), file('B.md', '# B')])).length, 2);
  assert.equal((await importUserSkills([image])).length, 0);
});

test('Root SKILL.md excludes nested skills without losing its own reference files', async () => {
  const imported = await importUserSkills([file('SKILL.md', '# Root'), file('reference.md', 'ROOT_REF'),
    file('nested/SKILL.md', '# Nested'), file('nested/ref.md', 'NESTED_REF')]);
  assert(imported[0].content.includes('ROOT_REF'));
  assert(!imported[0].content.includes('NESTED_REF'));
  assert(imported[1].content.includes('NESTED_REF'));
});

test('Forms edit a private draft, support add/remove, and save only through the user endpoint', async () => {
  const { window } = parseHTML('<html><body></body></html>');
  const previous = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = window.document; globalThis.Node = window.Node;
  try {
    const value = personal(), original = structuredClone(value), form = createUserInstructionsForm(value);
    const prompt = form.el.querySelector('[aria-label="自定义系统提示词"]'); prompt.value = 'A user-authored prompt';
    const name = form.el.querySelector('[aria-label="Skill 名称"]'); name.value = 'Renamed'; name.dispatchEvent(new window.Event('input'));
    assert.equal(form.el.querySelector('summary').textContent, 'Renamed');
    assert.equal(form.getValue().skills[0].name, 'Renamed');
    assert.deepEqual(value, original);
    const buttons = () => [...form.el.querySelectorAll('button')];
    buttons().find(b => b.textContent === '新建 Skill').click(); assert.equal(form.getValue().skills.length, 3);
    buttons().find(b => b.textContent === '移除').click(); assert.equal(form.getValue().skills.length, 2);
    const state = { settings: { agent: { maxTokens: 1024, userInstructions: value } } };
    let spec, saved = 0, refreshed = 0;
    const ctx = { store: { get: () => state, update: fn => fn(state) }, dialog: { open: s => { spec = s; } },
      agent: { loop: { refreshContext: () => refreshed++ } }, toast: { ok() {}, error: msg => { throw Error(msg); } },
      api: { putUserSettings: async patch => { saved++; return { agent: { ...state.settings.agent, ...patch.agent } }; } } };
    openUserInstructions(ctx);
    spec.body.querySelector('[aria-label="自定义系统提示词"]').value = 'Saved preference';
    assert.equal(await spec.actions.find(a => a.label === '保存').onClick(), true);
    assert.equal(saved, 1); assert.equal(refreshed, 1);
    assert.equal(state.settings.agent.maxTokens, 1024);
    assert.equal(state.settings.agent.userInstructions.prompt, 'Saved preference');
  } finally { Object.assign(globalThis, previous); }
});

test('Static settings persist user instructions across reloads, reject tool writes, and keep bundled skills unchanged', async () => {
  let persisted;
  const state = { settings: { providers: [], agent: {} }, projects: {}, templates: {}, imports: {} };
  const bundle = { resources: {}, skills: [{ id: 'bundled', content: 'Immutable bundled skill' }] };
  const before = structuredClone(bundle);
  const backend = createBackend({ state, persist: async () => { persisted = structuredClone(state); } }, bundle, fetch);
  const put = (target, body) => backend.fetch(target, { method: 'PUT', body: JSON.stringify(body) });
  assert.equal((await put('/api/settings', { agent: { userInstructions: personal() } })).status, 403);
  assert.equal((await put('/api/settings/user', { agent: { userInstructions: personal() } })).status, 200);
  const expected = normalizeUserInstructions(personal());
  assert.deepEqual(persisted.settings.agent.userInstructions, expected);
  const reloaded = createBackend({ state: persisted, persist: async () => {} }, bundle, fetch);
  assert.deepEqual((await (await reloaded.fetch('/api/settings')).json()).agent.userInstructions, expected);
  assert.equal((await put('/api/settings/user', { agent: { userInstructions: { skills: [{ id: 'bundled' }] } }, ui: { invalidWrite: true } })).status, 400);
  assert.deepEqual(backend.state.settings.agent.userInstructions, expected);
  assert(!backend.state.settings.ui?.invalidWrite);
  assert.deepEqual(bundle, before);
});

test('Agent API and command tools cannot modify personal instructions', async () => {
  let calls = 0;
  const executor = createToolExecutor({ store: { get: () => ({}) }, bus: {
    hasCommand: () => true, listCommands: () => [], runCommand: () => { calls++; },
  } });
  const result = await executor.execute('app_call_api', { operation: 'settings.write', body: { agent: { userInstructions: personal() } } }, { permission: 'full' });
  assert.equal(result.ok, false);
  assert.equal((await executor.execute('app_run_command', { name: 'agent.openUserInstructions' }, { permission: 'full' })).ok, false);
  assert.equal(calls, 0);
});

test('BAT backend persists custom content independently of built-ins and rejects invalid writes atomically', async t => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wds-instructions-'));
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), WDS_LOG: '0',
    WDS_DATA_DIR: path.join(temp, 'data'), WDS_PROJECTS_DIR: path.join(temp, 'projects') }, stdio: 'pipe', windowsHide: true });
  let logs = ''; child.stderr.on('data', data => { logs += data; }); child.stdout.on('data', () => {});
  t.after(async () => { if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } await fs.rm(temp, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch {}
    if (attempt >= 100 || child.exitCode !== null) throw Error('Backend did not start: ' + logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const request = async (route, body) => { const response = await fetch(base + route, body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return { response, data: await response.json() }; };
  const before = (await request('/api/skills')).data;
  assert.equal((await request('/api/settings', { agent: { userInstructions: personal() } })).response.status, 403);
  assert.equal((await request('/api/settings/user', { agent: { userInstructions: personal(), temperature: 0.3 } })).response.status, 200);
  const expected = normalizeUserInstructions(personal());
  assert.deepEqual((await request('/api/settings')).data.agent.userInstructions, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temp, 'data/settings.json'), 'utf8')).agent.userInstructions, expected);
  assert.equal((await request('/api/settings/user', { agent: { userInstructions: { skills: [{ id: 'builtin' }] } }, ui: { invalidWrite: true } })).response.status, 400);
  assert.equal((await request('/api/settings')).data.agent.temperature, 0.3);
  assert(!(await request('/api/settings')).data.ui.invalidWrite);
  assert.deepEqual((await request('/api/skills')).data, before);
});
