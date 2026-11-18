import { Buffer } from 'buffer';
import JSZip from 'jszip';
import { convertPptx } from '../../../server/pptx.mjs';
import { publicImageSettings, updateImageSettings, generationPayload } from './image-config.js';
import { API_CATALOG } from '../agent/api-catalog.js';
import { fetchModels, chatResponse, remote } from './models.js';
import { asData, fromData, createDocuments } from './documents.js';
import { favoriteId, normalizeFavorite, favoriteSummary } from '../core/favorite-data.js';
import { createWebDAVManager } from '../core/webdav-manager.js';
import { webDAVResponse } from '../core/webdav-api.js';
import { normalizeWebDAV } from '../core/webdav-config.js';
import { workspaceGate } from '../core/workspace-gate.js';
import { browserWorkspace } from './webdav-workspace.js';
import { normalizeVisibleModels } from '../core/model-visibility.js';
import { archivePatch } from '../core/project-archive.js';

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const id=(prefix)=>prefix+'-'+crypto.randomUUID();
const parse=(value,fallback={})=>{try{return JSON.parse(value||'');}catch{return fallback;}};
const count=(html)=>(html.match(/class=["'][^"']*\bwpx-slide\b/g)||[]).length||1;
const safePath=(path)=>{if(!path||path.startsWith('/')||path.includes('\\')||path.split('/').some((p)=>p==='..'))throw fail('文件路径无效');return path;};
export function createBackend(storage,bundle,nativeFetch) {
  const {state,persist}=storage,documents=createDocuments(state,bundle);
  state.settings.providers ||= [];state.settings.agent ||= {};state.settings.search ||= {};
  state.elements ||= {};
  state.settings.imageGeneration={enabled:false,model:'auto',models:[],...state.settings.imageGeneration};
  let writes=Promise.resolve();
  state.webdavConfig=normalizeWebDAV({},state.webdavConfig||{});
  const gate=workspaceGate();
  const backupWorkspace=browserWorkspace(state,persist,()=>Promise.resolve());
  const cloud=createWebDAVManager({mode:'static',getConfig:()=>state.webdavConfig,
    saveConfig:async value=>{state.webdavConfig=value;await persist();},initialStatus:state.webdavStatus,
    saveStatus:async value=>{state.webdavStatus=value;await persist();},...backupWorkspace,
    snapshot:include=>gate.exclusive(()=>backupWorkspace.snapshot(include)),apply:data=>gate.exclusive(()=>backupWorkspace.apply(data)),fetcher:nativeFetch});
  const settings=()=>state.settings;
  const provider=(pid)=>settings().providers.find((p)=>p.id===pid)||settings().providers[0]||{};
  const publicSettings=()=>({...settings(),providers:settings().providers.map(({apiKey,...p})=>({...p,keySet:!!apiKey,keySource:apiKey?'browser':null})),
    search:((s)=>({provider:s.provider||'deepseek',baseUrl:s.baseUrl||'https://api.deepseek.com',maxResults:s.maxResults||5,keySet:!!(s.apiKey||provider('deepseek').apiKey)}))(settings().search),
    imageGeneration:publicImageSettings(settings().imageGeneration),skillsCatalog:bundle.skills});
  function updateSettings(patch,user=false) {
    if(patch.imageGeneration&&!user)throw fail('生图须由用户在 API 设置中手动开启',403);
    const next=structuredClone(settings());
    if(patch.imageGeneration)next.imageGeneration=updateImageSettings(next.imageGeneration,patch.imageGeneration);
    for(const key of ['ui','agent','search'])if(patch[key]){
      const p={...patch[key]};if(key==='search'){if(p.clearKey)p.apiKey='';else if(!p.apiKey)p.apiKey=next.search?.apiKey||'';delete p.clearKey;}
      next[key]={...next[key],...p};
    }
    if(patch.removeProviders)next.providers=next.providers.filter((p)=>!patch.removeProviders.includes(p.id));
    for(const p of patch.providers||[]){const previous=next.providers.find((v)=>v.id===p.id),key=p.clearKey?'':p.apiKey||previous?.apiKey||'';
      const merged={...previous,...p,apiKey:key};if(p.visibleModels!==undefined)merged.visibleModels=normalizeVisibleModels(p.visibleModels);delete merged.clearKey;if(previous)Object.assign(previous,merged);else next.providers.push(merged);}
    state.settings=next;return publicSettings();
  }
  const getProject=(pid)=>{const p=state.projects[pid];if(!p)throw fail('工程不存在',404);return p;};
  const projectInfo=(p)=>({...p.meta,slideCount:count(p.files['index.html']||''),size:(p.files['index.html']||'').length,hasOriginal:!!p.files['original/index.html']});
  function createProject(body,files=null,kind='native',report=null){
    const tpl=state.templates[body.templateId]||bundle.templates[body.templateId||'blank'];
    if(!tpl&&!files)throw fail('模板不存在');
    const pid=id('deck'),meta={...tpl?.meta,id:pid,name:body.name||tpl?.meta.name||'未命名演示',kind:files?kind:tpl.meta.kind||'native',archived:false,archivedAt:0,createdAt:Date.now(),updatedAt:Date.now(),
      cover:tpl?.meta.cover?.bg||'#151515',coverFg:tpl?.meta.cover?.fg||'#eeeeee',coverAccent:tpl?.meta.cover?.accent||'#bed6a7',origin:{template:body.templateId||'blank'},...(report?{importReport:report}:{})};
    state.projects[pid]={meta,files:structuredClone(files||tpl.files),chats:{},versions:[]};return projectInfo(state.projects[pid]);
  }
  async function importFiles(body){
    if(body.importId){const staged=state.imports[body.importId];if(!staged)throw fail('暂存附件不存在');body={...staged,...body};}
    if(body.sourcePath)throw fail('单文件模式请使用上传文件，磁盘目录浏览请使用 BAT 模式');
    if(body.sampleId){const sample=bundle.samples[body.sampleId];if(!sample)throw fail('示例不存在');return {files:sample.files,kind:'raw'};}
    if(/\.ppt$/i.test(body.fileName||'')||body.pptMode==='faithful')throw fail('旧版 PPT / PowerPoint 外观优先转换需要 BAT 模式；此处支持可编辑 PPTX');
    if(/\.pptx$/i.test(body.fileName||'')){
      const converted=await convertPptx(fromData(body.dataUrl),{name:body.name||body.fileName});
      return {files:{'index.html':converted.html,...Object.fromEntries([...converted.assets].map(([name,bytes])=>[name,asData(name,bytes)]))},kind:'native',report:converted.report};
    }
    if(/\.zip$/i.test(body.fileName||'')){
      const {openArchive}=await import('../../../server/archive.mjs'),zip=await openArchive(fromData(body.dataUrl)),files={};
      for(const entry of Object.values(zip.files).filter((f)=>!f.dir)){const name=safePath(entry.name);if(/(?:^|\/)\./.test(name)&&!/\.raw-/.test(name))continue;
        files[name]=/\.(html?|css|m?js|json|txt|md)$/i.test(name)?await entry.async('string'):asData(name,await entry.async('uint8array'));}
      if(!files['index.html'])throw fail('ZIP 需要在根目录包含 index.html');return {files,kind:parse(files['template.json']).kind||'raw'};
    }
    const html=body.content||(body.dataUrl?fromData(body.dataUrl).toString():'');if(!html.trim())throw fail('需要 HTML 或 PPTX 文件');
    return {files:{'index.html':html,'original/index.html':html},kind:'raw'};
  }
  const publicVersion=(v)=>({id:v.id,label:v.label,kind:v.kind,createdAt:v.createdAt,fileCount:Object.keys(v.files).length,bytes:JSON.stringify(v.files).length,hasConversation:!!v.chat,conversation:v.conversation,delivery:v.delivery,scope:'full'});
  function capture(p,body={}){
    const v={id:id('v'),label:body.label||'手动保存',kind:body.kind||'manual',createdAt:Date.now(),files:structuredClone(p.files),meta:structuredClone(p.meta),chat:body.chat?structuredClone(body.chat):null,conversation:body.conversation,delivery:body.delivery};
    if(v.chat&&v.conversation?.turnId){const turn=v.chat.messages?.find((m)=>m.turnId===v.conversation.turnId);if(turn){turn.versions||={};turn.versions[p.meta.id]||={};turn.versions[p.meta.id][v.conversation.phase]=v.id;}}
    p.versions.push(v);return v;
  }
  function changes(p,v){return [...new Set([...Object.keys(v.files),...Object.keys(p.files)])].filter((name)=>v.files[name]!==p.files[name]).map((path)=>({path,action:v.files[path]===undefined?'remove':p.files[path]===undefined?'restore':'replace'}));}
  async function search(body,draft){const cfg={...settings().search,...draft};const key=cfg.clearKey?'':cfg.apiKey||settings().search.apiKey||provider('deepseek').apiKey;
    if(!key)throw fail('请先配置搜索密钥');const tavily=cfg.provider==='tavily',base=(cfg.baseUrl||(tavily?'https://api.tavily.com':'https://api.deepseek.com')).replace(/\/+$/,'');
    const response=await remote(nativeFetch,base+(tavily?'/search':/\/v1$/.test(base)?'/tools/search':'/v1/tools/search'),{method:'POST',headers:{'Content-Type':'application/json',...(!tavily?{Authorization:'Bearer '+key}:{})},body:JSON.stringify(tavily?{api_key:key,query:body.query,max_results:cfg.maxResults||5}:{query:body.query,count:cfg.maxResults||5,need_content:true}),signal:body.signal});
    if(!response.ok)throw fail('搜索服务返回 HTTP '+response.status);const data=await response.json();return {ok:true,results:data.results||[],count:data.results?.length||0};}
  async function generate(p,body,signal){const cfg=settings().imageGeneration;if(!cfg.enabled)throw fail('生图未开启，请用户手动开启',403);
    signal=signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000);signal.throwIfAborted();
    let models=cfg.models||[];if(!models.length&&cfg.model==='auto'){try{models=(await fetchModels(nativeFetch,cfg,true,signal)).models;}catch{}}
    const payload=generationPayload(cfg,body,models),{model}=payload;
    const base=cfg.baseUrl.replace(/\/+$/,'');const response=await remote(nativeFetch,/\/images\/generations$/.test(base)?base:base+'/images/generations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey},body:JSON.stringify(payload),signal});
    if(!response.ok)throw fail('生图服务返回 HTTP '+response.status);const data=await response.json(),item=data.data?.[0];let bytes;
    if(item?.b64_json)bytes=Buffer.from(item.b64_json,'base64');else if(item?.url){const download=await remote(nativeFetch,item.url,{signal});if(!download.ok)throw fail('图片下载失败');bytes=Buffer.from(await download.arrayBuffer());}else throw fail('生图服务未返回图片');
    if(bytes.length>20*1024*1024)throw fail('图片超过 20MB');
    const png=bytes[0]===137&&bytes[1]===80,jpg=bytes[0]===255&&bytes[1]===216,webp=bytes.toString('ascii',8,12)==='WEBP';if(!png&&!jpg&&!webp)throw fail('服务没有返回有效的 PNG/JPEG/WebP 图片');
    if(!settings().imageGeneration.enabled)throw fail('用户已关闭生图，结果未保存',403);signal?.throwIfAborted();
    const name=`assets/${id('generated')}.${png?'png':jpg?'jpg':'webp'}`;p.files[name]=asData(name,bytes);return {ok:true,url:name,model,size:bytes.length};}
  async function handle(input,init={}){
    const url=new URL(typeof input==='string'?input:input.url,'https://webdeck.local'),route=decodeURIComponent(url.pathname),method=(init.method||'GET').toUpperCase(),body=typeof init.body==='string'?parse(init.body):{},signal=init.signal;
    if(route.startsWith('/api/webdav/'))return webDAVResponse(cloud,url.href,method,body,backupWorkspace.readRecovery);
    const backupJob=cloud.status();
    if(backupJob.busy&&backupJob.operation==='restore'&&['POST','PUT','PATCH','DELETE'].includes(method))throw fail('云端备份正在恢复，请完成并刷新后再修改工作区',423);
    if(route==='/api/health')return json({ok:true,mode:'standalone'});
    if(route==='/api/elements'&&method==='GET')return json({elements:Object.values(state.elements).map(favoriteSummary).sort((a,b)=>b.createdAt-a.createdAt)});
    if(route==='/api/elements'&&method==='POST'){
      const element={...normalizeFavorite(body),id:id('el')};state.elements[element.id]=element;await persist();return json({element});
    }
    const favoriteMatch=/^\/api\/elements\/([^/]+)$/.exec(route);
    if(favoriteMatch){
      const fid=favoriteId(favoriteMatch[1]),element=state.elements[fid];if(!element)throw fail('收藏不存在',404);
      if(method==='GET')return json({element});
      if(method==='PATCH'){const next={...normalizeFavorite({name:body.name,description:body.description},element),id:fid};state.elements[fid]=next;await persist();return json({element:next});}
      if(method==='DELETE'){delete state.elements[fid];await persist();return json({ok:true});}
    }
    if(route==='/api/settings'&&method==='GET')return json(publicSettings());
    if(['/api/settings','/api/settings/user'].includes(route)&&method==='PUT'){const result=updateSettings(body,route.endsWith('/user'));await persist();return json(result);}
    if(route==='/api/settings/test-search'||route==='/api/search')return json(await search({...body,query:body.query||'presentation design',signal},route.includes('test-')?body:null));
    if(route==='/api/image-settings'&&method==='PUT'){settings().imageGeneration=updateImageSettings(settings().imageGeneration,body);await persist();return json({imageGeneration:publicImageSettings(settings().imageGeneration)});}
    if(route==='/api/image-models')return json(await fetchModels(nativeFetch,{...settings().imageGeneration,...(method==='POST'?body:{ }),apiKey:body.clearKey?'':body.apiKey||settings().imageGeneration.apiKey},true,signal));
    if(route==='/api/ai/models')return json(await fetchModels(nativeFetch,{...provider(body.providerId),...body,apiKey:body.clearKey?'':body.apiKey||provider(body.providerId).apiKey},false,signal));
    if(route==='/api/ai/models-cache')return json({ok:true,providers:settings().providers.length});
    if(route==='/api/ai/chat'||route==='/api/settings/test-chat'){
      const test=route.includes('test-'),cfg={...provider(test?body.id:body.providerId),...(test?body:{})};cfg.apiKey=body.clearKey?'':body.apiKey||cfg.apiKey;
      return chatResponse(nativeFetch,cfg,test?{...body,messages:[{role:'user',content:'请只回复 OK'}],maxTokens:24}:body,signal);
    }
    if(route==='/api/agent/capabilities')return json({operations:API_CATALOG.filter((op)=>!op.id.startsWith('filesystem.'))});
    if(route==='/api/skills')return json({skills:bundle.skills});
    if(route==='/api/samples')return json({samples:Object.values(bundle.samples).map((s)=>s.meta)});
    if(route==='/api/hanzi'){
      // 静态版不内嵌几十 MB 笔画库；返回可用但为空的响应，界面会提示字符退化为普通文字。
      return json({ok:true,set:'none',chars:'',strokes:{},medians:{},radicals:{},missing:Array.from(url.searchParams.get('chars')||''),note:'静态版不含笔画数据，请使用本地服务或在导出文件里替换为文字。'});
    }
    if(route==='/api/imports'){const importId=id('upload');state.imports[importId]=body;await persist();return json({importId,fileName:body.fileName});}
    if(route==='/api/templates'&&method==='GET')return json({templates:[...Object.values(bundle.templates),...Object.values(state.templates)].map((t)=>({...t.meta}))});
    if(route==='/api/templates'&&method==='POST'){
      let source=body.projectId?{files:getProject(body.projectId).files,kind:getProject(body.projectId).meta.kind}:await importFiles(body);
      const tid=id('custom'),meta={id:tid,name:body.name||body.fileName||'自定义模板',desc:body.desc||'',kind:source.kind,custom:true,slides:count(source.files['index.html']),cover:{bg:'#191919',fg:'#eeeeee',accent:'#bed6a7'}};
      state.templates[tid]={meta,files:structuredClone(source.files)};await persist();return json({template:meta,report:source.report});
    }
    const template=/^\/api\/templates\/([^/]+)(\/export)?$/.exec(route);
    if(template){const t=state.templates[template[1]];if(!t)throw fail('只能修改自定义模板');if(template[2]){const zip=new JSZip();for(const[name,value]of Object.entries(t.files))zip.file(name,fromData(value));zip.file('template.json',JSON.stringify(t.meta));return new Response(await zip.generateAsync({type:'uint8array'}),{headers:{'Content-Type':'application/zip'}});}
      if(method==='DELETE')delete state.templates[template[1]];else if(method==='PATCH')Object.assign(t.meta,{name:body.name||t.meta.name,desc:body.desc??t.meta.desc});await persist();return json({template:t.meta,ok:true});}
    if(route==='/api/projects'&&method==='GET')return json({projects:Object.values(state.projects).map(projectInfo).sort((a,b)=>b.updatedAt-a.updatedAt)});
    if(route==='/api/projects'&&method==='POST'){const project=createProject(body);await persist();return json({project});}
    if(route==='/api/projects/import'){const result=await importFiles(body),project=createProject(body,result.files,result.kind,result.report);await persist();return json({project,report:result.report});}
    const workspace=/^\/api\/workspace\/(chat|chats)$/.exec(route),projectRoute=/^\/api\/projects\/([^/]+)(.*)$/.exec(route);
    const p=projectRoute?getProject(projectRoute[1]):null,sub=projectRoute?projectRoute[2]:'/'+workspace?.[1],chats=p?p.chats:state.chats;
    if(workspace||p){
      if(sub==='/chat'){const session=url.searchParams.get('session')||'default';if(method==='GET')return json(chats[session]||{messages:[],updatedAt:0});chats[session]={...body,updatedAt:Date.now()};await persist();return json({ok:true,updatedAt:chats[session].updatedAt});}
      if(sub==='/chats')return json({chats:Object.entries(chats).map(([id,c])=>({id,title:c.title||c.messages?.find((m)=>m.role==='user')?.content?.slice(0,80)||'新对话',turns:c.messages?.filter((m)=>m.role==='user').length||0,updatedAt:c.updatedAt,origin:c.origin})).filter((c)=>c.turns).sort((a,b)=>b.updatedAt-a.updatedAt)});
      if(!sub){if(method==='DELETE'){delete state.projects[p.meta.id];await persist();return json({ok:true});}if(method==='PATCH'){const archive=archivePatch(p.meta,body);const fields=['name','kind','slideCount','theme','cover','coverFg','coverAccent','origin'];for(const k of fields)if(body[k]!==undefined)p.meta[k]=body[k];Object.assign(p.meta,archive,{updatedAt:Date.now()});await persist();}return json({project:projectInfo(p),files:Object.keys(p.files)});}
      if(sub==='/duplicate'){const project=createProject({name:p.meta.name+' · 副本'},p.files,p.meta.kind);await persist();return json({project});}
      if(sub==='/file'){const path=safePath(body.path||url.searchParams.get('path')||'index.html');if(method==='GET'){if(p.files[path]===undefined)throw fail('文件不存在',404);return json({path,content:p.files[path],size:p.files[path].length});}p.files[path]=String(body.content??'');p.meta.updatedAt=Date.now();await persist();return json({ok:true,savedAt:Date.now()});}
      if(['/history','/patches','/deck-config','/timeline'].includes(sub)){
        const map={'/history':['.history.json','ops',[]],'/patches':['.raw-edits.json','patches',[]],'/deck-config':['.raw-deck.json','config',{}],'/timeline':['.raw-timeline.json','timeline',null]},[file,key,fallback]=map[sub];
        if(method==='GET')return json(parse(p.files[file],{[key]:fallback}));p.files[file]=JSON.stringify({[key]:body[key]??fallback,updatedAt:Date.now()});await persist();return json({ok:true,savedAt:Date.now()});}
      if(sub==='/assets'){const name='assets/'+id('asset')+'-'+(body.name||url.searchParams.get('name')||'image.png').replace(/[^\w.\-]/g,'_');p.files[name]=body.dataUrl||asData(name,await init.body.arrayBuffer());await persist();return json({url:name,size:p.files[name].length});}
      if(sub==='/generate-image'){const result=await generate(p,body,signal);await persist();return json(result);}
      if(sub==='/upgrade-runtime'||sub==='/reload-runtime')return json({ok:true,changed:false});
      if(sub==='/versions'&&method==='GET')return json({versions:p.versions.map(publicVersion).reverse()});
      if(sub==='/versions'&&method==='POST'){const version=capture(p,body);await persist();return json({version:publicVersion(version),project:projectInfo(p)});}
      const vroute=/^\/versions\/(?:([^/]+)(?:\/(restore|preview|present|export))?)$/.exec(sub);
      if(vroute){const vid=vroute[1]==='detail'||vroute[1]==='restore'?body.versionId||url.searchParams.get('versionId'):vroute[1],v=p.versions.find((v)=>v.id===vid);if(!v)throw fail('版本不存在',404);
        if(vroute[2]==='restore'||vroute[1]==='restore'){
          const backup=capture(p,{kind:'backup',label:'回退前自动备份'});let conversation=null;
          if(body.rewindConversation){if(!v.chat)throw fail('此版本没有对话快照');const session=v.conversation?.sessionId||'default',archivedSession=id('branch');p.chats[archivedSession]={...structuredClone(p.chats[session]||{}),title:'回退前 · 历史分支',updatedAt:Date.now()};p.chats[session]=structuredClone(v.chat);conversation={sessionId:session,archivedSession};}
          p.files=structuredClone(v.files);p.meta={...structuredClone(v.meta),updatedAt:Date.now()};await persist();return json({ok:true,version:publicVersion(v),backup:publicVersion(backup),conversation,project:projectInfo(p)});
        }
        if(['preview','present','export'].includes(vroute[2]))return new Response(documents.documentFor(route),{headers:{'Content-Type':'text/html'}});
        return json({version:publicVersion(v),changes:changes(p,v)});
      }
      if(sub==='/export'||sub==='/thumb')return new Response(documents.documentFor(input),{headers:{'Content-Type':'text/html'}});
    }
    if(route.startsWith('/p/')||route.startsWith('/templates/')||route.startsWith('/samples/'))return new Response(documents.documentFor(input),{headers:{'Content-Type':'text/html'}});
    if(route.startsWith('/api/fs/'))throw fail('单文件模式请上传文件；磁盘目录浏览需要 BAT 后端模式');
    throw fail('静态模式未实现接口：'+route,404);
  }
  async function fetchLocal(input,init={}){
    const run=async()=>{
      let release;
      try{
        if(['POST','PUT','PATCH','DELETE'].includes((init.method||'GET').toUpperCase())&&!String(input).includes('/api/webdav/'))release=await gate.enter();
        return await handle(input,init);
      }catch(e){return json({error:{message:e.message}},e.status||400);}finally{release?.();}
    };
    // Serialize mutations so snapshots and settings cannot race other writes.
    const network=/\/(?:ai\/|webdav\/|image-models|generate-image|search|settings\/test-)/.test(String(input));
    if(['POST','PUT','PATCH','DELETE'].includes(init.method)&&!network){const result=writes.then(run,run);writes=result.then(()=>{},()=>{});return result;}
    return run();
  }
  return {fetch:fetchLocal,documents,state,persist,publicSettings,cloud};
}
