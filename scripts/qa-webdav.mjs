import assert from 'node:assert/strict';
import { mockDAV } from './webdav-fixture.mjs';
import { unpackWorkspace } from '../app/js/core/workspace-backup.js';

export async function qaWebDAV({ev,cdp,until,shot,mode}){
  const remote=await mockDAV();
  const click=label=>ev(`[...document.querySelectorAll('.dav-settings button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`);
  try{
    const pid=await ev(`(async()=>{const a=window.__WDS__.api,p=(await a.createProject({name:'WebDAV 备份验收',templateId:'blank'})).project;
      await a.putFile(p.id,'index.html','<!doctype html><html><body><h1>DAV_ORIGINAL</h1></body></html>');
      await a.putChat(p.id,{messages:[{role:'user',content:'DAV_CHAT_SAVED'}]},'qa-dav');
      await a.createVersion(p.id,{label:'DAV_VERSION_SAVED'});window.__WDS__.bus.runCommand('backup.open');return p.id;})()`);
    await until(()=>ev(`!!document.querySelector('#ais-section-backup:not([hidden]) .dav-settings')`),'WebDAV 设置');
    await ev(`(()=>{const f=document.querySelector('.dav-settings'),set=(label,value)=>{const e=f.querySelector('[aria-label="'+label+'"]');if(e.type==='checkbox')e.checked=value;else e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));};
      set('启用 WebDAV 挂载',true);set('WebDAV 地址',${JSON.stringify(remote.baseUrl)});set('账号','qa-user');set('WebDAV 密码','qa-password');set('备份目录','WebDeck');set('每天自动备份',false);})()`);
    await click('测试连接');await until(()=>remote.requests.some(r=>r.method==='PROPFIND'),'连接测试');
    await until(()=>ev(`[...document.querySelectorAll('.dav-settings button')].some(b=>b.textContent==='保存并挂载'&&!b.disabled)`),'连接测试结束');
    await click('保存并挂载');await until(()=>ev(`window.__WDS__.api.getWebDAV().then(s=>s.config.enabled&&s.config.passwordSet)`),'保存挂载配置');
    const publicConfig=await ev(`window.__WDS__.api.getWebDAV()`);assert(!JSON.stringify(publicConfig).includes('qa-password'));assert.equal(publicConfig.config.autoBackup,false);
    await until(()=>ev(`[...document.querySelectorAll('.dav-settings button')].some(b=>b.textContent==='立即备份'&&!b.disabled)`),'保存完成');await click('立即备份');
    await until(()=>ev(`window.__WDS__.api.webDAVStatus().then(s=>!s.busy&&!!s.lastBackup)`),'压缩并上传备份',30000);
    const backed=await ev(`window.__WDS__.api.webDAVStatus()`);assert(!backed.lastError,backed.lastError);
    assert(remote.requests.some(r=>r.method==='MOVE'));
    const remoteBytes=remote.files.get('/dav/WebDeck/'+backed.lastBackup.name);const archive=await unpackWorkspace(remoteBytes,mode==='static'?'static':'server');
    if(mode==='static'){
      const data=new TextDecoder().decode(archive.entries.get('state.json'));assert(data.includes('DAV_CHAT_SAVED'));assert(data.includes('DAV_VERSION_SAVED'));assert(!JSON.parse(data).settings);assert(!data.includes('qa-password'));
    }else{assert(archive.entries.has('projects/'+pid+'/.chats/qa-dav.json'));assert([...archive.entries.keys()].some(k=>k.includes('/.versions/')));assert(!archive.entries.has('data/settings.json'));assert(![...archive.entries.keys()].some(k=>k.includes('webdav/config')));}
    await until(()=>ev(`[...document.querySelectorAll('.dav-settings button')].some(b=>b.textContent==='查看云端备份'&&!b.disabled)`),'备份任务结束');await click('查看云端备份');
    await until(()=>ev(`!!document.querySelector('.dav-backup')`),'云端备份列表');await shot('webdav-settings-'+mode);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    assert(await ev(`(()=>{const f=document.querySelector('.dav-settings');return f.scrollWidth<=f.clientWidth+1&&[...f.querySelectorAll('input')].every(i=>i.getBoundingClientRect().right<innerWidth)})()`));await shot('webdav-mobile-'+mode);await cdp.send('Emulation.clearDeviceMetricsOverride');
    await ev(`window.__WDS__.api.putFile(${JSON.stringify(pid)},'index.html','<!doctype html><html><body>DAV_EDITED</body></html>')`);
    const origin=await ev('performance.timeOrigin');
    await ev(`[...document.querySelectorAll('.dav-backup button')].find(b=>b.textContent==='恢复').click()`);
    await until(()=>ev(`[...document.querySelectorAll('.modal-title')].some(e=>e.textContent==='恢复工作区')`),'恢复确认');
    await ev(`[...document.querySelectorAll('.modal')].at(-1).querySelector('.modal-foot .btn--primary').click()`);
    await until(()=>ev(`performance.timeOrigin!==${origin}&&!!window.__WDS__?.agent?.loop&&!window.__WDS__.agent.loop.getState().loading`),'恢复完成并刷新',30000);
    const restored=await ev(`window.__WDS__.api.getFile(${JSON.stringify(pid)},'index.html')`);assert(restored.content.includes('DAV_ORIGINAL'));assert(!restored.content.includes('DAV_EDITED'));
    const status=await ev(`window.__WDS__.api.webDAVStatus()`);assert(!status.lastError,status.lastError);assert(status.recovery?.name,JSON.stringify(status));assert(status.lastRestoreAt);
    const recoverySize=await ev(`window.__WDS__.api.webDAVDownload(${JSON.stringify(status.recovery.name)},true).then(r=>r.arrayBuffer()).then(b=>b.byteLength)`);assert(recoverySize>100);
    assert((await ev(`window.__WDS__.api.getWebDAV()`)).config.passwordSet);
    await ev(`window.__WDS__.api.putWebDAV({enabled:false})`);
  }finally{await remote.close();}
}
