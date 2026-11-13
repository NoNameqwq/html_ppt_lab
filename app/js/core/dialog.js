/* 弹窗 / 确认框 / 输入框 */

import { h } from './dom.js';
import { icon } from '../ui/icons.js';

let root = null;
const stack = [];

function getRoot() {
  if (!root) root = document.getElementById('overlay-root');
  return root;
}

function closeTop() {
  const top = stack[stack.length - 1];
  if (top) top.close(null);
}

/**
 * 打开弹窗。
 * spec: {title, sub, body, width:'md'|'lg'|'xl'|number, actions:[{label,value,kind:'primary'|'accent'|'ghost'|'danger',onClick}],
 *        onClose, closeOnBackdrop=true, className}
 * 返回 Promise<value>。
 */
export function open(spec = {}) {
  return new Promise((resolve) => {
    const {
      title = '', sub = '', body = null, width = 'md',
      actions = [{ label: '完成', value: true, kind: 'primary' }],
      closeOnBackdrop = true, className = '', onClose,
    } = spec;

    const wrap = h('div', { class: 'modal-wrap' });
    const widthCls = typeof width === 'string' ? `modal--${width}` : '';
    const modal = h('div', { class: `modal ${widthCls} ${className}`.trim(), role: 'dialog', 'aria-modal': 'true' });
    const head = h('div', { class: 'modal-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'modal-title' }, title),
        sub ? h('div', { class: 'modal-sub' }, sub) : null),
      h('button', { class: 'icon-btn icon-btn--sm modal-close', title: '关闭', html: icon('x', 16) }),
    );
    const bodyEl = h('div', { class: 'modal-body' });
    if (body instanceof Node) bodyEl.append(body);
    else if (typeof body === 'string') bodyEl.innerHTML = body;
    const foot = h('div', { class: 'modal-foot' });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      wrap.style.pointerEvents = 'none';
      wrap.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'both' })
        .finished.then(() => wrap.remove()).catch(() => wrap.remove());
      onClose?.(value);
      resolve(value);
    };

    const handle = { close: finish, el: modal };
    stack.push(handle);

    head.querySelector('.modal-close').addEventListener('click', () => finish(null));
    if (closeOnBackdrop) wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) finish(null); });

    for (const a of actions) {
      if (a.hidden) continue;
      const btn = h('button', {
        class: `btn ${a.kind === 'primary' ? 'btn--primary' : a.kind === 'accent' ? 'btn--accent' : a.kind === 'danger' ? 'btn--danger' : 'btn--ghost'}`,
      }, a.label);
      btn.addEventListener('click', async () => {
        if (a.onClick) {
          const r = await a.onClick(modal, finish);
          if (r === false) return;
          if (r !== undefined) finish(r);
          else finish(a.value);
        } else {
          finish(a.value);
        }
      });
      foot.append(btn);
    }

    modal.append(head, bodyEl, foot);
    wrap.append(modal);
    getRoot().append(wrap);
    wrap.style.pointerEvents = 'auto';
    requestAnimationFrame(() => {
      const first = modal.querySelector('input,textarea,select');
      if (first) first.focus();
    });
  });
}

export function confirm(message, opts = {}) {
  return open({
    title: opts.title || '确认操作',
    sub: opts.sub || '',
    width: 'sm',
    body: h('div', { style: { fontSize: '13px', lineHeight: '1.6', color: 'var(--ink-2)', padding: '2px 0 6px' } }, message),
    actions: [
      { label: opts.cancelLabel || '取消', value: false, kind: 'ghost' },
      { label: opts.okLabel || '确定', value: true, kind: opts.danger ? 'danger' : 'primary' },
    ],
  });
}

export function prompt(title, { value = '', placeholder = '', sub = '', multiline = false, okLabel = '确定' } = {}) {
  const input = multiline
    ? h('textarea', { class: 'input', placeholder, style: { minHeight: '110px' } })
    : h('input', { class: 'input', placeholder, value });
  input.value = value;
  const body = h('div', { style: { padding: '4px 0 8px' } }, input);
  return open({
    title, sub, width: 'sm', body,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      { label: okLabel, kind: 'primary', onClick: () => input.value },
    ],
  });
}

export function closeAll() {
  [...stack].reverse().forEach((s) => s.close(null));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    e.preventDefault();
    e.stopPropagation();
    closeTop();
  }
}, true);

export const dialog = { open, confirm, prompt, closeAll };
export default dialog;
