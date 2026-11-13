/* 选中框覆盖层：点击选中、拖动移动、8 向缩放、旋转、键盘微调
 * 覆盖层坐标 = iframe 内 stage 盒（bridge.getState().stage）+ iframe.getBoundingClientRect()
 * 设计空间固定 1920×1080；拖拽期间用 beginTransform/updateTransform 实时预览，松手 commitTransform 只产生一个 op。
 */

import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h, clamp, isTypingTarget } from '../core/dom.js';
import { toast } from '../core/toast.js';

const MIN_SIZE = 8;
const HANDLE_DIRS = {
  nw: { x: -1, y: -1 }, n: { x: 0, y: -1 }, ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 }, se: { x: 1, y: 1 }, s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 }, w: { x: -1, y: 0 },
};
const HANDLE_LIST = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TYPE_LABEL = { text: '文字', image: '图片', shape: '形状', html: 'HTML', canvas: '画布' };

let ctx = null;
let layer = null;
let box = null;
let hitEl = null;
let tagEl = null;
let sizeEl = null;
let handleEls = {};
let stage = null;
let drag = null;
let textEditing = false;
let refreshRaf = 0;
let unattendedPointerId = null;
let clipboard = null;
let unsubs = [];

/* ================= 初始化 ================= */

export async function init(context) {
  ctx = context;
  layer = document.getElementById('selection-layer');
  if (!layer) return;
  build();
  bindEvents();
}

function getBridge() {
  return ctx?.getEditor?.()?.bridge || null;
}

function canInteract() {
  const ed = ctx?.getEditor?.();
  return !!(ed?.bridge?.ready && ctx?.route?.name === 'editor');
}

function build() {
  layer.innerHTML = '';
  hitEl = h('div', { class: 'sel-hit' });
  box = h('div', { class: 'sel-box is-hidden' });
  tagEl = h('span', { class: 'sel-tag' });
  sizeEl = h('span', { class: 'sel-size is-hidden' });
  box.append(h('span', { class: 'sel-rot-stem' }));
  const rot = h('button', { class: 'sel-handle sel-handle--rot', 'data-handle': 'rot', title: '拖动旋转（Shift 15° 吸附）' });
  box.append(rot, tagEl, sizeEl);
  for (const dir of HANDLE_LIST) {
    const el = h('span', { class: `sel-handle sel-handle--${dir}`, 'data-handle': dir });
    handleEls[dir] = el;
    box.append(el);
  }
  layer.append(hitEl, box);
  layer.addEventListener('pointerdown', onLayerPointerDown);
  layer.addEventListener('dblclick', onLayerDblClick);
}

/* ================= 事件绑定 ================= */

function bindEvents() {
  unsubs.push(bus.on('selection:change', () => scheduleRefresh()));
  unsubs.push(bus.on('deck:change', () => scheduleRefresh()));
  unsubs.push(bus.on('deck:ready', () => scheduleRefresh()));
  unsubs.push(bus.on('deck:unload', () => { hide(); }));
  unsubs.push(bus.on('editor:layout', () => scheduleRefresh()));
  unsubs.push(bus.on('editor:op', ({ op } = {}) => {
    if (!op) return;
    if (['move', 'resize', 'rotate', 'style', 'attr', 'text', 'insert', 'delete', 'slide-add', 'slide-delete', 'slide-html'].includes(op.type)) {
      scheduleRefresh();
    }
  }));
  unsubs.push(bus.on('editor:text-editing', ({ editing } = {}) => {
    textEditing = !!editing;
    layer.classList.toggle('is-editing', textEditing);
    if (textEditing) sizeEl.classList.add('is-hidden');
    scheduleRefresh();
  }));
  unsubs.push(bus.on('editor:nudge', ({ dx = 0, dy = 0 } = {}) => {
    if (textEditing || drag) return;
    nudge(dx, dy);
  }));
  unsubs.push(bus.on('editor:escape', () => {
    if (textEditing) return;
    if (drag) { cancelDrag(); return; }
    if (store.get().selection) deselect();
  }));
  // 注意：iframe 内按键由 bridge-client 统一映射为命令 / editor:nudge，这里不再重复处理
  window.addEventListener('keydown', onWindowKeyDown, true);
  window.addEventListener('pointerup', () => { unattendedPointerId = null; }, true);
  registerCommands();
}

function onWindowKeyDown(e) {
  if (ctx?.route?.name !== 'editor') return;
  if (isTypingTarget(document.activeElement)) return;
  if (textEditing || drag) return;
  const mod = e.ctrlKey || e.metaKey;
  const sel = store.get().selection;
  if (e.key === 'Escape') {
    if (sel) { e.preventDefault(); deselect(); }
    return;
  }
  if (!sel?.elementId) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    bus.runCommand('edit.delete');
    return;
  }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    bus.runCommand('edit.duplicate');
    return;
  }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const dir = arrows[e.key];
  if (dir) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    nudge(dir[0] * step, dir[1] * step);
  }
}

/* ================= 指针：选择 / 拖动 / 缩放 / 旋转 ================= */

function toDesign(clientX, clientY) {
  const ed = ctx?.getEditor?.();
  if (!ed) return { x: 0, y: 0 };
  return ed.clientToDesign(clientX, clientY);
}

function onLayerPointerDown(e) {
  if (e.button !== 0 || !canInteract()) return;
  unattendedPointerId = e.pointerId;
  const handle = e.target?.closest?.('[data-handle]');
  if (handle) {
    e.preventDefault();
    e.stopPropagation();
    const dir = handle.dataset.handle;
    startTransform(dir === 'rot' ? 'rotate' : 'resize', e, dir === 'rot' ? null : dir);
    return;
  }
  // 点击命中层：选中元素（选中后进入待拖动状态）
  e.preventDefault();
  selectAtPoint(e);
}

async function selectAtPoint(e) {
  const bridge = getBridge();
  if (!bridge?.ready) return;
  const pt = toDesign(e.clientX, e.clientY);
  let selection = null;
  try {
    selection = await bridge.selectAt(pt.x, pt.y);
  } catch (err) {
    console.warn('[selection] selectAt 失败', err);
    return;
  }
  if (!selection?.elementId) {
    await deselect();
    return;
  }
  store.update((s) => { s.selection = selection; });
  bus.emit('selection:change', { selection });
  const geom = geometryOf(selection);
  paintRect(geom.rect, geom.rotate, selection);
  beginDragSession('move', e, selection, null);
}

function onLayerDblClick(e) {
  if (!canInteract()) return;
  const bridge = getBridge();
  if (!bridge?.ready) return;
  e.preventDefault();
  const pt = toDesign(e.clientX, e.clientY);
  // 兼容模式：命中嵌套文本元素时优先编辑该文本（标题/段落），而不是整块 wrapper
  bridge.hitTest(pt.x, pt.y).then((hit) => {
    const elementId = hit?.textElementId || hit?.elementId;
    if (!elementId) return;
    bus.emit('editor:begin-text', { elementId });
  }).catch(() => { /* ignore */ });
}

function beginDragSession(kind, e, selection, handle) {
  if (!selection?.elementId) return;
  // 指针可能已经在 await 期间抬起（快速点击）：不要留下悬挂的拖拽状态
  if (unattendedPointerId !== e.pointerId && kind === 'move') return;
  const geom = geometryOf(selection);
  const rect = geom.rect;
  const dragRotate = geom.rotate;
  drag = {
    kind,
    handle,
    elementId: selection.elementId,
    selection,
    pointerId: e.pointerId,
    startClient: { x: e.clientX, y: e.clientY },
    startRect: rect,
    startRotate: dragRotate,
    preview: { ...rect },
    previewRotate: dragRotate,
    started: false,
    support: true,
    beginPromise: null,
    tickPending: false,
    startAngle: 0,
    centerClient: null,
    moved: false,
  };
  if (kind === 'rotate') {
    drag.centerClient = designCenterClient(rect);
    drag.startAngle = angleOf(e.clientX, e.clientY, drag.centerClient);
  }
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragCancel);
  document.body.classList.add('is-transforming');
}

function startTransform(kind, e, handle) {
  const selection = store.get().selection;
  if (!selection?.elementId) return;
  beginDragSession(kind, e, selection, handle);
}

function removeDragListeners() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragCancel);
  document.body.classList.remove('is-transforming');
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const scale = stage?.scale || 1;
  const dxClient = e.clientX - drag.startClient.x;
  const dyClient = e.clientY - drag.startClient.y;
  const dist = Math.hypot(dxClient, dyClient);
  if (!drag.started) {
    if (drag.kind === 'move' && dist < 3) return;
    if (drag.kind !== 'move' && dist < 1) return;
    drag.started = true;
    sizeEl.classList.remove('is-hidden');
    beginBridgeTransform(drag);
  }
  const dx = dxClient / scale;
  const dy = dyClient / scale;
  const grid = !!store.get().ui.grid;
  const snap = (v) => (grid ? Math.round(v / 8) * 8 : Math.round(v * 10) / 10);

  if (drag.kind === 'move') {
    drag.preview = {
      ...drag.startRect,
      x: snap(drag.startRect.x + dx),
      y: snap(drag.startRect.y + dy),
    };
  } else if (drag.kind === 'resize') {
    const local = clientDeltaToLocal(dx, dy, drag.startRotate);
    drag.preview = resizeRect(drag.startRect, drag.startRotate, drag.handle, local.dx, local.dy, e.shiftKey);
  } else if (drag.kind === 'rotate') {
    const nowAngle = angleOf(e.clientX, e.clientY, drag.centerClient);
    let deg = drag.startRotate + (nowAngle - drag.startAngle);
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    drag.previewRotate = normalizeDeg(deg);
  }
  drag.moved = true;
  paintRect(drag.preview, drag.previewRotate, drag.selection);
  updateSizeBubble(drag.preview);
  scheduleTransformTick(drag);
}

function beginBridgeTransform(d) {
  const bridge = getBridge();
  if (!bridge?.ready) { d.support = false; return; }
  d.beginPromise = bridge.beginTransform(d.elementId).catch((err) => {
    console.warn('[selection] beginTransform 不可用，降级为松手提交', err);
    d.support = false;
    return null;
  });
}

function scheduleTransformTick(d) {
  if (d.tickPending || !d.support) return;
  d.tickPending = true;
  requestAnimationFrame(async () => {
    d.tickPending = false;
    if (drag !== d || !d.started || !d.support) return;
    if (d.beginPromise) {
      await d.beginPromise;
      d.beginPromise = null;
      if (drag !== d) return;
    }
    const bridge = getBridge();
    if (!bridge?.ready) return;
    // move/rotate 用 bridge 的增量模式（对已旋转元素也精确）；resize 用 rect 模式
    let params;
    if (d.kind === 'move') {
      params = {
        elementId: d.elementId,
        mode: 'move',
        dx: round1(d.preview.x - d.startRect.x),
        dy: round1(d.preview.y - d.startRect.y),
      };
    } else if (d.kind === 'rotate') {
      params = { elementId: d.elementId, mode: 'rotate', deg: round1(d.previewRotate) };
    } else {
      const rect = roundRect(d.preview);
      params = {
        elementId: d.elementId,
        rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rotate: round1(d.previewRotate) },
      };
    }
    try {
      await bridge.updateTransform(params);
    } catch (err) {
      d.support = false;
      console.warn('[selection] updateTransform 失败，降级为松手提交', err);
    }
  });
}

async function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  removeDragListeners();
  sizeEl.classList.add('is-hidden');
  if (!d.started) {
    paintFromStore();
    return;
  }
  const bridge = getBridge();
  if (!bridge?.ready) {
    paintFromStore();
    return;
  }
  let committed = false;
  if (d.support) {
    try {
      const res = await bridge.commitTransform(d.elementId);
      committed = true;
      if (res?.op?.opId) ctx.getEditor()?.recordOp?.(res.op);
    } catch (err) {
      console.warn('[selection] commitTransform 失败，改用直接提交', err);
    }
  }
  if (!committed) await fallbackCommit(d);
  await refreshSelectionFromBridge();
}

function onDragCancel() {
  cancelDrag();
}

function cancelDrag() {
  const d = drag;
  drag = null;
  removeDragListeners();
  sizeEl.classList.add('is-hidden');
  const bridge = getBridge();
  if (d?.started && d.support && bridge?.ready) {
    bridge.cancelTransform(d.elementId).catch(() => {});
  }
  paintFromStore();
}

async function fallbackCommit(d) {
  const bridge = getBridge();
  if (!bridge?.ready) return;
  try {
    if (d.kind === 'move') {
      const dx = Math.round(d.preview.x - d.startRect.x);
      const dy = Math.round(d.preview.y - d.startRect.y);
      if (!dx && !dy) return;
      await bridge.moveElement(d.elementId, dx, dy);
    } else if (d.kind === 'resize') {
      const rect = roundRect(d.preview);
      await bridge.resizeElement(d.elementId, rect.w, rect.h, rect.x, rect.y);
    } else if (d.kind === 'rotate') {
      await bridge.rotateElement(d.elementId, Math.round(normalizeDeg(d.previewRotate)));
    }
  } catch (err) {
    toast.error('修改元素失败：' + (err?.message || err));
  }
}

/* ================= 几何计算 ================= */

function normalizeRect(rect) {
  if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: Number(rect.x) || 0,
    y: Number(rect.y) || 0,
    w: Math.max(0, Number(rect.w ?? rect.width) || 0),
    h: Math.max(0, Number(rect.h ?? rect.height) || 0),
  };
}

/**
 * bridge 返回的 selection.rect 是元素旋转后的 AABB；覆盖层需要「未旋转布局盒」。
 * 未旋转时两者一致；旋转时用 inline width/height 或 AABB 反推，中心点保持不变。
 */
function geometryOf(selection) {
  const aabb = normalizeRect(selection?.rect);
  const rotate = Number(selection?.rotate) || 0;
  if (!selection?.elementId || Math.abs(rotate) < 0.5) return { rect: aabb, rotate };
  const size = parseInlineSize(selection.inline);
  const rad = (rotate * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  let w = size.w;
  let hgt = size.h;
  if (w == null && hgt != null) w = (aabb.w - hgt * s) / Math.max(c, 0.01);
  else if (hgt == null && w != null) hgt = (aabb.h - w * s) / Math.max(c, 0.01);
  else if (w == null && hgt == null) {
    const denom = c * c - s * s;
    if (Math.abs(denom) > 0.08) {
      w = (aabb.w * c - aabb.h * s) / denom;
      hgt = (aabb.h * c - aabb.w * s) / denom;
    }
  }
  w = Number.isFinite(w) && w > 0 ? w : aabb.w;
  hgt = Number.isFinite(hgt) && hgt > 0 ? hgt : aabb.h;
  const cx = aabb.x + aabb.w / 2;
  const cy = aabb.y + aabb.h / 2;
  return {
    rect: {
      x: Math.round((cx - w / 2) * 10) / 10,
      y: Math.round((cy - hgt / 2) * 10) / 10,
      w: Math.round(w * 10) / 10,
      h: Math.round(hgt * 10) / 10,
    },
    rotate,
  };
}

function parseInlineSize(inline) {
  const text = String(inline || '');
  const mw = /(?:^|;)\s*width\s*:\s*([\d.]+)px/i.exec(text);
  const mh = /(?:^|;)\s*height\s*:\s*([\d.]+)px/i.exec(text);
  return { w: mw ? parseFloat(mw[1]) : null, h: mh ? parseFloat(mh[1]) : null };
}

function roundRect(rect) {
  return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function normalizeDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function angleOf(clientX, clientY, center) {
  if (!center) return 0;
  return Math.atan2(clientY - center.y, clientX - center.x) * 180 / Math.PI;
}

/** 元素中心点的视口坐标（用于旋转角度计算，必须是 client 坐标） */
function designCenterClient(rect) {
  if (!stage) return { x: 0, y: 0 };
  return {
    x: stage.left + (rect.x + rect.w / 2) * stage.scale,
    y: stage.top + (rect.y + rect.h / 2) * stage.scale,
  };
}

/** 把设计空间位移换算到元素自身坐标系（考虑旋转） */
function clientDeltaToLocal(dx, dy, rotate) {
  const rad = (rotate || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { dx: dx * cos + dy * sin, dy: -dx * sin + dy * cos };
}

/** 按手柄方向计算缩放后的矩形（支持旋转，固定对角锚点） */
function resizeRect(orig, rotate, handle, localDx, localDy, keepRatio) {
  const dir = HANDLE_DIRS[handle] || { x: 1, y: 1 };
  let w = orig.w;
  let h = orig.h;
  if (dir.x === 1) w = orig.w + localDx;
  else if (dir.x === -1) w = orig.w - localDx;
  if (dir.y === 1) h = orig.h + localDy;
  else if (dir.y === -1) h = orig.h - localDy;
  w = Math.max(MIN_SIZE, w);
  h = Math.max(MIN_SIZE, h);

  if (keepRatio && dir.x !== 0 && dir.y !== 0 && orig.w > 0 && orig.h > 0) {
    const ratio = orig.h / orig.w;
    if (Math.abs(w - orig.w) >= Math.abs((h - orig.h) / (ratio || 1))) h = w * ratio;
    else w = h / ratio;
    w = Math.max(MIN_SIZE, w);
    h = Math.max(MIN_SIZE, h);
  }

  const rad = (rotate || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = orig.x + orig.w / 2;
  const cy = orig.y + orig.h / 2;
  // 固定点（对角）在局部坐标系中的向量
  const anchorLocal = { x: -dir.x * orig.w / 2, y: -dir.y * orig.h / 2 };
  const anchorWorld = {
    x: cx + anchorLocal.x * cos - anchorLocal.y * sin,
    y: cy + anchorLocal.x * sin + anchorLocal.y * cos,
  };
  const newAnchorLocal = { x: -dir.x * w / 2, y: -dir.y * h / 2 };
  const centerWorld = {
    x: anchorWorld.x - (newAnchorLocal.x * cos - newAnchorLocal.y * sin),
    y: anchorWorld.y - (newAnchorLocal.x * sin + newAnchorLocal.y * cos),
  };
  return {
    x: Math.round((centerWorld.x - w / 2) * 10) / 10,
    y: Math.round((centerWorld.y - h / 2) * 10) / 10,
    w: Math.round(w * 10) / 10,
    h: Math.round(h * 10) / 10,
  };
}

/* ================= 绘制 ================= */

function scheduleRefresh() {
  if (refreshRaf) return;
  refreshRaf = requestAnimationFrame(() => {
    refreshRaf = 0;
    refresh();
  });
}

export function refresh() {
  const ed = ctx?.getEditor?.();
  const bridge = ed?.bridge;
  if (!layer || !bridge?.ready) { hide(); return; }
  stage = ed.getStageRect();
  if (!stage) { hide(); return; }
  if (drag && drag.started) {
    paintRect(drag.preview, drag.previewRotate, drag.selection);
    return;
  }
  const selection = store.get().selection;
  if (!selection?.rect) { hide(); return; }
  const geom = geometryOf(selection);
  paintRect(geom.rect, geom.rotate, selection);
}

function paintFromStore() {
  const selection = store.get().selection;
  if (!selection?.rect) { hide(); return; }
  const geom = geometryOf(selection);
  paintRect(geom.rect, geom.rotate, selection);
}

function paintRect(rect, rotate, selection) {
  if (!box || !layer || !stage) return;
  const areaRect = layer.parentElement.getBoundingClientRect();
  const scale = stage.scale;
  const left = stage.left - areaRect.left + rect.x * scale;
  const top = stage.top - areaRect.top + rect.y * scale;
  const width = Math.max(1, rect.w * scale);
  const height = Math.max(1, rect.h * scale);
  box.classList.remove('is-hidden');
  box.style.left = Math.round(left) + 'px';
  box.style.top = Math.round(top) + 'px';
  box.style.width = Math.round(width) + 'px';
  box.style.height = Math.round(height) + 'px';
  box.style.setProperty('--sel-counter', `${-rotate}deg`);
  box.style.transform = rotate ? `rotate(${rotate}deg)` : '';
  box.classList.toggle('is-edge', width < 24 || height < 24);

  const label = TYPE_LABEL[selection?.type] || '元素';
  const text = (selection?.text || '').replace(/\s+/g, ' ').trim();
  tagEl.textContent = text ? `${label} · ${text.slice(0, 14)}${text.length > 14 ? '…' : ''}` : label;
  tagEl.classList.toggle('is-flip', top < 26);
  sizeEl.style.setProperty('--sel-counter', `${-rotate}deg`);
}

function updateSizeBubble(rect) {
  if (!sizeEl) return;
  sizeEl.textContent = `${Math.round(rect.w)} × ${Math.round(rect.h)}`;
  sizeEl.classList.remove('is-hidden');
}

function hide() {
  box?.classList.add('is-hidden');
  sizeEl?.classList.add('is-hidden');
}

/** 样式 / 属性类操作后，选区里的 styles 会过期：合并多次刷新，重新向画布要一次选区信息 */
let syncTimer = 0;
export function syncFromBridge(delay = 40) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = 0; refreshSelectionFromBridge(); }, delay);
}

async function refreshSelectionFromBridge() {
  const bridge = getBridge();
  if (!bridge?.ready) return;
  try {
    const selection = await bridge.getSelection();
    store.update((s) => { s.selection = selection || null; });
    bus.emit('selection:change', { selection: selection || null });
    scheduleRefresh();
  } catch { /* ignore */ }
}

async function deselect() {
  const bridge = getBridge();
  store.update((s) => { s.selection = null; });
  bus.emit('selection:change', { selection: null });
  hide();
  if (bridge?.ready) {
    try { await bridge.deselect(); } catch { /* ignore */ }
  }
}

async function nudge(dx, dy) {
  if (textEditing || drag) return;
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return;
  try {
    await bridge.moveElement(selection.elementId, dx, dy);
  } catch (err) {
    console.warn('[selection] 微调失败', err);
    return;
  }
  setTimeout(() => refreshSelectionFromBridge(), 30);
}

/* ================= 剪贴板 / 元素命令 ================= */

async function copySelection() {
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return { ok: false };
  try {
    const res = await bridge.getElementHtml(selection.elementId);
    const html = typeof res === 'string' ? res : res?.html;
    if (!html) throw new Error('元素内容为空');
    clipboard = {
      html,
      rect: normalizeRect(selection.rect),
      type: selection.type,
    };
    toast.ok('已复制');
    return { ok: true };
  } catch (err) {
    toast.error('复制失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function deleteSelection() {
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return { ok: false };
  try {
    await bridge.deleteElement(selection.elementId);
  } catch (err) {
    toast.error('删除失败：' + (err?.message || err));
    return { ok: false };
  }
  return { ok: true };
}

async function cutSelection() {
  const copied = await copySelection();
  if (!copied.ok) return copied;
  return deleteSelection();
}

async function duplicateSelection() {
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return { ok: false };
  try {
    const res = await bridge.duplicateElement(selection.elementId);
    if (res?.elementId) {
      try {
        const next = await bridge.select(res.elementId);
        if (next?.elementId) {
          store.update((s) => { s.selection = next; });
          bus.emit('selection:change', { selection: next });
        }
      } catch { /* ignore */ }
    }
    return { ok: true, elementId: res?.elementId };
  } catch (err) {
    toast.error('复制元素失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function pasteClipboard() {
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  if (!clipboard?.html) {
    bus.emit('editor:paste');
    return { ok: false, error: '剪贴板为空' };
  }
  const deck = store.get().deck;
  const base = clipboard.rect || { x: (deck.w - 400) / 2, y: (deck.h - 200) / 2, w: 400, h: 200 };
  try {
    const res = await bridge.insertElement({
      type: 'html',
      html: clipboard.html,
      x: Math.round(base.x + 24),
      y: Math.round(base.y + 24),
      w: Math.round(base.w),
      h: Math.round(base.h),
    });
    if (res?.elementId) {
      try {
        const next = await bridge.select(res.elementId);
        store.update((s) => { s.selection = next || s.selection; });
        bus.emit('selection:change', { selection: next || null });
      } catch { /* ignore */ }
    }
    return { ok: true };
  } catch (err) {
    toast.error('粘贴失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function selectAll() {
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  try {
    const res = await bridge.call('selectAll');
    return res || { ok: true };
  } catch {
    toast('当前版本仅支持单选，多选功能即将支持');
    return { ok: false };
  }
}

/* ================= 层级 / 对齐 / 旋转 ================= */

async function applyZIndex(z) {
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return { ok: false };
  await bridge.setStyles(selection.elementId, { 'z-index': String(Math.round(z)) });
  return { ok: true };
}

function currentZ() {
  return Number(store.get().selection?.zIndex) || 0;
}

async function alignElement(mode) {
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return { ok: false };
  const rect = normalizeRect(selection.rect);
  const deck = store.get().deck;
  const W = deck.w || 1920;
  const H = deck.h || 1080;
  let x = rect.x;
  let y = rect.y;
  switch (mode) {
    case 'left': x = 0; break;
    case 'center': x = (W - rect.w) / 2; break;
    case 'right': x = W - rect.w; break;
    case 'top': y = 0; break;
    case 'middle': y = (H - rect.h) / 2; break;
    case 'bottom': y = H - rect.h; break;
    default: break;
  }
  try {
    await bridge.resizeElement(selection.elementId, Math.round(rect.w), Math.round(rect.h), Math.round(x), Math.round(y));
    return { ok: true };
  } catch (err) {
    toast.error('对齐失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function rotateSelection(payload) {
  const bridge = getBridge();
  const selection = store.get().selection;
  if (!bridge?.ready || !selection?.elementId) return { ok: false };
  let deg = null;
  if (payload && typeof payload === 'object') {
    if (payload.delta != null) deg = (Number(selection.rotate) || 0) + Number(payload.delta);
    else if (payload.deg != null) deg = Number(payload.deg);
    else if (payload.rotate != null) deg = Number(payload.rotate);
  } else if (payload != null && payload !== '') {
    deg = Number(payload);
  }
  if (!Number.isFinite(deg)) deg = (Number(selection.rotate) || 0) + 15;
  try {
    await bridge.rotateElement(selection.elementId, Math.round(normalizeDeg(deg) * 10) / 10);
    return { ok: true };
  } catch (err) {
    toast.error('旋转失败：' + (err?.message || err));
    return { ok: false };
  }
}

/* ================= 命令注册 ================= */

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload); } catch (err) {
      console.error('[selection] 命令失败', name, err);
      toast.error('操作失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('edit.delete', { label: '删除', group: '编辑', icon: 'trash', shortcut: 'Delete' }, () => deleteSelection());
  reg('edit.duplicate', { label: '复制元素', group: '编辑', icon: 'copy', shortcut: 'Ctrl+D' }, () => duplicateSelection());
  reg('edit.copy', { label: '复制', group: '编辑', icon: 'copy', shortcut: 'Ctrl+C' }, () => copySelection());
  reg('edit.cut', { label: '剪切', group: '编辑', icon: 'clipboard', shortcut: 'Ctrl+X' }, () => cutSelection());
  reg('edit.paste', { label: '粘贴', group: '编辑', icon: 'clipboard', shortcut: 'Ctrl+V' }, () => pasteClipboard());
  reg('edit.selectAll', { label: '全选', group: '编辑', icon: 'frame', shortcut: 'Ctrl+A' }, () => selectAll());
  reg('edit.deselect', { label: '取消选中', group: '编辑', icon: 'mouse-pointer', shortcut: 'Esc' }, () => { deselect(); return { ok: true }; });

  reg('arrange.front', { label: '置于顶层', group: '排列', icon: 'bring-front' }, () => applyZIndex(Math.max(currentZ() + 1, 9999)));
  reg('arrange.back', { label: '置于底层', group: '排列', icon: 'send-back' }, () => applyZIndex(Math.min(currentZ() - 1, 0)));
  reg('arrange.forward', { label: '上移一层', group: '排列', icon: 'arrow-up' }, () => applyZIndex(currentZ() + 1));
  reg('arrange.backward', { label: '下移一层', group: '排列', icon: 'arrow-down' }, () => applyZIndex(currentZ() - 1));

  reg('arrange.alignLeft', { label: '左对齐', group: '排列', icon: 'align-left' }, () => alignElement('left'));
  reg('arrange.alignCenter', { label: '水平居中', group: '排列', icon: 'align-center' }, () => alignElement('center'));
  reg('arrange.alignRight', { label: '右对齐', group: '排列', icon: 'align-right' }, () => alignElement('right'));
  reg('arrange.alignTop', { label: '顶端对齐', group: '排列', icon: 'arrow-up' }, () => alignElement('top'));
  reg('arrange.alignMiddle', { label: '垂直居中', group: '排列', icon: 'align-center' }, () => alignElement('middle'));
  reg('arrange.alignBottom', { label: '底端对齐', group: '排列', icon: 'arrow-down' }, () => alignElement('bottom'));
  const notSupported = () => { toast('等距分布需要多选，当前版本仅支持单选'); return { ok: false }; };
  reg('arrange.distributeH', { label: '水平分布', group: '排列', icon: 'more-h' }, notSupported);
  reg('arrange.distributeV', { label: '垂直分布', group: '排列', icon: 'more-v' }, notSupported);

  reg('element.rotate', { label: '旋转', group: '排列', icon: 'rotate' }, (payload) => rotateSelection(payload));
}
