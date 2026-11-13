/* 历史记录面板：查看每次修改、单条撤回、回到任意时间点；history.open / revertTo / undo / redo 命令 */

import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { h, clamp, formatTime } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { icon } from '../ui/icons.js';

const TYPE_ICON = {
  text: 'type',
  html: 'type',
  style: 'sliders',
  attr: 'tag',
  move: 'move',
  resize: 'maximize',
  rotate: 'rotate',
  insert: 'plus',
  delete: 'trash',
  anim: 'zap',
  'slide-add': 'file-plus',
  'slide-delete': 'trash',
  'slide-move': 'drag',
  'slide-attrs': 'film',
  'slide-html': 'file-code',
  'deck-css': 'code',
  'deck-js': 'code',
  theme: 'palette',
  'deck-flags': 'droplet',
};

const TYPE_LABEL = {
  text: '文字',
  html: '内容',
  style: '样式',
  attr: '属性',
  move: '移动',
  resize: '尺寸',
  rotate: '旋转',
  insert: '插入',
  delete: '删除',
  anim: '动画',
  'slide-add': '新增页',
  'slide-delete': '删除页',
  'slide-move': '移动页',
  'slide-attrs': '页面属性',
  'slide-html': '页面内容',
  'deck-css': 'CSS',
  'deck-js': 'JS',
  theme: '主题',
  'deck-flags': '页面效果',
};

let ctx = null;
let bound = false;

/* ================= 初始化 ================= */

export async function init(context) {
  ctx = context;
  if (bound) return;
  bound = true;
  registerCommands();
}

function historyState() {
  const snapshot = ctx?.store?.get?.() || store.get();
  const history = snapshot.history || { ops: [], cursor: 0 };
  return { ops: Array.isArray(history.ops) ? history.ops : [], cursor: Number(history.cursor) || 0 };
}

function getBridge() {
  try { return ctx?.getEditor?.()?.bridge || null; } catch { return null; }
}

function refreshEditorUi() {
  const ed = ctx?.getEditor?.();
  try {
    ed?.markDirty?.();
    ed?.refreshDeckState?.();
    ed?.refresh?.();
  } catch { /* ignore */ }
}

/* ================= 游标回退 / 前进 ================= */

/** 把历史游标移动到 target（= 已应用的 op 数） */
async function revertToCursor(target) {
  const bridge = getBridge();
  if (!bridge?.ready) {
    toast('画布尚未就绪');
    return { ok: false };
  }
  const { ops, cursor } = historyState();
  const next = clamp(Math.round(Number(target) || 0), 0, ops.length);
  if (next === cursor) return { ok: true, cursor: next };
  try {
    if (next < cursor) {
      for (let c = cursor; c > next; c -= 1) {
        const op = ops[c - 1];
        if (!op) continue;
        await bridge.applyOp(op, 'undo');
      }
    } else {
      for (let c = cursor; c < next; c += 1) {
        const op = ops[c];
        if (!op) continue;
        await bridge.applyOp(op, 'redo');
      }
    }
  } catch (err) {
    console.error('[history] 回退失败', err);
    toast.error('回退失败：' + (err?.message || err));
    refreshEditorUi();
    return { ok: false, error: err?.message || String(err) };
  }
  store.update((s) => { s.history.cursor = next; });
  refreshEditorUi();
  return { ok: true, cursor: next };
}

/** 单条撤回：只撤销这一条 op，并把它从历史中移除 */
async function revertSingle(opIndex) {
  const bridge = getBridge();
  if (!bridge?.ready) {
    toast('画布尚未就绪');
    return { ok: false };
  }
  const { ops, cursor } = historyState();
  const index = Number(opIndex);
  if (!Number.isFinite(index) || index < 0 || index >= ops.length) return { ok: false };
  if (index >= cursor) {
    toast('这条修改还没有应用，无需撤回');
    return { ok: false };
  }
  const op = ops[index];
  try {
    await bridge.applyOp(op, 'undo');
  } catch (err) {
    toast.error('撤回失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  }
  store.update((s) => {
    const list = s.history.ops;
    if (list[index] && list[index].opId === op.opId) list.splice(index, 1);
    else {
      const found = list.findIndex((item) => item && item.opId === op.opId);
      if (found >= 0) list.splice(found, 1);
    }
    s.history.cursor = Math.max(0, Math.min(s.history.cursor - 1, s.history.ops.length));
  });
  refreshEditorUi();
  toast.ok('已撤回：' + (op.label || TYPE_LABEL[op.type] || '修改'));
  return { ok: true };
}

/* ================= 面板 ================= */

function openHistoryPanel() {
  const body = h('div', { class: 'history-panel' });
  let off = null;
  let closed = false;

  const render = () => { if (!closed) renderPanel(body); };
  render();
  off = bus.on('history:change', render);

  const done = ctx.dialog.open({
    title: '历史记录',
    sub: '每次修改都会记录；点击任意一条可以回到当时的状态',
    width: 'lg',
    body,
    actions: [
      { label: '撤销一步', kind: 'ghost', onClick: async () => { await bus.runCommand('app.undo'); return false; } },
      { label: '重做一步', kind: 'ghost', onClick: async () => { await bus.runCommand('app.redo'); return false; } },
      { label: '关闭', value: null, kind: 'primary' },
    ],
  });
  done.finally(() => {
    closed = true;
    try { off?.(); } catch { /* ignore */ }
  });
  return { ok: true };
}

function renderPanel(body) {
  const { ops, cursor } = historyState();
  body.innerHTML = '';
  body.append(buildToolbar(ops, cursor));
  if (!ops.length) {
    body.append(h('div', { class: 'history-empty' },
      h('span', { class: 'history-empty-icon', html: icon('history', 26) }),
      h('div', null, '还没有任何修改记录'),
      h('div', { class: 'history-empty-sub' }, '在画布上移动、改字、插入元素或修改样式后，这里会逐条记录')));
    return;
  }
  const list = h('div', { class: 'history-list' });
  const start = Math.max(0, ops.length - 240);
  for (let i = start; i < ops.length; i += 1) {
    list.append(buildRow(ops[i], i, cursor));
  }
  body.append(list);
  const foot = h('div', { class: 'history-foot' },
    h('span', null, `共 ${ops.length} 条记录`),
    h('span', { class: 'history-foot-hint' }, '灰色条目为已撤销，可点击重做'));
  body.append(foot);
}

function buildToolbar(ops, cursor) {
  const undoBtn = h('button', { class: 'btn btn--sm', title: '撤销一步 (Ctrl+Z)' },
    h('span', { class: 'history-btn-icon', html: icon('undo', 14) }), '撤销');
  undoBtn.addEventListener('click', () => bus.runCommand('app.undo'));
  if (!cursor) undoBtn.disabled = true;
  const redoBtn = h('button', { class: 'btn btn--sm', title: '重做一步 (Ctrl+Shift+Z)' },
    h('span', { class: 'history-btn-icon', html: icon('redo', 14) }), '重做');
  redoBtn.addEventListener('click', () => bus.runCommand('app.redo'));
  if (cursor >= ops.length) redoBtn.disabled = true;
  return h('div', { class: 'history-toolbar' },
    h('div', { class: 'history-stats' },
      h('span', { class: 'history-stat' }, h('b', null, String(cursor)), ' 已应用'),
      h('span', { class: 'history-stat history-stat--muted' }, h('b', null, String(Math.max(0, ops.length - cursor))), ' 可重做')),
    h('div', { class: 'grow' }),
    undoBtn,
    redoBtn);
}

function buildRow(op, index, cursor) {
  const applied = index < cursor;
  const label = op.label || TYPE_LABEL[op.type] || '修改';
  const typeLabel = TYPE_LABEL[op.type] || op.type;
  const source = op.source === 'agent' ? 'Agent' : op.source === 'import' ? '导入' : 'UI';
  const row = h('div', {
    class: 'history-row' + (applied ? ' is-applied' : ' is-future') + (index === cursor - 1 ? ' is-current' : ''),
    title: applied ? '点击回到这一步修改之后' : '点击重做到这一步',
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.history-row-action')) return;
    revertToCursor(index + 1);
  });

  const meta = [];
  if (op.slideIndex != null && op.slideIndex >= 0) meta.push('第 ' + (Number(op.slideIndex) + 1) + ' 页');
  if (op.elementId) meta.push(String(op.elementId));

  row.append(
    h('span', { class: 'history-dot' }),
    h('span', { class: 'history-time' }, formatTime(op.ts) || ''),
    h('span', { class: 'history-type-icon', html: icon(TYPE_ICON[op.type] || 'dot', 14) }),
    h('span', { class: 'history-main' },
      h('span', { class: 'history-label' }, label),
      h('span', { class: 'history-meta' }, [typeLabel, ...meta].join(' · '))),
    h('span', { class: 'history-source history-source--' + (op.source || 'ui') }, source),
  );

  if (applied) {
    const action = h('button', { class: 'history-row-action', title: '只撤回这一条', html: icon('undo', 13) });
    action.addEventListener('click', async (e) => {
      e.stopPropagation();
      await revertSingle(index);
    });
    row.append(action);
  } else {
    row.append(h('span', { class: 'history-future-tag' }, '可重做'));
  }
  return row;
}

/* ================= 命令注册 ================= */

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload || {}); } catch (err) {
      console.error('[history] 命令失败', name, err);
      toast.error('操作失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('history.open', { label: '历史记录', group: '历史', icon: 'history', shortcut: 'Ctrl+H' }, () => openHistoryPanel());

  reg('history.undo', { label: '撤销（历史）', group: '历史', icon: 'undo', shortcut: 'Ctrl+Z' }, () => bus.runCommand('app.undo'));
  reg('history.redo', { label: '重做（历史）', group: '历史', icon: 'redo', shortcut: 'Ctrl+Shift+Z' }, () => bus.runCommand('app.redo'));

  reg('history.revertTo', { label: '回到指定历史点', group: '历史', icon: 'clock' }, (payload) => {
    if (payload && payload.cursor != null) return revertToCursor(Number(payload.cursor));
    const index = Number(payload?.index);
    if (!Number.isFinite(index)) {
      toast('缺少要回退的目标');
      return { ok: false };
    }
    // 回退到「该条 op 已应用」的状态
    return revertToCursor(index + 1);
  });

  reg('history.list', { label: '查看历史记录数据', group: '历史', icon: 'list' }, () => {
    const { ops, cursor } = historyState();
    return { ok: true, ops, cursor };
  });
}
