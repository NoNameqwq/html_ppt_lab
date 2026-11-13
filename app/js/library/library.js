/* ==========================================================================
   文件库：工程卡片网格 / 搜索 / 排序 / 卡片操作 / 示例区
   路由 #/ 时由 main.js 通过 bus 'library:open' 触发渲染。
   新建 / 导入 / 转换分别由 create.js、import.js、convert.js 实现（这里统一 init）。
   ========================================================================== */

import { h, formatTime } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import * as brief from './brief.js';
import { init as initCreate } from './create.js';
import { init as initImport } from './import.js';
import { init as initConvert } from './convert.js';

const SORT_LABELS = {
  updated: '最近更新',
  created: '创建时间',
  name: '名称',
  slides: '页数',
};

let ctx = null;
let mounted = false;
let viewEl = null;
let gridEl = null;
let gridWrapEl = null;
let samplesEl = null;
let subtitleEl = null;
let countEl = null;
let searchInput = null;
let clearBtn = null;
let sortSelect = null;
let loadToken = 0;
let samplesToken = 0;
let thumbObserver = null;
let openMenu = null;
let menuCleanup = null;

const projects = [];
const samples = [];

const state = {
  loading: false,
  error: null,
  query: '',
  sort: 'updated',
  samplesLoading: false,
  samplesError: null,
  samplesLoaded: false,
  importingSample: '',
};

export async function init(_ctx) {
  ctx = _ctx;
  await brief.init(_ctx);
  // 先注册事件（即使某个子模块 init 失败，文件库也不会整页空白）
  ctx.bus.on('library:open', () => mount());
  ctx.bus.on('library:search', (payload) => applyQuery(payload && payload.query != null ? payload.query : ''));
  ctx.bus.on('library:refresh', () => { if (mounted) refreshProjects({ soft: true }); });
  ctx.bus.on('route:change', () => closeCardMenu());

  ctx.bus.registerCommand('file.rename', (payload) => commandTarget('rename', payload), { label: '重命名工程', group: '文件', icon: 'edit' });
  ctx.bus.registerCommand('file.delete', (payload) => commandTarget('delete', payload), { label: '删除工程', group: '文件', icon: 'trash' });
  ctx.bus.registerCommand('file.duplicate', (payload) => commandTarget('duplicate', payload), { label: '复制工程', group: '文件', icon: 'copy' });

  // 子模块各自注册 file.new / file.import / file.convert 命令（单个失败不影响其它）
  for (const [name, fn] of [['create', initCreate], ['import', initImport], ['convert', initConvert]]) {
    try {
      await fn(ctx);
    } catch (err) {
      console.error(`[library] 子模块 ${name} 初始化失败`, err);
      ctx.toast.error(`文件库子模块 ${name} 初始化失败：${err?.message || err}`);
    }
  }
}

const ic = (name, size = 16) => h('span', { class: 'ic-slot', html: icon(name, size) });

/* ==========================================================================
   挂载 / 页面骨架
   ========================================================================== */

function mount() {
  if (mounted) {
    refreshProjects();
    return;
  }
  viewEl = document.getElementById('library-view');
  if (!viewEl) return;
  state.query = ctx.store.get().library?.query || '';
  viewEl.replaceChildren(buildShell());
  mounted = true;
  bindShellEvents();
  if (searchInput) searchInput.value = state.query;
  if (clearBtn) clearBtn.hidden = !state.query;
  refreshProjects();
  loadSamples();
}

function buildShell() {
  searchInput = h('input', {
    class: 'lib-search-input',
    type: 'search',
    placeholder: '搜索工程名称、来源…',
    'aria-label': '搜索工程',
    spellcheck: 'false',
  });
  clearBtn = h('button', {
    class: 'lib-search-clear',
    type: 'button',
    title: '清除搜索',
    'aria-label': '清除搜索',
    hidden: true,
  }, ic('x', 13));
  const search = h('div', { class: 'lib-search' },
    h('span', { class: 'lib-search-icon', html: icon('search', 15) }),
    searchInput,
    clearBtn,
    h('kbd', { class: 'lib-search-kbd' }, 'Esc'));

  sortSelect = h('select', { class: 'input lib-sort-select', 'aria-label': '排序方式' },
    ...Object.entries(SORT_LABELS).map(([value, label]) => h('option', { value }, label)));
  sortSelect.value = state.sort;

  const hero = h('header', { class: 'lib-hero' },
    h('div', { class: 'lib-hero-main' },
      h('div', { class: 'lib-eyebrow' }, h('i', { class: 'lib-eyebrow-dot' }), 'WEB_DECK · 文件库'),
      h('h1', { class: 'lib-title' }, '文件库'),
      h('p', { class: 'lib-sub', ref: (el) => { subtitleEl = el; } }, '正在读取工程…')),
    h('div', { class: 'lib-hero-actions' },
      search,
      h('button', {
        class: 'btn btn--lg lib-btn',
        type: 'button',
        'data-tip': '导入网页',
        onclick: () => ctx.bus.runCommand('file.import'),
      }, ic('import', 16), h('span', null, '导入')),
      h('button', {
        class: 'btn btn--lg btn--primary lib-btn lib-btn--brief',
        type: 'button',
        'data-tip': '只说主题，自动生成整套演示',
        onclick: () => ctx.bus.runCommand('file.brief'),
      }, ic('sparkles', 16), h('span', null, '一句话开演')),
      h('button', {
        class: 'btn btn--lg lib-btn',
        type: 'button',
        'data-tip': '新建演示',
        onclick: () => ctx.bus.runCommand('file.new'),
      }, ic('plus', 16), h('span', null, '新建'))),
  );

  const toolbar = h('div', { class: 'lib-toolbar' },
    h('div', { class: 'lib-toolbar-left' },
      h('span', { class: 'lib-section-title' }, '全部工程'),
      h('span', { class: 'lib-count', ref: (el) => { countEl = el; } }, '')),
    h('div', { class: 'lib-toolbar-right' },
      h('label', { class: 'lib-sort' },
        h('span', { class: 'lib-sort-label' }, '排序'),
        sortSelect,
        h('span', { class: 'lib-sort-caret', html: icon('chevron-down', 14) })),
      h('button', {
        class: 'icon-btn lib-refresh',
        type: 'button',
        title: '刷新列表',
        'aria-label': '刷新列表',
        onclick: () => { refreshProjects(); loadSamples(); },
      }, ic('refresh', 16))),
  );

  gridWrapEl = h('div', { class: 'lib-grid-wrap' });
  gridEl = h('div', { class: 'lib-grid', role: 'list', 'aria-label': '工程列表' });
  gridWrapEl.appendChild(gridEl);

  samplesEl = h('div', { class: 'lib-samples' });
  const samplesSection = h('section', { class: 'lib-samples-section', 'aria-label': '内置示例' },
    h('div', { class: 'lib-samples-head' },
      h('div', { class: 'lib-samples-head-main' },
        h('span', { class: 'lib-section-title' }, '内置示例'),
        h('p', { class: 'lib-samples-sub' }, '内置原稿，一键导入（默认保留原动效）')),
      h('div', { class: 'lib-samples-line' })),
    samplesEl);

  return h('div', { class: 'lib-page' },
    hero,
    toolbar,
    gridWrapEl,
    samplesSection);
}

function bindShellEvents() {
  // 搜索（本地过滤，防抖 160ms）
  let timer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => setQuery(searchInput.value), 160);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      clearTimeout(timer);
      setQuery('');
      searchInput.blur();
    }
  });
  clearBtn.addEventListener('click', () => {
    setQuery('');
    searchInput.focus();
  });
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value || 'updated';
    renderProjects();
  });
  viewEl.addEventListener('scroll', () => closeCardMenu(), { passive: true });
  // Esc 关闭卡片菜单（弹窗有自己的 Esc 处理，这里只在菜单打开时生效）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) closeCardMenu();
  });
}

/* ==========================================================================
   查询 / 排序
   ========================================================================== */

function setQuery(next) {
  applyQuery(next);
}

/** 对外/事件入口：同步本地 + store（titlebar 输入框监听 store 回填） */
function applyQuery(raw) {
  const query = String(raw || '');
  state.query = query;
  if (searchInput && searchInput.value !== query) searchInput.value = query;
  if (clearBtn) clearBtn.hidden = !query;
  ctx.store.update((s) => { s.library.query = query; });
  renderProjects();
}

function filteredProjects() {
  const q = state.query.trim().toLowerCase();
  let list = projects.slice();
  if (q) {
    list = list.filter((p) => {
      const kindText = p.kind === 'raw' ? '网页' : '网页';
      return (
        String(p.name || '').toLowerCase().includes(q) ||
        String(p.origin?.file || '').toLowerCase().includes(q) ||
        kindText.includes(q) ||
        String(p.theme || '').toLowerCase().includes(q)
      );
    });
  }
  const sortBy = state.sort;
  list.sort((a, b) => {
    if (sortBy === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
    if (sortBy === 'slides') return (b.slideCount || 0) - (a.slideCount || 0);
    if (sortBy === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return list;
}

/* ==========================================================================
   数据刷新
   ========================================================================== */

async function refreshProjects({ soft = false } = {}) {
  if (!mounted) return;
  const token = ++loadToken;
  if (!soft) {
    state.loading = projects.length === 0;
    state.error = null;
    renderProjects();
  }
  writeStore();
  try {
    const res = await ctx.api.listProjects();
    if (token !== loadToken) return;
    const list = Array.isArray(res?.projects) ? res.projects : [];
    projects.splice(0, projects.length, ...list);
    state.loading = false;
    state.error = null;
  } catch (err) {
    if (token !== loadToken) return;
    console.error('[library] 读取工程列表失败', err);
    state.loading = false;
    state.error = err?.message || String(err);
  }
  writeStore();
  renderProjects();
}

async function loadSamples() {
  if (!mounted) return;
  const token = ++samplesToken;
  state.samplesLoading = !state.samplesLoaded;
  state.samplesError = null;
  renderSamples();
  try {
    const res = await ctx.api.samples();
    if (token !== samplesToken) return;
    const list = Array.isArray(res?.samples) ? res.samples : [];
    samples.splice(0, samples.length, ...list);
    state.samplesLoaded = true;
    state.samplesError = null;
  } catch (err) {
    if (token !== samplesToken) return;
    console.warn('[library] 读取示例失败', err);
    state.samplesLoaded = true;
    state.samplesError = err?.message || String(err);
  } finally {
    if (token === samplesToken) {
      state.samplesLoading = false;
      renderSamples();
    }
  }
}

function writeStore() {
  ctx.store.update((s) => {
    s.library = { projects: projects.slice(), loading: state.loading, query: state.query, error: state.error };
  });
}

/* ==========================================================================
   工程网格渲染
   ========================================================================== */

function renderProjects() {
  if (!mounted || !gridEl) return;
  const list = filteredProjects();
  updateHeader(list);
  if (state.loading && !projects.length) {
    gridEl.replaceChildren(renderSkeleton());
    return;
  }
  if (state.error && !projects.length) {
    gridEl.replaceChildren(renderErrorState());
    return;
  }
  if (!projects.length) {
    gridEl.replaceChildren(renderEmptyState());
    return;
  }
  if (!list.length) {
    gridEl.replaceChildren(renderNoResultState());
    return;
  }
  const frag = document.createDocumentFragment();
  list.forEach((project, index) => frag.appendChild(buildCard(project, index)));
  if (!state.query.trim()) frag.appendChild(buildAddCard());
  gridEl.replaceChildren(frag);
  setupThumbObserver();
}

/** 网格末尾的「新建演示」占位卡：让卡片区更充实，也给一个显式入口 */
function buildAddCard() {
  return h('button', {
    class: 'lib-add-card',
    type: 'button',
    'aria-label': '新建演示',
    onclick: () => ctx.bus.runCommand('file.new'),
  },
  h('span', { class: 'lib-add-card-icon', html: icon('plus', 20) }),
  h('span', { class: 'lib-add-card-label' }, '新建演示'),
  h('span', { class: 'lib-add-card-sub' }, '从模板开始'));
}

function updateHeader(list) {
  if (subtitleEl) {
    if (state.loading && !projects.length) subtitleEl.textContent = '正在读取工程…';
    else if (state.error && !projects.length) subtitleEl.textContent = '读取失败，' + state.error;
    else if (!projects.length) subtitleEl.textContent = '从模板新建，或导入现成的网页';
    else {
      const latest = projects.reduce((max, p) => Math.max(max, p.updatedAt || 0), 0);
      const q = state.query.trim();
      subtitleEl.textContent = q
        ? `${list.length} / ${projects.length} 个工程匹配「${q}」 · 最近更新 ${formatTime(latest)}`
        : `${projects.length} 个工程 · 最近更新 ${formatTime(latest)}`;
    }
  }
  if (countEl) {
    const searching = Boolean(state.query.trim());
    // 始终取本次渲染后的数组长度，避免 store 缓存与渲染不同步
    countEl.textContent = searching ? `${list.length} / ${projects.length}` : String(list.length);
    countEl.classList.toggle('is-filtered', searching);
  }
}

function buildCard(project, index) {
  const cover = project.cover || '#1B1A17';
  const coverFg = project.coverFg || '#F2EAE0';
  const accent = project.coverAccent || '#E1402B';
  const isRaw = project.kind === 'raw';
  // 兼容模式（raw）：不请求 /thumb（原稿没有 wpx-slide，缩略图不可用），用纯色封面 + 标签
  const hover = isRaw
    ? h('div', { class: 'lib-card-hover lib-card-hover--raw' },
      h('span', { class: 'lib-card-open lib-card-open--raw' }, ic('edit', 16), h('span', null, '打开编辑')))
    : h('div', { class: 'lib-card-hover' },
      h('span', { class: 'lib-card-open', html: icon('present', 20) }),
      h('span', { class: 'lib-card-open-text' }, '打开'));
  const thumb = h('div', { class: 'lib-card-thumb' },
    buildThumbCover(project, cover, coverFg, accent),
    hover,
  );
  if (!isRaw) {
    const frame = h('iframe', {
      class: 'lib-card-frame',
      title: (project.name || project.id) + ' 缩略图',
      tabindex: '-1',
      scrolling: 'no',
      'aria-hidden': 'true',
      dataset: { src: `/api/projects/${encodeURIComponent(project.id)}/thumb?slide=0` },
    });
    thumb.appendChild(frame);
    attachThumbLoad(frame, thumb);
  }

  const badge = project.kind === 'raw'
    ? h('span', { class: 'badge lib-badge lib-badge--raw', title: '网页工程：直接编辑网页，原动效保留' }, '网页')
    : project.kind === 'imported'
      ? h('span', { class: 'badge badge--accent lib-badge' }, '导入')
      : h('span', { class: 'badge badge--ok lib-badge' }, '网页');

  const slidesLabel = isRaw && !project.slideCount ? '原动效' : `${project.slideCount || 0} 页`;

  const card = h('article', {
    class: 'lib-card' + (isRaw ? ' lib-card--raw' : ''),
    role: 'listitem',
    tabindex: '0',
    dataset: { id: project.id },
    'aria-label': project.name || project.id,
  },
  thumb,
  h('div', { class: 'lib-card-body' },
    h('div', { class: 'lib-card-head' },
      h('div', { class: 'lib-card-title', title: project.name || project.id }, project.name || '未命名演示'),
      h('button', {
        class: 'lib-card-more',
        type: 'button',
        title: '更多操作',
        'aria-label': '更多操作',
        'aria-haspopup': 'menu',
      }, ic('more-h', 17))),
    h('div', { class: 'lib-card-meta' },
      h('span', { class: 'lib-meta-item' }, ic(isRaw ? 'film' : 'film', 13), h('span', null, slidesLabel)),
      h('span', { class: 'lib-meta-dot' }),
      h('span', { class: 'lib-meta-item' }, ic('clock', 13), h('span', null, formatTime(project.updatedAt)))),
    h('div', { class: 'lib-card-foot' },
      badge,
      project.hasOriginal
        ? h('span', { class: 'lib-origin-badge', title: '原稿保留：网页 HTML / 脚本 / 动效完整保留' }, ic('file-code', 12), h('span', null, '原稿保留'))
        : null),
  ),
  );
  card.style.setProperty('--card-accent', accent);
  card.style.setProperty('--card-cover', cover);
  card.dataset.index = String(index);
  card.addEventListener('click', (e) => {
    if (e.target.closest('.lib-card-more')) return;
    openProject(project);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProject(project);
    }
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCardMenu(card.querySelector('.lib-card-more'), project);
  });
  card.querySelector('.lib-card-more').addEventListener('click', (e) => {
    e.stopPropagation();
    openCardMenu(e.currentTarget, project);
  });
  return card;
}

function buildThumbCover(project, cover, coverFg, accent) {
  if (project.kind === 'raw') {
    // 兼容模式封面：纯色、无渐变、锐角标签，直接表明“原动效可编辑”
    const raw = h('div', { class: 'lib-card-cover lib-card-cover--raw' },
      h('div', { class: 'lib-card-cover-title' }, project.name || '未命名演示'),
      h('div', { class: 'lib-raw-tag' },
        h('span', { class: 'lib-raw-tag-dot' }),
        h('span', null, '网页 · 原动效')));
    raw.style.background = cover;
    raw.style.color = coverFg;
    raw.appendChild(h('div', { class: 'lib-raw-mark' }, 'WEB'));
    raw.style.setProperty('--card-accent', accent);
    return raw;
  }
  const el = h('div', { class: 'lib-card-cover' },
    h('div', { class: 'lib-card-cover-rule' }),
    h('div', { class: 'lib-card-cover-title' }, String(project.name || '未命名').slice(0, 6)),
    h('div', { class: 'lib-card-cover-lines' }, h('i'), h('i'), h('i')));
  el.style.background = cover;
  el.style.color = coverFg;
  el.style.setProperty('--card-accent', accent);
  return el;
}

/** 缩略图加载：懒加载交给 IntersectionObserver；load 失败保留 cover 兜底 */
function attachThumbLoad(frame, thumb) {
  frame.addEventListener('load', () => {
    let failed = false;
    try {
      const doc = frame.contentDocument;
      const body = doc && doc.body;
      const text = body ? (body.textContent || '').trim() : '';
      if (!body) failed = true;
      else if (/^\{\s*"error"/.test(text)) failed = true;
      else if (!body.children.length && !text && !(body.innerHTML || '').trim()) failed = true;
    } catch {
      failed = true;
    }
    frame.classList.toggle('is-failed', failed);
    frame.classList.toggle('is-loaded', !failed);
    thumb.classList.toggle('has-thumb', !failed);
  });
  frame.addEventListener('error', () => {
    frame.classList.add('is-failed');
  });
}

function setupThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  const frames = gridEl.querySelectorAll('.lib-card-frame[data-src]');
  if (!('IntersectionObserver' in window)) {
    for (const frame of frames) loadFrameSrc(frame);
    return;
  }
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const frame = entry.target.querySelector('.lib-card-frame[data-src]') || entry.target;
      loadFrameSrc(frame);
      thumbObserver.unobserve(entry.target);
    }
  }, { root: viewEl, rootMargin: '360px 0px' });
  for (const frame of frames) thumbObserver.observe(frame.closest('.lib-card-thumb'));
}

function loadFrameSrc(frame) {
  if (!frame || !frame.dataset || !frame.dataset.src) return;
  const src = frame.dataset.src;
  delete frame.dataset.src;
  frame.src = src;
}

/* ---------- 骨架 / 空态 / 错误态 ---------- */

function renderSkeleton() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 6; i += 1) {
    frag.appendChild(h('div', { class: 'lib-card lib-card--skeleton' },
      h('div', { class: 'skeleton skeleton--thumb' }),
      h('div', { class: 'lib-card-body' },
        h('div', { class: 'skeleton skeleton--title' }),
        h('div', { class: 'skeleton skeleton--meta' }))));
  }
  return frag;
}

function renderEmptyState() {
  return h('div', { class: 'lib-empty' },
    h('div', { class: 'lib-empty-art', 'aria-hidden': 'true' },
      h('div', { class: 'lib-empty-sheet is-1' }),
      h('div', { class: 'lib-empty-sheet is-2' }),
      h('div', { class: 'lib-empty-sheet is-3' },
        h('i', { class: 'lib-empty-line' }),
        h('i', { class: 'lib-empty-line is-short' }),
        h('i', { class: 'lib-empty-dot' })),
      h('i', { class: 'lib-empty-spark is-a' }),
      h('i', { class: 'lib-empty-spark is-b' })),
    h('h2', { class: 'lib-state-title' }, '还没有工程'),
    h('p', { class: 'lib-state-sub' }, '从模板新建，或导入现成的网页幻灯片 —— 一律保留原动效与脚本，导入即可编辑。'),
    h('div', { class: 'lib-empty-actions' },
      h('button', { class: 'btn btn--primary btn--lg', type: 'button', onclick: () => ctx.bus.runCommand('file.new') }, ic('plus', 16), h('span', null, '从模板新建')),
      h('button', { class: 'btn btn--lg', type: 'button', onclick: () => ctx.bus.runCommand('file.import') }, ic('import', 16), h('span', null, '导入网页'))));
}

function renderNoResultState() {
  return h('div', { class: 'lib-empty lib-empty--inline' },
    h('div', { class: 'lib-state-icon', html: icon('search', 22) }),
    h('h2', { class: 'lib-state-title' }, `没有匹配「${state.query.trim()}」的工程`),
    h('p', { class: 'lib-state-sub' }, '换个关键词试试，或清空搜索查看全部工程。'),
    h('div', { class: 'lib-empty-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => setQuery('') }, '清空搜索')));
}

function renderErrorState() {
  return h('div', { class: 'lib-empty lib-empty--error' },
    h('div', { class: 'lib-state-icon', html: icon('alert', 22) }),
    h('h2', { class: 'lib-state-title' }, '工程列表读取失败'),
    h('p', { class: 'lib-state-sub' }, state.error || '服务端暂时不可用，请稍后重试。'),
    h('div', { class: 'lib-empty-actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onclick: () => refreshProjects() }, '重试')));
}

/* ==========================================================================
   卡片操作
   ========================================================================== */

function findProject(id) {
  return projects.find((p) => p.id === id) || null;
}

function resolveTarget(payload) {
  if (payload && payload.project) return payload.project;
  if (payload && payload.projectId) return findProject(payload.projectId) || { id: payload.projectId, name: payload.projectId };
  const route = ctx.route || {};
  if (route.name === 'editor') {
    const proj = ctx.store.get().project;
    if (proj) return proj;
  }
  return null;
}

async function commandTarget(action, payload) {
  const project = resolveTarget(payload);
  if (!project) {
    ctx.toast.warn('请先打开或选择一个工程');
    return { ok: false, error: '没有目标工程' };
  }
  if (action === 'rename') return renameProject(project);
  if (action === 'delete') return removeProject(project);
  if (action === 'duplicate') return duplicateProject(project);
  return { ok: false, error: '未知操作' };
}

function openProject(project) {
  closeCardMenu();
  location.hash = '#/p/' + encodeURIComponent(project.id);
}

async function renameProject(project) {
  closeCardMenu();
  const next = await ctx.dialog.prompt('重命名工程', {
    value: project.name || '',
    placeholder: '工程名称',
    sub: '只影响显示名称，不改动 deck 内容。',
    okLabel: '保存',
  });
  if (next == null) return { ok: false, canceled: true };
  const name = String(next).trim();
  if (!name) {
    ctx.toast.warn('名称不能为空');
    return { ok: false };
  }
  if (name === project.name) return { ok: true };
  try {
    await ctx.api.patchProject(project.id, { name });
    // 同步当前编辑器里的工程名（如果正开着这个工程）
    const store = ctx.store.get();
    if (store.project && store.project.id === project.id) {
      ctx.store.update((s) => { if (s.project) s.project.name = name; });
    }
    ctx.toast.ok('已重命名为「' + name + '」');
    await refreshProjects({ soft: true });
    return { ok: true };
  } catch (err) {
    ctx.toast.error('重命名失败：' + (err?.message || err));
    return { ok: false, error: err?.message };
  }
}

async function duplicateProject(project) {
  closeCardMenu();
  try {
    const res = await ctx.api.duplicateProject(project.id);
    ctx.toast.ok(`已复制为「${res?.project?.name || project.name + ' 副本'}」`);
    await refreshProjects({ soft: true });
    return { ok: true, project: res?.project };
  } catch (err) {
    ctx.toast.error('复制失败：' + (err?.message || err));
    return { ok: false, error: err?.message };
  }
}

async function removeProject(project) {
  closeCardMenu();
  const ok = await ctx.dialog.confirm(
    `确定删除「${project.name || project.id}」？工程文件、原稿与历史记录都会被删除，且无法恢复。`,
    { title: '删除工程', okLabel: '删除', danger: true, cancelLabel: '取消' },
  );
  if (!ok) return { ok: false, canceled: true };
  try {
    await ctx.api.deleteProject(project.id);
    ctx.toast.ok('已删除工程');
    // 如果正在编辑被删除的工程，退回文件库
    if ((ctx.route || {}).name === 'editor' && (ctx.route || {}).projectId === project.id) {
      location.hash = '#/';
    }
    await refreshProjects({ soft: true });
    return { ok: true };
  } catch (err) {
    ctx.toast.error('删除失败：' + (err?.message || err));
    return { ok: false, error: err?.message };
  }
}

function exportProject(project) {
  closeCardMenu();
  try {
    const a = document.createElement('a');
    a.href = ctx.api.exportUrl(project.id);
    a.download = (project.name || project.id) + '.html';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    ctx.toast.ok('正在导出 HTML…');
  } catch (err) {
    ctx.toast.error('导出失败：' + (err?.message || err));
  }
}

function previewOriginal(project) {
  closeCardMenu();
  try {
    window.open(`/p/${encodeURIComponent(project.id)}/original/index.html`, '_blank', 'noopener');
  } catch (err) {
    ctx.toast.error('无法打开原稿：' + (err?.message || err));
  }
}

function convertProject(project) {
  closeCardMenu();
  ctx.bus.runCommand('file.convert', { project });
}

/* ---------- 卡片「更多」菜单 ---------- */

function menuItem({ label, iconName, onClick, kbd = '', danger = false, disabled = false }) {
  const btn = h('button', {
    class: 'menu-item' + (danger ? ' is-danger' : ''),
    type: 'button',
    role: 'menuitem',
    disabled,
  },
  h('span', { class: 'mi-icon', html: icon(iconName, 15) }),
  h('span', { class: 'grow' }, label),
  kbd ? h('span', { class: 'mi-kbd' }, kbd) : null);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (disabled) return;
    closeCardMenu();
    onClick?.();
  });
  return btn;
}

function openCardMenu(anchor, project) {
  if (!anchor) return;
  closeCardMenu();
  const menu = h('div', { class: 'menu lib-card-menu', role: 'menu', 'aria-label': '工程操作' });
  const isImported = project.kind === 'imported';
  const isRaw = project.kind === 'raw';
  menu.append(
    menuItem({ label: isRaw ? '打开编辑' : '打开', iconName: isRaw ? 'edit' : 'present', kbd: 'Enter', onClick: () => openProject(project) }),
    menuItem({ label: '重命名', iconName: 'edit', onClick: () => renameProject(project) }),
    menuItem({ label: '复制', iconName: 'copy', onClick: () => duplicateProject(project) }),
    menuItem({ label: '导出 HTML', iconName: 'download', onClick: () => exportProject(project) }),
    h('div', { class: 'menu-sep' }),
  );
  menu.append(
    h('div', { class: 'menu-sep' }),
    menuItem({ label: '删除', iconName: 'trash', danger: true, onClick: () => removeProject(project) }),
  );

  document.body.appendChild(menu);
  positionMenu(menu, anchor);
  openMenu = menu;
  // 键盘
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    const index = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const nextIndex = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCardMenu();
      anchor.focus();
    } else if (e.key === 'Tab') {
      closeCardMenu();
    }
  });
  const onPointerDown = (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeCardMenu();
  };
  const onResize = () => closeCardMenu();
  menuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('blur', onResize);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onResize);
    menu.querySelector('.menu-item:not([disabled])')?.focus({ preventScroll: true });
  }, 0);
}

function positionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 220;
  const gap = 6;
  let left = rect.right - width;
  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - gap);
  left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

function closeCardMenu() {
  if (!openMenu) return;
  menuCleanup?.();
  menuCleanup = null;
  openMenu.remove();
  openMenu = null;
}

/* ==========================================================================
   示例区
   ========================================================================== */

function renderSamples() {
  if (!mounted || !samplesEl) return;
  if (state.samplesLoading) {
    samplesEl.replaceChildren(h('div', { class: 'lib-samples-loading' },
      h('div', { class: 'skeleton skeleton--sample' }),
      h('div', { class: 'skeleton skeleton--sample' })));
    return;
  }
  if (state.samplesError) {
    samplesEl.replaceChildren(h('div', { class: 'lib-samples-note' },
      h('span', { class: 'lib-samples-note-icon', html: icon('alert', 16) }),
      h('span', null, '示例列表读取失败：' + state.samplesError),
      h('button', { class: 'btn btn--sm', type: 'button', onclick: () => loadSamples() }, '重试')));
    return;
  }
  if (!samples.length) {
    samplesEl.replaceChildren(h('div', { class: 'lib-samples-note' },
      h('span', { class: 'lib-samples-note-icon', html: icon('sparkles', 16) }),
      h('span', null, 'samples/ 目录为空，可直接上传文件或浏览本机路径导入。')));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const sample of samples) frag.appendChild(buildSampleCard(sample));
  samplesEl.replaceChildren(frag);
}

function sampleVariant(sample) {
  const key = String(sample.id || sample.file || '').toLowerCase();
  if (key.includes('motion')) return 'motion';
  if (key.includes('bloom')) return 'bloom';
  return 'generic';
}

function buildSampleCard(sample) {
  const variant = sampleVariant(sample);
  const cover = sample.cover && typeof sample.cover === 'object' ? sample.cover : {};
  const art = h('div', { class: `lib-sample-art is-${variant}` },
    h('div', { class: 'lib-sample-art-label' }, variant === 'motion' ? 'MOTION / 100' : variant === 'bloom' ? 'BLOOM / LIVE' : 'DEMO DECK'),
    h('div', { class: 'lib-sample-art-shapes', 'aria-hidden': 'true' },
      h('i', { class: 'shape shape-a' }),
      h('i', { class: 'shape shape-b' }),
      h('i', { class: 'shape shape-c' }),
      h('i', { class: 'shape shape-d' }),
      h('i', { class: 'shape shape-e' })),
    h('div', { class: 'lib-sample-art-title' }, sample.name || sample.id));
  art.style.background = cover.bg || (variant === 'bloom' ? '#120A26' : '#0A0A0B');
  art.style.color = cover.fg || '#F2EAE0';
  art.style.setProperty('--sample-accent', cover.accent || '#E1402B');

  const importing = state.importingSample === sample.id;
  const importBtn = h('button', {
    class: 'btn btn--accent btn--sm lib-sample-btn',
    type: 'button',
    disabled: importing,
  }, ic(importing ? 'loading' : 'import', 15), h('span', null, importing ? '导入中…' : '导入示例'));
  if (importing) importBtn.querySelector('.ic-slot')?.classList.add('spin');
  importBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    importSample(sample);
  });

  const previewBtn = h('button', {
    class: 'icon-btn icon-btn--sm lib-sample-preview',
    type: 'button',
    title: '预览示例原稿',
    'aria-label': '预览示例原稿',
  }, ic('external', 15));
  previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      window.open(`/samples/${encodeURIComponent(sample.id)}/index.html`, '_blank', 'noopener');
    } catch { /* ignore */ }
  });

  return h('article', { class: 'lib-sample-card', dataset: { sampleId: sample.id } },
    art,
    h('div', { class: 'lib-sample-body' },
      h('div', { class: 'lib-sample-head' },
        h('span', { class: 'lib-sample-name ellipsis' }, sample.name || sample.id),
        h('span', { class: 'badge' }, sample.slides ? sample.slides + ' 页' : '示例')),
      h('p', { class: 'lib-sample-desc' }, sample.desc || '内置原稿，一键导入并保留原动效。'),
      h('div', { class: 'lib-sample-foot' }, importBtn, previewBtn)));
}

async function importSample(sample) {
  if (state.importingSample) return;
  state.importingSample = sample.id;
  renderSamples();
  try {
    const res = await ctx.bus.runCommand('file.import', {
      sampleId: sample.id,
      sampleName: sample.name || sample.id,
      file: sample.file,
      mode: 'raw',
    });
    if (res && res.ok === false && res.error) {
      ctx.toast.error('示例导入失败：' + res.error);
    }
  } finally {
    state.importingSample = '';
    renderSamples();
    refreshProjects({ soft: true });
  }
}
