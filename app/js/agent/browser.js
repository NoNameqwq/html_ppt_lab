import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';

export const hasBuiltinBrowser = ctx => typeof ctx.api?.browser === 'function' && !globalThis.__WDS_STATIC__;

export function browserAction(ctx, args, { sessionId, signal } = {}) {
  if (!hasBuiltinBrowser(ctx)) throw new Error('内置浏览器需要通过 BAT 启动的本机工作台。');
  const loop = ctx.agent?.loop;
  return ctx.api.browser({
    ...args, projectId: loop ? loop.projectId : ctx.store.get().project?.id ?? null,
    sessionId: sessionId || loop?.getState().sessionId || 'default',
  }, signal);
}

export function showBuiltinBrowser(ctx) {
  const controller = new AbortController();
  const status = h('div', { class: 'wds-browser-status', role: 'status' });
  const address = h('input', { class: 'input', type: 'text', inputmode: 'url', 'aria-label': '网址', placeholder: 'https://example.org 或 127.0.0.1:5173', spellcheck: false });
  const preview = h('img', { class: 'wds-browser-preview', alt: '当前网页截图', hidden: true });
  const download = h('a', { class: 'btn btn--ghost', download: '网页截图.jpg', hidden: true }, '下载截图');
  const links = h('div', { class: 'wds-browser-targets', 'aria-label': '可操作的网页控件' });
  let busy = false;

  function button(label, glyph, action) {
    return h('button', {
      class: 'btn btn--ghost', type: 'button', title: label, 'aria-label': label,
      html: icon(glyph, 16), onClick: action,
    });
  }
  const actions = [
    button('后退', 'arrow-left', () => run('back')),
    button('刷新网页', 'refresh', () => run('reload')),
    button('向上滚动', 'arrow-up', () => run('scroll', { pixels: -550 })),
    button('向下滚动', 'arrow-down', () => run('scroll', { pixels: 550 })),
    button('重新截图', 'camera', () => run('screenshot')),
  ];
  const submit = h('button', { type: 'submit', class: 'btn btn--primary' }, '打开');
  const form = h('form', { class: 'wds-browser-address', onSubmit: event => {
    event.preventDefault();
    let url = address.value.trim();
    if (!url) return;
    if (/^127\.0\.0\.1(?=[:/?#]|$)/.test(url)) url = 'http://' + url;
    else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = 'https://' + url;
    void run('open', { url });
  } }, address, submit);
  async function run(action, params = {}) {
    if (busy || controller.signal.aborted) return;
    busy = true;
    const previousButtons = [...links.querySelectorAll('button')];
    for (const el of [submit, ...actions, ...previousButtons]) el.disabled = true;
    status.textContent = action === 'open' ? '正在打开网页…' : '正在读取浏览器…';
    try {
      const result = await browserAction(ctx, { action, ...params, preview: true }, { signal: controller.signal });
      if (result.open) address.value = result.url;
      const image = result.images?.[0];
      preview.hidden = download.hidden = !image;
      if (image) {
        preview.src = image;
        download.href = image;
      }
      status.textContent = result.open ? (result.title || result.url) + (result.httpStatus >= 400 ? ' · HTTP ' + result.httpStatus : '') : '输入网址，或让 Agent 打开页面。';
      links.replaceChildren(...(result.targets || []).map(target => h('button', {
        type: 'button', class: 'btn btn--ghost', title: target.href || target.label,
        onClick: () => run('click', { index: target.index, snapshot: result.snapshot }),
      }, target.label)));
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error.message;
    } finally {
      busy = false;
      for (const el of [submit, ...actions, ...previousButtons]) el.disabled = false;
    }
  }
  const body = h('div', { class: 'wds-browser' }, form,
    h('div', { class: 'wds-browser-toolbar' }, ...actions, download), status, preview, links);
  void run('inspect');
  return ctx.dialog.open({ title: '内置浏览器', body, width: 'xl', actions: [], onClose: () => controller.abort() });
}
