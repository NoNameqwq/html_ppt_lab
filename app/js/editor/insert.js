/* 插入：文本框 / 图片（上传·URL·拖放·粘贴）/ 形状 / 图标 / 原始 HTML */

import { api } from '../core/api.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h, isTypingTarget } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { dialog } from '../core/dialog.js';
import { icon } from '../ui/icons.js';
import { initRichAuthoring } from './rich-authoring.js';

let ctx = null;
let dropBound = false;
let pasteBound = false;

const ICON_CHOICES = [
  'sparkles', 'zap', 'star', 'heart', 'flag', 'bell', 'globe', 'layers',
  'cpu', 'wrench', 'brain', 'wand', 'link', 'message', 'user', 'image',
  'film', 'monitor', 'calendar', 'clock', 'folder', 'file-text', 'code', 'terminal',
  'arrow-right', 'arrow-up-right', 'check-circle', 'search', 'settings', 'palette',
];

export async function init(context) {
  ctx = context;
  bindCanvasDrop();
  bindPaste();
  bindEvents();
  registerCommands();
  initRichAuthoring(ctx);
}

function getBridge() {
  return ctx?.getEditor?.()?.bridge || null;
}

function deckSize() {
  const deck = store.get().deck;
  return { w: deck.w || 1920, h: deck.h || 1080 };
}

function centerBox(w, hgt) {
  const { w: W, h: H } = deckSize();
  return { x: Math.round((W - w) / 2), y: Math.round((H - hgt) / 2) };
}

function getSelection() {
  return store.get().selection;
}

function publishSelection(selection) {
  if (!selection) return;
  store.update((s) => { s.selection = selection; });
  bus.emit('selection:change', { selection });
}

async function selectInserted(res, options = {}) {
  if (!res?.elementId) return;
  const bridge = getBridge();
  try {
    const selection = await bridge.select(res.elementId);
    if (selection?.elementId) publishSelection(selection);
  } catch (err) {
    console.warn('[insert] 选中新元素失败', err);
  }
  if (options.beginText) bus.emit('editor:begin-text', { elementId: res.elementId });
}

/* ================= 文本框 ================= */

async function insertText(payload = {}) {
  const bridge = getBridge();
  if (!bridge?.ready) { toast('画布尚未就绪'); return { ok: false }; }
  const w = Math.max(80, Number(payload.w) || 640);
  const hgt = Math.max(40, Number(payload.h) || 132);
  const pos = payload.at || centerBox(w, hgt);
  const text = payload.html || payload.text || '双击输入文字';
  const styles = {
    'font-size': payload.fontSize || '48px',
    'line-height': payload.lineHeight || '1.35',
    'color': payload.color || 'var(--wpx-fg)',
    'font-family': payload.fontFamily || 'var(--wpx-serif)',
  };
  try {
    const res = await bridge.insertElement({
      type: 'text',
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w,
      text,
      html: text,
      styles,
    });
    await selectInserted(res, { beginText: true });
    return { ok: true, elementId: res?.elementId };
  } catch (err) {
    toast.error('插入文本框失败：' + (err?.message || err));
    return { ok: false };
  }
}

/* ================= 图片 ================= */

function safeFileName(name) {
  const base = String(name || 'image.png').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + '.png';
}

async function uploadImage(file) {
  const ed = ctx?.getEditor?.();
  const projectId = ed?.projectId;
  if (!projectId) throw new Error('未打开工程');
  if (!file) throw new Error('没有可上传的图片');
  if (file.size > 30 * 1024 * 1024) throw new Error('图片超过 30MB，请压缩后再插入');
  const res = await api.uploadAssetBlob(projectId, safeFileName(file.name), file);
  const url = res?.url;
  if (!url) throw new Error('上传接口没有返回资源地址');
  return url;
}

function absoluteAssetUrl(src) {
  if (!src) return src;
  if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
  const ed = ctx?.getEditor?.();
  if (!ed?.projectId) return src;
  return api.projectFileUrl(ed.projectId, src);
}

function measureImage(src, payload = {}) {
  return new Promise((resolve) => {
    if (payload.w && payload.h) {
      resolve({ w: Math.round(Number(payload.w)), h: Math.round(Number(payload.h)) });
      return;
    }
    const maxW = Math.min(1120, deckSize().w * 0.6);
    const maxH = Math.min(760, deckSize().h * 0.62);
    const img = new Image();
    img.onload = () => {
      const naturalW = img.naturalWidth || maxW;
      const naturalH = img.naturalHeight || maxH;
      const ratio = naturalW / naturalH || 16 / 9;
      let w = Math.min(naturalW, maxW);
      let hgt = w / ratio;
      if (hgt > maxH) { hgt = maxH; w = hgt * ratio; }
      resolve({ w: Math.round(w), h: Math.round(hgt) });
    };
    img.onerror = () => resolve({ w: Number(payload.w) || 900, h: Number(payload.h) || 506 });
    img.src = absoluteAssetUrl(src);
  });
}

async function insertImageAt(src, at) {
  const bridge = getBridge();
  if (!bridge?.ready) return { ok: false };
  const size = await measureImage(src, {});
  const pos = at || centerBox(size.w, size.h);
  try {
    const res = await bridge.insertElement({
      type: 'image',
      src,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w: size.w,
      h: size.h,
      objectFit: 'cover',
    });
    await selectInserted(res);
    return { ok: true, elementId: res?.elementId };
  } catch (err) {
    toast.error('插入图片失败：' + (err?.message || err));
    return { ok: false };
  }
}

function pickImage() {
  return new Promise((resolve) => {
    const state = { file: null, url: '' };
    const fileInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const dropLabel = h('div', { class: 'insert-drop-text' }, '点击选择图片，或把图片拖到这里');
    const drop = h('div', { class: 'insert-drop' },
      h('span', { class: 'insert-drop-icon', html: icon('image-plus', 26) }),
      dropLabel,
    );
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      state.file = fileInput.files?.[0] || null;
      if (state.file) dropLabel.textContent = state.file.name;
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      state.file = file;
      dropLabel.textContent = file.name;
    });
    const urlInput = h('input', { class: 'input', placeholder: '或粘贴图片链接（https://… / data:image/…）' });
    urlInput.addEventListener('input', () => { state.url = urlInput.value.trim(); });
    const body = h('div', { class: 'insert-image-dialog' },
      drop,
      fileInput,
      h('div', { class: 'insert-or' }, '或'),
      urlInput,
      h('div', { class: 'insert-tip' }, '图片会上传到工程 assets/ 目录；也支持直接拖到画布或 Ctrl+V 粘贴。'),
    );
    dialog.open({
      title: '插入图片',
      sub: '从本地选择、粘贴链接，或直接拖入画布',
      width: 'md',
      body,
      actions: [
        { label: '取消', value: null, kind: 'ghost' },
        {
          label: '插入',
          kind: 'primary',
          onClick: async () => {
            if (state.file) {
              try { return { src: await uploadImage(state.file) }; } catch (err) { toast.error('上传失败：' + (err?.message || err)); return false; }
            }
            if (state.url) return { src: state.url };
            toast.warn('请选择图片文件或填写图片链接');
            return false;
          },
        },
      ],
    }).then((result) => resolve(result?.src || null));
  });
}

async function insertImage(payload = {}) {
  const bridge = getBridge();
  if (!bridge?.ready) { toast('画布尚未就绪'); return { ok: false }; }
  let src = payload.src || payload.url || null;
  if (src === '__pick__') src = null;
  if (!src) src = await pickImage();
  if (!src) return { ok: false };
  return insertImageAt(src, payload.at || null);
}

/* ================= 形状 ================= */

const SHAPES = {
  rect: { label: '矩形', w: 440, h: 260, fill: 'var(--wpx-accent,#E1402B)' },
  roundRect: { label: '圆角矩形', w: 440, h: 260, fill: 'var(--wpx-accent,#E1402B)', radius: 24 },
  ellipse: { label: '椭圆', w: 340, h: 340, fill: 'var(--wpx-accent,#E1402B)' },
  circle: { label: '圆形', w: 320, h: 320, fill: 'var(--wpx-accent,#E1402B)' },
  triangle: { label: '三角形', w: 380, h: 330, fill: 'var(--wpx-accent,#E1402B)' },
  arrow: { label: '箭头', w: 420, h: 160, fill: 'var(--wpx-fg,#F2EAE0)' },
  star: { label: '星形', w: 340, h: 340, fill: 'var(--wpx-accent,#E1402B)' },
  hexagon: { label: '六边形', w: 360, h: 320, fill: 'var(--wpx-accent,#E1402B)' },
  line: { label: '线', w: 420, h: 2, fill: 'var(--wpx-fg,#F2EAE0)' },
};

function normalizeShapeKey(raw) {
  const key = String(raw || 'rect');
  if (key === 'square') return 'rect';
  if (key === 'circle') return 'ellipse';
  return SHAPES[key] ? key : 'rect';
}

async function insertShape(payload = {}) {
  const bridge = getBridge();
  if (!bridge?.ready) { toast('画布尚未就绪'); return { ok: false }; }
  const key = normalizeShapeKey(payload.shape || payload.value);
  const def = SHAPES[key];
  const pos = payload.at || centerBox(def.w, def.h);
  try {
    const res = await bridge.insertElement({
      type: 'shape',
      shape: key,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w: def.w,
      h: def.h,
      fill: def.fill,
      radius: def.radius,
      strokeWidth: def.strokeWidth,
    });
    await selectInserted(res);
    return { ok: true, elementId: res?.elementId };
  } catch (err) {
    toast.error('插入形状失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function insertLine(payload = {}) {
  return insertShape({ ...payload, shape: 'line' });
}

/* ================= 图标 ================= */

function pickIcon() {
  return new Promise((resolve) => {
    const grid = h('div', { class: 'insert-icon-grid' });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const name of ICON_CHOICES) {
      const btn = h('button', { class: 'insert-icon-cell', title: name, html: icon(name, 22) });
      btn.addEventListener('click', () => {
        finish(name);
        // 关闭弹窗：找到最近的 modal-wrap 并触发取消
        document.querySelector('.modal-wrap .modal-close')?.click();
      });
      grid.append(btn);
    }
    const body = h('div', null, grid, h('div', { class: 'insert-tip' }, '图标是内联 SVG，会作为一个可选中、可缩放的 HTML 元素插入。'));
    dialog.open({
      title: '插入图标',
      sub: '选择一个图标放到当前页中央',
      width: 'md',
      body,
      actions: [{ label: '取消', value: null, kind: 'ghost' }],
    }).then(() => finish(null));
  });
}

async function insertIcon(payload = {}) {
  const bridge = getBridge();
  if (!bridge?.ready) { toast('画布尚未就绪'); return { ok: false }; }
  let name = payload.name || payload.icon || null;
  if (!name) name = await pickIcon();
  if (!name) return { ok: false };
  const size = Math.max(24, Number(payload.size) || 120);
  const pos = payload.at || centerBox(size, size);
  const svg = icon(name, Math.round(size * 0.8), { strokeWidth: 1.6 });
  const html = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--wpx-accent)">${svg}</div>`;
  try {
    const res = await bridge.insertElement({
      type: 'html',
      html,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w: size,
      h: size,
    });
    await selectInserted(res);
    return { ok: true, elementId: res?.elementId };
  } catch (err) {
    toast.error('插入图标失败：' + (err?.message || err));
    return { ok: false };
  }
}

/* ================= 原始 HTML ================= */

async function insertHtml(payload = {}) {
  const bridge = getBridge();
  if (!bridge?.ready) { toast('画布尚未就绪'); return { ok: false }; }
  let html = payload.html || payload.value || payload.code || '';
  if (!String(html).trim()) {
    html = await dialog.prompt('插入 HTML 片段', {
      multiline: true,
      placeholder: '<div style="padding:24px;border:1px solid var(--wpx-line)">你的内容</div>',
      sub: '代码会作为一个元素插入到当前页中央，位置/尺寸可在右侧属性面板调整',
      okLabel: '插入',
    });
  }
  if (!html || !String(html).trim()) return { ok: false };
  const w = Math.max(80, Number(payload.w) || 800);
  const hgt = Math.max(40, Number(payload.h) || 320);
  const pos = payload.at || centerBox(w, hgt);
  try {
    const res = await bridge.insertElement({
      type: 'html',
      html: String(html).trim(),
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w,
      h: hgt,
    });
    await selectInserted(res);
    return { ok: true, elementId: res?.elementId };
  } catch (err) {
    toast.error('插入 HTML 失败：' + (err?.message || err));
    return { ok: false };
  }
}

/* ================= 拖放 / 粘贴 ================= */

function bindCanvasDrop() {
  if (dropBound) return;
  const area = document.getElementById('canvas-area');
  if (!area) return;
  dropBound = true;
  let depth = 0;
  area.addEventListener('dragenter', (e) => {
    if (!hasImageFiles(e)) return;
    e.preventDefault();
    depth += 1;
    area.classList.add('is-drop-target');
  });
  area.addEventListener('dragover', (e) => {
    if (!hasImageFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  area.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) area.classList.remove('is-drop-target');
  });
  area.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    depth = 0;
    area.classList.remove('is-drop-target');
    const ed = ctx?.getEditor?.();
    const at = ed?.clientToDesign(e.clientX, e.clientY);
    for (const file of files) {
      try {
        const src = await uploadImage(file);
        await insertImageAt(src, at);
      } catch (err) {
        toast.error('拖入图片失败：' + (err?.message || err));
      }
    }
  });
}

function hasImageFiles(e) {
  const items = e.dataTransfer?.items;
  if (!items) return false;
  return [...items].some((item) => item.kind === 'file' && item.type.startsWith('image/'));
}

function bindPaste() {
  if (pasteBound) return;
  pasteBound = true;
  window.addEventListener('paste', async (e) => {
    if (ctx?.route?.name !== 'editor') return;
    if (isTypingTarget(e.target)) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [...items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      try {
        const src = await uploadImage(file);
        await insertImageAt(src, null);
      } catch (err) {
        toast.error('粘贴图片失败：' + (err?.message || err));
      }
    }
  });
}

function bindEvents() {
  // iframe 内按 Ctrl+V 时由 bridge 转发 → edit.paste → 剪贴板为空时发出该事件
  bus.on('editor:paste', async () => {
    try {
      const items = await navigator.clipboard?.read?.();
      const imageItem = (items || []).find((item) => item.types.some((t) => t.startsWith('image/')));
      if (!imageItem) { toast('剪贴板里没有可插入的图片'); return; }
      const type = imageItem.types.find((t) => t.startsWith('image/'));
      const blob = await imageItem.getType(type);
      const file = new File([blob], 'pasted.png', { type });
      const src = await uploadImage(file);
      await insertImageAt(src, null);
    } catch {
      toast('剪贴板里没有可插入的图片');
    }
  });
}

/* ================= 命令注册 ================= */

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload || {}); } catch (err) {
      console.error('[insert] 命令失败', name, err);
      toast.error('插入失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('insert.text', { label: '文本框', group: '插入', icon: 'text-box' }, (payload) => insertText(payload));
  reg('insert.image', { label: '图片', group: '插入', icon: 'image' }, (payload) => insertImage(payload));
  reg('insert.shape', { label: '形状', group: '插入', icon: 'shapes' }, (payload) => insertShape(payload));
  reg('insert.line', { label: '线条', group: '插入', icon: 'line' }, (payload) => insertLine(payload));
  reg('insert.icon', { label: '图标', group: '插入', icon: 'sparkles' }, (payload) => insertIcon(payload));
  reg('insert.html', { label: 'HTML 片段', group: '插入', icon: 'code' }, (payload) => insertHtml(payload));
}
