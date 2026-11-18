import { XMLParser } from '../../vendor/xml-parser.mjs';
import { normalizeWebDAV, davError } from './webdav-config.js';
export const BACKUP_NAME=/^webdeck-(server|static)-\d{8}T\d{9}Z-[a-f0-9-]{36}\.zip$/;
export const BACKUP_MAX_BYTES=256*1024*1024;
export function createDAV(config,fetcher=fetch) {
  const cfg=normalizeWebDAV({},config);
  const root=new URL(cfg.folder.split('/').map(encodeURIComponent).join('/')+'/',cfg.baseUrl).href;
  const credentials=new TextEncoder().encode(cfg.username+':'+cfg.password);
  const auth='Basic '+btoa(Array.from(credentials,c=>String.fromCharCode(c)).join(''));
  async function request(url,method,body,extra={},timeout=120000) {
    let res;
    try{res=await fetcher(url,{method,body,headers:{Authorization:auth,...extra},redirect:'error',signal:AbortSignal.timeout(timeout)});}
    catch(e){throw davError(e.name==='TimeoutError'?'WebDAV 请求超时，请稍后重试':'无法连接 WebDAV；请检查地址、网络和跨域权限',502);}
    if(!res.ok&&!(method==='MKCOL'&&res.status===405))throw davError(`WebDAV ${method} 返回 HTTP ${res.status}，请检查账号与目录权限`,502);
    return res;
  }
  const propfind=url=>request(url,'PROPFIND','<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',{Depth:'1','Content-Type':'application/xml; charset=utf-8'});
  async function ensure() {
    // The endpoint is an existing DAV root; only create the configured subdirectories.
    let url=cfg.baseUrl;
    for(const part of cfg.folder.split('/')){url+=encodeURIComponent(part)+'/';await request(url,'MKCOL');}
    await propfind(root);return {ok:true};
  }
  async function list() {
    const res=await propfind(root),text=await res.text();if(text.length>4*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(text))throw davError('WebDAV 目录响应无效');
    let xml;try{xml=new XMLParser({removeNSPrefix:true,ignoreAttributes:false,processEntities:false}).parse(text);}catch{throw davError('WebDAV 返回了无效的目录 XML');}
    const entries=xml.multistatus?.response;if(!entries)throw davError('WebDAV 未返回标准目录，请检查是否填入了 WebDAV 接口地址');
    return (Array.isArray(entries)?entries:[entries]).flatMap(entry=>{
      try{
        const url=new URL(entry.href,root),folder=new URL(root),parts=url.pathname.split('/'),name=decodeURIComponent(parts.pop());
        if(url.origin!==folder.origin||decodeURIComponent(parts.join('/')+'/')!==decodeURIComponent(folder.pathname)||!BACKUP_NAME.test(name))return [];
        const stats=Array.isArray(entry.propstat)?entry.propstat:[entry.propstat],props=stats.find(p=>/\s200(?:\s|$)/.test(p?.status||''))?.prop;
        if(!props||props.resourcetype?.collection!==undefined)return [];
        return [{name,mode:BACKUP_NAME.exec(name)[1],size:Number(props.getcontentlength)||0,modifiedAt:Date.parse(props.getlastmodified)||0}];
      }catch{return [];}
    }).sort((a,b)=>b.name.localeCompare(a.name));
  }
  const valid=name=>{if(!BACKUP_NAME.test(name||''))throw davError('备份文件名无效');return name;};
  async function get(name) {
    const res=await request(new URL(valid(name),root).href,'GET');
    if(Number(res.headers.get('content-length'))>BACKUP_MAX_BYTES)throw davError('备份文件超过 256MB');
    const reader=res.body.getReader(),chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>BACKUP_MAX_BYTES)throw davError('备份文件超过 256MB');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    const out=new Uint8Array(size);let at=0;for(const c of chunks){out.set(c,at);at+=c.length;}return out;
  }
  async function put(name,bytes) {
    valid(name);if(bytes.length>BACKUP_MAX_BYTES)throw davError('备份压缩后超过 256MB');
    const target=new URL(name,root).href,temp=target+'.upload';
    try{
      await request(temp,'PUT',bytes,{'Content-Type':'application/zip','If-None-Match':'*'},600000);
      await request(temp,'MOVE',undefined,{Destination:target,Overwrite:'F'});
    }catch(e){try{await request(temp,'DELETE');}catch{}throw e;}
  }
  return {ensure,list,get,put,root};
}
