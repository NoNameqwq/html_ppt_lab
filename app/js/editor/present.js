/* 放映：新窗口打开 deck（从当前页 / 从头），以及编辑器内全屏预览 */

import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { icon } from '../ui/icons.js';

let ctx = null;
let inlineEl = null;
let inlineFrame = null;
let unsubs = [];

export async function init(context) {
  ctx = context;
  bindEvents();
  registerCommands();
}

/** 兼容模式（raw 原稿直编）：直接放映原文件，动效/切换 100% 保留 */
function isRawMode() {
  const deck = store.get().deck || {};
  return deck.raw === true || deck.mode === 'raw';
}

function deckUrl(index) {
  const project = ctx?.getEditor?.()?.project || store.get().project;
  if (!project?.id) return null;
  const base = '/p/' + encodeURIComponent(project.id) + '/index.html';
  // 兼容模式：原稿用自己的导航，不追加 #n 深链（部分原稿不支持 hash）
  if (isRawMode()) return base;
  return index != null ? base + '#' + (Number(index) + 1) : base;
}

/* ================= 新窗口放映 ================= */

function openPresentWindow(index) {
  const url = deckUrl(index);
  if (!url) {
    toast('还没有打开任何工程');
    return { ok: false };
  }
  if (isRawMode() && index != null) {
    toast('网页放映：从第 1 页开始（原稿动画完整保留）');
  }
  const win = window.open(url, '_blank');
  if (!win) {
    toast.error('放映窗口被浏览器拦截，请允许本站弹出窗口后重试', {
      duration: 5200,
      action: { label: '再试一次', onClick: () => openPresentWindow(index) },
    });
    return { ok: false, error: 'popup-blocked' };
  }
  try { win.opener = null; } catch { /* ignore */ }
  try { win.focus(); } catch { /* ignore */ }
  return { ok: true, url };
}

/* ================= 编辑器内全屏预览（可选） ================= */

function ensureInline() {
  if (inlineEl) return inlineEl;
  const root = document.getElementById('present-root');
  if (!root) return null;
  inlineFrame = h('iframe', { class: 'present-frame', title: '放映预览', allow: 'fullscreen' });
  const closeBtn = h('button', {
    class: 'present-close',
    title: '退出预览 (Esc)',
    html: icon('x', 18),
    onclick: () => closeInline(),
  });
  inlineEl = h('div', { class: 'present-overlay' },
    h('div', { class: 'present-bar' },
      h('span', { class: 'present-tip' }, '放映预览 · Esc 退出'),
      closeBtn),
    inlineFrame);
  inlineEl.addEventListener('pointerdown', (e) => {
    if (e.target === inlineEl) closeInline();
  });
  root.append(inlineEl);
  return inlineEl;
}

function openInline(index) {
  const url = deckUrl(index);
  if (!url) {
    toast('还没有打开任何工程');
    return { ok: false };
  }
  const overlay = ensureInline();
  if (!overlay) return { ok: false };
  inlineFrame.src = url;
  overlay.classList.add('is-open');
  document.body.classList.add('is-presenting');
  return { ok: true };
}

function closeInline() {
  if (!inlineEl) return;
  inlineEl.classList.remove('is-open');
  document.body.classList.remove('is-presenting');
  setTimeout(() => { if (inlineFrame && !inlineEl.classList.contains('is-open')) inlineFrame.src = 'about:blank'; }, 260);
}

/* ================= 事件 / 命令 ================= */

function bindEvents() {
  unsubs.push(bus.on('deck:unload', () => closeInline()));
  unsubs.push(bus.on('app:route', () => closeInline()));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inlineEl?.classList.contains('is-open')) {
      e.preventDefault();
      closeInline();
    }
  }, true);
}

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload); } catch (err) {
      console.error('[present] 命令失败', name, err);
      toast.error('放映失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('app.present', { label: '从头开始放映', group: '放映', icon: 'present', shortcut: 'F5' }, () => openPresentWindow(null));
  reg('app.presentCurrent', { label: '从当前页放映', group: '放映', icon: 'play-circle', shortcut: 'Shift+F5' }, () => {
    const index = store.get().deck.current || 0;
    return openPresentWindow(index);
  });
  reg('app.presentInline', { label: '在编辑器内预览', group: '放映', icon: 'monitor' }, () => {
    const index = store.get().deck.current || 0;
    return openInline(index);
  });
}
