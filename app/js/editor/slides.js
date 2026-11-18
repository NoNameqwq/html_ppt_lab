/* 左侧幻灯片缩略图栏：srcdoc 渲染（懒加载 + 虚拟化 ±5）、切页、拖拽排序、右键菜单 */

import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h, clamp } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { dialog } from '../core/dialog.js';
import { icon } from '../ui/icons.js';

const THUMB_W = 176;
const THUMB_H = 99;
const BUFFER = 5;
const TRANSITIONS = [
  ['fade', '淡入'],
  ['pushLeft', '左推'],
  ['zoom', '缩放'],
  ['iris', '光圈'],
  ['dissolve', '溶解'],
  ['slide', '滑动'],
];

let ctx = null;
let panel = null;
let listEl = null;
let headCount = null;
let footEl = null;
let items = [];
let thumbCache = new Map();
let lastTotal = -1;
let currentIndex = 0;
let visibleRaf = 0;
let invalidateTimer = null;
let dragState = null;
let indicator = null;
let menuEl = null;
let menuCleanup = null;
let unsubs = [];
let addBtnEl = null;

/* ================= 初始化 ================= */

export async function init(context) {
  ctx = context;
  panel = document.getElementById('slide-panel');
  if (!panel) return;
  buildPanel();
  bindEvents();
  registerCommands();
  syncFromStore();
}

function getBridge() {
  return ctx?.getEditor?.()?.bridge || null;
}

function deckState() {
  return store.get().deck;
}

/** 兼容模式（原稿直编）：不支持改页结构 / 页面属性 / 缩略图可能为空 */
function isRawMode() {
  const deck = deckState() || {};
  if (deck.raw === true || deck.mode === 'raw') return true;
  if (deck.capabilities && deck.capabilities.raw === true) return true;
  return !!(deck.capabilities && deck.capabilities.structure === false);
}

function structureBlocked() {
  if (!isRawMode()) return false;
  toast('网页结构由原稿决定，不能在这里增删页；可以复制/删除页面里的元素');
  return true;
}

function pageEditBlocked() {
  if (!isRawMode()) return false;
  toast('页面属性由网页原稿决定，不能在这里修改');
  return true;
}

function buildPanel() {
  panel.innerHTML = '';
  headCount = h('span', { class: 'slide-panel-count' }, '0');
  addBtnEl = h('button', {
    class: 'slide-add-btn',
    title: '新增幻灯片',
    html: icon('plus', 15),
    onclick: () => bus.runCommand('slide.add'),
  });
  const collapseBtn = h('button', {
    class: 'icon-btn icon-btn--sm',
    title: '收起幻灯片栏',
    html: icon('chevron-left', 15),
    onclick: () => bus.runCommand('view.slidePanel', { open: false }),
  });
  const head = h('div', { class: 'slide-panel-head' },
    h('span', { class: 'slide-panel-title' }, '幻灯片'),
    headCount,
    h('div', { class: 'grow' }),
    addBtnEl,
    collapseBtn);
  listEl = h('div', { class: 'slide-list' });
  listEl.addEventListener('scroll', scheduleVisibleRefresh, { passive: true });
  indicator = h('div', { class: 'slide-drop-line is-hidden' });
  listEl.append(indicator);
  footEl = h('div', { class: 'slide-panel-foot' },
    h('span', { class: 'slide-foot-page' }, '第 1 / 1 页'),
    h('span', { class: 'slide-foot-tip' }, '拖拽排序 · 右键菜单'));
  panel.append(head, listEl, footEl);
}

function bindEvents() {
  unsubs.push(bus.on('editor:three-ready',({index}={})=>scheduleInvalidate(index)));
  unsubs.push(bus.on('deck:change', () => syncFromStore()));
  unsubs.push(bus.on('deck:ready', () => onDeckReady()));
  unsubs.push(bus.on('slide:change', ({ index } = {}) => setCurrent(index)));
  unsubs.push(bus.on('deck:unload', () => { thumbCache.clear(); lastTotal = -1; items = []; listEl.innerHTML = ''; listEl.append(indicator); setFoot(0, 0); }));
  unsubs.push(bus.on('editor:op', ({ op } = {}) => {
    if (!op) return;
    if (['slide-add', 'slide-delete', 'slide-move', 'slide-attrs', 'slide-html'].includes(op.type)) {
      scheduleInvalidate(op.slideIndex);
    } else if (op.slideIndex != null) {
      scheduleInvalidate(op.slideIndex);
    }
  }));
  unsubs.push(bus.on('editor:layout', () => scheduleVisibleRefresh()));
  window.addEventListener('resize', scheduleVisibleRefresh);
}

/* ================= 列表同步 ================= */

function syncFromStore() {
  const deck = deckState();
  const total = Number(deck.total) || 0;
  currentIndex = Number(deck.current) || 0;
  headCount.textContent = String(total);
  applyModeUI();
  if (total !== lastTotal) {
    lastTotal = total;
    rebuild(total);
  } else {
    updateNames();
    updateActive(false);
    setFoot(currentIndex, total);
  }
}

/** 兼容模式：禁用页结构操作、页脚提示切换；空缩略图走占位卡 */
function applyModeUI() {
  const raw = isRawMode();
  if (addBtnEl) {
    addBtnEl.disabled = raw;
    addBtnEl.title = raw ? '页面结构由网页原稿决定，不能新增页' : '新增幻灯片';
  }
  panel?.classList.toggle('is-raw', raw);
  const tip = footEl?.querySelector('.slide-foot-tip');
  if (tip) tip.textContent = raw ? '网页结构由原稿决定' : '拖拽排序 · 右键菜单';
  if (raw) {
    for (const item of items) {
      if (!item.rendered && !item.loading) loadThumb(item.index);
    }
  }
}

function rebuild(total) {
  if (!listEl) return;
  listEl.querySelectorAll('.slide-item').forEach((el) => el.remove());
  items = [];
  for (let i = 0; i < total; i++) {
    const frame = h('iframe', {
      class: 'slide-thumb-frame',
      title: '第 ' + (i + 1) + ' 页',
      tabindex: '-1',
    });
    const rawPage = h('span', { class: 'slide-raw-page' }, '第 ' + (i + 1) + ' 页');
    const rawName = h('span', { class: 'slide-raw-name' }, slideName(i));
    const rawCard = h('div', { class: 'slide-raw-card' },
      h('span', { class: 'slide-raw-badge' }, '网页'),
      rawPage,
      rawName,
      h('span', { class: 'slide-raw-hint' }, '原稿结构 · 动效完整保留'));
    const item = h('div', {
      class: 'slide-item',
      dataset: { index: String(i) },
      title: slideName(i),
    },
    h('div', { class: 'slide-thumb' },
      h('div', { class: 'slide-thumb-fallback' }, h('span', null, '加载中…')),
      frame,
      rawCard,
      h('span', { class: 'slide-num' }, String(i + 1))),
    h('div', { class: 'slide-name' }, slideName(i)));
    if (i === currentIndex) item.classList.add('is-active');
    item.addEventListener('pointerdown', onItemPointerDown);
    item.addEventListener('contextmenu', onItemContextMenu);
    items.push({ index: i, el: item, frame, rendered: false, loading: false, rawPage, rawName });
    listEl.append(item);
  }
  updateActive(false);
  setFoot(currentIndex, total);
  requestAnimationFrame(() => { refreshVisible(true); });
}

function slideName(index) {
  const deck = deckState();
  const slide = deck.slides?.[index];
  return slide?.name || slide?.id || '第 ' + (index + 1) + ' 页';
}

function updateNames() {
  for (const item of items) {
    const name = slideName(item.index);
    item.el.title = name;
    const nameEl = item.el.querySelector('.slide-name');
    if (nameEl) nameEl.textContent = name;
    if (item.rawName) item.rawName.textContent = name;
    if (item.rawPage) item.rawPage.textContent = '第 ' + (item.index + 1) + ' 页';
  }
}

function updateActive(scroll = true) {
  for (const item of items) {
    const active = item.index === currentIndex;
    item.el.classList.toggle('is-active', active);
    if (active && scroll) item.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function setCurrent(index) {
  const next = Number(index);
  if (!Number.isFinite(next) || next === currentIndex) {
    currentIndex = Number.isFinite(next) ? next : currentIndex;
    updateActive(false);
    setFoot(currentIndex, items.length);
    return;
  }
  currentIndex = next;
  updateActive(true);
  setFoot(currentIndex, items.length);
}

function setFoot(index, total) {
  if (!footEl) return;
  const page = footEl.querySelector('.slide-foot-page');
  if (page) page.textContent = total ? `第 ${Math.min(index + 1, total)} / ${total} 页` : '暂无幻灯片';
}

/* ================= 缩略图渲染（懒加载 + 虚拟化） ================= */

function scheduleVisibleRefresh() {
  if (visibleRaf) return;
  visibleRaf = requestAnimationFrame(() => {
    visibleRaf = 0;
    refreshVisible(false);
  });
}

function itemHeight() {
  const first = items[0]?.el;
  if (!first) return 128;
  const rect = first.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(listEl).rowGap || '8') || 8;
  return rect.height + gap;
}

function refreshVisible(force = false) {
  if (!listEl || !items.length) return;
  const hgt = itemHeight();
  const scrollTop = listEl.scrollTop;
  const viewport = listEl.clientHeight || 600;
  const first = Math.max(0, Math.floor(scrollTop / hgt) - BUFFER);
  const last = Math.min(items.length - 1, Math.ceil((scrollTop + viewport) / hgt) + BUFFER);
  for (let i = first; i <= last; i++) loadThumb(i, force);
}

async function loadThumb(index, force = false) {
  const item = items[index];
  if (!item || !item.el.isConnected) return;
  if (item.loading) return;
  if (item.rendered && !force) return;
  const raw = isRawMode();
  let data = force ? null : thumbCache.get(index);
  if (!data) {
    const bridge = getBridge();
    if (!bridge?.ready) {
      if (raw) { renderRawCard(item); item.rendered = true; }
      return;
    }
    item.loading = true;
    try {
      data = await bridge.getThumb(index);
    } catch (err) {
      if (!raw) console.warn('[slides] 读取缩略图失败', index, err);
    } finally {
      item.loading = false;
    }
    if (!item.el.isConnected) return;
    // 兼容模式 / 动态页：getThumb 可能为空或只有壳，用占位卡兜底（不要白屏）
    if (!data || !data.html || String(data.html).replace(/\s+/g, '').length < 16) {
      if (raw) { renderRawCard(item); item.rendered = true; }
      return;
    }
    thumbCache.set(index, data);
  }
  if (!item.el.isConnected) return;
  renderThumb(item, data);
  item.rendered = true;
}

function renderThumb(item, data) {
  try {
    item.frame.srcdoc = buildThumbDoc(data);
  } catch (err) {
    console.warn('[slides] 渲染缩略图失败', err);
  }
  item.el.classList.remove('is-raw-card');
  item.el.classList.add('is-rendered');
}

/** 兼容模式占位卡：页码 + 页名 + 「兼容模式」（不依赖原稿截图） */
function renderRawCard(item) {
  if (!item?.el) return;
  if (item.frame) item.frame.srcdoc = '';
  item.el.classList.add('is-raw-card');
  item.el.classList.remove('is-rendered');
  if (item.rawPage) item.rawPage.textContent = '第 ' + (item.index + 1) + ' 页';
  if (item.rawName) item.rawName.textContent = slideName(item.index);
}

function buildThumbDoc(data) {
  const html = sanitizeThumbHtml(data?.html || '');
  const css = data?.css || '';
  const projectId = ctx?.getEditor?.()?.projectId || '';
  const scale = THUMB_W / 1920;
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<base href="/p/${encodeURIComponent(projectId)}/" />
<link rel="stylesheet" href="/editor/thumb.css" />
<style>${css}</style>
<style>
  html,body{margin:0;padding:0;width:${THUMB_W}px;height:${THUMB_H}px;overflow:hidden;background:#000}
  #wpx-app{position:fixed;inset:0;overflow:hidden;background:var(--wpx-bg,#0A0A0B)}
  #wpx-stage{width:1920px;height:1080px;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(var(--s,${scale}));transform-origin:center center}
  .wpx-selected,.wpx-hover{outline:0 !important}
  *,*::before,*::after{animation-duration:.001s !important;animation-delay:0s !important;animation-iteration-count:1 !important;animation-fill-mode:both !important;transition:none !important}
</style>
</head><body>
<div id="wpx-app" data-w="1920" data-h="1080"><div id="wpx-stage">${html}</div></div>
<script>document.documentElement.style.setProperty('--s',${scale});</script>
</body></html>`;
}

/** getThumb 的 html 是 live DOM 克隆，去掉编辑态残留（选中/悬停/可编辑属性） */
function sanitizeThumbHtml(html) {
  return String(html || '')
    .replace(/\bwpx-selected\b/g, '')
    .replace(/\bwpx-hover\b/g, '')
    .replace(/\s*contenteditable="[^"]*"/gi, '')
    .replace(/\s*spellcheck="[^"]*"/gi, '')
    .replace(/\s+class="\s*"/g, '');
}

function scheduleInvalidate(index) {
  clearTimeout(invalidateTimer);
  invalidateTimer = setTimeout(() => invalidate(index), 260);
}

/** 单页缩略图失效（内容变化时调用） */
export function invalidate(index) {
  if (index == null || index < 0) return;
  thumbCache.delete(index);
  const item = items[index];
  if (!item) return;
  item.rendered = false;
  if (item.el.isConnected && item.frame) {
    item.frame.srcdoc = '';
    item.el.classList.remove('is-rendered', 'is-raw-card');
  }
  scheduleVisibleRefresh();
}

/** 全部缩略图失效（增删页/排序/切换动效等） */
export function invalidateAll() {
  thumbCache.clear();
  for (const item of items) {
    item.rendered = false;
    if (item.frame) item.frame.srcdoc = '';
    item.el.classList.remove('is-rendered', 'is-raw-card');
  }
  scheduleVisibleRefresh();
}

/** deck 就绪：清空缓存并重建列表 */
export function onDeckReady() {
  thumbCache.clear();
  lastTotal = -1;
  syncFromStore();
}

/* ================= 拖拽排序 ================= */

function onItemPointerDown(e) {
  if (e.button !== 0) return;
  const item = e.currentTarget;
  const index = Number(item.dataset.index);
  if (e.target.closest('.slide-item-menu')) return;
  dragState = {
    index,
    item,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    target: null,
    pointerId: e.pointerId,
  };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragCancel);
}

function onDragMove(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  // 兼容模式：只能点击切页，不允许拖拽排序
  if (isRawMode()) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < 4) return;
  if (!dragState.moved) {
    dragState.moved = true;
    dragState.item.classList.add('is-dragging');
    listEl.classList.add('is-sorting');
    document.body.classList.add('is-slide-sorting');
  }
  const target = computeDropIndex(e.clientY);
  dragState.target = target;
  showIndicator(target);
}

function computeDropIndex(clientY) {
  const listRect = listEl.getBoundingClientRect();
  const y = clientY - listRect.top + listEl.scrollTop;
  const hgt = itemHeight();
  return clamp(Math.round(y / hgt), 0, items.length);
}

function showIndicator(insertIndex) {
  if (!indicator) return;
  const hgt = itemHeight();
  const top = insertIndex * hgt + parseFloat(getComputedStyle(listEl).paddingTop || '0') + 4;
  indicator.style.top = Math.max(0, top) + 'px';
  indicator.classList.remove('is-hidden');
}

function hideIndicator() {
  indicator?.classList.add('is-hidden');
}

async function onDragUp() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  removeDragListeners();
  state.item.classList.remove('is-dragging');
  listEl.classList.remove('is-sorting');
  document.body.classList.remove('is-slide-sorting');
  hideIndicator();

  if (!state.moved) {
    bus.runCommand('slide.select', { index: state.index });
    return;
  }
  if (structureBlocked()) return;
  const from = state.index;
  let to = state.target == null ? from : state.target;
  if (to > from) to -= 1;
  to = clamp(to, 0, items.length - 1);
  if (to === from) return;
  const bridge = getBridge();
  if (!bridge?.ready) return;
  try {
    await bridge.moveSlide(from, to);
    thumbCache.clear();
    await ctx?.getEditor?.()?.refreshDeckState?.();
    if (Array.isArray(store.get().deck.slides) && store.get().deck.slides.length === items.length) {
      // deck:change 会触发列表同步，这里只保证缩略图与当前页正确
      invalidateAll();
    }
    await ctx?.getEditor?.()?.goSlide?.(to);
    toast.ok('已移动幻灯片');
  } catch (err) {
    toast.error('移动幻灯片失败：' + (err?.message || err));
  }
}

function onDragCancel() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  removeDragListeners();
  state.item.classList.remove('is-dragging');
  listEl.classList.remove('is-sorting');
  document.body.classList.remove('is-slide-sorting');
  hideIndicator();
}

function removeDragListeners() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragCancel);
}

/* ================= 右键菜单 ================= */

function closeMenu() {
  menuCleanup?.();
  menuCleanup = null;
  menuEl?.remove();
  menuEl = null;
}

function onItemContextMenu(e) {
  e.preventDefault();
  const index = Number(e.currentTarget.dataset.index);
  openItemMenu(index, e.clientX, e.clientY);
}

function openItemMenu(index, x, y) {
  closeMenu();
  const root = document.getElementById('overlay-root') || document.body;
  const menu = h('div', { class: 'slide-menu' });
  const raw = isRawMode();
  const itemBtn = (label, iconName, onClick, opts = {}) => {
    const disabled = !!opts.disabled;
    const btn = h('button', {
      class: 'slide-menu-item' + (opts.danger ? ' is-danger' : '') + (disabled ? ' is-disabled' : ''),
      html: icon(iconName, 14),
      title: disabled ? '页面结构由网页原稿决定' : '',
    },
    h('span', null, label));
    btn.addEventListener('click', () => {
      if (disabled) { toast('页面结构由网页原稿决定，不能在这里增删页'); return; }
      closeMenu();
      onClick();
    });
    return btn;
  };
  const chips = TRANSITIONS.map(([name, label]) => {
    const btn = h('button', { class: 'slide-menu-chip' + (raw ? ' is-disabled' : '') }, label);
    btn.addEventListener('click', async () => {
      if (raw) { toast('切页由网页原稿控制，可用「转场」叠加特效'); return; }
      closeMenu();
      const bridge = getBridge();
      if (!bridge?.ready) return;
      try {
        await bridge.setSlideAttrs(index, { transition: name });
        toast.ok('已应用切换：' + label);
      } catch (err) { toast.error('应用切换失败：' + (err?.message || err)); }
    });
    return btn;
  });
  if (raw) menu.append(h('div', { class: 'slide-menu-label' }, '网页 · 可直接编辑页面内容'));
  menu.append(
    itemBtn('新增幻灯片', 'plus', () => bus.runCommand('slide.add', { afterIndex: index }), { disabled: raw }),
    itemBtn('复制幻灯片', 'copy', () => bus.runCommand('slide.duplicate', { index }), { disabled: raw }),
    itemBtn('重命名…', 'edit', () => renameSlide(index), { disabled: raw }),
    itemBtn('设置背景色…', 'palette', () => openBackgroundDialog(index), { disabled: raw }),
    h('div', { class: 'slide-menu-sep' }),
    h('div', { class: 'slide-menu-label' }, '应用切换'),
    h('div', { class: 'slide-menu-grid' }, ...chips),
    h('div', { class: 'slide-menu-sep' }),
    itemBtn('删除幻灯片', 'trash', () => deleteSlide(index), { danger: true, disabled: raw }),
  );
  root.append(menu);
  menuEl = menu;

  const rect = menu.getBoundingClientRect();
  const left = clamp(x, 8, window.innerWidth - rect.width - 8);
  const top = clamp(y, 8, window.innerHeight - rect.height - 8);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.classList.add('is-on');

  const onOutside = (evt) => {
    if (menuEl && !menuEl.contains(evt.target)) closeMenu();
  };
  const onKey = (evt) => { if (evt.key === 'Escape') closeMenu(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  };
}

/* ================= 幻灯片操作 ================= */

async function addSlide(payload = {}) {
  if (structureBlocked()) return { ok: false, raw: true };
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  const deck = deckState();
  const afterIndex = payload?.afterIndex != null ? Number(payload.afterIndex) : deck.current;
  try {
    const res = await bridge.addSlide(clamp(afterIndex, 0, Math.max(0, deck.total - 1)));
    await ctx?.getEditor?.()?.refreshDeckState?.();
    invalidateAll();
    if (res?.index != null) await ctx?.getEditor?.()?.goSlide?.(res.index);
    return { ok: true, index: res?.index };
  } catch (err) {
    toast.error('新增幻灯片失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function duplicateSlide(payload = {}) {
  if (structureBlocked()) return { ok: false, raw: true };
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  const index = payload?.index != null ? Number(payload.index) : deckState().current;
  try {
    const res = await bridge.duplicateSlide(index);
    await ctx?.getEditor?.()?.refreshDeckState?.();
    invalidateAll();
    if (res?.index != null) await ctx?.getEditor?.()?.goSlide?.(res.index);
    toast.ok('已复制幻灯片');
    return { ok: true, index: res?.index };
  } catch (err) {
    toast.error('复制幻灯片失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function deleteSlide(index) {
  if (structureBlocked()) return { ok: false, raw: true };
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  const deck = deckState();
  const target = Number.isFinite(Number(index)) ? Number(index) : deck.current;
  if (deck.total <= 1) {
    toast.warn('至少要保留一页幻灯片');
    return { ok: false };
  }
  const name = slideName(target);
  const sure = await dialog.confirm(`确定删除「${name}」吗？此操作可以用撤销恢复。`, { okLabel: '删除', danger: true, title: '删除幻灯片' });
  if (!sure) return { ok: false };
  try {
    await bridge.deleteSlide(target);
    await ctx?.getEditor?.()?.refreshDeckState?.();
    invalidateAll();
    toast.ok('已删除幻灯片');
    return { ok: true };
  } catch (err) {
    toast.error('删除幻灯片失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function renameSlide(index) {
  if (pageEditBlocked()) return { ok: false, raw: true };
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  const target = Number(index);
  if (!Number.isFinite(target)) return { ok: false };
  const name = await dialog.prompt('重命名幻灯片', { value: slideName(target), placeholder: '页面名称' });
  if (name == null) return { ok: false };
  try {
    await bridge.setSlideAttrs(target, { name: String(name).trim() || slideName(target) });
    await ctx?.getEditor?.()?.refreshDeckState?.();
    invalidateAll();
    return { ok: true };
  } catch (err) {
    toast.error('重命名失败：' + (err?.message || err));
    return { ok: false };
  }
}

function openBackgroundDialog(index) {
  if (pageEditBlocked()) return;
  const input = h('input', { class: 'insp-color slide-bg-color', type: 'color', value: '#0a0a0b' });
  const preview = h('div', { class: 'slide-bg-preview', style: { background: '#0a0a0b' } });
  input.addEventListener('input', () => { preview.style.background = input.value; });
  const body = h('div', { class: 'slide-bg-dialog' },
    preview,
    h('label', { class: 'slide-bg-field' }, h('span', null, '背景颜色'), input),
    h('div', { class: 'insert-tip' }, '背景色写入该页 data-bg，并同步到 canvas 的 inline background。'));
  dialog.open({
    title: '设置页面背景',
    sub: slideName(Number(index)),
    width: 'sm',
    body,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      { label: '应用', kind: 'primary', onClick: () => input.value },
    ],
  }).then(async (color) => {
    if (!color) return;
    const bridge = getBridge();
    if (!bridge?.ready) return;
    try {
      await bridge.setSlideAttrs(Number(index), { bg: color });
      invalidate(Number(index));
      toast.ok('背景已更新');
    } catch (err) {
      toast.error('设置背景失败：' + (err?.message || err));
    }
  });
}

/* ================= 命令注册 ================= */

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload || {}); } catch (err) {
      console.error('[slides] 命令失败', name, err);
      toast.error('操作失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('slide.add', { label: '新增幻灯片', group: '幻灯片', icon: 'plus', shortcut: 'Ctrl+M' }, (payload) => addSlide(payload));
  reg('slide.duplicate', { label: '复制幻灯片', group: '幻灯片', icon: 'copy' }, (payload) => duplicateSlide(payload));
  reg('slide.delete', { label: '删除幻灯片', group: '幻灯片', icon: 'trash' }, (payload) => deleteSlide(payload?.index));
  reg('slide.move', { label: '移动幻灯片', group: '幻灯片', icon: 'drag' }, async ({ from, to } = {}) => {
    if (structureBlocked()) return { ok: false, raw: true };
    const bridge = getBridge();
    if (!bridge?.ready) return { ok: false };
    try {
      await bridge.moveSlide(Number(from), Number(to));
      await ctx?.getEditor?.()?.refreshDeckState?.();
      invalidateAll();
      return { ok: true };
    } catch (err) {
      toast.error('移动幻灯片失败：' + (err?.message || err));
      return { ok: false };
    }
  });
  reg('slide.select', { label: '切换到幻灯片', group: '幻灯片', icon: 'film' }, async (payload) => {
    const index = payload && typeof payload === 'object' ? payload.index : payload;
    const result = await ctx?.getEditor?.()?.goSlide?.(Number(index) || 0);
    return result || { ok: true };
  });
  reg('slide.setName', { label: '重命名幻灯片', group: '幻灯片', icon: 'edit' }, (payload) => {
    const index = payload?.index != null ? payload.index : deckState().current;
    return renameSlide(index);
  });
  reg('slide.setBackground', { label: '设置页面背景', group: '幻灯片', icon: 'palette' }, (payload) => {
    const index = payload?.index != null ? Number(payload.index) : deckState().current;
    openBackgroundDialog(index);
    return { ok: true };
  });
}
