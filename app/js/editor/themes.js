/* 设计系统：Ribbon「设计」标签 + 主题数据 + 字体组合 + 背景预设 + 颗粒/暗角
   契约：docs/SPEC.md §2.2 / §8.2 / §14。其它模块可 import { THEMES } 复用同一份数据。 */

import { h, on } from '../core/dom.js';
import { icon } from '../ui/icons.js';

const TAB_ID = 'design';
const TAB_ORDER = 40;

/* ---------- 字体栈 ---------- */
const SERIF = '"Songti SC","Source Han Serif SC","Noto Serif SC",SimSun,serif';
const SANS = '"PingFang SC","Helvetica Neue","Microsoft YaHei","Noto Sans SC",sans-serif';
const MONO = '"Cascadia Code","JetBrains Mono",Consolas,"Courier New",monospace';
const LATIN_SANS = '"Inter","Helvetica Neue",Arial,sans-serif';
const LATIN_SERIF = 'Georgia,"Times New Roman",Songti SC,serif';

/* ---------- 8 套主题（唯一数据源） ---------- */
export const THEMES = [
  {
    id: 'ink',
    name: '墨韵',
    desc: '墨黑 / 骨白 / 朱砂 · 衬线大字',
    vars: {
      '--wpx-bg': '#0A0A0B',
      '--wpx-fg': '#F2EAE0',
      '--wpx-fg-2': '#C9C1B6',
      '--wpx-muted': '#8A8A90',
      '--wpx-accent': '#E1402B',
      '--wpx-accent-2': '#2C6E68',
      '--wpx-line': 'rgba(242,234,224,.18)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SANS,
      '--wpx-radius': '6px',
      '--wpx-grain-opacity': '0.045',
      '--wpx-vignette-opacity': '0.45',
    },
    preview: { bg: '#0A0A0B', fg: '#F2EAE0', accent: '#E1402B' },
    grain: true,
    vignette: true,
  },
  {
    id: 'paper',
    name: '素纸',
    desc: '米白 / 墨黑 / 朱砂 · 印刷质感',
    vars: {
      '--wpx-bg': '#F4F1E9',
      '--wpx-fg': '#1B1A17',
      '--wpx-fg-2': '#4A463F',
      '--wpx-muted': '#8A8478',
      '--wpx-accent': '#C43E1C',
      '--wpx-accent-2': '#2C6E68',
      '--wpx-line': 'rgba(27,26,23,.14)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SANS,
      '--wpx-radius': '4px',
      '--wpx-grain-opacity': '0.035',
      '--wpx-vignette-opacity': '0.14',
    },
    preview: { bg: '#F4F1E9', fg: '#1B1A17', accent: '#C43E1C' },
    grain: true,
    vignette: false,
  },
  {
    id: 'bloom',
    name: '繁花',
    desc: '深紫 / 花期粉 / 奶油光 · 柔光衬线',
    vars: {
      '--wpx-bg': '#0B0816',
      '--wpx-fg': '#F6F1EA',
      '--wpx-fg-2': '#C9BFD9',
      '--wpx-muted': '#8E7FA8',
      '--wpx-accent': '#FF5C8A',
      '--wpx-accent-2': '#FFE9C7',
      '--wpx-line': 'rgba(255,233,199,.18)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SANS,
      '--wpx-radius': '10px',
      '--wpx-grain-opacity': '0.05',
      '--wpx-vignette-opacity': '0.5',
    },
    preview: { bg: '#0B0816', fg: '#F6F1EA', accent: '#FF5C8A' },
    grain: true,
    vignette: true,
  },
  {
    id: 'celadon',
    name: '青瓷',
    desc: '青瓷绿 / 墨绿 / 赭石 · 清雅',
    vars: {
      '--wpx-bg': '#E9F0EA',
      '--wpx-fg': '#17251F',
      '--wpx-fg-2': '#3D534A',
      '--wpx-muted': '#7C8E83',
      '--wpx-accent': '#4C7A66',
      '--wpx-accent-2': '#9C6B3F',
      '--wpx-line': 'rgba(23,37,31,.14)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SERIF,
      '--wpx-radius': '8px',
      '--wpx-grain-opacity': '0.03',
      '--wpx-vignette-opacity': '0.12',
    },
    preview: { bg: '#E9F0EA', fg: '#17251F', accent: '#4C7A66' },
    grain: false,
    vignette: false,
  },
  {
    id: 'midnight',
    name: '午夜',
    desc: '午夜蓝 / 冷白 / 电光蓝 · 科技',
    vars: {
      '--wpx-bg': '#0B1220',
      '--wpx-fg': '#E6ECF5',
      '--wpx-fg-2': '#B3C0D4',
      '--wpx-muted': '#7A8798',
      '--wpx-accent': '#4D8DFF',
      '--wpx-accent-2': '#7FD1C8',
      '--wpx-line': 'rgba(230,236,245,.16)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SANS,
      '--wpx-radius': '8px',
      '--wpx-grain-opacity': '0.04',
      '--wpx-vignette-opacity': '0.42',
    },
    preview: { bg: '#0B1220', fg: '#E6ECF5', accent: '#4D8DFF' },
    grain: true,
    vignette: true,
  },
  {
    id: 'vermilion',
    name: '朱砂',
    desc: '漆黑夜 / 朱砂红 / 鎏金 · 戏剧感',
    vars: {
      '--wpx-bg': '#120705',
      '--wpx-fg': '#F6E7DB',
      '--wpx-fg-2': '#D9BFAE',
      '--wpx-muted': '#9A7E6F',
      '--wpx-accent': '#FF5030',
      '--wpx-accent-2': '#F2B544',
      '--wpx-line': 'rgba(246,231,219,.17)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SERIF,
      '--wpx-radius': '4px',
      '--wpx-grain-opacity': '0.05',
      '--wpx-vignette-opacity': '0.52',
    },
    preview: { bg: '#120705', fg: '#F6E7DB', accent: '#FF5030' },
    grain: true,
    vignette: true,
  },
  {
    id: 'mono',
    name: '黑白',
    desc: '纯白 / 纯黑 / 灰阶 · 极简',
    vars: {
      '--wpx-bg': '#FAFAF9',
      '--wpx-fg': '#141414',
      '--wpx-fg-2': '#4A4A4A',
      '--wpx-muted': '#8C8C8C',
      '--wpx-accent': '#141414',
      '--wpx-accent-2': '#C9C9C9',
      '--wpx-line': 'rgba(20,20,20,.12)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SANS,
      '--wpx-radius': '2px',
      '--wpx-grain-opacity': '0.02',
      '--wpx-vignette-opacity': '0.08',
    },
    preview: { bg: '#FAFAF9', fg: '#141414', accent: '#141414' },
    grain: false,
    vignette: false,
  },
  {
    id: 'editorial',
    name: '报刊',
    desc: '报纸白 / 墨黑 / 油墨蓝 · 编辑风',
    vars: {
      '--wpx-bg': '#FBF8F1',
      '--wpx-fg': '#16151A',
      '--wpx-fg-2': '#46444B',
      '--wpx-muted': '#85817C',
      '--wpx-accent': '#1B3A8C',
      '--wpx-accent-2': '#B5342A',
      '--wpx-line': 'rgba(22,21,26,.16)',
      '--wpx-serif': SERIF,
      '--wpx-sans': SANS,
      '--wpx-latin': LATIN_SERIF,
      '--wpx-radius': '2px',
      '--wpx-grain-opacity': '0.03',
      '--wpx-vignette-opacity': '0.1',
    },
    preview: { bg: '#FBF8F1', fg: '#16151A', accent: '#1B3A8C' },
    grain: true,
    vignette: false,
  },
];

export const THEME_MAP = Object.fromEntries(THEMES.map((t) => [t.id, t]));

/* ---------- 字体组合 ---------- */
export const FONT_PAIRS = [
  {
    id: 'serifSans',
    label: '衬线标题',
    desc: '衬线标题 + 无衬线正文（最稳的编辑感）',
    vars: { '--wpx-serif': SERIF, '--wpx-sans': SANS, '--wpx-latin': LATIN_SANS },
  },
  {
    id: 'sansAll',
    label: '全无衬线',
    desc: '标题正文统一无衬线（现代、干净）',
    vars: { '--wpx-serif': SANS, '--wpx-sans': SANS, '--wpx-latin': LATIN_SANS },
  },
  {
    id: 'serifAll',
    label: '全衬线',
    desc: '标题正文统一衬线（文学、艺术、文化）',
    vars: { '--wpx-serif': SERIF, '--wpx-sans': SERIF, '--wpx-latin': LATIN_SERIF },
  },
  {
    id: 'monoAccent',
    label: '等宽点缀',
    desc: '衬线标题 + 等宽数字/英文（技术、数据）',
    vars: { '--wpx-serif': SERIF, '--wpx-sans': SANS, '--wpx-latin': MONO },
  },
];

/* ---------- 背景预设 ---------- */
const NOISE_URI = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.86' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.55'/%3E%3C/svg%3E\")";

export const BG_COLORS = [
  { id: 'ink', label: '墨黑', color: '#0A0A0B' },
  { id: 'graphite', label: '石墨', color: '#1D1D1F' },
  { id: 'bone', label: '骨白', color: '#F2EAE0' },
  { id: 'cream', label: '暖米', color: '#F4F1E9' },
  { id: 'bloomDeep', label: '夜紫', color: '#0B0816' },
  { id: 'navy', label: '午夜蓝', color: '#0B1220' },
  { id: 'celadon', label: '青瓷', color: '#E9F0EA' },
  { id: 'cinnabar', label: '朱砂', color: '#C03A1B' },
];

export const TEXTURE_PRESETS = [
  { id: 'paper', label: '纸纹', kind: 'bg', desc: '暖白底 + 细噪点纸纹' },
  { id: 'vignette', label: '暗角', kind: 'flag', flag: 'vignette', desc: '四周压暗，聚焦中心' },
  { id: 'grain', label: '颗粒', kind: 'flag', flag: 'grain', desc: '全局胶片颗粒' },
];

const PAPER_BG = NOISE_URI + ' 0 0/140px 140px repeat, #F4F1E9';

/* ---------- 模块状态 ---------- */
const ui = {
  ctx: null,
  root: null,
  themeCards: [],
  pairCards: [],
  currentTheme: 'ink',
  currentPair: '',
  currentVars: { ...THEME_MAP.ink.vars },
  flags: { grain: THEME_MAP.ink.grain, vignette: THEME_MAP.ink.vignette },
  scope: 'slide',
  bgPanel: null,
  bgOpen: false,
  outsideHandler: null,
  escHandler: null,
  flagsLoaded: false,
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

function getProject() {
  const st = getState();
  return (st && st.project) || null;
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
    console.warn('[themes] bridge.' + method + ' 失败 params=' + JSON.stringify(params), err);
  }
  return null;
}

/** 画布是否已就绪（避免 deck 重载间隙调用 bridge） */
function deckReady() {
  const st = getState();
  return !!(st && st.deck && st.deck.ready);
}

async function patchProjectTheme(themeId) {
  const project = getProject();
  if (!project || !project.id || !ctx().api?.patchProject) return false;
  try {
    await ctx().api.patchProject(project.id, { theme: themeId });
    return true;
  } catch (err) {
    // 服务端 PATCH 只保证 name/cover，theme 失败不影响视觉应用
    console.warn('[themes] 工程元数据 theme 未保存（可忽略）', err && err.message);
    return false;
  }
}

/* ---------- 从 deck 读取当前状态（只读兜底） ---------- */
function deckDoc() {
  try { return ctx().getEditor()?.iframe?.contentDocument || null; } catch { return null; }
}

function readDeckFlagsFromDom() {
  try {
    const body = deckDoc()?.body;
    if (!body) return null;
    return {
      grain: body.getAttribute('data-wpx-grain') === 'on',
      vignette: body.getAttribute('data-wpx-vignette') === 'on',
    };
  } catch { return null; }
}

function readSlideBg(index) {
  try {
    const doc = deckDoc();
    if (!doc) return '';
    const section = doc.querySelectorAll('.wpx-slide')[index];
    if (!section) return '';
    return section.getAttribute('data-bg') || '';
  } catch { return ''; }
}

function syncFromProject() {
  const project = getProject();
  const id = project && project.theme && THEME_MAP[project.theme] ? project.theme : '';
  if (id) {
    ui.currentTheme = id;
    ui.currentVars = { ...THEME_MAP[id].vars };
    ui.flags = { grain: THEME_MAP[id].grain, vignette: THEME_MAP[id].vignette };
    ui.flagsLoaded = false;
  }
}

/** 读取 deck 当前 flags（bridge → iframe 只读 → 主题默认值） */
async function loadFlags(force = false) {
  if (ui.flagsLoaded && !force) return;
  const res = await callBridge('getDeckFlags', {});
  if (res && typeof res === 'object') {
    if (typeof res.grain === 'boolean') ui.flags.grain = res.grain;
    if (typeof res.vignette === 'boolean') ui.flags.vignette = res.vignette;
    ui.flagsLoaded = true;
  } else {
    const dom = readDeckFlagsFromDom();
    if (dom) { ui.flags = dom; ui.flagsLoaded = true; }
  }
  refreshToolbar();
}

/* ---------- 应用主题 ---------- */
async function applyTheme(themeId, opts = {}) {
  const theme = THEME_MAP[themeId];
  if (!theme) {
    toast('未知主题：' + themeId, 'warn');
    return { ok: false, error: '未知主题: ' + themeId };
  }
  const vars = { ...theme.vars };
  const res = await callBridge('setThemeVars', { vars });
  await callBridge('setDeckFlags', { grain: theme.grain, vignette: theme.vignette });
  ui.currentTheme = theme.id;
  ui.currentPair = '';
  ui.currentVars = vars;
  ui.flags = { grain: theme.grain, vignette: theme.vignette };
  ui.flagsLoaded = true;
  await patchProjectTheme(theme.id);
  try {
    ctx().store.update((s) => { if (s.project) s.project.theme = theme.id; });
  } catch { /* ignore */ }
  refreshToolbar();
  if (opts.silent !== true) toast('已应用主题「' + theme.name + '」', 'ok', 1600);
  return { ok: true, theme: theme.id, op: res && res.op };
}

/* ---------- 应用字体组合 ---------- */
async function applyFontPair(pairId, opts = {}) {
  const pair = FONT_PAIRS.find((p) => p.id === pairId) || FONT_PAIRS[0];
  const vars = { ...ui.currentVars, ...pair.vars };
  const res = await callBridge('setThemeVars', { vars });
  ui.currentPair = pair.id;
  ui.currentVars = vars;
  refreshToolbar();
  if (opts.silent !== true) toast('字体组合：' + pair.label, 'ok', 1400);
  return { ok: true, fontPair: pair.id, op: res && res.op };
}

/* ---------- 应用背景 ---------- */
async function applyColorBg(color, scope = ui.scope) {
  if (!color) return { ok: false, error: '缺少颜色' };
  if (slideCount() < 1 || !deckReady()) {
    toast('画布还没就绪，请稍后再试', 'warn', 1600);
    return { ok: false, error: '画布未就绪' };
  }
  const index = Math.min(currentSlideIndex(), Math.max(0, slideCount() - 1));
  const all = scope === 'all';
  let res = null;
  if (all) {
    const total = slideCount();
    for (let i = 0; i < total; i++) {
      const r = await callBridge('setSlideAttrs', { index: i, attrs: { bg: color } });
      if (r) res = r;
    }
  } else {
    res = await callBridge('setSlideAttrs', { index, attrs: { bg: color } });
  }
  toast(all ? '已设置全部页背景' : '已设置本页背景', 'ok', 1400);
  refreshBgPanel();
  return { ok: true, bg: color, scope: all ? 'all' : 'slide', op: res && res.op };
}

async function applyTexture(textureId, scope = ui.scope) {
  const preset = TEXTURE_PRESETS.find((t) => t.id === textureId);
  if (!preset) return { ok: false, error: '未知纹理: ' + textureId };
  if (preset.kind === 'bg') return applyColorBg(PAPER_BG, scope);
  const value = !ui.flags[preset.flag];
  const res = await setDeckFlag(preset.flag, value);
  return { ok: true, flag: preset.flag, value, op: res && res.op };
}

/* ---------- deck flags（颗粒 / 暗角） ---------- */
async function setDeckFlag(flag, value, opts = {}) {
  const next = typeof value === 'boolean' ? value : !ui.flags[flag];
  ui.flags[flag] = next;
  const res = await callBridge('setDeckFlags', { [flag]: next });
  refreshToolbar();
  if (res == null && bridge() == null) {
    toast('运行时未就绪：仅保存界面状态', 'warn', 1800);
  } else if (opts.silent !== true) {
    const label = flag === 'grain' ? '颗粒' : '暗角';
    toast(label + (next ? '：已开启' : '：已关闭'), 'ok', 1300);
  }
  return { ok: true, [flag]: next, op: res && res.op };
}

/* ---------- 工具条 ---------- */
function refreshToolbar() {
  if (!ui.root) return;
  const theme = THEME_MAP[ui.currentTheme];
  const valueEl = ui.root.querySelector('.wpx-cur-value');
  if (valueEl) valueEl.textContent = theme ? theme.name : '自定义';
  const tagEl = ui.root.querySelector('.wpx-cur-tag');
  if (tagEl) tagEl.textContent = theme ? theme.id : '';

  const grainInput = ui.root.querySelector('[data-act="grain"]');
  if (grainInput) grainInput.checked = !!ui.flags.grain;
  const vigInput = ui.root.querySelector('[data-act="vignette"]');
  if (vigInput) vigInput.checked = !!ui.flags.vignette;

  ui.themeCards.forEach((card) => card.classList.toggle('is-active', card.dataset.theme === ui.currentTheme));
  ui.pairCards.forEach((card) => card.classList.toggle('is-active', card.dataset.pair === ui.currentPair));
  refreshBgPanel();
}

/* ---------- 背景面板 ---------- */
function buildBgPanel() {
  if (ui.bgPanel) return ui.bgPanel;
  const swatches = h('div', { class: 'bg-swatches' });
  for (const c of BG_COLORS) {
    const sw = h('button', {
      class: 'bg-swatch', type: 'button', 'data-color': c.color, 'data-tip': c.label + ' ' + c.color,
      title: c.label + ' ' + c.color,
    });
    sw.style.background = c.color;
    on(sw, 'click', () => applyColorBg(c.color, ui.scope));
    swatches.append(sw);
  }

  const textures = h('div', { class: 'bg-textures' });
  for (const t of TEXTURE_PRESETS) {
    const btn = h('button', {
      class: 'bg-texture', type: 'button', 'data-texture': t.id, 'data-tip': t.desc,
    }, h('span', { class: 'bg-texture-preview bg-texture-preview--' + t.id }), h('span', { class: 'bg-texture-label' }, t.label));
    on(btn, 'click', () => applyTexture(t.id, ui.scope));
    textures.append(btn);
  }

  const scopeSeg = h('div', { class: 'seg bg-scope' });
  const mkScope = (id, label) => {
    const btn = h('button', { type: 'button', class: ui.scope === id ? 'is-active' : '', 'data-scope': id }, label);
    on(btn, 'click', () => {
      ui.scope = id;
      scopeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b.dataset.scope === id));
    });
    return btn;
  };
  scopeSeg.append(mkScope('slide', '当前页'), mkScope('all', '全部页'));

  const curBg = h('div', { class: 'bg-current muted' }, '');
  ui.bgPanel = h('div', { class: 'design-pop bg-panel', role: 'dialog', 'aria-label': '页面背景' },
    h('div', { class: 'design-pop-head' },
      h('span', { class: 'design-pop-title' }, '页面背景'),
      h('span', { class: 'wpx-grow' }),
      h('button', {
        class: 'icon-btn icon-btn--sm', type: 'button', 'data-tip': '关闭',
        html: icon('x', 14), onclick: () => toggleBgPanel(false),
      })),
    h('div', { class: 'design-pop-row' }, h('span', { class: 'design-pop-label' }, '范围'), scopeSeg),
    h('div', { class: 'design-pop-label' }, '纯色'),
    swatches,
    h('div', { class: 'design-pop-label' }, '纹理 / 质感'),
    textures,
    curBg);
  ui.bgPanel._cur = curBg;
  (document.getElementById('overlay-root') || document.body).append(ui.bgPanel);
  return ui.bgPanel;
}

function refreshBgPanel() {
  if (!ui.bgPanel) return;
  const cur = ui.bgPanel._cur;
  if (cur) {
    const bg = readSlideBg(currentSlideIndex());
    cur.textContent = bg ? '本页背景：' + bg : '本页背景：跟随主题';
  }
  ui.bgPanel.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('is-active', b.dataset.scope === ui.scope));
}

function positionBgPanel() {
  if (!ui.bgPanel) return;
  const anchor = ui.root && ui.root.querySelector('[data-act="bg"]');
  const rect = anchor ? anchor.getBoundingClientRect() : { left: 120, bottom: 130, top: 40 };
  const width = ui.bgPanel.offsetWidth || 320;
  const height = ui.bgPanel.offsetHeight || 300;
  let left = Math.min(rect.left, window.innerWidth - width - 12);
  left = Math.max(10, left);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 8);
  ui.bgPanel.style.left = left + 'px';
  ui.bgPanel.style.top = top + 'px';
}

function toggleBgPanel(force) {
  const open = typeof force === 'boolean' ? force : !ui.bgOpen;
  if (open === ui.bgOpen) return;
  ui.bgOpen = open;
  const btn = ui.root && ui.root.querySelector('[data-act="bg"]');
  if (btn) btn.classList.toggle('is-active', open);
  if (open) {
    buildBgPanel();
    refreshBgPanel();
    ui.bgPanel.classList.add('is-open');
    positionBgPanel();
    const onOutside = (e) => {
      if (!ui.bgPanel) return;
      if (ui.bgPanel.contains(e.target)) return;
      if (btn && btn.contains(e.target)) return;
      toggleBgPanel(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') toggleBgPanel(false); };
    ui.outsideHandler = onOutside;
    ui.escHandler = onEsc;
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
  } else {
    ui.bgPanel.classList.remove('is-open');
    if (ui.outsideHandler) document.removeEventListener('pointerdown', ui.outsideHandler, true);
    if (ui.escHandler) document.removeEventListener('keydown', ui.escHandler, true);
    ui.outsideHandler = null;
    ui.escHandler = null;
  }
}

/* ---------- 主题卡 / 字体卡 ---------- */
function buildThemeCard(theme) {
  const v = theme.vars;
  const mini = h('div', { class: 'theme-mini' });
  mini.style.background = v['--wpx-bg'];
  const aa = h('span', { class: 'theme-mini-aa' }, 'Aa');
  aa.style.color = v['--wpx-fg'];
  aa.style.fontFamily = v['--wpx-serif'];
  const bar = h('span', { class: 'theme-mini-bar' });
  bar.style.background = v['--wpx-accent'];
  const dot = h('span', { class: 'theme-mini-dot' });
  dot.style.background = v['--wpx-accent-2'];
  const line = h('span', { class: 'theme-mini-line' });
  line.style.background = v['--wpx-line'];
  mini.append(aa, bar, dot, line);
  const card = h('button', {
    class: 'theme-card', type: 'button', 'data-theme': theme.id,
    'data-tip': theme.name + ' · ' + theme.desc,
    title: theme.id,
  }, mini, h('span', { class: 'theme-card-label ellipsis' }, theme.name));
  on(card, 'click', () => applyTheme(theme.id));
  return card;
}

function buildPairCard(pair) {
  const preview = h('span', { class: 'pair-preview' }, 'Aa 文');
  preview.style.fontFamily = pair.vars['--wpx-serif'];
  const card = h('button', {
    class: 'pair-card', type: 'button', 'data-pair': pair.id,
    'data-tip': pair.label + ' · ' + pair.desc, title: pair.desc,
  }, preview, h('span', { class: 'pair-card-label ellipsis' }, pair.label));
  on(card, 'click', () => applyFontPair(pair.id));
  return card;
}

function buildGallery() {
  const row = h('div', { class: 'design-row', role: 'list', 'aria-label': '主题与字体' });
  row.append(h('div', { class: 'fx-row-cat' }, h('span', { class: 'fx-row-cat-label' }, '主题'), h('span', { class: 'fx-row-cat-line' })));
  ui.themeCards = [];
  for (const theme of THEMES) {
    const card = buildThemeCard(theme);
    ui.themeCards.push(card);
    row.append(card);
  }
  row.append(h('div', { class: 'fx-row-cat' }, h('span', { class: 'fx-row-cat-label' }, '字体组合'), h('span', { class: 'fx-row-cat-line' })));
  ui.pairCards = [];
  for (const pair of FONT_PAIRS) {
    const card = buildPairCard(pair);
    ui.pairCards.push(card);
    row.append(card);
  }
  return row;
}

/* ---------- 工具条 ---------- */
function switchControl(attr, checked, handler, tip) {
  const input = h('input', { type: 'checkbox', 'data-act': attr });
  input.checked = !!checked;
  on(input, 'change', () => handler(input.checked));
  return h('label', { class: 'switch wpx-loop', 'data-tip': tip }, input, h('i'));
}

function buildToolbar() {
  const curValue = h('span', { class: 'wpx-cur-value ellipsis' }, '墨韵');
  const curTag = h('span', { class: 'wpx-cur-tag' }, 'ink');
  const cur = h('div', { class: 'wpx-cur', 'data-tip': '当前主题' }, curValue, curTag);

  const bgBtn = h('button', {
    class: 'btn btn--sm wpx-bg-btn', type: 'button', 'data-act': 'bg', 'data-tip': '页面背景：纯色 / 纸纹 / 颗粒 / 暗角',
  }, ic('droplet', 14), h('span', {}, '背景'));
  on(bgBtn, 'click', () => toggleBgPanel());

  return h('div', { class: 'wpx-tab-bar' },
    cur,
    h('span', { class: 'wpx-sep' }),
    bgBtn,
    h('label', { class: 'wpx-field wpx-field--switch' },
      h('span', { class: 'wpx-field-label' }, '颗粒'), switchControl('grain', ui.flags.grain, (v) => setDeckFlag('grain', v), '全局颗粒质感（胶片噪点）')),
    h('label', { class: 'wpx-field wpx-field--switch' },
      h('span', { class: 'wpx-field-label' }, '暗角'), switchControl('vignette', ui.flags.vignette, (v) => setDeckFlag('vignette', v), '四周压暗（聚焦中心）')),
    h('span', { class: 'wpx-grow' }),
    h('span', { class: 'wpx-hint muted' }, '点主题卡立即应用 · 字体组合可叠加'),
  );
}

/* ---------- Ribbon 渲染 ---------- */
function buildTab(container) {
  container.classList.add('wpx-tabhost');
  container.replaceChildren();
  container.append(h('div', { class: 'wpx-tab wpx-tab--design' },
    buildToolbar(),
    h('div', { class: 'wpx-tab-gallery wpx-tab-gallery--design' }, buildGallery())));
  ui.root = container.querySelector('.wpx-tab');
  if (!ui.flagsLoaded) syncFromProject();
  refreshToolbar();
  loadFlags();
}

/* ---------- 命令注册 ---------- */
function registerCommands(context) {
  const reg = (name, fn, meta) => context.bus.registerCommand(name, fn, meta);

  reg('design.theme', async (payload = {}) => {
    const id = payload.id || payload.themeId || payload.theme;
    if (!id) {
      try { context.ribbon?.setActiveTab?.(TAB_ID); } catch { /* ignore */ }
      toast('请在主题卡中选择一套主题', 'info');
      return { ok: false, error: '缺少主题 id' };
    }
    return applyTheme(id, { silent: !!payload.silent });
  }, { label: '应用主题', group: '设计', icon: 'palette', payload: '{id|themeId}' });

  reg('design.fontPair', async (payload = {}) => {
    const id = payload.id || payload.pairId || payload.fontPair;
    return applyFontPair(id);
  }, { label: '字体组合', group: '设计', icon: 'type', payload: '{id: serifSans|sansAll|serifAll|monoAccent}' });

  reg('design.background', async (payload = {}) => {
    const scope = payload.scope === 'all' ? 'all' : 'slide';
    if (payload.texture) return applyTexture(payload.texture, scope);
    const color = payload.color || payload.bg;
    if (!color) {
      try { context.ribbon?.setActiveTab?.(TAB_ID); } catch { /* ignore */ }
      toggleBgPanel(true);
      toast('请选择背景色或纹理', 'info');
      return { ok: false, error: '缺少 color/texture' };
    }
    return applyColorBg(color, scope);
  }, { label: '页面背景', group: '设计', icon: 'droplet', payload: '{color?|texture?, scope?: slide|all}' });

  reg('design.grain', async (payload = {}) => {
    const value = typeof payload.on === 'boolean' ? payload.on : (typeof payload.value === 'boolean' ? payload.value : undefined);
    const res = await setDeckFlag('grain', value);
    return { ok: true, grain: res.grain };
  }, { label: '颗粒质感', group: '设计', icon: 'grid', payload: '{on?}' });

  reg('design.vignette', async (payload = {}) => {
    const value = typeof payload.on === 'boolean' ? payload.on : (typeof payload.value === 'boolean' ? payload.value : undefined);
    const res = await setDeckFlag('vignette', value);
    return { ok: true, vignette: res.vignette };
  }, { label: '暗角', group: '设计', icon: 'moon', payload: '{on?}' });
}

/* ---------- 事件订阅 ---------- */
function subscribe(context) {
  context.bus.on('deck:ready', () => {
    syncFromProject();
    ui.flagsLoaded = false;
    loadFlags();
    refreshToolbar();
  });
  context.bus.on('project:open', () => {
    syncFromProject();
    ui.flagsLoaded = false;
    refreshToolbar();
  });
  context.bus.on('project:close', () => {
    toggleBgPanel(false);
    ui.currentPair = '';
  });
  context.bus.on('slide:change', () => { refreshBgPanel(); });
  context.bus.on('history:change', () => { refreshToolbar(); });
  window.addEventListener('resize', () => { if (ui.bgOpen) positionBgPanel(); });
}

/* ---------- 注册 Ribbon 标签 ---------- */
function tryRegisterTab(context) {
  const ribbon = context.ribbon;
  if (!ribbon || typeof ribbon.registerTab !== 'function') return false;
  try {
    ribbon.registerTab(TAB_ID, {
      label: '设计',
      order: TAB_ORDER,
      icon: 'palette',
      render: (container) => buildTab(container),
    });
    return true;
  } catch (err) {
    console.warn('[themes] registerTab 失败', err);
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

export { PAPER_BG };
export default { init, THEMES };
