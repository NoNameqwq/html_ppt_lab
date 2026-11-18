import { normalizeFavorite } from './favorite-data.js';

// Embed only resources actually used by the selected subtree. A favorite must
// survive moving to another project or deleting its source project.
export async function portableFavorite(snapshot, fetcher = fetch) {
  let total = 0;
  const cache = new Map();
  async function embed(url) {
    if (!url || url.startsWith('#') || url.startsWith('data:')) return url;
    if (!/^(https?:|blob:)/i.test(url)) throw new Error('收藏素材地址无效：' + url.slice(0,100));
    if (!cache.has(url)) cache.set(url, (async () => {
      const res = await fetcher(url);
      if (!res.ok) throw new Error('收藏素材读取失败，请确认图片可用后重试');
      const data = await res.blob(); total += data.size;
      if (total > 16 * 1024 * 1024) throw new Error('元素素材超过 16MB，请缩小后再收藏');
      return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('素材读取失败'));reader.readAsDataURL(data); });
    })());
    return cache.get(url);
  }
  async function cssAssets(css) {
    const matches = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)];
    for (const m of matches) { const data = await embed(m[2]); css = css.split(m[0]).join('url("' + data + '")'); }
    return css;
  }
  const doc = new DOMParser().parseFromString(snapshot.html, 'text/html');
  for (const node of doc.body.querySelectorAll('*')) {
    for (const attr of ['src','poster',...(node.localName === 'image' ? ['href','xlink:href'] : [])]) if (node.hasAttribute(attr)) node.setAttribute(attr, await embed(node.getAttribute(attr)));
    if (node.hasAttribute('style')) node.setAttribute('style', await cssAssets(node.getAttribute('style')));
  }
  return normalizeFavorite({ ...snapshot, html: doc.body.innerHTML, css: await cssAssets(snapshot.css || '') });
}

export function favoriteMarkup(item, { x = 160, y = 160 } = {}) {
  const doc = new DOMParser().parseFromString('<div></div>', 'text/html'), wrapper = doc.body.firstElementChild;
  wrapper.innerHTML = item.html;
  wrapper.className = 'wpx-el wpx-html'; wrapper.dataset.wpxType = 'html'; wrapper.dataset.favoriteId = item.id;
  wrapper.style.cssText = `position:absolute;left:${Number(x)||0}px;top:${Number(y)||0}px;width:${item.w}px;height:${item.h}px;isolation:isolate;`;
  let extraCSS = '';
  wrapper.querySelectorAll('style').forEach(n => { extraCSS += '\n' + n.textContent; n.remove(); });
  wrapper.querySelectorAll('script:not([type="application/json"]),iframe,object,embed,link,meta,base').forEach(n => n.remove());
  const prefix = 'fav-' + crypto.randomUUID(), ids = new Map();
  wrapper.id = prefix;
  wrapper.querySelectorAll('[id]').forEach((n,i) => { const old = n.id; const next = prefix + '-' + i; if (!ids.has(old)) ids.set(old,next); n.id=next; });
  const pseudos = new Map();
  wrapper.querySelectorAll('[data-favorite-pseudo]').forEach(n => { const old=n.getAttribute('data-favorite-pseudo');const next=prefix+'-pseudo-'+pseudos.size;pseudos.set(old,next);n.setAttribute('data-favorite-pseudo',next); });
  const replace = value => {
    for (const [old,next] of ids) {
      if (value === '#'+old) value='#'+next;
      value=value.replace(new RegExp('url\\(\\s*(["\']?)#'+old.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\1\\s*\\)','g'),'url(#'+next+')');
    }
    return value;
  };
  // Scope selectors and keyframe names so separate copies cannot restyle each other.
  const sheet = new CSSStyleSheet(); sheet.replaceSync((item.css || '') + extraCSS);
  const animationNames = new Map();
  const collect = rules => { for (const rule of rules) { if (rule.type === 7) animationNames.set(rule.name, prefix + '-animation-' + animationNames.size); else if (rule.cssRules) collect(rule.cssRules); } };
  collect(sheet.cssRules);
  const animations = style => {
    const names = style.getPropertyValue('animation-name');
    if (names) style.setProperty('animation-name', names.split(',').map(n => animationNames.get(n.trim()) || n.trim()).join(','), style.getPropertyPriority('animation-name'));
  };
  function splitSelectors(value) {
    const parts = []; let start = 0, depth = 0, quote = '';
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (c === '\\') { i++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && !depth) { parts.push(value.slice(start,i)); start=i+1; }
    }
    return parts.concat(value.slice(start));
  }
  const rulesCSS = rules => Array.from(rules, rule => {
    if (rule.type === 7) { rule.name = animationNames.get(rule.name); return replace(rule.cssText); }
    if (rule.type === 1) {
      let selector = rule.selectorText;
      for (const [old,next] of ids) selector = selector.replace(new RegExp('#' + CSS.escape(old).replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?![\\w-])','g'), '#' + next);
      for (const [old,next] of pseudos) selector = selector.split(old).join(next);
      animations(rule.style);
      return splitSelectors(selector).map(s => `:where(#${prefix}) ${s.trim()}`).join(',') + `{${replace(rule.style.cssText)}}`;
    }
    if (rule.type === 5) return rule.cssText;
    if (rule.cssRules && (rule.type === 4 || rule.type === 12)) return rule.cssText.slice(0,rule.cssText.indexOf('{')+1) + rulesCSS(rule.cssRules) + '}';
    return '';
  }).join('\n');
  wrapper.querySelectorAll('*').forEach(n => {
    if (n.localName === 'script') return; // Scene JSON must remain byte-for-byte intact.
    Array.from(n.attributes).forEach(a => { if (/^on/i.test(a.name) || a.name==='srcdoc') n.removeAttribute(a.name); else if (['href','xlink:href','src','action','formaction'].includes(a.name) && /^\s*(?:javascript|vbscript):/i.test(a.value.replace(/[\u0000-\u0020]/g,''))) n.removeAttribute(a.name); else if(a.name!=='id')n.setAttribute(a.name,replace(a.value)); });
    if (n.style) animations(n.style);
    n.classList.remove('wpx-selected','wpx-hover'); n.removeAttribute('contenteditable');
  });
  const css = rulesCSS(sheet.cssRules);
  if (css) {
    const style=doc.createElement('style');style.textContent=css.replace(/<\/style/gi,'<\\/style');wrapper.prepend(style);
  }
  return wrapper.outerHTML;
}

export async function insertFavorite(ctx, item, args = {}) {
  const editor = ctx.getEditor?.();
  if (!editor?.bridge?.ready) throw new Error('请先打开一个工程');
  const { w = 1920, h = 1080 } = ctx.store.get().deck;
  const html = favoriteMarkup(item, { x: args.x ?? Math.max(0,(w-item.w)/2), y: args.y ?? Math.max(0,(h-item.h)/2) });
  const result = await editor.bridge.call('insertElementHtml', { html, favorite: true, label: '插入收藏 · '+item.name });
  await editor.bridge.call('select', { elementId: result.elementId });
  return { ok: true, favoriteId: item.id, elementId: result.elementId, op: result.op };
}
