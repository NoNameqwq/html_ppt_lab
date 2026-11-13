/* 全局浮层系统：菜单 / popover / 颜色选择器 / 工具提示
 *
 * 挂载到 ctx.overlay，供其它模块共用：
 *   ctx.overlay.menu({ x?, y?, anchor?, align?, items, minWidth?, className?, onClose? })
 *   ctx.overlay.popover({ anchor, content, width?, placement?, onClose?, className? })
 *   ctx.overlay.colorPicker({ anchor, value, onChange, allowAlpha? })
 *   ctx.overlay.tooltip(el, text?)   // 手动显示（一般无需调用，[data-tip] 自动生效）
 *   ctx.overlay.close()              // 关闭全部浮层
 *
 * 菜单项结构：
 *   { label, icon?, shortcut?, danger?, disabled?, checked?, onClick?, items?(子菜单), sep?, type:'label' }
 *   items 可以是数组或返回数组的函数（打开时求值）。
 *
 * 工具提示约定：元素上写 data-tip="保存|Ctrl+S"，第二段会渲染成 kbd；可选用 data-tip-kbd / data-tip-pos="bottom"。
 */

import { h } from '../core/dom.js';
import { icon } from './icons.js';

const MARGIN = 8;
const TIP_DELAY = 180;
const RECENT_COLORS_KEY = 'wds:colors';

/* 色板：暖骨白 / 墨黑 / 朱砂 / 青瓷 / 靛蓝 / 紫 / 玫瑰，四组 8 色 */
export const SWATCHES = [
  '#1B1A17', '#3D3A34', '#57534B', '#8A8478', '#C9C1B6', '#E7E4DD', '#F2EAE0', '#FFFDF9',
  '#C43E1C', '#E8694F', '#F2A08C', '#B5342A', '#8E2F17', '#D9A05B', '#B87319', '#F0C276',
  '#2C6E68', '#5FA69E', '#9CCBC4', '#1F4E4A', '#2F7D5B', '#4FA97C', '#14532D', '#A3C9A8',
  '#2B3A67', '#3E5AA6', '#7B96D6', '#4B2B5A', '#8A5A9E', '#D6A9D0', '#7A2E4A', '#F3B3C6',
  '#F5E6C8', '#D8C7A8', '#B8B2A6', '#7A6A55', '#4B4B4B', '#EDEDEB',
  '#FFFFFF', '#000000',
];

let ctxRef = null;
let globalsBound = false;
let tipBound = false;

/* 浮层栈：后打开的在上层；child 关系用 parent 记录（子菜单） */
const layers = [];

let tooltipEl = null;
let tipTarget = null;
let tipTimer = 0;

/* ============================================================
   基础工具
   ============================================================ */

function motionOff() {
  if (document.documentElement.classList.contains('qa')) return true;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function overlayRoot() {
  return document.getElementById('overlay-root') || document.body;
}

function rectOf(anchor) {
  if (!anchor) return null;
  if (typeof anchor.getBoundingClientRect !== 'function') return null;
  return anchor.getBoundingClientRect();
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

function resolveItems(value) {
  if (typeof value === 'function') {
    try {
      const out = value();
      return Array.isArray(out) ? out : [];
    } catch (err) {
      console.error('[overlay] 菜单 items 求值失败', err);
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

/* ============================================================
   浮层栈管理
   ============================================================ */

function addLayer(kind, el, parent = null) {
  const layer = {
    kind,
    el,
    parent,
    child: null,
    onClose: null,
    onKey: null,
    reposition: null,
  };
  layer.close = () => closeLayer(layer);
  layers.push(layer);
  return layer;
}

function forceRemove(layer) {
  const idx = layers.indexOf(layer);
  if (idx >= 0) layers.splice(idx, 1);
  if (layer.hoverTimer) {
    clearTimeout(layer.hoverTimer);
    layer.hoverTimer = 0;
  }
  try {
    layer.onClose?.();
  } catch (err) {
    console.error('[overlay] onClose 回调失败', err);
  }
  const el = layer.el;
  if (!el || !el.isConnected) return;
  if (motionOff() || typeof el.animate !== 'function') {
    el.remove();
    return;
  }
  /* 关闭动画期间不再接收指针事件，避免「幽灵点击」 */
  el.style.pointerEvents = 'none';
  const anim = el.animate(
    [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-3px) scale(.985)' },
    ],
    { duration: 120, easing: 'ease-in', fill: 'forwards' },
  );
  anim.finished.catch(() => {}).then(() => el.remove());
}

function closeLayer(layer) {
  const idx = layers.indexOf(layer);
  if (idx < 0) return;
  while (layers.length - 1 > idx) forceRemove(layers[layers.length - 1]);
  forceRemove(layer);
}

function closeAll() {
  while (layers.length) forceRemove(layers[layers.length - 1]);
}

function closeMenus() {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (layers[i].kind === 'menu') forceRemove(layers[i]);
  }
}

function closePopovers() {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (layers[i].kind !== 'menu') forceRemove(layers[i]);
  }
}

/* ============================================================
   定位
   ============================================================ */

/** 把浮层放到 anchor（或坐标点）附近，自动做视口夹取与上下翻转 */
function positionFloating(el, anchor, opts = {}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth || 200;
  const ht = el.offsetHeight || 100;
  const rect = rectOf(anchor);
  let left = MARGIN;
  let top = MARGIN;
  let up = false;

  if (rect) {
    const placement = opts.placement || 'bottom-start';
    const dash = placement.indexOf('-');
    const side = dash >= 0 ? placement.slice(0, dash) : placement;
    const align = dash >= 0 ? placement.slice(dash + 1) : opts.align || 'start';
    if (side === 'right' || side === 'left') {
      left = side === 'right' ? rect.right + 6 : rect.left - w - 6;
      top = align === 'center' ? rect.top + rect.height / 2 - ht / 2 : rect.top;
    } else {
      left = align === 'end' ? rect.right - w : align === 'center' ? rect.left + rect.width / 2 - w / 2 : rect.left;
      if (side === 'top') {
        top = rect.top - ht - 6;
        up = true;
      } else {
        top = rect.bottom + 6;
      }
      /* 空间不足时自动换边对齐 */
      if (!up && left + w > vw - MARGIN && left > MARGIN) left = rect.right - w;
      if (!up && left < MARGIN) left = rect.left;
    }
  } else if (opts.x != null || opts.y != null) {
    left = opts.x != null ? opts.x : MARGIN;
    top = opts.y != null ? opts.y : MARGIN;
    /* 右键菜单：右边/下边空间不足时向左上翻转 */
    if (left + w > vw - MARGIN) left = Math.max(MARGIN, vw - w - MARGIN);
    if (top + ht > vh - MARGIN) top = Math.max(MARGIN, vh - ht - MARGIN);
  }

  left = clamp(left, MARGIN, vw - w - MARGIN);

  if (top + ht > vh - MARGIN) {
    if (rect && !up && rect.top - ht - 6 >= MARGIN) {
      top = rect.top - ht - 6;
      up = true;
    } else if (!rect) {
      top = Math.max(MARGIN, vh - ht - MARGIN);
    } else {
      top = Math.max(MARGIN, Math.min(top, vh - ht - MARGIN));
    }
  }
  if (top < MARGIN) top = MARGIN;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.classList.toggle('is-up', up);
}

/** 子菜单：优先贴父项右侧，放不下就翻到左侧 */
function positionSubmenu(el, itemEl) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = itemEl.getBoundingClientRect();
  const w = el.offsetWidth || 180;
  const ht = el.offsetHeight || 120;
  let left = r.right + 4;
  let top = r.top - 5;
  if (left + w > vw - MARGIN) left = Math.max(MARGIN, r.left - w - 4);
  if (top + ht > vh - MARGIN) top = Math.max(MARGIN, vh - ht - MARGIN);
  if (top < MARGIN) top = MARGIN;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/* ============================================================
   菜单
   ============================================================ */

function menu(options = {}) {
  closeMenus();

  const el = h('div', {
    class: `menu ${options.className || ''}`.trim(),
    role: 'menu',
    'aria-label': options.label || '菜单',
  });
  if (options.minWidth) {
    el.style.minWidth = typeof options.minWidth === 'number' ? `${options.minWidth}px` : options.minWidth;
  }

  const layer = addLayer('menu', el, null);
  layer.items = [];
  layer.focusIndex = -1;
  layer.hoverTimer = 0;
  layer.onClose = options.onClose || null;

  buildMenuItems(el, resolveItems(options.items), layer);
  overlayRoot().append(el);

  layer.reposition = () => positionFloating(el, options.anchor, {
    x: options.x,
    y: options.y,
    align: options.align,
    placement: options.placement,
  });
  layer.reposition();
  layer.onKey = (e) => handleMenuKey(e, layer);

  return { el, close: layer.close };
}

function buildMenuItems(el, items, layer) {
  for (const item of items) {
    if (!item) continue;
    if (item === '-' || item.sep || item.type === 'sep') {
      el.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (item.type === 'label') {
      el.append(h('div', { class: 'menu-label' }, item.label));
      continue;
    }
    if (item.hidden) continue;

    const hasSub = item.items !== undefined && item.items !== null;
    const btn = h('button', {
      class: `menu-item${item.danger ? ' is-danger' : ''}${item.checked ? ' is-checked' : ''}`,
      type: 'button',
      role: hasSub ? 'menuitem' : 'menuitem',
      'aria-haspopup': hasSub ? 'menu' : null,
      'aria-checked': item.checked != null ? String(!!item.checked) : null,
      disabled: item.disabled ? true : null,
    });

    const iconMarkup = item.checked ? icon('check', 14) : item.icon ? icon(item.icon, 15) : '';
    btn.append(h('span', { class: 'mi-icon', html: iconMarkup }));
    btn.append(h('span', { class: 'mi-label' }, item.label == null ? '' : item.label));
    if (item.shortcut) btn.append(h('span', { class: 'mi-kbd' }, item.shortcut));
    if (hasSub) btn.append(h('span', { class: 'mi-sub', html: icon('chevron-right', 13) }));

    const entry = { el: btn, item, hasSub, submenu: null };
    layer.items.push(entry);
    el.append(btn);

    if (item.disabled) continue;

    btn.addEventListener('mouseenter', () => {
      setMenuFocus(layer, layer.items.indexOf(entry));
      scheduleSubmenu(layer, entry);
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      activateEntry(layer, entry);
    });
    if (hasSub) {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
  }
}

function setMenuFocus(layer, index) {
  const entry = layer.items[index];
  if (!entry) return;
  layer.focusIndex = index;
  for (const it of layer.items) it.el.classList.toggle('is-focused', it === entry);
  entry.el.scrollIntoView?.({ block: 'nearest' });
}

function moveMenuFocus(layer, delta) {
  const list = layer.items.filter((it) => !it.item.disabled);
  if (!list.length) return;
  let pos = list.findIndex((it) => it.el.classList.contains('is-focused'));
  if (pos < 0) pos = delta > 0 ? -1 : 0;
  pos = (pos + delta + list.length) % list.length;
  setMenuFocus(layer, layer.items.indexOf(list[pos]));
}

function clearHoverTimer(layer) {
  if (layer.hoverTimer) {
    clearTimeout(layer.hoverTimer);
    layer.hoverTimer = 0;
  }
}

function closeSubmenu(layer) {
  for (const entry of layer.items) {
    if (entry.submenu) {
      clearHoverTimer(layer);
      entry.submenu.close();
      entry.submenu = null;
    }
  }
}

function scheduleSubmenu(layer, entry) {
  clearHoverTimer(layer);
  if (entry.hasSub) {
    layer.hoverTimer = setTimeout(() => {
      layer.hoverTimer = 0;
      openSubmenu(layer, entry);
    }, 120);
  } else {
    closeSubmenu(layer);
  }
}

function openSubmenu(layer, entry) {
  const items = resolveItems(entry.item.items);
  if (!items.length) return;
  if (entry.submenu) return;
  closeSubmenu(layer);

  const el = h('div', { class: 'menu menu--sub', role: 'menu' });
  const sub = addLayer('menu', el, layer);
  sub.items = [];
  sub.focusIndex = -1;
  sub.hoverTimer = 0;
  sub.parentEntry = entry;
  entry.submenu = sub;
  entry.el.classList.add('is-sub-open');
  sub.onClose = () => {
    entry.submenu = null;
    entry.el.classList.remove('is-sub-open');
  };
  buildMenuItems(el, items, sub);
  overlayRoot().append(el);
  sub.reposition = () => positionSubmenu(el, entry.el);
  sub.reposition();
  sub.onKey = (e) => handleMenuKey(e, sub);
}

function activateEntry(layer, entry) {
  if (entry.item.disabled) return;
  if (entry.hasSub) {
    openSubmenu(layer, entry);
    return;
  }
  let root = layer;
  while (root.parent) root = root.parent;
  root.close();
  try {
    entry.item.onClick?.();
  } catch (err) {
    console.error('[overlay] 菜单项回调失败', err);
  }
}

function handleMenuKey(e, layer) {
  const key = e.key;
  if (key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    moveMenuFocus(layer, 1);
  } else if (key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    moveMenuFocus(layer, -1);
  } else if (key === 'Home') {
    e.preventDefault();
    e.stopPropagation();
    const list = layer.items.filter((it) => !it.item.disabled);
    if (list.length) setMenuFocus(layer, layer.items.indexOf(list[0]));
  } else if (key === 'End') {
    e.preventDefault();
    e.stopPropagation();
    const list = layer.items.filter((it) => !it.item.disabled);
    if (list.length) setMenuFocus(layer, layer.items.indexOf(list[list.length - 1]));
  } else if (key === 'ArrowRight') {
    const cur = layer.items[layer.focusIndex];
    if (cur && cur.hasSub) {
      e.preventDefault();
      e.stopPropagation();
      openSubmenu(layer, cur);
      const sub = cur.submenu;
      if (sub) {
        const first = sub.items.filter((it) => !it.item.disabled)[0];
        if (first) setMenuFocus(sub, sub.items.indexOf(first));
      }
    }
  } else if (key === 'ArrowLeft') {
    if (layer.parent) {
      e.preventDefault();
      e.stopPropagation();
      layer.close();
    }
  } else if (key === 'Enter' || key === ' ') {
    const cur = layer.items[layer.focusIndex];
    if (cur) {
      e.preventDefault();
      e.stopPropagation();
      activateEntry(layer, cur);
    }
  } else if (key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    closeAll();
  }
}

/* ============================================================
   Popover
   ============================================================ */

function popover(options = {}) {
  const {
    anchor,
    content,
    width,
    placement = 'bottom-start',
    onClose,
    className = '',
    label = '浮层',
    closable = true,
  } = options;

  const el = h('div', {
    class: `popover ${className}`.trim(),
    role: 'dialog',
    'aria-label': label,
  });
  if (width) el.style.width = typeof width === 'number' ? `${width}px` : width;
  if (content instanceof Node) el.append(content);
  else if (content != null) el.append(h('div', { class: 'popover-text' }, String(content)));

  const layer = addLayer('popover', el, null);
  layer.closable = closable;
  layer.onClose = onClose || null;
  overlayRoot().append(el);

  layer.reposition = () => positionFloating(el, anchor, { placement });
  layer.reposition();

  if (options.autoFocus) {
    requestAnimationFrame(() => {
      el.querySelector('input,textarea,select,button')?.focus?.();
    });
  }

  return { el, close: layer.close, update: layer.reposition };
}

/* ============================================================
   颜色解析 / 颜色选择器
   ============================================================ */

function parseColor(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s || s === 'transparent' || s === 'none') return null;

  /* #rgb / #rrggbb / #rrggbbaa */
  if (/^#([0-9a-f]{3,8})$/i.test(s)) {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    let alpha = 1;
    if (hex.length === 8) {
      alpha = parseInt(hex.slice(6, 8), 16) / 255;
      hex = hex.slice(0, 6);
    }
    if (hex.length !== 6) return null;
    return { hex: `#${hex.toUpperCase()}`, alpha: Math.round(alpha * 100) / 100 };
  }

  /* rgb()/rgba()/hsl()/命名色：借浏览器统一解析 */
  try {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = s;
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const m = /rgba?\(([^)]+)\)/.exec(computed || '');
    if (!m) return null;
    const parts = m[1].split(',').map((x) => x.trim());
    const [r, g, b] = parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))));
    const alpha = parts[3] != null ? Math.max(0, Math.min(1, Number(parts[3]))) : 1;
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    return { hex, alpha: Math.round(alpha * 100) / 100 };
  } catch {
    return null;
  }
}

function formatColor(hex, alpha = 1) {
  if (alpha >= 1) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

function readRecentColors() {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((c) => typeof c === 'string').slice(0, 16) : [];
  } catch {
    return [];
  }
}

function rememberColor(hex) {
  try {
    const list = readRecentColors().filter((c) => c.toUpperCase() !== hex.toUpperCase());
    list.unshift(hex);
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(list.slice(0, 16)));
  } catch {
    /* 忽略存储失败 */
  }
}

function colorPicker(options = {}) {
  const { anchor, value = '#1B1A17', onChange, allowAlpha = false, className = '' } = options;
  const parsed = parseColor(value) || { hex: '#1B1A17', alpha: 1 };
  const state = { hex: parsed.hex, alpha: allowAlpha ? parsed.alpha : 1 };
  let handle = null;

  const preview = h('span', { class: 'cp-preview', 'aria-hidden': 'true' });
  const hexInput = h('input', {
    class: 'input cp-hex',
    type: 'text',
    spellcheck: 'false',
    'aria-label': '颜色值（hex）',
  });
  const grid = h('div', { class: 'cp-grid' });
  const recentWrap = h('div', { class: 'cp-recent' });
  const foot = h('div', { class: 'cp-foot' });

  const effective = () => formatColor(state.hex, state.alpha);

  const syncPreview = () => {
    preview.style.backgroundColor = effective();
    hexInput.value = state.hex;
    for (const sw of [...grid.children, ...recentWrap.children]) {
      const c = sw.getAttribute('data-color');
      sw.classList.toggle('is-active', !!c && c.toUpperCase() === state.hex.toUpperCase());
    }
  };

  const emit = () => {
    try {
      onChange?.(effective());
    } catch (err) {
      console.error('[overlay] colorPicker onChange 失败', err);
    }
  };

  const commit = (color, closeAfter = false) => {
    const p = parseColor(color);
    if (!p) return false;
    state.hex = p.hex;
    state.alpha = allowAlpha ? p.alpha : 1;
    syncPreview();
    rememberColor(p.hex);
    emit();
    if (closeAfter) handle?.close();
    return true;
  };

  /* 头部：当前色预览 + hex 输入 */
  const head = h('div', { class: 'cp-head' }, preview, hexInput);
  hexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!commit(hexInput.value, true)) {
        hexInput.classList.add('is-invalid');
        setTimeout(() => hexInput.classList.remove('is-invalid'), 500);
      }
    }
  });
  hexInput.addEventListener('change', () => {
    if (!commit(hexInput.value)) syncPreview();
  });

  /* 色板 */
  for (const color of SWATCHES) {
    const sw = h('button', {
      class: 'cp-swatch',
      type: 'button',
      title: color,
      'aria-label': `颜色 ${color}`,
      style: { background: color },
      'data-color': color,
    });
    sw.addEventListener('click', () => commit(color, true));
    grid.append(sw);
  }

  /* 最近使用 */
  const renderRecent = () => {
    const list = readRecentColors().slice(0, 8);
    recentWrap.replaceChildren();
    if (!list.length) {
      recentWrap.classList.add('is-empty');
      return;
    }
    recentWrap.classList.remove('is-empty');
    recentWrap.append(h('span', { class: 'cp-recent-label' }, '最近'));
    for (const color of list) {
      const sw = h('button', {
        class: 'cp-swatch cp-swatch--sm',
        type: 'button',
        title: color,
        style: { background: color },
        'data-color': color,
      });
      sw.addEventListener('click', () => commit(color, true));
      recentWrap.append(sw);
    }
  };

  /* Alpha 滑杆 */
  let alphaRow = null;
  if (allowAlpha) {
    const range = h('input', {
      class: 'cp-alpha-range',
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round(state.alpha * 100)),
      'aria-label': '不透明度',
    });
    const valueLabel = h('span', { class: 'cp-alpha-value' }, `${Math.round(state.alpha * 100)}%`);
    range.addEventListener('input', () => {
      state.alpha = Math.min(1, Math.max(0, Number(range.value) / 100));
      valueLabel.textContent = `${range.value}%`;
      syncPreview();
      emit();
    });
    alphaRow = h('div', { class: 'cp-alpha' }, h('span', { class: 'cp-alpha-label' }, '透明'), range, valueLabel);
  }

  const noneBtn = h('button', { class: 'cp-none', type: 'button' }, '无填充');
  noneBtn.addEventListener('click', () => {
    try {
      onChange?.('transparent');
    } catch (err) {
      console.error('[overlay] colorPicker onChange 失败', err);
    }
    handle?.close();
  });
  foot.append(noneBtn);

  const content = h(
    'div',
    { class: `cp ${className}`.trim() },
    head,
    grid,
    recentWrap,
    alphaRow,
    foot,
  );

  renderRecent();
  syncPreview();

  handle = popover({
    anchor,
    content,
    width: allowAlpha ? 322 : 298,
    placement: 'bottom-start',
    className: 'popover--color',
    label: '颜色选择',
    onClose: renderRecent,
  });
  return handle;
}

/* ============================================================
   工具提示（全局委托 [data-tip]）
   ============================================================ */

function ensureTooltip() {
  if (tooltipEl && tooltipEl.isConnected) return tooltipEl;
  tooltipEl = h('div', { class: 'tip', role: 'tooltip' });
  document.body.append(tooltipEl);
  return tooltipEl;
}

function positionTooltip(el, target) {
  const rect = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const pos = target.getAttribute('data-tip-pos') || 'auto';
  let top = rect.top - ht - 8;
  let below = false;
  if (pos === 'bottom' || top < 6) {
    top = rect.bottom + 8;
    below = true;
  }
  let left = rect.left + rect.width / 2 - w / 2;
  left = clamp(left, 6, vw - w - 6);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.setProperty('--tip-arrow-x', `${Math.round(rect.left + rect.width / 2 - left)}px`);
  el.classList.toggle('is-below', below);
}

function hideTip(immediate = false) {
  if (tipTimer) {
    clearTimeout(tipTimer);
    tipTimer = 0;
  }
  tipTarget = null;
  if (!tooltipEl) return;
  if (immediate || motionOff()) {
    tooltipEl.classList.remove('is-on');
    return;
  }
  tooltipEl.classList.remove('is-on');
}

function showTipNow(target) {
  const raw = target.getAttribute('data-tip');
  if (!raw) return;
  const parts = String(raw).split('|');
  const text = parts[0].trim();
  const kbd = (target.getAttribute('data-tip-kbd') || parts[1] || '').trim();
  if (!text) return;
  tipTarget = target;
  const el = ensureTooltip();
  const parts2 = [h('span', { class: 'tip-text' }, text)];
  if (kbd) parts2.push(h('span', { class: 'kbd' }, kbd));
  el.replaceChildren(...parts2);
  el.classList.remove('is-on');
  positionTooltip(el, target);
  /* 强制 reflow 后再上淡入 class，保证动画生效 */
  void el.offsetWidth;
  el.classList.add('is-on');
}

function scheduleTip(target) {
  if (tipTimer) {
    clearTimeout(tipTimer);
    tipTimer = 0;
  }
  if (target === tipTarget) return;
  hideTip();
  tipTimer = setTimeout(() => {
    tipTimer = 0;
    if (!target.isConnected) return;
    showTipNow(target);
  }, TIP_DELAY);
}

function bindTooltip() {
  if (tipBound) return;
  tipBound = true;

  document.addEventListener('pointerover', (e) => {
    const target = e.target?.closest?.('[data-tip]');
    if (!target) {
      if (tipTarget) hideTip();
      return;
    }
    if (target === tipTarget) return;
    if (tooltipEl && tooltipEl.contains(e.target)) return;
    scheduleTip(target);
  }, true);

  document.addEventListener('pointerout', (e) => {
    const target = e.target?.closest?.('[data-tip]');
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    if (target === tipTarget || tipTimer) hideTip();
  }, true);

  document.addEventListener('pointerdown', () => hideTip(true), true);
  document.addEventListener('keydown', () => hideTip(true), true);
  document.addEventListener('scroll', () => hideTip(true), true);
  window.addEventListener('blur', () => hideTip(true));
  window.addEventListener('resize', () => hideTip(true));
}

/* ============================================================
   全局监听
   ============================================================ */

function onGlobalPointerDown(e) {
  if (!layers.length) return;
  const target = e.target;
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    if (layers[i].el.contains(target)) {
      while (layers.length - 1 > i) {
        const top = layers[layers.length - 1];
        if (top.closable === false) break;
        forceRemove(top);
      }
      return;
    }
  }
  closeAll();
}

function onGlobalKeyDown(e) {
  if (!layers.length) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    const top = layers[layers.length - 1];
    if (top) forceRemove(top);
    return;
  }
  const top = layers[layers.length - 1];
  if (top?.kind === 'menu' && top.onKey) top.onKey(e);
}

function onGlobalResize() {
  hideTip(true);
  for (const layer of layers) layer.reposition?.();
}

function onGlobalScroll(e) {
  if (!layers.length) return;
  const target = e.target;
  if (target instanceof Element && layers.some((l) => l.el.contains(target))) return;
  closeMenus();
}

function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  document.addEventListener('pointerdown', onGlobalPointerDown, true);
  document.addEventListener('keydown', onGlobalKeyDown, true);
  document.addEventListener('scroll', onGlobalScroll, true);
  window.addEventListener('resize', onGlobalResize);
}

/* ============================================================
   对外 API
   ============================================================ */

const api = {
  menu,
  popover,
  colorPicker,
  close: closeAll,
  closeMenus,
  closePopovers,
  isOpen: () => layers.length > 0,
  tooltip(target, text) {
    if (text != null && target) target.setAttribute('data-tip', text);
    if (target) showTipNow(target);
  },
  hideTooltip: () => hideTip(true),
  swatches: SWATCHES,
  parseColor,
};

export async function init(ctx) {
  ctxRef = ctx;
  bindGlobals();
  bindTooltip();
  ctx.overlay = api;
  return api;
}

export default api;
