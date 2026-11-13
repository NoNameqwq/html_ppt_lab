/* 文字：双击进入内容编辑、Esc/点空白提交；Ribbon 文字命令（编辑中走 execTextCommand，否则改 inline style） */

import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { toast } from '../core/toast.js';

let ctx = null;
let editingId = null;
let areaEl = null;
let unsubs = [];

export async function init(context) {
  ctx = context;
  areaEl = document.getElementById('canvas-area');
  if (areaEl) areaEl.addEventListener('pointerdown', onAreaPointerDown, true);
  bindEvents();
  registerCommands();
}

function getBridge() {
  return ctx?.getEditor?.()?.bridge || null;
}

function selection() {
  return store.get().selection;
}

function isEditing() {
  return !!editingId;
}

/* ================= 进入 / 退出文字编辑 ================= */

async function beginEdit(elementId) {
  const bridge = getBridge();
  if (!bridge?.ready || !elementId) return { ok: false };
  if (editingId === elementId) return { ok: true };
  if (editingId) await endEdit({ silent: true });
  try {
    const res = await bridge.beginTextEdit(elementId);
    if (res && res.ok === false) return { ok: false };
  } catch (err) {
    console.warn('[text] 进入文字编辑失败', err);
    return { ok: false };
  }
  editingId = elementId;
  bus.emit('editor:text-editing', { editing: true, elementId });
  return { ok: true };
}

async function endEdit(options = {}) {
  if (!editingId) return { ok: true };
  const id = editingId;
  editingId = null;
  bus.emit('editor:text-editing', { editing: false, elementId: id });
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: true };
  try {
    const res = await bridge.endTextEdit();
    if (res?.op?.opId) {
      // 兜底：bridge 若未发 change 事件，这里补一次（recordOp 会按 opId 去重）
      ctx?.getEditor?.()?.recordOp?.(res.op);
    }
  } catch (err) {
    if (!options.silent) console.warn('[text] 结束文字编辑失败', err);
  }
  return { ok: true };
}

function onAreaPointerDown(e) {
  if (!editingId) return;
  const target = e.target;
  if (target?.closest?.('#canvas-toolbar, #canvas-hint, #selection-layer')) return;
  endEdit();
}

function bindEvents() {
  unsubs.push(bus.on('editor:begin-text', ({ elementId } = {}) => {
    if (elementId) beginEdit(elementId);
  }));
  unsubs.push(bus.on('editor:escape', () => {
    if (editingId) endEdit();
  }));
  unsubs.push(bus.on('editor:end-text', () => { endEdit(); }));
  // bridge 自己结束编辑（点击元素外部等）时同步本地状态
  unsubs.push(bus.on('editor:text-editing', ({ editing } = {}) => {
    if (!editing) editingId = null;
  }));
  unsubs.push(bus.on('deck:unload', () => { editingId = null; }));
}

/* ================= 格式命令 ================= */

function currentStyles() {
  return selection()?.styles || {};
}

function textDecorationSet() {
  const styles = currentStyles();
  const raw = String(styles.textDecorationLine || styles.textDecoration || 'none').toLowerCase();
  return new Set(raw.split(/\s+/).filter((v) => v && v !== 'none'));
}

function buildDecoration(add, remove) {
  const set = textDecorationSet();
  if (add) {
    if (set.has(add)) set.delete(add);
    else set.add(add);
  }
  if (remove) set.delete(remove);
  return set.size ? [...set].join(' ') : 'none';
}

/**
 * 统一入口：编辑中 → bridge.execTextCommand；否则 → setStyles(inline style)
 */
async function applyTextCommand({ command, value, styles }) {
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false, error: '画布尚未就绪' };
  const sel = selection();

  if (isEditing()) {
    try {
      const res = await bridge.execTextCommand(command, value);
      if (!res || res.ok !== false) return { ok: true, mode: 'exec' };
      console.warn('[text] execTextCommand 被拒绝，降级为元素样式', command, res?.error);
    } catch (err) {
      console.warn('[text] execTextCommand 失败，降级为元素样式', command, err);
    }
  }
  if (!sel?.elementId) {
    toast('请先选中一个元素');
    return { ok: false };
  }
  const styleMap = typeof styles === 'function' ? styles() : styles;
  if (!styleMap || !Object.keys(styleMap).length) return { ok: false };
  try {
    await bridge.setStyles(sel.elementId, styleMap);
    return { ok: true, mode: 'style' };
  } catch (err) {
    toast.error('修改文字样式失败：' + (err?.message || err));
    return { ok: false };
  }
}

function openTextPanel() {
  store.update((s) => { s.ui.inspectorOpen = true; });
  bus.emit('inspector:focus', { group: 'text' });
  return { ok: true };
}

function valueOf(payload, key) {
  if (payload == null) return undefined;
  if (typeof payload === 'object') return payload[key] ?? payload.value ?? payload[key === 'family' ? 'fontFamily' : key];
  return payload;
}

/* ================= 命令注册 ================= */

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload); } catch (err) {
      console.error('[text] 命令失败', name, err);
      toast.error('操作失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('text.bold', { label: '加粗', group: '文字', icon: 'bold', shortcut: 'Ctrl+B' }, () => {
    const heavy = ['bold', '700', '800', '900'].includes(String(currentStyles().fontWeight || '').toLowerCase());
    return applyTextCommand({ command: 'bold', styles: { 'font-weight': heavy ? '400' : '700' } });
  });

  reg('text.italic', { label: '斜体', group: '文字', icon: 'italic', shortcut: 'Ctrl+I' }, () => {
    const italic = String(currentStyles().fontStyle || '').toLowerCase() === 'italic';
    return applyTextCommand({ command: 'italic', styles: { 'font-style': italic ? 'normal' : 'italic' } });
  });

  reg('text.underline', { label: '下划线', group: '文字', icon: 'underline', shortcut: 'Ctrl+U' }, () => {
    return applyTextCommand({ command: 'underline', styles: () => ({ 'text-decoration': buildDecoration('underline', 'line-through') }) });
  });

  reg('text.strike', { label: '删除线', group: '文字', icon: 'strike' }, () => {
    return applyTextCommand({ command: 'strikeThrough', styles: () => ({ 'text-decoration': buildDecoration('line-through', 'underline') }) });
  });

  reg('text.fontFamily', { label: '字体', group: '文字', icon: 'type' }, (payload) => {
    const family = valueOf(payload, 'family') ?? valueOf(payload, 'fontFamily');
    if (!family) return openTextPanel();
    return applyTextCommand({ command: 'fontFamily', value: family, styles: { 'font-family': family } });
  });

  reg('text.fontSize', { label: '字号', group: '文字', icon: 'text' }, (payload) => {
    const raw = valueOf(payload, 'size') ?? valueOf(payload, 'fontSize');
    if (raw == null || raw === '') return openTextPanel();
    const size = Number(String(raw).replace(/[^\d.]/g, '')) || 32;
    return applyTextCommand({ command: 'fontSize', value: size + 'px', styles: { 'font-size': size + 'px' } });
  });

  reg('text.color', { label: '字体颜色', group: '文字', icon: 'droplet' }, (payload) => {
    const color = valueOf(payload, 'color');
    if (!color) return openTextPanel();
    return applyTextCommand({ command: 'foreColor', value: color, styles: { color } });
  });

  reg('text.highlight', { label: '文字高亮', group: '文字', icon: 'palette' }, (payload) => {
    const color = valueOf(payload, 'color');
    if (!color) return openTextPanel();
    return applyTextCommand({ command: 'backColor', value: color, styles: { 'background-color': color } });
  });

  reg('text.align', { label: '对齐', group: '文字', icon: 'align-left' }, (payload) => {
    const raw = valueOf(payload, 'align');
    if (!raw) return openTextPanel();
    const align = ['left', 'center', 'right', 'justify'].includes(raw) ? raw : 'left';
    const execMap = { left: 'justifyLeft', center: 'justifyCenter', right: 'justifyRight', justify: 'justifyFull' };
    return applyTextCommand({ command: execMap[align], value: null, styles: { 'text-align': align } });
  });

  reg('text.lineHeight', { label: '行高', group: '文字', icon: 'line-height' }, (payload) => {
    const raw = valueOf(payload, 'value') ?? valueOf(payload, 'lineHeight');
    if (raw == null || raw === '') return openTextPanel();
    const value = Number(raw) || 1.4;
    return applyTextCommand({ command: 'lineHeight', value, styles: { 'line-height': String(value) } });
  });

  reg('text.letterSpacing', { label: '字距', group: '文字', icon: 'letter-spacing' }, (payload) => {
    const raw = valueOf(payload, 'value') ?? valueOf(payload, 'letterSpacing');
    if (raw == null || raw === '') return openTextPanel();
    const value = Number(raw) || 0;
    return applyTextCommand({ command: 'letterSpacing', value: value + 'px', styles: { 'letter-spacing': value + 'px' } });
  });

  reg('text.style', { label: '文字属性', group: '文字', icon: 'sliders' }, () => openTextPanel());
}
