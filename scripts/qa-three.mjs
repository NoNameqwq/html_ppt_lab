/* Isolated real-browser checks for interactive WebGL and portable exports. */
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {threeMarkup} from '../app/js/core/three-content.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'output','playwright');
const data=path.join(root,'output','three-qa','run-'+Date.now()),children=[],report={steps:[],errors:[],external:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let cdp;
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(fn,label,timeout=25000){const start=Date.now();while(Date.now()-start<timeout){try{const r=await fn();if(r)return r;}catch{}await sleep(100);}throw new Error('等待超时：'+label);}
function launch(file,args=[],env={}){const child=spawn(process.execPath,[file,...args],{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>console.error(String(b)));children.push(child);return child;}
class CDP{
  constructor(url){this.url=url;this.id=0;this.pending=new Map();}
  async open(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{this.ws.addEventListener('open',r);this.ws.addEventListener('error',j);});this.ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url)&&!m.params.request.url.startsWith(appBase))report.external.push(m.params.request.url);});}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timeout'));},30000);this.pending.set(id,{resolve,reject,timer});});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
}
const ev=expression=>cdp.eval(expression),W='window.__WDS__',E=W+'.getEditor()',B=E+'.bridge',D=E+'.iframe.contentDocument',V=E+'.iframe.contentWindow';
const ready=()=>until(()=>ev(`!!${W}?.getEditor()?.bridge?.ready&&!${W}.agent.loop.getState().loading`),'编辑器');
async function step(name,fn){const start=Date.now();try{await fn();report.steps.push({name,ok:true,ms:Date.now()-start});console.log('✓ '+name);}catch(e){report.steps.push({name,ok:false,error:e.message});throw e;}}
async function json(route,body){const r=await fetch(appBase+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;}
const scene={background:'#111827',camera:{position:[5,3,6],target:[0,0,0],fov:42},objects:[{name:'ring',geometry:{type:'torus',args:[1.4,.25,20,60]},material:{color:'#fb923c',metalness:.2,roughness:.35},rotation:[.3,0,0]},{name:'orb',geometry:{type:'sphere',args:[.7,32,24]},material:{color:'#38bdf8'},position:[0,0,0]},{type:'grid',size:8,divisions:8,position:[0,-1.8,0]}]};
const markup=threeMarkup({scene,label:'交互式空间结构',code:'const custom=new THREE.Mesh(new THREE.IcosahedronGeometry(.3),new THREE.MeshStandardMaterial({color:"#a3e635"}));custom.position.set(2,1,0);root.add(custom);return {update(t){custom.rotation.y=t*.2;}};'});
let appBase='',nativeId='',rawId='';
async function screenshot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}
async function loaded(prefix='window'){return until(()=>ev(`${prefix}.__WDS_THREE__?.getState().instances.some(i=>i.ready&&i.objects===4)`),'3D WebGL 与原创 factory 就绪');}
async function insert3d(){await ev(`${B}.insertElement({type:'html',x:300,y:230,w:1200,h:720,html:${JSON.stringify(markup)}})`);await loaded(V);await ev(`${E}.saveNow({reason:'qa-three'})`);}
async function editorGestures(){
  const togglePoint=()=>ev(`(()=>{const f=${E}.iframe.getBoundingClientRect(),r=${D}.querySelector('[data-wds-three-ui] button').getBoundingClientRect();return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2}})()`);
  const click=async({x,y})=>{await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});};
  await click(await togglePoint());await until(()=>ev(`${V}.__WDS_THREE__.getState().instances[0].interacting&&document.querySelector('#selection-layer').classList.contains('is-three-interacting')`),'编辑器操控按钮穿透选区覆盖层');
  const before=await ev(`${V}.__WDS_THREE__.getState().instances[0].camera.position`),bounds=await ev(`(()=>{const f=${E}.iframe.getBoundingClientRect(),c=${D}.querySelector('[data-wds-three] canvas'),r=c.getBoundingClientRect(),el=c.closest('[data-wpx-el]');return {x:f.x+r.x+r.width*.5,y:f.y+r.y+r.height*.5,left:el.style.left,top:el.style.top}})()`);
  const {x,y}=bounds;
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1});for(let i=1;i<=5;i++)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+i*15,y:y+i*4,button:'left',buttons:1});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+75,y:y+20,button:'left',buttons:0});await sleep(220);
  const debug=await ev(`(()=>{const f=${E}.iframe.getBoundingClientRect();return {parentHit:document.elementFromPoint(${x},${y})?.outerHTML.slice(0,180),frameHit:${D}.elementFromPoint(${x}-f.x,${y}-f.y)?.outerHTML.slice(0,180),layer:document.querySelector('#selection-layer').className,state:${V}.__WDS_THREE__.getState()}})()`);
  assert.notDeepEqual(await ev(`${V}.__WDS_THREE__.getState().instances[0].camera.position`),before,JSON.stringify(debug));
  assert.deepEqual(await ev(`(()=>{const el=${D}.querySelector('[data-wds-three]').closest('[data-wpx-el]');return {left:el.style.left,top:el.style.top}})()`),{left:bounds.left,top:bounds.top});
  await click(await togglePoint());await until(()=>ev(`!${V}.__WDS_THREE__.getState().instances[0].interacting&&!document.querySelector('#selection-layer').classList.contains('is-three-interacting')`),'完成操控恢复编辑');
}
async function assertPixels(prefix='window'){
  const result=await ev(`(()=>{const c=${prefix}.document.querySelector('[data-wds-three] canvas');const t=document.createElement('canvas');t.width=96;t.height=64;const ctx=t.getContext('2d');ctx.drawImage(c,0,0,96,64);const p=ctx.getImageData(0,0,96,64).data,colors=new Set();for(let i=0;i<p.length;i+=4)colors.add(p[i]+','+p[i+1]+','+p[i+2]);return {colors:colors.size,width:c.width,height:c.height,png:c.toDataURL().length}})()`);
  assert(result.width>400&&result.height>200,JSON.stringify(result));assert(result.colors>35,JSON.stringify(result));assert(result.png>10000,JSON.stringify(result));
}
const camera=()=>ev(`window.__WDS_THREE__.getState().instances[0].camera`);
const distance=c=>Math.hypot(...c.position.map((v,i)=>v-c.target[i]));
const angle=(a,b)=>{const u=a.position.map((v,i)=>(v-a.target[i])/distance(a)),v=b.position.map((n,i)=>(n-b.target[i])/distance(b));return Math.acos(Math.max(-1,Math.min(1,u.reduce((sum,n,i)=>sum+n*v[i],0))));};
async function canvasRect(){return ev(`(()=>{const r=document.querySelector('[data-wds-three] canvas').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);}
async function gestures(){
  await ev(`document.documentElement.requestFullscreen=()=>Promise.resolve()`);
  let r=await canvasRect(),x=r.x+r.w*.5,y=r.y+r.h*.5,before=await camera();
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1});
  for(let i=1;i<=6;i++)await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+i*20,y:y+i*5,button:'left',buttons:1});
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+120,y:y+30,button:'left',buttons:0});await sleep(250);assert(angle(await camera(),before)>.05);
  before=await camera();await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaY:200,deltaX:0});await sleep(250);assert(Math.abs(distance(await camera())/distance(before)-1)>.02);
  before=await camera();await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'right',buttons:2});await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+75,y:y+25,button:'right',buttons:2});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+75,y:y+25,button:'right',buttons:0});await sleep(200);assert.notDeepEqual((await camera()).target,before.target);
  before=await camera();
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x,y}]});
  for(let i=1;i<=5;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:x+i*18,y:y-i*7}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(200);assert(angle(await camera(),before)>.05);
  before=await camera();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:x-30,y},{id:2,x:x+30,y}]});
  for(let i=1;i<=4;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:x-30-i*12,y:y+i*5},{id:2,x:x+30+i*12,y:y+i*5}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(200);assert(Math.abs(distance(await camera())/distance(before)-1)>.1);
}
try{
  await fs.mkdir(out,{recursive:true});await fs.mkdir(data,{recursive:true});
  const appPort=await port(),debugPort=await port();appBase='http://127.0.0.1:'+appPort;
  launch('server.mjs',[],{PORT:String(appPort),WDS_DATA_DIR:path.join(data,'data'),WDS_PROJECTS_DIR:path.join(data,'projects'),WDS_LOG:'0'});
  await until(async()=>(await fetch(appBase+'/api/health')).ok,'隔离服务');
  const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--enable-webgl','--enable-unsafe-swiftshader','--disable-gpu-sandbox','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(data,'chrome'),'--window-size=1600,1000','about:blank'],{stdio:'ignore',windowsHide:true});children.push(chrome);
  const target=await until(async()=>(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(t=>t.type==='page'),'Chrome');cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
  await step('普通导出不携带 Three.js，编辑器可以动态插入真实 WebGL 结构',async()=>{
    nativeId=(await json('/api/projects',{name:'3D Native QA',templateId:'knowledge-garden'})).project.id;
    const regular=await(await fetch(appBase+'/api/projects/'+nativeId+'/export')).text();assert(!regular.includes('data-wds-runtime="three'));assert(!regular.includes('window.WDS_THREE'));
    await cdp.send('Page.navigate',{url:appBase+'/?qa=1#/p/'+nativeId});await ready();await insert3d();await assertPixels(V);await screenshot('three-native-editor');
  });
  await step('编辑器操控按钮可直接点击，旋转模型不误拖动页面元素',async()=>editorGestures());
  await step('旧 BAT 服务未注入 3D 运行时时，编辑桥自动补载，已有和新插入场景都能显示',async()=>{
    const file=path.join(data,'projects',nativeId,'index.html'),legacyFile=path.join(data,'projects',nativeId,'legacy.html'),source=await fs.readFile(file,'utf8');
    const legacy=source.replace(/<script\b[^>]*data-wds-runtime=["']three(?:-bundle)?["'][^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>','<script id="wpx-bridge" src="/editor/bridge.js"></script></body>');
    await fs.writeFile(legacyFile,legacy);
    try{
      await ev(`${B}.load('/p/'+${JSON.stringify(nativeId)}+'/legacy.html?wpx=edit')`);await loaded(V);await assertPixels(V);
      assert.equal(await ev(`${D}.querySelectorAll('script[data-wds-runtime="three"]').length`),1);
      await screenshot('three-legacy-runtime-recovered');
      // Start without any 3D source to exercise the dynamic insertion path too.
      const empty=legacy.replace(/<div\b[^>]*data-wds-three="?[^>]*>[\s\S]*?<\/script><\/div>/g,'');
      await fs.writeFile(legacyFile,empty);await ev(`${B}.load('/p/'+${JSON.stringify(nativeId)}+'/legacy.html?wpx=edit&t=empty')`);
      assert.equal(await ev(`${D}.querySelectorAll('[data-wds-three]').length`),0);
      assert(!await ev(`${V}.__WDS_THREE__`));
      await insert3d();await assertPixels(V);
    }finally{await fs.writeFile(file,source);await ev(`${B}.load('/p/'+${JSON.stringify(nativeId)}+'/index.html?wpx=edit&t=recovered')`);await loaded(V);}
  });
  await step('并发刷新和 Agent 状态检查等待首次引擎加载完成，不把未挂载误判为 WebGL 不可用',async()=>{
    const result=await ev(`(async()=>{
      const f=document.createElement('iframe');document.body.appendChild(f);
      f.srcdoc='<html><head></head><body style="margin:0">'+${JSON.stringify(markup)}+'</body></html>';await new Promise(r=>f.onload=r);
      const w=f.contentWindow,d=f.contentDocument;d.querySelector('[data-wds-three]').style.cssText='position:relative;width:600px;height:400px';
      w.__WDS_THREE_URL__=location.origin+'/app/vendor/three/three-bundle.js';
      const script=d.createElement('script');script.src=location.origin+'/editor/three-runtime.js';d.head.appendChild(script);await new Promise((r,j)=>{script.onload=r;script.onerror=j});
      try{await Promise.all([w.__WDS_THREE__.refresh(),w.__WDS_THREE__.refresh()]);return w.__WDS_THREE__.getState();}finally{f.remove();}
    })()`);
    assert.equal(result.instances[0].ready,true);assert.equal(result.instances[0].objects,4);assert(result.instances[0].renderer.width>400);
  });
  await step('引擎加载失败显示实际错误，修复地址后点击重试可恢复 Canvas',async()=>{
    const result=await ev(`(async()=>{
      const f=document.createElement('iframe');document.body.appendChild(f);
      f.srcdoc='<html><head></head><body>'+${JSON.stringify(markup)}+'</body></html>';await new Promise(r=>f.onload=r);
      const w=f.contentWindow,d=f.contentDocument;d.querySelector('[data-wds-three]').style.cssText='position:relative;width:600px;height:400px';
      w.__WDS_THREE_URL__=location.origin+'/app/vendor/three/missing-engine-for-test.js';
      const script=d.createElement('script');script.src=location.origin+'/editor/three-runtime.js';d.head.appendChild(script);await new Promise((r,j)=>{script.onload=r;script.onerror=j});
      try{
        await w.__WDS_THREE__.refresh();const failed=w.__WDS_THREE__.getState(),message=d.querySelector('[role="status"]').textContent;
        w.__WDS_THREE_URL__=location.origin+'/app/vendor/three/three-bundle.js';d.querySelector('[data-wds-three-generated="error"] button').click();
        await w.__WDS_THREE__.refresh();return {failed,message,recovered:w.__WDS_THREE__.getState()};
      }finally{f.remove();}
    })()`);
    assert.equal(result.failed.instances[0].ready,false);assert(result.message.includes('无法加载内置 Three.js'));
    assert.equal(result.recovered.instances[0].ready,true);assert(result.recovered.instances[0].renderer.width>400);
  });
  await step('原创 Three.js factory 仅初始化一次，动画更新与删除释放资源有效',async()=>{
    const custom=threeMarkup({code:'host.dataset.factoryRuns=String(Number(host.dataset.factoryRuns||0)+1);const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshNormalMaterial());root.add(mesh);return {update(){host.dataset.factoryUpdated="yes";},dispose(){window.__threeDisposed=(window.__threeDisposed||0)+1;}};'});
    const element=await ev(`${B}.insertElement({type:'html',x:1450,y:120,w:300,h:220,html:${JSON.stringify(custom)}})`);
    await until(()=>ev(`${V}.__WDS_THREE__.getState().instances.filter(i=>i.ready).length===2`),'第二个原创场景');
    await until(()=>ev(`${D}.querySelector('[data-wpx-el="${element.elementId}"] [data-wds-three]').dataset.factoryUpdated==='yes'`),'原创动画更新');
    assert.equal(await ev(`${D}.querySelector('[data-wpx-el="${element.elementId}"] [data-wds-three]').dataset.factoryRuns`),'1');
    await ev(`${B}.deleteElement(${JSON.stringify(element.elementId)})`);await until(()=>ev(`${V}.__threeDisposed===1&&${V}.__WDS_THREE__.getState().count===1`),'释放 GPU 场景');await ev(`${E}.saveNow({reason:'qa-three'})`);
  });
  await step('自定义相机与观察中心不被自动取景覆盖，复位恢复原视角',async()=>{
    const configured=threeMarkup({code:'root.add(new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshNormalMaterial()));camera.position.set(0,0,8);controls.target.set(0,0,0);camera.lookAt(0,0,0);'});
    const element=await ev(`${B}.insertElement({type:'html',x:1450,y:120,w:300,h:220,html:${JSON.stringify(configured)}})`);
    const value=()=>ev(`${V}.__WDS_THREE__.getState().instances.find(i=>i.elementId===${JSON.stringify(element.elementId)})`);
    await until(async()=>(await value())?.ready,'factory 自定义相机');
    assert((await value()).camera.position.every((n,i)=>Math.abs(n-[0,0,8][i])<1e-9));
    await ev(`${B}.deleteElement(${JSON.stringify(element.elementId)})`);await ev(`${E}.saveNow({reason:'qa-three-camera'})`);
  });
  await step('原生工程保存重开后重建 GPU 场景，版本导出包含离线引擎',async()=>{
    await cdp.send('Page.reload');await ready();await loaded(V);await assertPixels(V);
    const thumb=await ev(`${B}.getThumb(0)`);assert(thumb.html.includes('data:image/png;base64,'));assert(!thumb.html.includes('data-wds-three-generated'));assert(!thumb.html.includes('<canvas'));
    const version=(await json('/api/projects/'+nativeId+'/versions',{label:'3D QA'})).version;
    const html=await(await fetch(appBase+'/api/projects/'+nativeId+'/versions/'+version.id+'/export')).text();assert(!html.includes('src="/app/vendor/three'));assert(html.includes('WDS_THREE'));await fs.writeFile(path.join(out,'three-native.html'),html);
  });
  await step('Agent 多模态截图包含真实 WebGL 像素而不是空白 Canvas',async()=>{
    const result=await ev(`(async()=>{const tool=(await import('/app/js/agent/tools.js')).createToolExecutor(${W});const result=await tool.execute('deck_capture_slide',{region:{x:300,y:230,w:1200,h:720},scale:.5},{permission:'full'});if(!result.ok)throw new Error(JSON.stringify(result));const image=new Image();image.src=result.images[0];await image.decode();const c=document.createElement('canvas');c.width=120;c.height=72;const ctx=c.getContext('2d');ctx.drawImage(image,0,0,120,72);const p=ctx.getImageData(0,0,120,72).data;let orange=0,blue=0;for(let i=0;i<p.length;i+=4){if(p[i]>100&&p[i]>p[i+2]*1.3)orange++;if(p[i+2]>80&&p[i+2]>p[i]*1.3)blue++;}return {orange,blue,image:result.images[0]};})()`);
    assert(result.orange>20&&result.blue>20,JSON.stringify({orange:result.orange,blue:result.blue}));await fs.writeFile(path.join(out,'three-agent-capture.png'),Buffer.from(result.image.split(',')[1],'base64'));
  });
  await step('原生离线放映支持鼠标旋转缩放平移、单指与双指手势，操作不翻页',async()=>{
    await cdp.send('Page.navigate',{url:pathToFileURL(path.join(out,'three-native.html')).href});await loaded();await assertPixels();const index=await ev(`window.__WPX__.getState().current`);await gestures();assert.equal(await ev(`window.__WPX__.getState().current`),index);await screenshot('three-native-offline');
  });
  await step('原稿插入补丁保存为源码，导出后从 file:// 重建交互 3D',async()=>{
    const content='<!doctype html><html><head><style>html,body{margin:0;background:#111827;color:white}.slide{position:absolute;inset:0}.slide:not(.active){display:none}#stage{position:relative;width:100vw;height:100vh}</style></head><body><div id="stage"><section class="slide active"><h1>3D raw</h1></section><section class="slide"><h1>Second</h1></section></div><script>document.addEventListener("keydown",e=>{if(e.key==="ArrowRight"||e.key==="ArrowLeft")document.querySelectorAll(".slide").forEach(x=>x.classList.toggle("active"));})</script></body></html>';
    rawId=(await json('/api/projects/import',{name:'3D Raw QA',fileName:'three-raw.html',content,mode:'raw'})).project.id;
    await cdp.send('Page.navigate',{url:appBase+'/?qa=1#/p/'+rawId});await ready();await insert3d();await editorGestures();
    await cdp.send('Page.reload');await ready();await loaded(V);await assertPixels(V);
    const html=await(await fetch(appBase+'/api/projects/'+rawId+'/export')).text();assert(html.includes('WDS_THREE'));assert(!html.includes('src="/app/vendor/three'));await fs.writeFile(path.join(out,'three-raw.html'),html);
    await cdp.send('Page.navigate',{url:pathToFileURL(path.join(out,'three-raw.html')).href});await loaded();await assertPixels();await gestures();assert(await ev(`document.querySelector('.slide').classList.contains('active')`));await screenshot('three-raw-offline');
  });
  await step('静态单文件工作台支持动态插入与离线 3D 导出',async()=>{
    const build=launch('scripts/build-static.mjs',['--output',path.join(data,'WebDeck.html')]);assert.equal(await new Promise(r=>build.once('exit',r)),0);
    await cdp.send('Page.navigate',{url:pathToFileURL(path.join(data,'WebDeck.html')).href+'?qa=1#/'});await until(()=>ev(`!!${W}?.agent?.loop&&!!window.__WDS_STATIC__&&!${W}.agent.loop.getState().loading`),'静态工作台');
    const project=await ev(`(async()=>{const r=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Static 3D QA',templateId:'knowledge-garden'})});return (await r.json()).project})()`);
    await ev(`${W}.navigate('#/p/'+${JSON.stringify(project.id)})`);await ready();await insert3d();await assertPixels(V);await editorGestures();
    const html=await ev(`fetch('/api/projects/'+${JSON.stringify(project.id)}+'/export').then(r=>r.text())`);assert(html.includes('WDS_THREE'));await fs.writeFile(path.join(out,'three-static-export.html'),html);
    await cdp.send('Page.navigate',{url:pathToFileURL(path.join(out,'three-static-export.html')).href});await loaded();await assertPixels();await gestures();await screenshot('three-static-offline');
  });
  await step('无外部 CDN 或模型请求，无 JavaScript 异常',async()=>{assert.deepEqual(report.external,[]);assert.deepEqual(report.errors,[]);});
}catch(error){report.fatal=error.stack;console.error(error.stack);process.exitCode=1;try{await screenshot('three-failure');}catch{}}
finally{await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'three-report.json'),JSON.stringify(report,null,2));cdp?.ws.close();for(const child of children.reverse())child.kill();console.log(report.steps.filter(s=>s.ok).length+'/'+report.steps.length+' checks passed');}
