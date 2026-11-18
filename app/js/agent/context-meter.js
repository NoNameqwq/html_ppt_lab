import { h } from '../core/dom.js';
import { formatTokens } from './context-usage.js';

export function createContextMeter() {
  const label = h('span', {}, '0%');
  const ring = h('span', { class: 'agw-context-ring', 'aria-hidden': 'true', html: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><circle class="is-used" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" transform="rotate(-90 8 8)"/></svg>' });
  const button = h('button', { type: 'button', class: 'agw-context-button', 'aria-label': '上下文用量', 'aria-expanded': 'false', 'aria-controls': 'agent-context-detail' }, ring, label);
  const heading = h('div', { class: 'agw-context-heading' });
  const bar = h('div', { class: 'agw-context-bar', 'aria-hidden': 'true' });
  const rows = h('div', { class: 'agw-context-rows' });
  const note = h('small', { class: 'agw-context-note' }, '估算用量 · 接近上限时自动整理早期对话');
  const detail = h('div', { class: 'agw-context-detail', id: 'agent-context-detail', role: 'region', 'aria-label': '上下文用量详情', hidden: true }, heading, bar, rows, note);
  const el = h('div', { class: 'agw-context-meter' }, button, detail);
  let pinned = false, timer;
  const show = (open) => { clearTimeout(timer); detail.hidden = !open; button.setAttribute('aria-expanded', String(open)); };
  button.addEventListener('click', () => { pinned = !pinned; show(pinned); });
  el.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') show(true); });
  el.addEventListener('pointerleave', () => { if (!pinned && !el.contains(document.activeElement)) timer = setTimeout(() => show(false), 130); });
  button.addEventListener('focus', () => show(true));
  el.addEventListener('focusout', (e) => { if (!pinned && !el.contains(e.relatedTarget)) show(false); });
  document.addEventListener('pointerdown', (e) => { if (!el.contains(e.target)) { pinned = false; show(false); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !detail.hidden) { pinned = false; show(false); e.stopImmediatePropagation(); } }, true);
  function update(c) {
    if (!c) return;
    label.textContent = c.percent + '%'; ring.querySelector('.is-used').setAttribute('stroke-dashoffset', String(100 - c.percent));
    button.setAttribute('aria-label', `上下文已用 ${c.percent}%，约 ${formatTokens(c.tokens)} / ${formatTokens(c.limit)} tokens`);
    heading.replaceChildren(h('span', {}, '上下文已用 ', h('strong', {}, c.percent + '%')), h('strong', {}, `~${formatTokens(c.tokens)} / ${formatTokens(c.limit)}`));
    bar.replaceChildren(); rows.replaceChildren();
    for (const [key, title] of [['system','系统提示词'],['tools','工具定义'],['messages','对话消息']]) {
      const tokens = c.breakdown?.[key] || 0;
      bar.append(h('span', { 'data-part': key, style: { width: Math.min(100, tokens / Math.max(1, c.limit) * 100) + '%' } }));
      rows.append(h('div', { class: 'agw-context-row' }, h('span', { class: 'agw-context-dot', 'data-part': key }), h('span', {}, title), h('span', {}, '~' + formatTokens(tokens))));
    }
    note.textContent = c.folded ? `估算用量 · ${c.folded} 条早期记录已整理，原文完整保留` : '估算用量 · 接近上限时自动整理早期对话';
  }
  return { el, update, open: () => { pinned = true; show(true); button.focus(); } };
}
