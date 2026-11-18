import http from 'node:http';
export async function mockDAV(){
  const files=new Map(),directories=new Set(['/dav/']),requests=[];
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','OPTIONS,PROPFIND,MKCOL,PUT,MOVE,GET,DELETE');
    res.setHeader('Access-Control-Allow-Headers','Authorization,Depth,Destination,Overwrite,If-None-Match,Content-Type');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    requests.push({method:req.method,path:req.url,auth:req.headers.authorization});
    if(req.headers.authorization!=='Basic '+Buffer.from('qa-user:qa-password').toString('base64')){res.writeHead(401);res.end();return;}
    const name=new URL(req.url,'http://localhost').pathname;
    if(req.method==='MKCOL'){const exists=directories.has(name);directories.add(name);res.writeHead(exists?405:201);res.end();return;}
    if(req.method==='PROPFIND'){
      if(!directories.has(name)){res.writeHead(404);res.end();return;}
      const row=(href,value,folder=false)=>`<D:response><D:href>${escape(href)}</D:href><D:propstat><D:prop><D:getcontentlength>${value?.length||0}</D:getcontentlength><D:getlastmodified>${new Date().toUTCString()}</D:getlastmodified><D:resourcetype>${folder?'<D:collection/>':''}</D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      res.writeHead(207,{'Content-Type':'application/xml'});res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${row(name,null,true)}${[...files].filter(([p])=>p.startsWith(name)&&!p.slice(name.length).includes('/')).map(([p,v])=>row(p,v)).join('')}</D:multistatus>`);return;
    }
    if(req.method==='PUT'){const chunks=[];for await(const c of req)chunks.push(c);files.set(name,Buffer.concat(chunks));res.writeHead(201);res.end();return;}
    if(req.method==='MOVE'){const dest=new URL(req.headers.destination).pathname;if(!files.has(name)||files.has(dest)){res.writeHead(412);res.end();return;}files.set(dest,files.get(name));files.delete(name);res.writeHead(201);res.end();return;}
    if(req.method==='DELETE'){files.delete(name);res.writeHead(204);res.end();return;}
    if(req.method==='GET'&&files.has(name)){const bytes=files.get(name);res.writeHead(200,{'Content-Type':'application/zip','Content-Length':bytes.length});res.end(bytes);return;}
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {files,requests,baseUrl:'http://127.0.0.1:'+server.address().port+'/dav/',close:()=>{server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
