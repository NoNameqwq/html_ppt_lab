/* 右键菜单：元素菜单 / 画布菜单（native + 兼容模式通用）
 * 设计目标：右键永远是我们自己的菜单，不出现浏览器默认菜单；
 * 元素菜单覆盖「编辑 / 图层 / 复制 / 交互 / 时间线 / AI」六组动作。 */

import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';

let ctx = null;
let menuEl = null;
let subEl = null;
let offDoc = null;

const ACTIONS = [
  { value: '', label: '无（普通元素）' },
  { value: 'next', label: '点击 → 下一页' },
  { value: 'prev', label: '点击 → 上一页' },
  { value: 'replay', label: '点击 → 重播动画' },
  { value: 'timeline', label: '点击 → 播放/暂停时间线' },
  { value: 'go', label: '点击 → 跳到指定页…' },
  { value: 'url', label: '点击 → 打开链接…' },
];

function close() {
  closeSub();
  if (menuEl) { try { menuEl.remove(); } catch { /* ignore */ } menuEl = null; }
  if (offDoc) { try { offDoc(); } catch { /* ignore */ } offDoc = null; }
}
function closeSub() {
  if (subEl) { try { subEl.remove(); } catch { /* ignore */ } subEl = null; }
}

function getEditor() { try { return ctx?.getEditor ? ctx.getEditor() : null; } catch { return null; } }
function getBridge() { return getEditor()?.bridge || null; }
function deckState() { return (ctx?.store?.get()?.deck) || {}; }
function projectState() { return (ctx?.store?.get()?.project) || {}; }
function toastOk(msg) { try { ctx.toast.ok(msg); } catch { /* ignore */ } }
function toastErr(msg) { try { ctx.toast.error(msg); } catch { /* ignore */ } }

function mkItem(opt) {
  const btn = h('button', {
    type: 'button',
    class: 'ctx-menu-item' + (opt.danger ? ' is-danger' : '') + (opt.active ? ' is-active' : '') + (opt.disabled ? ' is-disabled' : ''),
    disabled: !!opt.disabled,
  },
  h('span', { class: 'ctx-menu-ic', html: icon(opt.icon || 'square', 15) }),
  h('span', { class: 'ctx-menu-label' }, opt.label),
  opt.hint ? h('kbd', { class: 'ctx-menu-hint' }, opt.hint) : null,
  opt.sub ? h('span', { class: 'ctx-menu-caret', html: icon('chevron-right', 13) }) : null);
  if (opt.disabled) return btn;
  if (opt.sub) {
    let timer = 0;
    btn.addEventListener('pointerenter', () => {
      clearTimeout(timer);
      timer = setTimeout(() => openSub(btn, opt.sub), 90);
    });
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openSub(btn, opt.sub); });
    return btn;
  }
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    try { await opt.run?.(); } catch (err) { toastErr('操作失败：' + (err?.message || err)); }
  });
  return btn;
}

function openSub(anchor, items) {
  closeSub();
  const sub = h('div', { class: 'ctx-menu ctx-menu--sub', role: 'menu' });
  for (const it of items) {
    if (it.sep) { sub.append(h('div', { class: 'ctx-menu-sep' })); continue; }
    if (it.title) { sub.append(h('div', { class: 'ctx-menu-label' }, it.title)); continue; }
    sub.append(mkItem(it));
  }
  document.body.append(sub);
  const a = anchor.getBoundingClientRect();
  const r = sub.getBoundingClientRect();
  let left = a.right + 4;
  let top = a.top - 4;
  if (left + r.width > window.innerWidth - 8) left = Math.max(8, a.left - r.width - 4);
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
  sub.style.left = left + 'px';
  sub.style.top = top + 'px';
  subEl = sub;
}

function place(menu, clientX, clientY) {
  document.body.append(menu);
  menuEl = menu;
  const r = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, clientX));
  const top = Math.max(8, Math.min(window.innerHeight - r.height - 8, clientY));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  const onDoc = (e) => {
    if (menuEl && !menuEl.contains(e.target) && !(subEl && subEl.contains(e.target))) close();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  offDoc = () => {
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
}

/* ---------------- 元素菜单 ---------------- */

async function openForElement(hit, clientX, clientY) {
  const bridge = getBridge();
  if (!bridge?.ready) return;
  const elementId = hit.elementId;
  const textId = hit.textElementId || hit.elementId;
  const deck = deckState();
  const proj = projectState();
  const slideIndex = deck.current || 0;
  const typeLabel = hit.type === 'image' ? '图片' : hit.type === 'shape' ? '形状' : hit.type === 'text' ? '文字' : '元素';

  const menu = h('div', { class: 'ctx-menu', role: 'menu' });

  const head = h('div', { class: 'ctx-menu-head' },
    h('span', { class: 'ctx-menu-kind' }, typeLabel),
    h('code', { class: 'ctx-menu-id' }, elementId));
  menu.append(head);

  menu.append(h('div', { class: 'ctx-menu-label' }, '编辑'));
  if (hit.type === 'text' || hit.type === 'html') {
    menu.append(mkItem({ icon: 'type', label: '编辑文字', hint: '双击', run: () => ctx.bus.emit('editor:begin-text', { elementId: textId }) }));
  }
  menu.append(mkItem({
    icon: 'code', label: '编辑 HTML 源码',
    run: async () => {
      const { html } = await bridge.getElementHtml(elementId);
      openHtmlDialog(elementId, html, bridge);
    },
  }));
  menu.append(mkItem({
    icon: 'agent', label: '用 AI 重做这个元素',
    run: () => {
      const page = deck.total ? `第 ${slideIndex + 1}/${deck.total} 页` : '';
      const text = `【右键选中${typeLabel}，工程「${proj.name || '当前工程'}」${page ? '，' + page : ''}】先读取这个元素（id: ${elementId}），按更符合当前视觉风格的方式重新设计它（保持可编辑）。`;
      ctx.bus.runCommand('agent.send', { text });
    },
  }));

  menu.append(h('div', { class: 'ctx-menu-sep' }));
  menu.append(h('div', { class: 'ctx-menu-label' }, '图层 / 排列'));
  menu.append(mkItem({ icon: 'bring-front', label: '置于顶层', run: () => ctx.bus.runCommand('arrange.front') }));
  menu.append(mkItem({ icon: 'bring-forward', label: '上移一层', run: () => ctx.bus.runCommand('arrange.forward') }));
  menu.append(mkItem({ icon: 'send-backward', label: '下移一层', run: () => ctx.bus.runCommand('arrange.backward') }));
  menu.append(mkItem({ icon: 'send-back', label: '置于底层', run: () => ctx.bus.runCommand('arrange.back') }));

  menu.append(h('div', { class: 'ctx-menu-sep' }));
  menu.append(mkItem({ icon: 'copy', label: '复制', hint: 'Ctrl+C', run: () => ctx.bus.runCommand('edit.copy') }));
  menu.append(mkItem({ icon: 'clipboard', label: '粘贴', hint: 'Ctrl+V', run: () => ctx.bus.runCommand('edit.paste') }));
  menu.append(mkItem({ icon: 'copy', label: '原位复制', hint: 'Ctrl+D', run: () => ctx.bus.runCommand('edit.duplicate') }));
  menu.append(mkItem({ icon: 'trash', label: '删除', hint: 'Del', danger: true, run: () => ctx.bus.runCommand('edit.delete') }));

  menu.append(h('div', { class: 'ctx-menu-sep' }));
  menu.append(h('div', { class: 'ctx-menu-label' }, '交互 / 时间线'));
  menu.append(mkItem({
    icon: 'cursor-select', label: '点击行为', sub: buildActionSub(bridge, elementId),
  }));
  menu.append(mkItem({
    icon: 'film', label: '加入时间线轨道',
    run: async () => {
      const ok = await ctx.bus.runCommand('timeline.addSelected', { elementId });
      if (ok === false) toastErr('加入时间线失败');
    },
  }));
  menu.append(mkItem({
    icon: 'layers', label: '复制到所有页',
    run: () => copyToAllPages(bridge, elementId, deck.total || 0),
  }));

  menu.append(h('div', { class: 'ctx-menu-sep' }));
  menu.append(mkItem({
    icon: 'sliders', label: '属性面板',
    run: () => ctx.bus.runCommand('app.toggleInspector', { open: true }),
  }));

  place(menu, clientX, clientY);
}

function buildActionSub(bridge, elementId) {
  const items = [];
  for (const a of ACTIONS) {
    if (a.value === 'go' || a.value === 'url') {
      items.push({
        icon: a.value === 'go' ? 'film' : 'link',
        label: a.label,
        run: async () => {
          if (a.value === 'go') {
            const total = deckState().total || 1;
            const answer = await ctx.dialog.prompt('跳到第几页？', { title: '点击行为', value: '1', placeholder: `1 – ${total}` });
            const n = Number(answer);
            if (!n || n < 1 || n > total) return;
            await bridge.setAttrs(elementId, { 'data-wpx-action': 'go:' + n });
            toastOk('已设置：点击跳到第 ' + n + ' 页');
          } else {
            const url = await ctx.dialog.prompt('输入链接地址', { title: '点击行为', value: 'https://', placeholder: 'https://…' });
            if (!url || !/^https?:/i.test(url)) return;
            await bridge.setAttrs(elementId, { 'data-wpx-action': 'url:' + url });
            toastOk('已设置：点击打开链接');
          }
        },
      });
    } else {
      items.push({
        icon: a.value ? 'play' : 'x',
        label: a.label,
        run: async () => {
          await bridge.setAttrs(elementId, { 'data-wpx-action': a.value || null });
          toastOk(a.value ? '已设置点击行为：' + a.label.replace('点击 → ', '') : '已清除点击行为');
        },
      });
    }
  }
  items.push({ sep: true });
  items.push({
    icon: 'info', label: '放映时点击元素执行行为，不翻页', disabled: true,
  });
  return items;
}

async function copyToAllPages(bridge, elementId, total) {
  if (deckState().raw) { toastErr('网页结构由原稿决定，不能批量插入到每一页'); return; }
  if (total < 2) { toastErr('只有一页'); return; }
  const { html } = await bridge.getElementHtml(elementId);
  const from = deckState().current || 0;
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (i === from) continue;
    try {
      await bridge.call('insertElementHtml', { slideIndex: i, html, label: '复制到所有页' });
      n += 1;
    } catch { /* ignore */ }
  }
  toastOk(`已复制到另外 ${n} 页`);
}

function openHtmlDialog(elementId, html, bridge) {
  const ta = h('textarea', { class: 'input ctx-html', spellcheck: 'false' });
  ta.value = html;
  ta.rows = 14;
  const body = h('div', { class: 'ctx-html-wrap' }, ta);
  ctx.dialog.open({
    title: '编辑 HTML 源码',
    sub: elementId,
    body,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      { label: '应用', value: 'save', kind: 'primary' },
    ],
  }).then(async (v) => {
    if (v !== 'save') return;
    try {
      await bridge.setElementHtml(elementId, ta.value);
      toastOk('HTML 已更新');
    } catch (err) { toastErr('更新失败：' + (err?.message || err)); }
  });
}

function goBy(delta) {
  const ed = getEditor();
  const deck = deckState();
  const next = Math.max(0, Math.min((deck.total || 1) - 1, (deck.current || 0) + delta));
  if (ed?.goSlide) return ed.goSlide(next);
  return null;
}

/* ---------------- 画布菜单 ---------------- */

function openForCanvas(clientX, clientY) {
  const deck = deckState();
  const proj = projectState();
  const menu = h('div', { class: 'ctx-menu', role: 'menu' });
  const head = h('div', { class: 'ctx-menu-head' },
    h('span', { class: 'ctx-menu-kind' }, proj.name || '画布'),
    h('code', { class: 'ctx-menu-id' }, `第 ${(deck.current || 0) + 1} / ${deck.total || 0} 页`));
  menu.append(head);
  menu.append(h('div', { class: 'ctx-menu-label' }, '插入'));
  menu.append(mkItem({ icon: 'text-box', label: '文本框', run: () => ctx.bus.runCommand('insert.text') }));
  menu.append(mkItem({ icon: 'image', label: '图片', run: () => ctx.bus.runCommand('insert.image') }));
  menu.append(mkItem({ icon: 'shapes', label: '形状', run: () => ctx.bus.runCommand('insert.shape') }));
  menu.append(mkItem({ icon: 'code', label: 'HTML 片段', run: () => ctx.bus.runCommand('insert.html') }));

  menu.append(h('div', { class: 'ctx-menu-sep' }));
  menu.append(h('div', { class: 'ctx-menu-label' }, '画布'));
  menu.append(mkItem({ icon: 'clipboard', label: '粘贴', hint: 'Ctrl+V', run: () => ctx.bus.runCommand('edit.paste') }));
  menu.append(mkItem({ icon: 'frame', label: '全选元素', hint: 'Ctrl+A', run: () => ctx.bus.runCommand('edit.selectAll') }));
  menu.append(mkItem({ icon: 'film', label: '动画时间线', run: () => ctx.bus.runCommand('app.toggleTimeline') }));
  menu.append(mkItem({ icon: 'grid', label: '显示网格', run: () => ctx.bus.runCommand('view.grid') }));
  menu.append(mkItem({ icon: 'fit', label: '适应窗口', hint: 'Ctrl+0', run: () => ctx.bus.runCommand('app.zoomFit') }));

  menu.append(h('div', { class: 'ctx-menu-sep' }));
  menu.append(mkItem({ icon: 'chevron-left', label: '上一页', run: () => goBy(-1) }));
  menu.append(mkItem({ icon: 'chevron-right', label: '下一页', run: () => goBy(1) }));
  menu.append(mkItem({
    icon: 'agent', label: '让 AI 重做这一页',
    run: () => {
      const text = `【工程「${proj.name || '当前工程'}」第 ${(deck.current || 0) + 1}/${deck.total || 1} 页】先读取这一页，再按当前视觉风格重做版式与动效（保持可编辑）。`;
      ctx.bus.runCommand('agent.send', { text });
    },
  }));
  place(menu, clientX, clientY);
}

/* ---------------- 入口 ---------------- */

async function openAt(designX, designY, clientX, clientY) {
  const bridge = getBridge();
  if (!bridge?.ready) { toastErr('画布还没准备好'); return; }
  close();
  let hit = null;
  try { hit = await bridge.hitTest(designX, designY); } catch { hit = null; }
  if (!hit?.elementId) { openForCanvas(clientX, clientY); return; }
  /* 右键即选中：菜单动作（图层/复制/删除）作用在这个元素上，而不是上一次选中的元素 */
  try {
    const sel = await bridge.select(hit.elementId);
    if (sel) { ctx.store.update((s) => { s.selection = sel; }); ctx.bus.emit('selection:change', { selection: sel }); }
  } catch { /* ignore */ }
  openForElement({ ...hit, designX, designY }, clientX, clientY);
}

async function designFromEvent(e) {
  const deck = deckState();
  let stage = deck.stage;
  if (!stage) {
    try {
      const st = await getBridge()?.getState();
      stage = st?.stage;
    } catch { /* ignore */ }
  }
  if (!stage) return null;
  const frame = document.getElementById('deck-frame');
  const r = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
  return {
    designX: (e.clientX - r.left - stage.left) / stage.scale,
    designY: (e.clientY - r.top - stage.top) / stage.scale,
  };
}

export async function init(context) {
  ctx = context;
  const area = document.getElementById('canvas-area');
  if (area) {
    area.addEventListener('contextmenu', async (e) => {
      if (ctx.route.name !== 'editor' || !projectState().id) return;
      e.preventDefault();
      e.stopPropagation();
      const pt = await designFromEvent(e);
      if (pt) openAt(pt.designX, pt.designY, e.clientX, e.clientY);
      else openForCanvas(e.clientX, e.clientY);
    }, true);
  }
  // 兼容模式：右键发生在 iframe 内，由 bridge 转发（bridge.js 已 preventDefault）
  ctx.bus.on('bridge:contextmenu', (data) => {
    if (ctx.route.name !== 'editor' || !data) return;
    const frame = document.getElementById('deck-frame');
    const r = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    openAt(data.designX, data.designY, r.left + (data.clientX || 0), r.top + (data.clientY || 0));
  });
  ctx.bus.on('route:change', () => close());
  ctx.bus.on('ui:closeMenus', () => close());

  ctx.bus.registerCommand('app.contextMenu', (payload = {}) => {
    openAt(payload.designX ?? 0, payload.designY ?? 0, payload.clientX ?? 100, payload.clientY ?? 100);
    return { ok: true };
  });
}
