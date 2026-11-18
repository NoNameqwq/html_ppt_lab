import { backupPath } from '../core/workspace-backup.js';
import { asData,fromData } from './documents.js';

const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
const key=k=>{if(!k||['__proto__','prototype','constructor'].includes(k))throw new Error('备份对象标识无效');};
export function browserWorkspace(state,persist,settled){
  async function snapshot(includeSettings=false){
    await settled();
    const data=structuredClone({projects:state.projects,templates:state.templates,chats:state.chats,elements:state.elements||{},...(includeSettings?{settings:state.settings}:{})});
    if(data.settings)delete data.settings.webdav;
    return new Map([['state.json',JSON.stringify(data)]]);
  }
  async function apply({entries,manifest}){
    if(entries.size!==1||!entries.has('state.json'))throw new Error('静态工作区备份结构无效');
    const data=JSON.parse(new TextDecoder().decode(entries.get('state.json')));
    for(const field of ['projects','templates','chats','elements'])if(!record(data[field]))throw new Error('备份缺少有效的 '+field);
    if(data.settings&&(!manifest.includeSettings||!Array.isArray(data.settings.providers)||!record(data.settings.agent)))throw new Error('备份 API 配置无效');
    for(const field of ['projects','templates'])for(const [pid,p]of Object.entries(data[field])){
      key(pid);if(!record(p)||!record(p.meta)||!record(p.files)||p.meta.id!==pid)throw new Error('备份工程或模板结构无效');
      for(const [name,value]of Object.entries(p.files)){backupPath(name);if(typeof value!=='string')throw new Error('备份文件内容无效');}
      if(field==='projects'&&(!record(p.chats)||!Array.isArray(p.versions)))throw new Error('备份对话或版本结构无效');
    }
    for(const field of ['chats','elements'])for(const [pid,p]of Object.entries(data[field])){key(pid);if(!record(p))throw new Error('备份条目无效');}
    await settled();const before=structuredClone(state);
    try{
      for(const field of ['projects','templates'])for(const [pid,p]of Object.entries(data[field])){
        const current=state[field][pid];
        state[field][pid]={...current,...p,files:{...current?.files,...p.files},...(field==='projects'?{
          chats:{...current?.chats,...p.chats},versions:[...new Map([...(current?.versions||[]),...p.versions].map(v=>[v.id,v])).values()]}:{})};
      }
      state.chats={...state.chats,...data.chats};state.elements={...state.elements,...data.elements};
      if(data.settings){delete data.settings.webdav;state.settings=data.settings;}
      await persist();return {projects:Object.keys(data.projects).length,files:1};
    }catch(error){Object.keys(state).forEach(k=>delete state[k]);Object.assign(state,before);await persist().catch(()=>{});throw error;}
  }
  async function saveRecovery(bytes){const name='recovery-'+Date.now()+'-'+crypto.randomUUID()+'.zip';state.webdavRecovery={name,data:asData(name,bytes)};await persist();return {name,size:bytes.length};}
  async function readRecovery(name){if(!state.webdavRecovery||state.webdavRecovery.name!==name)throw new Error('本地恢复副本不存在');return fromData(state.webdavRecovery.data);}
  return {snapshot,apply,saveRecovery,readRecovery};
}
