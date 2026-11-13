/* 切换面板：Ribbon「切换」标签 + 切换相关命令
   契约：docs/SPEC.md §4.3 / §6.3 / §8.2 / §14
   切换名固定 18 个（SPEC §4.3），预览用 animations.css 中的 CSS keyframes（.prev-*）。 */

import { h, on } from '../core/dom.js';
import { icon } from '../ui/icons.js';

const TAB_ID = 'transitions';
const TAB_ORDER = 45;

/** 18 个切换（顺序=SPEC §4.3，不得改名） */
const TRANSITIONS = [
  { name: 'fade', label: '淡入淡出', desc: '透明度过渡，最稳的默认切换' },
  { name: 'slide', label: '平移滑入', desc: '整页轻微移动淡入' },
  { name: 'pushLeft', label: '向左推进', desc: '新页从右侧推入' },
  { name: 'pushRight', label: '向右推进', desc: '新页从左侧推入' },
  { name: 'pushUp', label: '向上推进', desc: '新页从下方推入' },
  { name: 'pushDown', label: '向下推进', desc: '新页从上方推入' },
  { name: 'zoom', label: '放大推入', desc: '由小放大推进' },
  { name: 'zoomOut', label: '拉远收束', desc: '由大缩小落定' },
  { name: 'flipX', label: '上下翻折', desc: '绕水平轴翻转' },
  { name: 'flipY', label: '左右翻折', desc: '绕垂直轴翻转' },
  { name: 'iris', label: '圆形揭开', desc: '圆形遮罩由中心扩散' },
  { name: 'blinds', label: '百叶窗', desc: '横条分段落下' },
  { name: 'split', label: '中缝对开', desc: '从画面中缝向两侧打开' },
  { name: 'wipeUp', label: '向上擦除', desc: '自下而上擦出' },
  { name: 'wipeDown', label: '向下擦除', desc: '自上而下擦出' },
  { name: 'curtain', label: '幕布合拢', desc: '左右两块合拢揭示' },
  { name: 'shutter', label: '快门', desc: '竖条快速落下再打开' },
  { name: 'mosaic', label: '马赛克', desc: '方格阵列拼合揭示' },
  { name: 'clock', label: '时钟扫过', desc: '锥形遮罩旋转扫开' },
  { name: 'fold', label: '翻折落下', desc: '绕顶部横轴翻下' },
  { name: 'dissolve', label: '溶解', desc: '模糊散点溶入' },
  { name: 'glitch', label: '信号错位', desc: '切片抖动 + 通道偏移' },
  { name: 'flash', label: '闪白', desc: '白屏闪光后切入，适合强节奏' },
];

/** 画廊分组（只影响排版，不影响数据） */
const GROUPS = [
  { label: '基础', names: ['fade', 'slide'] },
  { label: '推进', names: ['pushLeft', 'pushRight', 'pushUp', 'pushDown'] },
  { label: '缩放', names: ['zoom', 'zoomOut'] },
  { label: '翻折', names: ['flipX', 'flipY'] },
  { label: '遮罩', names: ['iris', 'blinds', 'split', 'wipeUp', 'wipeDown'] },
  { label: '特效', names: ['curtain', 'dissolve', 'glitch', 'shutter', 'mosaic', 'clock', 'fold', 'flash'] },
];

const FX_LIST = [
  ['none', '无'],
  ['flash', '白闪'],
  ['black', '黑闪'],
  ['color', '色闪'],
  ['fly', '飞入'],
  ['sweep', '扫光'],
  ['bars', '横线'],
];
const FX_LABELS = Object.fromEntries(FX_LIST);

const DURATIONS = [400, 600, 800, 1000, 1200];
const DEFAULT_DURATION = 800;

const ui = {
  ctx: null,
  root: null,
  cards: [],
  duration: DEFAULT_DURATION,
  durations: {},       // 每页时长缓存（bridge.getState 不含 duration）
  clickAdvance: false,
  mouseMode: 'advance',
  currentName: '',
  flagsLoaded: false,
  modalEl: null,
};

/* ---------- 工具 ---------- */
const ctx = () => ui.ctx;

function ic(name, size = 15) {
  return h('span', { class: 'ic-wrap', html: icon(name, size) });
}

function toast(msg, type = 'info', duration) {
  try { ctx().toast(msg, { type, duration }); } catch { /* ignore */ }
}

function getState() {
  try { return ctx().store.get(); } catch { return null; }
}

function currentSlideIndex() {
  const st = getState();
  return st && st.deck ? st.deck.current || 0 : 0;
}

function slideCount() {
  const st = getState();
  return st && st.deck ? st.deck.total || (st.deck.slides || []).length : 0;
}

function bridge() {
  try { return ctx().getEditor()?.bridge || null; } catch { return null; }
}

async function callBridge(method, params = {}) {
  const b = bridge();
  if (!b) return null;
  try {
    // 优先走原始 RPC（bridge-client 便捷方法是位置参数，传对象会二次包装）
    if (typeof b.call === 'function') return await b.call(method, params);
    if (typeof b.request === 'function') return await b.request(method, params);
    if (typeof b.invoke === 'function') return await b.invoke(method, params);
    if (typeof b[method] === 'function') return await b[method](params);
  } catch (err) {
    console.warn('[transitions] bridge.' + method + ' 失败 params=' + JSON.stringify(params), err);
  }
  return null;
}

/** 画布/dock 是否已就绪（避免 deck 重载间隙写入越界页） */
function deckReady() {
  const st = getState();
  if (!st || !st.deck) return false;
  return !!st.deck.ready && (st.deck.total || (st.deck.slides || []).length) > 0;
}

function transitionMeta(name) {
  return TRANSITIONS.find((t) => t.name === name) || null;
}

function transitionLabel(name) {
  const meta = transitionMeta(name);
  return meta ? meta.label : (name || '无');
}

function setActiveTab() {
  try { ctx().ribbon?.setActiveTab?.(TAB_ID); } catch { /* ignore */ }
}

/* ---------- 当前页切换 / 时长 ---------- */
function readDeckSlide(index) {
  const st = getState();
  const slides = (st && st.deck && st.deck.slides) || [];
  return slides[index] || null;
}

/** bridge.getState 不含 duration，这里从 iframe 只读兜底读取 */
function readDurationFromDom(index) {
  try {
    const doc = getEditor()?.iframe?.contentDocument;
    if (!doc) return 0;
    const section = doc.querySelectorAll('.wpx-slide')[index];
    if (!section) return 0;
    const v = Number(section.getAttribute('data-transition-duration') || section.dataset.transitionDuration);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

function getEditor() {
  try { return ctx().getEditor ? ctx().getEditor() : null; } catch { return null; }
}

function deckIsRaw() {
  const ed = getEditor();
  return !!(ed && (ed.raw === true || ed.mode === 'raw'));
}

function refreshToolbar() {
  if (!ui.root) return;
  const index = currentSlideIndex();
  const slide = readDeckSlide(index);
  const name = (slide && slide.transition) || ui.currentName || 'fade';
  ui.currentName = name;
  const valueEl = ui.root.querySelector('.wpx-cur-value');
  if (valueEl) valueEl.textContent = transitionLabel(name);
  const tagEl = ui.root.querySelector('.wpx-cur-tag');
  if (tagEl) tagEl.textContent = '第 ' + (index + 1) + ' 页';

  const duration = ui.durations[index] || readDurationFromDom(index) || ui.duration || DEFAULT_DURATION;
  const durSel = ui.root.querySelector('[data-act="duration"]');
  if (durSel) durSel.value = String(duration);

  const clickInput = ui.root.querySelector('[data-act="clickAdvance"]');
  if (clickInput) clickInput.checked = !!ui.clickAdvance;
  const mouseSel = ui.root.querySelector('[data-act="mouseMode"]');
  if (mouseSel) mouseSel.value = ui.mouseMode || 'advance';
  const fx = (slide && slide.transitionFx) || 'none';
  const fxSel = ui.root.querySelector('[data-act="fx"]');
  if (fxSel) fxSel.value = fx;

  const count = slideCount();
  const applyAll = ui.root.querySelector('[data-act="applyAll"]');
  if (applyAll) applyAll.disabled = count < 1;
  if (durSel) durSel.disabled = count < 1;

  ui.cards.forEach((card) => card.classList.toggle('is-active', card.dataset.t === name));
}

/** 读取 deck 级 flags（grain/vignette/clickAdvance），bridge 不可用时用 iframe 只读兜底 */
async function loadFlags(force = false) {
  if (ui.flagsLoaded && !force) return;
  const res = await callBridge('getDeckFlags', {});
  if (res && typeof res === 'object') {
    if (typeof res.clickAdvance === 'boolean') ui.clickAdvance = res.clickAdvance;
    if (typeof res.mouseMode === 'string') ui.mouseMode = res.mouseMode;
    ui.flagsLoaded = true;
  } else {
    try {
      const body = getEditor()?.iframe?.contentDocument?.body;
      if (body) {
        ui.clickAdvance = body.getAttribute('data-wpx-click-advance') === 'on'
          || body.dataset.wpxClickAdvance === 'true';
        ui.flagsLoaded = true;
      }
    } catch { /* ignore */ }
  }
  refreshToolbar();
}

/* ---------- 应用 ---------- */
async function applyTransition(name, index, opts = {}) {
  const meta = transitionMeta(name);
  if (!meta) return { ok: false, error: '未知切换名: ' + name };
  if (!deckReady()) {
    toast('画布还没就绪，请稍后再试', 'warn', 1600);
    return { ok: false, error: '画布未就绪' };
  }
  const max = Math.max(0, slideCount() - 1);
  const wanted = Number.isInteger(index) ? index : currentSlideIndex();
  const i = Math.min(Math.max(0, wanted), max);
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : (ui.durations[i] || ui.duration || DEFAULT_DURATION);
  const res = await callBridge('setSlideAttrs', { index: i, attrs: { transition: name, duration } });
  ui.currentName = name;
  ui.durations[i] = duration;
  try {
    ctx().store.update((s) => {
      const slide = (s.deck.slides || [])[i];
      if (slide) slide.transition = name;
    });
  } catch { /* ignore */ }
  refreshToolbar();
  if (opts.silent !== true) toast('已应用切换「' + meta.label + '」', 'ok', 1400);
  return { ok: true, op: res && res.op, index: i, name };
}

async function applyToAll() {
  if (!deckReady()) {
    toast('画布还没就绪，请稍后再试', 'warn', 1600);
    return { ok: false, error: '画布未就绪' };
  }
  const count = slideCount();
  if (count < 1) {
    toast('还没有可应用切换的页面', 'warn');
    return { ok: false, error: '无幻灯片' };
  }
  const name = ui.currentName || 'fade';
  const duration = ui.duration || DEFAULT_DURATION;
  let done = 0;
  for (let i = 0; i < count; i++) {
    const res = await callBridge('setSlideAttrs', { index: i, attrs: { transition: name, duration } });
    if (res != null) done += 1;
    ui.durations[i] = duration;
  }
  try {
    ctx().store.update((s) => {
      (s.deck.slides || []).forEach((slide) => { slide.transition = name; });
    });
  } catch { /* ignore */ }
  toast('已把「' + transitionLabel(name) + '」应用到全部 ' + count + ' 页', 'ok');
  return { ok: true, count, name, duration, done };
}

async function setDuration(ms) {
  const duration = Number(ms) || DEFAULT_DURATION;
  ui.duration = duration;
  const i = currentSlideIndex();
  ui.durations[i] = duration;
  if (deckReady() && ui.currentName) {
    await callBridge('setSlideAttrs', { index: Math.min(i, Math.max(0, slideCount() - 1)), attrs: { transition: ui.currentName, duration } });
    toast('切换时长 ' + duration + 'ms', 'ok', 1100);
  }
  refreshToolbar();
  return { ok: true, duration };
}

async function setClickAdvance(value) {
  ui.clickAdvance = !!value;
  const res = await callBridge('setDeckFlags', { clickAdvance: ui.clickAdvance });
  if (res == null && bridge() == null) {
    toast('运行时未就绪：仅保存界面状态', 'warn', 1800);
  } else {
    toast(ui.clickAdvance ? '放映时单击推进：已开启' : '放映时单击推进：已关闭', 'ok', 1400);
  }
  refreshToolbar();
  return { ok: true, clickAdvance: ui.clickAdvance };
}

async function setMouseMode(value) {
  const mode = ['advance', 'anim', 'off'].includes(value) ? value : 'advance';
  ui.mouseMode = mode;
  ui.clickAdvance = mode === 'advance';
  const res = await callBridge('setDeckFlags', { mouseMode: mode, clickAdvance: ui.clickAdvance });
  if (res == null && bridge() == null) toast('运行时未就绪：仅保存界面状态', 'warn', 1800);
  else toast(mode === 'advance' ? '放映左键：翻页' : mode === 'anim' ? '放映左键：只播动画，不翻页' : '放映左键：不响应', 'ok', 1800);
  refreshToolbar();
  return { ok: true, mouseMode: mode };
}

async function rawGetDeckConfig() {
  const id = ctx()?.store?.get()?.project?.id;
  if (!id) return {};
  const res = await fetch('/api/projects/' + encodeURIComponent(id) + '/deck-config').catch(() => null);
  if (!res || !res.ok) return {};
  const data = await res.json().catch(() => ({}));
  return data.config || {};
}
async function rawPutDeckConfig(config) {
  const id = ctx()?.store?.get()?.project?.id;
  if (!id) return;
  await fetch('/api/projects/' + encodeURIComponent(id) + '/deck-config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
  }).catch(() => null);
}

async function setTransitionFx(value) {
  const i = currentSlideIndex();
  const fx = value || 'none';
  if (deckIsRaw()) {
    const cfg = await rawGetDeckConfig();
    cfg.transitionFx = cfg.transitionFx || {};
    cfg.transitionFx[String(i)] = fx;
    await rawPutDeckConfig(cfg);
    await callBridge('setSlideAttrs', { index: i, attrs: { transitionFx: fx } });
    try {
      ctx().store.update((s) => {
        const slide = (s.deck.slides || [])[i];
        if (slide) slide.transitionFx = fx;
      });
    } catch { /* ignore */ }
    refreshToolbar();
    toast(fx === 'none' ? '已关闭转场叠加' : '已叠加「' + (FX_LABELS[fx] || fx) + '」（原稿切换保持不动）', 'ok', 1800);
    return { ok: true, fx, raw: true };
  }
  const res = await callBridge('setSlideAttrs', { index: i, attrs: { transitionFx: fx } });
  try {
    ctx().store.update((s) => {
      const slide = (s.deck.slides || [])[i];
      if (slide) slide.transitionFx = fx;
    });
  } catch { /* ignore */ }
  refreshToolbar();
  toast(fx === 'none' ? '已关闭转场叠加' : '已叠加「' + (FX_LABELS[fx] || fx) + '」', 'ok', 1600);
  return { ok: true, fx, op: res && res.op };
}

/* ---------- Ribbon 渲染 ---------- */
function buildCard(meta) {
  const stage = h('div', { class: 'tr-mini' },
    h('div', { class: 'tr-bg' }),
    h('div', { class: 'tr-next' },
      h('span', { class: 'tr-next-bar' }),
      h('span', { class: 'tr-next-line' }),
      h('span', { class: 'tr-next-dot' })),
    h('div', { class: 'tr-grid' }));
  const card = h('button', {
    class: 'tr-card',
    type: 'button',
    'data-t': meta.name,
    'data-tip': meta.label + ' · ' + meta.desc,
    title: meta.name + ' · ' + meta.label,
  }, stage, h('div', { class: 'tr-label ellipsis' }, meta.label));
  on(card, 'click', () => {
    if (slideCount() < 1) {
      toast('还没有可应用切换的页面', 'warn');
      return;
    }
    const index = currentSlideIndex();
    if (deckIsRaw()) {
      toast('切换由网页本身控制，已按原稿真实速度预览；可用「转场」叠加屏闪/飞入', 'info', 2200);
      previewCurrent();
      return;
    }
    applyTransition(meta.name, index).then((r) => {
      if (r && r.ok) previewCurrent(meta.name, index);
    });
  });
  return card;
}

function buildGallery() {
  const row = h('div', { class: 'tr-row', role: 'list', 'aria-label': '切换效果' });
  const byName = new Map(TRANSITIONS.map((t) => [t.name, t]));
  ui.cards = [];
  for (const group of GROUPS) {
    row.append(h('div', { class: 'tr-group-label' }, group.label));
    for (const name of group.names) {
      const meta = byName.get(name);
      if (!meta) continue;
      const card = buildCard(meta);
      ui.cards.push(card);
      row.append(card);
    }
  }
  return row;
}

/** 完整预览切换（native：画布内克隆两页真实播放；raw：原稿真实速度切换一次再切回） */
async function previewCurrent(nameOverride, indexOverride) {
  if (!deckReady()) {
    toast('画布还没就绪，请稍后再试', 'warn', 1600);
    return { ok: false, error: '画布未就绪' };
  }
  const index = Number.isInteger(indexOverride) ? indexOverride : currentSlideIndex();
  const slide = readDeckSlide(index);
  const name = nameOverride || (slide && slide.transition) || ui.currentName || 'fade';
  const duration = ui.durations[index] || readDurationFromDom(index) || ui.duration;
  const editor = getEditor();
  const isRaw = !!(editor && (editor.raw === true || editor.mode === 'raw'));
  try {
    const res = await callBridge('previewTransition', { name, duration });
    if (isRaw && editor && typeof editor.goSlide === 'function') {
      try { await editor.goSlide(index); } catch { /* ignore */ }
    }
    return { ok: true, name, duration, res };
  } catch (err) {
    toast('切换预览失败：' + (err?.message || err), 'warn', 2400);
    return { ok: false, error: err?.message || String(err) };
  }
}

/** 全部切换效果弹窗：一次看全所有预设（预设栏放不下时的完整入口） */
function closeAllTransitions() {
  if (ui.modalEl) { try { ui.modalEl.remove(); } catch { /* ignore */ } ui.modalEl = null; }
}

function openAllTransitions() {
  closeAllTransitions();
  const overlay = h('div', { class: 'tr-modal-backdrop' });
  const panel = h('div', { class: 'tr-modal', role: 'dialog', 'aria-label': '全部切换效果' });
  const head = h('div', { class: 'tr-modal-head' },
    h('div', { class: 'tr-modal-title' }, '全部切换效果'),
    h('div', { class: 'tr-modal-sub' }, '点击任意效果：应用到当前页并完整预览'),
    h('span', { class: 'tr-modal-grow' }),
    h('button', { type: 'button', class: 'icon-btn tr-modal-close', 'aria-label': '关闭' }, ic('close', 16)));
  const body = h('div', { class: 'tr-modal-body' });
  const byName = new Map(TRANSITIONS.map((t) => [t.name, t]));
  for (const group of GROUPS) {
    const grid = h('div', { class: 'tr-modal-grid' });
    for (const name of group.names) {
      const meta = byName.get(name);
      if (!meta) continue;
      const card = h('button', { type: 'button', class: 'tr-modal-card' },
        h('div', { class: 'tr-modal-card-top' },
          h('strong', {}, meta.label),
          h('span', { class: 'tr-modal-name' }, meta.name)),
        h('span', { class: 'tr-modal-desc' }, meta.desc),
        h('span', { class: 'tr-modal-go' }, '点击应用 + 完整预览'));
      card.addEventListener('click', async () => {
        const index = currentSlideIndex();
        if (deckIsRaw()) {
          closeAllTransitions();
          toast('切换由网页本身控制，已按原稿真实速度预览；可用「转场」叠加屏闪/飞入', 'info', 2200);
          previewCurrent();
          return;
        }
        const r = await applyTransition(meta.name, index);
        if (r && r.ok) {
          closeAllTransitions();
          previewCurrent(meta.name, index);
        }
      });
      grid.append(card);
    }
    body.append(h('div', { class: 'tr-modal-group' },
      h('div', { class: 'tr-modal-group-label' }, group.label),
      grid));
  }
  panel.append(head, body);
  overlay.append(panel);
  document.body.append(overlay);
  ui.modalEl = overlay;
  const onKey = (e) => { if (e.key === 'Escape') { closeAllTransitions(); document.removeEventListener('keydown', onKey, true); } };
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closeAllTransitions(); });
  head.querySelector('.tr-modal-close').addEventListener('click', closeAllTransitions);
  setTimeout(() => document.addEventListener('keydown', onKey, true), 0);
}

function buildToolbar() {
  const curValue = h('span', { class: 'wpx-cur-value ellipsis' }, '淡入淡出');
  const curTag = h('span', { class: 'wpx-cur-tag' }, '第 1 页');
  const cur = h('div', { class: 'wpx-cur', 'data-tip': '本页当前切换效果' }, curValue, curTag);

  const durSel = h('select', { class: 'input wpx-select', 'data-act': 'duration' },
    ...DURATIONS.map((d) => h('option', { value: String(d) }, d + ' ms')));
  durSel.value = String(ui.duration);
  on(durSel, 'change', () => setDuration(Number(durSel.value)));

  const applyAll = h('button', {
    class: 'btn btn--sm', type: 'button', 'data-act': 'applyAll', 'data-tip': '把当前切换与时长应用到全部页面',
  }, ic('layers', 14), h('span', {}, '应用到全部'));
  on(applyAll, 'click', () => applyToAll());

  const previewBtn = h('button', {
    class: 'btn btn--sm btn--primary', type: 'button', 'data-act': 'preview', 'data-tip': '在画布内以真实速度完整播放一次切换',
  }, ic('play', 14), h('span', {}, '完整预览'));
  on(previewBtn, 'click', () => previewCurrent());

  const allBtn = h('button', {
    class: 'btn btn--sm', type: 'button', 'data-act': 'all', 'data-tip': '打开全部切换效果（网格，一次看全）',
  }, ic('grid', 14), h('span', {}, '全部效果'));
  on(allBtn, 'click', () => openAllTransitions());

  const clickInput = h('input', { type: 'checkbox', 'data-act': 'clickAdvance' });
  clickInput.checked = ui.clickAdvance;
  on(clickInput, 'change', () => setClickAdvance(clickInput.checked));
  const clickSwitch = h('label', {
    class: 'switch wpx-loop', 'data-tip': '放映时单击画面推进到下一页（需运行时支持）',
  }, clickInput, h('i'));

  const mouseSel = h('select', { class: 'input wpx-select', 'data-act': 'mouseMode', 'data-tip': '放映时左键的行为（右键始终是自定义菜单）' },
    h('option', { value: 'advance' }, '点击翻页'),
    h('option', { value: 'anim' }, '只播动画'),
    h('option', { value: 'off' }, '不响应'));
  mouseSel.value = ui.mouseMode || 'advance';
  on(mouseSel, 'change', () => setMouseMode(mouseSel.value));

  const fxSel = h('select', { class: 'input wpx-select', 'data-act': 'fx', 'data-tip': '转场叠加：在切换瞬间叠一层屏闪/飞入/扫光，不替代原切换' },
    ...FX_LIST.map(([v, label]) => h('option', { value: v }, v === 'none' ? '叠加：无' : '叠加：' + label)));
  fxSel.value = 'none';
  on(fxSel, 'change', () => setTransitionFx(fxSel.value));

  return h('div', { class: 'wpx-tab-bar' },
    cur,
    h('span', { class: 'wpx-sep' }),
    h('label', { class: 'wpx-field' }, h('span', { class: 'wpx-field-label' }, '时长'),
      h('span', { class: 'wpx-unit-group' }, durSel)),
    h('label', { class: 'wpx-field wpx-field--switch' },
      h('span', { class: 'wpx-field-label' }, '左键'), mouseSel),
    h('span', { class: 'wpx-sep' }),
    h('label', { class: 'wpx-field' }, h('span', { class: 'wpx-field-label' }, '转场'), h('span', { class: 'wpx-unit-group' }, fxSel)),
    h('span', { class: 'wpx-grow' }),
    h('span', { class: 'wpx-hint muted' }, '点击卡片应用并完整预览'),
    allBtn,
    previewBtn,
    applyAll);
}

function buildTab(container) {
  container.classList.add('wpx-tabhost');
  container.replaceChildren();
  container.append(h('div', { class: 'wpx-tab wpx-tab--trans' },
    buildToolbar(),
    h('div', { class: 'wpx-tab-gallery wpx-tab-gallery--trans' }, buildGallery())));
  ui.root = container.querySelector('.wpx-tab');
  refreshToolbar();
  loadFlags();
}

/* ---------- 命令注册 ---------- */
function registerCommands(context) {
  const reg = (name, fn, meta) => context.bus.registerCommand(name, fn, meta);

  reg('slide.setTransition', async (payload = {}) => {
    const name = payload.name || payload.transition;
    if (!name) {
      setActiveTab();
      toast('请在切换画廊中选择一个效果', 'info');
      return { ok: false, error: '缺少切换名 name' };
    }
    const index = Number.isInteger(payload.index) ? payload.index : undefined;
    return applyTransition(name, index, { duration: payload.duration });
  }, { label: '设置页面切换', group: '切换', icon: 'film', payload: '{name, index?, duration?}' });

  reg('deck.setMouseMode', async (payload = {}) => setMouseMode(payload.mode || payload.value), {
    label: '放映左键行为', group: '放映', icon: 'mouse-pointer', payload: '{mode: advance|anim|off}',
  });

  reg('deck.setTransitionFx', async (payload = {}) => setTransitionFx(payload.fx || 'none'), {
    label: '转场叠加特效', group: '切换', icon: 'zap', payload: '{fx: flash|black|color|fly|sweep|bars|none, all?}',
  });

  reg('slide.applyTransitionAll', async (payload = {}) => {
    if (payload.name || payload.transition) {
      const name = payload.name || payload.transition;
      const meta = transitionMeta(name);
      if (!meta) return { ok: false, error: '未知切换名: ' + name };
      if (Number(payload.duration) > 0) ui.duration = Number(payload.duration);
      ui.currentName = name;
    }
    return applyToAll();
  }, { label: '切换应用到全部', group: '切换', icon: 'layers', payload: '{name?, duration?}' });
}

/* ---------- 事件订阅 ---------- */
function subscribe(context) {
  context.bus.on('slide:change', () => { refreshToolbar(); if (!ui.flagsLoaded) loadFlags(); });
  context.bus.on('deck:ready', () => { refreshToolbar(); loadFlags(true); });
  context.bus.on('project:close', () => {
    ui.currentName = '';
    ui.durations = {};
    ui.flagsLoaded = false;
  });
  context.bus.on('history:change', () => refreshToolbar());
}

/* ---------- 注册 Ribbon 标签 ---------- */
function tryRegisterTab(context) {
  const ribbon = context.ribbon;
  if (!ribbon || typeof ribbon.registerTab !== 'function') return false;
  try {
    ribbon.registerTab(TAB_ID, {
      label: '切换',
      order: TAB_ORDER,
      icon: 'film',
      render: (container) => buildTab(container),
    });
    return true;
  } catch (err) {
    console.warn('[transitions] registerTab 失败', err);
    return false;
  }
}

function registerTab(context) {
  if (tryRegisterTab(context)) return;
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tryRegisterTab(context) || tries > 100) clearInterval(timer);
  }, 120);
  context.bus.on('app:ready', () => {
    if (tryRegisterTab(context)) clearInterval(timer);
  });
}

/* ---------- 入口 ---------- */
export async function init(context) {
  if (ui.ctx) return;
  ui.ctx = context;
  registerCommands(context);
  subscribe(context);
  registerTab(context);
}

export { TRANSITIONS };
export default { init };
