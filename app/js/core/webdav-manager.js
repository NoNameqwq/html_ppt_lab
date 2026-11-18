import { normalizeWebDAV, publicWebDAV, backupDue, davError } from './webdav-config.js';
import { createDAV } from './webdav-client.js';
import { packWorkspace, unpackWorkspace } from './workspace-backup.js';

export function createWebDAVManager({mode,getConfig,saveConfig,initialStatus={},saveStatus,snapshot,apply,saveRecovery,fetcher=fetch,clock=Date.now}) {
  let status={...initialStatus,busy:false},active=null,timer=null;
  const view=()=>structuredClone(status);
  const persist=()=>saveStatus(view());
  const client=(config=getConfig())=>{if(!config.baseUrl)throw davError('请先配置 WebDAV 地址');return createDAV(config,fetcher);};
  const identity=c=>JSON.stringify([c.baseUrl,c.username,c.folder]);
  async function configure(patch){
    if(status.busy)throw davError('备份或恢复正在进行，请完成后再修改挂载配置',409);
    const previous=normalizeWebDAV({},getConfig()),config=normalizeWebDAV(patch,previous);
    await saveConfig(config);
    if(identity(config)!==identity(previous)){status={busy:false};await persist();}
    return publicWebDAV(config);
  }
  function start(kind='backup',name='',reason='manual') {
    if(status.busy)throw davError('已有备份或恢复任务正在运行',409);
    const config=normalizeWebDAV({},getConfig());if(!config.enabled)throw davError('请先启用 WebDAV 挂载');
    if(!['backup','restore'].includes(kind))throw davError('任务类型无效');
    const jobId=crypto.randomUUID();status={...status,busy:true,jobId,operation:kind,reason,startedAt:clock(),lastAttemptAt:clock(),lastError:'',progress:'准备中'};
    active=(async()=>{
      try{
        await persist();const dav=client(config);await dav.ensure();
        if(kind==='backup'){
          status.progress='整理并压缩工作区';const packed=await packWorkspace(await snapshot(config.includeSettings),{mode,includeSettings:config.includeSettings});
          status.progress='上传到 WebDAV';const file=`webdeck-${mode}-${new Date(clock()).toISOString().replace(/[-:.]/g,'')}-${crypto.randomUUID()}.zip`;
          await dav.put(file,packed.bytes);status.lastSuccessAt=clock();status.lastBackup={name:file,size:packed.bytes.length,files:Object.keys(packed.manifest.files).length};
        }else{
          status.progress='下载并校验备份';const unpacked=await unpackWorkspace(await dav.get(name),mode);
          status.progress='保存恢复前的本地副本';const before=await packWorkspace(await snapshot(true),{mode,includeSettings:true});status.recovery=await saveRecovery(before.bytes);
          status.progress='恢复工作区';status.restored=await apply(unpacked);status.lastRestoreAt=clock();
        }
        status.progress='已完成';
      }catch(e){status.lastError=e.message||'WebDAV 操作失败';status.progress='失败';}
      finally{
        // A polling UI may reload as soon as busy becomes false. Publish that
        // transition only after the terminal record is durable (IndexedDB can
        // still have earlier snapshots queued behind a large local recovery).
        const terminal={...view(),busy:false,finishedAt:clock()};
        try{await saveStatus(terminal);}catch(e){terminal.lastError='任务状态保存失败：'+e.message;}
        status=terminal;active=null;
      }
      return view();
    })();
    return view();
  }
  async function tick(){try{if(backupDue(normalizeWebDAV({},getConfig()),status,clock()))start('backup','','automatic');}catch(e){status.lastError=e.message;await persist().catch(()=>{});}}
  return {configure,status:view,publicConfig:()=>publicWebDAV(getConfig()),
    test:async patch=>client(normalizeWebDAV(patch,getConfig())).ensure(),
    list:async()=>{const dav=client();await dav.ensure();return {backups:await dav.list()};},download:name=>client().get(name),start,tick,
    wait:()=>active||Promise.resolve(view()),
    startScheduler(){if(timer)return;timer=setInterval(()=>void tick(),60000);timer.unref?.();void tick();},
    stopScheduler(){clearInterval(timer);timer=null;},
  };
}
