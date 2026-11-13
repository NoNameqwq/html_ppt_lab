/* 轻量 toast 通知 */

import { h } from './dom.js';
import { icon } from '../ui/icons.js';

const ICONS = { info: 'info', ok: 'check-circle', warn: 'alert', error: 'x-circle', success: 'check-circle' };
let root = null;

function getRoot() {
  if (!root) root = document.getElementById('toast-root');
  return root;
}

export function toast(message, opts = {}) {
  const { type = 'info', duration = 2400, action = null } = opts;
  const el = h('div', { class: `toast toast--${type}` });
  el.innerHTML = icon(ICONS[type] || 'info', 15);
  const text = h('span', { class: 'grow' }, message);
  el.append(text);
  if (action) {
    const btn = h('button', { class: 'btn btn--sm', style: { marginLeft: '4px', height: '24px' } }, action.label);
    btn.addEventListener('click', () => { try { action.onClick?.(); } finally { dismiss(); } });
    el.append(btn);
  }
  getRoot().append(el);
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  };
  timer = setTimeout(dismiss, duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 900); });
  return dismiss;
}

toast.ok = (msg, opts) => toast(msg, { ...opts, type: 'ok' });
toast.warn = (msg, opts) => toast(msg, { ...opts, type: 'warn' });
toast.error = (msg, opts) => toast(msg, { ...opts, type: 'error', duration: 4200 });

export default toast;
