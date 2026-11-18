import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { backupPath } from '../app/js/core/workspace-backup.js';
import { withProjectLock, recoverVersionTransaction } from './version-store.mjs';

const ignored=rel=>/(?:^|\/)\.versions\/transactions(?:\/|$)/.test(rel)||rel.split('/').some(p=>p==='.git'||p==='node_modules'||/\.[a-z0-9-]{8,}\.tmp$/i.test(p));
const within=(base,file)=>{const rel=path.relative(base,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw new Error('备份路径超出工作区');return file;};
async function exists(file){try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function safeTarget(root,rel){
  backupPath(rel);const target=within(root,path.resolve(root,rel));let at=root;
  const base=await exists(root);if(base?.isSymbolicLink()||base&&!base.isDirectory())throw new Error('工作区根目录不是普通目录');
  for(const part of rel.split('/')){at=path.join(at,part);const s=await exists(at);if(s?.isSymbolicLink())throw new Error('备份不允许符号链接');if(s&&at!==target&&!s.isDirectory())throw new Error('恢复目录与现有文件冲突');}
  const s=await exists(target);if(s&&!s.isFile())throw new Error('恢复文件与现有目录冲突');return target;
}
async function atomic(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(temp,value,{flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}

export function diskWorkspace({projectsRoot,dataRoot,getSettings}) {
  async function snapshot(includeSettings=false){
    const entries=new Map();let size=0;
    async function walk(root,prefix,rel=''){
      const stat=await exists(path.join(root,rel));if(!stat)return;
      if(stat.isSymbolicLink())throw new Error('工作区包含符号链接，备份已停止');
      if(stat.isDirectory())for(const e of await fs.readdir(path.join(root,rel),{withFileTypes:true})){const name=(rel?rel+'/':'')+e.name;if(!ignored(name))await walk(root,prefix,name);}
      else if(stat.isFile()){const name=backupPath(prefix+rel);size+=stat.size;if(size>1024*1024*1024)throw new Error('工作区超过 1GB 备份上限');entries.set(name,await fs.readFile(path.join(root,rel)));}
    }
    for(const project of await fs.readdir(projectsRoot,{withFileTypes:true}))if(project.isDirectory()&&!project.name.startsWith('.')){
      const dir=path.join(projectsRoot,project.name);
      await withProjectLock(dir,async()=>{await recoverVersionTransaction(dir);await walk(dir,'projects/'+project.name+'/');});
    }
    for(const name of ['elements','templates','.chats','.chat.json'])await walk(dataRoot,'data/',name);
    if(includeSettings){const settings=await getSettings();delete settings.webdav;entries.set('data/settings.json',Buffer.from(JSON.stringify(settings)));}
    return entries;
  }
  async function apply({entries}){
    // Validate every destination and settings JSON before writing the first file.
    const writes=[];
    for(const [name,value]of entries){
      if(!/^(?:projects\/[^/.][^/]*\/|data\/(?:elements\/|templates\/|\.chats\/|\.chat\.json$|settings\.json$))/.test(name)||ignored(name))throw new Error('备份包含不支持的工作区路径');
      const [type,...parts]=name.split('/'),root=type==='projects'?projectsRoot:dataRoot,rel=parts.join('/');
      if(name==='data/settings.json'){const cfg=JSON.parse(Buffer.from(value).toString());if(!Array.isArray(cfg.providers)||!cfg.agent||typeof cfg.agent!=='object')throw new Error('备份 API 设置无效');delete cfg.webdav;writes.push({file:await safeTarget(root,rel),value:Buffer.from(JSON.stringify(cfg)),project:null});}
      else writes.push({file:await safeTarget(root,rel),value,project:type==='projects'?parts[0]:null});
    }
    const projects=[...new Set(writes.map(w=>w.project).filter(Boolean))].sort();
    const lock=async(index,fn)=>index===projects.length?fn():withProjectLock(path.join(projectsRoot,projects[index]),()=>lock(index+1,fn));
    return lock(0,async()=>{
      const rollback=[];
      try{for(const item of writes){const previous=await exists(item.file),old=previous?await fs.readFile(item.file):null;
        if(old&&old.equals(Buffer.from(item.value)))continue;
        await atomic(item.file,item.value);rollback.push({file:item.file,value:old});
      }}
      catch(error){let failed=false;for(const old of rollback.reverse())try{if(old.value===null)await fs.rm(old.file,{force:true});else await atomic(old.file,old.value);}catch{failed=true;}
        throw new Error(error.message+(failed?'；自动撤销未全部完成，请保留本地恢复副本':'；已撤销本次写入'));
      }
      return {projects:projects.length,files:writes.length};
    });
  }
  async function saveRecovery(bytes){const name='recovery-'+Date.now()+'-'+crypto.randomUUID()+'.zip';await atomic(await safeTarget(dataRoot,'webdav/recovery/'+name),bytes);return {name,size:bytes.length};}
  async function readRecovery(name){if(!/^recovery-\d+-[a-f0-9-]{36}\.zip$/.test(name||''))throw new Error('恢复副本名称无效');return fs.readFile(await safeTarget(dataRoot,'webdav/recovery/'+name));}
  return {snapshot,apply,saveRecovery,readRecovery};
}
