/* Agent 右侧栏（Codex 风格）：全高面板 / 简洁 header / 输入框 + 底部工具条 */

import { h, readFileAsDataURL, formatTime } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { openSearchSettings } from './search-settings.js';
import { createAgentLoop } from './loop.js';
import { createStreamMarkdown, attachMarkdownActions, estimateTokens } from './markdown.js';
import { loadCatalog, getCachedCatalog, openManager } from './skills.js';
import {
  loadSettings, getProviders, resolveActive, openSettings, modelBadges, rememberSelection,
} from './settings.js';
import { getToolMeta, getToolDefinitionsForPermission, PERMISSION_LEVELS, normalizePermission, resolveDeckCapabilities } from './tools.js';
import { ART_DIRECTIONS, buildCreationBrief } from './blueprints.js';
import { ACCEPT, extractFile, iconForExt, summaryOf, fileExt } from './attachments.js';

const APP_ID = 'app';
const PANEL_ID = 'agent-panel';
const MAX_ATTACH = 6;
const LS_EFFORT = 'wds:agent:effort';
const LS_PERMISSION = 'wds:agent:permission';
const LS_WEBSEARCH = 'wds:agent:webSearch';
const REASONING_EFFORTS = [
  { id: 'auto', label: '自动', tip: '按任务复杂度自动选择' },
  { id: 'low', label: '低', tip: '更快，适合简单修改' },
  { id: 'medium', label: '中', tip: '平衡速度与质量' },
  { id: 'high', label: '高', tip: '更深推理，适合复杂动效' },
];

/* 动效向快捷提示（不要 PPT 模板化文案） */
const QUICK_PROMPTS = [
  '给这一页做逐字错峰入场',
  '用代码做一个旋转模糊的页面转场',
  '标题做成 3D 翻转 + 弹簧回弹',
  '用 Canvas/SVG 做粒子或描边动效',
];

const els = {};
let loop = null;
let ctxRef = null;
let currentAssistant = null;
let lastAssistant = null;
let planDoneTimer = 0;
let pendingAttachments = [];
let skillsCatalog = [];
let modelMenuEl = null;
let historyMenuEl = null;
let optionMenuEl = null;
let openMenuKind = null;
let effort = 'auto';
let permission = 'edit';
let webSearch = false;
let slashItems = [];
let slashIndex = 0;

/* ---------- 小工具 ---------- */

const ic = (name, size = 14) => icon(name, size);

function el(tag, attrs, ...children) {
  return h(tag, attrs, ...children);
}

function truncateStr(str, max = 160) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function appRoot() {
  return document.getElementById(APP_ID);
}

function projectOpen() {
  const snap = ctxRef.store.get();
  const routeName = (snap.route && snap.route.name) || (ctxRef.route && ctxRef.route.name);
  return !!(snap.project && routeName === 'editor');
}

function readLocal(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v || fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function effortMeta(id) {
  return REASONING_EFFORTS.find((e) => e.id === id) || REASONING_EFFORTS[0];
}

function permissionMeta(id) {
  return PERMISSION_LEVELS.find((p) => p.id === normalizePermission(id)) || PERMISSION_LEVELS[1];
}

/* ---------- 滚动 ---------- */

function scrollPinned() {
  if (!els.thread) return true;
  return els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 48;
}

function scrollToBottom(smooth = false) {
  if (!els.thread) return;
  const top = els.thread.scrollHeight;
  if (smooth && els.thread.scrollTo) els.thread.scrollTo({ top, behavior: 'smooth' });
  else els.thread.scrollTop = top;
}

function scrollIfPinned() {
  if (scrollPinned()) requestAnimationFrame(() => scrollToBottom(false));
}

function hasContent() {
  if (!els.thread) return false;
  return !!els.thread.querySelector('.agent-msg, .agent-error');
}

function updateEmptyVisibility() {
  if (!els.empty) return;
  if (hasContent()) {
    els.empty.remove();
  } else if (!els.empty.isConnected && els.thread) {
    els.thread.append(els.empty);
  }
}

function updateHistoryCount() {
  if (!els.historyBtn || !els.historyCount) return;
  const count = loop ? loop.getState().messages.filter((m) => m.role === 'user' && !m.synthetic).length : 0;
  els.historyCount.textContent = count > 99 ? '99+' : String(count);
  els.historyCount.classList.toggle('hidden', count === 0);
}

/** 顶栏下方上下文条：工程 / 页码 / 选中元素（Codex 的 context line） */
function updateContextBar() {
  if (!els.contextBar || !ctxRef) return;
  const snap = ctxRef.store.get();
  const proj = snap.project || {};
  const deck = snap.deck || {};
  const sel = snap.selection;
  const parts = [];
  if (proj.name) parts.push(proj.name);
  if (deck.total) parts.push('第 ' + ((deck.current || 0) + 1) + '/' + deck.total + ' 页');
  if (sel) {
    const txt = String(sel.text || '').replace(/\s+/g, ' ').trim();
    parts.push(txt ? '选中「' + (txt.length > 12 ? txt.slice(0, 12) + '…' : txt) + '」' : '已选中元素');
  }
  els.contextBar.textContent = parts.join('  ·  ') || '打开一个工程开始';
  els.contextBar.classList.toggle('is-empty', !proj.id);
}

function updateFoldNote(count) {
  if (!els.foldNote) return;
  const n = Number(count) || 0;
  els.foldNote.classList.toggle('hidden', n <= 0);
  els.foldNote.textContent = n > 0 ? `已折叠 ${n} 条早期消息` : '';
}

/* ---------- 面板开关 ---------- */

function panelOpen() {
  const app = appRoot();
  return !!app && app.dataset.agent === 'open';
}

function setOpen(open, opts = {}) {
  const app = appRoot();
  if (app) app.dataset.agent = open ? 'open' : 'closed';
  try {
    ctxRef.store.update((s) => {
      s.agent.open = !!open;
      s.ui.agentOpen = !!open;
    });
  } catch { /* ignore */ }
  try { ctxRef.bus.emit('agent:toggle', { open: !!open }); } catch { /* ignore */ }
  if (open) {
    refreshComposer();
    requestAnimationFrame(() => {
      scrollToBottom(false);
      if (opts.focus) els.input?.focus();
    });
  }
  return { ok: true, open: !!open };
}

function toggle() {
  if (!panelOpen() && !projectOpen()) {
    ctxRef.toast.warn('打开一个工程后即可使用 Agent');
    return { ok: false, error: '请先打开工程' };
  }
  return setOpen(!panelOpen(), { focus: true });
}

/* ---------- 菜单 ---------- */

function closeMenus() {
  openMenuKind = null;
  if (modelMenuEl) { modelMenuEl.remove(); modelMenuEl = null; }
  if (historyMenuEl) { historyMenuEl.remove(); historyMenuEl = null; }
  if (optionMenuEl) { optionMenuEl.remove(); optionMenuEl = null; }
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  document.removeEventListener('keydown', onDocKeyDown, true);
}

function onDocPointerDown(e) {
  const anchors = [els.modelBtn, els.historyBtn, els.effortBtn, els.permBtn];
  for (const menu of [modelMenuEl, historyMenuEl, optionMenuEl]) {
    if (menu && menu.contains(e.target)) return;
  }
  for (const a of anchors) if (a && a.contains(e.target)) return;
  closeMenus();
}

function onDocKeyDown(e) {
  if (e.key === 'Escape') {
    closeMenus();
    if (els.ctxDetail) els.ctxDetail.classList.add('hidden');
  }
}

function positionMenu(menu, anchor) {
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 240;
  const mh = menu.offsetHeight || 180;
  let left = Math.max(10, Math.min(rect.left, window.innerWidth - mw - 10));
  let top = rect.top - mh - 6;
  if (top < 10) top = Math.min(window.innerHeight - mh - 10, rect.bottom + 6);
  menu.style.left = left + 'px';
  menu.style.top = Math.max(10, top) + 'px';
  menu.style.visibility = 'visible';
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('keydown', onDocKeyDown, true);
}

function addMenuLabel(menu, text) {
  menu.append(el('div', { class: 'agent-menu-label' }, text));
}

function addMenuItem(menu, opts) {
  const item = el('button', { class: 'agent-menu-item' + (opts.active ? ' is-active' : '') + (opts.danger ? ' is-danger' : ''), type: 'button' });
  if (opts.iconName) {
    const icn = el('span', { class: 'agent-mi-icon' });
    icn.innerHTML = ic(opts.iconName, 14);
    item.append(icn);
  }
  const main = el('span', { class: 'agent-mi-main' });
  main.append(el('span', { class: 'agent-mi-name ellipsis' }, opts.label));
  if (opts.desc) main.append(el('span', { class: 'agent-mi-desc ellipsis' }, opts.desc));
  item.append(main);
  if (opts.active) {
    const check = el('span', { class: 'agent-mi-check' });
    check.innerHTML = ic('check', 13);
    item.append(check);
  }
  if (opts.onClick) item.addEventListener('click', () => { closeMenus(); opts.onClick(); });
  menu.append(item);
  return item;
}

function selectModel(providerId, modelId) {
  rememberSelection(providerId, modelId);
  if (loop) loop.setProvider(providerId, modelId);
  refreshComposer();
  closeMenus();
}

function openModelMenu() {
  closeMenus();
  const menu = el('div', { class: 'agent-menu agent-model-menu' });
  const providers = getProviders(ctxRef);
  const active = resolveActive(ctxRef);
  if (!providers.length) {
    addMenuLabel(menu, '模型');
    menu.append(el('div', { class: 'agent-menu-empty' }, '还没有 Provider，请打开 AI 设置添加'));
  }
  for (const provider of providers) {
    const models = Array.isArray(provider.models) && provider.models.length
      ? provider.models
      : (provider.model ? [{ id: provider.model, name: provider.model }] : []);
    if (!models.length) continue;
    addMenuLabel(menu, provider.name + (provider.keySet ? '' : ' · 未配置 Key'));
    for (const m of models) {
      const id = m.id || m.name;
      if (!id) continue;
      const badges = modelBadges(m).map((b) => b.label).join(' · ');
      addMenuItem(menu, {
        label: m.name || id,
        desc: badges || id,
        active: active.providerId === provider.id && active.model === id,
        iconName: 'cpu',
        onClick: () => selectModel(provider.id, String(id)),
      });
    }
  }
  menu.append(el('div', { class: 'agent-menu-sep' }));
  addMenuItem(menu, { label: 'AI 设置…', desc: 'Provider / Key / 参数', iconName: 'settings', onClick: () => openAISettings() });
  modelMenuEl = menu;
  openMenuKind = 'model';
  positionMenu(menu, els.modelBtn);
}

function openHistoryMenu() {
  closeMenus();
  const menu = el('div', { class: 'agent-menu agent-history-menu' });
  const messages = loop ? loop.getState().messages : [];
  const users = messages.filter((m) => m.role === 'user' && !m.synthetic).slice(-8).reverse();
  addMenuLabel(menu, '最近消息');
  if (!users.length) menu.append(el('div', { class: 'agent-menu-empty' }, '暂无历史消息'));
  for (const m of users) {
    addMenuItem(menu, {
      label: truncateStr(m.content || '（图片消息）', 42),
      desc: m.ts ? formatTime(m.ts) : '',
      iconName: 'message',
      onClick: () => jumpToMessage(m.id),
    });
  }
  menu.append(el('div', { class: 'agent-menu-sep' }));
  addMenuItem(menu, { label: '新会话', iconName: 'plus', onClick: () => doNewChat() });
  historyMenuEl = menu;
  openMenuKind = 'history';
  positionMenu(menu, els.historyBtn);
}

function jumpToMessage(msgId) {
  if (!msgId) return;
  const nodes = [...els.thread.querySelectorAll('.agent-msg--user')];
  const target = nodes.find((n) => n.dataset.msgId === msgId);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('is-flash');
  setTimeout(() => target.classList.remove('is-flash'), 900);
}

function openOptionMenu(anchor, title, items, kind = 'option') {
  closeMenus();
  const menu = el('div', { class: 'agent-menu agent-option-menu' });
  addMenuLabel(menu, title);
  for (const item of items) {
    addMenuItem(menu, {
      label: item.label,
      desc: item.tip,
      active: item.active,
      iconName: item.iconName,
      onClick: item.onClick,
    });
  }
  optionMenuEl = menu;
  openMenuKind = kind;
  positionMenu(menu, anchor);
}

function setEffort(next, { silent = true } = {}) {
  effort = REASONING_EFFORTS.some((e) => e.id === next) ? next : 'auto';
  writeLocal(LS_EFFORT, effort);
  if (loop) loop.setOptions({ reasoningEffort: effort });
  refreshComposer();
  if (!silent) ctxRef.toast.ok('思考强度：' + effortMeta(effort).label);
}

function setPermission(next, { silent = true } = {}) {
  permission = normalizePermission(next);
  writeLocal(LS_PERMISSION, permission);
  if (loop) loop.setOptions({ permission });
  refreshComposer();
  if (!silent) ctxRef.toast.ok('工作权限：' + permissionMeta(permission).label);
}

function setWebSearch(next, { silent = true } = {}) {
  webSearch = !!next;
  writeLocal(LS_WEBSEARCH, webSearch ? '1' : '0');
  if (loop) loop.setOptions({ webSearch });
  refreshComposer();
  if (!silent) ctxRef.toast.ok(webSearch ? '联网搜索：已开启（Agent 可调用 web_search）' : '联网搜索：已关闭');
}

function openEffortMenu() {
  openOptionMenu(els.effortBtn, '思考强度', REASONING_EFFORTS.map((e) => ({
    label: e.label,
    tip: e.tip,
    active: effort === e.id,
    iconName: 'brain',
    onClick: () => setEffort(e.id),
  })), 'effort');
}

function openPermissionMenu() {
  openOptionMenu(els.permBtn, '工作权限', PERMISSION_LEVELS.map((p) => ({
    label: p.label,
    tip: p.tip,
    active: permission === p.id,
    iconName: p.id === 'read' ? 'lock' : p.id === 'full' ? 'unlock' : 'edit',
    onClick: () => setPermission(p.id),
  })), 'permission');
}

/* ---------- 设置 / 技能 ---------- */

async function openAISettings(focusProvider) {
  closeMenus();
  const saved = await openSettings(ctxRef, {
    focusProvider,
    skillsCatalog,
    getSkills: () => (loop ? loop.getState().skills : []),
    onChangeSkills: (ids) => { if (loop) loop.setSkills(ids); },
  });
  refreshComposer();
  return saved;
}

function openSkillsManager() {
  openManager(ctxRef, {
    catalog: skillsCatalog.length ? skillsCatalog : getCachedCatalog(),
    enabled: loop ? loop.getState().skills : [],
    onChange: (ids) => { if (loop) loop.setSkills(ids); },
  });
}

/* ---------- 消息视图 ---------- */

function createReasoningBlock() {
  const wrap = el('div', { class: 'agent-reasoning hidden' });
  const head = el('button', { type: 'button', class: 'agent-reasoning-head' });
  const label = el('span', { class: 'agent-reasoning-label' }, '思考过程');
  head.innerHTML = ic('brain', 13);
  head.append(label);
  const chev = el('span', { class: 'agent-reasoning-chev' });
  chev.innerHTML = ic('chevron-down', 13);
  head.append(chev);
  const body = el('div', { class: 'agent-reasoning-body' });
  wrap.append(head, body);
  let userToggled = false;
  head.addEventListener('click', () => {
    userToggled = true;
    wrap.classList.toggle('is-open');
  });
  return {
    wrap,
    head,
    body,
    set(text) {
      if (!text) return;
      wrap.classList.remove('hidden');
      body.textContent = text;
      label.textContent = '思考过程 · ' + text.length + ' 字';
      if (!userToggled) wrap.classList.add('is-open');
      if (wrap.classList.contains('is-open')) body.scrollTop = body.scrollHeight;
    },
    finish() {
      if (!userToggled) wrap.classList.remove('is-open');
    },
  };
}

function prettyToolArgs(raw) {
  if (raw == null || raw === '') return '{}';
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const text = JSON.stringify(parsed, null, 2);
    return text.length > 8000 ? text.slice(0, 8000) + '\n…（参数已截断）' : text;
  } catch {
    return String(raw).slice(0, 4000);
  }
}

function formatToolResult(result) {
  let text;
  try { text = JSON.stringify(result, null, 2); } catch { text = String(result); }
  if (text == null) text = 'undefined';
  if (text.length > 6000) text = text.slice(0, 6000) + '\n…（结果已截断）';
  return text;
}

function fmtDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return Math.round(n) + 'ms';
  return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
}

/** 工具行：默认单行，点开展开参数 / 结果（可撤回） */
function createToolCard(call) {
  const name = call.function && call.function.name ? call.function.name : 'tool';
  const meta = getToolMeta(name);
  const row = el('div', { class: 'agent-tool', 'data-state': 'pending', 'data-call': call.id || '', 'data-tool': name });
  const head = el('button', { type: 'button', class: 'agent-tool-head' });
  const iconBox = el('span', { class: 'agent-tool-icon' });
  iconBox.innerHTML = ic(meta.icon || 'terminal', 13);
  const title = el('span', { class: 'agent-tool-title' }, meta.label);
  const fnName = el('code', { class: 'agent-tool-fn' }, name);
  const argPreview = el('span', { class: 'agent-tool-argsline' }, '');
  const stateBox = el('span', { class: 'agent-tool-state' }, el('span', { class: 'agent-dot' }), el('span', { class: 'agent-tool-state-text' }, '等待执行'));
  const durEl = el('span', { class: 'agent-tool-dur' });
  const toggle = el('span', { class: 'agent-tool-toggle' });
  toggle.innerHTML = ic('chevron-down', 12);
  head.append(iconBox, title, fnName, argPreview, stateBox, durEl, toggle);

  const rawArgs = call.function && call.function.arguments;
  const hasArgs = !!rawArgs && String(rawArgs).replace(/\s+/g, '') !== '{}';
  const argsPre = el('pre', { class: 'agent-tool-args' + (hasArgs ? '' : ' hidden') }, prettyToolArgs(rawArgs));
  const resultEl = el('pre', { class: 'agent-tool-result' });
  const detailEl = el('span', { class: 'agent-tool-detail' });
  const undoBtn = el('button', { type: 'button', class: 'btn btn--sm agent-tool-undo hidden' }, '撤回');
  const foot = el('div', { class: 'agent-tool-foot' }, undoBtn, detailEl);
  const argsLabel = el('div', { class: 'agent-tool-k' + (hasArgs ? '' : ' hidden') }, '参数');
  const resLabel = el('div', { class: 'agent-tool-k hidden' }, '结果');
  const bodyEl = el('div', { class: 'agent-tool-body hidden' }, argsLabel, argsPre, resLabel, resultEl, foot);
  row.append(head, bodyEl);

  let open = false;
  let undoBound = false;
  let t0 = 0;
  let t1 = 0;

  function setOpen(next) {
    open = !!next;
    row.classList.toggle('is-open', open);
    bodyEl.classList.toggle('hidden', !open);
    if (open && resultEl.textContent) resultEl.scrollTop = resultEl.scrollHeight;
  }
  head.addEventListener('click', () => setOpen(!open));

  function setArgPreview(raw) {
    let text = '';
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed).slice(0, 2);
        text = keys.map((k) => {
          const v = parsed[k];
          const s = typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(v);
          return k + ':' + (s && s.length > 28 ? s.slice(0, 28) + '…' : s);
        }).join('  ');
      }
    } catch { text = truncateStr(String(raw), 48); }
    argPreview.textContent = text;
    argPreview.title = text;
  }
  setArgPreview(call.function && call.function.arguments);

  function setState(state, text) {
    row.dataset.state = state;
    const label = head.querySelector('.agent-tool-state-text');
    if (label) label.textContent = text;
    if (state === 'running') t0 = performance.now();
  }

  function bindUndo(opId, opIds) {
    if (!opId || undoBound) return;
    undoBound = true;
    undoBtn.dataset.op = opId;
    if (Array.isArray(opIds) && opIds.length > 1) undoBtn.dataset.ops = JSON.stringify(opIds);
    undoBtn.classList.remove('hidden');
    undoBtn.addEventListener('click', (e) => { e.stopPropagation(); undoAgentOp(opId, undoBtn); });
  }

  return {
    el: row,
    setState,
    setOpen,
    setArgs(raw) {
      const has = !!raw && String(raw).replace(/\s+/g, '') !== '{}';
      argsPre.textContent = prettyToolArgs(raw);
      argsPre.classList.toggle('hidden', !has);
      argsLabel.classList.toggle('hidden', !has);
      setArgPreview(raw);
    },
    setResult(value) {
      const ok = !!(value && value.ok !== false && !value.error);
      const dur = t0 ? performance.now() - t0 : 0;
      const apply = () => {
        t1 = performance.now();
        row.dataset.state = ok ? 'ok' : 'error';
        const label = head.querySelector('.agent-tool-state-text');
        if (label) label.textContent = ok ? '完成' : '失败';
        durEl.textContent = dur ? fmtDuration(dur) : '';
        resultEl.textContent = formatToolResult(value);
        resLabel.classList.remove('hidden');
        detailEl.textContent = value && value.summary ? String(value.summary) : (value && value.error ? String(value.error) : '');
        if (!ok) setOpen(true);
        if (ok && value && value.opId) bindUndo(String(value.opId), Array.isArray(value.opIds) ? value.opIds.map(String) : null);
      };
      /* Codex 式防闪烁：执行中状态至少停留 700ms，再切成完成 */
      const wait = Math.max(0, 700 - dur);
      if (wait > 0) setTimeout(apply, wait);
      else apply();
    },
    setMissing() {
      row.dataset.state = 'missing';
      const label = head.querySelector('.agent-tool-state-text');
      if (label) label.textContent = '未执行';
      resultEl.textContent = '该工具调用没有执行结果（生成可能被中断）。';
      resLabel.classList.remove('hidden');
      setOpen(true);
    },
  };
}

/**
 * 活动块：把一轮里的连续工具调用收成一组。
 * 执行中默认展开、结束后自动收起；有失败时保持展开。
 */
function createActivity() {
  const wrap = el('div', { class: 'agent-activity hidden' });
  const head = el('button', { type: 'button', class: 'agent-activity-head' });
  const spin = el('span', { class: 'agent-activity-spin' });
  spin.innerHTML = ic('loading', 12);
  const title = el('span', { class: 'agent-activity-title' }, '正在执行');
  const summary = el('span', { class: 'agent-activity-summary' });
  const durEl = el('span', { class: 'agent-activity-dur' });
  const chev = el('span', { class: 'agent-activity-chev' });
  chev.innerHTML = ic('chevron-down', 13);
  head.append(spin, title, summary, durEl, chev);
  const body = el('div', { class: 'agent-activity-body' });
  wrap.append(head, body);

  const rows = [];
  let open = false;
  let userToggled = false;
  let started = 0;
  let ended = 0;
  let failures = 0;
  let tick = null;

  function setOpen(next) {
    open = !!next;
    wrap.classList.toggle('is-open', open);
    body.classList.toggle('hidden', !open);
  }
  head.addEventListener('click', () => { userToggled = true; setOpen(!open); });

  function paintSummary() {
    if (!rows.length) { summary.textContent = ''; return; }
    const first = rows[0].el.querySelector('.agent-tool-title');
    const last = rows[rows.length - 1].el.querySelector('.agent-tool-title');
    const a = first ? first.textContent : '';
    const b = last ? last.textContent : '';
    summary.textContent = rows.length > 1 ? a + ' → ' + b : a;
  }

  return {
    el: wrap,
    get count() { return rows.length; },
    get open() { return open; },
    setOpen,
    begin(label) {
      if (!started) {
        started = performance.now();
        /* 运行中给一个实时走动的耗时，Codex 的活动行手感 */
        tick = setInterval(() => {
          if (durEl) durEl.textContent = fmtDuration(performance.now() - started);
        }, 200);
      }
      wrap.classList.remove('hidden');
      wrap.classList.add('is-running');
      if (label && !rows.length) {
        title.textContent = '正在执行';
        summary.textContent = label;
      }
    },
    addRow(call) {
      const row = createToolCard(call);
      rows.push(row);
      body.append(row.el);
      wrap.classList.remove('hidden');
      paintSummary();
      return row;
    },
    noteFailure() { failures += 1; },
    finish() {
      ended = performance.now();
      if (tick) { clearInterval(tick); tick = null; }
      wrap.classList.remove('is-running');
      wrap.classList.toggle('has-error', failures > 0);
      title.textContent = failures
        ? rows.length + ' 个工具 · ' + failures + ' 个失败'
        : rows.length + ' 个工具';
      if (started) durEl.textContent = fmtDuration(ended - started);
      /* 永远收起，不做自动展开/收合循环；只有失败才展开 */
      if (!userToggled) setOpen(failures > 0);
    },
  };
}

/**
 * 一次用户请求 = 一条 Agent 消息（可包含多轮：每轮 = 思考 + 回答 + 一组工具活动）。
 * 这样连续调用工具不会刷出一堆重复的 AGENT 标题。
 */
function createAssistantView(opts = {}) {
  const wrap = el('div', { class: 'agent-msg agent-msg--assistant' + (opts.streaming ? ' is-streaming' : ' is-done') });
  const head = el('div', { class: 'agent-ai-head' });
  const avatar = el('span', { class: 'agent-ai-avatar' });
  avatar.innerHTML = ic('sparkles', 14);
  const nameEl = el('span', { class: 'agent-ai-name' }, 'Agent');
  const state = loop && loop.getState ? loop.getState() : {};
  const modelTag = el('span', { class: 'agent-ai-model ellipsis' }, state.model || '');
  const foldBtn = el('button', { type: 'button', class: 'agent-ai-fold hidden', 'data-tip': '展开 / 收起整段过程' });
  const foldText = el('span', { class: 'agent-ai-fold-text' }, '过程');
  const foldChev = el('span', { class: 'agent-ai-fold-chev' });
  foldChev.innerHTML = ic('chevron-down', 12);
  foldBtn.append(foldText, foldChev);
  head.append(avatar, nameEl, modelTag, el('span', { class: 'grow' }), foldBtn);

  const body = el('div', { class: 'agent-ai-body' });
  wrap.append(head, body);

  const toolViews = new Map();
  let finished = false;
  let lastContent = '';
  let round = null;
  let roundCount = 0;
  let totalTools = 0;
  let pendingEnd = null;
  let foldUserToggled = false;
  let continuationPending = false;
  let lastClosedRound = null;
  let contNote = null;

  function setCollapsed(collapsed) {
    wrap.classList.toggle('is-collapsed', !!collapsed);
  }

  function updateFold() {
    const many = roundCount > 1 || totalTools > 0;
    foldBtn.classList.toggle('hidden', !many);
    foldText.textContent = roundCount + ' 轮 · ' + totalTools + ' 个工具';
  }

  /** 折叠时只保留最后一次有正文的轮次（最终回答），其余过程全部隐藏 */
  function markAnswer() {
    const rounds = [...body.querySelectorAll('.agent-ai-round')];
    rounds.forEach((r) => r.classList.remove('is-answer'));
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      if (rounds[i].classList.contains('has-md')) { rounds[i].classList.add('is-answer'); break; }
    }
  }

  foldBtn.addEventListener('click', () => {
    const pinned = scrollPinned();
    foldUserToggled = true;
    setCollapsed(!wrap.classList.contains('is-collapsed'));
    if (pinned) requestAnimationFrame(() => scrollToBottom(false));
  });

  function beginRound() {
    /* 自动接续：不新开轮次，续写到上一段回答里 */
    if (continuationPending) {
      continuationPending = false;
      if (round || pendingEnd) closeRound();
      const prev = lastClosedRound;
      if (prev) {
        round = prev;
        prev.carry = prev.content || '';
        prev.continued = true;
        prev.md.classList.remove('is-empty');
        prev.cursor = el('span', { class: 'agent-cursor' });
        prev.el.append(prev.cursor);
        prev.el.classList.add('is-continued');
        return prev;
      }
    }
    if (contNote) { contNote.remove(); contNote = null; }
    if (round || pendingEnd) closeRound();
    roundCount += 1;
    const elRound = el('div', { class: 'agent-ai-round' + (roundCount > 1 ? ' is-cont' : '') });
    if (roundCount > 1) {
      elRound.append(el('div', { class: 'agent-round-sep' },
        el('span', { class: 'agent-round-sep-line' }),
        el('span', { class: 'agent-round-sep-text' }, '第 ' + roundCount + ' 轮')));
    }
    const reasoning = createReasoningBlock();
    const md = el('div', { class: 'agent-md' });
    const activity = createActivity();
    const cursor = el('span', { class: 'agent-cursor' });
    elRound.append(reasoning.wrap, md, activity.el, cursor);
    body.append(elRound);
    round = {
      el: elRound,
      reasoning,
      md,
      activity,
      cursor,
      stream: createStreamMarkdown(md, { minInterval: 70 }),
      content: '',
      empty: true,
    };
    updateFold();
    return round;
  }

  function currentRound() {
    return round || beginRound();
  }

  function ensureTool(call) {
    const id = call.id || '';
    if (id && toolViews.has(id)) {
      const exist = toolViews.get(id);
      if (call.function && call.function.arguments != null) exist.setArgs(call.function.arguments);
      return exist;
    }
    const r = currentRound();
    const card = r.activity.addRow(call);
    r.empty = false;
    totalTools += 1;
    if (id) toolViews.set(id, card);
    updateFold();
    return card;
  }

  const view = {
    el: wrap,
    get lastContent() { return lastContent; },
    get finished() { return finished; },
    get roundCount() { return roundCount; },
    beginRound,
    setContent(text) {
      const r = currentRound();
      const chunk = String(text == null ? '' : text);
      lastContent = (r.carry || '') + chunk;
      r.content = lastContent;
      r.empty = !lastContent && r.activity.count === 0;
      r.md.classList.remove('is-empty');
      r.stream.update(lastContent);
    },
    setReasoning(text) {
      const r = currentRound();
      r.empty = r.empty && !text;
      r.reasoning.set(String(text || ''));
    },
    setToolCalls(calls) {
      if (!Array.isArray(calls)) return;
      for (const call of calls) if (call && call.id) ensureTool(call);
    },
    toolStart(call) {
      const card = ensureTool(call);
      card.setState('running', '执行中');
      currentRound().activity.begin(getToolMeta(call.function && call.function.name).label);
    },
    toolResult(call, result) {
      const card = ensureTool(call);
      card.setResult(result);
      const ok = !!(result && result.ok !== false && !result.error);
      if (!ok) currentRound().activity.noteFailure();
    },
    ensureTool,
    noteFailureForRound() { if (round) round.activity.noteFailure(); },
    /** 输出截断：整轮不结束，续写回上一段回答 */
    continuation(info = {}) {
      continuationPending = true;
      if (!contNote) {
        contNote = el('div', { class: 'agent-cont-note' },
          el('span', { class: 'agent-cont-spin', html: ic('loading', 12) }),
          el('span', { class: 'agent-cont-text' }));
        body.append(contNote);
      }
      const label = info.unexpected ? '连接中断，自动重连' : '输出达到上限，自动接续';
      contNote.querySelector('.agent-cont-text').textContent = label + ' ' + (info.count || 1) + '/' + (info.max || 8);
    },
    /** 模型这一轮流式结束（工具可能还没执行）：先记账，等下一轮开始或整轮结束时再收尾 */
    noteRoundEnd(msg, meta = {}) {
      if (!round) return;
      pendingEnd = { msg, meta };
    },
    /** 一轮彻底结束（会话回放或立即收尾） */
    finishRound(msg, meta = {}) {
      if (!round) return;
      pendingEnd = { msg, meta };
      closeRound();
    },
    finish(msg, meta = {}) {
      if (finished) return;
      finished = true;
      if (msg && typeof msg.content === 'string' && round && !round.content) round.content = msg.content;
      closeRound();
      if (contNote) { contNote.remove(); contNote = null; }
      wrap.classList.remove('is-streaming');
      wrap.classList.add('is-done');
      if (meta && meta.aborted) wrap.classList.add('is-aborted');
      if (!body.children.length && !(meta && meta.aborted)) { wrap.remove(); return; }
      /* 结束后整段收起：只留最终回答，避免多轮过程占满面板 */
      markAnswer();
      if (!foldUserToggled && (roundCount > 1 || totalTools > 0) && wrap.querySelector('.is-answer')) setCollapsed(true);
      updateFold();
      requestAnimationFrame(() => scrollIfPinned());
    },
  };

  function closeRound() {
    if (!round) { pendingEnd = null; return; }
    const info = pendingEnd || {};
    const msg = info.msg || null;
    const meta = info.meta || {};
    const r = round;
    round = null;
    pendingEnd = null;
    if (r.continued && contNote) { contNote.remove(); contNote = null; }
    const content = msg && typeof msg.content === 'string' ? msg.content : r.content;
    r.stream.finish(content);
    r.reasoning.finish();
    r.cursor.remove();
    if (r.activity.count) r.activity.finish();
    const aborted = !!meta.aborted;
    if (!content && r.activity.count === 0 && !aborted) { r.el.remove(); return; }
    if (!content && r.activity.count === 0 && aborted) r.md.append(el('div', { class: 'agent-md-note' }, '已停止'));
    r.md.classList.toggle('is-empty', !content);
    if (content) r.el.classList.add('has-md');
    r.carry = null;
    lastClosedRound = r;
    markAnswer();
  }

  return view;
}

function renderUserMessage(msg) {
  const node = el('div', { class: 'agent-msg agent-msg--user' });
  node.dataset.msgId = msg.id || '';
  const bubble = el('div', { class: 'agent-user-bubble' });
  if (msg.content) bubble.append(el('div', { class: 'agent-user-text' }, msg.content));
  if (Array.isArray(msg.images) && msg.images.length) {
    const imgs = el('div', { class: 'agent-user-imgs' });
    for (const src of msg.images) imgs.append(el('img', { src, alt: '附件图片', loading: 'lazy' }));
    bubble.append(imgs);
  }
  if (Array.isArray(msg.docs) && msg.docs.length) {
    const docsEl = el('div', { class: 'agent-user-docs' });
    for (const d of msg.docs) {
      const chip = el('span', { class: 'agent-user-doc' });
      const icn = el('span', { class: 'agent-user-doc-ic' });
      icn.innerHTML = ic(iconForExt(fileExt(d.name || '')), 12);
      chip.append(icn, el('span', { class: 'ellipsis' }, d.name || '文档'));
      if (d.pages) chip.append(el('span', { class: 'agent-user-doc-meta' }, d.pages + ' 页'));
      docsEl.append(chip);
    }
    bubble.append(docsEl);
  }
  node.append(bubble);
  if (msg.ts) node.append(el('div', { class: 'agent-msg-time' }, formatTime(msg.ts)));
  els.thread.append(node);
  updateEmptyVisibility();
  return node;
}

function renderAssistantMessage(msg, toolResults, turnView) {
  const isCont = !!turnView;
  const view = isCont ? turnView : createAssistantView({ streaming: false });
  if (!isCont) els.thread.append(view.el);
  view.beginRound();
  if (msg.reasoning) view.setReasoning(msg.reasoning);
  if (msg.content) view.setContent(msg.content);
  for (const call of msg.tool_calls || []) {
    const card = view.ensureTool(call);
    const toolMsg = toolResults.get(call.id);
    if (toolMsg) {
      let result = null;
      try { result = JSON.parse(toolMsg.content); } catch { result = { ok: false, error: '工具结果解析失败' }; }
      card.setResult(result);
      if (!(result && result.ok !== false && !result.error)) view.noteFailureForRound();
    } else {
      card.setMissing();
      view.noteFailureForRound();
    }
  }
  view.finishRound(msg, {});
  return view;
}

function renderSession(messages, skills) {
  els.thread.replaceChildren();
  currentAssistant = null;
  lastAssistant = null;
  hidePlan();
  const list = Array.isArray(messages) ? messages : [];
  let lastTurn = null;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (m.synthetic) continue;
    if (m.role === 'user') {
      lastTurn = null;
      renderUserMessage(m);
    } else if (m.role === 'assistant') {
      const results = new Map();
      let j = i + 1;
      while (j < list.length && list[j].role === 'tool') {
        results.set(list[j].tool_call_id, list[j]);
        j += 1;
      }
      lastTurn = renderAssistantMessage(m, results, lastTurn);
      i = j - 1;
    }
  }
  if (lastTurn) lastTurn.finish({}, {});
  if (!hasContent() && els.empty) {
    if (els.renderEmpty) els.renderEmpty();
    els.thread.append(els.empty);
  }
  updateEmptyVisibility();
  updateHistoryCount();
  scrollToBottom(false);
  updateFoldNote(loop ? loop.getState().foldedCount : 0);
  updateContextMeter(loop ? loop.getState().context : null);
  syncUndoButtons();
}

/* ---------- 撤回 ---------- */

function markUndone(btn) {
  if (!btn) return;
  btn.textContent = '已撤回';
  btn.disabled = true;
  btn.classList.add('is-done');
}

async function undoSingleOp(opId) {
  const history = ctxRef.store.get().history;
  const idx = history.ops.findIndex((op) => op.opId === opId);
  if (idx < 0 || idx >= history.cursor) return;
  if (idx === history.cursor - 1) {
    const res = await ctxRef.bus.runCommand('app.undo').catch((err) => ({ ok: false, error: err && err.message }));
    if (res && res.ok !== false) return;
  }
  const op = history.ops[idx];
  const editor = ctxRef.getEditor && ctxRef.getEditor();
  if (!editor || !editor.bridge) throw new Error('编辑器尚未就绪');
  await editor.bridge.call('applyOp', { op, direction: 'undo' });
  const ops = history.ops.slice();
  ops.splice(idx, 1);
  ctxRef.store.setHistory(ops, Math.max(0, history.cursor - 1));
}

async function undoAgentOp(opId, btn) {
  if (!opId) return;
  let opIds = [opId];
  try {
    if (btn && btn.dataset.ops) {
      const parsed = JSON.parse(btn.dataset.ops);
      if (Array.isArray(parsed) && parsed.length) opIds = parsed;
    }
  } catch { /* ignore */ }
  const history = ctxRef.store.get().history;
  const applied = new Set(history.ops.slice(0, history.cursor).map((op) => op.opId));
  const target = opIds.filter((id) => applied.has(id));
  if (!target.length) { markUndone(btn); return; }
  btn.disabled = true;
  try {
    for (let i = target.length - 1; i >= 0; i -= 1) await undoSingleOp(target[i]);
    markUndone(btn);
    ctxRef.toast.ok('已撤回该修改');
  } catch (err) {
    btn.disabled = false;
    console.warn('[agent] 撤回失败', err);
    ctxRef.toast.error('撤回失败：' + (err && err.message ? err.message : String(err)));
  }
}

function syncUndoButtons() {
  if (!els.thread) return;
  const history = ctxRef.store.get().history;
  const applied = new Set(history.ops.slice(0, history.cursor).map((op) => op.opId));
  for (const btn of els.thread.querySelectorAll('.agent-tool-undo[data-op]')) {
    if (btn.disabled) continue;
    if (!applied.has(btn.dataset.op)) markUndone(btn);
  }
}

/* ---------- 错误卡片 ---------- */

function renderErrorCard(err) {
  const message = (err && (err.message || (err.error && err.error.message))) || String(err || '未知错误');
  const card = el('div', { class: 'agent-error' });
  const iconBox = el('span', { class: 'agent-error-icon' });
  iconBox.innerHTML = ic('alert', 15);
  const text = el('div', { class: 'grow' },
    el('div', { class: 'agent-error-title' }, '请求失败'),
    el('div', { class: 'agent-error-desc' }, message)
  );
  const actions = el('div', { class: 'agent-error-actions' });
  const retry = el('button', { type: 'button', class: 'btn btn--sm' }, '重试');
  retry.addEventListener('click', async () => {
    retry.disabled = true;
    card.remove();
    if (loop) await loop.retryLast();
  });
  const openBtn = el('button', { type: 'button', class: 'btn btn--sm btn--ghost' }, '设置');
  openBtn.addEventListener('click', () => openAISettings());
  actions.append(retry, openBtn);
  card.append(iconBox, text, actions);
  els.thread.append(card);
  updateEmptyVisibility();
  scrollIfPinned();
  return card;
}

/* ---------- Composer ---------- */

/** Codex 式一键收起：把所有工具活动组、工具行与思考过程同时折叠/展开 */
function toggleAllDetails(force) {
  if (!els.thread) return;
  const groups = [...els.thread.querySelectorAll('.agent-activity')];
  const tools = [...els.thread.querySelectorAll('.agent-tool')];
  const reasons = [...els.thread.querySelectorAll('.agent-reasoning')];
  const anyOpen = groups.some((g) => g.classList.contains('is-open'))
    || tools.some((c) => c.classList.contains('is-open'))
    || reasons.some((r) => r.classList.contains('is-open'));
  const collapse = force != null ? !!force : anyOpen;
  groups.forEach((group) => {
    group.classList.toggle('is-open', !collapse);
    const body = group.querySelector('.agent-activity-body');
    if (body) body.classList.toggle('hidden', collapse);
  });
  tools.forEach((card) => {
    card.classList.toggle('is-open', !collapse);
    const body = card.querySelector('.agent-tool-body');
    if (body) body.classList.toggle('hidden', collapse);
  });
  reasons.forEach((r) => r.classList.toggle('is-open', !collapse));
  if (els.collapseToolsBtn) {
    els.collapseToolsBtn.innerHTML = ic(collapse ? 'chevron-down' : 'chevron-up', 16);
    els.collapseToolsBtn.dataset.tip = collapse ? '展开所有工具调用 / 思考过程' : '收起所有工具调用 / 思考过程';
  }
}

function refreshComposer() {  if (!els.modelBtn) return;
  const active = resolveActive(ctxRef);
  const providers = getProviders(ctxRef);
  const hasKey = providers.some((p) => p.keySet);
  const unconfigured = !active.providerId || !active.model || !hasKey;
  els.modelName.textContent = unconfigured ? '未配置模型' : (active.model || '');
  els.modelBtn.classList.toggle('is-warning', unconfigured);
  els.modelBtn.dataset.tip = unconfigured
    ? '未配置模型 / API Key，点击打开 AI 设置'
    : (active.provider ? active.provider.name + ' · ' : '') + active.model + '|点击切换';
  els.effortLabel.textContent = effortMeta(effort).label;
  els.effortBtn.dataset.tip = '思考强度：' + effortMeta(effort).label;
  els.permLabel.textContent = permissionMeta(permission).label;
  els.permBtn.dataset.tip = '工作权限：' + permissionMeta(permission).label;
  els.permBtn.dataset.perm = permission;
  els.permIcon.innerHTML = ic(permission === 'read' ? 'lock' : permission === 'full' ? 'unlock' : 'edit', 13);
  if (els.webBtn) {
    els.webBtn.classList.toggle('is-on', webSearch);
    els.webBtn.dataset.tip = webSearch ? '联网搜索已开启（点击关闭）' : '联网搜索已关闭（点击开启）';
    if (els.webLabel) els.webLabel.textContent = webSearch ? '联网中' : '联网';
  }
  if (typeof syncSendState === 'function') syncSendState();
}

function syncSendState() {
  if (!els.sendBtn) return;
  const streaming = !!(loop && loop.streaming);
  els.sendBtn.classList.toggle('is-stop', streaming);
  els.sendBtn.dataset.tip = streaming ? '停止生成' : '发送|Enter';
  els.sendBtn.innerHTML = streaming ? ic('stop', 16) : ic('send', 16);
  els.sendBtn.disabled = !projectOpen() && !streaming;
}

function autoGrowInput() {
  if (!els.input) return;
  els.input.style.height = 'auto';
  const max = 180;
  els.input.style.height = Math.min(els.input.scrollHeight, max) + 'px';
  els.input.style.overflowY = els.input.scrollHeight > max ? 'auto' : 'hidden';
}

/** 附件条：图片显示缩略图；PDF / Word / PPT / 文本显示文件卡片 + 解析状态 */
function renderAttachments() {
  if (!els.attachments) return;
  els.attachments.replaceChildren();
  if (!pendingAttachments.length) { els.attachments.classList.add('hidden'); return; }
  els.attachments.classList.remove('hidden');
  pendingAttachments.forEach((att, i) => {
    if (att.kind !== 'doc') {
      const item = el('div', { class: 'agent-attach' });
      item.append(el('img', { src: att.dataUrl || '', alt: '附件预览' }));
      const del = el('button', { type: 'button', class: 'agent-attach-del', title: '移除' });
      del.innerHTML = ic('x', 10);
      del.addEventListener('click', () => { pendingAttachments.splice(i, 1); renderAttachments(); });
      item.append(del);
      els.attachments.append(item);
      return;
    }
    const card = el('div', { class: 'agent-attach agent-attach--doc', 'data-state': att.status || 'reading' });
    const iconBox = el('span', { class: 'agent-attach-ic' });
    iconBox.innerHTML = ic(iconForExt(att.ext), 14);
    const main = el('span', { class: 'agent-attach-main' });
    main.append(el('span', { class: 'agent-attach-name ellipsis' }, att.name || '文件'));
    const meta = att.status === 'reading'
      ? '读取中…'
      : att.status === 'error'
        ? (att.error || '读取失败')
        : summaryOf(att);
    main.append(el('span', { class: 'agent-attach-meta ellipsis' }, meta));
    const spinner = el('span', { class: 'agent-attach-spin' });
    if (att.status === 'reading') spinner.innerHTML = ic('loading', 12);
    const del = el('button', { type: 'button', class: 'agent-attach-del', title: '移除' });
    del.innerHTML = ic('x', 10);
    del.addEventListener('click', () => { pendingAttachments.splice(i, 1); renderAttachments(); });
    card.append(iconBox, main, spinner, del);
    els.attachments.append(card);
  });
}

function downscaleImage(dataUrl, maxDim = 1280, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        if (scale >= 1 && dataUrl.length < 500000) { resolve(dataUrl); return; }
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/** 支持：图片 / PDF / DOCX / PPTX / 文本，逐项解析并显示进度 */
async function addAttachmentFiles(files) {
  for (const file of files) {
    if (pendingAttachments.length >= MAX_ATTACH) { ctxRef.toast.warn('最多附加 ' + MAX_ATTACH + ' 个文件'); break; }
    if (file.size > 30 * 1024 * 1024) { ctxRef.toast.warn(file.name + ' 超过 30MB，请压缩后再试'); continue; }
    const isImage = (file.type || '').startsWith('image/');
    const ext = fileExt(file.name);
    if (!isImage && !ACCEPT.split(',').some((x) => x.trim() === '.' + ext)) {
      ctxRef.toast.warn('暂不支持 ' + (ext ? '.' + ext : '该类型') + '，可上传图片 / PDF / DOCX / PPTX / 文本');
      continue;
    }
    const att = {
      id: 'att-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      name: file.name,
      size: file.size,
      ext,
      kind: isImage ? 'image' : 'doc',
      kindLabel: isImage ? '图片' : '',
      status: 'reading',
    };
    pendingAttachments.push(att);
    renderAttachments();
    try {
      if (isImage) {
        att.dataUrl = await downscaleImage(await readFileAsDataURL(file));
        att.status = 'ready';
        /* 同时存进工程素材，Agent 可以直接 deck_insert_image 引用 */
        try {
          const proj = ctxRef.store.get().project || {};
          if (proj.id && ctxRef.api && ctxRef.api.uploadAssetDataUrl) {
            const up = await ctxRef.api.uploadAssetDataUrl(proj.id, file.name || ('image-' + Date.now() + '.png'), att.dataUrl);
            if (up && up.url) att.asset = up.url;
          }
        } catch { /* 素材上传失败不影响附件发送 */ }
      } else {
        const parsed = await extractFile(file);
        Object.assign(att, parsed);
        if (parsed.error) { att.status = 'error'; att.error = parsed.error; }
        else att.status = 'ready';
        if (parsed.images && parsed.images.length) {
          att.scanImages = parsed.images;
          delete att.images;
        }
      }
    } catch (err) {
      att.status = 'error';
      att.error = err && err.message ? err.message : String(err);
    }
    renderAttachments();
  }
}

async function handleSend(brief) {
  if (!loop) return;
  if (loop.streaming) return;
  if (!projectOpen()) { ctxRef.toast.warn('打开一个工程后即可编辑'); return; }
  const active = resolveActive(ctxRef);
  if (!active.providerId || !active.model) {
    ctxRef.toast.warn('先配置模型：在设置里填写 API Key 并获取模型');
    openAISettings(active.providerId || undefined);
    return;
  }
  if (pendingAttachments.some((a) => a.status === 'reading')) {
    ctxRef.toast.warn('附件还在读取，请稍候');
    return;
  }
  const text = els.input.value.trim();
  const ready = pendingAttachments.filter((a) => a.status === 'ready');
  const images = [];
  const assetPaths = [];
  for (const att of ready) {
    if (att.kind === 'image' && att.dataUrl) images.push(att.dataUrl);
    if (att.kind === 'image' && att.asset) assetPaths.push(att.asset);
    if (att.scanImages && att.scanImages.length) images.push(...att.scanImages);
  }
  const docs = ready
    .filter((a) => a.kind === 'doc' && (a.text || a.scanImages))
    .map((a) => ({
      name: a.name,
      kindLabel: a.kindLabel || (a.ext || '').toUpperCase(),
      pages: a.pages || 0,
      text: a.text || '',
    }));
  if (!text && !images.length && !docs.length) { els.input.focus(); return; }
  els.input.value = '';
  autoGrowInput();
  pendingAttachments = [];
  renderAttachments();
  const res = await loop.send(text, images.slice(0, MAX_ATTACH), { brief: brief || undefined, docs, assetPaths });
  if (res && res.ok === false && res.error) {
    ctxRef.toast.warn(res.error);
    if (!els.input.value) { els.input.value = text; autoGrowInput(); }
  }
}

async function doSend(payload) {
  if (!projectOpen()) { ctxRef.toast.warn('打开一个工程后即可编辑'); return { ok: false, error: '请先打开工程' }; }
  if (!panelOpen()) setOpen(true, { focus: false });
  if (typeof payload === 'string') { els.input.value = payload; autoGrowInput(); return handleSend(); }
  if (payload && typeof payload === 'object') {
    if (payload.text) els.input.value = String(payload.text);
    if (payload.images) {
      pendingAttachments = payload.images
        .filter((x) => typeof x === 'string')
        .slice(0, MAX_ATTACH)
        .map((src, i) => ({ id: 'att-img-' + i, kind: 'image', name: '图片 ' + (i + 1), size: 0, ext: '', dataUrl: src, status: 'ready' }));
      renderAttachments();
    }
    if (Array.isArray(payload.docs)) {
      /* 程序化发送：文档以 {name, text} 形式直接带上 */
      pendingAttachments = pendingAttachments.concat(payload.docs.filter((d) => d && d.text).slice(0, MAX_ATTACH).map((d, i) => ({
        id: 'att-doc-' + i, kind: 'doc', name: d.name || '文档 ' + (i + 1), size: 0, ext: fileExt(d.name || ''),
        kindLabel: d.kindLabel || '文档', text: String(d.text), pages: d.pages || 0, status: 'ready',
      })));
      renderAttachments();
    }
    return handleSend(payload.brief);
  }
  return null;
}

function doNewChat() {
  closeMenus();
  if (!loop) return;
  const run = () => { loop.newChat(); updateFoldNote(0); ctxRef.toast.ok('已开始新会话'); };
  if (!loop.getState().messages.length) { run(); return; }
  ctxRef.dialog.confirm('清空当前会话的对话记录？', { title: '新会话', okLabel: '清空' }).then((ok) => { if (ok) run(); });
}

/* ---------- 空状态 ---------- */

/** 空状态里的「一句话开演」：只填主题，自动生成整套 */
function buildQuickCreate() {
  const dirSel = h('select', { class: 'ag-create-select', 'data-tip': '视觉方向' },
    h('option', { value: 'auto' }, '方向：自动匹配'),
    ...ART_DIRECTIONS.map((d) => h('option', { value: d.id }, d.name)));
  const pageSel = h('select', { class: 'ag-create-select', 'data-tip': '页数' },
    ...[6, 8, 10, 12].map((n) => h('option', { value: String(n) }, n + ' 页')));
  pageSel.value = '8';
  const input = h('input', {
    class: 'ag-create-input',
    type: 'text',
    placeholder: '一句话主题：给一款咖啡做品牌提案…',
    maxlength: '200',
  });
  const btn = h('button', { type: 'button', class: 'btn btn--primary ag-create-btn' }, '生成');
  const submit = () => {
    const topic = input.value.trim();
    if (topic.length < 2) { input.focus(); ctxRef.toast.warn('先写一句主题'); return; }
    const brief = buildCreationBrief({
      topic,
      directionId: dirSel.value === 'auto' ? '' : dirSel.value,
      sceneId: '',
      pages: Number(pageSel.value) || 8,
    });
    input.value = '';
    doSend({ text: brief.display, brief: brief.brief });
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
  });
  return h('div', { class: 'ag-create' },
    h('div', { class: 'ag-create-head' },
      h('span', { class: 'ag-create-kicker', html: ic('sparkles', 12) }, h('span', null, '一句话开演')),
      h('span', { class: 'ag-create-hint' }, '自动排页 · 自动配色 · 自动动效')),
    h('div', { class: 'ag-create-row' }, input, btn),
    h('div', { class: 'ag-create-opts' }, dirSel, pageSel));
}

function buildEmptyState() {
  const wrap = el('div', { class: 'agent-empty' });
  els.empty = wrap;
  const actions = [
    ['layout', '读取这一页并总结', '先看版式、文字与现有动效，再给建议', '读取当前页的完整结构与动画，告诉我这一页的视觉逻辑和可以改进的地方。'],
    ['film', '统一整册动效节奏', '把逐页动效整理成一套节奏', '读取整册的切换与动效，统一成一套节奏（入场/强调/退场），不要逐页堆效果。'],
    ['frame', '检查排版与遮挡', '找出版式问题和拥挤区域', '检查当前页的排版：元素是否重叠、文字是否溢出、留白是否失衡，并直接修正。'],
    ['wand', '重做这一页的视觉', '保持内容，重做版式', '保持内容不变，按当前风格重做这一页的版式与层级，让它更像一套成熟的设计。'],
  ];
  const render = () => {
    wrap.replaceChildren();
    if (!projectOpen()) {
      wrap.append(el('div', { class: 'ag-empty-kicker' }, 'AGENT'));
      wrap.append(el('h2', { class: 'ag-empty-title' }, '打开一个工程'));
      wrap.append(el('p', { class: 'ag-empty-sub' }, '在文件库里打开或新建工程后，Agent 可以直接读取页面、改 DOM、调时间线。'));
      return;
    }
    const snap = ctxRef.store.get();
    const proj = snap.project || {};
    const deck = snap.deck || {};
    wrap.append(el('div', { class: 'ag-empty-kicker' }, 'AGENT · READY'));
    wrap.append(el('h2', { class: 'ag-empty-title' }, '在「' + (proj.name || '当前工程') + '」里做什么？'));
    const meta = [];
    if (deck.total) meta.push('第 ' + ((deck.current || 0) + 1) + '/' + deck.total + ' 页');
    if (snap.selection) meta.push('已选中元素');
    meta.push('所有功能都有接口');
    wrap.append(el('div', { class: 'ag-empty-meta' }, meta.join('  ·  ')));
    wrap.append(buildQuickCreate());

    const list = el('div', { class: 'ag-empty-actions' });
    for (const [iconName, title, desc, prompt] of actions) {
      const row = el('button', { type: 'button', class: 'ag-action' },
        el('span', { class: 'ag-action-ic', html: ic(iconName, 15) }),
        el('span', { class: 'ag-action-text' },
          el('span', { class: 'ag-action-title' }, title),
          el('span', { class: 'ag-action-desc' }, desc)),
        el('span', { class: 'ag-action-arrow', html: ic('arrow-right', 14) }));
      row.addEventListener('click', () => {
        els.input.value = prompt;
        autoGrowInput();
        els.input.focus();
      });
      list.append(row);
    }
    wrap.append(list);
    const caps = el('div', { class: 'ag-caps' }, el('b', {}, '可直接改'));
    ['文字', '样式', '布局', '动效', '时间线', '点击交互', '网页代码', '页面结构'].forEach((t) => caps.append(el('span', {}, t)));
    wrap.append(caps);
    wrap.append(el('div', { class: 'ag-empty-hint' }, '直接描述要改什么；输入 ', el('code', {}, '/'), ' 查看全部命令接口'));
  };
  render();
  els.renderEmpty = render;
  return wrap;
}

/* ---------- 任务列表（输入框上方的计划坞） ---------- */

function buildPlanDock() {
  const dock = el('div', { class: 'agent-plan-dock hidden' });
  const head = el('button', { type: 'button', class: 'agent-plan-head' });
  const iconBox = el('span', { class: 'agent-plan-ic' });
  iconBox.innerHTML = ic('list-ordered', 13);
  const title = el('span', { class: 'agent-plan-title' }, '任务');
  const now = el('span', { class: 'agent-plan-now ellipsis' });
  const count = el('span', { class: 'agent-plan-count' }, '');
  const chev = el('span', { class: 'agent-plan-chev' });
  chev.innerHTML = ic('chevron-down', 13);
  head.append(iconBox, title, now, count, chev);
  const body = el('div', { class: 'agent-plan-list hidden' });
  dock.append(head, body);
  head.addEventListener('click', () => {
    const open = !dock.classList.contains('is-open');
    dock.classList.toggle('is-open', open);
    body.classList.toggle('hidden', !open);
  });
  els.planDock = dock;
  els.planList = body;
  els.planNow = now;
  els.planCount = count;
  return dock;
}

function hidePlan() {
  if (!els.planDock) return;
  els.planDock.classList.add('hidden');
  els.planDock.classList.remove('is-open', 'is-done');
  if (els.planList) { els.planList.replaceChildren(); els.planList.classList.add('hidden'); }
  if (els.planNow) els.planNow.textContent = '';
  if (els.planCount) els.planCount.textContent = '';
  planDoneTimer = 0;
}

function renderPlan(plan) {
  if (!els.planDock) return;
  if (!Array.isArray(plan) || !plan.length) { hidePlan(); return; }
  const done = plan.filter((p) => p.status === 'done').length;
  const running = plan.find((p) => p.status === 'running');
  const allDone = done === plan.length;

  els.planDock.classList.remove('hidden');
  els.planDock.classList.toggle('is-done', allDone);
  els.planCount.textContent = done + ' / ' + plan.length;
  els.planNow.textContent = allDone ? '已完成' : (running ? running.title : '');

  els.planList.replaceChildren(...plan.map((step) => el('div', { class: 'agent-plan-step is-' + (step.status || 'pending') },
    el('span', { class: 'agent-plan-check', html: ic(step.status === 'done' ? 'check' : step.status === 'running' ? 'loading' : 'dot', 12) }),
    el('span', { class: 'agent-plan-text' }, step.title))));

  if (!els.planDock.classList.contains('is-open')) {
    els.planDock.classList.add('is-open');
    els.planList.classList.remove('hidden');
  }
  if (allDone && !planDoneTimer) {
    planDoneTimer = setTimeout(() => {
      planDoneTimer = 0;
      if (!els.planDock || els.planDock.classList.contains('hidden')) return;
      els.planDock.classList.remove('is-open');
      els.planList.classList.add('hidden');
    }, 1800);
  }
  scrollIfPinned();
}

/* ---------- 上下文用量条（输入框上方） ---------- */

function fmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function buildCtxBar() {
  const bar = el('div', { class: 'agent-ctxbar' });
  const meter = el('span', { class: 'agent-ctx-meter' }, el('i'));
  const label = el('span', { class: 'agent-ctx-label' }, '上下文 —');
  const fold = el('span', { class: 'agent-ctx-fold hidden' });
  const btn = el('button', { type: 'button', class: 'agent-ctx-btn', 'data-tip': '上下文明细' });
  btn.innerHTML = ic('info', 12);
  const detail = el('div', { class: 'agent-ctx-detail hidden' });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (detail.classList.contains('hidden')) { paintCtxDetail(); detail.classList.remove('hidden'); }
    else detail.classList.add('hidden');
  });
  /* 点外部 / Esc 关闭明细 */
  document.addEventListener('pointerdown', (e) => {
    if (detail.classList.contains('hidden')) return;
    if (bar.contains(e.target)) return;
    detail.classList.add('hidden');
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !detail.classList.contains('hidden')) detail.classList.add('hidden');
  });
  bar.append(meter, label, fold, el('span', { class: 'grow' }), btn, detail);
  els.ctxBar = bar;
  els.ctxLabel = label;
  els.ctxMeter = meter.firstChild;
  els.ctxFold = fold;
  els.ctxDetail = detail;
  return bar;
}

function updateContextMeter(context) {
  if (!els.ctxLabel) return;
  const ctx = context || (loop && loop.getState ? loop.getState().context : null);
  if (!ctx) {
    els.ctxLabel.textContent = '上下文 —';
    els.ctxLabel.classList.add('is-empty');
    if (els.ctxMeter) els.ctxMeter.style.width = '0%';
    if (els.ctxFold) els.ctxFold.classList.add('hidden');
    return;
  }
  const used = Number(ctx.tokens) || 0;
  const budget = Number(ctx.budget) || 0;
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
  els.ctxLabel.classList.remove('is-empty');
  els.ctxLabel.textContent = '上下文 ' + fmtTokens(used) + ' / ' + fmtTokens(budget) + ' · ' + pct + '%';
  if (els.ctxMeter) {
    els.ctxMeter.style.width = Math.max(2, Math.min(100, pct)) + '%';
    els.ctxMeter.dataset.level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low';
  }
  if (els.ctxFold) {
    const folded = Number(ctx.folded) || 0;
    els.ctxFold.classList.toggle('hidden', folded <= 0);
    els.ctxFold.textContent = folded > 0 ? '已折叠 ' + folded + ' 条' : '';
  }
  if (els.ctxDetail && !els.ctxDetail.classList.contains('hidden')) paintCtxDetail(ctx);
}

function paintCtxDetail(context) {
  if (!els.ctxDetail) return;
  const ctx = context || (loop && loop.getState ? loop.getState().context : null) || {};
  const st = loop && loop.getState ? loop.getState() : {};
  const usage = st.usage || {};
  let toolTokens = 0;
  let toolCount = 0;
  try {
    const defs = getToolDefinitionsForPermission(permission, { webSearch });
    toolCount = defs.length;
    toolTokens = estimateTokens(JSON.stringify(defs));
  } catch { /* ignore */ }
  const rows = [
    ['用量', fmtTokens(ctx.tokens) + ' / ' + fmtTokens(ctx.budget) + ' · ' + (ctx.percent || 0) + '%'],
    ['模型窗口', ctx.limit ? fmtTokens(ctx.limit) + ' tokens' : '—'],
    ['系统提示', ctx.systemTokens ? fmtTokens(ctx.systemTokens) + ' tokens' : '—'],
    ['工具定义', toolTokens ? fmtTokens(toolTokens) + ' tokens · ' + toolCount + ' 个' : '—'],
    ['消息', (ctx.messages || 0) + ' 条' + (ctx.folded ? ' · 折叠 ' + ctx.folded : '')],
    ['上次请求', usage && usage.prompt_tokens ? fmtTokens(usage.prompt_tokens) + ' 输入 / ' + fmtTokens(usage.completion_tokens) + ' 输出' : '—'],
  ];
  els.ctxDetail.replaceChildren(...rows.map(([k, v]) => el('div', { class: 'agent-ctx-row' },
    el('span', { class: 'agent-ctx-k' }, k),
    el('span', { class: 'agent-ctx-v' }, v))));
}

/* ---------- 斜杠命令（所有 UI 功能的接口） ---------- */

function hideSlash() {
  if (els.slash) els.slash.classList.add('hidden');
  slashItems = [];
}

function updateSlash() {
  if (!els.slash || !ctxRef) return;
  const value = String(els.input.value || '');
  const m = /^\/([^\s]*)$/.exec(value);
  if (!m || !projectOpen()) { hideSlash(); return; }
  const kw = m[1].toLowerCase();
  const all = ctxRef.bus.listCommands ? ctxRef.bus.listCommands() : [];
  slashItems = all
    .filter((c) => c.label && c.group !== '内部')
    .filter((c) => {
      const hay = (c.name + ' ' + (c.label || '') + ' ' + (c.group || '')).toLowerCase();
      return !kw || hay.includes(kw);
    })
    .filter((c) => !/^(app\.(undo|redo|save|back|commandPalette)|agent\.)/.test(c.name))
    .slice(0, 8);
  if (!slashItems.length) { hideSlash(); return; }
  slashIndex = Math.min(slashIndex, slashItems.length - 1);
  paintSlash();
  els.slash.classList.remove('hidden');
}

function paintSlash() {
  if (!els.slash) return;
  els.slash.replaceChildren();
  slashItems.forEach((cmd, i) => {
    const row = el('button', { type: 'button', class: 'agent-slash-item' + (i === slashIndex ? ' is-active' : '') },
      el('code', {}, cmd.name),
      el('span', { class: 'agent-slash-label' }, cmd.label || ''),
      el('span', { class: 'agent-slash-group' }, cmd.group || ''));
    row.addEventListener('pointerdown', (e) => { e.preventDefault(); runSlash(cmd); });
    els.slash.append(row);
  });
}

async function runSlash(cmd) {
  if (!cmd) return;
  hideSlash();
  els.input.value = '';
  autoGrowInput();
  const res = await ctxRef.bus.runCommand(cmd.name, {}).catch((err) => ({ ok: false, error: err?.message || String(err) }));
  if (res && res.ok === false) ctxRef.toast.warn('命令失败：' + (res.error || cmd.name));
  else ctxRef.toast.ok('已执行 ' + (cmd.label || cmd.name));
}

/* ---------- 骨架 ---------- */

function buildSkeleton() {
  const inner = el('div', { class: 'agent-inner' });

  /* header：只保留标题 + 操作 */
  const head = el('header', { class: 'agent-head' });
  const brand = el('div', { class: 'agent-brand' });
  const logo = el('span', { class: 'agent-logo', html: ic('terminal', 14) });
  brand.append(logo, el('span', { class: 'agent-title' }, 'Agent'));

  const actions = el('div', { class: 'agent-head-actions' });
  els.historyBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-head-btn', 'data-tip': '历史消息' });
  els.historyBtn.innerHTML = ic('history', 16);
  els.historyCount = el('span', { class: 'agent-history-count hidden' }, '0');
  els.historyBtn.append(els.historyCount);
  els.historyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenuKind === 'history') { closeMenus(); return; }
    openHistoryMenu();
  });
  const newBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-head-btn', 'data-tip': '新会话' });
  newBtn.innerHTML = ic('plus', 16);
  newBtn.addEventListener('click', () => doNewChat());
  const settingsBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-head-btn', 'data-tip': 'AI 设置' });
  settingsBtn.innerHTML = ic('settings', 16);
  settingsBtn.addEventListener('click', () => openAISettings());
  els.collapseToolsBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-head-btn', 'data-tip': '收起所有工具调用 / 思考过程' });
  els.collapseToolsBtn.innerHTML = ic('chevron-up', 16);
  els.collapseToolsBtn.addEventListener('click', () => toggleAllDetails());
  const collapseBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-head-btn', 'data-tip': '收起 Agent|Ctrl+Shift+E' });
  collapseBtn.innerHTML = ic('chevron-right', 16);
  collapseBtn.addEventListener('click', () => setOpen(false));
  actions.append(els.historyBtn, els.collapseToolsBtn, newBtn, settingsBtn, collapseBtn);
  head.append(brand, h('span', { class: 'grow' }), actions);

  const contextBar = el('div', { class: 'agent-context' }, '打开一个工程开始');
  els.contextBar = contextBar;

  /* 消息区 */
  const threadWrap = el('div', { class: 'agent-thread-wrap' });
  els.thread = el('div', { class: 'agent-thread', role: 'log', 'aria-live': 'polite' });
  els.foldNote = el('div', { class: 'agent-fold-note hidden' });
  els.empty = buildEmptyState();
  els.thread.append(els.empty);
  els.scrollBtn = el('button', { type: 'button', class: 'agent-scroll-btn', 'data-tip': '回到底部' });
  els.scrollBtn.innerHTML = ic('arrow-down', 14);
  els.scrollBtn.addEventListener('click', () => scrollToBottom(true));
  threadWrap.append(els.thread, els.scrollBtn);
  els.thread.addEventListener('scroll', () => {
    els.scrollBtn.classList.toggle('is-visible', !scrollPinned());
  }, { passive: true });

  /* composer：输入框在上，工具条在下 */
  const composer = el('div', { class: 'agent-composer' });
  els.composer = composer;
  els.attachments = el('div', { class: 'agent-attachments hidden' });

  const inputBox = el('div', { class: 'agent-input-box' });
  const slash = el('div', { class: 'agent-slash hidden' });
  els.slash = slash;
  inputBox.append(slash);
  els.input = el('textarea', {
    class: 'agent-textarea',
    rows: '1',
    placeholder: '描述你想怎么改…',
    'aria-label': '给 Agent 的消息',
  });
  els.input.addEventListener('input', () => { autoGrowInput(); updateSlash(); });
  els.input.addEventListener('keydown', (e) => {
    if (els.slash && !els.slash.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; paintSlash(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; paintSlash(); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return; }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); runSlash(slashItems[slashIndex]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  const toolbar = el('div', { class: 'agent-toolbar' });

  /* 模型选择器 */
  els.modelBtn = el('button', { type: 'button', class: 'agent-chip-btn agent-model', 'data-tip': '选择模型' });
  const modelIcon = el('span', { class: 'agent-chip-icon', html: ic('cpu', 13) });
  els.modelName = el('span', { class: 'agent-model-name ellipsis' }, '未配置模型');
  const modelChev = el('span', { class: 'agent-chip-chev', html: ic('chevron-down', 12) });
  els.modelBtn.append(modelIcon, els.modelName, modelChev);
  els.modelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenuKind === 'model') { closeMenus(); return; }
    const active = resolveActive(ctxRef);
    const providers = getProviders(ctxRef);
    const hasKey = providers.some((p) => p.keySet);
    if (!active.providerId || !active.model || !hasKey) { openAISettings(active.providerId || undefined); return; }
    openModelMenu();
  });

  /* 思考强度 */
  els.effortBtn = el('button', { type: 'button', class: 'agent-chip-btn agent-effort', 'data-tip': '思考强度' });
  els.effortBtn.innerHTML = ic('brain', 13);
  els.effortLabel = el('span', { class: 'agent-chip-label' }, '自动');
  els.effortBtn.append(els.effortLabel);
  els.effortBtn.addEventListener('click', (e) => { e.stopPropagation(); if (openMenuKind === 'effort') { closeMenus(); return; } openEffortMenu(); });

  /* 工作权限 */
  els.permBtn = el('button', { type: 'button', class: 'agent-chip-btn agent-perm', 'data-tip': '工作权限', 'data-perm': permission });
  els.permIcon = el('span', { class: 'agent-chip-icon', html: ic('edit', 13) });
  els.permLabel = el('span', { class: 'agent-chip-label' }, permissionMeta(permission).label);
  els.permBtn.append(els.permIcon, els.permLabel);
  els.permBtn.addEventListener('click', (e) => { e.stopPropagation(); if (openMenuKind === 'permission') { closeMenus(); return; } openPermissionMenu(); });

  /* 联网搜索 + 设置 */
  els.webBtn = el('button', { type: 'button', class: 'agent-chip-btn agent-web', 'data-tip': '联网搜索' });
  els.webIcon = el('span', { class: 'agent-chip-icon', html: ic('globe', 13) });
  els.webLabel = el('span', { class: 'agent-chip-label' }, '联网');
  els.webBtn.append(els.webIcon, els.webLabel);
  els.webBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setWebSearch(!webSearch, { silent: false });
  });
  els.webSettingsBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-web-settings', 'data-tip': '联网搜索设置' });
  els.webSettingsBtn.innerHTML = ic('settings', 15);
  els.webSettingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openSearchSettings(ctxRef).catch((err) => ctxRef.toast.error('打开联网设置失败：' + (err?.message || err)));
  });

  /* 附件 + 发送 */
  els.attachBtn = el('button', { type: 'button', class: 'icon-btn icon-btn--sm agent-attach-btn', 'data-tip': '附加图片 / PDF / Word / PPT' });
  els.attachBtn.innerHTML = ic('image-plus', 16);
  const fileInput = el('input', { type: 'file', accept: ACCEPT, multiple: '', class: 'hidden' });
  fileInput.addEventListener('change', async () => {
    if (fileInput.files && fileInput.files.length) await addAttachmentFiles([...fileInput.files]);
    fileInput.value = '';
  });
  els.attachBtn.addEventListener('click', () => fileInput.click());

  els.sendBtn = el('button', { type: 'button', class: 'agent-send', 'data-tip': '发送|Enter' });
  els.sendBtn.innerHTML = ic('send', 16);
  els.sendBtn.addEventListener('click', () => {
    if (loop && loop.streaming) { loop.stop(); return; }
    handleSend();
  });

  toolbar.append(els.modelBtn, els.effortBtn, els.permBtn, els.webBtn, els.webSettingsBtn, el('span', { class: 'grow' }), els.attachBtn, els.sendBtn);
  inputBox.append(els.input, toolbar);
  inputBox.addEventListener('dragover', (e) => { e.preventDefault(); inputBox.classList.add('is-drag'); });
  inputBox.addEventListener('dragleave', () => inputBox.classList.remove('is-drag'));
  inputBox.addEventListener('drop', async (e) => {
    e.preventDefault();
    inputBox.classList.remove('is-drag');
    const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
    if (files.length) await addAttachmentFiles(files);
  });

  composer.append(els.attachments, tickerBox(), inputBox, fileInput);
  inner.append(head, contextBar, threadWrap, buildPlanDock(), buildCtxBar(), composer);
  return inner;
}

/* 折叠提示（有折叠时才显示，不是常驻 hint） */
function tickerBox() {
  return el('div', { class: 'agent-ticker' }, els.foldNote);
}

/* ---------- 循环 hooks ---------- */

function buildHooks() {
  return {
    onUserMessage(msg) {
      closeMenus();
      currentAssistant = null;
      lastAssistant = null;
      hidePlan();
      renderUserMessage(msg);
      updateHistoryCount();
      scrollToBottom(false);
      els.scrollBtn.classList.remove('is-visible');
    },
    onAssistantStart() {
      if (!currentAssistant) {
        currentAssistant = createAssistantView({ streaming: true });
        els.thread.append(currentAssistant.el);
        lastAssistant = currentAssistant;
      }
      currentAssistant.beginRound();
      updateEmptyVisibility();
      scrollToBottom(false);
    },
    onAssistantDelta(text) {
      if (currentAssistant) currentAssistant.setContent(text);
      scrollIfPinned();
    },
    onReasoningDelta(text) {
      if (currentAssistant) currentAssistant.setReasoning(text);
    },
    onToolCalls(calls) {
      if (currentAssistant) currentAssistant.setToolCalls(calls);
      scrollIfPinned();
    },
    onAssistantEnd(msg, meta) {
      if (currentAssistant) {
        currentAssistant.noteRoundEnd(msg, meta || {});
        lastAssistant = currentAssistant;
      }
      updateEmptyVisibility();
      scrollIfPinned();
      updateHistoryCount();
    },
    onToolStart(call) {
      if (lastAssistant) lastAssistant.toolStart(call);
      scrollIfPinned();
    },
    onToolResult(call, result) {
      if (lastAssistant) lastAssistant.toolResult(call, result);
      syncUndoButtons();
      scrollIfPinned();
    },
    onUsage() { updateContextMeter(); },
    onContext(context) { updateContextMeter(context); },
    onContinuation(info) {
      if (currentAssistant) currentAssistant.continuation(info || {});
      scrollIfPinned();
    },
    onStatus() { /* 状态通过发送/停止按钮与流式光标表达 */ },
    onStreamingChange(streaming) {
      syncSendState();
      if (!streaming && currentAssistant) {
        const view = currentAssistant;
        currentAssistant = null;
        view.finish({}, {});
        lastAssistant = view;
      }
      if (!streaming) updateEmptyVisibility();
    },
    onError(err) {
      if (currentAssistant) {
        const view = currentAssistant;
        currentAssistant = null;
        view.finish({}, {});
        lastAssistant = view;
      }
      lastAssistant = null;
      renderErrorCard(err && err.message ? err : err && err.error ? err.error : err);
      updateEmptyVisibility();
      updateHistoryCount();
      scrollIfPinned();
    },
    onAborted() { /* 保留已生成内容 */ },
    onSessionLoaded({ messages, skills, catalog }) {
      if (Array.isArray(catalog) && catalog.length) skillsCatalog = catalog;
      pendingAttachments = [];
      renderAttachments();
      renderSession(messages, skills);
      if (els.renderEmpty) els.renderEmpty();
      updateEmptyVisibility();
      updateHistoryCount();
      updateFoldNote(loop ? loop.getState().foldedCount : 0);
    },
    onSessionReset() {
      els.thread.replaceChildren();
      els.foldNote.classList.add('hidden');
      pendingAttachments = [];
      renderAttachments();
      hidePlan();
      updateContextMeter(null);
      if (els.renderEmpty) els.renderEmpty();
      els.thread.append(els.empty);
      currentAssistant = null;
      lastAssistant = null;
      updateEmptyVisibility();
      updateHistoryCount();
      updateFoldNote(0);
    },
    onBlocked(message) {
      ctxRef.toast.warn(message || '打开一个工程后即可编辑');
    },
    onNeedSetup(message) {
      ctxRef.toast.warn(message || '请先配置模型');
      openAISettings();
    },
    onCompact(count) {
      updateFoldNote(count);
    },
    onSaved() { /* 静默 */ },
    onSaveError(err) {
      console.warn('[agent] 会话保存失败', err);
    },
    onSkillsChange() { /* 技能不再常驻显示 */ },
    onBeforeRetry() {
      clearAfterLastUser();
    },
    onDone() { updateFoldNote(loop ? loop.getState().foldedCount : 0); },
  };
}

function clearAfterLastUser() {
  if (!els.thread) return;
  const users = [...els.thread.querySelectorAll('.agent-msg--user')];
  const last = users[users.length - 1];
  for (const errorCard of [...els.thread.querySelectorAll('.agent-error')]) errorCard.remove();
  if (!last) return;
  let node = last.nextElementSibling;
  while (node) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
}

/* ---------- 初始化 ---------- */

export async function init(ctx) {
  ctxRef = ctx;
  const panel = document.getElementById(PANEL_ID);
  if (!panel) {
    console.warn('[agent] 未找到 #agent-panel 挂载点');
    return;
  }

  ctxRef.store.update((s) => { if (s.agent.open === undefined) s.agent.open = false; });
  const app = appRoot();
  if (app && !app.dataset.agent) app.dataset.agent = 'closed';

  effort = REASONING_EFFORTS.some((e) => e.id === readLocal(LS_EFFORT, 'auto')) ? readLocal(LS_EFFORT, 'auto') : 'auto';
  permission = normalizePermission(readLocal(LS_PERMISSION, 'edit'));
  webSearch = readLocal(LS_WEBSEARCH, '0') === '1';

  panel.replaceChildren(buildSkeleton());
  attachMarkdownActions(els.thread);

  loop = createAgentLoop(ctxRef, buildHooks());
  loop.setOptions({ permission, reasoningEffort: effort, webSearch });

  refreshComposer();
  syncSendState();
  autoGrowInput();
  updateContextBar();

  /* 命令 */
  ctxRef.bus.registerCommand('app.toggleAgent', () => toggle());
  ctxRef.bus.registerCommand('agent.toggle', () => toggle());
  ctxRef.bus.registerCommand('agent.newChat', () => doNewChat());
  ctxRef.bus.registerCommand('agent.stop', () => (loop ? loop.stop() : { ok: false }));
  ctxRef.bus.registerCommand('agent.send', (payload) => {
    doSend(payload).catch((err) => console.warn('[agent] 发送失败', err));
    return { ok: true };
  });
  ctxRef.bus.registerCommand('agent.toggleSkill', (payload) => {
    if (!loop) return { ok: false };
    const id = typeof payload === 'string' ? payload : payload && (payload.id || payload.skillId);
    const next = loop.toggleSkill(id);
    return { ok: true, skills: next };
  });
  ctxRef.bus.registerCommand('agent.openSettings', () => {
    openAISettings().catch((err) => console.warn('[agent] 打开设置失败', err));
    return { ok: true };
  });
  ctxRef.bus.registerCommand('agent.openSearchSettings', () => {
    openSearchSettings(ctxRef).catch((err) => console.warn('[agent] 打开联网设置失败', err));
    return { ok: true };
  });
  ctxRef.bus.registerCommand('agent.openSkills', () => {
    openSkillsManager();
    return { ok: true };
  });

  /* 事件 */
  ctxRef.bus.on('project:open', (data) => {
    const project = data && (data.project || data);
    if (!project || !project.id) return;
    if (els.renderEmpty) els.renderEmpty();
    refreshComposer();
    updateContextBar();
    loop.load(project.id).catch((err) => console.warn('[agent] 会话加载失败', err));
  });

  ctxRef.bus.on('project:close', () => {
    if (loop) loop.load(null);
    refreshComposer();
    if (els.renderEmpty) els.renderEmpty();
  });

  ctxRef.bus.on('route:change', (route) => {
    refreshComposer();
    updateContextBar();
    if (els.renderEmpty) els.renderEmpty();
    if (route && route.name === 'library' && loop) loop.load(null);
  });

  ctxRef.bus.on('history:change', () => syncUndoButtons());
  ctxRef.bus.on('agent:plan', (data) => { if (data && data.plan) renderPlan(data.plan); });
  ctxRef.bus.on('selection:change', () => updateContextBar());
  ctxRef.bus.on('slide:change', () => updateContextBar());
  ctxRef.bus.on('deck:ready', () => updateContextBar());

  window.addEventListener('beforeunload', () => {
    try { loop && loop.flush(); } catch { /* ignore */ }
  });

  /* 技能目录 / 设置（异步，不阻塞面板） */
  loadCatalog(ctxRef).then((catalog) => {
    if (Array.isArray(catalog)) skillsCatalog = catalog;
  }).catch(() => { skillsCatalog = getCachedCatalog(); });

  loadSettings(ctxRef).then(() => refreshComposer()).catch(() => {});

  const snap = ctxRef.store.get();
  if (snap.project && snap.project.id && projectOpen()) {
    loop.load(snap.project.id).catch(() => {});
  } else {
    updateEmptyVisibility();
  }

  return { panel, loop };
}

export default { init };




