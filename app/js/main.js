/* WebDeck Studio · 应用入口：初始化、路由、全局快捷键 */

import { bus } from './core/bus.js';
import { store } from './core/store.js';
import { api } from './core/api.js';
import { toast } from './core/toast.js';
import { dialog } from './core/dialog.js';
import { icons } from './ui/icons.js';
import { isTypingTarget, parseQuery } from './core/dom.js';

import * as overlays from './ui/overlays.js';
import * as titlebar from './ui/titlebar.js';
import * as ribbon from './ui/ribbon.js';
import * as statusbar from './ui/statusbar.js';
import * as palette from './ui/palette.js';
import * as library from './library/library.js';
import * as animations from './editor/animations.js';
import * as transitions from './editor/transitions.js';
import * as themes from './editor/themes.js';
import * as contextMenu from './editor/context-menu.js';
import * as timeline from './editor/timeline.js';
import * as editor from './editor/editor.js';
import * as agent from './agent/agent.js';
import { initFavorites } from './editor/favorites.js';

const THEME_KEY = 'wds:theme';

/** 全局上下文：模块只能通过它协作 */
const ctx = {
  version: '1.0.0',
  api,
  store,
  bus,
  toast,
  dialog,
  icons,
  icon: icons.icon,
  route: { name: 'library', projectId: null },
  editor: null,
  qa: false,
  navigate(hash) {
    if (location.hash === hash) handleRoute(true);
    else location.hash = hash;
  },
  setEditor(obj) { ctx.editor = obj; },
  getEditor() { return ctx.editor; },
  refreshRoute(force = false) { return handleRoute(force); },
};

window.__WDS__ = ctx;
initFavorites(ctx);

/* ---------- 主题 ---------- */
function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  document.getElementById('app').dataset.theme = t;
  store.update((s) => { s.ui.theme = t; });
  try { localStorage.setItem(THEME_KEY, t); } catch { /* ignore */ }
  bus.emit('ui:theme', { theme: t });
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (!saved) saved = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved);
  bus.registerCommand('app.toggleTheme', () => applyTheme(store.get().ui.theme === 'dark' ? 'light' : 'dark'));
}

/* ---------- 路由 ---------- */
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (raw.startsWith('p/')) {
    const projectId = decodeURIComponent(raw.slice(2).split('?')[0]);
    return { name: 'editor', projectId };
  }
  return { name: 'library', projectId: null };
}

let routeToken = 0;

async function handleRoute(force = false) {
  const next = parseRoute();
  const prev = ctx.route;
  const same = prev.name === next.name && prev.projectId === next.projectId;
  if (same && !force) return;
  const token = ++routeToken;
  ctx.route = next;
  store.set({ route: next });
  try { dialog.closeAll(); } catch { /* ignore */ }
  try { ctx.overlay?.close?.(); } catch { /* ignore */ }
  const app = document.getElementById('app');
  app.dataset.route = next.name;

  if (next.name === 'editor') {
    try {
      const { project } = await api.getProject(next.projectId);
      if (token !== routeToken) return;
      store.set({ project });
      document.title = `${project.name} · WebDeck Studio`;
      bus.emit('project:open', { project });
    } catch (err) {
      if (token !== routeToken) return;
      console.error('[route] 打开工程失败', err);
      toast.error('打开工程失败：' + (err.message || err));
      ctx.navigate('#/');
    }
  } else {
    document.title = 'WebDeck Studio · 网页演播工作台';
    store.update((s) => { s.project = null; s.deck.ready = false; });
    bus.emit('library:open');
  }
  bus.emit('route:change', next);
}

/* ---------- 全局快捷键 ---------- */
function bindGlobalKeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = isTypingTarget(document.activeElement);

    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      bus.runCommand('app.save');
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      bus.runCommand('app.commandPalette');
      return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      bus.runCommand('app.toggleAgent');
      return;
    }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      bus.runCommand(e.shiftKey ? 'app.redo' : 'app.undo');
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      bus.runCommand('app.redo');
      return;
    }
    if (ctx.route.name === 'editor' && e.key === 'F5') {
      e.preventDefault();
      bus.runCommand(e.shiftKey ? 'app.presentCurrent' : 'app.present');
    }
  }, true);
}

/* ---------- 启动 ---------- */
async function boot() {
  const { editorProjectFonts, projectFontCss } = await import('./core/project-fonts.js');
  const css = projectFontCss(editorProjectFonts());
  if (css) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }
  initTheme();
  ctx.qa = parseQuery().qa === '1';
  if (ctx.qa) document.documentElement.classList.add('qa');

  const modules = [
    ['overlays', overlays], ['titlebar', titlebar], ['ribbon', ribbon], ['statusbar', statusbar],
    ['palette', palette], ['library', library],
    ['animations', animations], ['transitions', transitions], ['themes', themes],
    ['contextMenu', contextMenu], ['editor', editor], ['timeline', timeline], ['agent', agent],
  ];
  for (const [name, mod] of modules) {
    try {
      if (typeof mod.init === 'function') await mod.init(ctx);
    } catch (err) {
      console.error(`[boot] 模块 ${name} 初始化失败`, err);
      toast.error(`模块 ${name} 初始化失败：${err.message || err}`);
    }
  }

  bindGlobalKeys();
  window.addEventListener('hashchange', () => handleRoute());
  bus.registerCommand('app.commandPalette', () => palette.openPalette?.(ctx));
  bus.registerCommand('app.settings', () => bus.runCommand('agent.openSettings'));

  await handleRoute(true);

  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('is-gone');
    setTimeout(() => splash.remove(), 600);
  }
  bus.emit('app:ready', { ctx });
  console.info('%cWebDeck Studio', 'color:#C43E1C;font-weight:700', '已启动 ·', location.origin);
}

boot().catch((err) => {
  console.error('[boot] 启动失败', err);
  const tip = document.querySelector('.splash-tip');
  if (tip) tip.textContent = '启动失败：' + (err.message || err);
});
