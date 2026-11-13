/* Agent 对话循环：组装消息 → 流式请求 → 工具调用 → 持久化 / 中止 / 重试 / 上下文裁剪 */

import { uid, debounce } from '../core/dom.js';
import { buildSystemPrompt, truncate } from './prompt.js';
import { createToolExecutor, getToolDefinitionsForPermission, normalizePermission, permissionLabel, isRawCapabilities, canUseTool } from './tools.js';
import { loadCatalog, getCachedCatalog, defaultSkillIds, normalizeEnabledIds, getEnabledContent } from './skills.js';
import { resolveActive, readAgentSettings, findModel, rememberSelection, modelBadges, getProviders } from './settings.js';
import { estimateTokens } from './markdown.js';

const MAX_ROUNDS = 20;
const KEEP_RECENT = 12;
const PERSIST_DEBOUNCE = 600;
const TOOL_RESULT_MAX = 2400;
const REASONING_EFFORTS = ['auto', 'low', 'medium', 'high'];

function normalizeReasoningEffort(value) {
  return REASONING_EFFORTS.includes(value) ? value : 'auto';
}

/* ---------- 消息工具 ---------- */

function isMessage(m) {
  return !!m && typeof m === 'object' && ['user', 'assistant', 'tool'].includes(m.role);
}

function normalizeStoredMessage(m) {
  const out = { role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') };
  if (typeof m.id === 'string') out.id = m.id;
  if (typeof m.ts === 'number') out.ts = m.ts;
  if (typeof m.reasoning === 'string' && m.reasoning) out.reasoning = m.reasoning;
  if (Array.isArray(m.images) && m.images.length) out.images = m.images.filter((x) => typeof x === 'string' && x);
  if (Array.isArray(m.docs) && m.docs.length) out.docs = m.docs;
  if (Array.isArray(m.assetPaths) && m.assetPaths.length) out.assetPaths = m.assetPaths.filter((x) => typeof x === 'string' && x);
  if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
    const calls = m.tool_calls.filter((c) => c && c.function && c.function.name).map((c, i) => ({
      id: c.id || 'call_' + i,
      type: 'function',
      function: {
        name: String(c.function.name),
        arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}),
      },
    }));
    if (calls.length) out.tool_calls = calls;
  }
  if (m.role === 'tool') {
    out.tool_call_id = String(m.tool_call_id || '');
    if (m.name) out.name = String(m.name);
  }
  return out;
}

function cleanPersistMessage(m) {
  const out = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
  if (m.id) out.id = m.id;
  if (typeof m.ts === 'number') out.ts = m.ts;
  if (m.reasoning) out.reasoning = m.reasoning;
  if (Array.isArray(m.images) && m.images.length) out.images = m.images;
  if (Array.isArray(m.docs) && m.docs.length) {
    out.docs = m.docs.map((d) => ({
      name: String(d.name || ''),
      kindLabel: String(d.kindLabel || d.ext || ''),
      pages: Number(d.pages) || 0,
      text: String(d.text || '').slice(0, 24000),
    }));
  }
  if (Array.isArray(m.assetPaths) && m.assetPaths.length) out.assetPaths = m.assetPaths;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
  if (m.role === 'tool') {
    out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
  }
  if (m.aborted) out.aborted = true;
  return out;
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return {};
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* 继续修复 */ }
  try { return JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1')); } catch { /* 继续修复 */ }
  try { return JSON.parse(cleaned.replace(/'/g, '"')); } catch { /* ignore */ }
  return { __raw: text };
}

function mergeToolCalls(target, incoming) {
  if (!Array.isArray(incoming)) return;
  for (const part of incoming) {
    if (!part || typeof part !== 'object') continue;
    const idx = Number.isInteger(part.index) ? part.index : target.length;
    if (!target[idx]) target[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    const slot = target[idx];
    if (part.id) slot.id = String(part.id);
    if (part.type) slot.type = String(part.type);
    const fn = part.function || {};
    if (fn.name) slot.function.name = String(fn.name);
    const args = fn.arguments;
    if (typeof args === 'string' && args) {
      const prev = slot.function.arguments || '';
      if (part.id || !prev) slot.function.arguments = args;
      else if (args.startsWith(prev)) slot.function.arguments = args;
      else if (prev.startsWith(args)) { /* 重复片段，忽略 */ }
      else slot.function.arguments = prev + args;
    } else if (args && typeof args === 'object') {
      slot.function.arguments = JSON.stringify(args);
    }
  }
}

function normalizeToolCalls(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((tc, i) => {
    if (!tc || typeof tc !== 'object') return;
    const fn = tc.function || {};
    const name = fn.name || tc.name || '';
    if (!name) return;
    const args = fn.arguments !== undefined ? fn.arguments : tc.arguments;
    out.push({
      id: tc.id || 'call_' + i + '_' + Math.random().toString(36).slice(2, 6),
      type: 'function',
      function: {
        name: String(name),
        arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
      },
    });
  });
  return out;
}

function estimateMessageTokens(m) {
  let n = 8;
  n += estimateTokens(typeof m.content === 'string' ? m.content : '');
  if (Array.isArray(m.tool_calls)) {
    for (const c of m.tool_calls) n += estimateTokens((c.function && c.function.arguments) || '') + 12;
  }
  if (Array.isArray(m.images)) n += m.images.length * 1000;
  return n;
}

function toApiMessage(m) {
  if (m.role === 'tool') {
    let content = String(m.content || '');
    if (content.length > TOOL_RESULT_MAX) content = content.slice(0, TOOL_RESULT_MAX) + '…[结果已截断]';
    const out = { role: 'tool', tool_call_id: m.tool_call_id, content };
    if (m.name) out.name = m.name;
    return out;
  }
  if (m.role === 'assistant') {
    const out = { role: 'assistant', content: String(m.content || '') };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
    return out;
  }
  return { role: 'user', content: String(m.content || '') };
}

/** 用户消息 + 图片：支持视觉模型时用多模态内容数组（OpenAI / Anthropic 两种 wire） */
function toApiUserMessage(m, info, provider) {
  let text = m.brief
    ? String(m.brief) + '\n\n---\n用户原话：' + String(m.content || '')
    : String(m.content || '');

  /* 文档 / PDF 附件：抽出文字作为素材，模型按需引用 */
  const docs = Array.isArray(m.docs) ? m.docs.filter((d) => d && d.text) : [];
  if (docs.length) {
    const blocks = docs.map((d, i) => '### 附件 ' + (i + 1) + '：' + (d.name || '未命名')
      + '（' + (d.kindLabel || d.ext || '文件') + (d.pages ? ' · ' + d.pages + ' 页' : '') + '）\n'
      + String(d.text || '').slice(0, 24000));
    text += '\n\n【用户提供的附件资料】以下内容来自附件，只作为事实来源与素材，不要照抄它的版式：\n\n' + blocks.join('\n\n');
  }

  const images = Array.isArray(m.images) ? m.images : [];
  const assetPaths = Array.isArray(m.assetPaths) ? m.assetPaths : [];
  if (assetPaths.length) {
    text += '\n\n【附件图片已存入工程素材】' + assetPaths.join('、')
      + '\n需要放进页面时，用 deck_insert_image {src:"<上面的路径>", x, y, w, h} 引用；不要用外链。';
  }
  if (images.length && info && info.vision) {
    const wire = provider && provider.wire ? provider.wire : 'openai';
    const anthropic = wire === 'anthropic' || (wire === 'auto' && /claude|anthropic/i.test(String((info && info.id) || '')));
    if (anthropic) {
      const blocks = [];
      if (text) blocks.push({ type: 'text', text });
      for (const url of images) {
        const dataMatch = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (dataMatch) blocks.push({ type: 'image', source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] } });
        else if (/^https?:/i.test(url)) blocks.push({ type: 'image', source: { type: 'url', url } });
      }
      if (blocks.some((b) => b.type === 'image')) return { role: 'user', content: blocks };
    } else {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const url of images) content.push({ type: 'image_url', image_url: { url } });
      return { role: 'user', content };
    }
  }
  let content = text;
  if (images.length) content += '\n\n（随消息附带了 ' + images.length + ' 张图片；当前模型不支持图片输入，请直接说明要插入的图片路径，或在画布中先上传素材。）';
  return { role: 'user', content };
}

function summarizeEarlier(messages) {
  const lines = [];
  let toolCalls = 0;
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.content) lines.push('- 用户：' + truncate(m.content, 70));
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        toolCalls += m.tool_calls.length;
        lines.push('- 助手：调用了 ' + m.tool_calls.map((c) => c.function.name).join('、'));
      } else if (m.content) {
        lines.push('- 助手：' + truncate(m.content, 70));
      }
    }
  }
  if (lines.length > 14) lines.splice(0, lines.length - 14);
  return `【早前对话摘要】共 ${messages.length} 条早期消息已折叠（含 ${toolCalls} 次工具调用）。\n` +
    lines.join('\n') + '\n（如需旧细节，请重新读取当前工程状态，不要依赖被折叠的内容。）';
}

function abortError() {
  const err = new Error('已停止生成');
  err.name = 'AbortError';
  return err;
}

/** 清理会话：丢弃孤立 tool 消息、无结果的 tool_calls（服务端截断/异常时可能出现） */
function sanitizeConversation(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'tool') continue; // 等待与 assistant 配对
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = new Set(m.tool_calls.map((c) => c.id));
      const results = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        if (ids.has(messages[j].tool_call_id)) results.push(messages[j]);
        j += 1;
      }
      if (results.length === m.tool_calls.length) {
        out.push(m, ...results);
      } else if (results.length > 0) {
        const validIds = new Set(results.map((r) => r.tool_call_id));
        out.push({ ...m, tool_calls: m.tool_calls.filter((c) => validIds.has(c.id)) }, ...results);
      } else {
        const { tool_calls, ...rest } = m;
        out.push(rest);
      }
      i = j - 1;
      continue;
    }
    out.push(m);
  }
  return out;
}

/* ---------- 循环主体 ---------- */

/**
 * 创建 Agent 循环实例。
 * @param {object} ctx
 * @param {object} hooks 见下方 emit 调用
 */
export function createAgentLoop(ctx, hooks = {}) {
  const emit = (name, ...args) => {
    const fn = hooks[name];
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { console.error('[agent/loop] hook 执行失败:', name, err); }
  };

  const executor = createToolExecutor(ctx);
  const state = {
    projectId: null,
    messages: [],
    skills: [],
    catalog: null,
    streaming: false,
    abort: null,
    abortRequested: false,
    usage: null,
    foldedCount: 0,
    /** 最近一次请求的上下文占用估算（tokens / budget / limit / percent） */
    lastContext: null,
    pendingAcc: null,
    lastError: null,
    loadToken: 0,
    providerId: null,
    model: null,
    permission: 'edit',
    reasoningEffort: 'auto',
    webSearch: false,
    capabilities: null,
    raw: false,
  };

  const persistDebounced = debounce(() => persistNow(), PERSIST_DEBOUNCE);

  /** 请求 AI：默认流式；设置里关闭流式时走 stream:false（服务端统一协议仍可能为 SSE，这里自行解析） */
  async function requestChat(payload, onEvent, signal) {
    const cfg = readAgentSettings(ctx);
    if (cfg.streaming !== false) {
      await ctx.api.chatStream(payload, onEvent, signal);
      return;
    }
    let res;
    try {
      res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, stream: false }),
        signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error('连接 AI 服务失败：' + (err && err.message ? err.message : String(err)));
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j && j.error && (j.error.message || j.error)) || '';
      } catch { /* ignore */ }
      throw new Error(detail || `AI 请求失败 (${res.status})`);
    }
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const data = await res.json();
      const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
      if (msg.reasoning_content) onEvent({ type: 'reasoning', content: msg.reasoning_content });
      if (msg.content) onEvent({ type: 'delta', content: msg.content });
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) onEvent({ type: 'tool_calls', tool_calls: msg.tool_calls });
      if (data && data.usage) onEvent({ type: 'usage', usage: data.usage });
      onEvent({
        type: 'done',
        finish_reason: (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || (msg.tool_calls && msg.tool_calls.length ? 'tool_calls' : 'stop'),
      });
      return;
    }
    const text = await res.text();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const body = line.slice(5).trim();
      if (!body || body === '[DONE]') continue;
      try { onEvent(JSON.parse(body)); } catch { /* ignore */ }
    }
  }

  function getProject() {
    const snap = ctx.store.get();
    return snap.project || null;
  }

  function getRouteName() {
    const snap = ctx.store.get();
    return (snap.route && snap.route.name) || (ctx.route && ctx.route.name) || 'library';
  }

  function settingsLoaded() {
    const snap = ctx.store.get();
    return !!(snap.settings && snap.settings.loaded);
  }

  function contextInfo() {
    const active = resolveActive(ctx);
    return active.info;
  }

  function contextBudget(info) {
    const cfg = readAgentSettings(ctx);
    // 上下文上限：优先用设置里的 contextLimit，再与模型自身 contextLength 取较小值
    const configured = Number(cfg.contextLimit) || 100000000;
    const modelLimit = Number(info && info.contextLength) || 0;
    const contextLength = modelLimit > 0 ? Math.min(configured, modelLimit) : configured;
    const reserveForOutput = Math.max(1600, Math.round((Number(cfg.maxTokens) || 8192) * 0.8));
    // 预留输出不能吃掉整个上下文窗口，最多占一半
    const reserved = Math.min(Math.round(contextLength * 0.5), reserveForOutput);
    return { budget: Math.max(4000, Math.round(contextLength * 0.82) - reserved), limit: contextLength };
  }

  /** 组装 API messages（含上下文裁剪与折叠摘要） */
  /** 最大输出：设置里为 0（默认）时跟随模型上限，取不到就按 64k */
  function effectiveMaxTokens(info) {
    const cfg = readAgentSettings(ctx);
    const configured = Number(cfg.maxTokens) || 0;
    if (configured > 0) return configured;
    const modelOut = Number(info && (info.maxOutput || info.max_output_tokens)) || 0;
    return modelOut > 0 ? modelOut : 65536;
  }

  /** 组装系统提示词（buildApiMessages 与 measureContext 共用） */
  function systemPromptFor(info, capabilities) {
    const snap = ctx.store.get();
    const cfg = readAgentSettings(ctx);
    const skillsText = getEnabledContent(state.catalog || getCachedCatalog(), state.skills);
    return buildSystemPrompt(ctx, {
      project: snap.project,
      deck: snap.deck,
      selection: snap.selection,
      capabilities,
      skillsText,
      foldedCount: state.foldedCount,
      permission: state.permission,
      reasoningEffort: state.reasoningEffort,
      webSearch: state.webSearch,
      contextLimit: cfg.contextLimit,
      raw: state.raw,
      commands: ctx.bus.listCommands ? ctx.bus.listCommands() : [],
    });
  }

  function setContextStat(total, systemTokens, budget, limit, folded) {
    state.lastContext = {
      tokens: total,
      systemTokens,
      budget,
      limit,
      percent: Math.max(0, Math.min(100, Math.round((total / Math.max(1, budget)) * 100))),
      messages: state.messages.length,
      folded,
      at: Date.now(),
    };
    emit('onContext', state.lastContext);
    return state.lastContext;
  }

  /** 不进请求、只估算上下文占用（会话载入 / 切换工程时也要有数字） */
  function measureContext() {
    try {
      const info = contextInfo();
      const system = systemPromptFor(info, state.capabilities);
      const { budget, limit } = contextBudget(info);
      let total = estimateTokens(system) + 200;
      for (let i = Math.max(0, state.foldedCount); i < state.messages.length; i += 1) {
        total += estimateMessageTokens(state.messages[i]);
      }
      return setContextStat(total, estimateTokens(system), budget, limit, state.foldedCount);
    } catch (err) {
      console.warn('[agent/loop] 估算上下文失败', err);
      return null;
    }
  }

  function buildApiMessages(info, capabilities, provider) {
    const system = systemPromptFor(info, capabilities);

    const { budget, limit } = contextBudget(info);
    // 默认保留最近 12 条；超出上下文预算时继续向前折叠
    let start = Math.max(0, state.messages.length - KEEP_RECENT);
    while (start > 0 && start < state.messages.length && state.messages[start].role === 'tool') start -= 1;
    let total = estimateTokens(system) + 200;
    for (let i = start; i < state.messages.length; i += 1) total += estimateMessageTokens(state.messages[i]);
    while (start > 0 && total > budget) {
      total -= estimateMessageTokens(state.messages[start]);
      start += 1;
      while (start < state.messages.length && state.messages[start].role === 'tool') start += 1;
    }
    const folded = Math.max(0, start);
    if (folded !== state.foldedCount) {
      state.foldedCount = folded;
      emit('onCompact', folded);
    }

    /* 上下文占用：给界面显示「用了多少 / 上限多少」 */
    setContextStat(total, estimateTokens(system), budget, limit, folded);

    const out = [{ role: 'system', content: system }];
    if (folded > 0) out.push({ role: 'system', content: summarizeEarlier(state.messages.slice(0, folded)) });
    for (let i = folded; i < state.messages.length; i += 1) {
      const m = state.messages[i];
      out.push(m.role === 'user' ? toApiUserMessage(m, info, provider) : toApiMessage(m));
    }
    return out;
  }

  function syncStore() {
    try {
      ctx.store.update((s) => {
        s.agent.messages = state.messages.slice();
        s.agent.skills = state.skills.slice();
        s.agent.providerId = state.providerId || s.agent.providerId;
        s.agent.model = state.model || s.agent.model;
        s.agent.usage = state.usage;
        s.agent.context = state.lastContext;
        s.agent.streaming = state.streaming;
      });
    } catch (err) {
      console.warn('[agent/loop] 同步 store 失败', err);
    }
  }

  function setStreamingUI(streaming, status) {
    try {
      ctx.store.update((s) => {
        s.agent.streaming = streaming;
        if (status) s.agent.status = status;
        if (!streaming && s.agent.status === 'thinking') s.agent.status = 'idle';
      });
    } catch { /* ignore */ }
  }

  /* ---------- 持久化 ---------- */

  function persist() {
    if (!state.projectId) return;
    persistDebounced();
  }

  function persistNow() {
    if (!state.projectId) return;
    const projectId = state.projectId;
    const payload = {
      messages: state.messages.map(cleanPersistMessage),
      skills: state.skills.slice(),
    };
    ctx.api.putChat(projectId, payload).then(() => {
      if (state.projectId === projectId) emit('onSaved', { projectId });
    }).catch((err) => {
      if (state.projectId === projectId) {
        console.warn('[agent/loop] 保存会话失败', err);
        emit('onSaveError', err);
      }
    });
  }

  function flush() {
    try { persistDebounced.flush(); } catch { /* ignore */ }
  }

  /* ---------- 会话加载 ---------- */

  async function load(projectId) {
    state.loadToken += 1;
    const token = state.loadToken;
    flush();
    if (state.abort) {
      try { state.abort.abort(); } catch { /* ignore */ }
    }
    state.abort = null;
    state.streaming = false;
    state.abortRequested = false;
    emit('onStreamingChange', false);
    emit('onStatus', 'idle');
    state.messages = [];
    state.skills = [];
    state.usage = null;
    state.foldedCount = 0;
    state.lastContext = null;
    state.lastError = null;
    state.pendingAcc = null;
    state.capabilities = null;
    state.raw = false;
    state.projectId = projectId || null;
    state.catalog = await loadCatalog(ctx);
    if (state.loadToken !== token) return;

    if (!state.projectId) {
      emit('onSessionLoaded', { messages: [], skills: defaultSkillIds(state.catalog), catalog: state.catalog });
      measureContext();
      setStreamingUI(false, 'idle');
      return;
    }

    try {
      const data = await ctx.api.getChat(state.projectId);
      if (state.loadToken !== token) return;
      const rawMessages = Array.isArray(data && data.messages) ? data.messages : [];
      const messages = sanitizeConversation(rawMessages.filter(isMessage).map(normalizeStoredMessage));
      let skills = normalizeEnabledIds(state.catalog, data && data.skills);
      if (!skills.length) skills = defaultSkillIds(state.catalog);
      state.messages = messages;
      state.skills = skills;
      emit('onSessionLoaded', { messages: state.messages.slice(), skills: state.skills.slice(), catalog: state.catalog });
      if (messages.length) {
        // 从最近一次 usage 估算上下文规模（服务端不回传历史 usage，这里用粗略估算）
        emit('onCompact', 0);
      }
      measureContext();
    } catch (err) {
      if (state.loadToken !== token) return;
      console.warn('[agent/loop] 读取会话失败', err);
      state.skills = defaultSkillIds(state.catalog);
      emit('onSessionLoaded', { messages: [], skills: state.skills.slice(), catalog: state.catalog, error: err });
    }
    syncStore();
    setStreamingUI(false, 'idle');
  }

  /* ---------- 发送 / 循环 ---------- */

  async function send(text, images, opts = {}) {
    if (state.streaming) return { ok: false, error: '正在生成中，请稍候或先停止。' };
    const project = getProject();
    if (!project || getRouteName() !== 'editor') {
      emit('onBlocked', '打开一个工程后即可编辑。');
      return { ok: false, error: '请先打开工程' };
    }
    const content = String(text == null ? '' : text).trim();
    const imgs = Array.isArray(images) ? images.filter((x) => typeof x === 'string' && x) : [];
    const docs = Array.isArray(opts.docs) ? opts.docs.filter((d) => d && (d.text || d.name)).slice(0, 6) : [];
    const assetPaths = Array.isArray(opts.assetPaths) ? opts.assetPaths.filter((x) => typeof x === 'string' && x).slice(0, 12) : [];
    if (!content && !imgs.length && !docs.length) return { ok: false, error: '请输入内容' };

    const active = resolveActive(ctx);
    if (!active.providerId || !active.model) {
      emit('onNeedSetup', '还没有配置可用的模型，请先在 AI 设置里选择 Provider 和模型。');
      return { ok: false, error: '未配置模型' };
    }
    if (settingsLoaded() && active.provider && !active.provider.keySet) {
      emit('onNeedSetup', '还没有配置 API Key，请先在 AI 设置中完成配置。');
      return { ok: false, error: '未配置 API Key' };
    }

    state.catalog = state.catalog || getCachedCatalog();
    const brief = opts && typeof opts.brief === 'string' ? opts.brief.trim() : '';
    const userMsg = { role: 'user', content, ts: Date.now(), id: uid('msg') };
    if (brief) userMsg.brief = brief;
    if (imgs.length) userMsg.images = imgs;
    if (docs.length) userMsg.docs = docs;
    if (assetPaths.length) userMsg.assetPaths = assetPaths;
    state.messages.push(userMsg);
    emit('onUserMessage', userMsg);
    syncStore();
    persist();

    const info = findModel(ctx, active.providerId, active.model);
    return runLoop(active.providerId, active.model, info);
  }

  async function runLoop(providerId, model, info) {
    state.streaming = true;
    state.abortRequested = false;
    state.lastError = null;
    state.usage = null;
    state.continuations = 0;
    state.unexpectedEnds = 0;
    state.providerId = providerId;
    state.model = model;
    const provider = getProviders(ctx).find((p) => p.id === providerId) || null;
    const controller = new AbortController();
    state.abort = controller;
    emit('onStreamingChange', true);
    emit('onStatus', 'thinking');
    setStreamingUI(true, 'thinking');
    syncStore();
    let continueNext = false;

    try {
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        if (controller.signal.aborted) throw abortError();
        // 拉取编辑器能力（失败忽略）
        let capabilities = null;
        let raw = false;
        try {
          const editor = ctx.getEditor ? ctx.getEditor() : null;
          if (editor && editor.bridge) {
            const deckState = await editor.bridge.call('getState', {});
            capabilities = deckState && deckState.capabilities ? deckState.capabilities : null;
            raw = !!(deckState && (deckState.raw === true || deckState.mode === 'raw')) || isRawCapabilities(capabilities);
          }
        } catch { /* ignore */ }
        if (!capabilities && !raw) {
          const snap = ctx.store.get();
          const snapDeck = snap.deck || {};
          const snapProject = snap.project || {};
          capabilities = snapDeck.capabilities || null;
          raw = snapDeck.raw === true || snapDeck.mode === 'raw' || snapProject.kind === 'raw' || isRawCapabilities(capabilities);
        }
        state.capabilities = capabilities;
        state.raw = raw;

        const payload = {
          providerId,
          model,
          // OpenCode Go 要求每个会话稳定 session id（用于路由/缓存），否则 400 MissingSessionID
          sessionId: ((ctx.store.get().project && ctx.store.get().project.id) || 'webdeck') + ':agent',
          messages: buildApiMessages(info, capabilities, provider),
          tools: getToolDefinitionsForPermission(state.permission, { webSearch: state.webSearch }),
          temperature: readAgentSettings(ctx).temperature,
          maxTokens: effectiveMaxTokens(info),
          reasoning_effort: normalizeReasoningEffort(state.reasoningEffort),
          stream: true,
        };

        /* 创作模式（消息带 brief）：第一轮强制 deck_compose，避免弱模型逐页手搓跑偏 */
        if (round === 1 && !raw && canUseTool(state.permission, 'deck_compose')) {
          const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
          if (lastUser && lastUser.brief && payload.tools.some((d) => d.function && d.function.name === 'deck_compose')) {
            payload.toolChoice = { type: 'function', function: { name: 'deck_compose' } };
          }
        }

        emit('onAssistantStart', { round });
        emit('onStatus', 'thinking');
        const acc = { content: '', reasoning: '', toolCalls: [] };
        state.pendingAcc = acc;
        let finishReason = null;
        let streamError = null;

        const onEvent = (evt) => {
          if (!evt || typeof evt !== 'object') return;
          switch (evt.type) {
            case 'delta':
              if (typeof evt.content === 'string' && evt.content) {
                acc.content += evt.content;
                emit('onAssistantDelta', acc.content);
                emit('onStatus', 'streaming');
              }
              break;
            case 'reasoning':
              if (typeof evt.content === 'string' && evt.content) {
                acc.reasoning += evt.content;
                emit('onReasoningDelta', acc.reasoning);
                emit('onStatus', 'streaming');
              }
              break;
            case 'tool_calls':
              mergeToolCalls(acc.toolCalls, evt.tool_calls);
              emit('onToolCalls', acc.toolCalls.filter(Boolean));
              break;
            case 'usage': {
              const usage = evt.usage || evt;
              if (usage && typeof usage === 'object') {
                state.usage = usage;
                emit('onUsage', usage);
              }
              break;
            }
            case 'done':
              finishReason = evt.finish_reason || evt.finishReason || finishReason;
              emit('onStatus', 'thinking');
              break;
            case 'error':
              streamError = (evt.error && (evt.error.message || evt.error)) || evt.message || 'AI 服务返回错误';
              try { controller.abort(); } catch { /* ignore */ }
              break;
            default:
              break;
          }
        };

        try {
          await requestChat(payload, onEvent, controller.signal);
        } catch (err) {
          if (streamError) throw new Error(streamError);
          throw err;
        }
        if (streamError) throw new Error(streamError);
        if (controller.signal.aborted) throw abortError();

        const calls = normalizeToolCalls(acc.toolCalls);
        let assistantMsg = { role: 'assistant', content: acc.content || '', ts: Date.now(), id: uid('msg') };
        if (acc.reasoning) assistantMsg.reasoning = acc.reasoning;
        if (calls.length) assistantMsg.tool_calls = calls;
        /* 自动接续：把续写内容合并回上一条 assistant，历史里仍是一整段回答 */
        const carrying = continueNext;
        continueNext = false;
        if (carrying && !calls.length) {
          const prev = state.messages[state.messages.length - 2];
          if (prev && prev.role === 'assistant') {
            prev.content = (prev.content || '') + (assistantMsg.content || '');
            if (assistantMsg.reasoning) prev.reasoning = (prev.reasoning || '') + assistantMsg.reasoning;
            prev.ts = Date.now();
            assistantMsg = prev;
            state.messages.pop(); // 去掉临时的续写提示消息
          } else {
            state.messages.push(assistantMsg);
          }
        } else {
          state.messages.push(assistantMsg);
        }
        state.pendingAcc = null;
        emit('onAssistantEnd', assistantMsg, { round, finishReason, continued: carrying });
        syncStore();
        persist();

        if (!calls.length) {
          const truncated = finishReason === 'length' || finishReason === 'max_tokens';
          const partialLen = String(acc.content || '').trim().length;
          const unexpectedEnd = !finishReason && partialLen > 0;
          const MAX_CONTINUATIONS = 8;
          if ((truncated && partialLen > 0 && (state.continuations || 0) < MAX_CONTINUATIONS)
            || (unexpectedEnd && (state.unexpectedEnds || 0) < 2)) {
            // 输出被长度上限截断 / 流意外结束：像 Codex 一样自动续写，而不是直接结束
            state.continuations = (state.continuations || 0) + 1;
            if (unexpectedEnd && !truncated) state.unexpectedEnds = (state.unexpectedEnds || 0) + 1;
            state.messages.push({
              role: 'user',
              content: '（系统提示：上一次输出因达到长度上限或连接中断被截断。请从中断处继续输出，不要重复已输出的内容，不要重新开头。）',
              synthetic: true,
              ts: Date.now(),
              id: uid('msg'),
            });
            continueNext = true;
            emit('onContinuation', { count: state.continuations, max: MAX_CONTINUATIONS, unexpected: unexpectedEnd && !truncated });
            emit('onStatus', 'continuing');
            syncStore();
            persist();
            continue;
          }
          emit('onStatus', 'thinking');
          break;
        }

        // 执行工具（串行）
        emit('onToolCalls', calls);
        for (let i = 0; i < calls.length; i += 1) {
          const call = calls[i];
          if (controller.signal.aborted) break;
          emit('onToolStart', call, i);
          emit('onStatus', 'tool');
          const args = parseArgs(call.function.arguments);
          let result;
          try {
            result = await executor.execute(call.function.name, args, {
              permission: state.permission,
              capabilities: state.capabilities,
              raw: state.raw,
            });
          } catch (err) {
            result = { ok: false, error: err && err.message ? err.message : String(err) };
          }
          if (!result || typeof result !== 'object') result = { ok: true, result };
          const toolMsg = {
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(result),
            ts: Date.now(),
            id: uid('msg'),
          };
          state.messages.push(toolMsg);
          emit('onToolResult', call, result);
          persist();
          syncStore();
        }
        if (controller.signal.aborted) throw abortError();
        emit('onStatus', 'thinking');
      }
    } catch (err) {
      const isAbort = !!err && (err.name === 'AbortError' || /aborted|abort/i.test(String(err.name || '')) || /已停止/.test(String(err.message || '')));
      if (isAbort) {
        handleAbort();
      } else {
        state.lastError = err;
        const message = err && err.message ? err.message : String(err);
        emit('onError', { error: err, message }, { retry: () => retryLast() });
        emit('onStatus', 'error');
        state.pendingAcc = null;
        try {
          ctx.store.update((s) => { s.agent.status = 'error'; s.agent.error = message; });
        } catch { /* ignore */ }
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      state.pendingAcc = null;
      emit('onStreamingChange', false);
      emit('onStatus', 'idle');
      setStreamingUI(false, 'idle');
      syncStore();
      flush();
      emit('onDone', { aborted: state.abortRequested });
    }
  }

  function handleAbort() {
    state.abortRequested = true;
    const acc = state.pendingAcc;
    state.pendingAcc = null;
    if (acc && (acc.content || acc.reasoning)) {
      // 保留已生成内容；不落 tool_calls（避免出现没有结果的悬空调用）
      const msg = { role: 'assistant', content: acc.content || '', ts: Date.now(), id: uid('msg'), aborted: true };
      if (acc.reasoning) msg.reasoning = acc.reasoning;
      state.messages.push(msg);
      emit('onAssistantEnd', msg, { aborted: true });
    }
    emit('onAborted');
    syncStore();
    persist();
  }

  function stop() {
    if (!state.streaming) return { ok: false, error: '当前没有生成中的回复' };
    state.abortRequested = true;
    try { state.abort && state.abort.abort(); } catch { /* ignore */ }
    return { ok: true };
  }

  function retryLast() {
    if (state.streaming) return { ok: false, error: '正在生成中' };
    let idx = -1;
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      if (state.messages[i].role === 'user') { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: '没有可重试的消息' };
    state.messages = state.messages.slice(0, idx + 1);
    state.lastError = null;
    emit('onBeforeRetry', { messages: state.messages.slice() });
    syncStore();
    const active = resolveActive(ctx);
    if (!active.providerId || !active.model) {
      emit('onNeedSetup', '还没有配置可用的模型。');
      return { ok: false, error: '未配置模型' };
    }
    const info = findModel(ctx, active.providerId, active.model);
    return runLoop(active.providerId, active.model, info);
  }

  /* ---------- 会话管理 ---------- */

  function newChat() {
    if (state.abort) {
      try { state.abort.abort(); } catch { /* ignore */ }
    }
    state.abort = null;
    state.streaming = false;
    state.messages = [];
    state.usage = null;
    state.foldedCount = 0;
    state.lastContext = null;
    state.lastError = null;
    state.pendingAcc = null;
    emit('onSessionReset');
    measureContext();
    syncStore();
    persistNow();
    return { ok: true };
  }

  function setSkills(ids) {
    const catalog = state.catalog || getCachedCatalog();
    state.skills = normalizeEnabledIds(catalog, ids);
    emit('onSkillsChange', state.skills.slice());
    syncStore();
    persist();
    return state.skills.slice();
  }

  function toggleSkill(id) {
    const catalog = state.catalog || getCachedCatalog();
    const valid = normalizeEnabledIds(catalog, [id]);
    if (!valid.length) return state.skills.slice();
    const set = new Set(state.skills);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    return setSkills([...set]);
  }

  function setProvider(providerId, model) {
    state.providerId = providerId || null;
    state.model = model || null;
    rememberSelection(providerId, model);
    syncStore();
  }

  /** 设置工作权限 / 思考强度（由面板选择器调用） */
  function setOptions(options = {}) {
    if (options.permission !== undefined) state.permission = normalizePermission(options.permission);
    if (options.reasoningEffort !== undefined) state.reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
    if (options.webSearch !== undefined) state.webSearch = !!options.webSearch;
    try {
      ctx.store.update((s) => {
        s.agent.permission = state.permission;
        s.agent.reasoningEffort = state.reasoningEffort;
        s.agent.webSearch = state.webSearch;
      });
    } catch { /* ignore */ }
    return { permission: state.permission, reasoningEffort: state.reasoningEffort, webSearch: state.webSearch };
  }

  function getOptions() {
    return {
      permission: state.permission,
      permissionLabel: permissionLabel(state.permission),
      reasoningEffort: state.reasoningEffort,
      webSearch: state.webSearch,
      capabilities: state.capabilities,
      raw: state.raw,
    };
  }

  function getState() {
    const active = resolveActive(ctx);
    return {
      projectId: state.projectId,
      messages: state.messages.slice(),
      skills: state.skills.slice(),
      streaming: state.streaming,
      usage: state.usage,
      foldedCount: state.foldedCount,
      context: state.lastContext,
      lastError: state.lastError,
      providerId: active.providerId,
      model: active.model,
      modelInfo: active.info,
      modelBadges: modelBadges(active.info),
      catalog: state.catalog || getCachedCatalog(),
      permission: state.permission,
      reasoningEffort: state.reasoningEffort,
      capabilities: state.capabilities,
      raw: state.raw,
    };
  }

  return {
    load,
    send,
    stop,
    retryLast,
    newChat,
    setSkills,
    toggleSkill,
    setProvider,
    setOptions,
    getOptions,
    getState,
    flush,
    get messages() { return state.messages; },
    get skills() { return state.skills; },
    get streaming() { return state.streaming; },
    get projectId() { return state.projectId; },
    get permission() { return state.permission; },
    get reasoningEffort() { return state.reasoningEffort; },
    isStreaming: () => state.streaming,
  };
}

export default createAgentLoop;
