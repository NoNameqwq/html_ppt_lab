/* ==========================================================================
   导入网页：上传 HTML / 浏览本机路径 / 内置示例
   - POST /api/projects/import → 得到 kind='imported' 的工程（原稿保存到 projects/<id>/original/）
   - 默认立即调用 file.convert 命令，转换为可编辑原生 deck（进度/报告由 convert.js 负责）
   ========================================================================== */

import { h, formatBytes, formatTime, readFileAsText } from '../core/dom.js';
import { icon } from '../ui/icons.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

let ctx = null;

export async function init(_ctx) {
  ctx = _ctx;
  ctx.bus.registerCommand('file.import', (payload) => {
    if (payload && payload.sampleId) return importSampleDirect(payload);
    return openImportDialog();
  }, {
    label: '导入网页',
    group: '文件',
    icon: 'import',
    shortcut: '',
  });
}

const ic = (name, size = 16) => h('span', { class: 'ic-slot', html: icon(name, size) });

/* ==========================================================================
   主弹窗
   ========================================================================== */

async function openImportDialog() {
  if (!ctx) return { ok: false, error: '模块未初始化' };
  const state = {
    tab: 'upload',
    file: null,          // {name, content, size}
    pathFile: null,      // {name, path, size}
    sample: null,        // {id, name, file, ...}
    mode: 'raw',         // 统一按网页工程导入（保留原动效与脚本）
    busy: false,
  };

  const panels = {};
  const tabButtons = {};

  /* ---------- 1. 上传 ---------- */
  const uploadPanel = buildUploadPanel(state, () => syncImportButton());

  /* ---------- 2. 本机路径 ---------- */
  const pathPanel = buildPathPanel(state, () => syncImportButton());

  /* ---------- 3. 示例 ---------- */
  const samplePanel = buildSamplePanel(state, () => syncImportButton());

  panels.upload = uploadPanel.el;
  panels.path = pathPanel.el;
  panels.samples = samplePanel.el;

  const tabBar = h('div', { class: 'imp-tabs', role: 'tablist', 'aria-label': '导入方式' });
  for (const [id, label, name] of [
    ['upload', '上传文件', 'upload'],
    ['path', '本机路径', 'folder'],
    ['samples', '内置示例', 'sparkles'],
  ]) {
    const btn = h('button', {
      class: 'imp-tab',
      type: 'button',
      role: 'tab',
      'aria-selected': 'false',
      dataset: { tab: id },
    }, ic(name, 15), h('span', null, label));
    btn.addEventListener('click', () => switchTab(id));
    tabButtons[id] = btn;
    tabBar.appendChild(btn);
  }

  const body = h('div', { class: 'imp-dialog' },
    tabBar,
    h('div', { class: 'imp-panels' },
      panels.upload,
      panels.path,
      panels.samples),
    h('div', { class: 'imp-divider' }),
    h('div', { class: 'imp-tip' }, ic('info', 14), h('span', null, '导入后直接编辑网页：原稿结构、脚本与动效全部保留，文字 / 样式 / 动效 / 时间线 / 交互都能改。')));

  let primaryBtn = null;
  function syncImportButton() {
    if (!primaryBtn) return;
    const ready = Boolean(
      (state.tab === 'upload' && state.file) ||
      (state.tab === 'path' && state.pathFile) ||
      (state.tab === 'samples' && state.sample),
    );
    primaryBtn.disabled = state.busy || !ready;
  }

  function switchTab(id) {
    state.tab = id;
    for (const [key, btn] of Object.entries(tabButtons)) {
      const on = key === id;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const [key, el] of Object.entries(panels)) el.hidden = key !== id;
    if (id === 'path') pathPanel.ensureLoaded();
    if (id === 'samples') samplePanel.ensureLoaded();
    syncImportButton();
  }

  switchTab('upload');

  const openPromise = ctx.dialog.open({
    title: '导入网页',
    sub: '上传 HTML、浏览本机路径或导入示例；默认保留原动效',
    width: 'lg',
    body,
    className: 'dialog--import',
    closeOnBackdrop: true,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      {
        label: '导入',
        kind: 'primary',
        onClick: async (modal) => {
          if (state.busy) return false;
          primaryBtn = modal.querySelector('.modal-foot .btn--primary');
          const payload = collectImportPayload(state);
          if (!payload) {
            if (state.tab === 'upload') ctx.toast.warn('请先选择一个 HTML 文件');
            else if (state.tab === 'path') ctx.toast.warn('请先选择一个 HTML 文件');
            else ctx.toast.warn('请先选择一个示例');
            return false;
          }
          state.busy = true;
          setBusy(modal, true, '导入中…');
          syncImportButton();
          try {
            const res = await ctx.api.importProject(payload);
            const project = res?.project;
            if (!project?.id) throw new Error('服务端未返回工程信息');
            ctx.toast.ok(`已导入「${project.name}」`);
            return { project, mode: state.mode };
          } catch (err) {
            console.error('[import] 导入失败', err);
            body.classList.add('is-error');
            showInlineError(body, err?.message || String(err));
            ctx.toast.error('导入失败：' + (err?.message || err));
            return false;
          } finally {
            state.busy = false;
            setBusy(modal, false);
            syncImportButton();
          }
        },
      },
    ],
  });
  // dialog.open 同步创建 DOM，这里直接拿到主按钮做禁用态控制
  primaryBtn = document.querySelector('.dialog--import .modal-foot .btn--primary');
  syncImportButton();

  const result = await openPromise;

  if (!result || !result.project) {
    pathPanel.dispose?.();
    return { ok: false, canceled: true };
  }
  pathPanel.dispose?.();
  ctx.bus.emit('library:refresh', { projectId: result.project.id });
  if (result.mode === 'convert') {
    const conv = await ctx.bus.runCommand('file.convert', { project: result.project });
    return { ok: true, project: result.project, mode: 'convert', converted: conv?.ok === true, convert: conv };
  }
  // 兼容模式：导入成功直接进入编辑器（编辑原稿 DOM，原动效不变）
  if (result.project.kind === 'raw') {
    ctx.toast.ok('已导入，原动效已保留，可直接编辑', { duration: 3200 });
    const hash = '#/p/' + encodeURIComponent(result.project.id);
    if (typeof ctx.navigate === 'function') ctx.navigate(hash);
    else location.hash = hash;
    return { ok: true, project: result.project, mode: 'raw' };
  }
  // 服务端尚未支持 raw：退回“导入工程”，仍可稍后转换
  ctx.toast.warn('服务端暂未启用兼容模式，已按导入工程处理');
  return { ok: true, project: result.project, mode: 'imported', converted: false };
}

/** 导入方式选择：默认「保留原动效（兼容编辑）」 */
function buildModeSelector(state) {
  const MODES = [
    {
      id: 'raw',
      icon: 'film',
      title: '保留原动效（兼容编辑）',
      tag: '推荐',
      desc: '原稿原样保留：脚本、动效、字体全部照常运行，直接编辑原 DOM。',
    },
    {
      id: 'convert',
      icon: 'wand',
      title: '转换为可编辑工程',
      tag: '',
      desc: '逐页捕获为原生 deck：元素级编辑 + 动画库，转换较慢但更可控。',
    },
  ];
  const el = h('div', { class: 'imp-modes', role: 'radiogroup', 'aria-label': '导入方式' });
  const buttons = {};
  function select(id) {
    state.mode = id;
    for (const [key, btn] of Object.entries(buttons)) {
      const on = key === id;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  for (const mode of MODES) {
    const btn = h('button', {
      class: 'imp-mode',
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      dataset: { mode: mode.id },
    },
    h('span', { class: 'imp-mode-head' },
      h('span', { class: 'imp-mode-icon', html: icon(mode.icon, 16) }),
      h('span', { class: 'imp-mode-title' }, mode.title),
      mode.tag ? h('span', { class: 'imp-mode-tag' }, mode.tag) : null,
      h('span', { class: 'imp-mode-check', html: icon('check', 12) })),
    h('span', { class: 'imp-mode-desc' }, mode.desc));
    btn.addEventListener('click', () => select(mode.id));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(mode.id);
      }
    });
    buttons[mode.id] = btn;
    el.appendChild(btn);
  }
  select(state.mode || 'raw');
  return { el, select };
}

function collectImportPayload(state) {
  if (state.tab === 'upload') {
    if (!state.file) return null;
    return { fileName: state.file.name, content: state.file.content, mode: state.mode };
  }
  if (state.tab === 'path') {
    if (!state.pathFile) return null;
    return { sourcePath: state.pathFile.path, fileName: state.pathFile.name, mode: state.mode };
  }
  if (state.tab === 'samples') {
    if (!state.sample) return null;
    return { sampleId: state.sample.id, mode: state.mode };
  }
  return null;
}

/** 内置示例一键导入（不经弹窗，默认兼容模式） */
async function importSampleDirect(payload) {
  const sample = { id: payload.sampleId, name: payload.sampleName || payload.sampleId, file: payload.file };
  const mode = payload.mode || (payload.autoConvert ? 'convert' : 'raw');
  const dismiss = ctx.toast(`正在导入示例「${sample.name}」…`, { type: 'info', duration: 60000 });
  let project = null;
  try {
    const res = await ctx.api.importProject({ sampleId: sample.id, mode });
    project = res?.project;
    if (!project?.id) throw new Error('服务端未返回工程信息');
  } catch (err) {
    dismiss();
    console.error('[import] 示例导入失败', err);
    ctx.toast.error('示例导入失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  }
  dismiss();
  ctx.toast.ok(`已导入「${project.name}」`);
  ctx.bus.emit('library:refresh', { projectId: project.id });
  if (mode === 'convert') {
    const conv = await ctx.bus.runCommand('file.convert', { project });
    return { ok: true, project, mode, converted: conv?.ok === true, convert: conv };
  }
  // 兼容模式：直接进入编辑器
  if (project.kind === 'raw') {
    const hash = '#/p/' + encodeURIComponent(project.id);
    if (typeof ctx.navigate === 'function') ctx.navigate(hash);
    else location.hash = hash;
    return { ok: true, project, mode: 'raw' };
  }
  return { ok: true, project, mode: 'imported', converted: false };
}

/* ==========================================================================
   面板 1：上传文件
   ========================================================================== */

function buildUploadPanel(state, onChange) {
  const input = h('input', {
    type: 'file',
    accept: '.html,.htm,text/html',
    class: 'imp-file-input',
    tabindex: '-1',
    'aria-hidden': 'true',
  });
  const chip = h('div', { class: 'imp-file-chip', hidden: true });
  const zone = h('div', {
    class: 'imp-drop',
    role: 'button',
    tabindex: '0',
    'aria-label': '选择或拖放 HTML 文件',
  },
  h('span', { class: 'imp-drop-icon', html: icon('upload', 26) }),
  h('div', { class: 'imp-drop-title' }, '把 HTML 文件拖到这里'),
  h('div', { class: 'imp-drop-sub' }, '或点击选择文件 · 支持 .html / .htm · 最大 20MB'));

  function renderChip() {
    chip.replaceChildren();
    if (!state.file) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    chip.append(
      h('span', { class: 'imp-chip-icon', html: icon('file-code', 16) }),
      h('span', { class: 'imp-chip-name ellipsis' }, state.file.name),
      h('span', { class: 'imp-chip-meta' }, formatBytes(state.file.size)),
      h('button', {
        class: 'icon-btn icon-btn--sm',
        type: 'button',
        title: '移除',
        onclick: (e) => {
          e.stopPropagation();
          state.file = null;
          input.value = '';
          renderChip();
          onChange();
        },
      }, ic('x', 14)));
  }

  async function acceptFile(file) {
    if (!file) return false;
    if (!/\.html?$/i.test(file.name) && file.type !== 'text/html') {
      ctx.toast.warn('只支持导入 HTML 文件（.html / .htm）');
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      ctx.toast.error('文件过大（' + formatBytes(file.size) + '），最大支持 20MB');
      return false;
    }
    zone.classList.add('is-reading');
    try {
      const content = await readFileAsText(file);
      if (!content || !/<[a-z!]/i.test(content)) {
        ctx.toast.error('这个文件看起来不是 HTML');
        return false;
      }
      state.file = { name: file.name, content, size: file.size };
      renderChip();
      onChange();
      return true;
    } catch (err) {
      ctx.toast.error('读取文件失败：' + (err?.message || err));
      return false;
    } finally {
      zone.classList.remove('is-reading');
    }
  }

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (file) acceptFile(file);
  });
  let dragDepth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth += 1;
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) zone.classList.remove('is-over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    zone.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });

  const el = h('div', { class: 'imp-panel', dataset: { panel: 'upload' } }, input, zone, chip);
  renderChip();
  return { el };
}

/* ==========================================================================
   面板 2：本机路径浏览
   ========================================================================== */

function buildPathPanel(state, onChange) {
  const fs = {
    inited: false,
    loading: false,
    error: null,
    path: '',
    parent: null,
    dirs: [],
    files: [],
    roots: [],
    selected: null,
  };
  let token = 0;

  const pathInput = h('input', { class: 'input', placeholder: '输入目录路径，例如 C:\\Users\\你\\Desktop' });
  const listEl = h('div', { class: 'imp-fs-list', role: 'listbox', 'aria-label': '目录内容' });
  const rootsEl = h('div', { class: 'imp-fs-roots' });
  const selectedEl = h('div', { class: 'imp-fs-selected' }, '未选择文件');
  const goBtn = h('button', { class: 'btn btn--sm', type: 'button' }, '跳转');
  const upBtn = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', title: '上一级' }, ic('arrow-up', 15));
  const refreshBtn = h('button', { class: 'icon-btn icon-btn--sm', type: 'button', title: '刷新' }, ic('refresh', 15));

  function setSelected(file) {
    fs.selected = file || null;
    state.pathFile = file ? { name: file.name, path: file.path, size: file.size } : null;
    selectedEl.textContent = file ? `已选择：${file.name} · ${formatBytes(file.size)}` : '未选择文件';
    selectedEl.classList.toggle('is-selected', Boolean(file));
    for (const row of listEl.querySelectorAll('.imp-fs-row')) {
      row.classList.toggle('is-selected', Boolean(file) && row.dataset.path === file.path);
    }
    onChange();
  }

  function renderRoots() {
    rootsEl.replaceChildren();
    if (!fs.roots.length) return;
    for (const root of fs.roots) {
      const btn = h('button', {
        class: 'imp-root-chip',
        type: 'button',
        title: root.path,
        onclick: () => load(root.path),
      }, ic(root.kind === 'drive' ? 'hard-drive' : root.kind === 'dir' ? 'folder' : 'folder', 13), h('span', null, root.name || root.path));
      if (root.path === fs.path) btn.classList.add('is-active');
      rootsEl.appendChild(btn);
    }
  }

  function renderSkeleton() {
    const box = h('div', { class: 'imp-fs-skeleton' });
    for (let i = 0; i < 5; i += 1) box.appendChild(h('div', { class: 'skeleton skeleton--row' }));
    return box;
  }

  function renderError(message) {
    listEl.replaceChildren(h('div', { class: 'imp-fs-state' },
      ic('alert', 18),
      h('div', { class: 'grow' }, h('div', { class: 'imp-fs-state-title' }, '无法打开目录'), h('div', { class: 'imp-fs-state-sub' }, message)),
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        onclick: () => load(fs.path || ''),
      }, '重试')));
  }

  function renderList() {
    if (fs.loading) {
      listEl.replaceChildren(renderSkeleton());
      return;
    }
    if (fs.error) {
      renderError(fs.error);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const dir of fs.dirs) {
      const row = h('div', {
        class: 'imp-fs-row imp-fs-row--dir',
        role: 'option',
        tabindex: '0',
        dataset: { path: dir.path },
        title: dir.path,
      },
      h('span', { class: 'imp-fs-icon', html: icon('folder', 16) }),
      h('span', { class: 'imp-fs-name ellipsis' }, dir.name),
      h('span', { class: 'imp-fs-enter', html: icon('chevron-right', 14) }));
      row.addEventListener('dblclick', () => load(dir.path));
      row.addEventListener('click', () => {
        // 选中文件夹会清空已选文件，避免视觉与状态不一致
        setSelected(null);
        for (const r of listEl.querySelectorAll('.imp-fs-row')) r.classList.remove('is-highlight');
        row.classList.add('is-highlight');
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') load(dir.path);
      });
      frag.appendChild(row);
    }
    for (const file of fs.files) {
      const row = h('div', {
        class: 'imp-fs-row imp-fs-row--file',
        role: 'option',
        tabindex: '0',
        dataset: { path: file.path },
        title: file.path,
      },
      h('span', { class: 'imp-fs-icon is-file', html: icon('file-code', 16) }),
      h('span', { class: 'imp-fs-name ellipsis' }, file.name),
      h('span', { class: 'imp-fs-meta' }, formatBytes(file.size)),
      h('span', { class: 'imp-fs-meta' }, formatTime(file.mtime)),
      h('span', { class: 'badge badge--muted' }, (file.ext || '.html').replace('.', '').toUpperCase()));
      row.addEventListener('click', () => setSelected(file));
      row.addEventListener('dblclick', () => setSelected(file));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setSelected(file);
        }
      });
      if (fs.selected && fs.selected.path === file.path) row.classList.add('is-selected');
      frag.appendChild(row);
    }
    if (!fs.dirs.length && !fs.files.length) {
      frag.appendChild(h('div', { class: 'imp-fs-state' },
        ic('folder-open', 18),
        h('div', { class: 'grow' }, h('div', { class: 'imp-fs-state-title' }, '这个目录里没有可导入的文件'),
          h('div', { class: 'imp-fs-state-sub' }, '试试进入子文件夹，或在下方直接输入路径跳转'))));
    }
    listEl.replaceChildren(frag);
  }

  async function load(target) {
    const my = ++token;
    fs.loading = true;
    fs.error = null;
    renderList();
    try {
      const data = await ctx.api.fsList(target || '');
      if (my !== token) return;
      fs.path = data.path || target || '';
      fs.parent = data.parent || null;
      fs.dirs = Array.isArray(data.dirs) ? data.dirs : [];
      fs.files = Array.isArray(data.files) ? data.files : [];
      if (Array.isArray(data.roots) && data.roots.length) fs.roots = data.roots;
      fs.loading = false;
      fs.selected = null;
      pathInput.value = fs.path;
      renderRoots();
      renderList();
      setSelected(null);
    } catch (err) {
      if (my !== token) return;
      fs.loading = false;
      fs.error = err?.message || String(err);
      renderList();
    }
  }

  async function ensureLoaded() {
    if (fs.inited) return;
    fs.inited = true;
    try {
      const data = await ctx.api.fsList('');
      if (Array.isArray(data.roots) && data.roots.length) fs.roots = data.roots;
    } catch {
      fs.roots = [
        { name: 'C: 盘', path: 'C:\\', kind: 'drive' },
        { name: 'D: 盘', path: 'D:\\', kind: 'drive' },
      ];
    }
    renderRoots();
    const first = fs.roots.find((r) => r.kind === 'drive') || fs.roots[0];
    if (first) await load(first.path);
    else renderList();
  }

  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      load(pathInput.value.trim());
    }
  });
  goBtn.addEventListener('click', () => load(pathInput.value.trim()));
  upBtn.addEventListener('click', () => {
    if (fs.parent) load(fs.parent);
    else ctx.toast('已经是最上层目录');
  });
  refreshBtn.addEventListener('click', () => load(fs.path));

  const el = h('div', { class: 'imp-panel imp-fs', dataset: { panel: 'path' }, hidden: true },
    h('div', { class: 'imp-fs-bar' },
      pathInput,
      goBtn,
      h('div', { class: 'imp-fs-actions' }, upBtn, refreshBtn)),
    rootsEl,
    listEl,
    h('div', { class: 'imp-fs-foot' }, ic('file-code', 14), selectedEl,
      h('span', { class: 'imp-fs-hint' }, '双击文件夹进入 · 点击 HTML 文件选中')));

  return {
    el,
    ensureLoaded,
    dispose() { token += 1; },
  };
}

/* ==========================================================================
   面板 3：内置示例
   ========================================================================== */

function buildSamplePanel(state, onChange) {
  let loaded = false;
  let loading = false;
  const grid = h('div', { class: 'imp-samples', role: 'listbox', 'aria-label': '内置示例' });

  function sampleCover(sample) {
    const cover = sample.cover && typeof sample.cover === 'object' ? sample.cover : {};
    const bg = cover.bg || '#0A0A0B';
    const fg = cover.fg || '#F2EAE0';
    const accent = cover.accent || '#E1402B';
    const el = h('div', { class: 'imp-sample-cover' },
      h('span', { class: 'imp-sample-kicker' }, 'WebDeck 示例'),
      h('b', { class: 'imp-sample-title' }, sample.name || sample.id),
      h('i', { class: 'imp-sample-rule' }),
      h('i', { class: 'imp-sample-dot' }));
    el.style.background = bg;
    el.style.color = fg;
    el.style.setProperty('--sample-accent', accent);
    return el;
  }

  function renderList(list) {
    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'imp-fs-state' },
        ic('sparkles', 18),
        h('div', { class: 'grow' },
          h('div', { class: 'imp-fs-state-title' }, '暂无内置示例'),
          h('div', { class: 'imp-fs-state-sub' }, 'samples/ 目录为空，可直接上传文件或浏览本机路径导入'))));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const sample of list) {
      const card = h('button', {
        class: 'imp-sample',
        type: 'button',
        role: 'option',
        'aria-selected': 'false',
        dataset: { sampleId: sample.id },
      },
      sampleCover(sample),
      h('div', { class: 'imp-sample-info' },
        h('div', { class: 'imp-sample-line' },
          h('span', { class: 'imp-sample-name' }, sample.name || sample.id),
          h('span', { class: 'badge' }, (sample.slides ? sample.slides + ' 页' : '示例'))),
        h('div', { class: 'imp-sample-desc' }, sample.desc || '内置示例原稿，可一键导入并转换')),
      h('div', { class: 'imp-sample-check', html: icon('check', 12) }));
      card.addEventListener('click', () => {
        state.sample = sample;
        for (const el of grid.querySelectorAll('.imp-sample')) {
          const on = el === card;
          el.classList.toggle('is-selected', on);
          el.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        onChange();
      });
      frag.appendChild(card);
    }
    grid.replaceChildren(frag);
  }

  function renderSkeleton() {
    const box = document.createDocumentFragment();
    for (let i = 0; i < 2; i += 1) {
      box.appendChild(h('div', { class: 'imp-sample imp-sample--skeleton' },
        h('div', { class: 'skeleton skeleton--cover' }),
        h('div', { class: 'skeleton skeleton--line' }),
        h('div', { class: 'skeleton skeleton--line skeleton--short' })));
    }
    return box;
  }

  async function loadSamples() {
    if (loading) return;
    loading = true;
    grid.replaceChildren(renderSkeleton());
    try {
      const res = await ctx.api.samples();
      const list = Array.isArray(res?.samples) ? res.samples : [];
      loaded = true;
      renderList(list);
    } catch (err) {
      renderList([]);
      grid.replaceChildren(h('div', { class: 'imp-fs-state' },
        ic('alert', 18),
        h('div', { class: 'grow' },
          h('div', { class: 'imp-fs-state-title' }, '示例列表加载失败'),
          h('div', { class: 'imp-fs-state-sub' }, err?.message || String(err))),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onclick: () => {
            loading = false;
            loaded = false;
            loadSamples();
          },
        }, '重试')));
    } finally {
      loading = false;
    }
  }

  async function ensureLoaded() {
    if (loaded || loading) return;
    await loadSamples();
  }

  const el = h('div', { class: 'imp-panel', dataset: { panel: 'samples' }, hidden: true }, grid);
  return { el, ensureLoaded };
}

/* ==========================================================================
   小工具
   ========================================================================== */

function showInlineError(container, message) {
  let box = container.querySelector('.imp-inline-error');
  if (!box) {
    box = h('div', { class: 'imp-inline-error' }, ic('alert', 14), h('span', { class: 'grow' }, message));
    container.appendChild(box);
  } else {
    const span = box.querySelector('span.grow');
    if (span) span.textContent = message;
  }
  box.classList.remove('is-out');
}

function setBusy(modal, busy, label) {
  if (!modal) return;
  for (const btn of modal.querySelectorAll('.modal-foot .btn')) {
    btn.disabled = busy;
    if (btn.classList.contains('btn--primary')) {
      if (busy) {
        if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent || '';
        btn.textContent = label || '处理中…';
      } else if (btn.dataset.idleLabel) {
        btn.textContent = btn.dataset.idleLabel;
      }
    }
  }
}
