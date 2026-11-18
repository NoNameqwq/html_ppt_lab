/* 右侧属性面板：布局 / 文字 / 填充描边 / 图片 / 动画摘要，双向绑定 bridge setStyles / setAttrs / resizeElement */

import { api } from '../core/api.js';
import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h, debounce, clamp } from '../core/dom.js';
import { toast } from '../core/toast.js';

const SHADOWS = {
  none: 'none',
  soft: '0 4px 14px rgba(0, 0, 0, .14)',
  medium: '0 14px 36px rgba(0, 0, 0, .24)',
  strong: '0 28px 72px rgba(0, 0, 0, .36)',
};
const FONT_OPTIONS = [
  ['var(--wpx-serif)', '衬线标题'],
  ['var(--wpx-sans)', '无衬线正文'],
  ['var(--wpx-latin)', '英文衬线'],
  ['"Microsoft YaHei", "PingFang SC", sans-serif', '微软雅黑'],
  ['SimSun, "Songti SC", serif', '宋体'],
  ['"Cascadia Code", Consolas, monospace', '等宽代码'],
];

let ctx = null;
let root = null;
let emptyEl = null;
let groupsEl = null;
let footEl = null;
let refs = {};
let sections = {};
let groupOpen = { layout: true, text: true, fill: true, image: true, anim: false };
let unsubs = [];
let lockCheckedFor = null;
let lockedNow = false;

/* ================= 初始化 ================= */

export async function init(context) {
  ctx = context;
  root = document.getElementById('inspector');
  if (!root) return;
  build();
  bindEvents();
  registerCommands();
  refresh();
}

function getBridge() {
  return ctx?.getEditor?.()?.bridge || null;
}

function current() {
  return store.get().selection;
}

/* ================= DOM 构建 ================= */

function build() {
  root.innerHTML = '';
  const collapseBtn = h('button', {
    class: 'icon-btn icon-btn--sm insp-collapse',
    title: '收起属性面板',
    html: ctx.icon('chevron-right', 15),
    onclick: () => bus.runCommand('app.toggleInspector'),
  });
  root.append(
    h('div', { class: 'insp-head' },
      h('div', { class: 'insp-title' }, '属性'),
      refs.modeBadge = h('span', { class: 'insp-mode-badge is-hidden', title: '网页工程：直接编辑网页 DOM，动画与切换保留' }, '网页'),
      h('div', { class: 'grow' }),
      collapseBtn),
    h('div', { class: 'insp-body-wrap' },
      h('div', { class: 'insp-body' },
        emptyEl = h('div', { class: 'insp-empty' },
          h('span', { class: 'insp-empty-icon', html: ctx.icon('mouse-pointer', 22) }),
          h('div', null, '在画布上选中一个元素'),
          h('div', { class: 'insp-empty-sub' }, '这里会显示它的位置、尺寸、文字与填充属性')),
        groupsEl = h('div', { class: 'insp-groups' }),
        footEl = h('div', { class: 'insp-foot is-hidden' }))));
  buildGroups(groupsEl);
}

function buildGroups(container) {
  const layout = makeGroup('layout', '布局', 'square');
  buildLayoutGroup(layout.body);
  const text = makeGroup('text', '文字', 'type');
  buildTextGroup(text.body);
  const fill = makeGroup('fill', '填充与描边', 'droplet');
  buildFillGroup(fill.body);
  const image = makeGroup('image', '图片', 'image');
  buildImageGroup(image.body);
  const anim = makeGroup('anim', '动画摘要', 'zap');
  buildAnimGroup(anim.body);
  sections = { layout, text, fill, image, anim };
  container.append(layout.section, text.section, fill.section, image.section, anim.section);
}

function makeGroup(id, label, iconName) {
  const opened = groupOpen[id] !== false;
  const body = h('div', { class: 'insp-group-body' });
  const section = h('section', {
    class: 'insp-group' + (opened ? ' is-open' : ''),
    dataset: { group: id },
  });
  const head = h('button', {
    class: 'insp-group-head',
    onclick: () => {
      groupOpen[id] = !groupOpen[id];
      section.classList.toggle('is-open', groupOpen[id]);
    },
  },
  h('span', { class: 'insp-group-icon', html: ctx.icon(iconName, 14) }),
  h('span', { class: 'insp-group-label' }, label),
  h('span', { class: 'insp-caret', html: ctx.icon('chevron-down', 13) }));
  section.append(head, body);
  return { section, body, id };
}

function row(...children) {
  return h('div', { class: 'insp-row' }, ...children);
}

function field(label, control, extraClass = '') {
  return h('label', { class: 'insp-field ' + extraClass },
    h('span', { class: 'insp-label' }, label), control);
}

function numberInput(opts = {}) {
  const input = h('input', {
    class: 'input insp-input',
    type: 'number',
    step: opts.step ?? 1,
    min: opts.min,
    max: opts.max,
    title: opts.title || '',
  });
  const handler = () => { opts.onChange?.(input.value, input); };
  input.addEventListener('change', handler);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); handler(); input.blur(); }
    else if (e.key === 'Escape') { input.blur(); }
  });
  return input;
}

function colorInput(opts = {}) {
  const input = h('input', { class: 'insp-color', type: 'color', title: opts.title || '选择颜色' });
  const commit = debounce(() => { opts.onChange?.(input.value, input); }, 220);
  input.addEventListener('input', commit);
  input.addEventListener('change', () => { commit.cancel(); opts.onChange?.(input.value, input); });
  return input;
}

function selectInput(options, opts = {}) {
  const sel = h('select', { class: 'input insp-input insp-select' });
  for (const [value, label] of options) sel.append(h('option', { value }, label));
  sel.addEventListener('change', () => { opts.onChange?.(sel.value, sel); });
  return sel;
}

function segBtn(iconName, title, onClick) {
  const btn = h('button', { class: 'insp-seg-btn', title, html: ctx.icon(iconName, 15) });
  btn.addEventListener('click', onClick);
  return btn;
}

function iconActionBtn(iconName, title, onClick) {
  const btn = h('button', { class: 'insp-icon-btn', title, html: ctx.icon(iconName, 15) });
  btn.addEventListener('click', onClick);
  return btn;
}

/* ---------- 布局 ---------- */

function buildLayoutGroup(body) {
  refs.x = numberInput({ onChange: applyRect });
  refs.y = numberInput({ onChange: applyRect });
  refs.w = numberInput({ min: 8, onChange: applyRect });
  refs.h = numberInput({ min: 8, onChange: applyRect });
  refs.rotate = numberInput({ step: 1, onChange: applyRotate, title: '旋转角度（度）' });
  refs.opacityRange = h('input', { class: 'insp-range', type: 'range', min: 0, max: 100, step: 1 });
  refs.opacityNum = numberInput({ min: 0, max: 100, onChange: (value) => applyOpacity(Number(value), false) });
  const opacityCommit = debounce(() => applyOpacity(Number(refs.opacityRange.value), true), 200);
  refs.opacityRange.addEventListener('input', opacityCommit);
  refs.opacityRange.addEventListener('change', () => { opacityCommit.cancel(); applyOpacity(Number(refs.opacityRange.value), true); });

  body.append(
    row(field('X', refs.x), field('Y', refs.y)),
    row(field('W', refs.w), field('H', refs.h)),
    row(
      field('旋转', refs.rotate, 'insp-field--tight'),
      h('div', { class: 'insp-mini-group' },
        iconActionBtn('rotate', '向左旋转 90°', () => bus.runCommand('element.rotate', { delta: -90 })),
        iconActionBtn('refresh', '重置旋转', () => bus.runCommand('element.rotate', { deg: 0 }))),
    ),
    h('div', { class: 'insp-sub-label' }, '不透明度'),
    row(refs.opacityRange, h('div', { class: 'insp-opacity-num' }, refs.opacityNum, h('span', { class: 'insp-unit' }, '%'))),
    h('div', { class: 'insp-sub-label' }, '层级'),
    h('div', { class: 'insp-layer-btns' },
      iconActionBtn('bring-front', '置于顶层', () => bus.runCommand('arrange.front')),
      iconActionBtn('arrow-up', '上移一层', () => bus.runCommand('arrange.forward')),
      iconActionBtn('arrow-down', '下移一层', () => bus.runCommand('arrange.backward')),
      iconActionBtn('send-back', '置于底层', () => bus.runCommand('arrange.back'))),
    buildLockRow(),
  );
  refs.absoluteW=numberInput({min:1,title:'整体宽度（像素，包含内部文字与图形）',onChange:()=>applyAbsoluteSize('w')});
  refs.absoluteH=numberInput({min:1,title:'整体高度（像素，包含内部文字与图形）',onChange:()=>applyAbsoluteSize('h')});
  refs.absoluteW.setAttribute('aria-label','HTML 整体宽度');refs.absoluteH.setAttribute('aria-label','HTML 整体高度');
  refs.absoluteLock=h('input',{type:'checkbox',checked:true,'aria-label':'整体大小锁定比例'});
  refs.absoluteBox=h('div',{class:'insp-absolute-size'},h('div',{class:'insp-sub-label'},'整体绝对大小 · px'),row(field('宽',refs.absoluteW),field('高',refs.absoluteH)),h('label',{class:'insp-hint'},refs.absoluteLock,' 保持宽高比例'),h('div',{class:'insp-hint'},'文字、SVG 和内部图形一起缩放，原有布局宽高保留。'));
  body.append(refs.absoluteBox);
}

function buildLockRow() {
  refs.lockState = h('span', { class: 'insp-lock-state' }, '未锁定');
  refs.lockBtn = h('button', { class: 'btn btn--ghost btn--sm insp-lock-btn' }, '锁定');
  refs.lockBtn.addEventListener('click', () => toggleLock());
  return h('div', { class: 'insp-lock-row' },
    h('span', { class: 'insp-group-icon', html: ctx.icon('lock', 14) }),
    refs.lockState,
    h('div', { class: 'grow' }),
    refs.lockBtn);
}

/* ---------- 文字 ---------- */

function buildTextGroup(body) {
  refs.fontFamily = selectInput(FONT_OPTIONS, { onChange: applyFontFamily });
  refs.fontSize = numberInput({ min: 6, max: 400, onChange: applyFontSize });
  refs.lineHeight = numberInput({ step: 0.1, min: 0.6, max: 4, onChange: applyLineHeight });
  refs.letterSpacing = numberInput({ step: 0.5, onChange: applyLetterSpacing });
  refs.textColor = colorInput({ onChange: (v) => applyTextStyle({ color: v }), title: '文字颜色' });
  refs.highlight = colorInput({ onChange: (v) => applyTextStyle({ 'background-color': v }), title: '文字高亮' });
  refs.alignBtns = {};
  const alignGroup = h('div', { class: 'insp-seg' });
  const aligns = [['left', 'align-left', '左对齐'], ['center', 'align-center', '居中'], ['right', 'align-right', '右对齐'], ['justify', 'justify', '两端对齐']];
  for (const [value, iconName, title] of aligns) {
    const btn = segBtn(iconName, title, () => bus.runCommand('text.align', { align: value }));
    refs.alignBtns[value] = btn;
    alignGroup.append(btn);
  }
  body.append(
    row(field('字体', refs.fontFamily)),
    row(field('字号', refs.fontSize), field('行高', refs.lineHeight)),
    row(field('字距', refs.letterSpacing, 'insp-field--tight'), h('span', { class: 'insp-unit' }, 'px')),
    row(field('颜色', refs.textColor), field('高亮', refs.highlight)),
    row(h('span', { class: 'insp-label' }, '对齐'), alignGroup),
    h('div', { class: 'insp-hint' }, '编辑文字时，这些命令作用于选中的文字范围'),
  );
}

/* ---------- 填充与描边 ---------- */

function buildFillGroup(body) {
  refs.bgColor = colorInput({ onChange: applyBackground, title: '背景色' });
  refs.borderWidth = numberInput({ min: 0, max: 40, step: 0.5, onChange: applyBorder });
  refs.borderStyle = selectInput([
    ['none', '无边框'], ['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线'],
  ], { onChange: applyBorder });
  refs.borderColor = colorInput({ onChange: applyBorder, title: '边框颜色' });
  refs.radius = numberInput({ min: 0, max: 400, onChange: applyRadius });
  refs.shadow = selectInput([
    ['none', '无阴影'], ['soft', '轻微'], ['medium', '中等'], ['strong', '强烈'], ['custom', '自定义（保留）'],
  ], { onChange: applyShadow });
  body.append(
    row(field('背景', refs.bgColor),
      h('button', { class: 'btn btn--ghost btn--sm insp-clear-btn', onclick: () => applyTextStyle({ 'background-color': 'transparent' }) }, '透明')),
    row(field('边框', refs.borderWidth), field('样式', refs.borderStyle)),
    row(field('边框色', refs.borderColor), field('圆角', refs.radius)),
    row(field('阴影', refs.shadow)),
  );
}

/* ---------- 图片 ---------- */

function buildImageGroup(body) {
  refs.objectFit = selectInput([
    ['cover', '裁剪填充 cover'], ['contain', '适应 contain'], ['fill', '拉伸 fill'],
    ['none', '原始 none'], ['scale-down', '缩小 scale-down'],
  ], { onChange: (value) => applyStyle({ 'object-fit': value }) });
  refs.replaceInput = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  refs.replaceInput.addEventListener('change', () => {
    const file = refs.replaceInput.files?.[0];
    refs.replaceInput.value = '';
    if (file) replaceImage(file);
  });
  body.append(
    row(field('填充方式', refs.objectFit)),
    row(h('button', { class: 'btn btn--sm', onclick: () => refs.replaceInput.click() },
      h('span', { class: 'insp-btn-icon', html: ctx.icon('image-plus', 14) }), '替换图片'), refs.replaceInput),
    h('div', { class: 'insp-hint' }, '替换图片会上传到工程 assets/ 目录并保持当前尺寸'),
  );
}

/* ---------- 动画摘要 ---------- */

function buildAnimGroup(body) {
  refs.animName = h('div', { class: 'insp-anim-name' }, '未设置动画');
  refs.animMeta = h('div', { class: 'insp-anim-meta' }, '');
  body.append(
    refs.animName,
    refs.animMeta,
    row(
      h('button', { class: 'btn btn--sm', onclick: () => bus.emit('ui:tab', { tab: 'animations' }) }, '打开动效标签'),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => bus.runCommand('element.animationPreview') }, '预览')),
    row(
      h('button', { class: 'btn btn--ghost btn--sm', onclick: () => bus.runCommand('element.animationRemove') }, '移除动画')),
  );
}

/* ================= 事件 ================= */

function bindEvents() {
  unsubs.push(bus.on('selection:change', () => refresh()));
  unsubs.push(bus.on('editor:op', ({ op } = {}) => {
    if (op?.type === 'attr') lockCheckedFor = null; // 锁定状态可能被撤销/重做改变
    refresh();
  }));
  unsubs.push(bus.on('deck:change', () => refresh()));
  unsubs.push(bus.on('editor:ui', () => refresh()));
  unsubs.push(bus.on('inspector:focus', ({ group } = {}) => {
    if (group && sections[group]) {
      groupOpen[group] = true;
      sections[group].section.classList.add('is-open');
      sections[group].section.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    store.update((s) => { s.ui.inspectorOpen = true; });
  }));
}

/* ================= 刷新 ================= */

export function refresh() {
  if (!root || !emptyEl) return;
  const deck = store.get().deck || {};
  const raw = deck.raw === true || deck.mode === 'raw';
  if (refs.modeBadge) refs.modeBadge.classList.toggle('is-hidden', !raw);
  const selection = current();
  const has = !!selection?.elementId;
  emptyEl.classList.toggle('is-hidden', has);
  groupsEl.classList.toggle('is-hidden', !has);
  footEl.classList.toggle('is-hidden', !has);
  if (!has) return;

  const isText = selection.type === 'text' || selection.canEditText;
  const isImage = selection.type === 'image';
  sections.text.section.classList.toggle('is-hidden', !isText);
  sections.image.section.classList.toggle('is-hidden', !isImage);
  // 兼容模式没有原生动画数据，隐藏动画摘要组（原稿动画自动运行）
  sections.anim.section.classList.toggle('is-hidden', raw);

  updateLayout(selection);
  updateText(selection);
  updateFill(selection);
  updateImage(selection);
  updateAnim(selection);
  syncLockState(selection);

  footEl.innerHTML = '';
  footEl.append(
    h('span', { class: 'insp-foot-type' }, typeLabel(selection.type)),
    h('span', { class: 'insp-foot-id' }, selection.elementId || ''),
  );
}

function typeLabel(type) {
  return { text: '文字', image: '图片', shape: '形状', html: 'HTML', canvas: '画布' }[type] || '元素';
}

function setValue(input, value) {
  if (!input) return;
  if (document.activeElement === input) return;
  const next = value == null ? '' : String(value);
  if (input.value !== next) input.value = next;
}

function setSelect(select, value) {
  if (!select || document.activeElement === select) return;
  const target = String(value || '');
  const match = [...select.options].find((opt) => opt.value === target)
    || [...select.options].find((opt) => target && (target.includes(opt.value) || opt.value.includes(target)));
  if (match) select.value = match.value;
}

function setActive(btn, active) {
  if (btn) btn.classList.toggle('is-active', !!active);
}

function updateLayout(selection) {
  const rect = normalizeRect(selection.rect);
  setValue(refs.x, Math.round(rect.x));
  setValue(refs.y, Math.round(rect.y));
  setValue(refs.w, Math.round(rect.w));
  setValue(refs.h, Math.round(rect.h));
  setValue(refs.absoluteW,Math.round(rect.w));setValue(refs.absoluteH,Math.round(rect.h));
  refs.absoluteBox.classList.toggle('is-hidden',!['html','shape'].includes(selection.type));
  setValue(refs.rotate, Math.round(Number(selection.rotate) || 0));
  const opacity = Math.round(clamp(Number(selection.opacity ?? 1), 0, 1) * 100);
  setValue(refs.opacityNum, opacity);
  if (refs.opacityRange && document.activeElement !== refs.opacityRange) refs.opacityRange.value = String(opacity);
}

function updateText(selection) {
  const styles = selection.styles || {};
  setSelect(refs.fontFamily, fontOptionFor(styles.fontFamily));
  setValue(refs.fontSize, Math.round(parseFloat(styles.fontSize) || 32));
  setValue(refs.lineHeight, lineHeightRatio(styles.lineHeight, styles.fontSize));
  setValue(refs.letterSpacing, Math.round(parseFloat(styles.letterSpacing) || 0));
  setValue(refs.textColor, toHex(styles.color, '#F2EAE0'));
  setValue(refs.highlight, toHex(styles.backgroundColor, '#C43E1C'));
  for (const key of Object.keys(refs.alignBtns)) setActive(refs.alignBtns[key], styles.textAlign === key);
}

/** computed line-height 常是 px（如 40px），属性面板要显示无单位倍率（如 1.54） */
function lineHeightRatio(value, fontSize) {
  const raw = String(value ?? '').trim();
  const px = /^([\d.]+)px$/.exec(raw);
  const fs = parseFloat(fontSize) || 0;
  if (px && fs > 0) return Math.round((parseFloat(px[1]) / fs) * 100) / 100;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 1.4;
}

/** 把计算后的 font-family 映射回下拉选项 */
function fontOptionFor(computed) {
  const raw = String(computed || '');
  /* 具体字体族优先于泛型：否则 SimSun / Microsoft YaHei 会被 serif / sans 先匹配走 */
  const matchers = [
    [/cascadia|consolas|courier|monospace|jetbrains/i, '"Cascadia Code", Consolas, monospace'],
    [/simsun|songti|宋体|宋/i, 'SimSun, "Songti SC", serif'],
    [/yahei|pingfang|微软雅黑|microsoft yahei/i, '"Microsoft YaHei", "PingFang SC", sans-serif'],
    [/times new roman|georgia|garamond/i, 'var(--wpx-latin)'],
    [/serif/i, 'var(--wpx-serif)'],
    [/sans|arial|helvetica|segoe|inter|system/i, 'var(--wpx-sans)'],
  ];
  for (const [re, value] of matchers) if (re.test(raw)) return value;
  return FONT_OPTIONS[0][0];
}

function updateFill(selection) {
  const styles = selection.styles || {};
  setValue(refs.bgColor, toHex(styles.backgroundColor, '#1B1A17'));
  setValue(refs.borderWidth, Math.round(parseFloat(styles.borderWidth) || 0));
  setSelect(refs.borderStyle, styles.borderStyle || 'none');
  setValue(refs.borderColor, toHex(styles.borderColor, '#E1DCD2'));
  setValue(refs.radius, Math.round(parseFloat(styles.borderRadius) || 0));
  const shadow = String(styles.boxShadow || 'none');
  const preset = Object.keys(SHADOWS).find((key) => SHADOWS[key] === shadow) || 'custom';
  setSelect(refs.shadow, preset);
}

function updateImage(selection) {
  setSelect(refs.objectFit, (selection.styles || {}).objectFit || 'cover');
}

function updateAnim(selection) {
  const anim = selection.animation;
  if (!refs.animName) return;
  if (!anim?.name) {
    refs.animName.textContent = '未设置动画';
    refs.animMeta.textContent = '';
    return;
  }
  refs.animName.textContent = anim.label || anim.name;
  const params = anim.params || {};
  const bits = [];
  if (params.duration != null) bits.push(params.duration + 'ms');
  if (params.delay != null) bits.push('延迟 ' + params.delay + 'ms');
  if (params.trigger) bits.push(params.trigger === 'auto' ? '页面进入播放' : params.trigger === 'click' ? '单击播放' : '上一动画后');
  refs.animMeta.textContent = bits.join(' · ');
}

function normalizeRect(rect) {
  if (!rect) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: Number(rect.x) || 0,
    y: Number(rect.y) || 0,
    w: Math.max(0, Number(rect.w ?? rect.width) || 0),
    h: Math.max(0, Number(rect.h ?? rect.height) || 0),
  };
}

function toHex(value, fallback) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return '#' + raw.slice(1).split('').map((c) => c + c).join('').toLowerCase();
  }
  const rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(raw);
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]]
      .map((v) => Math.round(clamp(Number(v), 0, 255)).toString(16).padStart(2, '0'))
      .join('');
  }
  return fallback;
}

/* ================= 应用修改 ================= */

async function applyStyle(styles) {
  const bridge = getBridge();
  const selection = current();
  if (!bridge?.ready || !selection?.elementId || !styles) return { ok: false };
  try {
    await bridge.setStyles(selection.elementId, styles);
    return { ok: true };
  } catch (err) {
    toast.error('修改样式失败：' + (err?.message || err));
    return { ok: false };
  }
}

async function applyRect() {
  const bridge = getBridge();
  const selection = current();
  if (!bridge?.ready || !selection?.elementId) return;
  const rect = normalizeRect(selection.rect);
  const x = Number(refs.x.value);
  const y = Number(refs.y.value);
  const w = Math.max(8, Number(refs.w.value) || rect.w);
  const hgt = Math.max(8, Number(refs.h.value) || rect.h);
  try {
    await bridge.resizeElement(selection.elementId, Math.round(w), Math.round(hgt), Math.round(Number.isFinite(x) ? x : rect.x), Math.round(Number.isFinite(y) ? y : rect.y));
  } catch (err) {
    toast.error('调整位置/尺寸失败：' + (err?.message || err));
  }
}

async function applyAbsoluteSize(axis) {
  const sel=current(),bridge=getBridge();if(!sel?.elementId||!bridge?.ready)return;
  const input=axis==='w'?refs.absoluteW:refs.absoluteH;
  const value=Number(input.value);if(!Number.isFinite(value)||value<=0)return;
  const params={elementId:sel.elementId,keepRatio:refs.absoluteLock.checked,[axis]:value};
  if(!params.keepRatio){params.w=Number(refs.absoluteW.value);params.h=Number(refs.absoluteH.value);}
  try {await bridge.call('setAbsoluteSize',params);}catch(e){toast.error('整体大小修改失败：'+e.message);}
}

async function applyRotate() {
  const selection = current();
  const value = Number(refs.rotate.value);
  if (!Number.isFinite(value)) return;
  await bus.runCommand('element.rotate', { deg: value });
}

async function applyOpacity(value, fromRange) {
  const amount = clamp(Number(value) || 0, 0, 100);
  if (!fromRange) setValue(refs.opacityRange, amount);
  setValue(refs.opacityNum, Math.round(amount));
  await applyStyle({ opacity: String(Math.round(amount) / 100) });
}

async function applyFontFamily(value) {
  await bus.runCommand('text.fontFamily', { family: value });
}

async function applyFontSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return;
  await bus.runCommand('text.fontSize', { size });
}

async function applyLineHeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return;
  await bus.runCommand('text.lineHeight', { value: n });
}

async function applyLetterSpacing(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  await bus.runCommand('text.letterSpacing', { value: n });
}

async function applyTextStyle(styles) {
  await applyStyle(styles);
}

async function applyBackground(value) {
  await applyStyle({ 'background-color': value });
}

async function applyBorder() {
  const width = Math.max(0, Number(refs.borderWidth.value) || 0);
  const style = refs.borderStyle.value;
  const color = refs.borderColor.value;
  const target = style === 'none' || width === 0 ? 'none' : `${width}px ${style} ${color}`;
  await applyStyle({ border: target, 'border-width': width + 'px', 'border-style': style, 'border-color': color });
}

async function applyRadius() {
  const value = Math.max(0, Number(refs.radius.value) || 0);
  await applyStyle({ 'border-radius': value + 'px' });
}

async function applyShadow() {
  const key = refs.shadow.value;
  if (key === 'custom') return;
  await applyStyle({ 'box-shadow': SHADOWS[key] || 'none' });
}

/* ================= 替换图片 ================= */

function safeFileName(name) {
  const base = String(name || 'image.png').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + '.png';
}

async function replaceImage(file) {
  const bridge = getBridge();
  const selection = current();
  const ed = ctx?.getEditor?.();
  if (!bridge?.ready || !selection?.elementId || !ed?.projectId) return;
  try {
    const res = await api.uploadAssetBlob(ed.projectId, safeFileName(file.name), file);
    if (!res?.url) throw new Error('上传失败');
    await bridge.setAttrs(selection.elementId, { src: res.url });
    toast.ok('图片已替换');
  } catch (err) {
    toast.error('替换图片失败：' + (err?.message || err));
  }
}

/* ================= 元素锁定 ================= */

function syncLockState(selection) {
  if (!selection?.elementId) {
    lockCheckedFor = null;
    lockedNow = false;
    updateLockUi();
    return;
  }
  const stale = Date.now() - (syncLockState.lastAt || 0) > 1500;
  if (lockCheckedFor === selection.elementId && !stale) return;
  const sameElement = lockCheckedFor === selection.elementId;
  lockCheckedFor = selection.elementId;
  syncLockState.lastAt = Date.now();
  if (!sameElement) {
    lockedNow = false;
    updateLockUi();
  }
  const bridge = getBridge();
  if (!bridge?.ready) return;
  bridge.getElementHtml(selection.elementId).then((res) => {
    if (current()?.elementId !== selection.elementId) return;
    const html = typeof res === 'string' ? res : (res?.html || '');
    lockedNow = /data-wpx-locked\s*=\s*["']?1/.test(html);
    updateLockUi();
  }).catch(() => { /* ignore */ });
}

function updateLockUi() {
  if (!refs.lockState || !refs.lockBtn) return;
  refs.lockState.textContent = lockedNow ? '已锁定' : '未锁定';
  refs.lockState.classList.toggle('is-locked', lockedNow);
  refs.lockBtn.textContent = lockedNow ? '解锁' : '锁定';
  refs.lockBtn.title = lockedNow ? '解锁后可在画布上选中与拖动' : '锁定后画布上不可选中（仍可在此面板修改属性）';
}

async function setLocked(locked) {
  const bridge = getBridge();
  const selection = current();
  if (!bridge?.ready || !selection?.elementId) return { ok: false, error: '未选中元素' };
  try {
    await bridge.setAttrs(selection.elementId, { 'data-wpx-locked': locked ? '1' : null });
  } catch (err) {
    toast.error('设置锁定失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  }
  lockedNow = !!locked;
  lockCheckedFor = selection.elementId;
  updateLockUi();
  toast.ok(locked ? '已锁定元素' : '已解锁元素');
  return { ok: true, locked: !!locked };
}

async function toggleLock() {
  return setLocked(!lockedNow);
}

/* ================= 命令 ================= */

function registerCommands() {
  bus.registerCommand('element.opacity', async (payload) => {
    let value = typeof payload === 'object' && payload ? (payload.opacity ?? payload.value) : payload;
    value = Number(value);
    if (!Number.isFinite(value)) value = 100;
    if (value <= 1.001) value *= 100;
    await applyOpacity(clamp(value, 0, 100), false);
    return { ok: true, opacity: clamp(value, 0, 100) / 100 };
  }, { label: '不透明度', group: '排列', icon: 'eye' });

  bus.registerCommand('element.lock', async () => setLocked(true), {
    label: '锁定元素', group: '排列', icon: 'lock',
  });
  bus.registerCommand('element.unlock', async () => setLocked(false), {
    label: '解锁元素', group: '排列', icon: 'unlock',
  });
}
