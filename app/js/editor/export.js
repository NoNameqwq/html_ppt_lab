/* 导出：下载自包含 HTML（bridge.serialize 结果）；打印 / 另存为 PDF */

import { bus } from '../core/bus.js';
import { store } from '../core/store.js';
import { downloadBlob } from '../core/dom.js';
import { toast } from '../core/toast.js';

let ctx = null;

export async function init(context) {
  ctx = context;
  registerCommands();
}

function getBridge() {
  return ctx?.getEditor?.()?.bridge || null;
}

function getProject() {
  return ctx?.getEditor?.()?.project || store.get().project;
}

function safeFileName(name, fallback = 'deck') {
  const base = String(name || fallback).replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  return base || fallback;
}

async function serializeDeck() {
  const bridge = getBridge();
  if (!bridge?.ready) throw new Error('画布尚未就绪');
  const res = await bridge.serialize();
  const html = typeof res === 'string' ? res : res?.html;
  if (!html) throw new Error('序列化结果为空');
  return html;
}

function isRawMode() {
  const ed = ctx?.getEditor?.();
  return ed?.raw === true || ed?.mode === 'raw';
}

/** 导出完整 HTML 文件 */
async function exportHtml() {
  const project = getProject();
  if (!project?.id) {
    toast('还没有打开任何工程');
    return { ok: false };
  }
  try {
    const fileName = safeFileName(project.name, project.id) + '.html';
    const saved=await ctx?.getEditor?.()?.saveNow({reason:'export'});
    if(saved?.ok===false)throw new Error(saved.error||'保存失败');
    const res = await fetch('/api/projects/' + encodeURIComponent(project.id) + '/export');
    if (!res.ok) throw new Error('导出失败（HTTP ' + res.status + '）');
    downloadBlob(await res.blob(), fileName);
    toast.ok('已导出 ' + fileName);
    return { ok: true, fileName, raw: isRawMode() };
  } catch (err) {
    console.error('[export] 导出失败', err);
    toast.error('导出失败：' + (err?.message || err));
    return { ok: false, error: err?.message || String(err) };
  }
}

/** 打开打印窗口（可另存为 PDF） */
async function printDeck() {
  const project = getProject();
  if (!project?.id) {
    toast('还没有打开任何工程');
    return { ok: false };
  }
  let html;
  if (isRawMode()) {
    // 兼容模式：直接打开 server 放映页（已注入补丁），再打印
    const win = window.open('/api/projects/' + encodeURIComponent(project.id) + '/export', '_blank');
    if (!win) { toast.error('打印窗口被浏览器拦截，请允许本站弹出窗口后重试'); return { ok: false, error: 'popup-blocked' }; }
    try { win.addEventListener('load', () => setTimeout(() => { try { win.focus(); win.print(); } catch { /* ignore */ } }, 900), { once: true }); } catch { /* ignore */ }
    toast('已打开打印窗口，选择「另存为 PDF」即可导出 PDF');
    return { ok: true, raw: true };
  }
  try {
    html = await serializeDeck();
  } catch (err) {
    toast.error('导出失败：' + (err?.message || err));
    return { ok: false };
  }
  const win = window.open('', '_blank');
  if (!win) {
    toast.error('打印窗口被浏览器拦截，请允许本站弹出窗口后重试');
    return { ok: false, error: 'popup-blocked' };
  }
  try {
    win.opener = null;
  } catch { /* ignore */ }
  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (err) {
    toast.error('写入打印窗口失败：' + (err?.message || err));
    try { win.close(); } catch { /* ignore */ }
    return { ok: false };
  }
  // 等文档里的字体/图片就绪后再打印；deck 需以放映模式分页打印
  const trigger = () => {
    try { win.focus(); win.print(); } catch { /* ignore */ }
  };
  try {
    win.addEventListener('load', () => setTimeout(trigger, 380), { once: true });
    setTimeout(trigger, 1400);
  } catch {
    setTimeout(trigger, 600);
  }
  toast('已打开打印窗口，选择「另存为 PDF」即可导出 PDF');
  return { ok: true };
}

function reg(name, meta, fn) {
  bus.registerCommand(name, async (payload) => {
    try { return await fn(payload); } catch (err) {
      console.error('[export] 命令失败', name, err);
      toast.error('操作失败：' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }, meta);
}

function registerCommands() {
  reg('app.export', { label: '导出 HTML', group: '文件', icon: 'download' }, () => exportHtml());
  reg('app.print', { label: '打印 / 另存 PDF', group: '文件', icon: 'file-text' }, () => printDeck());
}
