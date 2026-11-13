/* 底部状态栏：页码 / 选中摘要 / 保存状态 / 缩放控件 / 快捷键提示
 * 编辑器：第 x / y 页、选中元素摘要、保存状态、缩放（适合 + 百分比 + 加减）
 * 文件库：工程数量 / 最近更新 / 版本与快捷键提示
 */

import { h, formatTime } from '../core/dom.js';
import { icon } from './icons.js';

let ctxRef = null;
let els = {};
let syncPending = false;

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];

const TYPE_META = {
  text: { icon: 'type', label: '文字' },
  image: { icon: 'image', label: '图片' },
  shape: { icon: 'shapes', label: '形状' },
  html: { icon: 'code', label: 'HTML' },
  canvas: { icon: 'layout', label: '画布' },
};

function cmd(name, payload) {
  return ctxRef.bus.runCommand(name, payload);
}

function tip(text, kbd) {
  return kbd ? `${text}|${kbd}` : text;
}

function iconBtn(name, tipText, onClick, extraClass = '') {
  const btn = h('button', {
    class: `sb-btn sb-icon-btn ${extraClass}`.trim(),
    type: 'button',
    'data-tip': tipText,
    'aria-label': tipText,
    html: icon(name, 13),
  });
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

function pageText(state) {
  const total = state.deck?.total || 0;
  const current = state.deck?.current || 0;
  if (!total) return '— / —';
  return `${current + 1} / ${total}`;
}

function slideName(state) {
  const current = state.deck?.current || 0;
  return state.deck?.slides?.[current]?.name || '';
}

function selectionInfo(selection) {
  if (!selection) return { icon: 'mouse-pointer', text: '未选择元素', muted: true, tip: '在画布中单击元素以选中' };
  const meta = TYPE_META[selection.type] || { icon: 'dot', label: '元素' };
  const parts = [meta.label];
  if (selection.rect) parts.push(`${Math.round(selection.rect.w)} × ${Math.round(selection.rect.h)}`);
  const rawText = typeof selection.text === 'string' ? selection.text.replace(/\s+/g, ' ').trim() : '';
  if (rawText) parts.push(`「${rawText.length > 22 ? rawText.slice(0, 22) + '…' : rawText}」`);
  return {
    icon: meta.icon,
    text: parts.join(' · '),
    muted: false,
    tip: selection.editable === false ? '元素已锁定（只读）' : '双击元素可编辑；点击打开 / 关闭属性面板',
  };
}

/* ============================================================
   编辑器状态栏
   ============================================================ */

function buildEditor() {
  const state = ctxRef.store.get();

  /* 左：页码 + 页名 */
  const pageBtn = h('button', { class: 'sb-btn sb-page', type: 'button' });
  pageBtn.append(
    h('span', { class: 'sb-page-ic', html: icon('slide', 13) }),
    h('span', { class: 'sb-page-num' }, pageText(state)),
    h('span', { class: 'sb-page-name' }, slideName(state)),
  );
  pageBtn.setAttribute('data-tip', '显示 / 隐藏幻灯片缩略图');
  pageBtn.addEventListener('click', () => cmd('app.toggleSlidePanel'));
  els.pageNum = pageBtn.querySelector('.sb-page-num');
  els.pageName = pageBtn.querySelector('.sb-page-name');

  /* 中：选中元素摘要 */
  const selBtn = h('button', { class: 'sb-btn sb-sel', type: 'button' });
  selBtn.append(
    h('span', { class: 'sb-sel-ic', html: icon('mouse-pointer', 13) }),
    h('span', { class: 'sb-sel-text' }, '未选择元素'),
  );
  selBtn.addEventListener('click', () => cmd('app.toggleInspector'));
  els.selBtn = selBtn;
  els.selIc = selBtn.querySelector('.sb-sel-ic');
  els.selText = selBtn.querySelector('.sb-sel-text');

  /* 右：保存状态 */
  const saveBtn = h('button', { class: 'sb-btn sb-save', type: 'button', 'data-tip': '保存到磁盘|Ctrl S' });
  saveBtn.append(
    h('span', { class: 'sb-save-ic', html: icon('check-circle', 12) }),
    h('span', { class: 'sb-save-text' }, '已保存'),
  );
  saveBtn.addEventListener('click', () => cmd('app.save'));
  els.saveBtn = saveBtn;
  els.saveIc = saveBtn.querySelector('.sb-save-ic');
  els.saveText = saveBtn.querySelector('.sb-save-text');

  /* 右：缩放控件 */
  const zoomOut = h('button', {
    class: 'sb-zoom-btn',
    type: 'button',
    'data-tip': '缩小',
    'aria-label': '缩小',
    html: icon('minus', 13),
  });
  zoomOut.addEventListener('click', () => cmd('app.zoomOut'));

  const zoomIn = h('button', {
    class: 'sb-zoom-btn',
    type: 'button',
    'data-tip': '放大',
    'aria-label': '放大',
    html: icon('plus', 13),
  });
  zoomIn.addEventListener('click', () => cmd('app.zoomIn'));

  const zoomFit = h('button', {
    class: 'sb-zoom-btn',
    type: 'button',
    'data-tip': '适应窗口',
    'aria-label': '适应窗口',
    html: icon('fit', 13),
  });
  zoomFit.addEventListener('click', () => cmd('app.zoomFit'));

  const zoomPct = h('button', {
    class: 'sb-zoom-pct',
    type: 'button',
    'data-tip': '缩放比例',
    'aria-label': '缩放比例',
  }, '适合');
  zoomPct.addEventListener('click', () => {
    const current = ctxRef.store.get().ui.zoom;
    ctxRef.overlay.menu({
      anchor: zoomPct,
      align: 'end',
      items: () => [
        { label: '适应窗口', icon: 'fit', checked: current === 'fit', onClick: () => cmd('app.zoomFit') },
        { sep: true },
        ...ZOOM_PRESETS.map((z) => ({
          label: `${Math.round(z * 100)}%`,
          checked: typeof current === 'number' && Math.abs(current - z) < 0.001,
          onClick: () => cmd('view.zoom', { zoom: z }),
        })),
        { sep: true },
        { label: '重置为 100%', icon: 'refresh', onClick: () => cmd('app.zoomReset') },
      ],
    });
  });
  els.zoomPct = zoomPct;

  els.zoomGroup = h('div', { class: 'sb-zoom' }, zoomOut, zoomPct, zoomIn, h('span', { class: 'sb-zoom-sep' }), zoomFit);

  /* 右：快捷键提示 */
  const hint = h(
    'button',
    { class: 'sb-hint', type: 'button', 'data-tip': '打开命令面板|Ctrl K', onClick: () => cmd('app.commandPalette') },
    h('span', { class: 'sb-hint-ic', html: icon('command', 12) }),
    h('span', { class: 'kbd' }, 'Ctrl K'),
    h('span', { class: 'sb-hint-text' }, '命令'),
  );
  const helpBtn = iconBtn('keyboard', '快捷键与帮助', () => cmd('help.shortcuts'), 'sb-icon-btn--ghost');

  els.root.replaceChildren(
    h('div', { class: 'sb-left' }, pageBtn),
    h('div', { class: 'sb-mid' }, selBtn),
    h(
      'div',
      { class: 'sb-right' },
      saveBtn,
      h('span', { class: 'sb-sep' }),
      els.zoomGroup,
      h('span', { class: 'sb-sep' }),
      hint,
      helpBtn,
    ),
  );
}

/* ============================================================
   文件库状态栏
   ============================================================ */

function buildLibrary() {
  const state = ctxRef.store.get();
  const count = (state.library?.projects || []).length;
  const loading = state.library?.loading;

  const infoText = h('span', { class: 'sb-lib-text' }, loading ? '正在载入工程…' : `共 ${count} 个工程`);
  const info = h('div', { class: 'sb-lib-info' },
    h('span', { class: 'sb-lib-dot' }),
    infoText,
  );

  const right = h(
    'div',
    { class: 'sb-right' },
    h('span', { class: 'sb-version' }, `WebDeck Studio v${ctxRef.version || '1.0.0'}`),
    h('span', { class: 'sb-sep' }),
    h(
      'button',
      { class: 'sb-hint', type: 'button', 'data-tip': '打开命令面板|Ctrl K', onClick: () => cmd('app.commandPalette') },
      h('span', { class: 'sb-hint-ic', html: icon('command', 12) }),
      h('span', { class: 'kbd' }, 'Ctrl K'),
      h('span', { class: 'sb-hint-text' }, '命令'),
    ),
  );

  els.libInfo = info;
  els.libInfoText = infoText;
  els.root.replaceChildren(
    h('div', { class: 'sb-left' }, h('span', { class: 'sb-lib-label' }, h('span', { class: 'sb-lib-ic', html: icon('folder', 12) }), '文件库'), info),
    h('div', { class: 'sb-mid' }),
    right,
  );
}

/* ============================================================
   同步
   ============================================================ */

function syncEditor(state) {
  if (els.pageNum) els.pageNum.textContent = pageText(state);
  if (els.pageName) {
    const name = slideName(state);
    els.pageName.textContent = name;
    els.pageName.classList.toggle('is-empty', !name);
  }

  if (els.selText) {
    const info = selectionInfo(state.selection);
    if (els.selIc) els.selIc.innerHTML = icon(info.icon, 13);
    els.selText.textContent = info.text;
    els.selBtn.classList.toggle('is-muted', !!info.muted);
    if (info.tip) els.selBtn.setAttribute('data-tip', info.tip);
    else els.selBtn.removeAttribute('data-tip');
  }

  if (els.saveBtn) {
    const saving = state.ui.saving || 'saved';
    const map = {
      saved: ['check-circle', '已保存', 'is-saved'],
      saving: ['loading', '保存中', 'is-saving'],
      dirty: ['dot', '未保存', 'is-dirty'],
      error: ['alert', '保存失败', 'is-error'],
    };
    const [ic, text, cls] = map[saving] || map.saved;
    els.saveBtn.classList.remove('is-saved', 'is-saving', 'is-dirty', 'is-error');
    els.saveBtn.classList.add(cls);
    if (els.saveIc) els.saveIc.innerHTML = icon(ic, 12);
    if (els.saveText) els.saveText.textContent = text;
    const last = state.ui.savedAt ? `上次保存 ${formatTime(state.ui.savedAt)}` : '保存到磁盘';
    els.saveBtn.setAttribute('data-tip', `${last}|Ctrl S`);
  }

  if (els.zoomPct) {
    const zoom = state.ui.zoom;
    els.zoomPct.textContent = typeof zoom === 'number' ? `${Math.round(zoom * 100)}%` : '适合';
  }
}

function syncLibrary(state) {
  if (!els.libInfoText) return;
  const count = (state.library?.projects || []).length;
  const loading = state.library?.loading;
  els.libInfoText.textContent = loading ? '正在载入工程…' : `共 ${count} 个工程`;
}

function sync() {
  if (!ctxRef || !els.root) return;
  const state = ctxRef.store.get();
  if (ctxRef.route?.name === 'editor') syncEditor(state);
  else syncLibrary(state);
}

function scheduleSync() {
  if (syncPending) return;
  syncPending = true;
  requestAnimationFrame(() => {
    syncPending = false;
    sync();
  });
}

function build() {
  if (!els.root) return;
  const root = els.root;
  els = { root };
  if (ctxRef.route?.name === 'editor') buildEditor();
  else buildLibrary();
  scheduleSync();
}

export async function init(ctx) {
  ctxRef = ctx;
  els.root = document.getElementById('statusbar');
  build();

  ctx.bus.on('route:change', () => build());
  ctx.bus.on('deck:ready', scheduleSync);
  ctx.bus.on('deck:change', scheduleSync);
  ctx.bus.on('slide:change', scheduleSync);
  ctx.bus.on('selection:change', scheduleSync);
  ctx.bus.on('history:change', scheduleSync);
  ctx.bus.on('project:saved', scheduleSync);
  ctx.bus.on('project:dirty', scheduleSync);
  ctx.bus.on('editor:saving', scheduleSync);
  ctx.bus.on('editor:zoom', scheduleSync);
  ctx.bus.on('editor:layout', scheduleSync);
  ctx.bus.on('editor:ui', scheduleSync);
  ctx.bus.on('library:update', scheduleSync);
  ctx.store.subscribe(scheduleSync);
  if (document.fonts?.ready) document.fonts.ready.then(scheduleSync).catch(() => {});
}
