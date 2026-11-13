import path from 'node:path';

const MIME={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg'};
const safeScript=(s)=>s.replace(/<\/script/gi,'<\\/script');
async function replaceAsync(text,re,fn){const matches=[...text.matchAll(re)],values=await Promise.all(matches.map(fn));let i=0;return text.replace(re,()=>values[i++]);}

export async function deckDocument({read,shared,base='',portable=false}) {
  let html=(await read('index.html'))?.toString();
  if(!html)throw Object.assign(new Error('版本中的网页不存在'),{status:404});
  const json=async(rel)=>{try{return JSON.parse((await read(rel))?.toString()||'null');}catch{return null;}};
  const project=await json('project.json');
  if(project?.kind==='raw') {
    const patches=(await json('.raw-edits.json'))?.patches||[],timeline=(await json('.raw-timeline.json'))?.timeline,config=(await json('.raw-deck.json'))?.config||{};
    const data=(id,v)=>`<script type="application/json" id="${id}">${JSON.stringify(v).replace(/</g,'\\u003c')}</script>`;
    let tags=data('wpx-deck-config',config);
    if(patches.length)tags+=data('wpx-raw-patches',patches)+`<script src="/editor/raw-patches.js"></script>`;
    if(timeline)tags+=data('wpx-timeline',timeline)+`<script src="/editor/timeline-player.js"></script>`;
    tags+='<script src="/editor/fx-presets.js"></script><script src="/editor/web-runtime.js"></script><script src="/editor/present-shell.js"></script>';
    html=html.includes('</body>')?html.replace('</body>',()=>tags+'\n</body>'):html+tags;
  }
  if(!portable){const tag=`<base href="${base}">`;if(/<head\b/i.test(html))return html.replace(/<head\b[^>]*>/i,(m)=>m+tag);if(/<html\b/i.test(html))return html.replace(/<html\b[^>]*>/i,(m)=>m+'<head>'+tag+'</head>');return '<!doctype html><html><head>'+tag+'</head><body>'+html.replace(/<!doctype[^>]*>/gi,'')+'</body></html>';}
  const resolve=(url,from='')=>{
    if(/^(data:|https?:|\/\/|#|blob:|javascript:)/i.test(url))return null;
    let clean;try{clean=decodeURIComponent(url.split(/[?#]/)[0]);}catch{return null;}
    const file=clean.startsWith('/')?path.posix.normalize(clean):path.posix.normalize(path.posix.join(path.posix.dirname(from),clean));
    if(file.startsWith('../')||file.includes('\\'))return null;
    return file;
  };
  const bytes=async(file)=>file.startsWith('/')?shared(file):read(file);
  const asset=async(url,from)=>{const file=resolve(url,from);if(!file)return url;const data=await bytes(file).catch(()=>null);return data?`data:${MIME[path.posix.extname(file)]||'application/octet-stream'};base64,${data.toString('base64')}`:url;};
  const css=async(text,from)=>replaceAsync(text,/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi,async(m)=>{const value=await asset(m[2],from);return value===m[2]?m[0]:`url(${value})`;});
  html=await replaceAsync(html,/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi,async(m)=>{const href=/href=["']([^"']+)["']/i.exec(m[0])?.[1],file=href&&resolve(href);if(!file)return m[0];const data=await bytes(file).catch(()=>null);return data?`<style>${(await css(data.toString(),file)).replace(/<\/style/gi,'<\\/style')}</style>`:m[0];});
  html=await replaceAsync(html,/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi,async(m)=>{const file=resolve(m[1]);if(!file)return m[0];const data=await bytes(file).catch(()=>null);return data?`<script>${safeScript(data.toString())}</script>`:m[0];});
  html=await replaceAsync(html,/(<(?:img|video|audio|source)\b[^>]*?\b(?:src|poster)=["'])([^"']+)(["'])/gi,async(m)=>m[1]+await asset(m[2])+m[3]);
  html=await css(html,'index.html');
  // Raw edits store inserted markup inside JSON; bundle those nested fragments too.
  html=await replaceAsync(html,/(<script\b[^>]*id="wpx-raw-patches"[^>]*>)([\s\S]*?)(<\/script>)/gi,async(m)=>{
    const bundle=async(value)=>{
      if(typeof value==='string'&&/<(?:link|img|video|source)\b|url\(/i.test(value))return deckDocument({read:async(rel)=>rel==='index.html'?Buffer.from(value):rel==='project.json'?Buffer.from('{}'):read(rel),shared,portable:true});
      if(Array.isArray(value))return Promise.all(value.map(bundle));
      if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([k,v])=>[k,await bundle(v)])));
      return value;
    };
    return m[1]+JSON.stringify(await bundle(JSON.parse(m[2]))).replace(/</g,'\\u003c')+m[3];
  });
  return html.replace(/<base\b[^>]*>/gi,'');
}
