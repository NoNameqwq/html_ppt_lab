import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { setWorkspaceRestoring } from '../core/api.js';

const size=n=>n>1024*1024?(n/1024/1024).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
const date=n=>n?new Date(n).toLocaleString():'尚无';
export function createWebDAVForm(ctx,initial,error=''){
  let config=initial?.config||{},state=initial?.status||{},dirty=false,disposed=false,timer=null,working=false;
  const fields={},el=h('section',{class:'ais-service-form dav-settings'});
  const staticMode=!!window.__WDS_STATIC__;
  const status=h('div',{class:'dav-status',role:'status','aria-live':'polite'}),list=h('div',{class:'dav-backups'});
  const heading=h('div',{class:'ais-section-heading'},h('strong',{},'WebDAV 云端备份'),h('p',{},'挂载自己的云盘，压缩备份工程、对话、历史版本、模板和元素收藏。默认每天备份，也可以随时手动备份。'));
  function field(key,label,type='text',placeholder=''){
    const input=h('input',{class:'input',type,'aria-label':label,placeholder,...(type==='checkbox'?{checked:!!config[key]}:{value:type==='password'?'':config[key]||''})});
    input.addEventListener('input',()=>{dirty=true;});fields[key]=input;
    return h('label',{class:'ais-field'+(type==='checkbox'?' dav-switch':'')},h('span',{class:'ais-label'},label),input);
  }
  const grid=h('div',{class:'dav-grid'},field('baseUrl','WebDAV 地址','url','https://dav.example.com/dav/'),field('folder','备份目录','text','WebDeck'),
    field('username','账号'),field('password','WebDAV 密码','password',config.passwordSet?'已保存，留空保留':'输入密码或应用专用密码'),
    field('dailyTime','每日备份时间','time'),field('timeZone','备份时区','text','Asia/Shanghai'));
  const message=h('p',{class:'ais-subline'},staticMode?'单文件模式：网页打开时自动备份，错过会在下次打开补做。云盘需允许 file:// 页面的跨域访问，以及 PROPFIND、MKCOL、PUT、MOVE 和 GET。':'BAT 模式：后端运行期间每日自动备份，错过会在下次启动补做。无需映射系统盘符。');
  const enabled=field('enabled','启用 WebDAV 挂载','checkbox'),automatic=field('autoBackup','每天自动备份','checkbox'),keys=field('includeSettings','备份中包含 API 配置和密钥','checkbox');
  const hint=h('p',{class:'ais-subline'},'备份 ZIP 包含完整历史版本。API 密钥默认排除；WebDAV 密码始终排除。恢复会覆盖同名文件并保留额外本地内容，开始前自动保存本地恢复副本。BAT 与单文件备份请在对应模式恢复。');
  const buttons=[];
  const button=(label,glyph,fn)=>{const node=h('button',{type:'button',class:'btn btn--sm',onClick:()=>void action(fn)},h('span',{html:icon(glyph,14)}),label);buttons.push(node);return node;};
  function patch(){return Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.type==='checkbox'?input.checked:input.value]));}
  async function save(){if(!dirty)return;if(error)throw new Error(error);const result=await ctx.api.putWebDAV(patch());config=result.config;fields.password.value='';fields.password.placeholder=config.passwordSet?'已保存，留空保留':'输入密码或应用专用密码';dirty=false;}
  async function flush(){
    if(ctx.agent?.loop?.streaming)throw new Error('请先等待 Agent 完成或停止生成，再备份或恢复');
    if(ctx.getEditor?.()?.projectId){const result=await ctx.getEditor().saveNow({reason:'cloud-backup'});if(result?.ok===false)throw new Error(result.error||'工程保存失败');}
    await ctx.agent?.loop?.flush(true);
  }
  function renderStatus(){
    status.classList.toggle('is-error',!!state.lastError);
    status.replaceChildren(h('strong',{},state.busy?(state.operation==='restore'?'正在恢复 · ':'正在备份 · ')+(state.progress||'准备中'):state.lastError||'挂载后，工作区会每天自动备份'),
      h('small',{},'上次成功备份：'+date(state.lastSuccessAt)+(state.lastBackup?' · '+size(state.lastBackup.size):'')),
      ...(state.recovery?[h('button',{class:'btn btn--sm',type:'button',onClick:()=>void action(()=>download(state.recovery.name,true))},'下载恢复前的本地副本')]:[]));
    for(const b of buttons)b.disabled=working||state.busy||!!error;
  }
  async function refresh(){state=await ctx.api.webDAVStatus();if(!disposed)renderStatus();}
  async function download(name,recovery=false){const response=await ctx.api.webDAVDownload(name,recovery),url=URL.createObjectURL(await response.blob());const a=h('a',{href:url,download:name});a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  async function restore(name){
    if(!await ctx.dialog.confirm('将恢复此云端备份，同名文件会被覆盖，额外本地内容会保留。恢复前会自动保存本地副本，完成后刷新工作台。',{title:'恢复工作区'}))return;
    await flush();
    ctx.workspaceRestoring=true;setWorkspaceRestoring(true);
    const app=document.getElementById('app'),inert=app?.inert;if(app)app.inert=true;
    const overlay=h('div',{class:'dav-restore-shield',role:'status'},h('span',{html:icon('refresh',28)}),h('strong',{},'正在恢复工作区'),h('p',{},'正在校验备份并保存本地副本，请保持页面打开。'));
    document.body.append(overlay);let started=false,finished=false;
    try{
      state=await ctx.api.webDAVRestore(name);started=true;
      do{await new Promise(r=>setTimeout(r,1000));state=await ctx.api.webDAVStatus();overlay.querySelector('p').textContent=state.progress||'处理中';}while(state.busy);
      finished=true;if(state.lastError)throw new Error(state.lastError);
      overlay.querySelector('p').textContent='恢复完成，正在刷新…';location.reload();
    }catch(e){
      if(!started||finished){overlay.remove();if(app)app.inert=inert;ctx.workspaceRestoring=false;setWorkspaceRestoring(false);throw e;}
      overlay.querySelector('p').textContent='无法确认恢复状态：'+e.message+'。重新载入后查看状态。';
      overlay.append(h('button',{class:'btn btn--primary',onClick:()=>location.reload()},'重新载入'));
    }
  }
  async function loadBackups(){
    await save();const data=await ctx.api.webDAVBackups();if(disposed)return;
    list.replaceChildren(...data.backups.map(b=>h('article',{class:'dav-backup'},h('div',{},h('strong',{},b.mode==='server'?'BAT 工作区':'单文件工作区'),h('small',{},date(b.modifiedAt)+' · '+size(b.size)),h('code',{},b.name)),
      h('div',{class:'dav-backup-actions'},h('button',{type:'button',class:'btn btn--sm',onClick:()=>void action(()=>download(b.name))},'下载'),
        h('button',{type:'button',class:'btn btn--sm',disabled:b.mode!==(staticMode?'static':'server'),onClick:()=>void action(()=>restore(b.name))},'恢复')))));
    if(!data.backups.length)list.append(h('p',{class:'ais-subline'},'云端还没有备份，点击「立即备份」保存第一份。'));
  }
  async function action(fn){if(working)return;working=true;renderStatus();try{await fn();}catch(e){ctx.toast.error(e.message);}finally{working=false;if(!disposed)renderStatus();}}
  el.append(heading,enabled,grid,automatic,keys,message,hint,h('div',{class:'dav-actions'},
    button('测试连接','globe',async()=>{await ctx.api.testWebDAV(patch());ctx.toast.ok('WebDAV 目录可连接');}),
    button('保存并挂载','save',async()=>{await save();ctx.toast.ok('WebDAV 配置已保存');}),
    button('立即备份','upload',async()=>{await save();await flush();state=await ctx.api.webDAVBackup();renderStatus();}),
    button('查看云端备份','history',loadBackups)),status,list);
  if(error)el.prepend(h('p',{class:'dav-status is-error'},error));renderStatus();
  return {el,save,activate(){if(!timer&&!disposed){void refresh().catch(()=>{});timer=setInterval(()=>void refresh().catch(()=>{}),2000);}},dispose(){disposed=true;clearInterval(timer);}};
}
