/* 命令总线 + 全局事件 */

class Bus {
  constructor() {
    this._commands = new Map();
    this._events = new Map();
    this._debug = false;
  }

  /* ---------- 命令 ---------- */
  registerCommand(name, handler, meta = {}) {
    if (typeof handler !== 'function') throw new Error('命令 handler 必须是函数: ' + name);
    this._commands.set(name, { handler, meta });
    return () => { if (this._commands.get(name)?.handler === handler) this._commands.delete(name); };
  }

  hasCommand(name) { return this._commands.has(name); }

  listCommands() {
    return [...this._commands.entries()].map(([name, { meta }]) => ({ name, ...meta }));
  }

  async runCommand(name, payload) {
    const entry = this._commands.get(name);
    if (!entry) {
      console.warn('[bus] 未注册命令:', name, payload);
      return { ok: false, error: '未注册命令: ' + name };
    }
    try {
      const result = await entry.handler(payload);
      return result === undefined ? { ok: true } : result;
    } catch (err) {
      console.error('[bus] 命令执行失败:', name, err);
      this.emit('command:error', { name, error: err });
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /* ---------- 事件 ---------- */
  on(event, fn) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (data) => { off(); fn(data); });
    return off;
  }

  off(event, fn) {
    this._events.get(event)?.delete(fn);
  }

  emit(event, data) {
    if (this._debug) console.debug('[bus]', event, data);
    const set = this._events.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(data); } catch (err) { console.error('[bus] 事件处理失败:', event, err); }
    }
  }

  clear() { this._commands.clear(); this._events.clear(); }
}

export const bus = new Bus();
export default bus;
