import { escapeHtml as esc } from './dom.js';

export const NAVIGATION_STYLES = [
  { id: 'petals', label: '花瓣展开', hint: '适合知识、自然、人文主题；花瓣展开，选中叶片扩展进入章节。' },
  { id: 'orbit', label: '知识轨道', hint: '适合科技与系统关系；章节围绕核心主题展开。' },
  { id: 'steps', label: '章节阶梯', hint: '适合汇报、提案与递进讲解；章节依次显现。' },
];

const css = `
.wds-nav{position:absolute;inset:0;width:1920px;height:1080px;color:var(--wpx-fg,#f2eee6);font-family:var(--wpx-sans,sans-serif)}
.wds-nav-head{position:absolute;left:120px;top:168px;width:510px}
.wds-nav-eyebrow{font-size:24px;letter-spacing:5px;opacity:.55;margin-bottom:44px}
.wds-nav-title{font-size:94px;font-weight:600;line-height:1.15;letter-spacing:-3px;overflow-wrap:anywhere}
.wds-nav-subtitle{font-size:29px;line-height:1.65;opacity:.64;margin-top:40px;max-width:470px}
.wds-nav-rule{width:72px;height:3px;background:var(--wpx-accent,#b9d5a4);margin-top:58px}
.wds-nav-footer{position:absolute;left:120px;bottom:92px;font-size:22px;opacity:.5}
.wds-nav-core{position:absolute;left:1140px;top:450px;width:220px;height:220px;border:1px solid currentColor;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:25px;letter-spacing:4px;opacity:.48}
.wds-nav-ring{position:absolute;left:900px;top:210px;width:700px;height:700px;border:1px solid currentColor;border-radius:50%;opacity:.1}
.wds-nav-node{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:1px solid color-mix(in srgb,currentColor 20%,transparent);background:var(--nav-color,var(--wpx-accent,#b9d5a4));color:var(--nav-ink,#17251d);padding:24px;cursor:pointer;font:inherit;text-align:center;transform:rotate(var(--angle,0deg));transform-origin:center;transition:filter .22s,box-shadow .22s}
.wds-nav-node:hover{filter:brightness(1.12);box-shadow:0 12px 65px #0002}
.wds-nav-node:focus-visible{outline:4px solid var(--wpx-fg);outline-offset:8px}
.wds-nav-label{display:block;transform:rotate(var(--counter-angle,0deg));width:100%;pointer-events:none}
.wds-nav-number{display:block;font-size:22px;letter-spacing:3px;opacity:.5;margin-bottom:13px}
.wds-nav-name{display:block;font-size:32px;font-weight:600;line-height:1.25;overflow-wrap:anywhere}
.wds-nav-desc{display:block;font-size:23px;line-height:1.4;opacity:.7;margin-top:9px}
.wds-nav-petals .wds-nav-node{border-radius:74% 16% 74% 16%}
.wds-nav-orbit .wds-nav-node{border-radius:50%}
.wds-nav-steps .wds-nav-node{justify-content:flex-start;text-align:left;border-radius:8px;background:color-mix(in srgb,var(--nav-color) 13%,transparent);color:var(--wpx-fg);border-left:5px solid var(--nav-color);padding:24px 40px}
.wds-nav-steps .wds-nav-number{display:inline-block;width:90px;margin:0;vertical-align:middle}
.wds-nav-steps .wds-nav-name{display:inline-block;vertical-align:middle}
.wds-nav-steps .wds-nav-desc{margin-left:90px}
@keyframes wds-nav-unfold{from{opacity:0;transform:translate(var(--gather-x,0px),var(--gather-y,0px)) rotate(calc(var(--angle,0deg) - 32deg)) scale(.18)}to{opacity:1;transform:translate(0,0) rotate(var(--angle,0deg)) scale(1)}}
body:not(.wpx-editing) .is-active .wds-nav-node{animation:wds-nav-unfold .85s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--order,0)*85ms)}
@media(prefers-reduced-motion:reduce){.wds-nav-node{animation:none!important;transition:none!important}}
`;

export function buildNavigationHTML(options = {}, seed = 'nav') {
  const style=options.style||(options.html?'custom':'steps');
  const chapters = options.chapters || [];
  if(style==='custom') {
    if(chapters.length<2||chapters.length>24)throw new Error('自定义目录需要 2–24 个章节');
    let html=String(options.html||'').trim();const customCss=String(options.css||'');
    if(!html)throw new Error('自定义目录需要 HTML / SVG 内容，不能退回固定样式');
    if(/<\/?(?:script|iframe|object|embed)\b|\son\w+\s*=|javascript\s*:/i.test(html)||/<\/style/i.test(customCss))throw new Error('目录仅接受 HTML / SVG 和 CSS，脚本请使用工程 JS 工具');
    if(html.length+customCss.length>200000)throw new Error('目录代码超过 200000 字符');
    for(let i=0;i<chapters.length;i++) {
      const token=`{{target:${i}}}`;
      if(!chapters[i].targetId||!html.includes(token))throw new Error(`目录缺少章节 ${i+1} 的有效链接：${token}`);
      const linked=new RegExp(`data-wds-target=["']\\{\\{target:${i}\\}\\}["']`,'i').test(html)&&new RegExp(`data-wpx-action=["']go-id:\\{\\{target:${i}\\}\\}["']`,'i').test(html);
      if(!linked)throw new Error(`章节 ${i+1} 需使用 data-wds-target="${token}" 和 data-wpx-action="go-id:${token}"`);
      html=html.split(token).join(esc(chapters[i].targetId));
    }
    if(/\{\{target:/.test(html))throw new Error('目录引用了不存在的章节');
    return `<style data-wds-navigation-style>.wds-nav-custom{position:absolute;inset:0;width:1920px;height:1080px;color:var(--wpx-fg);font-family:var(--wpx-sans)}${customCss}</style><div class="wds-nav-custom" data-wds-navigation="custom" data-wds-nav-transition="page">${html}</div>`;
  }
  if(!NAVIGATION_STYLES.some(s=>s.id===style))throw new Error('未知目录形式；原创布局请使用 custom 并提供 HTML / CSS');
  if (chapters.length < 2 || chapters.length > 6) throw new Error('目录需要 2–6 个章节；更多内容请分层组织');
  const colors = ['#bed6a7', '#e2c9a4', '#b2ccc9', '#d9b6a7', '#c5bed9', '#b6c9e0'];
  const nodes = chapters.map((chapter, i) => {
    if (!chapter.targetId) throw new Error(`章节「${chapter.title || i + 1}」缺少有效目标页面`);
    if (String(chapter.title || '').length > 24) throw new Error('章节标题最多 24 字，请用简洁的章节名');
    const angle = -90 + 360 * i / chapters.length, radians = angle * Math.PI / 180;
    const orbit = style === 'orbit', steps = style === 'steps';
    const w = steps ? 930 : orbit ? 225 : 310, h = steps ? Math.min(160, 800 / chapters.length - 20) : orbit ? 225 : 215;
    const x = steps ? 780 : 1250 + Math.cos(radians) * 284 - w / 2;
    const y = steps ? 145 + i * (800 / chapters.length) : 560 + Math.sin(radians) * 284 - h / 2;
    const rotate = style === 'petals' ? angle + 45 : 0;
    const color = /^#[0-9a-f]{3,8}$/i.test(chapter.color || '') ? chapter.color : colors[i];
    const desc = steps && chapter.description ? `<span class="wds-nav-desc">${esc(String(chapter.description).slice(0, 42))}</span>` : '';
    return `<button type="button" class="wpx-el wds-nav-node" data-wpx-el="${esc(seed)}-${i}" data-wpx-type="html" data-wds-target="${esc(chapter.targetId)}" data-wpx-action="go-id:${esc(chapter.targetId)}" aria-label="进入章节：${esc(chapter.title)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;--angle:${rotate}deg;--counter-angle:${-rotate}deg;--order:${i};--gather-x:${1250 - x - w / 2}px;--gather-y:${560 - y - h / 2}px;--nav-color:${color}"><span class="wds-nav-label"><span class="wds-nav-number">${String(i + 1).padStart(2, '0')}</span><span class="wds-nav-name">${esc(chapter.title)}</span>${desc}</span></button>`;
  }).join('');
  return `<style data-wds-navigation-style>${css}</style><div class="wds-nav wds-nav-${style}" data-wds-navigation="${style}"><div class="wpx-el wds-nav-head" data-wpx-el="${esc(seed)}-head" data-wpx-type="text"><div class="wds-nav-eyebrow">CONTENTS / ${String(chapters.length).padStart(2,'0')}</div><div class="wds-nav-title">${esc(options.title || '沿着问题，\n逐步展开').replace(/\n/g,'<br>')}</div><div class="wds-nav-subtitle">${esc(options.subtitle || '从整体看到细节。选择一个章节，开始探索。')}</div><div class="wds-nav-rule"></div></div>${style === 'steps' ? '' : '<div class="wds-nav-ring"></div><div class="wds-nav-core">探索路径</div>'}${nodes}<div class="wds-nav-footer">${esc(options.footer || '点击章节进入 · 方向键顺序放映')}</div></div>`;
}

export function resolveChapters(chapters, slides, directoryIndex) {
  const used = new Set();
  return chapters.map((chapter) => {
    const index = Number(chapter.slideIndex);
    const target = Number.isInteger(index) ? slides[index] : null;
    if (!target || index === directoryIndex || used.has(index)) throw new Error('目录章节必须指向不同的有效页面，且不能指向自身');
    used.add(index);
    return { ...chapter, title: chapter.title || target.name, targetId: target.id };
  });
}
