import JSZip from 'jszip';
import { BACKUP_MAX_BYTES } from './webdav-client.js';
import { davError } from './webdav-config.js';
const MAX_EXPANDED=1024*1024*1024,MAX_FILES=25000;
const bytes=value=>typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(value);
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),n=>n.toString(16).padStart(2,'0')).join('');
export function backupPath(name) {
  if(typeof name!=='string'||!name||name.length>600||/[\\:\x00-\x1f<>"|?*]/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw davError('备份包含不安全的文件路径');
  return name;
}
export async function packWorkspace(entries,{mode,includeSettings=false}={}) {
  if(!['server','static'].includes(mode))throw davError('备份模式无效');
  if(entries.size>MAX_FILES)throw davError('工作区文件数量超过备份上限');
  const zip=new JSZip(),manifest={format:'webdeck-workspace',schema:1,mode,createdAt:Date.now(),includeSettings,files:{}};let total=0;
  for(const [name,value]of entries){backupPath(name);const data=bytes(value);total+=data.length;if(total>MAX_EXPANDED)throw davError('工作区超过 1GB 备份上限');manifest.files[name]={size:data.length,sha256:await digest(data)};zip.file('workspace/'+name,data);}
  zip.file('manifest.json',JSON.stringify(manifest));const data=await zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}});
  if(data.length>BACKUP_MAX_BYTES)throw davError('备份压缩后超过 256MB');return {bytes:data,manifest};
}
export async function unpackWorkspace(data,mode) {
  if(data.length>BACKUP_MAX_BYTES)throw davError('备份文件超过 256MB');
  let zip;try{zip=await JSZip.loadAsync(data);}catch{throw davError('不是有效的 ZIP 备份，未更改本地数据');}
  const files=Object.values(zip.files);if(files.length>MAX_FILES*2+2)throw davError('备份文件数量过多');let total=0;
  for(const f of files){backupPath((f.unsafeOriginalName||f.name).replace(/\/$/,''));total+=f._data?.uncompressedSize||0;if(total>MAX_EXPANDED||((Number(f.unixPermissions)||0)&0o170000)===0o120000)throw davError('备份展开内容过大或包含链接');}
  const meta=zip.file('manifest.json');if(!meta||meta._data.uncompressedSize>10*1024*1024)throw davError('备份清单缺失或过大');
  let manifest;try{manifest=JSON.parse(await meta.async('string'));}catch{throw davError('备份清单损坏');}
  if(manifest.format!=='webdeck-workspace'||manifest.schema!==1||!['server','static'].includes(manifest.mode)||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw davError('不支持的备份格式');
  if(mode&&manifest.mode!==mode)throw davError(`这是${manifest.mode==='server'?' BAT':'单文件'}模式备份，请在对应模式中恢复`);
  if(Object.keys(manifest.files).length>MAX_FILES)throw davError('备份文件数量过多');
  const entries=new Map();
  for(const [name,info]of Object.entries(manifest.files)){
    backupPath(name);const f=zip.file('workspace/'+name);if(!f||f._data.uncompressedSize!==info.size||!/^[a-f0-9]{64}$/.test(info.sha256))throw davError('备份文件与清单不一致，未更改本地数据');
    const value=await f.async('uint8array');if(await digest(value)!==info.sha256)throw davError('备份完整性校验失败，未更改本地数据');entries.set(name,value);
  }
  return {entries,manifest};
}
