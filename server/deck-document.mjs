import path from 'node:path';
import {createExportPlan,exportReferences,scriptKind,shouldKeepRuntime,optimizeExportCss,optimizeExportHtml,exportManifest} from '../app/js/core/export-plan.js';
import { prependProjectFontStyle, projectFontCss, projectFontFace, projectFontStyle } from '../app/js/core/project-fonts.js';
import { projectFontFacesFor, splitProjectFontStyles } from '../app/js/core/project-font-export.js';

const MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg'};
const safeScript=(s)=>s.replace(/<!--/g,'\\x3c!--').replace(/<\/script/gi,'<\\/script');
async function replaceAsync(text,re,fn){const matches=[...text.matchAll(re)],values=await Promise.all(matches.map(fn));let i=0;return text.replace(re,()=>values[i++]);}

export async function deckDocument({read,shared,base='',portable=false}) {
  let html=(await read('index.html'))?.toString();
  if(!html)throw Object.assign(new Error('版本中的网页不存在'),{status:404});
  const json=async(rel)=>{try{return JSON.parse((await read(rel))?.toString()||'null');}catch{return null;}};
  const project=await json('project.json');
  const patches=project?.kind==='raw'?(await json('.raw-edits.json'))?.patches||[]:[],
    timeline=project?.kind==='raw'?(await json('.raw-timeline.json'))?.timeline:null,
    config=project?.kind==='raw'?(await json('.raw-deck.json'))?.config||{}:{};
  const resolve=(url,from='index.html')=>{
    if(/^(data:|https?:|\/\/|#|blob:|javascript:)/i.test(url))return null;
    let clean;try{clean=decodeURIComponent(url.split(/[?#]/)[0]);}catch{return null;}
    const file=clean.startsWith('/')?path.posix.normalize(clean):path.posix.normalize(path.posix.join(path.posix.dirname(from),clean));
    if(file.startsWith('../')||file.includes('\\'))return null;
    return file;
  };
  const cache=new Map();
  const bytes=async(file)=>{if(!cache.has(file))cache.set(file,Promise.resolve().then(()=>file.startsWith('/')?shared(file):read(file)).catch(()=>null));return cache.get(file);};
  let plan, embeddedFonts;
  if(portable){
    ({ html, embedded: embeddedFonts } = splitProjectFontStyles(html));
    const sources={};
    await Promise.all([...exportReferences(html,{patches,timeline})].map(async([url])=>{const file=resolve(url),data=file&&await bytes(file);if(data)sources[url]=data.toString();}));
    plan=createExportPlan(html,{patches,timeline,config,sources});
  }
  if (/<(?:html|head|body)\b|<!doctype/i.test(html)) {
    const tag='<script data-wds-runtime="timeline-content" src="/editor/timeline-content.js"></script>';
    html=html.replace(/<script\b[^>]*data-wds-runtime=["'](?:timeline-content|presentation-tools|three|three-bundle)["'][^>]*>[\s\S]*?<\/script>/gi,'');
    if(!portable||plan.timelineContent)html=/<head\b/i.test(html)?html.replace(/<head\b[^>]*>/i,m=>m+tag):tag+html;
    const tools='<script data-wds-runtime="presentation-tools" src="/editor/presentation-tools.js"></script>';
    html=html.includes('</body>')?html.replace('</body>',()=>tools+'</body>'):html+tools;
  }
  if(project?.kind==='raw') {
    const data=(id,v)=>`<script type="application/json" id="${id}">${JSON.stringify(v).replace(/</g,'\\u003c')}</script>`;
    let tags=data('wpx-deck-config',config);
    if(patches.length)tags+=data('wpx-raw-patches',patches)+`<script data-wds-runtime="raw-patches" src="/editor/raw-patches.js"></script>`;
    if(timeline&&(!portable||plan.timeline))tags+=data('wpx-timeline',timeline)+`<script data-wds-runtime="timeline-player" src="/editor/timeline-player.js"></script>`;
    for(const [kind,file] of [['fx','fx-presets'],['web-runtime','web-runtime'],['present-shell','present-shell']])if(!portable||shouldKeepRuntime(kind,plan))tags+=`<script data-wds-runtime="${kind}" src="/editor/${file}.js"></script>`;
    html=html.includes('</body>')?html.replace('</body>',()=>tags+'\n</body>'):html+tags;
  }
  // Keep the small observer available in previews for dynamically inserted 3D
  // components. Portable files carry the engine only when effective content,
  // including raw insertion patches, actually uses it.
  if (/<(?:html|head|body)\b|<!doctype/i.test(html)) {
    const usesThree=portable?plan.three:/data-wds-three(?:[\s="'\\>]|$)/i.test(html);
    if(!portable||usesThree) {
      const tags=(portable?'<script data-wds-runtime="three-bundle" src="/app/vendor/three/three-bundle.js"></script>':'')+
        '<script data-wds-runtime="three" src="/editor/three-runtime.js"></script>';
      html=/<head\b/i.test(html)?html.replace(/<head\b[^>]*>/i,m=>m+tags):tags+html;
    }
    // 艺术字：无动画的作品是纯 CSS，不需要运行时；有动画时才补（源稿或补丁里出现即可）
    const usesType=portable?plan.typeset:/data-wds-type(?:[\s="'\\>]|$)/i.test(html)||/data-wds-type/.test(JSON.stringify(patches));
    if(usesType) {
      const tag='<script data-wds-runtime="type" src="/editor/type-runtime.js"></script>';
      html=/<head\b/i.test(html)?html.replace(/<head\b[^>]*>/i,m=>m+tag):tag+html;
    }
  }
  if (!portable) {
    const tag = `<base href="${base}">` + projectFontStyle(projectFontCss());
    if (/<head\b/i.test(html)) return html.replace(/<head\b[^>]*>/i, head => head + tag);
    if (/<html\b/i.test(html)) return html.replace(/<html\b[^>]*>/i, root => root + '<head>' + tag + '</head>');
    return '<!doctype html><html><head>' + tag + '</head><body>' + html.replace(/<!doctype[^>]*>/gi, '') + '</body></html>';
  }
  const asset=async(url,from)=>{const file=resolve(url,from);if(!file)return url;const data=await bytes(file).catch(()=>null);return data?`data:${MIME[path.posix.extname(file)]||'application/octet-stream'};base64,${data.toString('base64')}`:url;};
  const css=async(text,from)=>replaceAsync(text,/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi,async(m)=>{const value=await asset(m[2],from);return value===m[2]?m[0]:`url(${value})`;});
  const mathStyles=new Set(),hoistedStyles=[];
  const placeholder=project?.kind==='raw'?'<style></style>':'';
  const packCss=async(code,from,attrs='',nested=false)=>{
    const math=/katex/i.test(from)||/font-family\s*:\s*["']?KaTeX_/i.test(code);
    if(math){
      if(!plan.math){plan.removed.push('math-css');return '';}
      const key=code+'|'+(/\bmedia=(["'])(.*?)\1/i.exec(attrs)?.[2]||'');
      if(mathStyles.has(key)){plan.removed.push('duplicate:math-css');return '';}
      mathStyles.add(key);
    }
    const packed=await css(optimizeExportCss(code,plan,{math}),from);
    if(math&&nested){hoistedStyles.push('<style>'+packed.replace(/<\/style/gi,'<\\/style')+'</style>');return '';}
    return packed;
  };
  // Parse complete script/style blocks first: asset rewriting must never touch
  // JavaScript strings, inline factories, or serialized user code.
  const pack=async(markup,nested=false)=>replaceAsync(markup,/<script\b([^>]*)>([\s\S]*?)<\/script>|<style\b([^>]*)>([\s\S]*?)<\/style>|<[a-z][^>]*>/gi,async(m)=>{
    if(m[1]!==undefined){
      const attrs=m[1],code=m[2],kind=scriptKind(attrs,code),src=/\bsrc=["']([^"']+)["']/i.exec(attrs)?.[1];
      if(kind&&!shouldKeepRuntime(kind,plan)){plan.removed.push(kind);return '';}
      if(!src)return m[0];
      const file=resolve(src),data=file&&await bytes(file);if(!data)return m[0];
      const kept=attrs.replace(/\bsrc=["'][^"']+["']/i,'');
      return '<script '+kept+(kind&&!/\bdata-wds-runtime=/.test(kept)?' data-wds-runtime="'+kind+'"':'')+'>'+safeScript(data.toString())+'</script>';
    }
    if(m[3]!==undefined){const code=await packCss(m[4],'index.html',m[3],nested);return code?'<style'+m[3]+'>'+code.replace(/<\/style/gi,'<\\/style')+'</style>':placeholder;}
    let tag=m[0];
    if(/^<link\b/i.test(tag)&&/\brel=["']stylesheet["']/i.test(tag)){
      const href=/\bhref=["']([^"']+)["']/i.exec(tag)?.[1],file=href&&resolve(href),data=file&&await bytes(file);if(!data)return tag;
      const code=await packCss(data.toString(),file,tag,nested);if(!code)return placeholder;
      const attrs=tag.slice(5,-1).replace(/\b(?:href|rel|integrity|crossorigin)=["'][^"']*["']/gi,'');
      return '<style'+attrs+'>'+code.replace(/<\/style/gi,'<\\/style')+'</style>';
    }
    if(/^<(?:img|video|audio|source)\b/i.test(tag))tag=await replaceAsync(tag,/\b(src|poster)=(["'])([^"']+)\2/gi,async(a)=>a[1]+'='+a[2]+await asset(a[3],'index.html')+a[2]);
    return replaceAsync(tag,/\b(style|fill|stroke|filter|mask|clip-path)=(["'])(.*?)\2/gi,async(a)=>a[1]+'='+a[2]+(await css(a[3],'index.html')).replaceAll(a[2],a[2]==='"'?'&quot;':'&#39;')+a[2]);
  });
  html=await pack(html);
  // Bundle data fields as fragments, without recursively injecting entire deck
  // runtimes into each insertion or touching scripts/LaTeX stored as strings.
  html=await replaceAsync(html,/(<script\b[^>]*id="(?:wpx-raw-patches|wpx-timeline)"[^>]*>)([\s\S]*?)(<\/script>)/gi,async(m)=>{
    const bundle=async(value,key='')=>{
      if(typeof value==='string'){
        if(key==='html')return pack(value,true);
        if(key==='css')return packCss(value,'index.html','',true);
        if(key==='cssText')return css(value,'index.html');
        if(['src','poster'].includes(key))return asset(value,'index.html');
        return value;
      }
      if(Array.isArray(value))return Promise.all(value.map(v=>bundle(v)));
      if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([k,v])=>[k,await bundle(v,k)])));
      return value;
    };
    return m[1]+JSON.stringify(await bundle(JSON.parse(m[2]))).replace(/</g,'\\u003c')+m[3];
  });
  if(hoistedStyles.length){const tags=hoistedStyles.join('');html=/<\/head>/i.test(html)?html.replace(/<\/head>/i,()=>tags+'</head>'):tags+html;}
  html = optimizeExportHtml(html.replace(/<base\b[^>]*>/gi, ''), plan);
  const fontStyles = [];
  for (const font of projectFontFacesFor(plan)) {
    for (const face of font.faces) {
      let rule = embeddedFonts.get(font.family + ':' + face.weight);
      if (!rule) {
        const dataUrl = await asset(face.url, 'index.html');
        if (dataUrl === face.url) continue;
        rule = projectFontFace(font, face, dataUrl);
      }
      plan.fontFamilies.add(font.family);
      fontStyles.push(rule);
    }
  }
  return exportManifest(prependProjectFontStyle(html, fontStyles.join('\n'), 'embedded'), plan);
}
