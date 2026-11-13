/* Agent 消息的安全 Markdown 渲染器：先整体转义，再做受控格式化 */

import { escapeHtml, copyText } from '../core/dom.js';
import { protectRichContent } from '../core/rich-content.js';

/* ---------- 行内处理 ---------- */

const SAFE_LINK = /^(https?:\/\/|mailto:|\/|\.\/|\.\.\/|#|assets\/)/i;
const SAFE_IMG = /^(https?:\/\/|\/|\.\/|\.\.\/|assets\/|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);)/i;

function safeUrl(raw, kind) {
  const url = String(raw || '').trim();
  if (!url) return '';
  const re = kind === 'img' ? SAFE_IMG : SAFE_LINK;
  if (!re.test(url)) return '';
  // 已转义文本里不会出现裸引号，这里再兜一层
  if (/["'<>`]/.test(url)) return '';
  return url;
}

/** 行内标记：code/bold/italic/strike/link/image，输入必须是已转义文本 */
function inline(text) {
  const codes = [];
  let s = String(text);
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push('<code>' + code + '</code>');
    return '\u0000IC' + (codes.length - 1) + '\u0000';
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const safe = safeUrl(url, 'img');
    if (!safe) return m;
    return '<img class="md-img" src="' + safe + '" alt="' + alt + '" loading="lazy" decoding="async" />';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    if (!safe) return label;
    return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000IC(\d+)\u0000/g, (_m, i) => codes[Number(i)] || '');
  return s;
}

/* ---------- 块解析 ---------- */

const RE_FENCE = /^```\s*([\w+#.-]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*(?:>|&gt;)\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

function isTableStart(lines, i) {
  return i + 1 < lines.length && lines[i].includes('|') && RE_TABLE_SEP.test(lines[i + 1]) && !/^\s*$/.test(lines[i]);
}

function parseBlocks(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }

    // 围栏代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', lang: fence[1] || '', code: code.join('\n') });
      continue;
    }

    // 标题
    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    // 分隔线
    if (RE_HR.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }

    // 引用
    if (RE_QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { buf.push(RE_QUOTE.exec(lines[i])[1]); i += 1; }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    // Tables keep their structure and scroll horizontally in narrow panels.
    if (isTableStart(lines, i)) {
      const rows = [];
      const header = lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // 列表
    if (RE_LIST.test(line)) {
      const ordered = /\d/.test(RE_LIST.exec(line)[2]);
      const items = [];
      while (i < lines.length) {
        const m = RE_LIST.exec(lines[i]);
        if (!m) break;
        items.push(m[3]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 段落：连续非空、非特殊行
    const buf = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (RE_FENCE.test(cur) || RE_HEADING.test(cur) || RE_HR.test(cur) || RE_QUOTE.test(cur) || RE_LIST.test(cur)) break;
      if (isTableStart(lines, i)) break;
      buf.push(cur);
      i += 1;
    }
    if (buf.length) blocks.push({ type: 'p', text: buf.join('\n') });
  }
  return blocks;
}

function renderBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'code': {
        const lang = b.lang ? escapeHtml(b.lang) : 'code';
        out.push(
          '<div class="md-code">' +
          '<div class="md-code-head"><span class="md-lang">' + lang + '</span>' +
          '<button class="md-copy" type="button">复制</button></div>' +
          '<pre><code>' + (b.code || '') + '</code></pre></div>'
        );
        break;
      }
      case 'heading': {
        const lv = Math.min(4, Math.max(1, b.level));
        out.push('<h' + lv + ' class="md-h">' + inline(b.text) + '</h' + lv + '>');
        break;
      }
      case 'hr':
        out.push('<hr class="md-hr" />');
        break;
      case 'quote':
        out.push('<blockquote class="md-quote">' + inline(b.text).replace(/\n/g, '<br>') + '</blockquote>');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<' + tag + ' class="md-list">' + b.items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</' + tag + '>');
        break;
      }
      case 'table': {
        const head = b.header.map((c) => '<th scope="col">' + inline(c) + '</th>').join('');
        const rows = b.rows.map((row) => '<tr>' + row.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('');
        out.push('<div class="md-table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table></div>');
        break;
      }
      default:
        out.push('<p>' + inline(b.text).replace(/\n/g, '<br>') + '</p>');
    }
  }
  return out.join('');
}

/**
 * 渲染 Markdown 为安全 HTML 字符串（输入会先整体转义）。
 * @param {string} src
 * @returns {string}
 */
export function markdownToHtml(src) {
  if (src == null || src === '') return '';
  const rich = protectRichContent(String(src));
  return rich.restore(renderBlocks(parseBlocks(escapeHtml(rich.src))));
}

/** 渲染到容器（替换内容） */
export function renderMarkdown(container, src) {
  if (!container) return;
  container.innerHTML = markdownToHtml(src);
  return container;
}

/**
 * 流式渲染器：节流重渲染，避免每个 token 都重建整段 DOM。
 * update() 传入累积文本；finish() 强制最终一次渲染。
 */
export function createStreamMarkdown(container, opts = {}) {
  const minInterval = opts.minInterval ?? 70;
  let timer = null;
  let pending = null;
  let lastPaint = 0;
  let disposed = false;

  const paint = (src) => {
    if (disposed || !container) return;
    container.innerHTML = markdownToHtml(src || '');
    lastPaint = Date.now();
  };

  return {
    update(src) {
      if (disposed) return;
      pending = src;
      if (timer) return;
      const wait = Math.max(0, minInterval - (Date.now() - lastPaint));
      if (wait === 0) {
        const v = pending;
        pending = null;
        paint(v);
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        if (pending == null) return;
        const v = pending;
        pending = null;
        paint(v);
      }, wait);
    },
    finish(src) {
      if (timer) { clearTimeout(timer); timer = null; }
      const v = src == null ? (pending == null ? '' : pending) : src;
      pending = null;
      paint(v);
    },
    dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
    },
  };
}

/**
 * 给容器安装 Markdown 交互（代码块复制按钮），返回清理函数。
 * 使用事件委托，流式重渲染后依然有效。
 */
export function attachMarkdownActions(container) {
  if (!container) return () => {};
  const onClick = async (e) => {
    const btn = e.target.closest('.md-copy');
    if (!btn || !container.contains(btn)) return;
    e.preventDefault();
    const codeEl = btn.closest('.md-code')?.querySelector('code');
    if (!codeEl) return;
    const ok = await copyText(codeEl.textContent || '');
    const old = btn.textContent;
    btn.textContent = ok ? '已复制' : '复制失败';
    btn.classList.toggle('is-ok', ok);
    setTimeout(() => { btn.textContent = old; btn.classList.remove('is-ok'); }, 1400);
  };
  container.addEventListener('click', onClick);
  return () => container.removeEventListener('click', onClick);
}

/** Conservative estimate for mixed Chinese/code; reserve space before provider context limits. */
export function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 1.5 + rest * 0.35);
}
