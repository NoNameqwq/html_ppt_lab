/* AI 设置（Codex 风格）：Provider 分页 / 高级设置折叠 / 技能管理 */

import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { openManager, getCachedCatalog } from './skills.js';
import { createSearchSettingsForm } from './search-settings.js';
import { createImageSettingsForm } from './image-settings.js';
import { normalizeCollaboration } from './collaboration.js';
import { createCollaborationForm } from './collaboration-settings.js';
import { normalizeCompaction } from './compaction.js';
import { createCompactionForm } from './compaction-settings.js';
import { createWebDAVForm } from './webdav-settings.js';
import { normalizeVisibleModels, providerModels } from '../core/model-visibility.js';

export const PROVIDER_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    wire: 'openai',
    model: 'deepseek-chat',
    models: [],
    keyLink: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'opencode',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    keyEnv: 'OPENCODE_GO_API_KEY',
    wire: 'auto',
    model: '',
    models: [],
    keyLink: 'https://opencode.ai/',
  },
];

const PRESET_IDS = PROVIDER_PRESETS.map((p) => p.id);
const SELECTION_KEY = 'wds:agent:model';

export const DEFAULT_AGENT = {
  temperature: 0.7,
  contextLimit: 100000000,
  /** 0 = 跟随模型最大输出（自动） */
  maxTokens: 0,
  streaming: true,
};

/* ---------- 数据层 ---------- */

export function normalizeProvider(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const id = String(p.id || '').trim();
  const models = Array.isArray(p.models) ? p.models : [];
  const custom = p.isCustom != null ? !!p.isCustom : !PRESET_IDS.includes(id);
  return {
    id,
    name: String(p.name || id || 'Provider'),
    baseUrl: String(p.baseUrl || p.base_url || p.base || ''),
    keyEnv: String(p.keyEnv || p.key_env || ''),
    keySet: !!(p.keySet || p.keyConfigured || p.hasKey),
    keySource: p.keySource || p.key_source || null,
    masked: String(p.masked || ''),
    model: String(p.model || p.defaultModel || p.default_model || ''),
    models,
    visibleModels: normalizeVisibleModels(p.visibleModels),
    wire: String(p.wire || 'openai'),
    isCustom: custom,
    keyLink: (PROVIDER_PRESETS.find((x) => x.id === id) || {}).keyLink || '',
    apiKey: '',
    clearKey: false,
    status: null,
  };
}

export function getProviders(ctx) {
  const snap = ctx && ctx.store ? ctx.store.get() : {};
  const list = snap.settings && Array.isArray(snap.settings.providers) ? snap.settings.providers : [];
  if (list.length) return list.map(normalizeProvider);
  return PROVIDER_PRESETS.map((p) => normalizeProvider({ ...p }));
}

export function providerById(ctx, providerId) {
  return getProviders(ctx).find((p) => p.id === providerId) || null;
}

export function readAgentSettings(ctx) {
  const snap = ctx && ctx.store ? ctx.store.get() : {};
  const a = (snap.settings && snap.settings.agent) || {};
  const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return {
    temperature: Math.min(2, Math.max(0, num(a.temperature, DEFAULT_AGENT.temperature))),
    contextLimit: Math.max(4000, Math.round(num(a.contextLimit, DEFAULT_AGENT.contextLimit))),
    /* 旧版默认 65536 视为「跟随模型」；0 = 自动 */
    maxTokens: (() => {
      const raw = Math.max(0, Math.min(384000, Math.round(num(a.maxTokens, DEFAULT_AGENT.maxTokens))));
      return raw === 65536 ? 0 : raw;
    })(),
    streaming: a.streaming !== false,
    collaboration: normalizeCollaboration(a.collaboration),
    compaction: normalizeCompaction(a.compaction),
  };
}

export function findModel(ctxOrProviders, providerId, modelId) {
  const providers = Array.isArray(ctxOrProviders) ? ctxOrProviders : getProviders(ctxOrProviders);
  const provider = providers.find((p) => p.id === providerId) || null;
  const model = modelId || (provider ? provider.model : '') || '';
  if (!provider || !model) {
    return { id: model, name: model || '未选择模型', provider: providerId || null };
  }
  const raw = (provider.models || []).find((m) => m && (m.id === model || m.name === model));
  if (raw) return { ...raw, id: raw.id || model, name: raw.name || raw.id || model, provider: provider.id };
  return { id: model, name: model, provider: provider.id };
}

/** 解析当前 Provider / 模型（含本地记忆与默认值） */
export function resolveActive(ctx) {
  const providers = getProviders(ctx);
  const agentState = (ctx.store.get() && ctx.store.get().agent) || {};
  const remembered = readRememberedSelection();
  let providerId = agentState.providerId || remembered.providerId || null;
  let model = agentState.model || remembered.model || null;
  let provider = providers.find((p) => p.id === providerId) || null;
  if (!provider) {
    provider = providers.find((p) => p.keySet) || providers.find((p) => p.model) || providers[0] || null;
    providerId = provider ? provider.id : null;
    model = null;
  }
  if (provider && !model) model = provider.model || (provider.models[0] && provider.models[0].id) || null;
  if (provider && model && provider.model && Array.isArray(provider.models) && provider.models.length) {
    const exists = provider.models.some((m) => m && (m.id === model || m.name === model));
    if (!exists) model = provider.model;
  }
  return { providerId: providerId || null, model: model || null, provider, info: findModel(providers, providerId, model) };
}

export function rememberSelection(providerId, model) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ providerId: providerId || null, model: model || null }));
  } catch { /* ignore */ }
}

export function readRememberedSelection() {
  try {
    const raw = localStorage.getItem(SELECTION_KEY);
    if (!raw) return { providerId: null, model: null };
    const data = JSON.parse(raw);
    return { providerId: data && data.providerId ? data.providerId : null, model: data && data.model ? data.model : null };
  } catch {
    return { providerId: null, model: null };
  }
}

export function formatContext(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 1000000) {
    const v = num / 1000000;
    return (Number.isInteger(v) ? v : v.toFixed(1)) + 'M';
  }
  if (num >= 1000) return Math.round(num / 1000) + 'k';
  return String(num);
}

/** 模型能力徽章（服务端 badges 优先，缺上下文时补充） */
export function modelBadges(info) {
  const out = [];
  if (!info) return out;
  if (Array.isArray(info.badges) && info.badges.length) {
    for (const b of info.badges) {
      if (typeof b === 'string') out.push({ label: b, kind: 'muted' });
      else if (b && b.label) out.push({ label: String(b.label), kind: b.kind || 'muted' });
    }
  } else {
    if (info.tools) out.push({ label: '工具', kind: 'accent' });
    if (info.reasoning) out.push({ label: '推理', kind: 'accent' });
    if (info.vision) out.push({ label: '视觉', kind: 'muted' });
  }
  const ctxLabel = formatContext(info.contextLength);
  if (ctxLabel && !out.some((b) => /上下文/.test(b.label) || b.label === ctxLabel)) {
    out.push({ label: ctxLabel + ' 上下文', kind: 'muted' });
  }
  return out;
}

let settingsInflight = null;

/** 拉取并写入 store.settings（失败不抛错；并发去重） */
export async function loadSettings(ctx, opts = {}) {
  const snap = ctx.store.get();
  if (!opts.force && snap.settings && snap.settings.loaded) return snap.settings;
  if (settingsInflight && !opts.force) return settingsInflight;
  settingsInflight = (async () => {
    try {
      const data = await ctx.api.getSettings();
      const providers = Array.isArray(data && data.providers) ? data.providers.map(normalizeProvider) : [];
      const ui = data && typeof data.ui === 'object' && data.ui ? data.ui : {};
      const agent = data && typeof data.agent === 'object' && data.agent ? data.agent : {};
      ctx.store.update((s) => {
        s.settings = { ...s.settings, providers, ui, agent, search: data.search || {}, imageGeneration: data.imageGeneration || { enabled: false }, loaded: true, error: null };
      });
    } catch (err) {
      console.warn('[agent/settings] 读取设置失败（服务端可能未就绪）', err);
      ctx.store.update((s) => {
        s.settings = { ...s.settings, loaded: false, error: err && err.message ? err.message : String(err) };
      });
    }
    return ctx.store.get().settings;
  })();
  try {
    return await settingsInflight;
  } finally {
    settingsInflight = null;
  }
}

/* ---------- 弹窗 UI ---------- */

function tabLabel(provider) {
  if (provider.id === 'deepseek') return 'DeepSeek';
  if (provider.id === 'opencode') return 'OpenCode Go';
  return provider.name || '自定义';
}

function statusEl(pane, provider) {
  const el = h('div', { class: 'ais-status hidden' });
  if (provider.status && provider.status.text) {
    el.classList.remove('hidden');
    el.classList.add('ais-status--' + provider.status.kind);
    el.textContent = provider.status.text;
  }
  pane.append(el);
  return el;
}

function setProviderStatus(provider, text, kind) {
  provider.status = text ? { text, kind: kind || 'info' } : null;
}

/**
 * 打开 AI 设置。
 * @param {object} ctx
 * @param {object} opts {focusProvider?, getSkills?:()=>string[], onChangeSkills?:(ids)=>void, skillsCatalog?:Array}
 * @returns {Promise<boolean>}
 */
export async function openSettings(ctx, opts = {}) {
  await loadSettings(ctx);
  const snap = ctx.store.get();
  const serverOk = !!(snap.settings && snap.settings.loaded);

  const draft = {
    providers: getProviders(ctx).map((p) => normalizeProvider({ ...p, status: null })),
    more: readAgentSettings(ctx),
    removed: [],
    activeId: null,
  };
  if (!draft.providers.length) draft.providers = PROVIDER_PRESETS.map((p) => normalizeProvider({ ...p }));
  const focus = opts.focusProvider && draft.providers.find((p) => p.id === opts.focusProvider);
  draft.activeId = (focus || draft.providers[0]).id;
  let saved = false;
  let disposed = false;
  const requests = new Set();

  const body = h('div', { class: 'ais' });
  const sectionTabs = h('div', { class: 'ais-sections', role: 'tablist', 'aria-label': 'API 设置分类' });
  const chatSection = h('div', { class: 'ais-section', role: 'tabpanel', id: 'ais-section-chat', 'aria-labelledby': 'ais-nav-chat' });
  const searchForm = createSearchSettingsForm(ctx, snap.settings.search);
  const imageForm = createImageSettingsForm(ctx, snap.settings.imageGeneration);
  let davData,davError='';try{davData=await ctx.api.getWebDAV();}catch(e){davError='WebDAV 设置不可用：'+e.message;}
  const davForm=createWebDAVForm(ctx,davData,davError);
  const sections = { chat: chatSection,
    search: h('div', { class: 'ais-section', role: 'tabpanel', id: 'ais-section-search', 'aria-labelledby': 'ais-nav-search' }, searchForm.el),
    image: h('div', { class: 'ais-section', role: 'tabpanel', id: 'ais-section-image', 'aria-labelledby': 'ais-nav-image' }, imageForm.el),
    backup: h('div',{class:'ais-section',role:'tabpanel',id:'ais-section-backup','aria-labelledby':'ais-nav-backup'},davForm.el) };
  const tabsEl = h('div', { class: 'ais-tabs', role: 'tablist' });
  const paneEl = h('div', { class: 'ais-pane', role: 'tabpanel' });
  const moreEl = h('details', { class: 'ais-more' });
  const collaborationForm=createCollaborationForm(()=>draft.providers,draft.more.collaboration);
  const compactionForm = createCompactionForm(() => draft.providers, draft.more.compaction, () => resolveActive(ctx));
  chatSection.append(h('div', { class: 'ais-section-heading' }, h('strong', {}, '选择对话模型服务'), h('p', {}, '配置服务地址与密钥，获取模型后选择默认模型。')), tabsEl, paneEl, compactionForm.el, collaborationForm.el, moreEl);
  body.append(sectionTabs, ...Object.values(sections));
  const nav = [];
  function selectSection(id) {
    for (const [key, section] of Object.entries(sections)) section.hidden = key !== id;
    for (const button of nav) { const selected = button.dataset.section === id; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
    if (id === 'image') imageForm.activate();
    if (id === 'backup') davForm.activate();
  }
  for (const [id, name, glyph] of [['chat','对话模型','message'], ['search','联网搜索','globe'], ['image','生图','image'],['backup','云端备份','cloud']]) {
    const button = h('button', { type: 'button', role: 'tab', id: 'ais-nav-' + id, class: 'ais-section-tab', 'data-section': id, 'aria-controls': 'ais-section-' + id, onClick: () => selectSection(id) }, h('span', { html: icon(glyph, 16) }), name);
    nav.push(button); sectionTabs.append(button);
  }
  sectionTabs.addEventListener('keydown', (e) => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
    e.preventDefault(); const i = nav.indexOf(document.activeElement), next = e.key === 'Home' ? 0 : e.key === 'End' ? nav.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + nav.length) % nav.length;
    selectSection(nav[next].dataset.section); nav[next].focus();
  });
  selectSection(sections[opts.section] ? opts.section : 'chat');

  function activeProvider() {
    return draft.providers.find((p) => p.id === draft.activeId) || draft.providers[0];
  }

  function renderTabs() {
    const scrollLeft = tabsEl.scrollLeft;
    collaborationForm.refresh();
    compactionForm.refresh();
    tabsEl.replaceChildren();
    for (const p of draft.providers) {
      const btn = h('button', {
        type: 'button',
        class: 'ais-tab' + (p.id === draft.activeId ? ' is-on' : ''),
        'data-pid': p.id,
        title: p.name,
      }, tabLabel(p));
      if (!p.keySet) btn.classList.add('is-missing');
      btn.addEventListener('click', () => {
        draft.activeId = p.id;
        renderTabs();
        renderPane();
      });
      tabsEl.append(btn);
    }
    const add = h('button', { type: 'button', class: 'ais-tab ais-tab-add', title: '添加自定义 Provider' });
    add.innerHTML = icon('plus', 14);
    add.addEventListener('click', () => {
      const id = 'custom-' + Date.now().toString(36);
      const p = normalizeProvider({ id, name: '自定义', baseUrl: '', keyEnv: '', wire: 'openai', model: '', models: [], isCustom: true });
      draft.providers.push(p);
      draft.activeId = p.id;
      renderTabs();
      renderPane();
    });
    tabsEl.append(add);
    tabsEl.scrollLeft = scrollLeft;
  }

  async function fetchModels(provider, pane) {
    provider.status = null;
    if (!provider.baseUrl) {
      setProviderStatus(provider, '请先填写 Base URL。', 'error');
      renderPane();
      return;
    }
    if (!provider.apiKey && !provider.keySet) {
      setProviderStatus(provider, '请先填写 API Key。', 'error');
      renderPane();
      return;
    }
    setProviderStatus(provider, '正在获取模型…', 'loading');
    renderPane();
    const controller = new AbortController(); requests.add(controller);
    try {
      const res = await ctx.api.fetchModels({
        providerId: provider.id,
        baseUrl: provider.baseUrl,
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      }, controller.signal);
      if (disposed) return;
      const models = Array.isArray(res && res.models) ? res.models : [];
      if (!models.length) {
        setProviderStatus(provider, '该端点没有返回模型。', 'warn');
        renderPane();
        return;
      }
      provider.models = models;
      collaborationForm.refresh();
      compactionForm.refresh();
      const recommended = models.find((m) => m && m.recommended) || models[0];
      const currentOk = models.some((m) => (m.id || m.name) === provider.model);
      if (!provider.model || !currentOk) provider.model = String(recommended.id || recommended.name || '');
      setProviderStatus(provider, '已获取 ' + models.length + ' 个模型，已选 ' + provider.model, 'ok');
      renderPane();
    } catch (err) {
      if (disposed || err.name === 'AbortError') return;
      setProviderStatus(provider, '获取失败：' + (err && err.message ? err.message : String(err)), 'error');
      renderPane();
    } finally { requests.delete(controller); }
  }

  async function testConnection(provider) {
    if (!provider.model || !provider.baseUrl || (!provider.apiKey && !provider.keySet)) { setProviderStatus(provider, '请先填写服务地址、API Key 并选择模型。', 'error'); renderPane(); return; }
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000), start = Date.now();
    let reply = '', error = '', finished = false;
    setProviderStatus(provider, '正在测试当前草稿…', 'loading'); renderPane();
    try {
      await ctx.api.testChatSettings({ id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey, clearKey: provider.clearKey, model: provider.model, wire: provider.wire }, (e) => {
        if (e.type === 'delta') reply += e.content || '';
        if (e.type === 'error') error = e.message || '模型返回错误';
        if (e.type === 'done') finished = true;
      }, controller.signal);
      if (error || !finished || !reply.trim()) throw new Error(error || '模型没有返回完整回复');
      setProviderStatus(provider, `连接成功 · ${Date.now()-start}ms · 草稿尚未保存`, 'ok');
    } catch (e) { setProviderStatus(provider, e.name === 'AbortError' ? '测试超时（30s）' : '连接失败：' + e.message, 'error'); }
    finally { clearTimeout(timer); requests.delete(controller); if (!disposed) renderPane(); }
  }

  function buildModelList(provider) {
    const wrap = h('div', { class: 'ais-models-section' });
    const models = providerModels(provider);
    if (!models.length) return null;
    const all = h('input', { type: 'checkbox', 'aria-label': '聊天模型全选' });
    const syncAll = () => {
      const selected = provider.visibleModels;
      const n = models.filter(m => selected === null || selected.includes(m.id)).length;
      all.checked = n === models.length;
      all.indeterminate = n > 0 && n < models.length;
    };
    all.addEventListener('change', () => { provider.visibleModels = all.checked ? null : []; renderPane(); });
    wrap.append(h('div', { class: 'ais-models-toolbar' },
      h('span', {}, '默认模型 · 聊天中显示'), h('label', { class: 'ais-model-select-all' }, all, '全选')),
      h('p', { class: 'ais-models-hint' }, '点击卡片设置默认模型；勾选决定聊天菜单显示哪些模型。全选后自动显示新获取的模型。'));
    const list = h('div', { class: 'ais-models' });
    for (const m of models) {
      const id = String(m.id || m.name || '');
      if (!id) continue;
      const isOn = provider.model === id;
      const item = h('button', { type: 'button', class: 'ais-model' + (isOn ? ' is-on' : '') });
      const head = h('div', { class: 'ais-model-head' },
        h('span', { class: 'ais-model-name' }, String(m.name || id)),
        h('span', { class: 'ais-model-id' }, id)
      );
      item.append(head);
      const badges = modelBadges(m);
      if (badges.length) {
        const row = h('div', { class: 'ais-model-badges' });
        for (const b of badges) row.append(h('span', { class: 'badge ' + (b.kind === 'accent' ? 'badge--accent' : 'badge--muted') }, b.label));
        item.append(row);
      }
      item.addEventListener('click', () => {
        provider.model = id;
        setProviderStatus(provider, '默认模型：' + id + '（保存后生效）', 'ok');
        renderPane();
      });
      const check = h('input', { type: 'checkbox', 'aria-label': '聊天中显示 ' + id });
      check.checked = provider.visibleModels === null || provider.visibleModels.includes(id);
      check.addEventListener('change', () => {
        const selected = new Set(provider.visibleModels === null ? models.map(m => m.id) : provider.visibleModels);
        if (check.checked) selected.add(id); else selected.delete(id);
        provider.visibleModels = [...selected]; syncAll();
      });
      list.append(h('div', { class: 'ais-model-row' }, item,
        h('label', { class: 'ais-model-visible', title: '在聊天模型菜单中显示' }, check, h('span', {}, '显示'))));
    }
    syncAll(); wrap.append(list);
    return wrap;
  }

  function buildAdvanced(provider, pane) {
    const det = h('details', { class: 'ais-adv' });
    const summary = h('summary', {}, 'Provider 高级');
    const inner = h('div', { class: 'ais-adv-body' });
    const modelInput = h('input', { class: 'input', placeholder: '模型 id，如 deepseek-chat', value: provider.model || '', list: 'ais-models-' + provider.id });
    modelInput.addEventListener('input', () => { provider.model = modelInput.value.trim(); });
    modelInput.addEventListener('change', () => { renderPane(); collaborationForm.refresh(); compactionForm.refresh(); });
    const datalist = h('datalist', { id: 'ais-models-' + provider.id });
    for (const m of provider.models || []) {
      const id = m && (m.id || m.name);
      if (id) datalist.append(h('option', { value: String(id) }));
    }
    inner.append(
      h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, '模型 id'), modelInput, datalist)
    );
    const tools = h('div', { class: 'ais-adv-tools' });
    if (provider.isCustom) {
      const wire = h('select', { class: 'input ais-select' });
      for (const [v, label] of [['openai', 'OpenAI 兼容'], ['auto', '自动判断'], ['anthropic', 'Anthropic']]) {
        const opt = h('option', { value: v }, label);
        if (provider.wire === v) opt.selected = true;
        wire.append(opt);
      }
      wire.addEventListener('change', () => { provider.wire = wire.value; });
      tools.append(h('label', { class: 'ais-field ais-field--inline' }, h('span', { class: 'ais-label' }, 'wire'), wire));
      const del = h('button', { type: 'button', class: 'btn btn--sm btn--danger' }, '删除 Provider');
      del.addEventListener('click', () => {
        const i = draft.providers.findIndex((p) => p.id === provider.id);
        if (i >= 0) draft.providers.splice(i, 1);
        if (!draft.removed.includes(provider.id)) draft.removed.push(provider.id);
        draft.activeId = (draft.providers[0] || {}).id || null;
        renderTabs();
        renderPane();
      });
      tools.append(del);
    }
    if (provider.keySet) {
      const clear = h('button', { type: 'button', class: 'btn btn--sm btn--ghost' }, '清除 Key');
      clear.addEventListener('click', () => {
        provider.clearKey = true;
        provider.keySet = false;
        provider.keySource = null;
        provider.masked = '';
        setProviderStatus(provider, '保存后清除已存 Key。', 'warn');
        renderPane();
      });
      tools.append(clear);
    }
    inner.append(tools);
    if (provider.keyLink) {
      const a = h('a', { class: 'ais-link', href: provider.keyLink, target: '_blank', rel: 'noopener noreferrer' });
      a.innerHTML = icon('external', 12) + '<span>去获取 Key</span>';
      inner.append(a);
    }
    det.append(summary, inner);
    return det;
  }

  function renderPane() {
    paneEl.replaceChildren();
    const provider = activeProvider();
    if (!provider) {
      paneEl.append(h('div', { class: 'ais-empty' }, '还没有 Provider，点上方 + 添加。'));
      return;
    }
    if (provider.isCustom) {
      const name = h('input', { class: 'input', value: provider.name, maxlength: '80', 'aria-label': '供应商名称', placeholder: '例如：我的模型服务' });
      name.addEventListener('input', () => { provider.name = name.value.trim(); renderTabs(); });
      paneEl.append(h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, '供应商名称'), name));
    }
    const keyRow = h('label', { class: 'ais-field ais-field--row' });
    const keyInput = h('input', {
      class: 'input ais-key-input',
      type: 'password',
      autocomplete: 'new-password',
      placeholder: provider.keySet ? '已配置（留空不修改）' : '粘贴 API Key',
      value: provider.apiKey || '',
      'aria-label': '对话 API Key',
    });
    keyInput.addEventListener('input', () => { provider.apiKey = keyInput.value; provider.clearKey = false; });
    keyRow.append(h('span', { class: 'ais-label' }, 'API Key'), keyInput);

    const sub = h('div', { class: 'ais-subline' });
    if (provider.keySet) {
      sub.textContent = '已配置' + (provider.keySource === 'env' ? '（环境变量 ' + provider.keyEnv + '）' : '') + (provider.masked ? ' · ' + provider.masked : '') + ' · Key 只存服务端';
    } else {
      sub.textContent = '未配置 · Key 只存服务端' + (provider.keyEnv ? '（也可用环境变量 ' + provider.keyEnv + '）' : '');
    }

    const actions = h('div', { class: 'ais-actions' });
    const fetchBtn = h('button', { type: 'button', class: 'btn btn--sm' });
    fetchBtn.innerHTML = icon('refresh', 13) + '<span>获取模型</span>';
    fetchBtn.addEventListener('click', () => fetchModels(provider, paneEl));
    const testBtn = h('button', { type: 'button', class: 'btn btn--sm', onClick: () => testConnection(provider) }, '测试对话连接');
    const modelTag = h('span', { class: 'ais-model-picked ellipsis' }, provider.model ? '模型：' + provider.model : '未选择模型');
    actions.append(fetchBtn, testBtn, h('span', { class: 'grow' }), modelTag);

    const base = h('input', { class: 'input', value: provider.baseUrl || '', placeholder: 'https://api.example.com/v1', 'aria-label': '对话 Base URL' });
    base.addEventListener('input', () => { provider.baseUrl = base.value.trim(); });
    paneEl.append(h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, 'Base URL'), base), keyRow, sub, actions);
    statusEl(paneEl, provider);
    const modelList = buildModelList(provider);
    if (modelList) paneEl.append(modelList);
    paneEl.append(buildAdvanced(provider, paneEl));
  }

  function renderMore() {
    moreEl.replaceChildren();
    const summary = h('summary', { class: 'ais-more-summary' });
    summary.innerHTML = icon('sliders', 14) + '<span>高级设置</span>';
    const inner = h('div', { class: 'ais-more-body' });

    /* 温度 */
    const tempValue = h('span', { class: 'ais-value' }, Number(draft.more.temperature).toFixed(2));
    const tempInput = h('input', { type: 'range', min: '0', max: '2', step: '0.05', class: 'ais-range', value: String(draft.more.temperature) });
    tempInput.addEventListener('input', () => {
      draft.more.temperature = Number(tempInput.value);
      tempValue.textContent = Number(tempInput.value).toFixed(2);
    });
    inner.append(h('div', { class: 'ais-row' },
      h('span', { class: 'ais-row-label' }, '温度'),
      tempInput,
      tempValue
    ));

    /* 上下文上限 */
    const ctxInput = h('input', { type: 'number', min: '4000', max: '200000000', step: '10000', class: 'input ais-num', value: String(draft.more.contextLimit) });
    ctxInput.addEventListener('input', () => {
      const n = Number(ctxInput.value);
      if (Number.isFinite(n) && n > 0) draft.more.contextLimit = Math.round(n);
    });
    inner.append(h('div', { class: 'ais-row' },
      h('span', { class: 'ais-row-label' }, '上下文上限'),
      h('span', { class: 'ais-row-hint' }, formatContext(draft.more.contextLimit) + ' tokens'),
      ctxInput
    ));

    /* 最大输出：0 = 跟随模型（默认），截断后自动接续 */
    const maxInput = h('input', { type: 'number', min: '0', max: '384000', step: '1024', class: 'input ais-num', value: String(draft.more.maxTokens) });
    const maxHint = h('span', { class: 'ais-row-hint' }, draft.more.maxTokens > 0 ? draft.more.maxTokens + ' tokens · 截断后自动接续' : '跟随模型最大输出 · 截断后自动接续');
    maxInput.addEventListener('input', () => {
      const n = Number(maxInput.value);
      if (!Number.isFinite(n) || n < 0) return;
      draft.more.maxTokens = Math.round(n);
      maxHint.textContent = draft.more.maxTokens > 0
        ? draft.more.maxTokens + ' tokens · 截断后自动接续'
        : '跟随模型最大输出 · 截断后自动接续';
    });
    inner.append(h('div', { class: 'ais-row' },
      h('span', { class: 'ais-row-label' }, '最大输出'),
      maxHint,
      maxInput
    ));

    /* 流式 */
    const streamInput = h('input', { type: 'checkbox' });
    streamInput.checked = !!draft.more.streaming;
    streamInput.addEventListener('change', () => { draft.more.streaming = streamInput.checked; });
    inner.append(h('div', { class: 'ais-row' },
      h('span', { class: 'ais-row-label' }, '流式输出'),
      h('span', { class: 'grow' }),
      h('label', { class: 'switch' }, streamInput, h('i'))
    ));

    /* 技能管理 */
    const enabled = typeof opts.getSkills === 'function' ? (opts.getSkills() || []) : [];
    const catalog = Array.isArray(opts.skillsCatalog) && opts.skillsCatalog.length ? opts.skillsCatalog : getCachedCatalog();
    const skillBtn = h('button', { type: 'button', class: 'btn btn--sm' }, '技能管理');
    skillBtn.addEventListener('click', () => {
      openManager(ctx, {
        catalog,
        enabled: typeof opts.getSkills === 'function' ? (opts.getSkills() || []) : [],
        onChange: (ids) => {
          if (typeof opts.onChangeSkills === 'function') opts.onChangeSkills(ids);
        },
      });
    });
    inner.append(h('div', { class: 'ais-row' },
      h('span', { class: 'ais-row-label' }, '技能'),
      h('span', { class: 'ais-row-hint' }, '已启用 ' + enabled.length + ' / ' + catalog.length),
      h('span', { class: 'grow' }),
      skillBtn
    ));

    moreEl.append(summary, inner);
  }

  async function saveDraft(silent = false) {
    const providers = draft.providers.map((p) => {
      const base = {
        id: p.id,
        name: p.name || p.id,
        baseUrl: p.baseUrl,
        wire: p.wire,
        keyEnv: p.keyEnv,
        model: p.model,
        models: p.models || [],
        visibleModels: normalizeVisibleModels(p.visibleModels),
      };
      if (p.isCustom) base.custom = true;
      if (p.apiKey) base.apiKey = p.apiKey;
      if (p.clearKey) base.clearKey = true;
      return base;
    });
    const payload = {
      providers,
      agent: {
        temperature: draft.more.temperature,
        contextLimit: draft.more.contextLimit,
        maxTokens: draft.more.maxTokens,
        streaming: draft.more.streaming,
        collaboration:collaborationForm.getValue(),
        compaction: compactionForm.getValue(),
      },
      ui: { ...((ctx.store.get().settings && ctx.store.get().settings.ui) || {}) },
    };
    if (Array.isArray(draft.removed) && draft.removed.length) payload.removeProviders = draft.removed.slice();
    payload.search = searchForm.getPatch();
    payload.imageGeneration = imageForm.getPatch();
    await ctx.api.putUserSettings(payload);
    await davForm.save();
    for (const p of draft.providers) {
      if (p.apiKey) { p.keySet = true; p.keySource = 'settings'; }
      if (p.clearKey) { p.keySet = false; p.keySource = null; p.masked = ''; p.clearKey = false; }
      p.apiKey = '';
    }
    const removedIds = draft.removed.slice();
    draft.removed = [];
    await loadSettings(ctx, { force: true });
    if (removedIds.length) {
      const remain = getProviders(ctx).filter((p) => removedIds.includes(p.id));
      if (remain.length) ctx.toast.warn('服务端暂不支持删除该 Provider：' + remain.map((p) => p.name).join('、'));
    }
    saved = true;
    if (!silent && typeof opts.onSaved === 'function') opts.onSaved();
    return true;
  }

  renderTabs();
  renderPane();
  renderMore();

  let saving = false;
  const result = await ctx.dialog.open({
    title: 'API 设置',
    sub: serverOk ? '模型、搜索、生图与云端备份，统一管理' : '设置接口未就绪，保存可能失败',
    width: 'lg',
    className: 'ais-dialog',
    body,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      {
        label: '保存',
        kind: 'primary',
        onClick: async () => {
          if (saving) return false;
          saving = true;
          try {
            await saveDraft(false);
            ctx.toast.ok('API 设置已保存');
            return true;
          } catch (err) {
            console.error('[agent/settings] 保存失败', err);
            ctx.toast.error('保存失败：' + (err && err.message ? err.message : String(err)));
            return false;
          } finally { saving = false; }
        },
      },
    ],
    onClose: () => { disposed = true; for (const controller of requests) controller.abort(); imageForm.dispose(); davForm.dispose(); },
  });
  return result === true && saved;
}

export default { openSettings, loadSettings, getProviders, resolveActive, modelBadges };

