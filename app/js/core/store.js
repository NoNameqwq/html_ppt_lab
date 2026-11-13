/* 全局状态 + 历史记录数据层 */

const initial = {
  route: { name: 'library', projectId: null },
  library: { projects: [], loading: false, query: '', error: null },
  project: null,
  deck: { ready: false, current: 0, total: 0, w: 1920, h: 1080, slides: [] },
  selection: null,
  ui: {
    theme: 'light',
    agentOpen: false,
    inspectorOpen: true,
    slidePanelOpen: true,
    zoom: 'fit',
    grid: false,
    rulers: false,
    activeTab: 'home',
    saving: 'saved',       // saved | saving | dirty | error
    savedAt: 0,
    lastError: null,
  },
  history: { ops: [], cursor: 0 },
  agent: {
    open: false,
    streaming: false,
    messages: [],
    skills: [],
    providerId: null,
    model: null,
    usage: null,
    status: 'idle',
    error: null,
  },
  settings: { providers: [], ui: {}, skillsCatalog: [], loaded: false },
};

const state = structuredClone(initial);
const subs = new Set();
let notifyScheduled = false;

function notify(patch) {
  if (notifyScheduled) return;
  notifyScheduled = true;
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const fn of [...subs]) {
      try { fn(state, patch); } catch (err) { console.error('[store] subscriber 错误', err); }
    }
  });
}

export const store = {
  get() { return state; },

  /** 浅合并顶层字段；嵌套对象请传完整对象或用 update */
  set(patch) {
    Object.assign(state, patch);
    notify(patch);
    return state;
  },

  /** 通过回调修改（可对嵌套字段赋值），完成后通知 */
  update(fn) {
    fn(state);
    notify({});
    return state;
  },

  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },

  reset(keep = {}) {
    const fresh = structuredClone(initial);
    for (const k of Object.keys(fresh)) if (!(k in keep)) state[k] = fresh[k];
    for (const [k, v] of Object.entries(keep)) state[k] = v;
    notify({});
  },

  /* ---------- 历史记录 ---------- */
  pushOp(op) {
    const h = state.history;
    h.ops = h.ops.slice(0, h.cursor);
    h.ops.push(op);
    h.cursor = h.ops.length;
    if (h.ops.length > 400) { h.ops = h.ops.slice(-400); h.cursor = h.ops.length; }
    notify({ history: h });
    return op;
  },

  setHistory(ops = [], cursor = ops.length) {
    state.history = { ops, cursor: Math.min(cursor, ops.length) };
    notify({ history: state.history });
  },

  canUndo() { return state.history.cursor > 0; },
  canRedo() { return state.history.cursor < state.history.ops.length; },
  undoOp() {
    if (!this.canUndo()) return null;
    const op = state.history.ops[state.history.cursor - 1];
    state.history.cursor -= 1;
    notify({ history: state.history });
    return op;
  },
  redoOp() {
    const h = state.history;
    if (h.cursor >= h.ops.length) return null;
    const op = h.ops[h.cursor];
    h.cursor += 1;
    notify({ history: h });
    return op;
  },
  truncateHistory(cursor) {
    state.history.ops = state.history.ops.slice(0, cursor);
    state.history.cursor = Math.min(state.history.cursor, state.history.ops.length);
    notify({ history: state.history });
  },
};

export default store;
