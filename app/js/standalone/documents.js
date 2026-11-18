import { Buffer } from 'buffer';
import {createExportPlan,exportReferences,scriptKind,shouldKeepRuntime,optimizeExportCss,optimizeExportHtml,exportManifest} from '../core/export-plan.js';
const mime = (name) => ({ css:'text/css', js:'text/javascript', mjs:'text/javascript', html:'text/html', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', svg:'image/svg+xml', woff2:'font/woff2', woff:'font/woff', ttf:'font/ttf', pdf:'application/pdf' }[name.split('.').pop()] || 'application/octet-stream');
export const fromData = (value) => /^data:/.test(value) ? Buffer.from(value.slice(value.indexOf(',')+1), 'base64') : Buffer.from(value || '');
export const asData = (name, bytes) => `data:${mime(name)};base64,${Buffer.from(bytes).toString('base64')}`;
const script = (value) => value.replace(/<!--/g,'\\x3c!--').replace(/<\/script/gi, '<\\/script');
const json = (value) => JSON.stringify(value).replace(/</g,'\\u003c');

export function createDocuments(state, bundle) {
  const resources = bundle.resources;
  function file(pathname, files) {
    const resource = resources[pathname];
    if (resource) return resource;
    const relative = pathname.replace(/^\/p\/[^/]+\//, '');
    return files?.[relative];
  }
  function asset(url, base, files) {
    if (/^(data:|https?:|blob:|#|\/\/)/i.test(url)) return url;
    const path = new URL(url, 'https://webdeck.local'+base).pathname;
    const value = file(decodeURIComponent(path), files);
    return value === undefined ? url : /^data:/.test(value) ? value : asData(path, value);
  }
  function css(text, base, files) {
    return text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (all,q,url) => `url("${asset(url,base,files)}")`);
  }
  function prepare(source, base, files, { edit=false, present=true, query='', hash='', projectId='', raw=false, patches=[], timeline=null, config={},portable=false,fragment=false,exportPlan=null,mathStyles=new Set(),hoistedStyles=[] } = {}) {
    let html=source.replace(/<base\b[^>]*>/gi,'').replace(/<script\b[^>]*data-wds-standalone[^>]*>[\s\S]*?<\/script>/gi,'');
    let plan=exportPlan;
    if(portable&&!plan){
      const sources={};
      for(const [url] of exportReferences(html,{patches,timeline})){
        if(/^(https?:|data:|blob:|\/\/)/i.test(url))continue;
        const path=new URL(url,'https://webdeck.local'+base).pathname,value=file(decodeURIComponent(path),files);if(value!==undefined)sources[url]=fromData(value).toString();
      }
      plan=createExportPlan(html,{patches,timeline,config,sources});
    }
    const full=!fragment&&/<(?:html|head|body)\b|<!doctype/i.test(html);
    if(full&&!raw&&resources['/editor/deck-runtime.js']) html=html.replace(/<script\b[^>]*\bid=["']wpx-runtime["'][^>]*>[\s\S]*?<\/script>/i,()=>`<script id="wpx-runtime">${script(fromData(resources['/editor/deck-runtime.js']).toString())}</script>`);
    if(full) {
      html=html.replace(/<script\b[^>]*data-wds-runtime=["'](?:timeline-content|presentation-tools|three|three-bundle|type)["'][^>]*>[\s\S]*?<\/script>/gi,'');
      const usesThree=portable?plan.three:/data-wds-three(?:[\s="'\\>]|$)/i.test(html)||/data-wds-three(?:[\s="'\\>]|$)/i.test(JSON.stringify(patches));
      const usesType=portable?plan.typeset:/data-wds-type(?:[\s="'\\>]|$)/i.test(html)||/data-wds-type/.test(JSON.stringify(patches));
      const runtime=(!portable||plan.timelineContent?'<script data-wds-runtime="timeline-content" src="/editor/timeline-content.js"></script>':'')+
        (usesThree?'<script data-wds-runtime="three-bundle" src="/app/vendor/three/three-bundle.js"></script>':'')+
        (edit||usesThree?'<script data-wds-runtime="three" src="/editor/three-runtime.js"></script>':'')+
        (usesType?'<script data-wds-runtime="type" src="/editor/type-runtime.js"></script>':'');
      html=/<head\b/i.test(html)?html.replace(/<head\b[^>]*>/i,m=>m+runtime):runtime+html;
    }
    const bootstrap = `<script data-wds-standalone>window.__WDS_EMBED__=${json({search:query,hash,projectId})};${edit ? 'window.fetch=function(a,b){return parent.__WDS_STATIC__.fetch(a,b)};window.__WDS_THREE_URL__='+json(resources['/app/vendor/three/three-bundle.js']||'')+';window.__WDS_THREE_RUNTIME_URL__='+json(resources['/editor/three-runtime.js']||'')+';' : ''}</script>`;
    if(!fragment)html=html.replace(/<head\b[^>]*>/i,(s)=>s+bootstrap);
    const data=(id,value)=>`<script type="application/json" id="${id}">${json(value)}</script>`;
    let tags='';
    if(full && !edit && present) tags+='<script data-wds-runtime="presentation-tools" src="/editor/presentation-tools.js"></script>';
    if(raw){
      tags+=data('wpx-deck-config',config);
      if(patches.length)tags+=data('wpx-raw-patches',patches)+'<script data-wds-runtime="raw-patches" src="/editor/raw-patches.js"></script>';
      if(timeline&&(!portable||plan.timeline))tags+=data('wpx-timeline',timeline)+'<script data-wds-runtime="timeline-player" src="/editor/timeline-player.js"></script>';
      for(const [kind,name] of [['fx','fx-presets'],['web-runtime','web-runtime'],['present-shell','present-shell']])if((kind!=='present-shell'||!edit)&&(!portable||shouldKeepRuntime(kind,plan)))tags+=`<script data-wds-runtime="${kind}" src="/editor/${name}.js"></script>`;
    }
    if(edit) tags+='<script id="wpx-bridge" src="/editor/bridge.js"></script>';
    html=html.includes('</body>')?html.replace('</body>',()=>tags+'</body>'):html+tags;
    const packCss=(text,path,attrs='',nested=fragment)=>{
      if(!portable)return css(text,path,files);
      const math=/katex/i.test(path)||/font-family\s*:\s*["']?KaTeX_/i.test(text);
      if(math){
        if(!plan.math){plan.removed.push('math-css');return '';}
        const key=text+'|'+(/\bmedia=(["'])(.*?)\1/i.exec(attrs)?.[2]||'');
        if(mathStyles.has(key)){plan.removed.push('duplicate:math-css');return '';}
        mathStyles.add(key);
      }
      const packed=css(optimizeExportCss(text,plan,{math}),path,files);
      if(math&&nested){hoistedStyles.push('<style>'+packed.replace(/<\/style/gi,'<\\/style')+'</style>');return '';}
      return packed;
    };
    // Complete blocks protect user JavaScript from URL and markup rewrites.
    html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>|<style\b([^>]*)>([\s\S]*?)<\/style>|<[a-z][^>]*>/gi,(tag,scriptAttrs,code,styleAttrs,styleCode)=>{
      if(scriptAttrs!==undefined){
        const kind=scriptKind(scriptAttrs,code),url=/\bsrc=["']([^"']+)["']/i.exec(scriptAttrs)?.[1];
        if(portable&&kind&&!shouldKeepRuntime(kind,plan)){plan.removed.push(kind);return '';}
        if(!url||/^(https?:|data:|blob:|\/\/)/i.test(url))return tag;
        const path=new URL(url,'https://webdeck.local'+base).pathname,value=file(decodeURIComponent(path),files);if(value===undefined)return tag;
        let text=fromData(value).toString();
        if(path.startsWith('/editor/'))text=text.replaceAll('location.search','(window.__WDS_EMBED__?.search || location.search)').replaceAll("(location.hash || '')","(location.hash || window.__WDS_EMBED__?.hash || '')");
        if(path.endsWith('/bridge.js'))text=text.replace('var PARENT_ORIGIN = location.origin;',"var PARENT_ORIGIN = location.origin === 'null' ? '*' : location.origin;").replace("var m = /\\/p\\/([^/]+)\\//.exec(location.pathname);","if(window.__WDS_EMBED__?.projectId)return window.__WDS_EMBED__.projectId;var m = /\\/p\\/([^/]+)\\//.exec(location.pathname);");
        const attrs=scriptAttrs.replace(/\bsrc=["'][^"']+["']/i,'');
        return '<script '+attrs+(kind&&!/\bdata-wds-runtime=/.test(attrs)?' data-wds-runtime="'+kind+'"':'')+'>'+script(text)+'</script>';
      }
      if(styleAttrs!==undefined){const text=packCss(styleCode,base,styleAttrs);return text?'<style'+styleAttrs+'>'+text.replace(/<\/style/gi,'<\\/style')+'</style>':(raw||fragment?'<style></style>':'');}
      if(/^<link\b/i.test(tag)){
      if(!/rel=["']stylesheet["']/i.test(tag))return tag;
      const url=/href=["']([^"']+)["']/i.exec(tag)?.[1];if(!url||/^(https?:|data:|\/\/)/i.test(url))return tag;
      const path=new URL(url,'https://webdeck.local'+base).pathname,value=file(decodeURIComponent(path),files);
      if(value===undefined)return tag;
      const text=packCss(fromData(value).toString(),path,tag);if(!text)return raw||fragment?'<style></style>':'';
      const attrs=tag.slice(5,-1).replace(/\b(?:href|rel|integrity|crossorigin)=["'][^"']*["']/gi,'');
      return '<style'+attrs+'>'+text.replace(/<\/style/gi,'<\\/style')+'</style>';
      }
      if(/^<(?:img|video|audio|source)\b/i.test(tag))tag=tag.replace(/\b(src|poster)=(["'])([^"']+)\2/gi,(_,name,q,url)=>name+'='+q+asset(url,base,files)+q);
      return tag.replace(/\b(style|fill|stroke|filter|mask|clip-path)=(["'])(.*?)\2/gi,(_,name,q,text)=>name+'='+q+css(text,base,files).replaceAll(q,q==='"'?'&quot;':'&#39;')+q);
    });
    html=html.replace(/(<script\b[^>]*id="(?:wpx-raw-patches|wpx-timeline)"[^>]*>)([\s\S]*?)(<\/script>)/gi,(all,a,text,b)=>{
      try { const inline=(v,key='')=>{
        if(typeof v==='string'){
          if(key==='html')return prepare(v,base,files,{fragment:true,portable,exportPlan:plan,mathStyles,hoistedStyles});
          if(key==='css')return packCss(v,base,'',true);
          if(key==='cssText')return css(v,base,files);
          if(['src','poster'].includes(key))return asset(v,base,files);
          return v;
        }
        return Array.isArray(v)?v.map(x=>inline(x)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,inline(x,k)])):v;
      };return a+json(inline(JSON.parse(text)))+b; } catch {return all;}
    });
    if(!fragment&&hoistedStyles.length){const tags=hoistedStyles.join('');html=/<\/head>/i.test(html)?html.replace(/<\/head>/i,()=>tags+'</head>'):tags+html;}
    return portable&&!fragment?exportManifest(optimizeExportHtml(html,plan),plan):html;
  }
  function projectDoc(id, query='', filesOverride=null, metaOverride=null, hash='', portable=false) {
    const project=state.projects[id];if(!project)throw new Error('工程不存在');
    const files=filesOverride||project.files,meta=metaOverride||project.meta;
    return prepare(files['index.html'],`/p/${id}/index.html`,files,{edit:new URLSearchParams(query).get('wpx')==='edit',query,hash,projectId:id,raw:meta.kind==='raw',portable,
      patches:JSON.parse(files['.raw-edits.json']||'{}').patches||[],timeline:JSON.parse(files['.raw-timeline.json']||'{}').timeline,config:JSON.parse(files['.raw-deck.json']||'{}').config||{}});
  }
  function documentFor(value) {
    const url=new URL(value,'https://webdeck.local'),path=decodeURIComponent(url.pathname), project=/^\/p\/([^/]+)\/(.*)$/.exec(path);
    if(project){if(project[2]==='index.html'||!project[2])return projectDoc(project[1],url.search,null,null,url.hash);const p=state.projects[project[1]];return prepare(p.files[project[2]],path,p.files,{query:url.search,hash:url.hash});}
    const template=/^\/(templates|samples)\/([^/]+)\/index.html$/.exec(path);
    if(template){const item=template[1]==='templates'?(state.templates[template[2]]||bundle.templates[template[2]]):bundle.samples[template[2]];if(!item)throw new Error('模板不存在');return prepare(item.files['index.html'],path,item.files,{query:url.search});}
    const match=/^\/api\/projects\/([^/]+)\/(thumb|export|versions\/([^/]+)\/(preview|present|export))$/.exec(path);
    if(match){const p=state.projects[match[1]],version=match[3]&&p?.versions.find((v)=>v.id===match[3]);
      if(match[3]&&!version)throw new Error('版本不存在');
      return projectDoc(match[1],match[2]==='thumb'?'?wpx=thumb&slide='+url.searchParams.get('slide'):'',version?.files,version?.meta,'',match[2]==='export'||match[4]==='export');}
    throw new Error('静态网页无法打开：'+path);
  }
  function bridgeParams(frame, method, params) {
    const id=frame?.contentWindow?.__WDS_EMBED__?.projectId,p=state.projects[id];
    if(!p)return params;
    const base=`/p/${id}/index.html`;
    const transform=(value,key)=>{
      if(typeof value==='string'){
        if(key==='html')return prepare(value,base,p.files);
        if(['src','poster','href'].includes(key))return asset(value,base,p.files);
        if(key==='css'||value.includes('url('))return css(value,base,p.files);
        return value;
      }
      if(Array.isArray(value))return value.map((item)=>transform(item,''));
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,transform(v,k)]));
      return value;
    };
    return transform(params,'');
  }
  return { prepare, projectDoc, documentFor, asset, bridgeParams };
}
