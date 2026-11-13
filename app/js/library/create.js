/* ==========================================================================
   新建工程：模板画廊对话框
   - GET /api/templates → 模板卡片（缩略图 iframe 或 cover 色块排版预览）
   - 命名 → POST /api/projects → 关闭弹窗 → 进入编辑器
   ========================================================================== */

import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import {initTemplateLibrary,importTemplate,saveTemplate,manageTemplates} from './templates.js';

/** 模板列表接口不可用时的兜底（与 motion-design 的模板 id 对齐） */
const FALLBACK_TEMPLATES = [
  { id: 'blank', name: '空白', desc: '干净的起点，自由排版', theme: 'ink', slides: 3, cover: { bg: '#FBFAF7', fg: '#1B1A17', accent: '#C43E1C' } },
  { id: 'ink', name: '墨韵', desc: '骨白 / 墨黑 / 朱砂，衬线标题', theme: 'ink', slides: 8, cover: { bg: '#0A0A0B', fg: '#F2EAE0', accent: '#E1402B' } },
  { id: 'bloom', name: '繁花', desc: '深紫与粉，柔和光晕', theme: 'bloom', slides: 8, cover: { bg: '#120A26', fg: '#F6F1EA', accent: '#FF5C8A' } },
  { id: 'minimal', name: '素白', desc: '浅色极简，商务克制', theme: 'paper', slides: 7, cover: { bg: '#F2F0EB', fg: '#1B1A17', accent: '#2C6E68' } },
];

let ctx = null;

export async function init(_ctx) {
  ctx = _ctx;
  initTemplateLibrary(ctx);
  ctx.bus.registerCommand('file.new', () => openNewDialog(), {
    label: '新建演示',
    group: '文件',
    icon: 'file-plus',
    shortcut: '',
  });
}

function fmtDate(d = new Date()) {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function coverOf(tpl) {
  const c = tpl && tpl.cover;
  if (c && typeof c === 'object') {
    return { bg: c.bg || '#1B1A17', fg: c.fg || '#F2EAE0', accent: c.accent || '#E1402B' };
  }
  if (typeof c === 'string') return { bg: c, fg: '#F2EAE0', accent: '#E1402B' };
  return { bg: '#1B1A17', fg: '#F2EAE0', accent: '#E1402B' };
}

/** 模板 iframe 缩略图（静态模板由 runtime 自行处理 ?wpx=thumb） */
function templateFrame(tpl) {
  const frame = h('iframe', {
    class: 'tpl-frame',
    src: `/templates/${encodeURIComponent(tpl.id)}/index.html?wpx=thumb&slide=0`,
    loading: 'lazy',
    title: (tpl.name || tpl.id) + ' 预览',
    tabindex: '-1',
    scrolling: 'no',
    sandbox: 'allow-scripts',
  });
  frame.addEventListener('load', () => {
    frame.classList.add('is-loaded');
  });
  frame.addEventListener('error',()=>frame.classList.add('is-failed'));
  return frame;
}

/** cover 色块 + 排版预览（视频/加载失败的视觉兜底） */
function coverPreview(tpl) {
  const c = coverOf(tpl);
  const el = h('div', { class: 'tpl-cover' },
    h('div', { class: 'tpl-cover-rule' }),
    h('div', { class: 'tpl-cover-title' }, tpl.name || '模板'),
    h('div', { class: 'tpl-cover-lines' }, h('i'), h('i'), h('i')),
    h('div', { class: 'tpl-cover-dots' }, h('b'), h('b'), h('b')));
  el.style.setProperty('--tpl-bg', c.bg);
  el.style.setProperty('--tpl-fg', c.fg);
  el.style.setProperty('--tpl-accent', c.accent);
  return el;
}

function buildTemplateCard(tpl, state) {
  const c = coverOf(tpl);
  const card = h('button', {
    class: 'tpl-card',
    type: 'button',
    role: 'option',
    'aria-selected': 'false',
    dataset: { templateId: tpl.id },
  },
  h('div', { class: 'tpl-thumb' },
    coverPreview(tpl),
    templateFrame(tpl),
    h('div', { class: 'tpl-check', html: icon('check', 12) })),
  h('div', { class: 'tpl-info' },
    h('div', { class: 'tpl-line' },
      h('span', { class: 'tpl-name' }, tpl.name || tpl.id),
      h('span', { class: 'tpl-slides' }, (tpl.slides ? tpl.slides + ' 页' : '') || '')),
    h('div', { class: 'tpl-desc' }, tpl.desc || '')),
  );
  card.style.setProperty('--tpl-accent', c.accent);
  card.addEventListener('click', () => selectTemplate(state, tpl, card));
  return card;
}

function selectTemplate(state, tpl, card) {
  state.selectedId = tpl.id;
  const grid = card.parentElement;
  if (grid) {
    for (const el of grid.querySelectorAll('.tpl-card')) {
      const on = el === card;
      el.classList.toggle('is-selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  if (!state.nameDirty) {
    const title = tpl.name || '未命名演示';
    state.nameInput.value = `${title} · ${fmtDate()}`;
  }
  state.selectedName = tpl.name || tpl.id;
}

/** 模板加载失败时显示的提示块 */
function errorBox(message, onRetry) {
  return h('div', { class: 'tpl-error' },
    h('span', { class: 'tpl-error-icon', html: icon('alert', 16) }),
    h('div', { class: 'grow' }, h('div', { class: 'tpl-error-title' }, '模板加载失败'), h('div', { class: 'tpl-error-sub' }, message)),
    h('button', { class: 'btn btn--sm', type: 'button', onclick: onRetry }, '重试'));
}

function skeletonGrid() {
  const grid = h('div', { class: 'tpl-grid' });
  for (let i = 0; i < 4; i += 1) {
    grid.appendChild(h('div', { class: 'tpl-card tpl-card--skeleton' },
      h('div', { class: 'skeleton skeleton--thumb' }),
      h('div', { class: 'skeleton skeleton--line' }),
      h('div', { class: 'skeleton skeleton--line skeleton--short' })));
  }
  return grid;
}

async function openNewDialog() {
  if (!ctx) return { ok: false, error: '模块未初始化' };
  const state = {
    templates: [],
    selectedId: '',
    selectedName: '',
    nameDirty: false,
    creating: false,
    loadToken: 0,
  };

  const gallery = h('div', { class: 'tpl-gallery' }, skeletonGrid());
  const nameInput = h('input', {
    class: 'input',
    placeholder: '给演示起个名字…',
    maxlength: '80',
    spellcheck: 'false',
  });
  const nameHint = h('span', { class: 'tpl-name-hint' }, '创建后仍可重命名');
  state.nameInput = nameInput;
  nameInput.addEventListener('input', () => {
    state.nameDirty = true;
    if (nameInput.value.trim()) nameInput.classList.remove('is-invalid');
  });

  const body = h('div', { class: 'tpl-dialog' },
    h('div',{class:'author-row'},h('button',{class:'btn btn--sm',onClick:async()=>{const r=await importTemplate(ctx);if(r?.template){state.selectedId=r.template.id;await loadTemplates();}}},'导入 / 自定义模板'),h('button',{class:'btn btn--sm',disabled:!ctx.store.get().project,onClick:async()=>{const r=await saveTemplate(ctx);if(r?.template){state.selectedId=r.template.id;await loadTemplates();}}},'保存当前为模板'),h('button',{class:'btn btn--sm',onClick:async()=>{await manageTemplates(ctx);await loadTemplates();}},'管理模板')),
    gallery,
    h('div', { class: 'tpl-divider' }),
    h('div', { class: 'tpl-name-row' },
      h('label', { class: 'tpl-name-label', for: 'wds-new-name' }, '工程名称'),
      h('div', { class: 'tpl-name-field' }, nameInput),
      nameHint),
    h('div', { class: 'tpl-foot-tip' }, h('span', { html: icon('sparkles', 14) }), '模板只提供版式与配色起点，创建后可在编辑器里自由修改。'));

  async function loadTemplates() {
    const token = ++state.loadToken;
    gallery.replaceChildren(skeletonGrid());
    try {
      const res = await ctx.api.templates();
      if (token !== state.loadToken) return;
      const list = Array.isArray(res?.templates) ? res.templates : [];
      if (!list.length) throw new Error('服务器没有返回模板（templates/ 目录为空）');
      state.templates = list;
      const grid = h('div', { class: 'tpl-grid', role: 'listbox', 'aria-label': '模板' });
      for (const tpl of list) grid.appendChild(buildTemplateCard(tpl, state));
      gallery.replaceChildren(grid);
      // 默认选中第一套
      const first = grid.querySelector('.tpl-card');
      if (first && !state.selectedId) first.click();
      if (state.selectedId) {
        const target = grid.querySelector(`.tpl-card[data-template-id="${cssEscape(state.selectedId)}"]`);
        if (target) selectTemplate(state, state.templates.find((t) => t.id === state.selectedId), target);
      }
    } catch (err) {
      if (token !== state.loadToken) return;
      // 接口不可用时给出兜底模板，保证新建流程可用
      state.templates = FALLBACK_TEMPLATES.slice();
      const grid = h('div', { class: 'tpl-grid', role: 'listbox', 'aria-label': '模板' });
      for (const tpl of state.templates) grid.appendChild(buildTemplateCard(tpl, state));
      gallery.replaceChildren(
        errorBox(err?.message || String(err), () => { loadTemplates(); }),
        grid,
      );
      const first = grid.querySelector('.tpl-card');
      if (first && !state.selectedId) first.click();
    }
  }

  loadTemplates();

  const result = await ctx.dialog.open({
    title: '新建演示',
    sub: '选择一个模板开始，创建后自动进入编辑器',
    width: 'lg',
    body,
    className: 'dialog--new',
    closeOnBackdrop: true,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      {
        label: '创建并打开',
        kind: 'primary',
        onClick: async (modal) => {
          if (state.creating) return false;
          const tpl = state.templates.find((t) => t.id === state.selectedId);
          const name = nameInput.value.trim();
          if (!tpl) {
            ctx.toast.warn('请先选择一个模板');
            return false;
          }
          if (!name) {
            ctx.toast.warn('请填写工程名称');
            nameInput.classList.add('is-invalid');
            nameInput.focus();
            return false;
          }
          state.creating = true;
          setFootBusy(modal, true, '创建中…');
          try {
            const res = await ctx.api.createProject({ name, templateId: tpl.id });
            const project = res?.project;
            if (!project?.id) throw new Error('服务端未返回工程信息');
            ctx.toast.ok(`已创建「${project.name || name}」`);
            ctx.bus.emit('library:refresh', { projectId: project.id });
            const hash = '#/p/' + encodeURIComponent(project.id);
            if (typeof ctx.navigate === 'function') ctx.navigate(hash);
            else location.hash = hash;
            return { project };
          } catch (err) {
            console.error('[create] 创建失败', err);
            ctx.toast.error('创建失败：' + (err?.message || err));
            return false;
          } finally {
            state.creating = false;
            setFootBusy(modal, false);
          }
        },
      },
    ],
  });
  return result?.project ? { ok: true, project: result.project } : { ok: false, canceled: true };
}

function setFootBusy(modal, busy, label) {
  if (!modal) return;
  const btns = [...modal.querySelectorAll('.modal-foot .btn')];
  for (const btn of btns) {
    btn.disabled = busy;
    if (busy && btn.classList.contains('btn--primary')) {
      if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent || '';
      btn.textContent = label || '处理中…';
    } else if (!busy && btn.classList.contains('btn--primary') && btn.dataset.idleLabel) {
      btn.textContent = btn.dataset.idleLabel;
    }
  }
}

function cssEscape(value) {
  try {
    if (window.CSS && typeof window.CSS.escape === 'function') return CSS.escape(value);
  } catch { /* ignore */ }
  return String(value).replace(/["\\]/g, '\\$&');
}
