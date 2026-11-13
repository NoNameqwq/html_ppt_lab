import katex from '../../vendor/katex/katex.mjs';
import createDOMPurify from '../../vendor/dompurify.mjs';
import { escapeHtml } from './dom.js';

export function renderFormula(latex, displayMode = true) {
  const source = String(latex || '').trim();
  if (!source) throw new Error('请输入 LaTeX 公式');
  if (source.length > 100000) throw new Error('公式超过 100000 字符，请拆成多个公式');
  return katex.renderToString(source, { displayMode, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml' });
}
const SVG_TAGS = ['svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','textPath','title','desc','marker','linearGradient','radialGradient','stop','clipPath','mask','pattern','symbol','use'];
const SVG_ATTRS = ['xmlns','viewBox','width','height','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','d','points','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-opacity','stroke-dasharray','stroke-dashoffset','stroke-linecap','stroke-linejoin','opacity','transform','id','href','xlink:href','clip-path','mask','marker-start','marker-mid','marker-end','markerWidth','markerHeight','markerUnits','refX','refY','orient','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','font-family','font-size','font-weight','font-style','text-anchor','dominant-baseline','alignment-baseline','dx','dy','rotate','lengthAdjust','textLength','preserveAspectRatio','vector-effect','patternUnits','patternTransform','role','aria-label'];
export function sanitizeSvg(source, win = globalThis.window) {
  if (!win?.DOMParser) throw new Error('SVG 渲染需要浏览器环境');
  if (String(source).length > 1000000) throw new Error('SVG 超过 1MB，请简化图形');
  const dirty = new win.DOMParser().parseFromString(String(source), 'image/svg+xml');
  if (dirty.querySelector('parsererror') || dirty.documentElement.localName !== 'svg') throw new Error('SVG 格式无效，请提供完整的 <svg> 文档');
  const purifier = createDOMPurify(win);
  const clean = purifier.sanitize(source, { ALLOWED_TAGS: SVG_TAGS, ALLOWED_ATTR: SVG_ATTRS, ALLOW_DATA_ATTR: false, ADD_URI_SAFE_ATTR: ['marker-start','marker-mid','marker-end'] });
  const doc = new win.DOMParser().parseFromString(clean, 'image/svg+xml'), svg = doc.documentElement;
  for (const el of [svg, ...svg.querySelectorAll('*')]) for (const attr of [...el.attributes]) {
    if (/href$/i.test(attr.name) && !/^#[\w:.-]+$/.test(attr.value)) el.removeAttribute(attr.name);
    if (/url\(/i.test(attr.value) && !/^url\(\s*#[\w:.-]+\s*\)$/.test(attr.value)) el.removeAttribute(attr.name);
  }
  if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${parseFloat(svg.getAttribute('width')) || 800} ${parseFloat(svg.getAttribute('height')) || 450}`);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); svg.setAttribute('role', 'img');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  return new win.XMLSerializer().serializeToString(svg);
}

export function formulaMarkup(latex, displayMode = true) {
  return `<span data-wds-latex="${escapeHtml(latex)}" data-wds-display="${displayMode ? 'block' : 'inline'}"${displayMode ? ' style="display:block"' : ''}>${renderFormula(latex, displayMode)}</span>`;
}

// Materialize formulas before saving. Playback and offline exports need no MathJax
// request or model-generated script, and the original TeX stays editable.
export function preparePageRichContent(html, win = globalThis.window) {
  if (!win?.DOMParser) return String(html);
  const doc = new win.DOMParser().parseFromString('<body>' + html, 'text/html');
  let hasMath = false;
  for (const el of doc.body.querySelectorAll('[data-wds-latex]')) {
    if (el.closest('svg,script,style,pre,code')) continue;
    el.innerHTML = renderFormula(el.getAttribute('data-wds-latex'), el.getAttribute('data-wds-display') !== 'inline');
    hasMath = true;
  }
  const walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT), texts = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('script,style,textarea,pre,code,svg,math,.katex,[data-wds-latex],[data-wds-no-math]')) texts.push(node);
  }
  const pattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|(?<![\\\w])\$(?!\s|\$)([^\n$]*?\S)\$(?!\d)/g;
  for (const node of texts) {
    let offset = 0, found = false; const fragment = doc.createDocumentFragment();
    for (const match of node.data.matchAll(pattern)) {
      fragment.append(doc.createTextNode(node.data.slice(offset, match.index)));
      const template = doc.createElement('template');
      template.innerHTML = formulaMarkup(match[1] ?? match[2] ?? match[3] ?? match[4], match[1] !== undefined || match[2] !== undefined);
      fragment.append(template.content); offset = match.index + match[0].length; found = true;
    }
    if (found) { fragment.append(doc.createTextNode(node.data.slice(offset))); node.replaceWith(fragment); hasMath = true; }
  }
  for (const el of doc.body.querySelectorAll('[data-wds-svg]')) el.innerHTML = sanitizeSvg(el.getAttribute('data-wds-svg'), win);
  if (hasMath && !doc.querySelector('link[data-wds-math]')) {
    const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = '/app/vendor/katex/katex.min.css'; link.setAttribute('data-wds-math', ''); (doc.querySelector('.wpx-canvas') || doc.body).prepend(link);
  }
  return doc.body.innerHTML;
}

// Tokenize before Markdown escaping so subscripts, ampersands and line breaks keep
// their TeX meaning. Incomplete delimiters remain readable while streaming.
export function protectRichContent(input) {
  const rich = [], keep = (html) => '\u0000RICH' + (rich.push(html) - 1) + '\u0000';
  const math = (src, display) => {
    try { return keep(`<span class="md-math${display ? ' md-math-display' : ''}" data-latex="${escapeHtml(src)}">${renderFormula(src, display)}</span>`); }
    catch (e) { return keep(`<span class="md-math-error" title="${escapeHtml(e.message)}">${escapeHtml((display ? '$$' : '$') + src + (display ? '$$' : '$'))}</span>`); }
  };
  const code = (lang, source) => `<div class="md-code"><div class="md-code-head"><span>${escapeHtml(lang)}</span><button class="md-copy" type="button">复制</button></div><pre><code>${escapeHtml(source)}</code></pre></div>`;
  const src = String(input).replace(/```([^\n]*)\n([\s\S]*?)(```|$)|`[^`\n]*`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|(?<![\\\w])\$(?!\s|\$)([^\n$]*?\S)\$(?!\d)/g,
    (match, language, fenced, close, block, bracket, paren, inline) => {
      if (language !== undefined) {
        const lang = language.trim().toLowerCase();
        if (close === '```' && ['latex','tex','math'].includes(lang)) return math(fenced.trim(), true);
        if (close === '```' && lang === 'svg') {
          try { return keep(`<figure class="md-svg"><div class="md-svg-preview">${sanitizeSvg(fenced)}</div><details><summary>SVG 源码</summary>${code('svg', fenced)}</details></figure>`); }
          catch (e) { return keep(`<div class="md-math-error">${escapeHtml(e.message)}</div>${code(lang, fenced)}`); }
        }
        // Keep other fenced code untouched; Markdown handles escaping and copying.
        return match;
      }
      if (match.startsWith('`')) return match;
      return math(block ?? bracket ?? paren ?? inline, block !== undefined || bracket !== undefined);
    });
  return { src, restore: (html) => html.replace(/\u0000RICH(\d+)\u0000/g, (_, n) => rich[Number(n)] || '') };
}
