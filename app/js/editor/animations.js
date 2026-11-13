/* 动效面板：Ribbon「动画」标签 + 动画窗格 + 动效相关命令
   契约：docs/SPEC.md §4 / §6.3 / §8.2 / §14
   预设由 window.WPX_FX / window.WPX_FX_CATALOG 提供（editor/fx-presets.js）。 */

import { h, on, sleep } from '../core/dom.js';
import { icon } from '../ui/icons.js';

/* ---------- 常量 ---------- */
const TAB_ID = 'animations';
const TAB_ORDER = 50;

const EASING_OPTIONS = [
  { id: 'expo', label: '指数缓出' },
  { id: 'smooth', label: '平滑' },
  { id: 'inOut', label: '缓入缓出' },
  { id: 'back', label: '回弹过冲' },
  { id: 'spring', label: '弹簧' },
  { id: 'linear', label: '线性' },
  { id: 'steps', label: '阶梯' },
];

const TRIGGER_OPTIONS = [
  { id: 'click', label: '单击时' },
  { id: 'auto', label: '与上一动画同时' },
  { id: 'after', label: '上一动画之后' },
];

const TRIGGER_CHIP = { click: '单击', auto: '同时', after: '之后' };
const CAT_LABEL = { text: '文字', shape: '形状', loop: '循环', emphasis: '强调', exit: '退场' };
const CAT_ICON = { text: 'type', shape: 'shapes', loop: 'refresh', emphasis: 'sparkles', exit: 'send' };

/** fx-presets 尚未加载时的兜底目录（名称严格按 SPEC §4，不新增） */
const FALLBACK_CATS = [
  { id: 'text', names: ['fadeIn', 'fadeUp', 'fadeDown', 'slideInLeft', 'slideInRight', 'zoomIn', 'zoomOutIn',
    'blurIn', 'springPop', 'rotateIn', 'flipInX', 'clipUp', 'clipWipe', 'charDrop', 'charStagger',
    'typewriter', 'trackingIn', 'strokeFill', 'lineMask', 'blockReveal'] },
  { id: 'shape', names: ['shapeSpring', 'shapeRotate', 'shapeWipe', 'shapeFlip', 'shapeBounce'] },
  { id: 'loop', names: ['pulse', 'breathe', 'shake', 'swing', 'floatY', 'marqueeX', 'hueFlow', 'glowPulse'] },
  { id: 'emphasis', names: ['underlineGrow', 'sweepLight', 'glitch', 'colorPop'] },
  { id: 'exit', names: ['fadeOut', 'flyOut', 'zoomOut'] },
];

const FALLBACK_LABEL = {
  fadeIn: '淡入', fadeUp: '上浮淡入', fadeDown: '下落淡入', slideInLeft: '左侧滑入', slideInRight: '右侧滑入',
  zoomIn: '放大进入', zoomOutIn: '由大到小进入', blurIn: '模糊成像', springPop: '弹簧弹入', rotateIn: '旋转进入',
  flipInX: '翻转进入', clipUp: '遮罩上推', clipWipe: '擦除揭示', charDrop: '逐字下落', charStagger: '逐字错峰',
  typewriter: '打字机', trackingIn: '字距收拢', strokeFill: '描边转实心', lineMask: '遮罩升行', blockReveal: '色块揭示',
  shapeSpring: '形状弹入', shapeRotate: '形状旋转', shapeWipe: '形状擦除', shapeFlip: '形状翻面', shapeBounce: '形状弹跳',
  pulse: '脉冲', breathe: '呼吸', shake: '抖动', swing: '摇摆', floatY: '上下漂浮', marqueeX: '横向跑马灯',
  hueFlow: '色相流动', glowPulse: '光晕呼吸', underlineGrow: '下划线展开', sweepLight: '扫光', glitch: '故障闪烁',
  colorPop: '变色强调', fadeOut: '淡出', flyOut: '飞出', zoomOut: '缩小退场',
};

/** 迷你舞台里的预览参数：缩小位移、缩短时长，避免卡片里过冲 */
const MINI_PARAMS = { duration: 780, stagger: 45, distance: 12, intensity: 1, loop: false };

const DEFAULT_PARAMS = { duration: 900, delay: 0, easing: 'expo', trigger: 'auto', loop: false };

/* ---------- 模块状态 ---------- */
const ui = {
  ctx: null,
  root: null,
  row: null,
  cat: 'all',
  defaults: { ...DEFAULT_PARAMS },
  cards: [],
  hoverCard: null,
  hoverTimer: null,
  previewToken: 0,
  previewHandle: null,
  controls: null,
  pane: null,
  paneList: null,
  paneCount: null,
  paneBtn: null,
  paneOpen: false,
  paneItems: [],
  paneLoading: false,
  paneTimer: null,
  outsideHandler: null,
  escHandler: null,
};

/* ---------- 基础工具 ---------- */
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

function getSelection() {
  const st = getState();
  return (st && st.selection) || null;
}

function getCurrentSlide() {
  const st = getState();
  return st && st.deck ? st.deck.current : 0;
}

function bridge() {
  try { return ctx().getEditor()?.bridge || null; } catch { return null; }
}

/** 统一 bridge 调用：兼容 bridge.method(params) 与 bridge.call(method, params) 两种封装 */
async function callBridge(method, params = {}) {
  const b = bridge();
  if (!b) return null;
  try {
    // 优先走原始 RPC：bridge.call(method, params) 的 params 与桥协议一一对应
    // （bridge-client 的便捷方法多为位置参数，传对象会二次包装）
    if (typeof b.call === 'function') return await b.call(method, params);
    if (typeof b.request === 'function') return await b.request(method, params);
    if (typeof b.invoke === 'function') return await b.invoke(method, params);
    if (typeof b[method] === 'function') return await b[method](params);
  } catch (err) {
    console.warn('[animations] bridge.' + method + ' 失败 params=' + JSON.stringify(params), err);
  }
  return null;
}

/** 画布是否已就绪（避免 deck 重载间隙调用 bridge） */
function deckReady() {
  const st = getState();
  return !!(st && st.deck && st.deck.ready);
}

function setActiveTab() {
  try { ctx().ribbon?.setActiveTab?.(TAB_ID); } catch { /* ignore */ }
  try {
    ctx().store.update((s) => { s.ui.activeTab = TAB_ID; });
  } catch { /* ignore */ }
}

/* ---------- 预设目录 ---------- */
function presetLabel(name) {
  const fx = window.WPX_FX && window.WPX_FX[name];
  return (fx && fx.label) || FALLBACK_LABEL[name] || name;
}

function normalizeCatalogItem(item, cat) {
  const name = item.name || item.id;
  if (!name) return null;
  return {
    name,
    label: item.label || presetLabel(name),
    desc: item.desc || '',
    params: item.params || {},
    cat: cat || item.cat || 'text',
  };
}

function getCatalog() {
  const raw = window.WPX_FX_CATALOG;
  if (Array.isArray(raw) && raw.length) {
    const cats = raw
      .map((c) => {
        const items = Array.isArray(c.items) ? c.items.map((it) => normalizeCatalogItem(it, c.id)) : [];
        return { id: c.id, label: c.label || CAT_LABEL[c.id] || c.id, items: items.filter(Boolean) };
      })
      .filter((c) => c.items.length);
    if (cats.length) return cats;
  }
  return FALLBACK_CATS.map((c) => ({
    id: c.id,
    label: CAT_LABEL[c.id] || c.id,
    items: c.names.map((name) => ({ name, label: presetLabel(name), desc: '', params: {}, cat: c.id })),
  }));
}

/* ---------- 应用 / 移除 / 预览 ---------- */
function collectParams(extra) {
  const params = { ...ui.defaults, ...(extra || {}) };
  Object.keys(params).forEach((k) => { if (params[k] === undefined || params[k] === null) delete params[k]; });
  return params;
}

async function applyAnimation(name, extraParams, elementId) {
  const target = elementId || getSelection()?.elementId;
  if (!target) {
    toast('请先选中一个元素', 'warn');
    return { ok: false, error: '未选中元素' };
  }
  if (!deckReady()) {
    toast('画布还没就绪，请稍后再试', 'warn', 1600);
    return { ok: false, error: '画布未就绪' };
  }
  const base = (window.WPX_FX && window.WPX_FX[name] && window.WPX_FX[name].params) || {};
  const params = collectParams({ ...base, ...(extraParams || {}) });
  const res = await callBridge('setAnimation', { elementId: target, anim: { name, params } });
  toast('已应用「' + presetLabel(name) + '」', 'ok', 1400);
  refreshToolbar();
  schedulePaneRefresh();
  // 应用后立即在画布上预览一次，便于确认效果
  callBridge('previewAnimation', { elementId: target });
  return { ok: true, op: res && res.op, elementId: target, name, params };
}

async function removeAnimation(elementId) {
  const target = elementId || getSelection()?.elementId;
  if (!target) {
    toast('请先选中一个元素', 'warn');
    return { ok: false, error: '未选中元素' };
  }
  await callBridge('setAnimation', { elementId: target, anim: null });
  toast('已移除动画', 'ok', 1400);
  refreshToolbar();
  schedulePaneRefresh();
  return { ok: true };
}

async function previewAnimation(elementId) {
  const target = elementId || getSelection()?.elementId;
  if (!target) {
    toast('请先选中一个元素', 'warn');
    return { ok: false, error: '未选中元素' };
  }
  await callBridge('previewAnimation', { elementId: target });
  return { ok: true };
}

async function previewSlide(index) {
  const i = Number.isInteger(index) ? index : getCurrentSlide();
  const res = await callBridge('previewAnimation', index == null ? {} : { index: i });
  if (res == null) {
    // 兜底：直接驱动 iframe 内运行时重播
    try {
      const win = ctx().getEditor()?.iframe?.contentWindow;
      win?.__WPX__?.replay?.();
    } catch { /* 跨域/未就绪时忽略 */ }
  }
  toast('预览当前页动画', 'info', 1200);
  return { ok: true };
}

async function selectElement(elementId) {
  if (!elementId) return;
  const b = bridge();
  if (b && typeof b.call === 'function') {
    try { await b.call('select', { elementId }); return; } catch (err) { console.warn('[animations] select 失败', err); }
  }
  if (b && typeof b.select === 'function') {
    try { await b.select(elementId); return; } catch (err) { console.warn('[animations] select 失败', err); }
  }
  try { await ctx().bus.runCommand('slide.select', { elementId }); } catch { /* ignore */ }
}

/* ---------- 顶部工具条 ---------- */
function buildSelect(options, value, onchange, extraClass = '') {
  const sel = h('select', { class: 'input wpx-select ' + extraClass },
    ...options.map((o) => h('option', { value: o.id }, o.label)));
  sel.value = value;
  on(sel, 'change', () => onchange(sel.value));
  return sel;
}

function buildNumberInput(value, min, max, step, onchange) {
  const input = h('input', { class: 'input wpx-num', type: 'number', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  on(input, 'change', () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = value;
    v = Math.min(max, Math.max(min, Math.round(v)));
    input.value = String(v);
    onchange(v);
  });
  return input;
}

function field(label, control) {
  return h('label', { class: 'wpx-field' }, h('span', { class: 'wpx-field-label' }, label), control);
}

/** 用户改参数：有选中动画则立刻写回 bridge，否则只更新下次应用的默认值 */
async function onParamsChanged(patch, opts = {}) {
  Object.assign(ui.defaults, patch);
  const sel = getSelection();
  const anim = sel && sel.animation && sel.animation.name ? sel.animation : null;
  if (sel && anim) {
    const params = collectParams({ ...(anim.params || {}), ...patch });
    await callBridge('setAnimation', { elementId: sel.elementId, anim: { name: anim.name, params } });
    schedulePaneRefresh();
    if (opts.silent !== true) {
      const key = Object.keys(patch)[0];
      const text = key === 'trigger' ? '开始方式：' + (TRIGGER_OPTIONS.find((t) => t.id === patch.trigger)?.label || patch.trigger)
        : key === 'loop' ? (patch.loop ? '已开启循环' : '已关闭循环')
          : '动画参数已更新';
      toast(text, 'ok', 1100);
    }
  }
  refreshToolbar();
}

function syncControls(values) {
  const c = ui.controls;
  if (!c) return;
  const active = document.activeElement;
  if (c.trigger && active !== c.trigger) c.trigger.value = values.trigger || 'auto';
  if (c.easing && active !== c.easing) c.easing.value = values.easing || 'expo';
  if (c.duration && active !== c.duration) c.duration.value = String(values.duration || 900);
  if (c.delay && active !== c.delay) c.delay.value = String(values.delay || 0);
  if (c.loop && active !== c.loop) c.loop.checked = !!values.loop;
}

function refreshToolbar() {
  if (!ui.root) return;
  const sel = getSelection();
  const anim = sel && sel.animation && sel.animation.name ? sel.animation : null;
  const valueEl = ui.root.querySelector('.wpx-cur-value');
  if (valueEl) {
    valueEl.textContent = anim ? presetLabel(anim.name) : (sel ? '无动画' : '未选中元素');
    valueEl.classList.toggle('is-empty', !anim);
    valueEl.classList.toggle('is-none', !!sel && !anim);
  }
  const tagEl = ui.root.querySelector('.wpx-cur-tag');
  if (tagEl) tagEl.style.display = anim ? '' : 'none';
  const previewBtn = ui.root.querySelector('[data-act="preview"]');
  const removeBtn = ui.root.querySelector('[data-act="remove"]');
  if (previewBtn) previewBtn.disabled = !sel;
  if (removeBtn) removeBtn.disabled = !sel || !anim;
  syncControls({ ...ui.defaults, ...((anim && anim.params) || {}) });
}

function buildToolbar() {
  const curValue = h('span', { class: 'wpx-cur-value ellipsis' }, '未选中元素');
  const curTag = h('span', { class: 'wpx-cur-tag' }, '动画');
  const cur = h('div', {
    class: 'wpx-cur',
    'data-tip': '当前选中元素的动画',
  }, curValue, curTag);

  const previewBtn = h('button', {
    class: 'icon-btn', type: 'button', 'data-act': 'preview', 'data-tip': '预览选中元素动画',
    html: icon('play-circle', 17),
    onclick: () => previewAnimation(),
  });

  const removeBtn = h('button', {
    class: 'icon-btn', type: 'button', 'data-act': 'remove', 'data-tip': '移除选中元素动画',
    html: icon('x-circle', 17),
    onclick: () => removeAnimation(),
  });

  const triggerSelect = buildSelect(TRIGGER_OPTIONS, ui.defaults.trigger, (v) => onParamsChanged({ trigger: v }), 'wpx-select--wide');

  const durationInput = buildNumberInput(ui.defaults.duration, 100, 8000, 100, (v) => onParamsChanged({ duration: v }, { silent: v !== ui.defaults.duration }));
  const delayInput = buildNumberInput(ui.defaults.delay, 0, 5000, 50, (v) => onParamsChanged({ delay: v }));
  const easingSelect = buildSelect(EASING_OPTIONS, ui.defaults.easing, (v) => onParamsChanged({ easing: v }));

  const loopInput = h('input', { type: 'checkbox' });
  loopInput.checked = !!ui.defaults.loop;
  on(loopInput, 'change', () => onParamsChanged({ loop: loopInput.checked }));
  const loopSwitch = h('label', { class: 'switch wpx-loop', 'data-tip': '循环播放（强调/循环类动效）' }, loopInput, h('i'));

  const paneBtn = h('button', {
    class: 'btn btn--sm wpx-pane-btn', type: 'button', 'data-act': 'pane', 'data-tip': '打开动画窗格（当前页全部动画）',
  }, ic('layers', 14), h('span', {}, '动画窗格'));
  ui.paneBtn = paneBtn;
  on(paneBtn, 'click', () => togglePane());

  ui.controls = { trigger: triggerSelect, duration: durationInput, delay: delayInput, easing: easingSelect, loop: loopInput };

  const bar = h('div', { class: 'wpx-tab-bar wpx-tab-bar--anim' },
    cur,
    h('div', { class: 'wpx-tab-btns' }, previewBtn, removeBtn),
    h('span', { class: 'wpx-sep' }),
    field('开始', triggerSelect),
    field('时长', h('span', { class: 'wpx-unit-group' }, durationInput, h('span', { class: 'wpx-unit' }, 'ms'))),
    field('延迟', h('span', { class: 'wpx-unit-group' }, delayInput, h('span', { class: 'wpx-unit' }, 'ms'))),
    field('缓动', easingSelect),
    h('label', { class: 'wpx-field wpx-field--switch' }, h('span', { class: 'wpx-field-label' }, '循环'), loopSwitch),
    h('span', { class: 'wpx-grow' }),
    paneBtn,
  );
  return bar;
}

/* ---------- 动效库 ---------- */
function buildCard(item) {
  const isShape = item.cat === 'shape';
  const demo = h('div', {
    class: 'fx-mini-el ' + (isShape ? 'fx-mini-el--shape' : 'fx-mini-el--text'),
  });
  if (!isShape) demo.textContent = 'Aa';
  const stage = h('div', { class: 'fx-mini' }, demo);
  const labelEl = h('div', { class: 'fx-card-label ellipsis' }, item.label);
  const card = h('button', {
    class: 'fx-card', type: 'button', 'data-fx': item.name, 'data-cat': item.cat,
    'data-tip': item.desc ? item.label + ' · ' + item.desc : item.label,
    title: item.name,
  }, stage, labelEl);
  card._fx = item;
  return card;
}

function renderCards() {
  if (!ui.row) return;
  stopPreview();
  ui.cards = [];
  const cats = getCatalog();
  const visible = ui.cat === 'all' ? cats : cats.filter((c) => c.id === ui.cat);
  ui.row.replaceChildren();
  for (const cat of visible) {
    if (!cat.items.length) continue;
    if (ui.cat === 'all') {
      ui.row.append(h('div', { class: 'fx-row-cat' }, h('span', { class: 'fx-row-cat-label' }, cat.label), h('span', { class: 'fx-row-cat-line' })));
    }
    for (const item of cat.items) {
      const card = buildCard(item);
      ui.cards.push(card);
      ui.row.append(card);
    }
  }
  if (!ui.cards.length) ui.row.append(h('div', { class: 'fx-row-empty muted' }, '没有可用的动效预设'));
}

function renderCats() {
  const cats = getCatalog();
  const wrap = ui.root && ui.root.querySelector('.wpx-cats');
  if (!wrap) return;
  wrap.replaceChildren();
  const all = [{ id: 'all', label: '全部' }, ...cats.map((c) => ({ id: c.id, label: c.label }))];
  for (const c of all) {
    const btn = h('button', {
      class: 'wpx-cat' + (ui.cat === c.id ? ' is-active' : ''),
      type: 'button',
      'data-cat': c.id,
      'data-tip': c.id === 'all' ? '全部动效预设' : CAT_LABEL[c.id] || c.label,
    }, c.id === 'all' ? '全部' : (CAT_LABEL[c.id] || c.label));
    if (c.id !== 'all' && CAT_ICON[c.id]) btn.prepend(ic(CAT_ICON[c.id], 13));
    on(btn, 'click', () => {
      ui.cat = c.id;
      wrap.querySelectorAll('.wpx-cat').forEach((n) => n.classList.toggle('is-active', n.dataset.cat === c.id));
      renderCards();
    });
    wrap.append(btn);
  }
}

/* ---------- 悬停预览 ---------- */
function stopPreview() {
  ui.previewToken += 1;
  if (ui.previewHandle) {
    try { ui.previewHandle.cancel(); } catch { /* ignore */ }
    ui.previewHandle = null;
  }
  if (ui.hoverCard) ui.hoverCard.classList.remove('is-playing', 'is-static');
}

function clearHover() {
  clearTimeout(ui.hoverTimer);
  ui.hoverTimer = null;
  stopPreview();
  ui.hoverCard = null;
}

function playPreview(card) {
  stopPreview();
  const name = card.dataset.fx;
  const fx = window.WPX_FX && window.WPX_FX[name];
  const demo = card.querySelector('.fx-mini-el');
  if (!fx || typeof fx.play !== 'function' || !demo) {
    card.classList.add('is-static');
    return;
  }
  const token = ++ui.previewToken;
  card.classList.add('is-playing');
  const params = { ...(card._fx?.params || {}), ...MINI_PARAMS };
  const loopPlay = async () => {
    while (token === ui.previewToken && card.isConnected) {
      let handle = null;
      try {
        handle = fx.play(demo, params, { instant: false, editing: false });
      } catch (err) {
        console.warn('[animations] 预览播放失败：' + name, err);
        break;
      }
      if (!handle) break;
      ui.previewHandle = handle;
      if (handle.finished) {
        try { await handle.finished; } catch { break; }
      } else break;
      if (token !== ui.previewToken || !card.isConnected) break;
      await sleep(420);
    }
    card.classList.remove('is-playing');
  };
  loopPlay();
}

function schedulePreview(card) {
  clearTimeout(ui.hoverTimer);
  ui.hoverCard = card;
  ui.hoverTimer = setTimeout(() => {
    if (ui.hoverCard === card) playPreview(card);
  }, 300);
}

/* ---------- 动画窗格 ---------- */
function buildPane() {
  if (ui.pane) return ui.pane;
  ui.paneList = h('div', { class: 'anim-pane-list' });
  ui.paneCount = h('span', { class: 'muted' }, '');
  const closeBtn = h('button', {
    class: 'icon-btn icon-btn--sm', type: 'button', 'data-tip': '关闭动画窗格',
    html: icon('x', 14), onclick: () => togglePane(false),
  });
  const previewAll = h('button', {
    class: 'btn btn--sm', type: 'button', 'data-tip': '按顺序预览当前页全部动画',
    onclick: () => previewSlide(),
  }, ic('play', 14), h('span', {}, '全部预览'));
  ui.pane = h('div', { class: 'anim-pane', role: 'dialog', 'aria-label': '动画窗格' },
    h('div', { class: 'anim-pane-head' },
      h('span', { class: 'anim-pane-title' }, '动画窗格'),
      h('span', { class: 'badge badge--muted' }, '当前页'),
      h('span', { class: 'wpx-grow' }),
      closeBtn),
    ui.paneList,
    h('div', { class: 'anim-pane-foot' },
      previewAll,
      h('span', { class: 'wpx-grow' }),
      ui.paneCount));
  (document.getElementById('overlay-root') || document.body).append(ui.pane);
  return ui.pane;
}

function positionPane() {
  if (!ui.pane || !ui.paneBtn) return;
  const rect = ui.paneBtn.getBoundingClientRect();
  const width = ui.pane.offsetWidth || 348;
  const height = ui.pane.offsetHeight || 320;
  let left = Math.min(rect.left, window.innerWidth - width - 12);
  left = Math.max(10, left);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 8);
  ui.pane.style.left = left + 'px';
  ui.pane.style.top = top + 'px';
}

function togglePane(force) {
  const open = typeof force === 'boolean' ? force : !ui.paneOpen;
  if (open === ui.paneOpen) return;
  ui.paneOpen = open;
  ui.paneBtn?.classList.toggle('is-active', open);
  if (open) {
    buildPane();
    ui.pane.classList.add('is-open');
    positionPane();
    refreshPane(true);
    const onOutside = (e) => {
      if (!ui.pane) return;
      if (ui.pane.contains(e.target)) return;
      if (ui.paneBtn && ui.paneBtn.contains(e.target)) return;
      togglePane(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') togglePane(false); };
    ui.outsideHandler = onOutside;
    ui.escHandler = onEsc;
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  } else {
    ui.pane?.classList.remove('is-open');
    if (ui.outsideHandler) document.removeEventListener('pointerdown', ui.outsideHandler, true);
    if (ui.escHandler) document.removeEventListener('keydown', ui.escHandler, true);
    ui.outsideHandler = null;
    ui.escHandler = null;
  }
}

function triggerLabel(id) {
  const t = TRIGGER_OPTIONS.find((x) => x.id === id);
  return t ? t.label : id;
}

function normalizeAnimItem(raw) {
  if (!raw) return null;
  const name = raw.name || (raw.anim && raw.anim.name) || '';
  if (!name) return null;
  const params = raw.params || (raw.anim && raw.anim.params) || {};
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim();
  const rect = raw.rect || null;
  const summary = text
    ? (text.length > 20 ? text.slice(0, 20) + '…' : text)
    : rect ? Math.round(rect.w || 0) + '×' + Math.round(rect.h || 0) : '元素 ' + (raw.elementId || '');
  return {
    elementId: raw.elementId || raw.el || raw.id || '',
    name,
    label: raw.label || presetLabel(name),
    params,
    trigger: raw.trigger || params.trigger || 'auto',
    duration: Number(raw.duration || params.duration || 900),
    delay: Number(raw.delay || params.delay || 0),
    rect,
    text,
    summary,
  };
}

/** bridge.getSlideAnimations 不可用时的兜底：用 getSlideHtml 解析 data-wpx-anim */
async function fallbackSlideAnimations(index) {
  const res = await callBridge('getSlideHtml', { index });
  const html = typeof res === 'string' ? res : (res && res.html) || '';
  if (!html) return [];
  let doc = null;
  try {
    doc = new DOMParser().parseFromString('<div id="wpx-root">' + html + '</div>', 'text/html');
  } catch { return []; }
  const nodes = [...doc.querySelectorAll('[data-wpx-el]')].filter((n) => n.getAttribute('data-wpx-anim'));
  return nodes.map((n) => {
    let params = {};
    try { params = JSON.parse(n.getAttribute('data-wpx-anim-params') || '{}'); } catch { /* ignore */ }
    return {
      elementId: n.getAttribute('data-wpx-el'),
      name: n.getAttribute('data-wpx-anim'),
      params,
      rect: {
        x: parseFloat(n.style.left) || 0,
        y: parseFloat(n.style.top) || 0,
        w: parseFloat(n.style.width) || 0,
        h: parseFloat(n.style.height) || 0,
      },
      text: (n.textContent || '').trim().slice(0, 200),
    };
  });
}

async function loadSlideAnimations() {
  const index = getCurrentSlide();
  let raw = null;
  const res = await callBridge('getSlideAnimations', { index });
  if (Array.isArray(res)) raw = res;
  else if (res && Array.isArray(res.animations)) raw = res.animations;
  else if (res && Array.isArray(res.list)) raw = res.list;
  if (!raw) raw = await fallbackSlideAnimations(index);
  return raw.map(normalizeAnimItem).filter(Boolean);
}

function buildPaneRow(item, i) {
  const row = h('div', {
    class: 'anim-row',
    'data-el': item.elementId,
    'data-anim': item.name,
    'data-tip': (item.text || item.summary) + '\n' + triggerLabel(item.trigger) + ' · ' + item.duration + 'ms',
  },
  h('span', { class: 'anim-row-no' }, String(i + 1).padStart(2, '0')),
  h('span', { class: 'anim-row-main' },
    h('span', { class: 'anim-row-name ellipsis' }, item.label),
    h('span', { class: 'anim-row-sub ellipsis' }, item.summary || item.elementId)),
  h('span', { class: 'anim-row-meta' },
    h('span', { class: 'badge anim-row-chip' }, TRIGGER_CHIP[item.trigger] || item.trigger),
    h('span', { class: 'anim-row-dur' }, item.duration + 'ms')),
  h('button', {
    class: 'icon-btn icon-btn--sm anim-row-del', type: 'button', 'data-tip': '移除该动画',
    html: icon('trash', 13),
    onclick: (e) => { e.stopPropagation(); removeAnimation(item.elementId); },
  }));
  on(row, 'click', () => selectElement(item.elementId));
  return row;
}

function renderPaneList() {
  if (!ui.paneList) return;
  ui.paneList.replaceChildren();
  if (ui.paneLoading && !ui.paneItems.length) {
    ui.paneList.append(h('div', { class: 'anim-pane-empty muted' }, '正在读取当前页动画…'));
    return;
  }
  if (!ui.paneItems.length) {
    ui.paneList.append(h('div', { class: 'anim-pane-empty' },
      h('div', { class: 'anim-pane-empty-title' }, '当前页还没有动画'),
      h('div', { class: 'muted' }, '在下方动效库点选一个预设，即可添加到选中元素')));
    return;
  }
  ui.paneItems.forEach((item, i) => ui.paneList.append(buildPaneRow(item, i)));
  highlightPaneRow();
}

function highlightPaneRow() {
  if (!ui.paneList) return;
  const sel = getSelection();
  const id = sel && sel.elementId;
  ui.paneList.querySelectorAll('.anim-row').forEach((row) => {
    row.classList.toggle('is-selected', !!id && row.dataset.el === id);
  });
}

async function refreshPane(force = false) {
  if (!ui.paneOpen && !force) return;
  if (!ui.paneList) return;
  ui.paneLoading = true;
  ui.paneItems = await loadSlideAnimations();
  ui.paneLoading = false;
  renderPaneList();
  if (ui.paneCount) ui.paneCount.textContent = ui.paneItems.length ? '共 ' + ui.paneItems.length + ' 个动画' : '';
  if (ui.paneOpen) positionPane();
  // 页数变化时可能撑开高度，重新定位
  if (ui.paneOpen) setTimeout(positionPane, 30);
}

function schedulePaneRefresh() {
  clearTimeout(ui.paneTimer);
  ui.paneTimer = setTimeout(() => { if (ui.paneOpen) refreshPane(true); }, 80);
}

/* ---------- Ribbon 渲染 ---------- */
function buildTab(container) {
  stopPreview();
  container.classList.add('wpx-tabhost');
  container.replaceChildren();
  const root = h('div', { class: 'wpx-tab wpx-tab--anim' });
  const bar = buildToolbar();
  const cats = h('div', { class: 'wpx-cats', role: 'tablist', 'aria-label': '动效分类' });
  ui.row = h('div', { class: 'wpx-fx-row', role: 'list', 'aria-label': '动效预设' });

  on(ui.row, 'mouseover', (e) => {
    const card = e.target.closest && e.target.closest('.fx-card');
    if (!card || !ui.row.contains(card)) return;
    if (card === ui.hoverCard) return;
    schedulePreview(card);
  });
  on(ui.row, 'mouseout', (e) => {
    const card = e.target.closest && e.target.closest('.fx-card');
    if (!card) return;
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    clearHover();
  });
  on(ui.row, 'click', (e) => {
    const card = e.target.closest && e.target.closest('.fx-card');
    if (!card) return;
    const item = card._fx;
    if (!item) return;
    clearHover();
    applyAnimation(item.name, item.params);
  });

  const gallery = h('div', { class: 'wpx-tab-gallery' }, cats, ui.row);
  root.append(bar, gallery);
  container.append(root);

  ui.root = root;
  renderCats();
  renderCards();
  refreshToolbar();
}

/* ---------- 命令注册 ---------- */
function registerCommands(context) {
  const reg = (name, fn, meta) => context.bus.registerCommand(name, fn, meta);

  reg('element.animation', async (payload = {}) => {
    const name = payload.name || (payload.anim && payload.anim.name);
    if (!name) {
      setActiveTab();
      toast('请在动效库中选择一个动画', 'info');
      return { ok: false, error: '缺少动画名 name' };
    }
    const params = (payload.anim && payload.anim.params) || payload.params || {};
    const elementId = payload.elementId || payload.el;
    return applyAnimation(name, params, elementId);
  }, { label: '添加动画', group: '动效', icon: 'sparkles', payload: '{name, params?, elementId?}' });

  reg('element.animationRemove', async (payload = {}) => {
    return removeAnimation(payload.elementId || payload.el);
  }, { label: '移除动画', group: '动效', icon: 'x-circle', payload: '{elementId?}' });

  reg('element.animationPreview', async (payload = {}) => {
    return previewAnimation(payload.elementId || payload.el);
  }, { label: '预览动画', group: '动效', icon: 'play-circle', payload: '{elementId?}' });

  reg('slide.previewAnimation', async (payload = {}) => {
    return previewSlide(payload.index);
  }, { label: '预览本页动画', group: '动效', icon: 'play-circle', payload: '{index?}' });
}

/* ---------- 事件订阅 ---------- */
function subscribe(context) {
  context.bus.on('selection:change', () => {
    refreshToolbar();
    highlightPaneRow();
  });
  context.bus.on('slide:change', () => {
    refreshToolbar();
    schedulePaneRefresh();
  });
  context.bus.on('deck:ready', () => {
    refreshToolbar();
    schedulePaneRefresh();
  });
  context.bus.on('history:change', schedulePaneRefresh);
  context.bus.on('project:close', () => {
    ui.paneItems = [];
    togglePane(false);
    refreshToolbar();
  });
  // 面板可能被拖拽/缩放影响，窗口尺寸变化时重新定位
  window.addEventListener('resize', () => { if (ui.paneOpen) positionPane(); });
}

/* ---------- 注册 Ribbon 标签 ---------- */
function tryRegisterTab(context) {
  const ribbon = context.ribbon;
  if (!ribbon || typeof ribbon.registerTab !== 'function') return false;
  try {
    ribbon.registerTab(TAB_ID, {
      label: '动画',
      order: TAB_ORDER,
      icon: 'sparkles',
      render: (container) => buildTab(container),
    });
    return true;
  } catch (err) {
    console.warn('[animations] registerTab 失败', err);
    return false;
  }
}

function registerTab(context) {
  if (tryRegisterTab(context)) return;
  // 降级：ui-chrome 可能比本模块晚挂载 ctx.ribbon，轮询 + 事件双保险（不改共享文件）
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

export default { init };
