/* 编辑器核心编排：打开工程 → 加载 deck iframe → bridge ready → 历史 / 自动保存 / 布局 / 命令
 * 约定见 docs/SPEC.md §8 / §9 / §14。子模块 selector/text/insert/inspector/slides/present/export 由此初始化。
 */

import { api } from '../core/api.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h, clamp, debounce } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { BridgeClient } from './bridge-client.js';
import * as selection from './selection.js';
import * as text from './text.js';
import * as insert from './insert.js';
import * as inspector from './inspector.js';
import * as slides from './slides.js';
import * as present from './present.js';
import * as exporter from './export.js';
import * as historyPanel from './history.js';

const DESIGN_W = 1920;
const DESIGN_H = 1080;
const PAD_X = 18;
const PAD_Y = 32;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3];

/* ================= 模块级状态 ================= */

let ctx = null;
let bridge = null;
let project = null;
let host = null;
let bootToken = 0;
let saveDebounced = null;
let historyDebounced = null;
let savingPromise = null;
let saveQueued = false;
let historyDirty = false;
let restoringHistory = false;
let lastSavedAt = 0;
let dirty = false;
let suppressChange = 0;
let recentOpIds = [];
let offBridge = [];
let unsubStore = null;
let resizeObserver = null;
let lastHistorySig = '';
/** 兼容模式：打开时已应用的补丁基线（保存时与新补丁合并，避免覆盖旧编辑） */
let rawBasePatches = [];
let lastUiSig = '';
let lastZoom = 'fit';
let gridBtn = null;
let rulerBtn = null;
let zoomLabel = null;
let emptyEl = null;
let loadingEl = null;
let stageSyncTimer = null;
let modeBadge = null;

/* ================= 对外 API（ctx.getEditor()） ================= */

const editorApi = {
  get project() { return project; },
  get projectId() { return project?.id || null; },
  get bridge() { return bridge; },
  get iframe() { return host?.frame || null; },
  get ready() { return !!(bridge && bridge.ready); },
  get design() { return { w: DESIGN_W, h: DESIGN_H }; },
  get raw() { return store.get().deck.raw === true; },
  get mode() { return store.get().deck.mode || (store.get().deck.raw ? 'raw' : 'native'); },
  get capabilities() { return store.get().deck.capabilities || null; },
  canStructure() { return store.get().deck.capabilities?.structure !== false && !store.get().deck.raw; },
  refresh() { return syncAll(); },
  refreshDeckState() { return refreshDeckState(); },
  refreshSelection() { selection.refresh(); },
  goSlide(index) { return goSlide(index); },
  getStageRect() { return computeStageRect(); },
  getStageScale() { return currentScale(); },
  designToClient(x, y) { return designToClient(x, y); },
  clientToDesign(cx, cy) { return clientToDesign(cx, cy); },
  recordOp(op) { recordOp(op); },
  markDirty() { markDirty(); },
  saveNow(opts) { return saveNow(opts); },
  toast,
};

/* ================= 初始化 ================= */

export async function init(context) {
  ctx = context;
  host = ensureHost();
  ctx.setEditor(editorApi);

  await selection.init(ctx);
  await text.init(ctx);
  await insert.init(ctx);
  await inspector.init(ctx);
  await slides.init(ctx);
  await present.init(ctx);
  await exporter.init(ctx);
  await historyPanel.init(ctx);

  saveDebounced = debounce(() => { saveNow({ reason: 'auto' }); }, 800);
  historyDebounced = debounce(() => { persistHistory(); }, 600);

  buildToolbar();
  // 画布底部小字提示已按用户要求移除（#canvas-hint 不再渲染内容）
  if (host.hint) host.hint.remove();
  applyUiFlags();
  updateToolbar();

  bindTextEditingBus();
  bus.on('project:open', onProjectOpen);
  bus.on('library:open', onLeaveEditor);
  bus.on('project:close', onLeaveEditor);

  unsubStore = store.subscribe(onStoreChange);
  setupLayoutObservers();
  setupExitFlush();
  registerCommands();
}

/* 文字编辑中不自动保存（bridge.serialize 会结束编辑，打断输入），编辑结束后再落盘 */
let textEditingNow = false;
let textEditingBusBound = false;
function bindTextEditingBus() {
  if (textEditingBusBound) return;
  textEditingBusBound = true;
  bus.on('editor:text-editing', ({ editing } = {}) => {
    textEditingNow = !!editing;
    if (!textEditingNow && dirty) saveDebounced?.();
  });
}

/* ================= DOM 挂载点 ================= */

function ensureHost() {
  const root = document.getElementById('editor-view');
  const area = document.getElementById('canvas-area');
  const viewport = document.getElementById('canvas-viewport');
  const wrap = document.getElementById('canvas-frame-wrap');
  const frame = document.getElementById('deck-frame');
  const selectionLayer = document.getElementById('selection-layer');
  const overlays = document.getElementById('canvas-overlays');
  const toolbar = document.getElementById('canvas-toolbar');
  const hint = document.getElementById('canvas-hint');
  const inspectorEl = document.getElementById('inspector');
  const panel = document.getElementById('slide-panel');

  if (!loadingEl && area) {
    loadingEl = h('div', { class: 'canvas-loading is-hidden' },
      h('span', { class: 'canvas-loading-icon', html: ctx.icon('loading', 22) }),
      h('span', { class: 'canvas-loading-text' }, '正在加载画布…'),
      h('button', {
        class: 'btn btn--sm canvas-loading-retry',
        onclick: () => bus.emit('project:open', { project: store.get().project }),
      }, '重试'));
    area.append(loadingEl);
  }
  if (!emptyEl && area) {
    emptyEl = h('div', { class: 'canvas-empty is-hidden' },
      h('span', { class: 'canvas-empty-icon', html: ctx.icon('film', 30) }),
      h('div', { class: 'canvas-empty-title' }, '这个工程还没有幻灯片'),
      h('div', { class: 'canvas-empty-sub' }, '用左侧「+」新增一页，或让 Agent 帮你生成内容'));
    area.append(emptyEl);
  }

  return { root, area, viewport, wrap, frame, selectionLayer, overlays, toolbar, hint, inspector: inspectorEl, panel };
}

/* ================= 打开 / 关闭工程 ================= */

async function onProjectOpen(payload) {
  const next = payload?.project;
  if (!next?.id || !ctx) return;
  const token = ++bootToken;
  await teardown(false);
  project = next;
  // 历史恢复完成前不要持久化（否则会先写入空 ops 覆盖磁盘记录）
  restoringHistory = true;
  resetProjectState();
  setLoading(true, '正在加载画布…');
  store.update((s) => {
    s.project = next;
    s.deck = { ready: false, current: 0, total: 0, w: DESIGN_W, h: DESIGN_H, slides: [], mode: 'native', raw: false, capabilities: null };
  });
  applyModeUi({ raw: false });

  try {
    const frame = host.frame;
    bridge = new BridgeClient(frame, { timeout: 8000 });
    bindBridgeEvents();
    const histPromise = api.getHistory(next.id).catch((err) => {
      console.warn('[editor] 读取历史失败', err);
      return { ops: [] };
    });
    // 兼容模式（raw 原稿直编）工程不能升级内联运行时，否则会改写原稿 HTML/脚本，动画会丢
    const rawProject = next.raw === true || next.kind === 'raw' || next.mode === 'raw'
      || next.compat === true || next.origin?.mode === 'raw';
    if (!rawProject) {
      // 旧工程内联的是旧版运行时：打开时静默升级（保留 DOM/历史，仅换运行时，获得新动效/转场）
      try {
        const up = await api.upgradeRuntime(next.id);
        if (up && up.changed) {
          ctx.toast.ok('已升级播放运行时（原稿转场 / 入场时序已启用）', { duration: 2200 });
        }
      } catch (err) {
        console.warn('[editor] 运行时升级失败', err);
      }
    }
    if (token !== bootToken) return;
    const editUrl = api.deckEditUrl(next.id, 't=' + Date.now().toString(36));
    const readyData = await bridge.load(editUrl);
    if (token !== bootToken) return;

    const state = readyData?.state || (await bridge.getState());
    applyDeckState(state || {}, readyData?.mode);
    const rawDeck = store.get().deck.raw === true;
    if (rawDeck) {
      // 兼容模式：补丁是唯一真相源；历史只保留本次会话的 ops（避免旧 ops 重复生成补丁）
      try {
        const rp = await bridge.call('getRawPatches');
        rawBasePatches = Array.isArray(rp?.patches) ? rp.patches : [];
      } catch { rawBasePatches = []; }
      store.setHistory([], 0);
    } else {
      const hist = await histPromise;
      if (token !== bootToken) return;
      const ops = Array.isArray(hist?.ops) ? hist.ops.filter((o) => o && typeof o.type === 'string') : [];
      store.setHistory(ops, ops.length);
    }
    await Promise.resolve();
    restoringHistory = false;
    store.update((s) => { s.deck.ready = true; });
    setLoading(false);
    host.root.classList.add('is-loaded');
    lastSavedAt = 0;
    setSaving('saved', 0);
    applyLayout();
    applyUiFlags();
    bus.emit('deck:ready', { deck: store.get().deck, state });
    bus.emit('slide:change', { index: store.get().deck.current });
    selection.refresh();
    inspector.refresh();
    updateEmptyState();
  } catch (err) {
    if (token !== bootToken) return;
    restoringHistory = false;
    console.error('[editor] 画布加载失败', err);
    setLoading(false, '画布加载失败：' + (err?.message || err), true);
    toast.error('画布加载失败：' + (err?.message || err));
    store.update((s) => { s.deck.ready = false; });
  }
}

async function onLeaveEditor() {
  if (!project) return;
  bootToken += 1; // 让进行中的打开流程失效
  const leaving = project;
  try { await flushSaveBeforeLeave(); } catch { /* ignore */ }
  // 保存期间用户可能已经切到另一个工程，此时不要销毁新状态
  if (project !== leaving) return;
  await teardown(false);
  if (project?.id === leaving.id) project = null;
  store.update((s) => {
    s.deck = { ready: false, current: 0, total: 0, w: DESIGN_W, h: DESIGN_H, slides: [], mode: 'native', raw: false, capabilities: null };
    s.selection = null;
  });
  bus.emit('deck:unload');
}

async function flushSaveBeforeLeave() {
  if (!project) return;
  if (!bridge?.ready) {
    if (historyDirty) await persistHistory();
    return;
  }
  if (dirty) {
    const result = await saveNow({ reason: 'leave' });
    if (!result.ok) flushHistoryKeepalive();
  } else if (historyDirty) {
    await persistHistory();
  }
}

async function teardown(notify = true) {
  unbindBridgeEvents();
  if (bridge) { bridge.destroy(); bridge = null; }
  saveDebounced?.cancel();
  historyDebounced?.cancel();
  savingPromise = null;
  saveQueued = false;
  dirty = false;
  historyDirty = false;
  recentOpIds = [];
  suppressChange = 0;
  project = null;
  lastSavedAt = 0;
  if (host) {
    host.root.classList.remove('is-loaded');
    setLoading(false);
    if (emptyEl) emptyEl.classList.add('is-hidden');
    try { host.frame.src = 'about:blank'; } catch { /* ignore */ }
  }
  if (notify) {
    store.update((s) => { s.deck.ready = false; s.selection = null; });
    bus.emit('deck:unload');
  }
}

function resetProjectState() {
  recentOpIds = [];
  suppressChange = 0;
  dirty = false;
  historyDirty = false;
  lastHistorySig = '0:0';
  rawBasePatches = [];
  setSaving('saved', 0);
  store.update((s) => {
    s.selection = null;
    s.history = { ops: [], cursor: 0 };
    s.ui.zoom = 'fit';
    s.ui.saving = 'saved';
    s.ui.savedAt = 0;
    s.ui.lastError = null;
  });
  applyModeUi({ raw: false });
}

/* ================= bridge 事件 ================= */

function bindBridgeEvents() {
  if (!bridge) return;
  offBridge.push(bridge.on('change', (data) => onBridgeChange(data)));
  offBridge.push(bridge.on('selectionchange', (data) => onSelectionChange(data)));
  offBridge.push(bridge.on('slidechange', (data) => onSlideChange(data)));
  offBridge.push(bridge.on('textedit', (data) => {
    bus.emit('editor:text-editing', { editing: !!data?.editing, elementId: data?.elementId || null });
  }));
  offBridge.push(bridge.on('save-request', () => { saveNow({ reason: 'bridge' }); }));
  offBridge.push(bridge.on('error', (data) => {
    const message = data?.message || '画布内部错误';
    console.error('[editor] bridge 错误:', message);
    toast.error('画布错误：' + message);
    setLoading(false, message, true);
  }));
}

function unbindBridgeEvents() {
  for (const off of offBridge) { try { off(); } catch { /* ignore */ } }
  offBridge = [];
}

function onBridgeChange(data) {
  const op = data?.op;
  if (!op) return;
  recordOp(op);
}

function recordOp(op) {
  if (!op || typeof op.type !== 'string') return;
  if (suppressChange > 0) return;
  if (op.opId && recentOpIds.includes(op.opId)) return;
  if (op.opId) {
    recentOpIds.push(op.opId);
    if (recentOpIds.length > 80) recentOpIds.splice(0, recentOpIds.length - 80);
  }
  store.pushOp(op);
  markDirty();
  afterOp(op);
}

function afterOp(op) {
  bus.emit('editor:op', { op });
  const slideOps = ['slide-add', 'slide-delete', 'slide-move', 'slide-attrs', 'slide-html'];
  if (slideOps.includes(op.type)) {
    refreshDeckState().then(() => { slides.invalidateAll(); });
  } else {
    slides.invalidate(op.slideIndex);
  }
  if (op.type === 'text' || op.type === 'style' || op.type === 'attr') {
    document.dispatchEvent(new CustomEvent('wpx:ops-applied', { detail: { op } }));
    /* 选区的 styles 已过期（字体/字号/颜色等），重新拉一次，否则工具栏标签与属性面板停留在旧值 */
    const sel = store.get().selection;
    if (sel && (!op.elementId || op.elementId === sel.elementId)) selection.syncFromBridge();
  }
  setTimeout(() => { selection.refresh(); inspector.refresh(); }, 30);
}

function onSelectionChange(data) {
  const selectionData = data && Object.prototype.hasOwnProperty.call(data, 'selection')
    ? data.selection
    : (data || null);
  store.update((s) => { s.selection = selectionData || null; });
  bus.emit('selection:change', { selection: selectionData || null });
}

function onSlideChange(data) {
  const index = Number(data?.index ?? data ?? 0) || 0;
  const deck = store.get().deck;
  store.update((s) => {
    s.deck = { ...deck, ready: true, current: index };
    if (s.selection && s.selection.slideIndex !== index) s.selection = null;
  });
  bus.emit('deck:change', { deck: store.get().deck });
  bus.emit('slide:change', { index });
  setTimeout(() => selection.refresh(), 20);
}

/* ================= deck 状态同步 ================= */

function applyDeckState(state, readyMode = '') {
  if (!state) return null;
  const prev = store.get().deck || {};
  const modeRaw = readyMode === 'raw' || state.mode === 'raw' || state.raw === true;
  // 兼容模式（raw 原稿直编）：raw 缺失时沿用上一次（避免 refresh 把 raw 状态冲掉）
  const raw = state.raw != null ? (!!state.raw || modeRaw) : (modeRaw || prev.raw === true);
  const capabilities = state.capabilities || prev.capabilities
    || { slides: true, animations: true, insert: true, structure: true, text: true };
  const deck = {
    ready: true,
    current: Number(state.current) || 0,
    total: Number(state.total) || 0,
    w: Number(state.w) || DESIGN_W,
    h: Number(state.h) || DESIGN_H,
    slides: Array.isArray(state.slides) ? state.slides : [],
    stage: state.stage || prev.stage || null,
    mode: raw ? 'raw' : (state.mode === 'edit' ? 'native' : (state.mode || 'native')),
    raw,
    capabilities,
  };
  store.update((s) => { s.deck = deck; });
  bus.emit('deck:change', { deck });
  bus.emit('deck:mode', { mode: deck.mode, raw, capabilities });
  applyModeUi(deck);
  updateEmptyState();
  return deck;
}

/** 兼容模式 UI：画布工具条「兼容模式」徽章 + 编辑器根节点 class */
function applyModeUi(deck) {
  const current = deck || store.get().deck || {};
  const raw = current.raw === true;
  if (host?.root) host.root.classList.toggle('is-raw', raw);
  if (modeBadge) {
    modeBadge.classList.toggle('is-hidden', !raw);
    modeBadge.title = '网页工程：直接编辑网页 DOM，保存后原动画/切换完整保留';
  }
}

async function refreshDeckState() {
  if (!bridge?.ready) return null;
  try {
    const state = await bridge.getState();
    return applyDeckState(state);
  } catch (err) {
    console.warn('[editor] 同步 deck 状态失败', err);
    return null;
  }
}

function updateEmptyState() {
  if (!emptyEl) return;
  const deck = store.get().deck;
  const empty = deck.ready && deck.total === 0;
  emptyEl.classList.toggle('is-hidden', !empty);
  if (!empty) return;
  const title = emptyEl.querySelector('.canvas-empty-title');
  const sub = emptyEl.querySelector('.canvas-empty-sub');
  if (deck.raw) {
    if (title) title.textContent = '未识别到可编辑的网页页面';
    if (sub) sub.textContent = '原稿可能是动态生成的页面，暂无法可视化编辑；放映原文件不受影响';
  } else {
    if (title) title.textContent = '这个工程还没有幻灯片';
    if (sub) sub.textContent = '用左侧「+」新增一页，或让 Agent 帮你生成内容';
  }
}

function syncAll() {
  selection.refresh();
  inspector.refresh();
  slides.invalidateAll();
  refreshDeckState();
}

/* ================= 保存 / 历史 ================= */

function markDirty() {
  dirty = true;
  if (store.get().ui.saving !== 'dirty') setSaving('dirty');
  bus.emit('project:dirty', { dirty: true });
  saveDebounced?.();
}

function setSaving(state, savedAt = 0, error = null) {
  store.update((s) => {
    s.ui.saving = state;
    if (state === 'saved' && savedAt) s.ui.savedAt = savedAt;
    s.ui.lastError = error ? (error.message || String(error)) : null;
  });
  bus.emit('editor:saving', {
    saving: state,
    savedAt: state === 'saved' ? savedAt : 0,
    error: error ? (error.message || String(error)) : null,
  });
  if (state === 'saved') bus.emit('project:dirty', { dirty: false });
}

/** 合并补丁时按目标去重（html/style/attr/bg/slide-html 同一目标保留最后一次，insert/delete 保序保留） */
function dedupeRawPatches(list) {
  const keyed = new Set(['html', 'style', 'attr', 'bg', 'slide-html']);
  const seen = new Set();
  const out = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    if (!p || !p.type) continue;
    if (keyed.has(p.type)) {
      const key = p.type + ':' + p.slide + ':' + (p.path || '');
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.unshift(p);
  }
  return out;
}

/** 保存兼容模式补丁到工程 .raw-edits.json（原稿 index.html 永不改写） */
async function putRawPatches(projectId, patches) {
  if (typeof api.putRawPatches === 'function') return api.putRawPatches(projectId, patches);
  const res = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/patches', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patches: Array.isArray(patches) ? patches : [] }),
  });
  if (!res.ok) throw new Error('保存补丁失败（HTTP ' + res.status + '）');
  return res.json();
}

async function saveNow(options = {}) {
  if (!project || !bridge?.ready) {
    if (options.toast) toast('画布尚未就绪，无法保存');
    return { ok: false, error: '未打开工程' };
  }
  // 文字编辑中：自动保存延后，避免 serialize 结束编辑打断输入
  if (textEditingNow && options.reason === 'auto') {
    saveDebounced?.();
    return { ok: true, deferred: true };
  }
  if (savingPromise) {
    saveQueued = true;
    return savingPromise;
  }
  const projectId = project.id;
  saveDebounced?.cancel();
  savingPromise = (async () => {
    setSaving('saving');
    // 兼容模式（raw 原稿直编）：原稿 index.html 永不改写，编辑结果以「补丁数组」存到 .raw-edits.json
    if (store.get().deck.raw === true) {
      const history = store.get().history;
      const ops = history.ops.slice(0, history.cursor);
      const built = await bridge.call('buildPatches', { ops });
      const sessionPatches = Array.isArray(built?.patches) ? built.patches : [];
      // 合并打开时已应用的补丁，避免第二次保存覆盖掉之前的编辑；同目标去重
      const patches = dedupeRawPatches((rawBasePatches || []).concat(sessionPatches));
      const res = await putRawPatches(projectId, patches);
      rawBasePatches = patches.slice();
      // 补丁已落盘：清空会话历史，下一次保存只追加新操作（历史不再作为跨会话真相源）
      store.setHistory([], 0);
      historyDirty = false;
      lastSavedAt = Number(res?.savedAt) || Date.now();
      dirty = false;
      setSaving('saved', lastSavedAt);
      await flushHistory();
      bus.emit('project:saved', { projectId, savedAt: lastSavedAt, raw: true, patches: patches.length });
      bus.emit('editor:raw-patches', { patches });
      if (options.toast) toast.ok(`已保存（网页补丁 ${patches.length} 条）`);
      return { ok: true, savedAt: lastSavedAt, raw: true, patches: patches.length };
    }
    const result = await bridge.serialize();
    const html = typeof result === 'string' ? result : result?.html;
    if (!html) throw new Error('序列化结果为空');
    const res = await api.putFile(projectId, 'index.html', html);
    lastSavedAt = Number(res?.savedAt) || Date.now();
    dirty = false;
    setSaving('saved', lastSavedAt);
    await flushHistory();
    bus.emit('project:saved', { projectId, savedAt: lastSavedAt });
    if (options.toast) toast.ok('已保存');
    return { ok: true, savedAt: lastSavedAt };
  })()
    .catch((err) => {
      console.error('[editor] 保存失败', err);
      setSaving('error', 0, err);
      toast.error('保存失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    })
    .finally(() => {
      savingPromise = null;
      if (saveQueued) { saveQueued = false; saveNow({ reason: 'queued' }); }
    });
  return savingPromise;
}

async function persistHistory() {
  if (!project) return;
  const projectId = project.id;
  // 只持久化「已应用」的 op：磁盘上的 deck 是当前状态，历史记录必须与之一致（撤销后重开不会出现幽灵可重做项）
  const history = store.get().history;
  const ops = history.ops.slice(0, history.cursor);
  historyDirty = false;
  try {
    await api.putHistory(projectId, ops);
  } catch (err) {
    historyDirty = true;
    console.warn('[editor] 历史记录持久化失败', err);
  }
}

async function flushHistory() {
  if (!historyDirty) return;
  historyDebounced?.cancel();
  await persistHistory();
}

function scheduleHistorySave() {
  historyDirty = true;
  historyDebounced?.();
}

function flushHistoryKeepalive() {
  if (!project) return;
  const history = store.get().history;
  const ops = history.ops.slice(0, history.cursor);
  try {
    fetch('/api/projects/' + encodeURIComponent(project.id) + '/history', {
      method: 'PUT',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops }),
    }).catch(() => {});
  } catch { /* ignore */ }
}

/* ================= 撤销 / 重做 ================= */

async function doUndoRedo(isRedo) {
  if (!bridge?.ready) { toast('画布尚未就绪'); return { ok: false }; }
  const op = isRedo ? store.redoOp() : store.undoOp();
  if (!op) {
    toast(isRedo ? '没有可重做的操作' : '没有可撤销的操作');
    return { ok: false };
  }
  suppressChange += 1;
  try {
    await bridge.applyOp(op, isRedo ? 'redo' : 'undo');
  } catch (err) {
    if (isRedo) store.undoOp(); else store.redoOp();
    toast.error((isRedo ? '重做' : '撤销') + '失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  } finally {
    suppressChange = Math.max(0, suppressChange - 1);
  }
  scheduleHistorySave();
  markDirty();
  await afterUndoRedo(op);
  return { ok: true, op };
}

async function afterUndoRedo(op) {
  const state = await refreshDeckState();
  const slideOps = ['slide-add', 'slide-delete', 'slide-move', 'slide-attrs', 'slide-html'];
  if (op && slideOps.includes(op.type)) {
    slides.invalidateAll();
  } else if (op) {
    slides.invalidate(op.slideIndex);
  }
  if (op && op.slideIndex != null && state && state.current !== op.slideIndex && op.type !== 'slide-delete') {
    try { await bridge.go(op.slideIndex); } catch { /* ignore */ }
  }
  setTimeout(() => { selection.refresh(); inspector.refresh(); }, 40);
}

/* ================= 切页 / 重新加载 ================= */

async function goSlide(index) {
  if (!bridge?.ready) return { ok: false };
  const n = clamp(Number(index) || 0, 0, Math.max(0, (store.get().deck.total || 1) - 1));
  try {
    await bridge.go(n);
  } catch (err) {
    toast.error('切换幻灯片失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  }
  // 兼容模式（raw）下 bridge 用原稿自己的导航切页，可能不发送 slidechange 事件：
  // 这里主动同步一次 deck 状态，保证缩略图高亮 / 状态栏页码 / store 一致。
  try {
    if (bridge.ready) {
      const state = await bridge.getState();
      if (state) applyDeckState(state);
    }
  } catch { /* ignore */ }
  if (store.get().deck.current !== n) {
    store.update((s) => { s.deck = { ...s.deck, current: n }; });
    bus.emit('deck:change', { deck: store.get().deck });
    bus.emit('slide:change', { index: n });
  }
  setTimeout(() => selection.refresh(), 40);
  return { ok: true, index: n };
}

async function reloadDeck() {
  if (!project) return { ok: false };
  const projectId = project.id;
  if (dirty) {
    const saved = await saveNow({ reason: 'reload' });
    if (!saved.ok) {
      toast.error('有未保存的修改，重新加载已取消');
      return saved;
    }
  }
  const token = ++bootToken;
  unbindBridgeEvents();
  if (bridge) { bridge.destroy(); bridge = null; }
  if (historyDirty) await persistHistory();
  bridge = new BridgeClient(host.frame, { timeout: 8000 });
  bindBridgeEvents();
  setLoading(true, '正在重新加载画布…');
  try {
    const readyData = await bridge.load(api.deckEditUrl(projectId, 't=' + Date.now().toString(36)));
    if (token !== bootToken) return { ok: false };
    const state = readyData?.state || (await bridge.getState());
    applyDeckState(state, readyData?.mode);
    store.update((s) => { s.deck.ready = true; s.selection = null; });
    setLoading(false);
    host.root.classList.add('is-loaded');
    selection.refresh();
    inspector.refresh();
    slides.invalidateAll();
    bus.emit('deck:ready', { deck: store.get().deck, state });
    toast.ok('画布已重新加载');
    return { ok: true };
  } catch (err) {
    setLoading(false, '重新加载失败：' + (err?.message || err), true);
    toast.error('重新加载失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  }
}

/* ================= 布局 / 坐标 ================= */

function computeStageRect() {
  const frame = host?.frame;
  if (!frame) return null;
  const rect = frame.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const stage = bridge?.state?.stage;
  if (stage && Number(stage.width) > 0) {
    return {
      left: rect.left + Number(stage.left || 0),
      top: rect.top + Number(stage.top || 0),
      width: Number(stage.width),
      height: Number(stage.height),
      scale: Number(stage.scale) || Number(stage.width) / DESIGN_W,
    };
  }
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    scale: rect.width / DESIGN_W,
  };
}

function designToClient(x, y) {
  const stage = computeStageRect();
  if (!stage) return { x: 0, y: 0 };
  return { x: stage.left + x * stage.scale, y: stage.top + y * stage.scale };
}

function clientToDesign(clientX, clientY) {
  const stage = computeStageRect();
  if (!stage) return { x: 0, y: 0 };
  return { x: (clientX - stage.left) / stage.scale, y: (clientY - stage.top) / stage.scale };
}

function currentScale() {
  const stage = computeStageRect();
  return stage?.scale || 1;
}

function applyLayout() {
  if (!host?.viewport || !host?.wrap) return;
  const vw = host.viewport.clientWidth;
  const vh = host.viewport.clientHeight;
  if (!vw || !vh) return;
  const zoom = store.get().ui.zoom;
  const fitScale = Math.min((vw - PAD_X * 2) / DESIGN_W, (vh - PAD_Y * 2) / DESIGN_H);
  const numeric = Number(zoom);
  const scale = zoom === 'fit' || !Number.isFinite(numeric) || numeric <= 0
    ? Math.max(0.06, fitScale)
    : clamp(numeric, 0.05, 4);
  const w = Math.max(4, Math.round(DESIGN_W * scale));
  const hgt = Math.max(4, Math.round(DESIGN_H * scale));
  host.wrap.style.width = w + 'px';
  host.wrap.style.height = hgt + 'px';
  const realScale = w / DESIGN_W;
  host.area.style.setProperty('--grid-size', Math.round(48 * realScale) + 'px');
  updateToolbar();
  renderRulers(realScale);
  bus.emit('editor:layout', { scale: realScale, zoom: store.get().ui.zoom });
  // runtime 可能在 iframe 内重新计算 stage 缩放（letterbox），稍后重新取一次
  clearTimeout(stageSyncTimer);
  stageSyncTimer = setTimeout(() => {
    if (!bridge?.ready) return;
    bridge.getState().then(() => selection.refresh()).catch(() => {});
  }, 90);
}

function applyUiFlags() {
  if (!host) return;
  const ui = store.get().ui;
  host.area.classList.toggle('is-grid', !!ui.grid);
  host.area.classList.toggle('has-rulers', !!ui.rulers);
  if (host.root) {
    host.root.classList.toggle('is-slidepanel-off', !ui.slidePanelOpen);
    host.root.classList.toggle('is-inspector-off', !ui.inspectorOpen);
  }
  applyModeUi();
  updateToolbar();
}

/* ================= 缩放 ================= */

function setZoom(value) {
  store.update((s) => { s.ui.zoom = value; });
  applyLayout();
  bus.emit('editor:zoom', { zoom: value, scale: currentScale() });
  return { ok: true, zoom: value };
}

function zoomBy(direction) {
  const ui = store.get().ui;
  const current = ui.zoom === 'fit' ? currentScale() : (Number(ui.zoom) || currentScale());
  let next;
  if (direction > 0) {
    next = ZOOM_STEPS.find((z) => z > current + 0.005);
    if (!next) next = Math.min(4, current * 1.25);
  } else {
    next = [...ZOOM_STEPS].reverse().find((z) => z < current - 0.005);
    if (!next) next = Math.max(0.05, current / 1.25);
  }
  return setZoom(Math.round(next * 100) / 100);
}

/* ================= 工具栏 / 提示 / 空态 ================= */

function buildToolbar() {
  if (!host.toolbar) return;
  host.toolbar.innerHTML = '';
  const mk = (iconName, title, onClick, className = '') => h('button', {
    class: 'canvas-tool ' + className,
    title,
    html: ctx.icon(iconName, 15),
    onclick: onClick,
  });
  const zoomOut = mk('zoom-out', '缩小 (Ctrl+-)', () => bus.runCommand('app.zoomOut'));
  zoomLabel = h('button', { class: 'canvas-zoom-label', title: '当前缩放，点击适应窗口' }, '适应');
  zoomLabel.textContent = '100%';
  zoomLabel.addEventListener('click', () => bus.runCommand('app.zoomFit'));
  const zoomIn = mk('zoom-in', '放大 (Ctrl+=)', () => bus.runCommand('app.zoomIn'));
  const fit = mk('fit', '适应窗口 (Ctrl+0)', () => bus.runCommand('app.zoomFit'));
  const reset = h('button', { class: 'canvas-tool canvas-tool--text', title: '实际大小 100%' }, '100%');
  reset.addEventListener('click', () => bus.runCommand('app.zoomReset'));
  gridBtn = mk('grid', '显示网格', () => bus.runCommand('view.grid'));
  rulerBtn = mk('rulers', '显示标尺', () => bus.runCommand('view.rulers'));
  modeBadge = h('div', {
    class: 'canvas-mode-badge is-hidden',
    title: '网页工程：直接编辑网页 DOM，保存后原动画/切换完整保留',
  },
  h('span', { class: 'canvas-mode-dot' }),
  h('span', null, '网页工程'));
  host.toolbar.append(
    h('div', { class: 'canvas-toolbar-group' }, zoomOut, zoomLabel, zoomIn, fit, reset),
    h('div', { class: 'canvas-toolbar-sep' }),
    h('div', { class: 'canvas-toolbar-group' }, gridBtn, rulerBtn),
    h('div', { class: 'canvas-toolbar-sep' }),
    modeBadge,
  );
}

function updateToolbar() {
  if (zoomLabel) {
    const scale = currentScale();
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }
  const ui = store.get().ui;
  gridBtn?.classList.toggle('is-active', !!ui.grid);
  rulerBtn?.classList.toggle('is-active', !!ui.rulers);
}

function buildHint() {
  // 已废弃：用户要求移除画布底部的操作提示小字
}

function setLoading(active, message, isError = false) {
  if (!loadingEl) return;
  loadingEl.classList.toggle('is-hidden', !active);
  loadingEl.classList.toggle('is-error', !!isError);
  const text = loadingEl.querySelector('.canvas-loading-text');
  if (text && message) text.textContent = message;
  const iconEl = loadingEl.querySelector('.canvas-loading-icon');
  if (iconEl) iconEl.innerHTML = ctx.icon(isError ? 'alert' : 'loading', 22);
  const retry = loadingEl.querySelector('.canvas-loading-retry');
  if (retry) retry.classList.toggle('is-hidden', !isError);
}

/* ================= 标尺 ================= */

function renderRulers(scale) {
  if (!host?.overlays) return;
  let rulerH = host.overlays.querySelector('.canvas-ruler--h');
  let rulerV = host.overlays.querySelector('.canvas-ruler--v');
  const on = !!store.get().ui.rulers;
  if (!on) { rulerH?.remove(); rulerV?.remove(); return; }
  if (!rulerH) {
    rulerH = h('div', { class: 'canvas-ruler canvas-ruler--h' });
    rulerV = h('div', { class: 'canvas-ruler canvas-ruler--v' });
    host.overlays.append(rulerH, rulerV);
  }
  const stage = computeStageRect();
  const areaRect = host.area.getBoundingClientRect();
  const originX = stage ? stage.left - areaRect.left : 0;
  const originY = stage ? stage.top - areaRect.top : 0;
  const step = Math.max(18, 100 * scale);
  rulerH.innerHTML = '';
  rulerV.innerHTML = '';
  for (let x = 0, i = 0; x <= Math.max(0, stage?.width || 0) + 2 && i < 40; x += step, i++) {
    const tick = h('i', { style: { left: Math.round(originX + x) + 'px' } });
    if (i % 2 === 0) tick.append(h('b', null, String(i * 100)));
    rulerH.append(tick);
  }
  for (let y = 0, i = 0; y <= Math.max(0, stage?.height || 0) + 2 && i < 30; y += step, i++) {
    const tick = h('i', { style: { top: Math.round(originY + y) + 'px' } });
    if (i % 2 === 0) tick.append(h('b', null, String(i * 100)));
    rulerV.append(tick);
  }
}

/* ================= store 订阅 ================= */

function onStoreChange(state) {
  const history = state.history;
  const sig = `${history.ops.length}:${history.cursor}`;
  if (sig !== lastHistorySig) {
    lastHistorySig = sig;
    bus.emit('history:change', { ops: history.ops, cursor: history.cursor });
    if (!restoringHistory && project) scheduleHistorySave();
  }

  const ui = state.ui;
  const uiSig = [ui.slidePanelOpen, ui.inspectorOpen, ui.grid, ui.rulers, ui.zoom].join('|');
  if (uiSig !== lastUiSig) {
    const zoomChanged = lastZoom !== ui.zoom;
    lastUiSig = uiSig;
    lastZoom = ui.zoom;
    applyUiFlags();
    if (zoomChanged) applyLayout();
    bus.emit('editor:ui', { ui });
  }
}

/* ================= 布局观察 / 滚轮缩放 ================= */

function setupLayoutObservers() {
  if (!host?.viewport) return;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { applyLayout(); });
    resizeObserver.observe(host.viewport);
    if (host.area) resizeObserver.observe(host.area);
  } else {
    window.addEventListener('resize', () => applyLayout());
  }
  host.viewport.addEventListener('scroll', () => {
    selection.refresh();
    if (store.get().ui.rulers) renderRulers(currentScale());
  }, { passive: true });
  host.area?.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });
  bus.on('editor:op', () => updateToolbar());
}

/* ================= 离开页面时尽量保存 ================= */

function setupExitFlush() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (!project) return;
    if (dirty) saveNow({ reason: 'visibility' });
    else if (historyDirty) persistHistory();
  });
  window.addEventListener('pagehide', () => {
    if (project && (dirty || historyDirty)) flushHistoryKeepalive();
  });
  window.addEventListener('beforeunload', () => {
    if (!project) return;
    if (dirty) {
      // 序列化是异步 RPC，来不及在卸载前完成；尽力发起保存并兜底历史
      saveNow({ reason: 'unload' });
      flushHistoryKeepalive();
    } else if (historyDirty) {
      flushHistoryKeepalive();
    }
  });
}

/* ================= 命令注册 ================= */

function wrapCommand(fn) {
  return async (payload) => {
    try {
      return await fn(payload);
    } catch (err) {
      console.error('[editor] 命令执行失败', err);
      toast.error('操作失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  };
}

function reg(name, meta, fn) {
  bus.registerCommand(name, wrapCommand(fn), meta);
}

function registerCommands() {
  reg('app.save', { label: '保存', group: '文件', icon: 'save', shortcut: 'Ctrl+S' }, () => saveNow({ toast: true }));
  reg('app.undo', { label: '撤销', group: '编辑', icon: 'undo', shortcut: 'Ctrl+Z' }, () => doUndoRedo(false));
  reg('app.redo', { label: '重做', group: '编辑', icon: 'redo', shortcut: 'Ctrl+Shift+Z' }, () => doUndoRedo(true));
  reg('app.reloadDeck', { label: '重新加载画布', group: '文件', icon: 'refresh' }, () => reloadDeck());

  reg('app.zoomIn', { label: '放大', group: '视图', icon: 'zoom-in', shortcut: 'Ctrl+=' }, () => zoomBy(1));
  reg('app.zoomOut', { label: '缩小', group: '视图', icon: 'zoom-out', shortcut: 'Ctrl+-' }, () => zoomBy(-1));
  reg('app.zoomFit', { label: '适应窗口', group: '视图', icon: 'fit', shortcut: 'Ctrl+0' }, () => setZoom('fit'));
  reg('app.zoomReset', { label: '实际大小（100%）', group: '视图', icon: 'monitor' }, () => setZoom(1));
  reg('view.zoomIn', { label: '放大', group: '视图', icon: 'zoom-in' }, () => zoomBy(1));
  reg('view.zoomOut', { label: '缩小', group: '视图', icon: 'zoom-out' }, () => zoomBy(-1));
  reg('view.zoomFit', { label: '适应窗口', group: '视图', icon: 'fit' }, () => setZoom('fit'));
  reg('view.zoomReset', { label: '实际大小', group: '视图', icon: 'monitor' }, () => setZoom(1));
  reg('view.zoom', { label: '设置缩放', group: '视图', icon: 'zoom-in' }, (payload) => {
    const raw = payload && typeof payload === 'object' ? payload.zoom : payload;
    if (raw === 'fit' || raw === 'in' || raw === 'out' || raw == null) {
      if (raw === 'in') return zoomBy(1);
      if (raw === 'out') return zoomBy(-1);
      return setZoom('fit');
    }
    return setZoom(clamp(Number(raw) || 1, 0.05, 4));
  });

  reg('view.grid', { label: '显示网格', group: '视图', icon: 'grid' }, (payload) => {
    const next = typeof payload === 'boolean' ? payload
      : (payload && typeof payload === 'object' && 'grid' in payload ? !!payload.grid : !store.get().ui.grid);
    store.update((s) => { s.ui.grid = next; });
    applyUiFlags();
    return { ok: true, grid: next };
  });
  reg('view.rulers', { label: '显示标尺', group: '视图', icon: 'rulers' }, (payload) => {
    const next = typeof payload === 'boolean' ? payload
      : (payload && typeof payload === 'object' && 'rulers' in payload ? !!payload.rulers : !store.get().ui.rulers);
    store.update((s) => { s.ui.rulers = next; });
    applyUiFlags();
    if (next) applyLayout(); else renderRulers(currentScale());
    return { ok: true, rulers: next };
  });

  const toggleSlidePanel = (payload) => {
    const current = store.get().ui.slidePanelOpen;
    const next = typeof payload === 'boolean' ? payload
      : (payload && typeof payload === 'object' && 'open' in payload ? !!payload.open : !current);
    store.update((s) => { s.ui.slidePanelOpen = next; });
    applyUiFlags();
    return { ok: true, open: next };
  };
  reg('view.slidePanel', { label: '显示幻灯片栏', group: '视图', icon: 'panel-left' }, toggleSlidePanel);
  reg('app.toggleSlidePanel', { label: '切换幻灯片栏', group: '视图', icon: 'panel-left' }, toggleSlidePanel);

  const toggleInspector = (payload) => {
    const current = store.get().ui.inspectorOpen;
    const next = typeof payload === 'boolean' ? payload
      : (payload && typeof payload === 'object' && 'open' in payload ? !!payload.open : !current);
    store.update((s) => { s.ui.inspectorOpen = next; });
    applyUiFlags();
    return { ok: true, open: next };
  };
  reg('app.toggleInspector', { label: '切换属性面板', group: '视图', icon: 'sliders' }, toggleInspector);
}
