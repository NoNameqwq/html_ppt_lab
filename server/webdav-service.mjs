import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWebDAVManager } from '../app/js/core/webdav-manager.js';
import { normalizeWebDAV } from '../app/js/core/webdav-config.js';
import { diskWorkspace } from './workspace-backup.mjs';

export { workspaceGate } from '../app/js/core/workspace-gate.js';
export async function webDAVService({projectsRoot,dataRoot,getSettings,gate}){
  const root=path.join(dataRoot,'webdav');await fs.mkdir(root,{recursive:true});
  async function read(name,fallback){try{return JSON.parse(await fs.readFile(path.join(root,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
  async function write(name,value){const file=path.join(root,name),temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,JSON.stringify(value,null,2),{flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
  let config=normalizeWebDAV({},await read('config.json',{}));
  const disk=diskWorkspace({projectsRoot,dataRoot,getSettings});
  const manager=createWebDAVManager({mode:'server',getConfig:()=>config,saveConfig:async next=>{await write('config.json',next);config=next;},
    initialStatus:await read('status.json',{}),saveStatus:status=>write('status.json',status),
    snapshot:include=>gate.exclusive(()=>disk.snapshot(include)),apply:data=>gate.exclusive(()=>disk.apply(data)),saveRecovery:disk.saveRecovery});
  return {manager,readRecovery:disk.readRecovery};
}
