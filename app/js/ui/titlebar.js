/* 顶部标题栏（52px 单行）：品牌 / 路由感知操作区 + Ribbon 标签挂载点
 *
 * 文件库：品牌、搜索（bus 事件 library:search）、新建、导入、命令面板、API 设置、主题、帮助
 * 编辑器：品牌、返回、工程名（双击行内重命名）、保存状态、撤销/重做、
 *         醒目的 Agent 主按钮、放映（拆分）、更多菜单；
 *         中间 `#titlebar-tabs` 是 Ribbon 标签条的挂载点（ribbon.js 通过 ctx.ribbon.mountTabs() 挂入）。
 */

import { h, formatTime, debounce, isTypingTarget } from '../core/dom.js';
import { icon } from './icons.js';

const TABS_SLOT_ID = 'titlebar-tabs';

let ctxRef = null;
let els = {};
let syncPending = false;
let renameState = { input: null };

/* ============================================================
   小工具
   ============================================================ */

function cmd(name, payload) {
  return ctxRef.bus.runCommand(name, payload);
}

function tipText(label, kbd) {
  return kbd ? `${label}|${kbd}` : label;
}

/** 通用图标按钮 */
function iconBtn({ name, tip, kbd, onClick, className = '', disabled = false, active = false, size = 18 }) {
  const btn = h('button', {
    class: `icon-btn ${className}${active ? ' is-active' : ''}`.trim(),
    type: 'button',
    'data-tip': tip ? tipText(tip, kbd) : null,
    'aria-label': tip || name,
    disabled: disabled ? true : null,
    html: icon(name, size),
  });
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function setIcon(btn, name, size = 18) {
  if (btn) btn.innerHTML = icon(name, size);
}

/** 品牌标记（编辑器紧凑 / 文件库带字标） */
function brandMark({ full = false } = {}) {
  const children = [h('span', { class: 'tb-logo', html: icon('logo', 17) })];
  if (full) {
    children.push(
      h(
        'span',
        { class: 'tb-wordmark' },
        h('span', { class: 'tb-wordmark-main' }, 'WebDeck'),
        h('span', { class: 'tb-wordmark-sub' }, 'STUDIO'),
      ),
    );
  }
  const tip = ctxRef.route?.name === 'editor' ? '返回文件库' : 'WebDeck Studio · 文件库';
  const btn = h('button', {
    class: `tb-brand${full ? '' : ' tb-brand--compact'}`,
    type: 'button',
    'data-tip': tip,
    'aria-label': 'WebDeck Studio',
  }, ...children);
  btn.addEventListener('click', () => cmd('app.back'));
  return btn;
}

/** 让 Ribbon 把标签条挂到当前标题栏的插槽里（路由重建后需重新调用） */
function mountRibbonTabs() {
  try {
    ctxRef?.ribbon?.mountTabs?.();
  } catch (err) {
    console.error('[titlebar] 挂载 Ribbon 标签失败', err);
  }
}

/* ============================================================
   构建：文件库模式
   ============================================================ */

function buildLibrary() {
  const ctx = ctxRef;
  const searchInput = h('input', {
    class: 'tb-search-input',
    type: 'text',
    placeholder: '搜索工程…',
    'aria-label': '搜索工程',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const searchWrap = h(
    'div',
    { class: 'tb-search' },
    h('span', { class: 'tb-search-icon', html: icon('search', 17) }),
    searchInput,
    h('span', { class: 'kbd tb-search-kbd' }, '/'),
  );
  els.search = searchInput;

  const emitSearch = debounce((query) => {
    ctx.store.update((s) => { s.library.query = query; });
    ctx.bus.emit('library:search', { query });
  }, 180);

  searchInput.addEventListener('input', () => emitSearch(searchInput.value.trim()));
  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (searchInput.value) {
        searchInput.value = '';
        emitSearch.cancel();
        emitSearch.flush('');
      } else {
        searchInput.blur();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      emitSearch.cancel();
      emitSearch.flush(searchInput.value.trim());
    }
  });
  searchInput.addEventListener('blur', () => emitSearch.flush(searchInput.value.trim()));

  const themeBtn = iconBtn({
    name: 'moon',
    tip: '切换深色模式',
    onClick: () => cmd('app.toggleTheme'),
  });
  els.themeBtns = [themeBtn];

  const right = h(
    'div',
    { class: 'tb-right' },
    h(
      'button',
      { class: 'btn btn--primary tb-new', type: 'button', 'data-tip': '新建工程', onClick: () => cmd('file.new') },
      h('span', { class: 'tb-btn-ic', html: icon('plus', 17) }),
      '新建',
    ),
    h(
      'button',
      { class: 'btn tb-import', type: 'button', 'data-tip': '导入 HTML 原稿', onClick: () => cmd('file.import') },
      h('span', { class: 'tb-btn-ic', html: icon('import', 17) }),
      '导入',
    ),
    h('span', { class: 'tb-sep' }),
    iconBtn({ name: 'command', tip: '命令面板', kbd: 'Ctrl K', onClick: () => cmd('app.commandPalette') }),
    iconBtn({ name: 'terminal', tip: '打开 Agent', kbd: 'Ctrl Shift E', onClick: () => cmd('app.toggleAgent') }),
    iconBtn({name:'cloud',tip:'WebDAV 云端备份',onClick:()=>cmd('backup.open')}),
    iconBtn({ name: 'sparkles', tip: 'API 设置', onClick: () => cmd('app.settings') }),
    themeBtn,
    iconBtn({ name: 'help', tip: '快捷键与帮助', onClick: () => cmd('help.shortcuts') }),
  );

  els.root.replaceChildren(
    h('div', { class: 'tb-left' }, brandMark({ full: true })),
    h('div', { class: 'tb-center tb-center--library' }, searchWrap),
    right,
  );
}

/* ============================================================
   构建：编辑器模式
   ============================================================ */

function buildEditor() {
  const ctx = ctxRef;
  const project = ctx.store.get().project || { name: '未命名工程', kind: 'native' };

  /* 左：品牌 + 返回 + 文件名 + 来源徽章 */
  const backBtn = iconBtn({
    name: 'arrow-left',
    tip: '返回文件库',
    onClick: () => cmd('app.back'),
  });

  const nameEl = h('span', {
    class: 'tb-project-name',
    role: 'button',
    tabindex: '0',
    'data-tip': '双击重命名工程',
  }, project.name);
  nameEl.addEventListener('dblclick', startRename);
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      startRename();
    }
  });
  const projectWrap = h(
    'div',
    { class: 'tb-project' },
    nameEl,
    project.kind === 'imported'
      ? h('span', { class: 'badge tb-kind tb-kind--imported', 'data-tip': '由 HTML 原稿导入转换' }, '导入')
      : project.kind === 'raw'
        ? h('span', { class: 'badge tb-kind tb-kind--raw', 'data-tip': '网页工程：直接编辑网页，保留全部原动效' }, '网页')
        : h('span', { class: 'badge tb-kind', 'data-tip': '网页工程' }, '网页'),
  );
  els.nameEl = nameEl;

  /* 中：Ribbon 标签挂载点 */
  const tabsSlot = h('div', { class: 'tb-tabs-slot', id: TABS_SLOT_ID });
  els.tabsSlot = tabsSlot;

  /* 右：命令搜索 / 保存 / 撤销重做 / Agent / 放映 / 更多 */
  const paletteBtn = h(
    'button',
    { class: 'tb-cmd', type: 'button', 'data-tip': '命令面板|Ctrl K', onClick: () => cmd('app.commandPalette') },
    h('span', { class: 'tb-cmd-ic', html: icon('command', 16) }),
    h('span', { class: 'tb-cmd-text' }, '搜索命令'),
    h('span', { class: 'kbd tb-cmd-kbd' }, 'Ctrl K'),
  );

  const saveChip = h('button', { class: 'tb-save', type: 'button', 'data-tip': '保存到磁盘|Ctrl+S' });
  saveChip.append(
    h('span', { class: 'tb-save-ic', html: icon('check-circle', 15) }),
    h('span', { class: 'tb-save-text' }, '已保存'),
  );
  saveChip.addEventListener('click', () => cmd('app.save'));
  els.saveChip = saveChip;
  els.saveIc = saveChip.querySelector('.tb-save-ic');
  els.saveText = saveChip.querySelector('.tb-save-text');

  els.undo = iconBtn({ name: 'undo', tip: '撤销', kbd: 'Ctrl Z', onClick: () => cmd('app.undo'), disabled: true });
  els.redo = iconBtn({ name: 'redo', tip: '重做', kbd: 'Ctrl Y', onClick: () => cmd('app.redo'), disabled: true });

  /* Agent 主按钮：accent 实底 + 图标 + 文字 */
  els.agentMain = h(
    'button',
    {
      class: 'tb-agent-main',
      type: 'button',
      'data-tip': '显示 / 隐藏 Agent 助手|Ctrl Shift E',
      'aria-label': 'Agent 助手',
      'aria-pressed': 'false',
    },
    h('span', { class: 'tb-agent-ic', html: icon('bot', 18) }),
    h('span', { class: 'tb-agent-label' }, 'Agent'),
  );
  els.agentMain.addEventListener('click', () => cmd('app.toggleAgent'));

  /* 放映：深色实底主按钮 + 选项菜单 */
  const presentMenu = () => [
    { label: '从头开始放映', icon: 'present', shortcut: 'F5', onClick: () => cmd('app.present') },
    { label: '从当前页放映', icon: 'play-circle', shortcut: 'Shift+F5', onClick: () => cmd('app.presentCurrent') },
    { sep: true },
    { label: '重新加载画布', icon: 'refresh', onClick: () => cmd('app.reloadDeck') },
  ];
  const presentMain = h(
    'button',
    {
      class: 'tb-present-main',
      type: 'button',
      'data-tip': '从当前页放映|Shift F5',
      onClick: () => cmd('app.presentCurrent'),
    },
    h('span', { class: 'tb-btn-ic', html: icon('play', 15) }),
    h('span', { class: 'tb-label' }, '放映'),
  );
  const presentCaret = h('button', {
    class: 'tb-present-caret',
    type: 'button',
    'data-tip': '放映选项',
    'aria-label': '放映选项',
    html: icon('chevron-down', 14),
  });
  presentCaret.addEventListener('click', () => {
    ctx.overlay.menu({ anchor: presentCaret, align: 'end', items: presentMenu, minWidth: 210 });
  });
  const presentWrap = h('div', { class: 'tb-present' }, presentMain, presentCaret);

  /* 更多菜单 */
  const moreBtn = h('button', {
    class: 'icon-btn tb-more',
    type: 'button',
    'data-tip': '更多操作',
    'aria-label': '更多操作',
    html: icon('more-h', 18),
  });
  moreBtn.addEventListener('click', () => {
    ctx.overlay.menu({
      anchor: moreBtn,
      align: 'end',
      minWidth: 220,
      items: () => {
        const dark = ctx.store.get().ui.theme === 'dark';
        return [
          { label: '导出为 HTML', icon: 'download', onClick: () => cmd('app.export') },
          { label: '打印 / 另存为 PDF', icon: 'print', onClick: () => cmd('app.print') },
          { label: '重命名工程', icon: 'edit', onClick: () => cmd('file.rename') },
          { label: '复制工程', icon: 'copy', onClick: () => cmd('file.duplicate') },
          { sep: true },
          { label: '历史记录', icon: 'history', onClick: () => cmd('history.open') },
          { label: '重新加载画布', icon: 'refresh', onClick: () => cmd('app.reloadDeck') },
          {label:'WebDAV 云端备份',icon:'cloud',onClick:()=>cmd('backup.open')},
          { label: '应用设置', icon: 'settings', onClick: () => cmd('app.settings') },
          { sep: true },
          { label: dark ? '切换到浅色模式' : '切换到深色模式', icon: dark ? 'sun' : 'moon', onClick: () => cmd('app.toggleTheme') },
          { label: '快捷键与帮助', icon: 'help', onClick: () => cmd('help.shortcuts') },
          { sep: true },
          { label: '删除工程', icon: 'trash', danger: true, onClick: () => cmd('file.delete') },
        ];
      },
    });
  });
  els.moreBtn = moreBtn;

  const right = h(
    'div',
    { class: 'tb-right' },
    paletteBtn,
    saveChip,
    h('span', { class: 'tb-sep' }),
    els.undo,
    els.redo,
    h('span', { class: 'tb-sep' }),
    els.agentMain,
    presentWrap,
    moreBtn,
  );

  els.root.replaceChildren(
    h(
      'div',
      { class: 'tb-left' },
      brandMark({ full: false }),
      backBtn,
      h('span', { class: 'tb-sep' }),
      projectWrap,
    ),
    h('div', { class: 'tb-center tb-center--tabs' }, tabsSlot),
    right,
  );
}

/* ============================================================
   行内重命名
   ============================================================ */

function startRename() {
  if (renameState.input || !els.nameEl) return;
  const ctx = ctxRef;
  const nameEl = els.nameEl;
  const current = ctx.store.get().project?.name || nameEl.textContent || '';
  const input = h('input', {
    class: 'tb-rename-input',
    type: 'text',
    'aria-label': '工程名称',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  input.value = current;
  nameEl.classList.add('is-hidden');
  nameEl.after(input);
  renameState.input = input;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    nameEl.classList.remove('is-hidden');
    renameState.input = null;
    if (!commit || !value || value === current) return;
    if (!ctx.route.projectId) return;
    try {
      await ctx.api.patchProject(ctx.route.projectId, { name: value });
      ctx.store.update((s) => {
        if (s.project) s.project.name = value;
      });
      nameEl.textContent = value;
      document.title = `${value} · WebDeck Studio`;
      ctx.toast.ok(`工程已重命名为「${value}」`);
      ctx.bus.emit('project:renamed', { projectId: ctx.route.projectId, name: value });
    } catch (err) {
      ctx.toast.error('重命名失败：' + (err?.message || err));
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function cleanupRename() {
  const input = renameState.input;
  if (!input) return;
  renameState.input = null;
  input.remove();
  els.nameEl?.classList.remove('is-hidden');
}

/* ============================================================
   帮助弹窗
   ============================================================ */

const HELP_SECTIONS = [
  {
    title: '全局',
    rows: [
      ['命令面板', 'Ctrl K'],
      ['保存工程', 'Ctrl S'],
      ['撤销 / 重做', 'Ctrl Z / Ctrl Y'],
      ['显示 / 隐藏 Agent', 'Ctrl Shift E'],
      ['返回文件库', 'Esc 关闭浮层'],
    ],
  },
  {
    title: '编辑',
    rows: [
      ['复制 / 剪切 / 粘贴', 'Ctrl C / X / V'],
      ['复制元素', 'Ctrl D'],
      ['删除元素', 'Delete'],
      ['加粗 / 斜体 / 下划线', 'Ctrl B / I / U'],
      ['微调位置', '方向键'],
    ],
  },
  {
    title: '放映',
    rows: [
      ['从头开始', 'F5'],
      ['从当前页开始', 'Shift F5'],
      ['下一页 / 上一页', '→ / ←'],
      ['退出放映', 'Esc'],
    ],
  },
  {
    title: '画布',
    rows: [
      ['适应窗口', '适配画布按钮'],
      ['缩放', '状态栏 − / +'],
      ['网格 / 参考线', '视图标签'],
      ['双击文字', '就地编辑'],
    ],
  },
];

function openHelp() {
  const ctx = ctxRef;
  const grid = h('div', { class: 'help-grid' });
  for (const section of HELP_SECTIONS) {
    const box = h('div', { class: 'help-sec' }, h('div', { class: 'help-sec-title' }, section.title));
    for (const [label, kbd] of section.rows) {
      box.append(h('div', { class: 'help-row' }, h('span', { class: 'help-label' }, label), h('span', { class: 'kbd' }, kbd)));
    }
    grid.append(box);
  }
  const body = h(
    'div',
    { class: 'help' },
    h('p', { class: 'help-intro' }, 'WebDeck Studio 是网页演播工作台，画布固定 1920×1080。所有操作都可以在命令面板（Ctrl+K）中检索。'),
    grid,
  );
  ctx.dialog.open({
    title: '快捷键与帮助',
    sub: `WebDeck Studio v${ctx.version || '1.0.0'} · 网页演播工作台`,
    width: 'lg',
    body,
    actions: [
      {
        label: '打开命令面板',
        kind: 'ghost',
        onClick: () => {
          setTimeout(() => cmd('app.commandPalette'), 160);
        },
      },
      { label: '关闭', value: true, kind: 'primary' },
    ],
  });
}

/* ============================================================
   外壳命令注册（其它模块负责的命令不在这里注册）
   ============================================================ */

function toggleAgentFallback(ctx) {
  const open = !ctx.store.get().ui.agentOpen;
  ctx.store.update((s) => { s.ui.agentOpen = open; });
  const appEl = document.getElementById('app');
  if (appEl) appEl.dataset.agent = open ? 'open' : 'closed';
  ctx.bus.emit('agent:toggle', { open });
}

async function toggleFullscreen(ctx) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    ctx.toast.warn('当前环境不支持全屏');
  }
}

function registerShellCommands(ctx) {
  const bus = ctx.bus;
  const reg = (name, handler, meta) => {
    if (bus.hasCommand(name)) return;
    bus.registerCommand(name, handler, meta);
  };

  reg('app.back', () => {
    if (ctx.route.name !== 'editor') return { ok: true };
    ctx.navigate('#/');
    return { ok: true };
  }, { label: '返回文件库', group: '应用', icon: 'arrow-left', keywords: ['返回', '首页', '文件库'] });

  reg('app.toggleAgent', () => {
    toggleAgentFallback(ctx);
    return { ok: true };
  }, { label: '显示/隐藏 Agent 面板', group: '应用', icon: 'bot', shortcut: 'Ctrl+Shift+E', keywords: ['agent', '助手'] });

  reg('app.commandPalette', async () => {
    const mod = await import('./palette.js');
    return mod.openPalette(ctx);
  }, { label: '命令面板', group: '应用', icon: 'command', shortcut: 'Ctrl+K', keywords: ['命令', '搜索', 'palette'] });

  reg('app.settings', () => bus.runCommand('agent.openSettings'), {
    label: 'API 设置', group: '应用', icon: 'sparkles', keywords: ['模型', 'API', '密钥'],
  });

  reg('view.dark', () => bus.runCommand('app.toggleTheme'), {
    label: '深色模式', group: '视图', icon: 'moon', keywords: ['主题', '外观', '暗色'],
  });

  reg('view.fullscreen', () => toggleFullscreen(ctx), {
    label: '全屏', group: '视图', icon: 'fullscreen', keywords: ['全屏', '窗口'],
  });

  reg('help.shortcuts', openHelp, {
    label: '快捷键与帮助', group: '帮助', icon: 'help', keywords: ['快捷键', '帮助', '说明'],
  });
}

/* ============================================================
   状态同步
   ============================================================ */

function updateSaveChip(state) {
  const chip = els.saveChip;
  if (!chip) return;
  const saving = state.ui.saving || 'saved';
  const map = {
    saved: ['check-circle', '已保存', 'is-saved'],
    saving: ['loading', '保存中', 'is-saving'],
    dirty: ['dot', '未保存', 'is-dirty'],
    error: ['alert', '保存失败', 'is-error'],
  };
  const [ic, text, cls] = map[saving] || map.saved;
  chip.classList.remove('is-saved', 'is-saving', 'is-dirty', 'is-error');
  chip.classList.add(cls);
  if (els.saveIc) els.saveIc.innerHTML = icon(ic, 15);
  if (els.saveText) els.saveText.textContent = text;
  const last = state.ui.savedAt ? `上次保存 ${formatTime(state.ui.savedAt)}` : '保存到磁盘';
  chip.setAttribute('data-tip', `${last}|Ctrl S`);
}

function sync() {
  const ctx = ctxRef;
  if (!ctx || !els.root) return;
  const state = ctx.store.get();

  /* 主题按钮 */
  const dark = state.ui.theme === 'dark';
  for (const btn of els.themeBtns || []) {
    setIcon(btn, dark ? 'sun' : 'moon', 18);
    btn.setAttribute('data-tip', dark ? '切换到浅色模式' : '切换到深色模式');
  }

  /* 撤销/重做 */
  if (els.undo) els.undo.disabled = !(state.history.cursor > 0);
  if (els.redo) els.redo.disabled = !(state.history.cursor < state.history.ops.length);

  /* 保存状态 */
  updateSaveChip(state);

  /* 工程名 */
  if (els.nameEl && !renameState.input) {
    const name = state.project?.name;
    if (name && els.nameEl.textContent !== name) els.nameEl.textContent = name;
  }

  /* Agent 主按钮：打开状态高亮 */
  if (els.agentMain) {
    const appEl = document.getElementById('app');
    const open = !!(state.ui.agentOpen || appEl?.dataset.agent === 'open');
    els.agentMain.classList.toggle('is-open', open);
    els.agentMain.setAttribute('aria-pressed', open ? 'true' : 'false');
    els.agentMain.setAttribute('data-tip', `${open ? '关闭' : '打开'} Agent 助手|Ctrl Shift E`);
  }

  /* 文件库搜索框：外部重置时回填 */
  if (els.search && document.activeElement !== els.search) {
    const q = state.library?.query || '';
    if (els.search.value !== q) els.search.value = q;
  }
}

function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => {
    syncPending = false;
    sync();
  });
}

/* ============================================================
   挂载
   ============================================================ */

function build() {
  if (!els.root) return;
  const root = els.root;
  cleanupRename();
  els = { root };
  if (ctxRef.route?.name === 'editor') buildEditor();
  else buildLibrary();
  mountRibbonTabs();
  scheduleSync();
}

function onGlobalKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key !== '/' || ctxRef?.route?.name !== 'library') return;
  if (isTypingTarget(e.target)) return;
  if (!els.search) return;
  e.preventDefault();
  els.search.focus();
  els.search.select();
}

export async function init(ctx) {
  ctxRef = ctx;
  els.root = document.getElementById('titlebar');
  registerShellCommands(ctx);
  build();

  ctx.bus.on('route:change', () => build());
  ctx.bus.on('project:open', scheduleSync);
  ctx.bus.on('project:renamed', scheduleSync);
  ctx.bus.on('project:saved', scheduleSync);
  ctx.bus.on('project:dirty', scheduleSync);
  ctx.bus.on('editor:saving', scheduleSync);
  ctx.bus.on('history:change', scheduleSync);
  ctx.bus.on('agent:toggle', scheduleSync);
  ctx.bus.on('ui:theme', scheduleSync);
  ctx.bus.on('project:close', scheduleSync);
  ctx.store.subscribe(scheduleSync);
  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('resize', () => mountRibbonTabs());
  if (document.fonts?.ready) document.fonts.ready.then(scheduleSync).catch(() => {});
}
