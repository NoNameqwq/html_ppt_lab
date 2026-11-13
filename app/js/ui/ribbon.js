/* PowerPoint 式功能区（Ribbon）
 *
 * 标签：开始 / 插入 / 设计 / 切换 / 动画 / 放映 / 视图 / Agent
 * - 开始 / 插入 / 放映 / 视图 / Agent 由本模块实现；设计 / 切换 / 动画 预注册占位标签，
 *   由 motion-design 通过 ctx.ribbon.registerTab(id,{label,order,render(container,ctx)}) 覆盖。
 * - 标签切换：下划线滑动 + 内容 120ms 淡入；双击当前标签折叠 / 展开功能区。
 * - ctx.ribbon 在 init 一开始就挂载，registerTab 可在之后任意时刻调用。
 */

import { h } from '../core/dom.js';
import { icon } from './icons.js';

/* 标签 id / 顺序（Lead 约定） */
const DEFAULT_ORDER = {
  home: 10,
  insert: 20,
  design: 40,
  transitions: 45,
  animations: 50,
  slideshow: 60,
  view: 70,
  agent: 80,
};

const TAB_LABELS = {
  home: '开始',
  insert: '插入',
  design: '设计',
  transitions: '切换',
  animations: '动画',
  slideshow: '放映',
  view: '视图',
  agent: 'Agent',
};

const FONTS = [
  { label: '无衬线', value: 'var(--wpx-sans)', match: 'wpx-sans' },
  { label: '衬线', value: 'var(--wpx-serif)', match: 'wpx-serif' },
  { label: '拉丁', value: 'var(--wpx-latin)', match: 'wpx-latin' },
  { label: '微软雅黑', value: '"Microsoft YaHei", sans-serif', match: 'microsoft yahei' },
  { label: '宋体', value: 'SimSun, serif', match: 'simsun' },
  { label: '黑体', value: 'SimHei, sans-serif', match: 'simhei' },
  { label: '等线', value: 'DengXian, sans-serif', match: 'dengxian' },
  { label: 'Georgia', value: 'Georgia, serif', match: 'georgia' },
  { label: 'Times', value: '"Times New Roman", serif', match: 'times' },
  { label: 'Arial', value: 'Arial, sans-serif', match: 'arial' },
  { label: '等宽', value: 'Consolas, "Courier New", monospace', match: 'consolas' },
];

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 72, 80, 96, 120, 160];

const LINE_HEIGHTS = [
  { label: '0.9', value: 0.9 },
  { label: '1.0', value: 1 },
  { label: '1.15', value: 1.15 },
  { label: '1.3', value: 1.3 },
  { label: '1.5', value: 1.5 },
  { label: '1.75', value: 1.75 },
  { label: '2.0', value: 2 },
  { label: '2.5', value: 2.5 },
];

const LETTER_SPACINGS = [
  { label: '-2 px', value: -2 },
  { label: '-1 px', value: -1 },
  { label: '-0.5 px', value: -0.5 },
  { label: '0 px', value: 0 },
  { label: '0.5 px', value: 0.5 },
  { label: '1 px', value: 1 },
  { label: '2 px', value: 2 },
  { label: '4 px', value: 4 },
  { label: '8 px', value: 8 },
];

const SHAPES = [
  { key: 'rect', label: '矩形', icon: 'square' },
  { key: 'roundRect', label: '圆角矩形', icon: 'rounded-square' },
  { key: 'ellipse', label: '椭圆', icon: 'circle' },
  { key: 'triangle', label: '三角形', icon: 'triangle' },
  { key: 'arrow', label: '箭头', icon: 'arrow-right' },
  { key: 'star', label: '星形', icon: 'star' },
  { key: 'hexagon', label: '六边形', icon: 'hexagon' },
];

const ICON_CHOICES = [
  'star', 'sparkles', 'zap', 'moon', 'sun', 'droplet', 'globe', 'flag', 'bell', 'calendar', 'clock', 'message',
  'send', 'play', 'present', 'film', 'layers', 'palette', 'wand', 'brain', 'cpu', 'terminal', 'code', 'link',
  'tag', 'folder', 'file', 'image', 'grid', 'frame', 'hexagon', 'triangle', 'circle', 'square', 'arrow-right',
  'arrow-up-right', 'check-circle', 'help', 'search', 'settings', 'sliders', 'share', 'download', 'upload',
  'trash', 'edit', 'pen', 'lock', 'keyboard', 'command', 'quote', 'maximize', 'refresh', 'history', 'camera',
];

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const SEL_TYPE_LABEL = { text: '文字', image: '图片', shape: '形状', html: 'HTML', canvas: '画布' };

/* ============================================================
   模块状态
   ============================================================ */

let ctxRef = null;
let api = null;
let els = {};
const tabs = new Map();
const DEFAULT_TABS = new Map();
let activeId = '';
let syncFns = [];
let syncPending = false;
let collapsed = false;
let inkFrame = 0;

/* ============================================================
   基础工具
   ============================================================ */

const getState = () => ctxRef.store.get();
const getSelection = () => getState().selection;
const getStylesOf = (state) => state?.selection?.styles || {};
const getStyles = () => getSelection()?.styles || {};

function run(name, payload) {
  return ctxRef.bus.runCommand(name, payload).then((r) => {
    if (r && r.ok === false && String(r.error || '').includes('未注册')) {
      ctxRef.toast.warn('该功能暂未接入：' + name);
    }
    return r;
  });
}

function setBtnActive(btn, on) {
  btn.classList.toggle('is-active', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function setBtnIcon(btn, name, size = 18) {
  const slot = btn.querySelector('.rbtn-ic');
  if (slot) slot.innerHTML = icon(name, size);
}

function fontSizeOf(sel) {
  const raw = parseFloat(String(sel?.styles?.fontSize || ''));
  return Number.isFinite(raw) ? Math.round(raw) : 18;
}

function currentFontLabel(sel) {
  const family = String(sel?.styles?.fontFamily || '');
  if (!family) return '无衬线';
  const low = family.toLowerCase();
  const hit = FONTS.find((f) => low.includes(f.match));
  if (hit) return hit.label;
  const first = family.split(',')[0].replace(/["']/g, '').trim();
  return first ? first.slice(0, 10) : '字体';
}

function currentLineHeight(sel) {
  const raw = parseFloat(String(sel?.styles?.lineHeight || ''));
  return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 1.2;
}

function currentLetterSpacing(sel) {
  const raw = parseFloat(String(sel?.styles?.letterSpacing || ''));
  return Number.isFinite(raw) ? raw : 0;
}

function currentAlign(sel) {
  const a = String(sel?.styles?.textAlign || '').toLowerCase();
  if (a === 'start' || a === 'justify-all') return 'left';
  return ['left', 'center', 'right', 'justify'].includes(a) ? a : 'left';
}

function currentZoomLabel() {
  const z = getState().ui.zoom;
  return typeof z === 'number' ? `${Math.round(z * 100)}%` : '适合';
}

function isDark() {
  return getState().ui.theme === 'dark';
}

/* 注册一个状态同步回调（渲染时收集，store 变化时执行） */
function bind(fn) {
  syncFns.push(fn);
  try {
    fn();
  } catch (err) {
    console.error('[ribbon] 状态同步失败', err);
  }
}

function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => {
    syncPending = false;
    for (const fn of syncFns) {
      try {
        fn();
      } catch (err) {
        console.error('[ribbon] 状态同步失败', err);
      }
    }
  });
}

/* ============================================================
   DOM 构造辅助
   ============================================================ */

function group(label, ...nodes) {
  return h(
    'div',
    { class: 'rgroup' },
    h('div', { class: 'rgroup-main' }, ...nodes.flat()),
    h('div', { class: 'rgroup-label' }, label),
  );
}

function row(...nodes) {
  return h('div', { class: 'rrow' }, ...nodes.flat());
}

function stack(...nodes) {
  return h('div', { class: 'rstack' }, ...nodes.flat());
}

function col(...nodes) {
  return h('div', { class: 'rcol' }, ...nodes.flat());
}

/**
 * 图标按钮
 * opts: { icon, label, big, tip, kbd, cmd, payload, onClick, active(state), disabled(state), className }
 */
function makeButton(opts) {
  const {
    icon: iconName,
    label = '',
    big = false,
    tip = '',
    kbd = '',
    cmd: command,
    payload,
    onClick,
    active = null,
    disabled = null,
    className = '',
  } = opts;
  const btn = h('button', {
    class: `rbtn${big ? ' rbtn--big' : ''} ${className}`.trim(),
    type: 'button',
    'aria-label': tip || label || iconName,
  });
  btn.setAttribute('data-tip', kbd ? `${tip || label}|${kbd}` : tip || label || '');
  btn.append(h('span', { class: 'rbtn-ic', html: icon(iconName, big ? 22 : 18) }));
  if (label) btn.append(h('span', { class: 'rbtn-label' }, label));
  btn.addEventListener('click', () => {
    if (onClick) return onClick(btn);
    if (command) return run(command, payload);
    return undefined;
  });
  if (active) {
    bind(() => {
      const value = typeof active === 'function' ? active(getState()) : active;
      setBtnActive(btn, value);
    });
  }
  if (disabled) {
    bind(() => {
      btn.disabled = !!(typeof disabled === 'function' ? disabled(getState()) : disabled);
    });
  }
  return btn;
}

/** 下拉菜单按钮 */
function makeMenuButton(opts) {
  const {
    icon: iconName,
    label = '',
    big = false,
    tip = '',
    kbd = '',
    items,
    align = 'start',
    className = '',
    active = null,
    minWidth = 0,
  } = opts;
  const btn = h('button', {
    class: `rbtn has-caret${big ? ' rbtn--big' : ''} ${className}`.trim(),
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-label': tip || label,
  });
  btn.setAttribute('data-tip', kbd ? `${tip || label}|${kbd}` : tip || label);
  btn.append(h('span', { class: 'rbtn-ic', html: icon(iconName, big ? 22 : 18) }));
  if (label) btn.append(h('span', { class: 'rbtn-label' }, label));
  btn.addEventListener('click', () => {
    ctxRef.overlay.menu({ anchor: btn, align, minWidth, items });
  });
  if (active) {
    bind(() => {
      const value = typeof active === 'function' ? active(getState()) : active;
      setBtnActive(btn, value);
    });
  }
  return btn;
}

/** 下拉组合按钮（显示当前值） */
function makeCombo(opts) {
  const {
    icon: iconName,
    label: initial = '',
    tip = '',
    items,
    width = 180,
    align = 'start',
    update = null,
    className = '',
  } = opts;
  const labelEl = h('span', { class: 'rcombo-label' }, initial);
  const btn = h('button', {
    class: `rcombo ${className}`.trim(),
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-label': tip || initial,
    'data-tip': tip || initial,
  });
  if (iconName) btn.append(h('span', { class: 'rcombo-ic', html: icon(iconName, 16) }));
  btn.append(labelEl, h('span', { class: 'rcombo-caret', html: icon('caret-down', 11) }));
  btn.addEventListener('click', () => {
    ctxRef.overlay.menu({ anchor: btn, align, minWidth: width, items });
  });
  if (update) {
    bind(() => {
      const value = update(getState());
      if (value != null) labelEl.textContent = value;
    });
  }
  return btn;
}

/** 字体颜色 / 高亮色按钮（带当前色条） */
function makeColorButton({ icon: iconName, tip, target }) {
  const btn = h('button', {
    class: 'rbtn rbtn--color has-caret',
    type: 'button',
    'aria-label': tip,
    'data-tip': tip,
  });
  btn.append(h('span', { class: 'rbtn-ic', html: icon(iconName, 18) }));
  const bar = h('span', { class: 'rbtn-colorbar' });
  btn.append(bar);
  btn.addEventListener('click', () => {
    const styles = getStyles();
    const current = target === 'color' ? styles.color : styles.backgroundColor;
    ctxRef.overlay.colorPicker({
      anchor: btn,
      value: current || (target === 'color' ? '#1B1A17' : '#F2EAE0'),
      allowAlpha: target !== 'color',
      onChange: (color) => run(target === 'color' ? 'text.color' : 'text.highlight', { color }),
    });
  });
  bind(() => {
    const styles = getStyles();
    const color = target === 'color' ? styles.color : styles.backgroundColor;
    bar.style.background = color && color !== 'rgba(0, 0, 0, 0)' ? color : 'transparent';
  });
  return btn;
}

/* ============================================================
   共享菜单项
   ============================================================ */

function alignItems() {
  return [
    { label: '左对齐', icon: 'align-left', checked: currentAlign(getSelection()) === 'left', onClick: () => run('text.align', { align: 'left' }) },
    { label: '居中对齐', icon: 'align-center', checked: currentAlign(getSelection()) === 'center', onClick: () => run('text.align', { align: 'center' }) },
    { label: '右对齐', icon: 'align-right', checked: currentAlign(getSelection()) === 'right', onClick: () => run('text.align', { align: 'right' }) },
    { label: '两端对齐', icon: 'justify', checked: currentAlign(getSelection()) === 'justify', onClick: () => run('text.align', { align: 'justify' }) },
    { sep: true },
    { label: '水平分布', icon: 'distribute-h', onClick: () => run('arrange.distributeH') },
    { label: '垂直分布', icon: 'distribute-v', onClick: () => run('arrange.distributeV') },
  ];
}

function arrangeItems() {
  return [
    { label: '置于顶层', icon: 'bring-front', onClick: () => run('arrange.front') },
    { label: '上移一层', icon: 'bring-forward', onClick: () => run('arrange.forward') },
    { label: '下移一层', icon: 'send-backward', onClick: () => run('arrange.backward') },
    { label: '置于底层', icon: 'send-back', onClick: () => run('arrange.back') },
    { sep: true },
    { label: '左对齐', icon: 'align-left', onClick: () => run('arrange.alignLeft') },
    { label: '水平居中', icon: 'align-center', onClick: () => run('arrange.alignCenter') },
    { label: '右对齐', icon: 'align-right', onClick: () => run('arrange.alignRight') },
    { label: '顶对齐', icon: 'align-top', onClick: () => run('arrange.alignTop') },
    { label: '垂直居中', icon: 'align-middle', onClick: () => run('arrange.alignMiddle') },
    { label: '底对齐', icon: 'align-bottom', onClick: () => run('arrange.alignBottom') },
  ];
}

function fontFamilyItems() {
  const family = String(getStyles().fontFamily || '').toLowerCase();
  return FONTS.map((f) => ({
    label: f.label,
    checked: family.includes(f.match),
    onClick: () => run('text.fontFamily', { family: f.value }),
  }));
}

function fontSizeItems() {
  const current = fontSizeOf(getSelection());
  const items = FONT_SIZES.map((size) => ({
    label: `${size}`,
    checked: current === size,
    onClick: () => run('text.fontSize', { size }),
  }));
  items.push({ sep: true });
  items.push({
    label: '自定义字号…',
    icon: 'edit',
    onClick: async () => {
      const value = await ctxRef.dialog.prompt('自定义字号', {
        value: String(current),
        placeholder: '输入像素值，如 42',
        sub: '单位 px（1920×1080 画布）',
        okLabel: '应用',
      });
      const size = parseFloat(value);
      if (Number.isFinite(size) && size > 0) run('text.fontSize', { size });
    },
  });
  return items;
}

function lineHeightItems() {
  const current = currentLineHeight(getSelection());
  return LINE_HEIGHTS.map((item) => ({
    label: item.label,
    checked: Math.abs(current - item.value) < 0.01,
    onClick: () => run('text.lineHeight', { value: item.value }),
  }));
}

function letterSpacingItems() {
  const current = currentLetterSpacing(getSelection());
  return LETTER_SPACINGS.map((item) => ({
    label: item.label,
    checked: Math.abs(current - item.value) < 0.01,
    onClick: () => run('text.letterSpacing', { value: item.value }),
  }));
}

function shapeItems() {
  return SHAPES.map((shape) => ({
    label: shape.label,
    icon: shape.icon,
    onClick: () => run('insert.shape', { shape: shape.key }),
  }));
}

function zoomItems() {
  const current = getState().ui.zoom;
  return [
    { label: '适应窗口', icon: 'fit', checked: current === 'fit', onClick: () => run('app.zoomFit') },
    { sep: true },
    ...ZOOM_PRESETS.map((z) => ({
      label: `${Math.round(z * 100)}%`,
      checked: typeof current === 'number' && Math.abs(current - z) < 0.001,
      onClick: () => run('view.zoom', { zoom: z }),
    })),
    { sep: true },
    { label: '重置为 100%', icon: 'refresh', onClick: () => run('app.zoomReset') },
  ];
}

/* 图标选择 popover */
function openIconPicker(anchor) {
  const grid = h('div', { class: 'ip-grid' });
  const content = h('div', { class: 'icon-picker' },
    h('div', { class: 'ip-title' }, '插入图标'),
    h('div', { class: 'ip-sub' }, '矢量内联图标 · 颜色随元素'),
    grid);
  let handle = null;
  for (const name of ICON_CHOICES) {
    const btn = h('button', {
      class: 'ip-item',
      type: 'button',
      'data-tip': name,
      'aria-label': '图标 ' + name,
      html: icon(name, 20),
    });
    btn.addEventListener('click', () => {
      handle?.close();
      run('insert.icon', { name });
    });
    grid.append(btn);
  }
  handle = ctxRef.overlay.popover({ anchor, content, className: 'popover--icons', label: '图标库' });
}

/* ---------- 每个标签的上下文 AI 入口（AI 设计弹窗） ---------- */
const AI_TAB_PROMPTS = {
  home: ['统一整套字体与层级', '把标题/正文对齐得更整齐', '优化当前页排版密度'],
  insert: ['插入一张示意图或图表', '给当前页加一组图标', '用 HTML 代码插入数据卡片'],
  design: ['换一套更克制的配色', '把版式改成杂志风', '统一整套页面的字体'],
  transitions: ['设计一个有电影感的切换', '把整册切换统一成柔和推移', '给这一页做一个旋转模糊转场'],
  animations: ['标题逐字错峰入场', '给关键元素做弹簧回弹', '设计一套整页入场编排'],
  slideshow: ['优化整册的放映节奏', '给每页设计点击触发的动效'],
  view: ['检查当前页的视觉密度', '给出布局优化建议'],
  agent: ['帮我梳理这套视觉的主线'],
  default: ['优化当前页的视觉与动效'],
};

let aiPopEl = null;
let aiPopOff = null;

function closeAiPop() {
  if (aiPopEl) { try { aiPopEl.remove(); } catch { /* ignore */ } aiPopEl = null; }
  if (aiPopOff) { try { aiPopOff(); } catch { /* ignore */ } aiPopOff = null; }
}

function openAiPop(anchor, id, label) {
  closeAiPop();
  const st = ctxRef.store.get();
  const deck = st.deck || {};
  const proj = st.project || {};
  const sel = st.selection;
  const page = deck.total ? `第 ${deck.current + 1}/${deck.total} 页` : '';
  const selText = sel ? `，已选中${sel.type === 'image' ? '图片' : sel.type === 'shape' ? '形状' : '元素'}` : '';
  const raw = deck.raw === true || deck.mode === 'raw';
  const ctxLine = [proj.name || '当前工程', page + selText].filter(Boolean).join(' · ');
  const prompts = AI_TAB_PROMPTS[id] || AI_TAB_PROMPTS.default;

  const input = h('textarea', { class: 'ribbon-ai-input', rows: '3', placeholder: '描述你想让 AI 怎么设计…' });
  const chips = h('div', { class: 'ribbon-ai-chips' });
  for (const p of prompts) {
    const chip = h('button', { type: 'button', class: 'ribbon-ai-chip' }, p);
    chip.addEventListener('click', () => { input.value = p; input.focus(); });
    chips.append(chip);
  }
  const send = h('button', { type: 'button', class: 'btn btn--sm btn--accent' }, h('span', { html: icon('agent', 14) }), h('span', {}, '发送给 Agent'));
  const close = h('button', { type: 'button', class: 'icon-btn ribbon-ai-close', 'aria-label': '关闭' }, h('span', { html: icon('close', 15) }));
  const pop = h('div', { class: 'ribbon-ai-pop', role: 'dialog', 'aria-label': 'AI 设计' },
    h('div', { class: 'ribbon-ai-head' },
      h('strong', {}, '让 AI 设计' + label),
      close),
    h('div', { class: 'ribbon-ai-ctx' }, ctxLine),
    chips,
    input,
    h('div', { class: 'ribbon-ai-foot' },
      h('span', { class: 'ribbon-ai-grow' }),
      send));
  document.body.append(pop);
  aiPopEl = pop;
  const rect = anchor.getBoundingClientRect();
  const width = 340;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const top = Math.min(window.innerHeight - pop.offsetHeight - 8, rect.bottom + 8);
  pop.style.left = left + 'px';
  pop.style.top = Math.max(8, top) + 'px';
  close.addEventListener('click', closeAiPop);
  send.addEventListener('click', () => {
    const text = String(input.value || '').trim();
    if (!text) { input.focus(); return; }
    closeAiPop();
    const full = `【当前在「${label}」标签，${ctxLine}】${text}`;
    try {
      ctxRef.bus.runCommand('agent.send', { text: full });
    } catch (err) {
      ctxRef.toast?.error?.('Agent 未就绪：' + (err?.message || err));
    }
  });
  const onDoc = (e) => {
    if (aiPopEl && !aiPopEl.contains(e.target) && e.target !== anchor) closeAiPop();
  };
  const onKey = (e) => { if (e.key === 'Escape') closeAiPop(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  aiPopOff = () => {
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  input.focus();
}

function buildAiGroup(id) {
  const label = (tabs.get(id) && tabs.get(id).label) || TAB_LABELS[id] || id;
  const btn = h('button', {
    type: 'button',
    class: 'btn btn--sm btn--accent rbtn-ai',
    'data-tip': '让 AI 设计「' + label + '」相关内容',
  }, h('span', { html: icon('agent', 15) }), h('span', {}, 'AI 设计'));
  btn.addEventListener('click', () => openAiPop(btn, id, label));
  return h('div', { class: 'rgroup rgroup--ai' },
    h('div', { class: 'rgroup-main' }, btn),
    h('div', { class: 'rgroup-label' }, 'AI'));
}

/** 功能区右侧「当前状态」卡：填充空白，并实时显示选中元素 / 页码信息 */
function buildTailGroup() {
  const iconEl = h('span', { class: 'rtail-ic', html: icon('mouse-pointer', 18) });
  const title = h('div', { class: 'rtail-title' }, '未选择元素');
  const subPage = h('span', { class: 'rtail-sub-page' }, '');
  const subExtra = h('span', { class: 'rtail-sub-extra' }, '');
  const sub = h('div', { class: 'rtail-sub' }, subPage, subExtra);
  const card = h(
    'div',
    { class: 'rtail' },
    iconEl,
    h('div', { class: 'rtail-text' }, title, sub),
  );

  bind(() => {
    const s = getState();
    const sel = s.selection;
    if (sel) {
      const label = SEL_TYPE_LABEL[sel.type] || '元素';
      const size = sel.rect ? ` · ${Math.round(sel.rect.w)}×${Math.round(sel.rect.h)}` : '';
      title.textContent = label + size;
      const txt = String(sel.text || '').replace(/\s+/g, ' ').trim();
      subPage.textContent = txt
        ? `「${txt.length > 16 ? txt.slice(0, 16) + '…' : txt}」`
        : '双击编辑文字';
      subExtra.textContent = txt ? '' : ' · Delete 删除';
      card.classList.add('is-sel');
      iconEl.innerHTML = icon(
        sel.type === 'image' ? 'image' : sel.type === 'shape' ? 'shapes' : sel.type === 'html' ? 'code' : 'type',
        18,
      );
    } else {
      const total = s.deck?.total || 0;
      const current = s.deck?.current || 0;
      title.textContent = '未选择元素';
      subPage.textContent = total ? `第 ${current + 1}/${total} 页` : '在画布中单击元素以选中';
      subExtra.textContent = total ? ' · 1920×1080' : '';
      card.classList.remove('is-sel');
      iconEl.innerHTML = icon('mouse-pointer', 18);
    }
  });

  return h(
    'div',
    { class: 'rgroup rgroup--tail' },
    h('div', { class: 'rgroup-main' }, card),
    h('div', { class: 'rgroup-label' }, '当前状态'),
  );
}

/** 标签栏 / 内容区横向滚动提示（wheel 横向滚动 + 边缘渐隐） */
function scrollWheel(e, el) {
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + e.deltaY));
  e.preventDefault();
}

function updateScrollHints() {
  if (els.track) {
    els.tabs?.classList.toggle('is-overflow', els.track.scrollWidth > els.track.clientWidth + 2);
  }
  const panel = els.body?.querySelector('.ribbon-panel');
  if (panel) panel.classList.toggle('is-overflow', panel.scrollWidth > panel.clientWidth + 2);
}

/* ============================================================
   标签内容：开始
   ============================================================ */

function renderHome(container) {
  const slideGroup = group(
    '幻灯片',
    makeButton({ icon: 'slide-plus', label: '新建', big: true, tip: '新建幻灯片', cmd: 'slide.add' }),
    stack(
      makeButton({ icon: 'copy', tip: '复制当前页', cmd: 'slide.duplicate' }),
      makeButton({ icon: 'trash', tip: '删除当前页', cmd: 'slide.delete' }),
    ),
  );

  const clipboardGroup = group(
    '剪贴板',
    makeButton({ icon: 'clipboard', label: '粘贴', big: true, tip: '粘贴', kbd: 'Ctrl V', cmd: 'edit.paste' }),
    stack(
      makeButton({ icon: 'scissors', tip: '剪切', kbd: 'Ctrl X', cmd: 'edit.cut' }),
      makeButton({ icon: 'copy', tip: '复制', kbd: 'Ctrl C', cmd: 'edit.copy' }),
    ),
    stack(
      makeButton({ icon: 'copy', tip: '复制元素', kbd: 'Ctrl D', cmd: 'edit.duplicate' }),
      makeButton({ icon: 'trash', tip: '删除元素', kbd: 'Delete', cmd: 'edit.delete' }),
    ),
  );

  const fontGroup = group(
    '字体',
    col(
      row(
        makeCombo({
          icon: 'type',
          label: '无衬线',
          tip: '字体',
          width: 168,
          update: (s) => currentFontLabel(s.selection),
          items: fontFamilyItems,
        }),
        makeCombo({
          label: '18',
          tip: '字号',
          width: 120,
          update: (s) => String(fontSizeOf(s.selection)),
          items: fontSizeItems,
        }),
      ),
      row(
        makeButton({ icon: 'bold', tip: '加粗', kbd: 'Ctrl B', cmd: 'text.bold', active: (s) => {
          const w = String(getStylesOf(s).fontWeight || '');
          return w === 'bold' || w === 'bolder' || parseInt(w, 10) >= 600;
        } }),
        makeButton({ icon: 'italic', tip: '斜体', kbd: 'Ctrl I', cmd: 'text.italic', active: (s) => /italic|oblique/.test(String(getStylesOf(s).fontStyle || '')) }),
        makeButton({ icon: 'underline', tip: '下划线', kbd: 'Ctrl U', cmd: 'text.underline', active: (s) => /underline/.test(String(getStylesOf(s).textDecoration || '')) }),
        makeButton({ icon: 'strike', tip: '删除线', cmd: 'text.strike', active: (s) => /line-through/.test(String(getStylesOf(s).textDecoration || '')) }),
        makeColorButton({ icon: 'text-color', tip: '字体颜色', target: 'color' }),
        makeColorButton({ icon: 'highlight', tip: '高亮颜色', target: 'highlight' }),
      ),
    ),
  );

  const paragraphGroup = group(
    '段落',
    row(
      makeButton({ icon: 'align-left', tip: '左对齐', cmd: 'text.align', payload: { align: 'left' }, active: (s) => currentAlign(s.selection) === 'left' }),
      makeButton({ icon: 'align-center', tip: '居中对齐', cmd: 'text.align', payload: { align: 'center' }, active: (s) => currentAlign(s.selection) === 'center' }),
      makeButton({ icon: 'align-right', tip: '右对齐', cmd: 'text.align', payload: { align: 'right' }, active: (s) => currentAlign(s.selection) === 'right' }),
      makeButton({ icon: 'justify', tip: '两端对齐', cmd: 'text.align', payload: { align: 'justify' }, active: (s) => currentAlign(s.selection) === 'justify' }),
      h('span', { class: 'rdivider' }),
      makeMenuButton({ icon: 'line-height', label: '行距', tip: '行距', items: lineHeightItems }),
      makeMenuButton({ icon: 'letter-spacing', label: '字距', tip: '字符间距', items: letterSpacingItems }),
    ),
  );

  const editGroup = group(
    '编辑',
    makeMenuButton({
      icon: 'cursor-select',
      label: '选择',
      tip: '选择',
      items: () => [
        { label: '全选（当前页元素）', icon: 'frame', shortcut: 'Ctrl A', onClick: () => run('edit.selectAll') },
        { label: '取消选择', icon: 'x', shortcut: 'Esc', onClick: () => run('edit.deselect') },
      ],
    }),
    stack(
      makeButton({ icon: 'frame', tip: '全选元素', kbd: 'Ctrl A', cmd: 'edit.selectAll' }),
      makeButton({ icon: 'x-circle', tip: '取消选择', kbd: 'Esc', cmd: 'edit.deselect' }),
    ),
    makeButton({ icon: 'trash', label: '删除', tip: '删除元素', kbd: 'Delete', cmd: 'edit.delete', className: 'rbtn--danger' }),
  );

  const arrangeGroup = group(
    '排列',
    makeMenuButton({ icon: 'layers', label: '层级', big: true, tip: '排列层级', items: arrangeItems, minWidth: 200 }),
    makeMenuButton({ icon: 'align-middle', label: '对齐', big: true, tip: '对齐与分布', items: alignItems, minWidth: 190 }),
  );

  container.append(slideGroup, clipboardGroup, fontGroup, paragraphGroup, editGroup, arrangeGroup, buildTailGroup());
}

/* ============================================================
   标签内容：插入
   ============================================================ */

function renderInsert(container) {
  const textGroup = group(
    '文本',
    makeButton({ icon: 'text-box', label: '文本框', big: true, tip: '插入文本框', cmd: 'insert.text' }),
    makeButton({ icon: 'code', label: 'HTML', big: true, tip: '插入 HTML 代码块', cmd: 'insert.html' }),
    stack(
      makeButton({ icon: 'icon-grid', tip: '插入图标', onClick: openIconPicker }),
      makeButton({ icon: 'line', tip: '插入线条', cmd: 'insert.line' }),
    ),
  );

  const mediaGroup = group(
    '媒体',
    makeButton({ icon: 'image-plus', label: '图片', big: true, tip: '插入图片（上传 / URL / 拖入）', cmd: 'insert.image' }),
    stack(
      makeButton({ icon: 'upload', tip: '从本地上传图片', onClick: () => run('insert.image', { mode: 'upload' }) }),
      makeButton({ icon: 'clipboard', tip: '粘贴图片', kbd: 'Ctrl V', cmd: 'edit.paste' }),
    ),
  );

  const shapeGroup = group(
    '形状',
    makeMenuButton({ icon: 'shapes', label: '形状', big: true, tip: '插入形状', items: shapeItems, minWidth: 168 }),
    makeButton({ icon: 'line', label: '线条', big: true, tip: '插入线条', cmd: 'insert.line' }),
  );

  const slideGroup = group(
    '幻灯片',
    makeButton({ icon: 'slide-plus', label: '新建', big: true, tip: '新建幻灯片', cmd: 'slide.add' }),
    stack(
      makeButton({ icon: 'copy', tip: '复制当前页', cmd: 'slide.duplicate' }),
      makeButton({ icon: 'trash', tip: '删除当前页', cmd: 'slide.delete' }),
    ),
  );

  const designGroup = group(
    '主题',
    makeButton({ icon: 'palette', label: '设计', big: true, tip: '打开设计标签', onClick: () => setActiveTab('design') }),
    makeButton({ icon: 'film', label: '切换', big: true, tip: '打开切换标签', onClick: () => setActiveTab('transitions') }),
  );
  const knowledgeGroup=group('知识表达',makeButton({icon:'list',label:'动画目录',big:true,tip:'设计可跳转的章节目录',cmd:'insert.navigation'}),makeButton({icon:'code',label:'公式',big:true,tip:'插入 LaTeX 公式',cmd:'insert.math'}),makeButton({icon:'shapes',label:'SVG 图解',big:true,tip:'插入矢量知识图解',cmd:'insert.svg'}),makeButton({icon:'type',label:'自动字体',big:true,tip:'按内容和本机字体选择组合',cmd:'design.autoFonts'}));
  container.append(textGroup, knowledgeGroup, mediaGroup, shapeGroup, slideGroup, designGroup, buildTailGroup());
}

/* ============================================================
   标签内容：放映
   ============================================================ */

function renderSlideshow(container) {
  const startGroup = group(
    '开始放映',
    makeButton({ icon: 'present', label: '从头开始', big: true, tip: '从头开始放映', kbd: 'F5', cmd: 'app.present' }),
    makeButton({ icon: 'play-circle', label: '从当前页', big: true, tip: '从当前页放映', kbd: 'Shift F5', cmd: 'app.presentCurrent' }),
    stack(
      makeButton({ icon: 'fullscreen', tip: '全屏模式', cmd: 'view.fullscreen' }),
      makeButton({ icon: 'refresh', tip: '重新加载画布', cmd: 'app.reloadDeck' }),
    ),
  );

  const previewGroup = group(
    '预览',
    makeButton({ icon: 'wand', label: '预览动画', big: true, tip: '预览当前页动画', onClick: () => run('slide.previewAnimation') }),
    makeButton({ icon: 'film', label: '切换预览', big: true, tip: '预览当前页切换效果', onClick: () => setActiveTab('transitions') }),
  );

  const mouseGroup = group(
    '放映交互',
    makeButton({ icon: 'mouse-pointer', label: '左键翻页', big: true, tip: '放映时左键翻页；右键始终是自定义菜单（上一页/跳页/全屏/重播/左键模式）', onClick: () => run('deck.setMouseMode', { mode: 'advance' }) }),
    stack(
      makeButton({ icon: 'play', tip: '左键只播动画，不翻页', onClick: () => run('deck.setMouseMode', { mode: 'anim' }) }),
      makeButton({ icon: 'x-circle', tip: '左键不响应（适合自助展示）', onClick: () => run('deck.setMouseMode', { mode: 'off' }) }),
    ),
    makeButton({ icon: 'film', label: '时间线', big: true, tip: '打开动画时间线（跨页 / 多轨 / 关键帧）', cmd: 'app.toggleTimeline' }),
  );

  const outputGroup = group(
    '输出',
    makeButton({ icon: 'download', label: '导出 HTML', big: true, tip: '导出为独立 HTML 文件', cmd: 'app.export' }),
    makeButton({ icon: 'print', label: '打印 / PDF', big: true, tip: '打印或另存为 PDF', cmd: 'app.print' }),
  );

  container.append(startGroup, previewGroup, mouseGroup, outputGroup, buildTailGroup());
}

/* ============================================================
   标签内容：视图
   ============================================================ */

function renderView(container) {
  const zoomGroup = group(
    '缩放',
    makeCombo({
      label: '适合',
      tip: '缩放比例',
      width: 170,
      update: () => currentZoomLabel(),
      items: zoomItems,
      icon: 'zoom-in',
    }),
    stack(
      makeButton({ icon: 'plus', tip: '放大', cmd: 'app.zoomIn' }),
      makeButton({ icon: 'minus', tip: '缩小', cmd: 'app.zoomOut' }),
    ),
    makeButton({ icon: 'fit', label: '适应', big: true, tip: '适应窗口', cmd: 'app.zoomFit' }),
  );

  const displayGroup = group(
    '显示',
    makeButton({
      icon: 'grid',
      label: '网格',
      big: true,
      tip: '显示网格',
      cmd: 'view.grid',
      active: (s) => !!s.ui.grid,
    }),
    makeButton({
      icon: 'rulers',
      label: '参考线',
      big: true,
      tip: '显示参考线',
      cmd: 'view.rulers',
      active: (s) => !!s.ui.rulers,
    }),
  );

  const panelGroup = group(
    '面板',
    makeButton({
      icon: 'panel-left',
      label: '幻灯片',
      big: true,
      tip: '显示 / 隐藏幻灯片面板',
      cmd: 'app.toggleSlidePanel',
      active: (s) => !!s.ui.slidePanelOpen,
    }),
    makeButton({
      icon: 'panel-right',
      label: '属性',
      big: true,
      tip: '显示 / 隐藏属性面板',
      cmd: 'app.toggleInspector',
      active: (s) => !!s.ui.inspectorOpen,
    }),
    makeButton({
      icon: 'bot',
      label: 'Agent',
      big: true,
      tip: '显示 / 隐藏 Agent 面板',
      kbd: 'Ctrl Shift E',
      cmd: 'app.toggleAgent',
      active: (s) => !!s.ui.agentOpen,
    }),
  );

  const lookGroup = group(
    '外观',
    makeButton({
      icon: 'moon',
      label: '深色',
      big: true,
      tip: '切换深色 / 浅色模式',
      cmd: 'app.toggleTheme',
      active: (s) => s.ui.theme === 'dark',
    }),
    makeButton({ icon: 'fullscreen', label: '全屏', big: true, tip: '全屏显示工作台', cmd: 'view.fullscreen' }),
  );

  const helpGroup = group(
    '工具',
    makeButton({ icon: 'command', label: '命令', big: true, tip: '打开命令面板', kbd: 'Ctrl K', cmd: 'app.commandPalette' }),
    makeButton({ icon: 'help', label: '帮助', big: true, tip: '快捷键与帮助', cmd: 'help.shortcuts' }),
  );

  /* 深色按钮图标随主题变化 */
  const darkBtn = lookGroup.querySelector('.rbtn');
  if (darkBtn) bind(() => setBtnIcon(darkBtn, isDark() ? 'sun' : 'moon', 22));

  container.append(zoomGroup, displayGroup, panelGroup, lookGroup, helpGroup, buildTailGroup());
}

/* ============================================================
   标签内容：Agent
   ============================================================ */

function renderAgent(container) {
  const agentGroup = group(
    'Agent',
    makeButton({
      icon: 'bot',
      label: '面板',
      big: true,
      tip: '显示 / 隐藏 Agent 面板',
      kbd: 'Ctrl Shift E',
      cmd: 'app.toggleAgent',
      active: (s) => !!s.ui.agentOpen,
    }),
    makeButton({ icon: 'plus', label: '新会话', big: true, tip: '开启新会话', cmd: 'agent.newChat' }),
    makeButton({ icon: 'settings', label: '设置', big: true, tip: 'Agent / 模型设置', cmd: 'agent.openSettings' }),
  );

  const runGroup = group(
    '运行',
    makeButton({ icon: 'stop', label: '停止', big: true, tip: '停止当前生成', cmd: 'agent.stop' }),
    makeButton({ icon: 'command', label: '命令面板', big: true, tip: '打开命令面板', kbd: 'Ctrl K', cmd: 'app.commandPalette' }),
  );

  const hint = h(
    'div',
    { class: 'rhint' },
    h('span', { class: 'rhint-ic', html: icon('sparkles', 16) }),
    h('div', { class: 'rhint-text' },
      h('strong', {}, '用自然语言修改这份网页'),
      h('span', {}, '在右侧 Agent 面板描述想要的效果，例如「把封面标题改成衬线字体并加淡入动画」。')),
  );

  container.append(agentGroup, runGroup, hint, buildTailGroup());
}

/* ============================================================
   占位标签（等待 motion-design 注册覆盖）
   ============================================================ */

function placeholderRender(label, iconName) {
  return (container) => {
    container.append(
      h(
        'div',
        { class: 'rplaceholder' },
        h('span', { class: 'rph-ic', html: icon(iconName, 20) }),
        h(
          'div',
          { class: 'rph-text' },
          h('strong', {}, `${label}功能区`),
          h('span', {}, '由动效设计模块提供，正在加载…'),
        ),
      ),
    );
  };
}

function registerPlaceholderTabs() {
  const defs = [
    ['design', '设计', 'palette'],
    ['transitions', '切换', 'film'],
    ['animations', '动画', 'wand'],
  ];
  for (const [id, label, iconName] of defs) {
    const def = {
      label,
      order: DEFAULT_ORDER[id],
      render: placeholderRender(label, iconName),
    };
    tabs.set(id, def);
    DEFAULT_TABS.set(id, def);
  }
}

/* ============================================================
   标签栏 / 内容渲染
   ============================================================ */

function rebuildTabs() {
  if (!els.tabs || !els.track) return;
  const ordered = [...tabs.entries()].sort((a, b) => {
    const oa = a[1].order ?? 50;
    const ob = b[1].order ?? 50;
    if (oa !== ob) return oa - ob;
    return String(a[0]).localeCompare(String(b[0]));
  });

  const buttons = ordered.map(([id, def]) => {
    const on = id === activeId;
    const btn = h('button', {
      class: `ribbon-tab${on ? ' is-active' : ''}`,
      type: 'button',
      role: 'tab',
      'data-tab': id,
      'aria-selected': on ? 'true' : 'false',
      tabindex: on ? '0' : '-1',
    }, def.label || id);
    btn.addEventListener('click', () => {
      if (activeId === id) return;
      setActiveTab(id);
    });
    btn.addEventListener('dblclick', (e) => {
      e.preventDefault();
      toggleCollapse();
    });
    return btn;
  });

  const tail = h(
    'div',
    { class: 'ribbon-tabs-tail' },
    h('span', { class: 'ribbon-tabs-line' }),
    h('button', {
      class: `ribbon-collapse${collapsed ? ' is-collapsed' : ''}`,
      type: 'button',
      'data-tip': '折叠功能区（双击标签）',
      'aria-label': '折叠功能区',
    }, h('span', { class: 'ribbon-collapse-ic', html: icon(collapsed ? 'chevron-down' : 'chevron-up', 16) })),
  );
  const collapseBtn = tail.querySelector('.ribbon-collapse');
  collapseBtn.addEventListener('click', () => toggleCollapse());

  els.collapseBtn = collapseBtn;
  updateCollapseButton();

  /* 标签按钮 + 滑动下划线放进可横向滚动的 track；折叠按钮固定在右侧 */
  els.track.replaceChildren(...buttons, els.ink);
  els.tabs.replaceChildren(els.track, tail);
  requestAnimationFrame(() => {
    updateInk();
    updateScrollHints();
  });
}

/** 把标签条挂进标题栏的插槽（titlebar.js 在每次重建后调用） */
function mountTabs() {
  if (!els.tabs) return;
  const slot = document.getElementById('titlebar-tabs');
  if (slot) {
    if (els.tabs.parentNode !== slot) slot.append(els.tabs);
  } else if (els.tabs.parentNode) {
    els.tabs.remove();
  }
  requestAnimationFrame(() => {
    updateInk();
    updateScrollHints();
  });
}

function updateCollapseButton() {
  const btn = els.collapseBtn;
  if (!btn) return;
  btn.classList.toggle('is-collapsed', collapsed);
  btn.dataset.tip = collapsed ? '展开功能区' : '折叠功能区（双击标签）';
  btn.setAttribute('aria-label', collapsed ? '展开功能区' : '折叠功能区');
  const ic = btn.querySelector('.ribbon-collapse-ic');
  if (ic) ic.innerHTML = icon(collapsed ? 'chevron-down' : 'chevron-up', 16);
}

function updateInk() {
  if (!els.tabs || !els.ink) return;
  if (inkFrame) cancelAnimationFrame(inkFrame);
  inkFrame = requestAnimationFrame(() => {
    inkFrame = 0;
    if (!els.tabs.isConnected) {
      els.ink.style.width = '0px';
      return;
    }
    const btn = els.track ? els.track.querySelector('.ribbon-tab.is-active') : null;
    if (!btn) {
      els.ink.style.width = '0px';
      return;
    }
    els.ink.style.width = `${btn.offsetWidth}px`;
    els.ink.style.transform = `translateX(${btn.offsetLeft}px)`;
  });
}

function renderBody(id) {
  if (!els.body) return;
  const def = tabs.get(id);
  syncFns = [];
  const panel = h('div', { class: 'ribbon-panel' });
  if (def && typeof def.render === 'function') {
    try {
      const ret = def.render(panel, ctxRef, api);
      if (ret && typeof ret.then === 'function') {
        ret.catch((err) => {
          console.error('[ribbon] 标签异步渲染失败', id, err);
          panel.replaceChildren(h('div', { class: 'rplaceholder is-error' }, '功能区加载失败：' + (err?.message || err)));
        });
      } else if (ret instanceof Node && !panel.firstChild) {
        panel.append(ret);
      }
    } catch (err) {
      console.error('[ribbon] 标签渲染失败', id, err);
      panel.replaceChildren(h('div', { class: 'rplaceholder is-error' }, '功能区加载失败：' + (err?.message || err)));
    }
  }
  /* 每个标签都带一个上下文 AI 入口（让 AI 设计当前标签的内容） */
  if (!panel.querySelector('.rgroup--ai')) {
    const aiGroup = buildAiGroup(id);
    const tail = panel.querySelector('.rgroup--tail');
    if (tail) panel.insertBefore(aiGroup, tail); else panel.append(aiGroup);
  }
  /* 外部注册的标签（设计/切换/动画）也补一张「当前状态」卡，保持右侧不空 */
  if (!panel.querySelector('.rgroup--tail')) panel.append(buildTailGroup());
  els.body.replaceChildren(panel);
  void panel.offsetWidth;
  panel.classList.add('is-in');
  requestAnimationFrame(() => {
    updateInk();
    updateScrollHints();
  });
  for (const fn of syncFns) {
    try {
      fn();
    } catch (err) {
      console.error('[ribbon] 状态同步失败', err);
    }
  }
}

function setActiveTab(id, opts = {}) {
  if (!tabs.has(id)) return false;
  if (id === activeId && !opts.force) return true;
  activeId = id;
  for (const btn of els.tabs ? els.tabs.querySelectorAll('.ribbon-tab') : []) {
    const on = btn.dataset.tab === id;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  }
  renderBody(id);
  updateInk();
  if (!opts.fromStore) {
    ctxRef.store.update((s) => { s.ui.activeTab = id; });
  }
  return true;
}

/* ============================================================
   折叠 / 展开
   ============================================================ */

const COLLAPSE_KEY = 'wds:ribbon:collapsed';

function setCollapsed(value) {
  collapsed = !!value;
  if (els.root) els.root.classList.toggle('is-collapsed', collapsed);
  /* 其它模块/样式可读取折叠状态 */
  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.ribbon = collapsed ? 'collapsed' : 'expanded';
  updateCollapseButton();
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    /* 忽略 */
  }
  requestAnimationFrame(updateInk);
}

function toggleCollapse() {
  setCollapsed(!collapsed);
}

/* ============================================================
   注册机制（ctx.ribbon）
   ============================================================ */

function registerTab(id, def = {}) {
  if (!id || typeof id !== 'string') throw new Error('ctx.ribbon.registerTab 需要字符串 id');
  const prev = tabs.get(id);
  const entry = {
    label: def.label || prev?.label || TAB_LABELS[id] || id,
    order: Number.isFinite(def.order) ? def.order : prev?.order ?? DEFAULT_ORDER[id] ?? 55,
    render: typeof def.render === 'function' ? def.render : prev?.render || (() => {}),
  };
  tabs.set(id, entry);
  rebuildTabs();
  if (activeId === id) renderBody(id);
  return () => unregisterTab(id);
}

function unregisterTab(id) {
  if (!tabs.has(id)) return false;
  const fallback = DEFAULT_TABS.get(id);
  if (fallback) tabs.set(id, fallback);
  else tabs.delete(id);
  if (!tabs.has(activeId)) {
    const first = [...tabs.keys()][0];
    if (first) setActiveTab(first);
  } else if (activeId === id) {
    renderBody(id);
  }
  rebuildTabs();
  requestAnimationFrame(updateInk);
  return true;
}

function refresh() {
  if (els.tabs) {
    for (const btn of els.tabs.querySelectorAll('.ribbon-tab')) {
      const def = tabs.get(btn.dataset.tab);
      if (def && btn.textContent !== def.label) btn.textContent = def.label;
    }
  }
  renderBody(activeId);
  updateInk();
}

/* ============================================================
   键盘 / 事件
   ============================================================ */

function onTabsKeydown(e) {
  const key = e.key;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
  const buttons = [...(els.tabs?.querySelectorAll('.ribbon-tab') || [])];
  if (!buttons.length) return;
  const current = buttons.findIndex((b) => b.dataset.tab === activeId);
  let next = current;
  if (key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
  else if (key === 'ArrowRight') next = (current + 1) % buttons.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = buttons.length - 1;
  e.preventDefault();
  const target = buttons[next];
  if (!target) return;
  setActiveTab(target.dataset.tab);
  target.focus();
}

function normalizeTabId(id) {
  if (typeof id !== 'string') return '';
  return id === 'animation' ? 'animations' : id;
}

/* ============================================================
   挂载
   ============================================================ */

export async function init(ctx) {
  ctxRef = ctx;

  /* 先挂 API：motion-design 在后续 init 中会立即调用 registerTab */
  api = {
    registerTab,
    unregisterTab,
    setActiveTab,
    refresh,
    mountTabs,
    collapse: (v = true) => setCollapsed(v),
    expand: () => setCollapsed(false),
    isCollapsed: () => collapsed,
    getTabs: () => [...tabs.entries()].map(([id, def]) => ({ id, label: def.label, order: def.order })),
    get activeTab() {
      return activeId;
    },
  };
  ctx.ribbon = api;

  /* 默认标签 */
  const defaults = [
    ['home', '开始', renderHome],
    ['insert', '插入', renderInsert],
    ['slideshow', '放映', renderSlideshow],
    ['view', '视图', renderView],
    ['agent', 'Agent', renderAgent],
  ];
  for (const [id, label, render] of defaults) {
    const def = { label, order: DEFAULT_ORDER[id], render };
    tabs.set(id, def);
    DEFAULT_TABS.set(id, def);
  }
  registerPlaceholderTabs();

  els.root = document.getElementById('ribbon');
  if (!els.root) return;
  els.track = h('div', { class: 'ribbon-tabs-track' });
  els.ink = h('span', { class: 'ribbon-ink', 'aria-hidden': 'true' });
  els.tabs = h('div', { class: 'ribbon-tabs', role: 'tablist', 'aria-label': '功能区标签' });
  els.body = h('div', { class: 'ribbon-body' });
  els.tabs.addEventListener('keydown', onTabsKeydown);
  els.track.addEventListener('wheel', (e) => scrollWheel(e, els.track), { passive: false });
  els.body.addEventListener('wheel', (e) => scrollWheel(e, els.body.querySelector('.ribbon-panel')), { passive: false });
  els.root.replaceChildren(els.body);

  try {
    collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    collapsed = false;
  }

  const initialTab = normalizeTabId(ctx.store.get().ui.activeTab);
  activeId = '';
  rebuildTabs();
  setActiveTab(tabs.has(initialTab) ? initialTab : 'home', { fromStore: true });
  setCollapsed(collapsed);
  mountTabs();

  /* 状态 */
  ctx.store.subscribe(() => {
    scheduleSync();
    const tabId = normalizeTabId(ctx.store.get().ui.activeTab);
    if (tabId && tabId !== activeId && tabs.has(tabId)) {
      setActiveTab(tabId, { fromStore: true });
    }
  });
  ctx.bus.on('history:change', scheduleSync);
  ctx.bus.on('selection:change', scheduleSync);
  ctx.bus.on('ui:tab', (data) => {
    const id = normalizeTabId(data?.tab ?? data);
    if (id && tabs.has(id)) setActiveTab(id);
  });
  ctx.bus.on('route:change', () => {
    requestAnimationFrame(updateInk);
    requestAnimationFrame(() => {
      if (els.root && els.root.offsetWidth) updateInk();
    });
  });
  window.addEventListener('resize', () => {
    updateInk();
    updateScrollHints();
  });
  if (document.fonts?.ready) document.fonts.ready.then(updateInk).catch(() => {});
}
