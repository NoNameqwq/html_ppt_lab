import { davError } from './webdav-config.js';

export async function webDAVResponse(manager,path,method,body={},readRecovery) {
  const url=new URL(path,'https://webdeck.local'),route=url.pathname;
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(route==='/api/webdav/config'&&method==='GET')return json({config:manager.publicConfig(),status:manager.status()});
  if(route==='/api/webdav/config'&&method==='PUT')return json({config:await manager.configure(body)});
  if(route==='/api/webdav/test'&&method==='POST')return json(await manager.test(body));
  if(route==='/api/webdav/status'&&method==='GET')return json(manager.status());
  if(route==='/api/webdav/backups'&&method==='GET')return json(await manager.list());
  if(route==='/api/webdav/backup'&&method==='POST')return json(manager.start('backup'));
  if(route==='/api/webdav/restore'&&method==='POST')return json(manager.start('restore',body.name));
  if(['/api/webdav/download','/api/webdav/recovery'].includes(route)&&method==='GET'){
    const name=url.searchParams.get('name'),bytes=route.endsWith('/recovery')?await readRecovery(name):await manager.download(name);
    return new Response(bytes,{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'no-store'}});
  }
  throw davError('WebDAV 接口不存在',404);
}
