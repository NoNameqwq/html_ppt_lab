import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {normalizeWebDAV,publicWebDAV,backupDue} from '../app/js/core/webdav-config.js';
import {createDAV,BACKUP_NAME} from '../app/js/core/webdav-client.js';
import {packWorkspace,unpackWorkspace,backupPath} from '../app/js/core/workspace-backup.js';
import {createWebDAVManager} from '../app/js/core/webdav-manager.js';
import {diskWorkspace} from '../server/workspace-backup.mjs';
import {browserWorkspace} from '../app/js/standalone/webdav-workspace.js';
import {workspaceGate} from '../app/js/core/workspace-gate.js';
import {mockDAV} from './webdav-fixture.mjs';
import {createBackend} from '../app/js/standalone/backend.js';

test('WebDAV configuration validates endpoints, preserves passwords and schedules daily catch-up with retry backoff',()=>{
  const config=normalizeWebDAV({enabled:true,baseUrl:'https://dav.example/dav',username:'user',password:'secret'});
  assert.equal(config.autoBackup,true);assert(!('password' in publicWebDAV(config)));assert(publicWebDAV(config).passwordSet);
  assert.equal(normalizeWebDAV({password:''},config).password,'secret');assert.equal(normalizeWebDAV({clearPassword:true},config).password,'');
  for(const p of [{baseUrl:'file:///tmp/'},{baseUrl:'https://user:pass@host/'},{baseUrl:'https://host/?key=secret'},{folder:'../x'},{dailyTime:'28:00'},{timeZone:'bad-zone'}])assert.throws(()=>normalizeWebDAV(p,config));
  const now=Date.parse('2026-11-17T04:00:00+08:00');assert(backupDue(config,{},now));
  assert(!backupDue(config,{lastSuccessAt:now-3600000},now));assert(backupDue(config,{lastSuccessAt:now-86400000},now));
  assert(!backupDue(config,{lastSuccessAt:now-86400000,lastAttemptAt:now-60000,lastError:'offline'},now));
  assert(!backupDue(config,{busy:true},now));assert(!backupDue({...config,enabled:false},{},now));
});

test('Archive uses compressed bytes and per-file hashes, rejects corrupt payloads, wrong modes and unsafe paths',async()=>{
  const entries=new Map([['projects/中文/index.html','<html>content</html>'.repeat(500)],['data/elements/el.json','{}']]);
  const packed=await packWorkspace(entries,{mode:'server'});assert(packed.bytes.length<3000);
  const unpacked=await unpackWorkspace(packed.bytes,'server');assert.equal(new TextDecoder().decode(unpacked.entries.get('projects/中文/index.html')),entries.get('projects/中文/index.html'));
  await assert.rejects(unpackWorkspace(packed.bytes,'static'),/对应模式/);
  const zip=await JSZip.loadAsync(packed.bytes);zip.file('workspace/projects/中文/index.html','broken');await assert.rejects(unpackWorkspace(await zip.generateAsync({type:'uint8array'})),/清单/);
  for(const p of ['../x','/x','a/../b','a\\b','C:/x','a/con.txt','a/b.'])assert.throws(()=>backupPath(p));
  await assert.rejects(unpackWorkspace(new Uint8Array([1,2,3])),/有效/);
});

test('DAV atomically delivers ZIP files, lists only complete matching backups and retrieves original bytes',async()=>{
  const server=await mockDAV();
  try{
    const config=normalizeWebDAV({baseUrl:server.baseUrl,folder:'WebDeck/中文',username:'qa-user',password:'qa-password'}),dav=createDAV(config);
    await dav.ensure();const name='webdeck-server-20261117T120000000Z-'+crypto.randomUUID()+'.zip';assert(BACKUP_NAME.test(name));
    const bytes=new Uint8Array([1,2,3]);await dav.put(name,bytes);server.files.set('/dav/WebDeck/%E4%B8%AD%E6%96%87/incomplete.zip.upload',Buffer.from('temp'));
    const list=await dav.list();assert.equal(list.length,1);assert.equal(list[0].name,name);assert.deepEqual(await dav.get(name),bytes);
    assert(server.requests.some(r=>r.method==='MOVE'));assert(![...server.files.keys()].some(p=>p===new URL(name+'.upload',dav.root).pathname));
    await assert.rejects(createDAV({...config,password:'bad'}).ensure(),/401/);
  }finally{await server.close();}
});

test('Manager performs manual and daily backups, validates before restore, saves local recovery and reports errors without dropping local data',async()=>{
  const server=await mockDAV();let config=normalizeWebDAV({enabled:true,autoBackup:true,baseUrl:server.baseUrl,username:'qa-user',password:'qa-password'}),now=Date.parse('2026-11-17T04:00:00+08:00');
  let content='original',applied=0,recovery=0;const saved=[];
  const manager=createWebDAVManager({mode:'static',getConfig:()=>config,saveConfig:async c=>config=c,saveStatus:async s=>saved.push(s),clock:()=>now,
    snapshot:async()=>new Map([['state.json',content]]),apply:async data=>{content=new TextDecoder().decode(data.entries.get('state.json'));applied++;return {files:1};},saveRecovery:async bytes=>{recovery++;return {name:'local.zip',size:bytes.length};}});
  try{
    await manager.tick();const backed=await manager.wait();assert(!backed.lastError);assert.equal(backed.reason,'automatic');assert(saved.some(s=>s.busy));
    const name=backed.lastBackup.name;assert.equal((await manager.list()).backups.length,1);
    await manager.tick();await manager.wait();assert.equal((await manager.list()).backups.length,1);
    content='edited';manager.start('restore',name);assert.throws(()=>manager.start(),/正在运行/);await manager.wait();assert.equal(content,'original');assert.equal(applied,1);assert.equal(recovery,1);
    content='local';server.files.set('/dav/WebDeck/'+name,Buffer.from('corrupt'));
    manager.start('restore',name);const failed=await manager.wait();assert(failed.lastError);assert.equal(content,'local');assert.equal(applied,1);assert.equal(recovery,1);
    now+=86400000;await manager.tick();assert(!(await manager.wait()).lastError);assert.equal((await manager.list()).backups.length,2);
    await manager.configure({folder:'Different'});assert(!manager.status().lastSuccessAt);
    assert(!JSON.stringify(manager.publicConfig()).includes('qa-password'));
  }finally{manager.stopScheduler();await server.close();}
});

test('Disk snapshot includes conversations, versions and favorites, excludes DAV secrets and restores with a recovery archive',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'webdeck-dav-')),projectsRoot=path.join(root,'projects'),dataRoot=path.join(root,'data');
  await fs.mkdir(path.join(projectsRoot,'demo','.versions','blobs'),{recursive:true});await fs.mkdir(path.join(dataRoot,'elements'),{recursive:true});
  await fs.writeFile(path.join(projectsRoot,'demo','index.html'),'before');await fs.writeFile(path.join(projectsRoot,'demo','.versions','blobs','data'),'version');await fs.writeFile(path.join(projectsRoot,'demo','.chat.json'),'{"messages":[]}');
  await fs.writeFile(path.join(dataRoot,'elements','el.json'),'{}');
  const disk=diskWorkspace({projectsRoot,dataRoot,getSettings:async()=>({providers:[],agent:{},webdav:{password:'never include'}})});
  try{
    const entries=await disk.snapshot();assert.equal(entries.size,4);assert(!entries.has('data/settings.json'));
    const all=await disk.snapshot(true);assert(!new TextDecoder().decode(all.get('data/settings.json')).includes('never include'));
    const packed=await packWorkspace(entries,{mode:'server'});const recovery=await disk.saveRecovery(packed.bytes);assert.deepEqual(new Uint8Array(await disk.readRecovery(recovery.name)),packed.bytes);
    await fs.writeFile(path.join(projectsRoot,'demo','index.html'),'edited');await fs.writeFile(path.join(projectsRoot,'demo','extra.html'),'keep');
    await disk.apply(await unpackWorkspace(packed.bytes,'server'));assert.equal(await fs.readFile(path.join(projectsRoot,'demo','index.html'),'utf8'),'before');assert.equal(await fs.readFile(path.join(projectsRoot,'demo','extra.html'),'utf8'),'keep');
    await assert.rejects(disk.apply({entries:new Map([['data/webdav/config.json','secret']])}),/不支持/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('Browser backups omit credentials by default, merge imported content, preserve local DAV configuration and roll back failed persistence',async()=>{
  const state={settings:{providers:[{apiKey:'api-secret'}],agent:{}},projects:{demo:{meta:{id:'demo'},files:{'index.html':'original'},chats:{},versions:[]}},templates:{},chats:{},elements:{},webdavConfig:{password:'dav-secret'}};
  let fail=false;const disk=browserWorkspace(state,async()=>{if(fail)throw new Error('quota');},()=>Promise.resolve());
  const entries=await disk.snapshot();assert(!entries.get('state.json').includes('api-secret'));assert(!entries.get('state.json').includes('dav-secret'));
  entries.set('state.json',new TextEncoder().encode(entries.get('state.json')));
  state.projects.demo.files['index.html']='edited';state.projects.demo.files['extra.html']='keep';
  await disk.apply({entries,manifest:{includeSettings:false}});assert.equal(state.projects.demo.files['index.html'],'original');assert.equal(state.projects.demo.files['extra.html'],'keep');assert.equal(state.settings.providers[0].apiKey,'api-secret');assert.equal(state.webdavConfig.password,'dav-secret');
  state.projects.demo.files['index.html']='new-edit';fail=true;await assert.rejects(disk.apply({entries,manifest:{includeSettings:false}}),/quota/);assert.equal(state.projects.demo.files['index.html'],'new-edit');
});

test('Workspace exclusive sections wait for existing writes and prevent new writes until snapshot or restore completes',async()=>{
  const gate=workspaceGate(),events=[];const done=await gate.enter();
  let releaseSnapshot;const wait=new Promise(r=>releaseSnapshot=r);
  const snapshot=gate.exclusive(async()=>{events.push('snapshot');await wait;events.push('snapshot-end');});
  await new Promise(r=>setTimeout(r,0));const later=gate.enter().then(release=>{events.push('later-write');release();});
  assert.deepEqual(events,[]);done();await new Promise(r=>setTimeout(r,0));assert.deepEqual(events,['snapshot']);
  releaseSnapshot();await Promise.all([snapshot,later]);assert.deepEqual(events,['snapshot','snapshot-end','later-write']);
});

test('Static backend API routes expose redacted DAV settings and run backup/restore without a browser backend',async()=>{
  const remote=await mockDAV();
  const state={settings:{providers:[],agent:{}},projects:{demo:{meta:{id:'demo'},files:{'index.html':'original'},chats:{},versions:[]}},templates:{},chats:{},imports:{}};
  const backend=createBackend({state,persist:async()=>{}},{resources:{},skills:[]},fetch);
  const call=async(route,method='GET',body)=>{const r=await backend.fetch('/api/'+route,{method,...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;};
  try{
    assert.equal((await call('webdav/config')).config.enabled,false);
    await call('webdav/config','PUT',{enabled:true,autoBackup:false,baseUrl:remote.baseUrl,username:'qa-user',password:'qa-password'});
    assert(!JSON.stringify(await call('webdav/config')).includes('qa-password'));
    await call('webdav/backup','POST',{});await backend.cloud.wait();const name=backend.cloud.status().lastBackup.name;
    state.projects.demo.files['index.html']='changed';await call('webdav/restore','POST',{name});await backend.cloud.wait();
    assert(!backend.cloud.status().lastError,backend.cloud.status().lastError);assert.equal(state.projects.demo.files['index.html'],'original');
    assert(state.webdavRecovery.name);assert.equal(state.webdavConfig.password,'qa-password');
    const response=await backend.fetch('/api/webdav/recovery?name='+state.webdavRecovery.name);assert(response.ok);assert((await response.arrayBuffer()).byteLength>100);
  }finally{backend.cloud.stopScheduler();await remote.close();}
});

test('Completion stays busy until terminal backup status has finished persisting',async()=>{
  const remote=await mockDAV();let entered,release;
  const saving=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
  const config=normalizeWebDAV({enabled:true,autoBackup:false,baseUrl:remote.baseUrl,username:'qa-user',password:'qa-password'});
  const manager=createWebDAVManager({mode:'static',getConfig:()=>config,saveConfig:async()=>{},snapshot:async()=>new Map([['state.json','{}']]),
    saveStatus:async s=>{if(!s.busy&&s.lastBackup){entered();await pending;}},apply:async()=>{},saveRecovery:async()=>{}});
  try{
    manager.start();await saving;assert(manager.status().busy,'reload must not race IndexedDB persistence');
    release();await manager.wait();assert(!manager.status().busy);assert(manager.status().lastBackup);
  }finally{release();await manager.wait();await remote.close();}
});
