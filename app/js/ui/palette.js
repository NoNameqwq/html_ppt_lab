/* Ctrl+K 命令面板
 *
 * - 列出 bus.listCommands() 的全部命令（按 meta.label / meta.group 展示，缺 meta 时用内置中文兜底表）
 * - 输入即筛（标签 / 命令名 / 关键词 / 分组），↑↓ 选择，Enter 执行，Esc 关闭，点击外部关闭
 * - 最近使用存 localStorage；面板关闭后把焦点还给原元素
 */

import { h } from '../core/dom.js';
import { icon } from './icons.js';

const RECENT_KEY = 'wds:palette:recent';
const RECENT_MAX = 8;
const GROUP_ORDER = ['应用', '文件', '幻灯片', '编辑', '文本', '插入', '排列', '元素', '设计', '切换', '动画', '视图', 'Agent', '历史', '帮助', '其他'];

/* SPEC §8.2 命令名的中文兜底元数据：[label, group, icon, shortcut?] */
const FALLBACK_META = {
  'app.back': ['返回文件库', '应用', 'arrow-left'],
  'app.save': ['保存工程', '应用', 'save', 'Ctrl+S'],
  'app.export': ['导出 HTML', '应用', 'download'],
  'app.print': ['打印 / 另存为 PDF', '应用', 'print'],
  'app.present': ['从头开始放映', '动画', 'present', 'F5'],
  'app.presentCurrent': ['从当前页放映', '动画', 'play-circle', 'Shift+F5'],
  'app.undo': ['撤销', '应用', 'undo', 'Ctrl+Z'],
  'app.redo': ['重做', '应用', 'redo', 'Ctrl+Y'],
  'app.toggleAgent': ['显示 / 隐藏 Agent 面板', '应用', 'bot', 'Ctrl+Shift+E'],
  'app.toggleInspector': ['属性面板', '视图', 'panel-right'],
  'app.toggleSlidePanel': ['幻灯片面板', '视图', 'panel-left'],
  'app.zoomIn': ['放大画布', '视图', 'zoom-in'],
  'app.zoomOut': ['缩小画布', '视图', 'zoom-out'],
  'app.zoomReset': ['画布缩放到 100%', '视图', 'refresh'],
  'app.zoomFit': ['适应窗口', '视图', 'fit'],
  'app.commandPalette': ['命令面板', '应用', 'command', 'Ctrl+K'],
  'app.settings': ['API 设置', '应用', 'sparkles'],
  'app.toggleTheme': ['切换深色 / 浅色', '视图', 'moon'],
  'app.reloadDeck': ['重新加载画布', '应用', 'refresh'],
  'file.new': ['新建工程', '文件', 'plus'],
  'file.import': ['导入 HTML 原稿', '文件', 'import'],
  'file.rename': ['重命名工程', '文件', 'edit'],
  'file.delete': ['删除工程', '文件', 'trash'],
  'file.duplicate': ['复制工程', '文件', 'copy'],
  'slide.add': ['新建幻灯片', '幻灯片', 'slide-plus'],
  'slide.duplicate': ['复制幻灯片', '幻灯片', 'copy'],
  'slide.delete': ['删除幻灯片', '幻灯片', 'trash'],
  'slide.move': ['移动幻灯片', '幻灯片', 'move'],
  'slide.select': ['选择幻灯片', '幻灯片', 'slide'],
  'slide.setTransition': ['设置切换效果', '切换', 'film'],
  'slide.applyTransitionAll': ['切换应用到全部', '切换', 'layers'],
  'slide.setBackground': ['页面背景', '设计', 'droplet'],
  'slide.setName': ['重命名幻灯片', '幻灯片', 'edit'],
  'slide.previewAnimation': ['预览当前页动画', '动画', 'play-circle'],
  'edit.cut': ['剪切', '编辑', 'scissors', 'Ctrl+X'],
  'edit.copy': ['复制', '编辑', 'copy', 'Ctrl+C'],
  'edit.paste': ['粘贴', '编辑', 'clipboard', 'Ctrl+V'],
  'edit.delete': ['删除元素', '编辑', 'trash', 'Delete'],
  'edit.selectAll': ['全选元素', '编辑', 'frame', 'Ctrl+A'],
  'edit.duplicate': ['复制元素', '编辑', 'copy', 'Ctrl+D'],
  'edit.deselect': ['取消选择', '编辑', 'x', 'Esc'],
  'text.bold': ['加粗', '文本', 'bold', 'Ctrl+B'],
  'text.italic': ['斜体', '文本', 'italic', 'Ctrl+I'],
  'text.underline': ['下划线', '文本', 'underline', 'Ctrl+U'],
  'text.strike': ['删除线', '文本', 'strike'],
  'text.fontFamily': ['字体', '文本', 'type'],
  'text.fontSize': ['字号', '文本', 'type'],
  'text.color': ['字体颜色', '文本', 'text-color'],
  'text.highlight': ['高亮颜色', '文本', 'highlight'],
  'text.align': ['文本对齐', '文本', 'align-left'],
  'text.lineHeight': ['行距', '文本', 'line-height'],
  'text.letterSpacing': ['字距', '文本', 'letter-spacing'],
  'text.style': ['文字样式', '文本', 'type'],
  'insert.text': ['插入文本框', '插入', 'text-box'],
  'insert.image': ['插入图片', '插入', 'image'],
  'insert.shape': ['插入形状', '插入', 'shapes'],
  'insert.line': ['插入线条', '插入', 'line'],
  'insert.icon': ['插入图标', '插入', 'icon-grid'],
  'insert.html': ['插入 HTML 代码块', '插入', 'code'],
  'arrange.front': ['置于顶层', '排列', 'bring-front'],
  'arrange.back': ['置于底层', '排列', 'send-back'],
  'arrange.forward': ['上移一层', '排列', 'bring-forward'],
  'arrange.backward': ['下移一层', '排列', 'send-backward'],
  'arrange.alignLeft': ['左对齐', '排列', 'align-left'],
  'arrange.alignCenter': ['水平居中', '排列', 'align-center'],
  'arrange.alignRight': ['右对齐', '排列', 'align-right'],
  'arrange.alignTop': ['顶对齐', '排列', 'align-top'],
  'arrange.alignMiddle': ['垂直居中', '排列', 'align-middle'],
  'arrange.alignBottom': ['底对齐', '排列', 'align-bottom'],
  'arrange.distributeH': ['水平分布', '排列', 'distribute-h'],
  'arrange.distributeV': ['垂直分布', '排列', 'distribute-v'],
  'element.rotate': ['旋转元素', '元素', 'rotate'],
  'element.opacity': ['透明度', '元素', 'droplet'],
  'element.animation': ['添加动画', '动画', 'wand'],
  'element.animationRemove': ['移除动画', '动画', 'x-circle'],
  'element.animationPreview': ['预览元素动画', '动画', 'play-circle'],
  'element.lock': ['锁定元素', '元素', 'lock'],
  'element.unlock': ['解锁元素', '元素', 'unlock'],
  'design.theme': ['主题配色', '设计', 'palette'],
  'design.fontPair': ['字体组合', '设计', 'type'],
  'design.background': ['页面背景', '设计', 'image'],
  'design.grain': ['颗粒质感', '设计', 'grid'],
  'design.vignette': ['暗角', '设计', 'moon'],
  'view.zoom': ['缩放画布', '视图', 'zoom-in'],
  'view.grid': ['显示网格', '视图', 'grid'],
  'view.rulers': ['显示参考线', '视图', 'rulers'],
  'view.dark': ['深色模式', '视图', 'moon'],
  'view.fullscreen': ['全屏', '视图', 'fullscreen'],
  'view.slidePanel': ['显示幻灯片面板', '视图', 'panel-left'],
  'agent.newChat': ['Agent 新会话', 'Agent', 'message'],
  'agent.stop': ['停止生成', 'Agent', 'stop'],
  'agent.send': ['发送消息', 'Agent', 'send'],
  'agent.toggleSkill': ['切换技能', 'Agent', 'sparkles'],
  'agent.openSettings': ['Agent 设置', 'Agent', 'settings'],
  'agent.toggle': ['显示 / 隐藏 Agent', 'Agent', 'bot'],
  'history.open': ['历史记录', '历史', 'history'],
  'history.revertTo': ['回到某次修改', '历史', 'history'],
  'history.undo': ['历史撤销', '历史', 'undo'],
  'history.redo': ['历史重做', '历史', 'redo'],
};

let ctxRef = null;
let isOpen = false;
let wrapEl = null;
let panelEl = null;
let inputEl = null;
let listEl = null;
let footCountEl = null;
let previousFocus = null;
let commands = [];
let flatEntries = [];
let rowEls = [];
let activeIndex = -1;
let closingTimer = 0;

/* ============================================================
   数据
   ============================================================ */

function humanizeName(name) {
  return String(name)
    .split('.')
    .map((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .join(' · ');
}

function collectCommands() {
  const list = ctxRef.bus.listCommands();
  return list.map((meta) => {
    const fb = FALLBACK_META[meta.name] || [];
    const label = meta.label || fb[0] || humanizeName(meta.name);
    const group = meta.group || fb[1] || '其他';
    const keywords = [
      ...(Array.isArray(meta.keywords) ? meta.keywords : meta.keywords ? [meta.keywords] : []),
      meta.name,
      group,
      fb[0] || '',
    ].filter(Boolean);
    return {
      name: meta.name,
      label,
      group,
      icon: meta.icon || fb[2] || '',
      shortcut: meta.shortcut || fb[3] || '',
      keywords,
    };
  });
}

function groupRank(group) {
  const idx = GROUP_ORDER.indexOf(group);
  return idx < 0 ? GROUP_ORDER.length : idx;
}

function sortedCommands() {
  return [...commands].sort((a, b) => {
    const ga = groupRank(a.group);
    const gb = groupRank(b.group);
    if (ga !== gb) return ga - gb;
    const groupCmp = a.group.localeCompare(b.group, 'zh-Hans-CN');
    if (groupCmp) return groupCmp;
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
}

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(names) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(names.slice(0, RECENT_MAX)));
  } catch {
    /* 忽略 */
  }
}

function pushRecent(name) {
  const list = loadRecent().filter((n) => n !== name);
  list.unshift(name);
  saveRecent(list);
}

function searchCommands(query) {
  const q = query.toLowerCase();
  const scored = [];
  for (const c of commands) {
    const label = c.label.toLowerCase();
    const name = c.name.toLowerCase();
    const group = c.group.toLowerCase();
    let score = 0;
    if (label === q) score = 100;
    else if (label.startsWith(q)) score = 85;
    else if (label.includes(q)) score = 70;
    else if (name.includes(q)) score = 55;
    else if (c.keywords.some((k) => String(k).toLowerCase().includes(q))) score = 40;
    else if (group.includes(q)) score = 25;
    if (score) scored.push({ entry: c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label, 'zh-Hans-CN'));
  return scored.map((s) => s.entry);
}

/* ============================================================
   渲染
   ============================================================ */

function highlight(text, query) {
  const frag = document.createDocumentFragment();
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      frag.append(document.createTextNode(text.slice(i)));
      break;
    }
    if (idx > i) frag.append(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + q.length);
    frag.append(mark);
    i = idx + q.length;
  }
  return frag;
}

function makeRow(entry, query, index) {
  const iconName = entry.icon || 'command';
  const row = h('button', {
    class: 'cmdk-item',
    type: 'button',
    'data-index': String(index),
    role: 'option',
    'aria-selected': 'false',
  });
  row.append(h('span', { class: 'cmdk-item-ic', html: icon(iconName, 15) }));
  const label = h('span', { class: 'cmdk-label' });
  if (query) label.append(highlight(entry.label, query));
  else label.textContent = entry.label;
  row.append(label);
  row.append(h('span', { class: 'cmdk-hint' }, entry.group));
  if (entry.shortcut) row.append(h('span', { class: 'kbd cmdk-kbd' }, entry.shortcut));
  row.addEventListener('mouseenter', () => setActiveRow(index));
  row.addEventListener('click', () => execute(entry));
  return row;
}

function makeGroupLabel(text) {
  return h('div', { class: 'cmdk-group' }, text);
}

function renderList() {
  if (!listEl) return;
  const query = inputEl.value.trim();
  listEl.replaceChildren();
  flatEntries = [];
  rowEls = [];
  activeIndex = -1;

  if (!query) {
    const recentNames = loadRecent();
    const recentEntries = recentNames
      .map((name) => commands.find((c) => c.name === name))
      .filter(Boolean);
    const ordered = sortedCommands();
    const recentSet = new Set(recentEntries.map((c) => c.name));

    if (recentEntries.length) {
      listEl.append(makeGroupLabel('最近使用'));
      for (const entry of recentEntries) {
        const index = flatEntries.length;
        flatEntries.push(entry);
        const row = makeRow(entry, '', index);
        rowEls.push(row);
        listEl.append(row);
      }
    }

    let lastGroup = '';
    for (const entry of ordered) {
      if (recentSet.has(entry.name)) continue;
      if (entry.group !== lastGroup) {
        listEl.append(makeGroupLabel(entry.group));
        lastGroup = entry.group;
      }
      const index = flatEntries.length;
      flatEntries.push(entry);
      const row = makeRow(entry, '', index);
      rowEls.push(row);
      listEl.append(row);
    }
  } else {
    const results = searchCommands(query);
    if (!results.length) {
      listEl.append(
        h('div', { class: 'cmdk-empty' },
          h('span', { class: 'cmdk-empty-ic', html: icon('search', 22) }),
          h('span', {}, '没有匹配的命令'),
          h('span', { class: 'cmdk-empty-sub' }, '换个关键词试试，或按 Esc 关闭')),
      );
    } else {
      for (const entry of results) {
        const index = flatEntries.length;
        flatEntries.push(entry);
        const row = makeRow(entry, query, index);
        rowEls.push(row);
        listEl.append(row);
      }
    }
  }

  if (footCountEl) {
    footCountEl.textContent = query ? `${flatEntries.length} 个匹配` : `${commands.length} 个命令`;
  }
  if (flatEntries.length) setActiveRow(0, false);
}

function setActiveRow(index, scroll = true) {
  if (!flatEntries.length) {
    activeIndex = -1;
    return;
  }
  const next = Math.max(0, Math.min(flatEntries.length - 1, index));
  activeIndex = next;
  rowEls.forEach((row, i) => {
    const on = i === next;
    row.classList.toggle('is-active', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const row = rowEls[next];
  if (row && scroll) row.scrollIntoView?.({ block: 'nearest' });
}

function moveActive(delta) {
  if (!flatEntries.length) return;
  const next = (activeIndex + delta + flatEntries.length) % flatEntries.length;
  setActiveRow(next);
}

/* ============================================================
   执行 / 开关
   ============================================================ */

function execute(entry) {
  if (!entry) return;
  closePalette();
  pushRecent(entry.name);
  window.setTimeout(() => {
    ctxRef?.bus.runCommand(entry.name).catch?.((err) => {
      console.error('[palette] 命令执行失败', entry.name, err);
    });
  }, 80);
}

function onWindowKey(e) {
  if (!isOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    moveActive(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    moveActive(-1);
  } else if (e.key === 'PageDown') {
    e.preventDefault();
    moveActive(8);
  } else if (e.key === 'PageUp') {
    e.preventDefault();
    moveActive(-8);
  } else if (e.key === 'Enter') {
    if (activeIndex < 0) return;
    e.preventDefault();
    e.stopPropagation();
    execute(flatEntries[activeIndex]);
  } else if (e.key === 'Tab') {
    e.preventDefault();
  }
}

function onWrapPointerDown(e) {
  if (e.target === wrapEl) closePalette();
}

function buildPanel() {
  const head = h(
    'div',
    { class: 'cmdk-head' },
    h('span', { class: 'cmdk-search-ic', html: icon('search', 18) }),
    inputEl,
    h('span', { class: 'kbd cmdk-esc' }, 'Esc'),
  );

  listEl = h('div', { class: 'cmdk-list', role: 'listbox', 'aria-label': '命令列表' });

  footCountEl = h('span', { class: 'cmdk-foot-count' }, '');
  const foot = h(
    'div',
    { class: 'cmdk-foot' },
    h('span', { class: 'cmdk-foot-hint' }, h('span', { class: 'kbd' }, '↑↓'), '选择'),
    h('span', { class: 'cmdk-foot-hint' }, h('span', { class: 'kbd' }, '↵'), '执行'),
    h('span', { class: 'cmdk-foot-hint' }, h('span', { class: 'kbd' }, 'Esc'), '关闭'),
    h('span', { class: 'cmdk-foot-spacer' }),
    footCountEl,
  );

  panelEl = h(
    'div',
    { class: 'cmdk', role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板' },
    head,
    listEl,
    foot,
  );
  wrapEl = h('div', { class: 'cmdk-wrap' }, panelEl);
  wrapEl.addEventListener('pointerdown', onWrapPointerDown);
}

export function openPalette(ctx) {
  if (ctx) ctxRef = ctx;
  if (!ctxRef) return false;
  if (isOpen) {
    closePalette();
    return true;
  }

  commands = collectCommands();
  previousFocus = document.activeElement;

  inputEl = h('input', {
    class: 'cmdk-input',
    type: 'text',
    placeholder: '搜索命令，例如「加粗」「导出」「动画」…',
    'aria-label': '搜索命令',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  inputEl.addEventListener('input', renderList);
  inputEl.addEventListener('keydown', (e) => e.stopPropagation());

  buildPanel();

  const root = document.getElementById('overlay-root') || document.body;
  /* 清理可能残留的关闭动画节点 */
  root.querySelectorAll?.('.cmdk-wrap')?.forEach?.((el) => el.remove());
  root.append(wrapEl);
  isOpen = true;
  window.addEventListener('keydown', onWindowKey, true);

  renderList();
  requestAnimationFrame(() => {
    inputEl?.focus();
    inputEl?.select?.();
  });
  return true;
}

export function closePalette() {
  if (!isOpen) return;
  isOpen = false;
  window.removeEventListener('keydown', onWindowKey, true);
  const wrap = wrapEl;
  wrapEl = null;
  panelEl = null;
  inputEl = null;
  listEl = null;
  footCountEl = null;
  flatEntries = [];
  rowEls = [];
  activeIndex = -1;
  if (!wrap) return;
  wrap.classList.add('is-closing');
  clearTimeout(closingTimer);
  closingTimer = window.setTimeout(() => wrap.remove(), 140);
  const focusBack = previousFocus;
  previousFocus = null;
  if (focusBack && typeof focusBack.focus === 'function' && focusBack.isConnected) {
    try {
      focusBack.focus();
    } catch {
      /* 忽略 */
    }
  }
}

export function togglePalette(ctx) {
  if (isOpen) closePalette();
  else openPalette(ctx);
  return true;
}

export async function init(ctx) {
  ctxRef = ctx;
  /* 命令注册在 main.js（app.commandPalette）；这里只做挂载 */
}

export default { init, openPalette, closePalette, togglePalette };
