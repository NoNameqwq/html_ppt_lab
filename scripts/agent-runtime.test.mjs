import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { readSSE } from '../app/js/core/sse.js';
import { proxyChat } from '../server/agent-proxy.mjs';
import { readChat, saveChat, listChats } from '../server/chat-store.mjs';
import { createAgentLoop } from '../app/js/agent/loop.js';
import { createToolExecutor, mutationProject } from '../app/js/agent/tools.js';
import { sanitizeConversation, memoryChunks } from '../app/js/agent/conversation.js';
import { messageTokens } from '../app/js/agent/conversation.js';

globalThis.localStorage = { data: new Map(), getItem(k) { return this.data.get(k) || null; }, setItem(k, v) { this.data.set(k, v); }, removeItem(k) { this.data.delete(k); } };
const emitText = (fn, text, reason = 'stop') => { fn({ type: 'delta', content: text }); fn({ type: 'done', finish_reason: reason }); };
function fixture(handler, messages = [], options = {}) {
  localStorage.data.clear();
  const snapshot = { agent: {}, project: { id: 'test', name: '测试' }, deck: { total: 1, current: 0, slides: [] }, history: { ops: [], cursor: 0 }, settings: {
    loaded: true, providers: [{ id: 'test', name: 'test', keySet: true, model: 'test', models: [{ id: 'test', contextLength: 131072, maxOutput: 8192 }] }], agent: { contextLimit: 131072, maxTokens: 8192 },
  } };
  Object.assign(snapshot.settings.agent, options);
  const saved = [], requests = [], hooks = { errors: [], done: [] };
  const ctx = { store: { get: () => snapshot, update: (fn) => fn(snapshot) }, bus: { listCommands: () => [], emit() {}, hasCommand: () => true, runCommand: async () => ({ ok: true }) },
    api: { skills: async () => ({ skills: [] }), getChat: async () => ({ messages, skills: [] }), putChat: async (id, body, session) => { saved.push(structuredClone({ id, body, session })); }, listChats: async () => ({ chats: [] }),
      chatStream: async (payload, callback, signal) => { requests.push(payload); await handler(payload, callback, signal, requests.length); } },
  };
  const loop = createAgentLoop(ctx, { onError: (e) => hooks.errors.push(e), onDone: (e) => hooks.done.push(e) });
  return { ctx, loop, snapshot, requests, saved, hooks };
}

function checkpointFixture(handler, history = []) {
  const f = fixture(handler, history), versions = [], writes = [];
  f.ctx.api.createVersion = async (id, options) => { const version = { id: 'version-' + versions.length }; versions.push(structuredClone({ id, options, version })); return { version }; };
  f.ctx.bus.runCommand = async (name) => { writes.push({ name, snapshotsBeforeWrite: versions.length }); return { ok: true }; };
  return { ...f, versions, writes };
}
function toolReply(cb, names = ['insert.text']) {
  cb({ type: 'tool_calls', tool_calls: names.map((name, i) => ({ id: 'write-' + i, type: 'function', function: { name: 'app_run_command', arguments: JSON.stringify({ name }) } })) });
  cb({ type: 'done', finish_reason: 'tool_calls' });
}
test('Mutating turns capture a single before checkpoint and a complete after checkpoint, including durable turn links', async () => {
  const old = [{ role: 'user', content: '旧请求' }, { role: 'assistant', content: '旧回复' }];
  const f = checkpointFixture(async (_, cb, signal, n) => n === 1 ? toolReply(cb, ['insert.text', 'insert.shape']) : emitText(cb, '完成修改'), old);
  await f.loop.load('test'); await f.loop.send('改成蓝色');
  assert.equal(f.versions.length, 2); assert.equal(f.writes.length, 2); assert(f.writes.every((w) => w.snapshotsBeforeWrite === 1));
  assert.deepEqual(f.versions[0].options.chat.messages.map(({ role, content }) => ({ role, content })), old); assert.equal(f.versions[0].options.chat.summary, null);
  assert(f.versions[0].options.chat.messages[0].turnId, 'Legacy turns acquire durable IDs on load');
  assert.equal(f.versions[1].options.chat.messages.at(-1).content, '完成修改');
  assert.equal(f.versions[1].options.chat.messages.filter((m) => m.role === 'tool').length, 2);
  const user = f.saved.at(-1).body.messages.find((m) => m.content === '改成蓝色');
  assert.equal(user.versions.test.before, 'version-0'); assert.equal(user.versions.test.after, 'version-1'); assert.equal(user.versions.test.pending, undefined);
  assert.equal(user.deliveries[0].versionId,'version-1');assert.equal(user.deliveries[0].status,'complete');
});
test('Read-only turns and denied nested API calls create no project checkpoints', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '仅建议，不修改'));
  await f.loop.load('test'); await f.loop.send('先分析'); assert.equal(f.versions.length, 0);
  let checkpoints = 0;
  const result = await createToolExecutor(f.ctx).execute('app_call_api', { operation: 'files.write', body: { content: 'x' } }, { permission: 'read', beforeMutation: async () => { checkpoints++; } });
  assert.equal(result.ok, false); assert.equal(checkpoints, 0);
  assert.equal(mutationProject(f.ctx, 'app_call_api', { operation: 'timeline.write', projectId: 'other' }), 'other');
  assert.equal(mutationProject(f.ctx, 'app_call_api', { operation: 'settings.write' }), null);
  assert.equal(mutationProject(f.ctx, 'app_call_api', { operation: 'models.list' }), null);
});
test('A checkpoint failure blocks the project write and remains visible in the actual tool result', async () => {
  const f = checkpointFixture(async (_, cb, signal, n) => n === 1 ? toolReply(cb) : emitText(cb, '版本保存失败，未执行修改'));
  f.ctx.api.createVersion = async () => { throw new Error('磁盘空间不足'); };
  await f.loop.load('test'); await f.loop.send('修改');
  assert.equal(f.writes.length, 0);
  const result = JSON.parse(f.loop.messages.find((m) => m.role === 'tool').content);
  assert.equal(result.ok, false); assert.match(result.error, /磁盘空间不足/);
});
test('Stop and resume preserve the original before version and create new after versions without replaying writes', async () => {
  const f = checkpointFixture(async (_, cb, signal, n) => {
    if (n === 1 || n === 3) return toolReply(cb);
    if (n === 2) {
      cb({ type: 'delta', content: '已经完成第一项。' });
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')), { once: true }));
    } else emitText(cb, '继续完成第二项。');
  });
  await f.loop.load('test'); const pending = f.loop.send('完成两项');
  while (f.requests.length < 2) await new Promise((r) => setTimeout(r, 2));
  f.loop.stop(); await pending;
  assert.equal(f.versions.length, 2); assert.equal(f.writes.length, 1);
  await f.loop.resume();
  assert.equal(f.versions.length, 3); assert.equal(f.writes.length, 2);
  assert.equal(f.versions.filter((v) => v.options.kind === 'before').length, 1);
  assert.equal(f.loop.messages[0].versions.test.before, 'version-0'); assert.equal(f.loop.messages[0].versions.test.after, 'version-2');
});
test('Rewinding reloads the restored conversation without flushing the discarded future over it', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '未来回复'));
  await f.loop.load('test'); await f.loop.send('未来请求');
  let restoreIndex;
  f.ctx.api.restoreVersion = async () => {
    restoreIndex = f.saved.length;
    f.ctx.api.getChat = async () => ({ messages: [{ role: 'user', content: '历史请求' }, { role: 'assistant', content: '历史回复' }], skills: [], summary: null });
    return { ok: true, version: { label: '历史版本' }, conversation: { sessionId: 'default', archivedSession: 'branch-history' } };
  };
  await f.loop.restoreCheckpoint('version', { rewindConversation: true });
  assert.equal(f.loop.messages.at(-1).content, '历史回复'); assert.equal(f.saved.length, restoreIndex);
  await f.loop.flush(); assert.equal(f.saved.at(-1).body.messages.at(-1).content, '历史回复');
});
test('Resume finalizes a pending checkpoint after browser interruption even if no additional writes are needed', async () => {
  const f = checkpointFixture(async (_, cb) => emitText(cb, '确认当前状态，已完成'), [
    { role: 'user', content: '中断前请求', turnId: 'interrupted', versions: { test: { before: 'original-before', pending: true } } },
    { role: 'assistant', content: '中断前的进度', incomplete: true },
  ]);
  await f.loop.load('test'); await f.loop.resume();
  assert.equal(f.versions.length, 1); assert.equal(f.versions[0].options.kind, 'after');
  assert.equal(f.loop.messages[0].versions.test.before, 'original-before'); assert.equal(f.loop.messages[0].versions.test.after, 'version-0');
  assert.equal(f.loop.messages[0].versions.test.pending, undefined);
});
test('SSE preserves fragmented Unicode, CRLF, multiline events and final unterminated frame', async () => {
  const bytes = new TextEncoder().encode(': pulse\r\nevent: message\r\ndata: {"text":\r\ndata: "你好 🌱"}\r\n\r\ndata: {"last":true}');
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close(); } });
  const events = []; for await (const event of readSSE(body)) events.push(event);
  assert.equal(JSON.parse(events[0].data).text, '你好 🌱'); assert.equal(JSON.parse(events[1].data).last, true);
});
test('Conversation store retains more than 200 messages and separate sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webdeck-chat-test-'));
  try {
    const messages = Array.from({ length: 412 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '消息' + i }));
    await saveChat(dir, 'default', { messages }); await saveChat(dir, 'another', { messages: [{ role: 'user', content: '独立会话' }] });
    assert.equal((await readChat(dir)).messages.length, 412); assert.equal((await listChats(dir)).chats.length, 2);
    await assert.rejects(() => saveChat(dir, '../escape', {}), /会话 ID/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('Long conversation retains the first user preference beyond the old 12-message limit', async () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 0 ? '记住：品牌色使用蓝色，禁止暖色' : '第' + i + '条消息' }));
  const f = fixture(async (_, cb) => emitText(cb, '继续沿用蓝色。'), history);
  await f.loop.load('test'); await f.loop.send('接着做');
  assert(f.requests[0].messages.some((m) => String(m.content).includes('品牌色使用蓝色')));
  assert.equal(f.loop.messages.length, 32);
});
test('Length continuations combine into one complete assistant message without synthetic user turns', async () => {
  const parts = ['第一段：开始。', '第二段：继续。', '第三段：完成。'];
  const f = fixture(async (_, cb, signal, n) => emitText(cb, parts[n - 1], n < 3 ? 'length' : 'stop'));
  await f.loop.load('test'); const result = await f.loop.send('写三段');
  assert.equal(result.ok, true); assert.equal(f.loop.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(f.loop.messages.at(-1).content, parts.join('')); assert.equal(f.loop.messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(f.saved.at(-1).body.messages.at(-1).incomplete, false);
});
test('Unexpected EOF reconnects and preserves the partial response', async () => {
  const f = fixture(async (_, cb, signal, n) => { if (n === 1) cb({ type: 'delta', content: '保留前半段。' }); else emitText(cb, '接着完成后半段。'); });
  await f.loop.load('test'); await f.loop.send('断流测试');
  assert.equal(f.requests.length, 2); assert.equal(f.loop.messages.at(-1).content, '保留前半段。接着完成后半段。');
});
test('Provider errors remain errors and keep partial output for explicit resume', async () => {
  const f = fixture(async (_, cb) => { cb({ type: 'delta', content: '保留下来的进度' }); cb({ type: 'error', status: 401, recoverable: false, message: '密钥无效' }); });
  await f.loop.load('test'); const r = await f.loop.send('测试');
  assert.equal(r.ok, false); assert.equal(f.requests.length, 1); assert.equal(f.hooks.errors[0].message, '密钥无效');
  assert.equal(f.loop.messages.at(-1).content, '保留下来的进度'); assert.equal(f.loop.messages.at(-1).incomplete, true);
});
test('Tool JSON failure is repaired without executing partial write arguments', async () => {
  let writes = 0;
  const f = fixture(async (_, cb, signal, n) => {
    if (n === 1) { cb({ type: 'tool_calls', snapshot: true, tool_calls: [{ id: 'partial', type: 'function', function: { name: 'file_write', arguments: '{"path":"index.html","content":"' } }] }); cb({ type: 'done', finish_reason: 'length' }); }
    else emitText(cb, '已改为小步处理。');
  });
  f.ctx.api.putFile = async () => { writes++; };
  await f.loop.load('test'); await f.loop.send('修改文件');
  assert.equal(writes, 0); assert.equal(f.requests.length, 2); assert(!f.loop.messages.some((m) => m.tool_calls?.length));
});
test('Tool results larger than 2400 characters reach subsequent requests without hard truncation', async () => {
  const f = fixture(async (payload, cb, signal, n) => {
    if (n === 1) { cb({ type: 'tool_calls', tool_calls: [{ id: 'catalog', type: 'function', function: { name: 'app_list_apis', arguments: '{}' } }] }); cb({ type: 'done', finish_reason: 'tool_calls' }); }
    else emitText(cb, '已读取完整接口。');
  });
  await f.loop.load('test'); await f.loop.send('有哪些接口');
  const tool = f.requests[1].messages.find((m) => m.role === 'tool');
  assert(tool.content.length > 2400); assert(JSON.parse(tool.content).operations.some((o) => o.id === 'search.web'));
});
test('Permission restrictions apply inside API and command dispatchers', async () => {
  const f = fixture(async () => {}); const executor = createToolExecutor(f.ctx);
  const denied = await executor.execute('app_call_api', { operation: 'projects.create', body: { name: 'x' } }, { permission: 'read' });
  assert.equal(denied.ok, false);
  const command = await executor.execute('app_run_command', { name: 'file.rename' }, { permission: 'edit' });
  assert.equal(command.ok, false);
  const search = await executor.execute('app_call_api', { operation: 'search.web' }, { permission: 'full', webSearch: false });
  assert.equal(search.ok, false);
});
test('Stop retains partial output and interrupted tool calls retain explicit results', async () => {
  const f = fixture(async (_, cb, signal) => {
    cb({ type: 'delta', content: '停下也保留的正文' });
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')), { once: true }));
  });
  await f.loop.load('test'); const pending = f.loop.send('长任务');
  await new Promise((r) => setTimeout(r, 10)); f.loop.stop(); await pending;
  assert.equal(f.loop.messages.at(-1).content, '停下也保留的正文'); assert.equal(f.loop.messages.at(-1).aborted, true);
  const cleaned = sanitizeConversation([{ role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'deck_set_text', arguments: '{}' } }] }]);
  assert.equal(cleaned[1].tool_call_id, 'x'); assert.equal(JSON.parse(cleaned[1].content).interrupted, true);
});
test('New conversations preserve and flush the existing conversation', async () => {
  const f = fixture(async (_, cb) => emitText(cb, '已完成'));
  await f.loop.load('test'); await f.loop.send('旧对话'); await f.loop.newChat();
  assert(f.saved.some((s) => s.session === 'default' && s.body.messages.some((m) => m.content === '旧对话')));
  assert.notEqual(f.loop.getState().sessionId, 'default');
});
test('Context compaction keeps real model memory and the current user turn', async () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: ('历史' + i + '。').repeat(1600) }));
  const f = fixture(async (p, cb) => emitText(cb, p.tools.length ? '根据记忆继续完成。' : '用户要求深色背景，标题保持中文。'), history, { contextLimit: 32000 });
  await f.loop.load('test'); await f.loop.send('继续这个项目');
  assert(f.requests.length > 2); assert(f.loop.getState().foldedCount > 0);
  assert(f.requests.slice(0, -1).every((r) => messageTokens(r.messages) + r.maxTokens < 32000));
  assert(f.requests.at(-1).messages.some((m) => String(m.content).includes('用户要求深色背景')));
  assert(f.requests.at(-1).messages.some((m) => m.content === '继续这个项目'));
  assert.equal(f.loop.messages.length, 22);
});

test('Memory chunks preserve every character and respect request budgets', () => {
  const text = '连续的中文与 emoji 🌱\n'.repeat(6000);
  const chunks = memoryChunks(text, 5000);
  assert(chunks.length > 2); assert.equal(chunks.join(''), text);
  assert(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c)));
});

test('Long attachments retain their full source and expose paginated access', async () => {
  const source = '附件原文。'.repeat(40000) + 'END_OF_ATTACHMENT';
  const f = fixture(async (payload, cb) => {
    const user = payload.messages.find((m) => m.role === 'user');
    assert(user.content.includes('分页读取')); assert(!user.content.includes('END_OF_ATTACHMENT'));
    emitText(cb, '附件可以分页阅读。');
  });
  await f.loop.load('test'); await f.loop.send('阅读全文', [], { docs: [{ name: 'long.md', text: source }] });
  const doc = f.loop.messages[0].docs[0]; assert.equal(doc.text, source);
  const result = await createToolExecutor(f.ctx).execute('tool_result_read', { resultId: doc.resultId, offset: source.length - 17, limit: 100 }, { permission: 'read' });
  assert(result.content.endsWith('END_OF_ATTACHMENT')); assert.equal(f.saved.at(-1).body.messages[0].docs[0].text, source);
});

test('Explicit resume continues the partial assistant without losing or repeating prior writes', async () => {
  const f = fixture(async (payload, cb, signal, n) => {
    if (n === 1) { cb({ type: 'delta', content: '此前已保留。' }); cb({ type: 'error', status: 401, recoverable: false, message: '服务错误' }); }
    else {
      assert(payload.messages.some((m) => m.role === 'system' && m.content.includes('避免重复修改')));
      emitText(cb, '接着完成。');
    }
  });
  await f.loop.load('test'); await f.loop.send('完成任务'); await f.loop.resume();
  assert.equal(f.loop.messages.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(f.loop.messages.at(-1).content, '此前已保留。接着完成。');
  assert.equal(f.loop.messages.at(-1).incomplete, false); assert.equal(f.loop.messages.at(-1).aborted, false);
});

test('A failed new turn cannot mark an earlier completed answer incomplete', async () => {
  const f = fixture(async (_, cb, signal, n) => {
    if (n === 1) emitText(cb, '上一个任务已经完成。');
    else cb({ type: 'error', status: 401, recoverable: false, message: '密钥错误' });
  });
  await f.loop.load('test'); await f.loop.send('第一个任务'); await f.loop.send('第二个任务');
  assert.equal(f.loop.messages[1].incomplete, false); assert.equal(f.loop.messages.at(-1).role, 'user');
});
test('Reasoning-only and blank history stays saved but cannot become empty assistant API messages', async () => {
  const call = { id: 'previous-call', type: 'function', function: { name: 'app_list_apis', arguments: '{}' } };
  const history = [
    { role: 'user', content: '原来的任务' },
    { role: 'assistant', id: 'reasoning-only', content: '', reasoning: '中断前保留的思考', incomplete: true },
    ...[null, undefined, '   \n', []].map((content) => ({ role: 'assistant', content })),
    { role: 'assistant', content: '', reasoning: '工具前的推理', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, name: 'app_list_apis', content: '{"ok":true}' },
    { role: 'assistant', content: '已完成上一步。' },
  ];
  const f = fixture(async (_, cb) => emitText(cb, '继续完成。'), history);
  await f.loop.load('test'); await f.loop.send('继续');
  const sent = f.requests[0].messages.filter((m) => m.role === 'assistant');
  assert.equal(sent.length, 2);
  assert(sent.some((m) => m.tool_calls?.[0].id === call.id && m.reasoning_content === '工具前的推理'));
  assert(f.requests[0].messages.some((m) => m.role === 'tool' && m.tool_call_id === call.id));
  assert.equal(f.loop.messages.find((m) => m.id === 'reasoning-only').reasoning, '中断前保留的思考');
  assert.equal(f.saved.at(-1).body.messages.find((m) => m.id === 'reasoning-only').content, '');
});

test('A reasoning-only interrupted response can reconnect without sending an empty assistant', async () => {
  const f = fixture(async (_, cb, signal, n) => {
    if (n === 1) cb({ type: 'reasoning', content: '仅生成思考时连接中断' });
    else emitText(cb, '恢复后完整回答。');
  });
  await f.loop.load('test'); const result = await f.loop.send('继续我的任务');
  assert.equal(result.ok, true);
  assert(!f.requests[1].messages.some((m) => m.role === 'assistant' && !m.content && !m.tool_calls?.length));
  assert.equal(f.loop.messages.at(-1).content, '恢复后完整回答。');
  assert.equal(f.loop.messages.at(-1).reasoning, '仅生成思考时连接中断');
});

test('Proxy repairs blank assistant history for old clients while preserving valid tool turns', async () => {
  let received;
  const call = { id: 'proxy-call', type: 'function', function: { name: 'app_list_apis', arguments: '{}' } };
  const messages = [
    { role: 'user', content: '开始' },
    ...[null, undefined, '', '  ', []].map((content) => ({ role: 'assistant', content, reasoning_content: '保留在原始记录中的推理' })),
    { role: 'assistant', content: '', tool_calls: [call], reasoning_content: '有效工具调用的推理' },
    { role: 'tool', tool_call_id: call.id, content: '{"ok":true}' },
    { role: 'assistant', content: '有效正文。' },
    { role: 'user', content: '继续' },
  ];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; received = JSON.parse(raw);
    const invalid = received.messages.some((m) => m.role === 'assistant' && !(typeof m.content === 'string' && m.content.trim()) && !m.tool_calls?.length);
    res.writeHead(invalid ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invalid ? { error: { message: 'Invalid assistant message: content or tool_calls must be set' } } : { choices: [{ message: { content: '恢复成功。' }, finish_reason: 'stop' }] }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = http.createServer((req, res) => proxyChat({ req, res, base: 'http://127.0.0.1:' + upstream.address().port,
    wire: 'openai', headers: {}, model: 'test', messages, tools: [], maxTokens: 1024, stream: true }));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  try {
    const response = await fetch('http://127.0.0.1:' + proxy.address().port), events = [];
    for await (const event of readSSE(response.body)) events.push(JSON.parse(event.data));
    assert(!events.some((e) => e.type === 'error'), JSON.stringify(events));
    assert.equal(events.at(-1).finish_reason, 'stop');
    assert.equal(received.messages.length, 5);
    assert.equal(received.messages[1].tool_calls[0].id, call.id);
    assert.equal(received.messages[1].reasoning_content, '有效工具调用的推理');
    assert.equal(messages.length, 10);
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => upstream.close(r))]);
  }
});

test('Proxy reports missing upstream finish marker instead of inventing success', async () => {
  let anthropic = false, json = false;
  const upstream = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    if (json) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ content: [{ type: 'text', text: 'JSON 完整回答' }], stop_reason: 'end_turn' })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(anthropic ? 'event: content_block_delta\ndata: {"delta":{"text":"中文尾帧"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"end_turn"}}' : 'data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const proxy = http.createServer((req, res) => proxyChat({ req, res, base, wire: anthropic ? 'anthropic' : 'openai', headers: {}, model: 'test', messages: [], tools: [], maxTokens: 4096, stream: !json }));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const url = 'http://127.0.0.1:' + proxy.address().port;
  try {
    let res = await fetch(url), events = []; for await (const e of readSSE(res.body)) events.push(JSON.parse(e.data));
    assert.equal(events.at(-1).finish_reason, null); assert.equal(events.at(-1).incomplete, true);
    anthropic = true;
    res = await fetch(url); events = []; for await (const e of readSSE(res.body)) events.push(JSON.parse(e.data));
    assert.equal(events[0].content, '中文尾帧'); assert.equal(events.at(-1).finish_reason, 'stop');
    json = true;
    res = await fetch(url); events = []; for await (const e of readSSE(res.body)) events.push(JSON.parse(e.data));
    assert.equal(events[0].content, 'JSON 完整回答'); assert.equal(events.at(-1).finish_reason, 'stop');
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise((r) => proxy.close(r)), new Promise((r) => upstream.close(r))]); }
});
