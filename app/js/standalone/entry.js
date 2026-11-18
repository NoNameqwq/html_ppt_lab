import { Buffer } from 'buffer';
import { openStorage } from './storage.js';
import { createBackend } from './backend.js';
import { networkHint } from './models.js';

globalThis.Buffer=Buffer;
const originalDocument=document.documentElement.cloneNode(true);
const bundled=JSON.parse(document.getElementById('wds-static-bundle').textContent);
const portable=JSON.parse(document.getElementById('wds-portable-state')?.textContent||'null');
const nativeFetch=window.fetch.bind(window);
const virtual=(url)=>/^\/(?:api|p|app|editor|templates|samples)\//.test(String(url));
const blob=(html)=>URL.createObjectURL(new Blob([html],{type:'text/html'}));
function download(value,name,type='text/html'){
  const href=URL.createObjectURL(new Blob([value],{type})),a=document.createElement('a');a.href=href;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(href),60000);
}
async function boot(){
  const storage=await openStorage(bundled.settings,portable),backend=createBackend(storage,bundled,nativeFetch);
  window.__WDS_STATIC__=backend;
  backend.pdfWorkerUrl=URL.createObjectURL(new Blob([Buffer.from(bundled.resources['/app/vendor/pdfjs/pdf.worker.min.mjs'].split(',')[1],'base64').toString()],{type:'text/javascript'}));
  window.fetch=async(input,init)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(virtual(url))return backend.fetch(url,init);
    try{return await nativeFetch(input,init);}catch(e){throw networkHint(e);}
  };
  const srcDescriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
  const docDescriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'srcdoc');
  const imageDescriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  const imageURL=(url)=>{
    const match=/^\/p\/([^/]+)\//.exec(String(url)),p=match&&backend.state.projects[match[1]];
    return p?backend.documents.asset(url,`/p/${match[1]}/index.html`,p.files):url;
  };
  Object.defineProperty(HTMLImageElement.prototype,'src',{...imageDescriptor,set(url){imageDescriptor.set.call(this,imageURL(url));}});
  Object.defineProperty(HTMLIFrameElement.prototype,'src',{...srcDescriptor,set(url){
    // srcdoc inherits the workbench origin, so editor tools can inspect the deck DOM.
    // A blob URL opened from file:// has a separate opaque origin in Chromium.
    if(virtual(url))docDescriptor.set.call(this,backend.documents.documentFor(url));
    else {this.removeAttribute('srcdoc');srcDescriptor.set.call(this,url);}
  }});
  Object.defineProperty(HTMLIFrameElement.prototype,'srcdoc',{...docDescriptor,set(html){
    const base=/<base\b[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
    if(base?.startsWith('/p/')){const pid=base.split('/')[2],p=backend.state.projects[pid];if(p)html=backend.documents.prepare(html,base,p.files,{present:false});}
    docDescriptor.set.call(this,html);
  }});
  const setAttribute=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){if((this instanceof HTMLIFrameElement||this instanceof HTMLImageElement)&&name.toLowerCase()==='src'){this.src=value;return;}return setAttribute.call(this,name,value);};
  const windowOpen=window.open.bind(window);
  window.open=function(url,...args){return windowOpen(virtual(url)?blob(backend.documents.documentFor(url))+new URL(url,'https://webdeck.local').hash:url,...args);};
  document.addEventListener('click',async(e)=>{
    const a=e.target.closest('a[href]'),href=a?.getAttribute('href');if(!a||!virtual(href))return;
    e.preventDefault();e.stopPropagation();
    try{
      if(a.hasAttribute('download')){const response=await backend.fetch(href);if(!response.ok)throw new Error((await response.json()).error.message);download(await response.blob(),href.includes('/templates/')?'模板.zip':'演示.html',response.headers.get('Content-Type'));}
      else window.open(href,a.target||'_blank');
    }catch(error){window.__WDS__?.toast.error(error.message);}
  },true);
  await import('../main.js');
  const wait=()=>new Promise((resolve)=>window.__WDS__?.bus?resolve():setTimeout(()=>wait().then(resolve),30));await wait();
  const ctx=window.__WDS__;ctx.standalone=true;
  async function flushWorkspace(){
    const saved=await ctx.getEditor()?.saveNow({reason:'backup'});
    if(saved?.ok===false)throw new Error(saved.error||'工程保存失败');
    await ctx.agent.loop.flush(true);
    await backend.persist();
  }
  async function backup(){await flushWorkspace();download(JSON.stringify(backend.state),'WebDeck-工作区备份.json','application/json');}
  async function portableHTML(){
    await flushWorkspace();
    const state=JSON.stringify({...backend.state,_exportId:crypto.randomUUID()}).replace(/</g,'\\u003c');
    const source=originalDocument.cloneNode(true);
    source.querySelector('#wds-portable-state')?.remove();
    const embedded=document.createElement('script');embedded.id='wds-portable-state';embedded.type='application/json';embedded.textContent=state;
    source.querySelector('head').append(embedded);
    download('<!doctype html>\n'+source.outerHTML,'WebDeck-私有工作台.html');
  }
  const menu=async()=>{
    const file=document.createElement('input');file.type='file';file.accept='.json';
    file.onchange=async()=>{try{const data=JSON.parse(await file.files[0].text());if(!data.settings||!data.projects||!data.templates||!data.chats)throw new Error('不是有效的 WebDeck 工作区备份');
      const answer=await ctx.dialog.confirm('导入备份会替换当前静态工作区。建议先导出当前备份。',{title:'导入工作区备份'});if(!answer)return;
      Object.keys(backend.state).forEach((key)=>delete backend.state[key]);Object.assign(backend.state,data);await backend.persist();location.reload();
    }catch(error){ctx.toast.error(error.message);}};
    const node=document.createElement('div');node.style.cssText='font-size:13px;line-height:1.8';
    node.textContent='工程、对话、版本和 API 配置保存在此浏览器中。导出的私有工作台包含当前工程和密钥，可在另一台电脑直接打开。API 服务需允许浏览器跨域访问。旧版 PPT、外观优先转换与磁盘目录浏览请使用 BAT 模式。';
    await ctx.dialog.open({title:'单文件工作台',sub:'无需 Node.js / 后端 · 本地浏览器存储',body:node,width:'lg',actions:[
      {label:'备份 JSON',kind:'ghost',onClick:async()=>{try{await backup();}catch(e){ctx.toast.error(e.message);}return false;}},
      {label:'导入备份',kind:'ghost',onClick:()=>{file.click();return false;}},
      {label:'导出私有 HTML',kind:'primary',onClick:async()=>{try{await portableHTML();}catch(e){ctx.toast.error(e.message);}return false;}},
      {label:'关闭',kind:'ghost',value:true},
    ]});
  };
  ctx.bus.registerCommand('app.staticWorkspace',menu,{label:'单文件工作区：备份 / 导出私有 HTML',group:'文件',icon:'download'});
  const button=document.createElement('button');button.className='btn btn--sm';button.textContent='单文件工作区';button.title='备份工作区、迁移数据与导出带配置的单个 HTML';button.style.cssText='position:fixed;right:12px;bottom:5px;z-index:200;font-size:11px;height:24px';button.onclick=menu;document.body.append(button);
  document.documentElement.dataset.runtime='standalone';
  backend.cloud.startScheduler();
  window.addEventListener('pagehide',()=>backend.cloud.stopScheduler());
  window.addEventListener('pageshow',()=>backend.cloud.startScheduler());
}
boot().catch((error)=>{console.error(error);const node=document.querySelector('.splash-tip');if(node)node.textContent='静态工作台启动失败：'+error.message;});
