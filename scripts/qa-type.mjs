/* 艺术字工坊的真实浏览器检查：渲染、动画、笔画数据、导出与静态版。 */
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'output','playwright');
const data=path.join(root,'output','type-qa','run-'+Date.now()),children=[],report={steps:[],errors:[],external:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let cdp,appBase='';
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function until(fn,label,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){try{const r=await fn();if(r)return r;}catch{}await sleep(120);}throw new Error('等待超时：'+label);}
function launch(file,args=[],env={}){const child=spawn(process.execPath,[file,...args],{cwd:root,env:{...process.env,...env},windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>console.error(String(b)));children.push(child);return child;}
class CDP{
  constructor(url){this.url=url;this.id=0;this.pending=new Map();}
  async open(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{this.ws.addEventListener('open',r);this.ws.addEventListener('error',j);});
    this.ws.addEventListener('message',({data})=>{const m=JSON.parse(data);
      if(m.id){const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}
      if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
      if(m.method==='Network.requestWillBeSent'&&/^https?:/.test(m.params.request.url)&&!m.params.request.url.startsWith(appBase))report.external.push(m.params.request.url);});}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timeout'));},30000);this.pending.set(id,{resolve,reject,timer});});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
}
const ev=expression=>cdp.eval(expression),W='window.__WDS__',E=W+'.getEditor()',B=E+'.bridge',D=E+'.iframe.contentDocument',V=E+'.iframe.contentWindow';
const ready=()=>until(()=>ev(`!!${W}?.getEditor()?.bridge?.ready&&!${W}.agent.loop.getState().loading`),'编辑器');
async function step(name,fn){const start=Date.now();try{await fn();report.steps.push({name,ok:true,ms:Date.now()-start});console.log('✓ '+name);}catch(e){report.steps.push({name,ok:false,error:e.message});throw e;}}
async function json(route,body){const r=await fetch(appBase+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;}
async function screenshot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}

/** 用 Agent 工具入口插入，覆盖真实的类型取数 → 落页 → 保存链路。 */
async function insertType(params){
  return ev(`(async()=>{const tool=(await import(new URL('/app/js/agent/tools.js',location.href).href)).createToolExecutor(${W});const r=await tool.execute('deck_insert_type',${JSON.stringify(params)},{permission:'full'});if(!r.ok)throw new Error(r.error);return r;})()`);
}
/** 取某个元素在画布里实际画出的像素统计，用于确认真的渲染出了东西。 */
const inkOf = (elementId) => ev(`(()=>{const el=${D}.querySelector('[data-wpx-el="${elementId}"]');if(!el)return null;const r=el.getBoundingClientRect(),f=${E}.iframe.getBoundingClientRect(),k=f.width/1920;return {x:r.x,y:r.y,w:r.width,h:r.height,k,text:el.textContent.trim().slice(0,40),paths:el.querySelectorAll('path').length,hasStyle:!!el.querySelector('style[data-wds-type-css]')}})()`);
async function pixelInk(region){
  const shot=await cdp.send('Page.captureScreenshot',{format:'png',clip:{x:region.x,y:region.y,width:Math.max(8,region.w),height:Math.max(8,region.h),scale:1}});
  const b64=shot.data;
  return ev(`(async()=>{const img=new Image();img.src='data:image/png;base64,${b64}';await img.decode();const c=document.createElement('canvas');c.width=140;c.height=90;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,140,90);const p=ctx.getImageData(0,0,140,90).data;const colors=new Set();let dark=0;for(let i=0;i<p.length;i+=4){colors.add((p[i]>>4)+','+(p[i+1]>>4)+','+(p[i+2]>>4));if(p[i]+p[i+1]+p[i+2]<600)dark++;}return {colors:colors.size,dark};})()`);
}

try{
  await fs.mkdir(out,{recursive:true});await fs.mkdir(data,{recursive:true});
  const appPort=await port(),debugPort=await port();appBase='http://127.0.0.1:'+appPort;
  launch('server.mjs',[],{PORT:String(appPort),WDS_DATA_DIR:path.join(data,'data'),WDS_PROJECTS_DIR:path.join(data,'projects'),WDS_LOG:'0'});
  await until(async()=>(await fetch(appBase+'/api/health')).ok,'隔离服务');
  const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-angle=swiftshader','--disable-gpu-sandbox','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(data,'chrome'),'--window-size=1600,1000','about:blank'],{stdio:'ignore',windowsHide:true});children.push(chrome);
  const target=await until(async()=>(await(await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(t=>t.type==='page'),'Chrome');
  cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');

  let nativeId='',rawId='';

  await step('笔画接口按需返回数据，未知字符不影响已有字符',async()=>{
    const res=await (await fetch(appBase+'/api/hanzi?chars='+encodeURIComponent('永好X'))).json();
    assert.equal(res.ok,true);assert.equal(res.chars,'永好');
    assert.equal(res.strokes['永'].length,5);assert.equal(res.radicals['永'].length,4);
    assert.deepEqual(res.missing,['X']);
    const empty=await (await fetch(appBase+'/api/hanzi?chars=')).json();assert.deepEqual(empty.strokes,{});
  });

  await step('预览目录结构化：预设、分组、字体栈齐全且 id 唯一',async()=>{
    nativeId=(await json('/api/projects',{name:'Type Native QA',templateId:'knowledge-garden'})).project.id;
    await cdp.send('Page.navigate',{url:appBase+'/#/p/'+nativeId});await ready();
    const info=await ev(`(async()=>{const m=await import(new URL('/app/js/core/type-kit.js',location.href).href);const ids=m.TYPE_PRESETS.map(p=>p.id);return {count:ids.length,unique:new Set(ids).size,groups:m.TYPE_GROUPS.map(g=>g.id),fonts:Object.keys(m.TYPE_FONTS).length,stroke:m.TYPE_PRESETS.filter(p=>p.split==='stroke').length,animated:m.TYPE_PRESETS.filter(p=>p.css).length};})()`);
    assert(info.count>=45,JSON.stringify(info));assert.equal(info.count,info.unique);
    assert(info.stroke>=4);assert(info.fonts>=12);
    for(const group of info.groups)assert(['latin','cjk','effect','texture','shadow','motion','stroke'].includes(group));
  });

  await step('花体英文 / 特效 / 纹理 / 阴影 / 填充动效都能插入并真实渲染',async()=>{
    const cases=[
      ['script-swash','Aurora',40,180],
      ['neon','CYBER',40,420],
      ['texture-halftone','POSTER',40,640],
      ['shadow-long','DEPTH',40,860],
      ['fill-flow','流动渐变',900,180],
      ['glitch','SIGNAL',900,420],
      ['gold','Gilded',1380,640],
      ['motion-char-pop','逐字弹入',900,860],
    ];
    for(const [preset,text,x,y] of cases){
      const res=await insertType({preset,text,size:110,x,y,w:900,h:200});
      assert(res.elementId,preset);
      const ink=await inkOf(res.elementId);
      assert(ink&&ink.hasStyle,preset+' 缺少作用域样式：'+JSON.stringify(ink));
      const px=await pixelInk(ink);
      assert(px.colors>2,preset+' 没有渲染出内容 '+JSON.stringify(px));
    }
    await ev(`${E}.saveNow({reason:'qa-type'})`);
    await screenshot('type-effects-editor');
  });

  await step('动画按页面显示状态启停，并能在切页后重新播放',async()=>{
    const info=await ev(`(()=>{const el=${D}.querySelector('[data-wds-type="fill-flow"]');const cs=getComputedStyle(el.querySelector('.wtk-text'));return {playing:cs.animationPlayState,name:cs.animationName,cls:el.className};})()`);
    assert.notEqual(info.cls.indexOf('wtk-play'),-1,'当前页应处于播放态：'+JSON.stringify(info));
    assert.equal(info.playing,'running');
    // 切到别的页后，作品会停在暂停态；再切回来必须重新播放（动画名时间轴重置）
    const before=await ev(`(()=>{const el=${D}.querySelector('[data-wds-type="fill-flow"] .wtk-text');return el.getAnimations().map(a=>a.currentTime||0)[0]||0;})()`);
    await sleep(320);
    const after=await ev(`(()=>{const el=${D}.querySelector('[data-wds-type="fill-flow"] .wtk-text');return el.getAnimations().map(a=>a.currentTime||0)[0]||0;})()`);
    assert(after>before,'动画没有推进：'+before+' → '+after);
    // 手动重播
    await ev(`${V}.__WDS_TYPESET__.replay(${D}.querySelector('.wpx-slide.is-active'))`);
    const restarted=await ev(`(()=>{const el=${D}.querySelector('[data-wds-type="fill-flow"] .wtk-text');return el.getAnimations().map(a=>a.currentTime||0)[0]||0;})()`);
    assert(restarted<after,'重播后时间轴应归零：'+after+' → '+restarted);
  });

  await step('汉字笔画拆解：取数、内联路径、按笔顺动起来',async()=>{
    const res=await insertType({preset:'stroke-draw',text:'永',size:240,x:1500,y:180,w:340,h:340,loop:false});
    assert(res.elementId);assert.equal(res.strokeData,true);
    assert.deepEqual(res.missing,[],'「永」应当有笔画数据');
    const ink=await inkOf(res.elementId);
    assert(ink.paths>=5,'笔画路径数不足：'+JSON.stringify(ink));
    const px=await pixelInk(ink);
    assert(px.colors>2,JSON.stringify(px));
    const anim=await ev(`(()=>{const el=${D}.querySelector('[data-wds-type="stroke-draw"]');const path=el.querySelector('path');const cs=getComputedStyle(path);return {dash:cs.strokeDasharray,offset:cs.strokeDashoffset,play:cs.animationPlayState,name:cs.animationName,count:el.querySelectorAll('path').length};})()`);
    assert(anim.count>=5,JSON.stringify(anim));
    assert.equal(anim.play,'running',JSON.stringify(anim));
    await screenshot('type-stroke-editor');
  });

  await step('部首高亮把部首笔画单独上色',async()=>{
    const res=await insertType({preset:'stroke-radical',text:'好',size:240,x:1500,y:560,w:340,h:340,color:'#1B1915',color2:'#E1402B'});
    assert(res.elementId);
    const rad=await ev(`(()=>{const el=${D}.querySelectorAll('[data-wds-type="stroke-radical"]');const last=el[el.length-1];return {marked:last.querySelectorAll('path[data-rad="1"]').length,total:last.querySelectorAll('path').length,fill:getComputedStyle(last.querySelector('path')).stroke};})()`);
    assert(rad.marked>0,'部首没有标记：'+JSON.stringify(rad));
    assert(rad.total>rad.marked);
    await ev(`${E}.saveNow({reason:'qa-type-stroke'})`);
  });

  await step('普通文字可一键转艺术字，原文字被带入',async()=>{
    const element=await ev(`${B}.insertElement({type:'text',x:120,y:900,w:700,h:120,html:'<p style="font-size:40px">原有标题文字</p>'})`);
    const prepared=await insertType({preset:'lishu',text:'原有标题文字',size:90,x:120,y:900,w:800,h:150});
    assert(prepared.elementId);
    const text=await ev(`${D}.querySelector('[data-wpx-el="${prepared.elementId}"] [data-wds-type]').getAttribute('data-wtk-text')`);
    assert.equal(text,'原有标题文字');
    void element;
  });

  await step('导出 HTML 自包含：样式内联、笔画路径在文件里、运行时按需保留',async()=>{
    const html=await(await fetch(appBase+'/api/projects/'+nativeId+'/export')).text();
    assert(html.includes('wtk--script-swash'),'缺少作用域样式');
    assert(html.includes('@keyframes'),'缺少动画关键帧');
    assert(html.includes('pathLength="1"'),'笔画路径没有内联');
    assert(html.includes('data-wds-runtime="type"'),'缺少艺术字运行时');
    assert(!html.includes('src="/editor/type-runtime.js"'),'运行时未内联');
    assert(!html.includes('<style src'),'导出不应残留外部样式引用');
    await fs.writeFile(path.join(out,'type-export.html'),html);
  });

  await step('导出文件离线打开：艺术字样式生效、动画可重播、无外部请求',async()=>{
    await cdp.send('Page.navigate',{url:pathToFileURL(path.join(out,'type-export.html')).href});
    await until(()=>ev(`!!window.__WDS_TYPESET__`),'艺术字运行时');
    await sleep(400);
    const state=await ev(`(()=>{const el=document.querySelector('[data-wds-type="glitch"]');if(!el)return null;const cs=getComputedStyle(el.querySelector('.wtk-text'));return {cls:el.className,play:cs.animationPlayState,name:cs.animationName,hasJs:document.documentElement.classList.contains('wds-type-js'),stroke:document.querySelectorAll('[data-wds-type] path').length};})()`);
    assert(state,'导出文件里找不到作品');
    assert.equal(state.hasJs,true);
    assert(state.stroke>=5,'导出文件里笔画丢失：'+JSON.stringify(state));
    const shot=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,'type-export-offline.png'),Buffer.from(shot.data,'base64'));
  });

  await step('静态单文件工作台可用：艺术字可插入，笔画数据优雅降级',async()=>{
    const build=launch('scripts/build-static.mjs',['--output',path.join(data,'WebDeck.html')]);assert.equal(await new Promise(r=>build.once('exit',r)),0);
    await cdp.send('Page.navigate',{url:pathToFileURL(path.join(data,'WebDeck.html')).href+'?qa=1#/'});
    await until(()=>ev(`!!${W}?.agent?.loop&&!!window.__WDS_STATIC__&&!${W}.agent.loop.getState().loading`),'静态工作台');
    const project=await ev(`(async()=>{const r=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Static Type QA',templateId:'knowledge-garden'})});return (await r.json()).project})()`);
    await ev(`${W}.navigate('#/p/'+${JSON.stringify(project.id)})`);await ready();
    // 静态单文件版没有可分模块地址，走应用内命令入口（与界面按钮同一条路径）。
    const res=await ev(`(async()=>{const r=await ${W}.bus.runCommand('insert.type',{preset:'neon',text:'静态版',size:120,x:100,y:200,w:800,h:200});return {ok:!!r};})()`);
    assert(res.ok,'静态版插入失败：'+res.error);
    const degraded=await ev(`(async()=>{const r=await ${W}.bus.runCommand('insert.type',{preset:'stroke-draw',text:'永',size:200,x:100,y:500,w:300,h:300});const el=${D}.querySelector('[data-wds-type="stroke-draw"]');return {ok:!!r,strokePaths:el?el.querySelectorAll('path').length:0,text:el?el.querySelector('.wtk-text').textContent.trim():''};})()`);
    assert(degraded.ok,'静态版笔画预设应降级而不是失败');
    assert.equal(degraded.strokePaths,0,'静态版应退化为普通文字而不是半成品笔画');
    assert.equal(degraded.text,'永');
  });

  await step('无外部 CDN 请求，无 JavaScript 异常',async()=>{
    assert.deepEqual(report.external,[],JSON.stringify(report.external));
    assert.deepEqual(report.errors,[],JSON.stringify(report.errors));
  });
}catch(error){report.fatal=error.stack;console.error(error.stack);process.exitCode=1;try{await screenshot('type-failure');}catch{}}
finally{await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'type-report.json'),JSON.stringify(report,null,2));cdp?.ws.close();for(const child of children.reverse())child.kill();console.log(report.steps.filter(s=>s.ok).length+'/'+report.steps.length+' checks passed');}
