/* deck iframe 的 postMessage RPC 客户端（父窗口侧）
 * 协议见 docs/SPEC.md §6 / §14：
 *   {type:'wpx:req', id, method, params}  →  {type:'wpx:res', id, ok, result|error}
 *   事件：{type:'wpx:event', event:'ready'|'slidechange'|'selectionchange'|'change'|'shortcut'|'save-request', data}
 */

import { bus } from '../core/bus.js';

const DEFAULT_TIMEOUT = 8000;
const READY_TIMEOUT = 15000;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 兼容位置参数与对象入参：pickParam(2,'index')→2；pickParam({index:2},'index')→2 */
function pickParam(value, ...keys) {
  if (isPlainObject(value)) {
    for (const key of keys) if (key in value) return value[key];
  }
  return value;
}

export class BridgeClient {
  constructor(iframe, options = {}) {
    this.iframe = iframe || null;
    this.origin = options.origin || location.origin;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this._seq = 0;
    this._pending = new Map();
    this._handlers = new Map();
    this._ready = false;
    this._readyWaiters = [];
    this._state = null;
    this._destroyed = false;
    this.latestOpId = null;
    this._onMessage = this._handleMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  /* ================= 生命周期 ================= */

  get ready() { return this._ready && !this._destroyed; }
  get state() { return this._state; }
  get destroyed() { return this._destroyed; }
  get editing() { return !!this._state?.editing; }
  get frameWindow() {
    try { return this.iframe?.contentWindow || null; } catch { return null; }
  }

  /** 设置 iframe 地址并等待 bridge ready；返回 ready 事件的 data */
  async load(src) {
    this._ready = false;
    this._state = null;
    if (!this.iframe) throw new Error('缺少 deck iframe');
    const readyPromise = this.waitReady(READY_TIMEOUT);
    if (src != null) this.iframe.src = src;
    return readyPromise;
  }

  /** 等待 bridge ready（可重复 await） */
  waitReady(timeout = READY_TIMEOUT) {
    if (this.ready) return Promise.resolve({ mode: 'edit', state: this._state });
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this._readyWaiters = this._readyWaiters.filter((w) => w !== waiter);
          reject(new Error('画布加载超时：等不到 bridge ready'));
        }, timeout),
      };
      this._readyWaiters.push(waiter);
    });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    window.removeEventListener('message', this._onMessage);
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('bridge 已销毁'));
    }
    this._pending.clear();
    for (const w of this._readyWaiters) {
      clearTimeout(w.timer);
      w.reject(new Error('bridge 已销毁'));
    }
    this._readyWaiters = [];
    this._ready = false;
    this._handlers.clear();
  }

  /* ================= RPC ================= */

  call(method, params = {}) {
    if (this._destroyed) return Promise.reject(new Error('bridge 已销毁'));
    const win = this.frameWindow;
    if (!win) return Promise.reject(new Error('画布尚未加载'));
    const id = `r${++this._seq}.${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`bridge 调用超时：${method}`));
      }, this.timeout);
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        win.postMessage({ type: 'wpx:req', id, method, params: params || {} }, this.origin);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** 允许失败的调用：失败返回 null（能力探测/非关键刷新用） */
  async tryCall(method, params = {}) {
    try { return await this.call(method, params); } catch { return null; }
  }

  /* ================= 事件 ================= */

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  _emit(eventName, data) {
    if (!eventName) return;
    if (eventName === 'ready') {
      this._ready = true;
      this._state = data?.state || null;
      const waiters = this._readyWaiters;
      this._readyWaiters = [];
      for (const w of waiters) { clearTimeout(w.timer); w.resolve(data); }
    }
    if (eventName === 'change' && data?.op?.opId) this.latestOpId = data.op.opId;
    if (eventName === 'shortcut') this._handleShortcut(data || {});
    bus.emit('bridge:event', { event: eventName, data });
    if (eventName === 'ready') bus.emit('bridge:ready', data);
    else bus.emit('bridge:' + eventName, data);
    const set = this._handlers.get(eventName);
    if (set) {
      for (const fn of [...set]) {
        try { fn(data); } catch (err) { console.error('[bridge] 事件处理失败:', eventName, err); }
      }
    }
  }

  _handleMessage(event) {
    if (this._destroyed) return;
    const win = this.frameWindow;
    if (!win || event.source !== win) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'wpx:res') { this._settle(data); return; }
    if (data.type === 'wpx:event') this._emit(data.event, data.data);
  }

  _settle(data) {
    const pending = this._pending.get(data.id);
    if (!pending) return;
    this._pending.delete(data.id);
    clearTimeout(pending.timer);
    if (data.ok) {
      pending.resolve(data.result);
      return;
    }
    const message = data.error?.message || `bridge 调用失败：${pending.method}`;
    const err = new Error(message);
    err.code = data.error?.code;
    err.method = pending.method;
    pending.reject(err);
  }

  /* 把 iframe 内按键转成父窗口命令（避免与父窗口 keydown 重复绑定） */
  _handleShortcut(data) {
    bus.emit('editor:shortcut', data);
    const key = String(data.key || '').toLowerCase();
    const ctrl = !!(data.ctrl || data.ctrlKey || data.meta || data.metaKey);
    const shift = !!(data.shift || data.shiftKey);
    const run = (name, payload) => { bus.runCommand(name, payload); };

    if (ctrl && key === 's') { run('app.save'); return; }
    if (ctrl && key === 'z') { run(shift ? 'app.redo' : 'app.undo'); return; }
    if (ctrl && key === 'y') { run('app.redo'); return; }
    if (ctrl && key === 'd') { run('edit.duplicate'); return; }
    if (ctrl && key === 'a') { run('edit.selectAll'); return; }
    if (ctrl && key === 'c') { run('edit.copy'); return; }
    if (ctrl && key === 'x') { run('edit.cut'); return; }
    if (ctrl && key === 'v') { run('edit.paste'); return; }
    if (ctrl && (key === '=' || key === '+')) { run('app.zoomIn'); return; }
    if (ctrl && key === '-') { run('app.zoomOut'); return; }
    if (ctrl && key === '0') { run('app.zoomReset'); return; }
    if (key === 'delete' || key === 'backspace') { run('edit.delete'); return; }
    if (key === 'escape') { bus.emit('editor:escape'); return; }
    if (key === 'f5') { run(shift ? 'app.presentCurrent' : 'app.present'); return; }

    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    const dir = arrows[key];
    if (dir) {
      const step = shift ? 10 : 1;
      bus.emit('editor:nudge', { dx: dir[0] * step, dy: dir[1] * step });
    }
  }

  /* ================= 便捷方法（SPEC §6.3 / §14.1） =================
   * 所有便捷方法同时兼容「位置参数」与「{key:...} 对象」入参：
   * go(2) 与 go({index:2}) 等价（历史 bug：go({index}) 曾发出 {index:{index}} 导致切页失效）。
   */

  async getState() {
    const state = await this.call('getState');
    if (state && typeof state === 'object') this._state = state;
    return state;
  }
  go(index) { return this.call('go', { index: pickParam(index, 'index') }); }
  select(elementId) { return this.call('select', { elementId: pickParam(elementId, 'elementId') }); }
  selectAt(x, y) {
    if (isPlainObject(x)) return this.call('selectAt', { x: x.x, y: x.y });
    return this.call('selectAt', { x, y });
  }
  deselect() { return this.call('deselect'); }
  getSelection() { return this.call('getSelection'); }
  hitTest(x, y) {
    if (isPlainObject(x)) return this.call('hitTest', { x: x.x, y: x.y });
    return this.call('hitTest', { x, y });
  }

  beginTextEdit(elementId) { return this.call('beginTextEdit', { elementId: pickParam(elementId, 'elementId') }); }
  endTextEdit() { return this.call('endTextEdit'); }
  execTextCommand(command, value) {
    if (isPlainObject(command) && value === undefined) return this.call('execTextCommand', command);
    return this.call('execTextCommand', { command, value });
  }
  setText(elementId, html) {
    if (isPlainObject(elementId) && html === undefined) return this.call('setText', elementId);
    return this.call('setText', { elementId, html });
  }
  setStyles(elementId, styles) {
    if (isPlainObject(elementId) && styles === undefined) return this.call('setStyles', elementId);
    return this.call('setStyles', { elementId, styles });
  }
  setAttrs(elementId, attrs) {
    if (isPlainObject(elementId) && attrs === undefined) return this.call('setAttrs', elementId);
    return this.call('setAttrs', { elementId, attrs });
  }

  moveElement(elementId, dx, dy) {
    if (isPlainObject(elementId) && dx === undefined) return this.call('moveElement', elementId);
    return this.call('moveElement', { elementId, dx, dy });
  }
  resizeElement(elementId, w, h, x, y) {
    if (isPlainObject(elementId) && w === undefined) return this.call('resizeElement', elementId);
    return this.call('resizeElement', { elementId, w, h, x, y });
  }
  rotateElement(elementId, deg) {
    if (isPlainObject(elementId) && deg === undefined) return this.call('rotateElement', elementId);
    return this.call('rotateElement', { elementId, deg });
  }

  beginTransform(elementId) { return this.call('beginTransform', { elementId: pickParam(elementId, 'elementId') }); }
  updateTransform(params) { return this.call('updateTransform', params); }
  commitTransform(elementId) { return this.call('commitTransform', { elementId: pickParam(elementId, 'elementId') }); }
  cancelTransform(elementId) { return this.call('cancelTransform', { elementId: pickParam(elementId, 'elementId') }); }

  insertElement(payload) { return this.call('insertElement', payload); }
  deleteElement(elementId) { return this.call('deleteElement', { elementId: pickParam(elementId, 'elementId') }); }
  duplicateElement(elementId) { return this.call('duplicateElement', { elementId: pickParam(elementId, 'elementId') }); }
  getElementHtml(elementId) { return this.call('getElementHtml', { elementId: pickParam(elementId, 'elementId') }); }
  setElementHtml(elementId, html) {
    if (isPlainObject(elementId) && html === undefined) return this.call('setElementHtml', elementId);
    return this.call('setElementHtml', { elementId, html });
  }
  setAnimation(elementId, anim) {
    if (isPlainObject(elementId) && anim === undefined) return this.call('setAnimation', elementId);
    return this.call('setAnimation', { elementId, anim });
  }

  getSlideHtml(index) { return this.call('getSlideHtml', { index: pickParam(index, 'index') }); }
  setSlideHtml(index, html) {
    if (isPlainObject(index) && html === undefined) return this.call('setSlideHtml', index);
    return this.call('setSlideHtml', { index, html });
  }
  addSlide(afterIndex, html) {
    if (isPlainObject(afterIndex) && html === undefined) return this.call('addSlide', afterIndex);
    return this.call('addSlide', { afterIndex: pickParam(afterIndex, 'afterIndex', 'index'), html });
  }
  duplicateSlide(index) { return this.call('duplicateSlide', { index: pickParam(index, 'index') }); }
  deleteSlide(index) { return this.call('deleteSlide', { index: pickParam(index, 'index') }); }
  moveSlide(from, to) {
    if (isPlainObject(from) && to === undefined) return this.call('moveSlide', from);
    return this.call('moveSlide', { from, to });
  }
  setSlideAttrs(index, attrs) {
    if (isPlainObject(index) && attrs === undefined) return this.call('setSlideAttrs', index);
    return this.call('setSlideAttrs', { index, attrs });
  }
  getSlideAnimations(index) { return this.call('getSlideAnimations', { index: pickParam(index, 'index') }); }

  setDeckCss(css) { return this.call('setDeckCss', { css }); }
  setDeckJs(js) { return this.call('setDeckJs', { js }); }
  setThemeVars(vars) { return this.call('setThemeVars', { vars }); }
  setDeckFlags(flags) { return this.call('setDeckFlags', flags); }
  getDeckCss() { return this.call('getDeckCss'); }
  getDeckJs() { return this.call('getDeckJs'); }

  applyOp(op, direction = 'undo') { return this.call('applyOp', { op, direction }); }
  serialize() { return this.call('serialize'); }
  save() { return this.call('save'); }
  getThumb(index) { return this.call('getThumb', { index: pickParam(index, 'index') }); }
  previewAnimation(elementId) {
    if (isPlainObject(elementId)) return this.call('previewAnimation', elementId);
    return this.call('previewAnimation', elementId ? { elementId } : {});
  }
  setEditing(editing) { return this.call('setEditing', { editing: !!pickParam(editing, 'editing') }); }

  /** 重载 iframe 文档（桥接若未实现 reload 时由 editor 直接换 src） */
  async reloadDocument(options = {}) {
    const { preserveState = true } = options;
    this._ready = false;
    this._state = null;
    const readyPromise = this.waitReady(READY_TIMEOUT);
    const win = this.frameWindow;
    if (win) {
      try {
        win.postMessage({
          type: 'wpx:req',
          id: `reload.${++this._seq}`,
          method: 'reload',
          params: { preserveState },
        }, this.origin);
      } catch { /* 换 src 兜底由调用方处理 */ }
    }
    return readyPromise;
  }
}

/** 创建客户端 */
export function createBridge(iframe, options) {
  return new BridgeClient(iframe, options);
}

export default BridgeClient;
