/* Isolated real-browser acceptance: concurrent product workers, UI and durable resume. */
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),out=path.join(root,'output','playwright');
const children=[],report={steps:[],errors:[]};let cdp;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){try{const x=await fn();if(x)return x;}catch{}await sleep(80);}throw new Error('等待超时：'+label);}
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const value=server.address().port;await new Promise(r=>server.close(r));return value;}
function launch(file,env){const child=spawn(process.execPath,[file],{cwd:root,env:{...process.env,...env},stdio:['ignore','ignore','pipe'],windowsHide:true});child.stderr.on('data',b=>{if(String(b).includes('Error'))console.error(String(b));});children.push(child);return child;}
class CDP{
  constructor(url){this.url=url;this.id=0;this.pending=new Map();}
  async open(){this.ws=new WebSocket(this.url);await new Promise((r,j)=>{this.ws.addEventListener('open',r);this.ws.addEventListener('error',j);});this.ws.addEventListener('message',({data})=>{const m=JSON.parse(data);if(m.id){const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')report.errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timeout'));},30000);this.pending.set(id,{resolve,reject,timer});});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
}
const ev=s=>cdp.eval(s),W='window.__WDS__',L=W+'.agent.loop',D=W+'.getEditor().iframe.contentDocument',V=W+'.getEditor().iframe.contentWindow';
const ready=()=>until(()=>ev(`!!${W}?.agent?.loop&&!${L}.getState().loading&&!!${W}.getEditor()?.bridge?.ready`),'工作台就绪');
const idle=()=>until(()=>ev(`!${L}.streaming`),'生成完成');
async function step(name,fn){try{await fn();report.steps.push({name,ok:true});console.log('✓ '+name);}catch(e){report.steps.push({name,ok:false,error:e.message});throw e;}}
async function shot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}
async function json(base,route,body){const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert(r.ok,route+': '+r.status);return r.json();}
async function openAgent(){if(!await ev(`document.querySelector('#app')?.dataset.agent==='open'`)){await ev(`${W}.bus.runCommand('app.toggleAgent')`);}await until(()=>ev(`document.querySelector('.agw-input')?.getBoundingClientRect().width>0`),'聊天可见');}
async function input(text){await ev(`(()=>{const e=document.querySelector('.agw-input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.focus();})()`);await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await until(()=>ev(`${L}.streaming`),'生成开始');}
async function effort(label){await ev(`document.querySelector('.agw-effort').click()`);await ev(`[...document.querySelectorAll('.agw-menu-item')].find(e=>e.textContent.trim()===${JSON.stringify(label)}||e.textContent.trim().startsWith(${JSON.stringify(label+' ·')})).click()`);}
async function newChat(){await ev(`${L}.newChat()`);await ready();}
async function unfold(){await ev(`document.querySelectorAll('.agw-ledger').forEach(e=>e.open=true)`);}
try{
  await fs.mkdir(out,{recursive:true});const appPort=await port(),modelPort=await port(),debugPort=await port(),base='http://127.0.0.1:'+appPort,mock='http://127.0.0.1:'+modelPort;
  const data=path.join(root,'output','agent-qa','parallel-'+Date.now());
  launch('server.mjs',{PORT:String(appPort),WDS_DATA_DIR:path.join(data,'data'),WDS_PROJECTS_DIR:path.join(data,'projects'),WDS_LOG:'0'});
  launch('scripts/mock-agent-workspace.mjs',{AGENT_MOCK_PORT:String(modelPort)});
  await until(async()=> (await fetch(base+'/api/health')).ok,'隔离服务');await until(async()=> (await fetch(mock+'/test/parallel-stats')).ok,'模拟模型');
  const modelIds=['workspace-test','parallel-designer','parallel-worker','parallel-reviewer'];
  const settings={providers:[{id:'workspace-test',name:'Parallel test only',baseUrl:mock+'/v1',wire:'openai',apiKey:'test-only',model:'workspace-test',models:modelIds.map(id=>({id,contextLength:131072,maxOutput:8192,tools:true,vision:false}))}],agent:{maxTokens:8192,collaboration:{design:{providerId:'workspace-test',model:'parallel-designer'},implement:{providerId:'workspace-test',model:'parallel-worker'},review:{providerId:'workspace-test',model:'parallel-reviewer'}}}};
  assert((await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).ok);
  const {project}=await json(base,'/api/projects',{name:'并行子代理验收',templateId:'blank'});
  const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--remote-debugging-port='+debugPort,'--user-data-dir='+path.join(data,'chrome'),'--window-size=1600,1000','about:blank'],{stdio:'ignore',windowsHide:true});children.push(chrome);
  const target=await until(async()=> (await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json()).find(p=>p.type==='page'),'Chrome');cdp=new CDP(target.webSocketDebuggerUrl);await cdp.open();await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('wds:agent:model',JSON.stringify({providerId:'workspace-test',model:'workspace-test'}));localStorage.setItem('wds:agent:permission','full');`});
  await cdp.send('Page.navigate',{url:base+'/?qa=1#/p/'+project.id});await ready();await openAgent();
  await step('普通思考使用当前模型真正并行生成，聊天显示各代理实时状态和输出',async()=>{
    await input('PARALLEL_QA_NORMAL 构建一个可交互的 3D 立方体');
    await until(()=>ev(`document.querySelectorAll('.agw-workers .agw-worker[data-state="running"]').length>=2`),'两个子代理同时运行');
    assert(await ev(`document.querySelector('.agw-workers').textContent.includes('workspace-test')`));
    await shot('agent-parallel-live');await idle();assert.equal(await ev(`${L}.getState().lastError?.message||null`),null);
    const stats=await json(mock,'/test/parallel-stats'),workers=stats.requests.filter(r=>r.task==='normal'&&r.id!=='lead');
    assert.equal(workers.length,2);assert(workers.every(w=>w.model==='workspace-test'));assert(stats.maxActive>=2);
    assert.equal(stats.requests.find(r=>r.task==='normal'&&r.id==='lead').requestedTool,'agent_parallel');
    assert(workers.every(w=>!w.tools.some(t=>['agent_parallel','agent_handoff','file_write','deck_set_text'].includes(t))));
    const continuing=stats.requests.find(r=>r.task==='normal'&&r.id==='lead'&&r.independentReady&&r.backgroundActive>0);
    assert(continuing,'主模型在子代理运行期间完成独立写入并继续请求');
    assert(continuing.startedAt<Math.min(...workers.map(w=>w.finishedAt)),'独立布局在子代理完成前已写入');
    assert(await ev(`${L}.messages.some(m=>m.name==='agent_wait'&&JSON.parse(m.content).taskIds?.includes('geometry'))`));
    assert(await ev(`${D}.body.textContent.includes('并行探索 · 三维结构')`));
    await unfold();assert.equal(await ev(`document.querySelectorAll('.agw-workers .agw-worker[data-state="complete"]').length`),2);
    assert(await ev(`${L}.messages.find(m=>m.name==='agent_parallel').content.includes('SCENE_JSON')`));
  });
  await step('并行输出由主代理实际写入 3D 页面，并建立完整版本',async()=>{
    await until(()=>ev(`${V}.__WDS_THREE__?.getState().instances.some(x=>x.ready)`),'Three.js 实例');
    assert(await ev(`${D}.querySelector('[data-wds-three] script').textContent.includes('parallel-cube')`));
    const turn=await ev(`${L}.messages.find(m=>m.role==='user')`);assert(turn.versions[project.id].before);assert(turn.versions[project.id].after);
    assert(await ev(`document.querySelector('.agw-final').textContent.includes('PARALLEL_QA_DONE')`));
    assert(await ev(`${L}.messages.find(m=>m.name==='deck_insert_3d').content.includes('"ok":true')`));await shot('agent-parallel-integrated');
  });
  await step('刷新后并行记录、模型、完整生成代码和 3D 结构恢复',async()=>{
    const origin=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${origin}`),'刷新');await ready();await openAgent();await unfold();
    assert.equal(await ev(`document.querySelectorAll('.agw-worker[data-state="complete"]').length`),2);
    assert(await ev(`${L}.messages.find(m=>m.role==='user').parallelRuns[0].workers[0].content.includes('SCENE_JSON')`));
    assert(await ev(`${D}.querySelector('[data-wds-three] script').textContent.includes('parallel-cube')`));
  });
  await step('极高思考同时调用三个角色模型，整合后执行实际只读检查',async()=>{
    await newChat();await effort('极高');await input('PARALLEL_QA_TEAM 构建 3D 结构并完成检查');
    await until(()=>ev(`document.querySelectorAll('.agw-worker[data-state="running"]').length===3`),'三个角色并行');await shot('agent-parallel-three-models');await idle();
    assert.equal(await ev(`${L}.getState().lastError?.message||null`),null);
    const stats=await json(mock,'/test/parallel-stats'),workers=stats.requests.filter(r=>r.task==='team'&&r.id!=='lead');
    assert.deepEqual(workers.map(w=>w.model).sort(),['parallel-designer','parallel-reviewer','parallel-worker']);
    assert(stats.maxActive>=3);assert.equal(await ev(`${L}.messages.find(m=>m.collaboration).collaboration.phase`),'done');
    assert(await ev(`${D}.body.textContent.includes('PARALLEL_INTEGRATED')`));
    const reads=await ev(`${L}.messages.filter(m=>m.agentRole?.role==='review'&&m.name==='deck_read_slide')`);assert.equal(reads.length,1);assert(reads[0].content.includes('parallel-cube'));
    await unfold();assert.equal(await ev(`document.querySelectorAll('.agw-worker[data-state="complete"]').length`),3);
  });
  await step('停止后保留已完成结果和未完成输出，刷新继续只恢复未完成代理',async()=>{
    await newChat();await effort('中');await input('PARALLEL_QA_STOP 构建一个 3D 结构');
    await until(()=>ev(`document.querySelector('.agw-worker[data-state="complete"]')&&document.querySelector('.agw-worker[data-state="running"]')`),'一个完成一个生成中');
    await ev(`document.querySelector('[aria-label="停止生成"]').click()`);await idle();
    assert.equal(await ev(`${L}.messages.find(m=>m.role==='user').parallelRuns[0].workers.find(w=>w.id==='geometry').status`),'complete');
    assert(await ev(`${L}.messages.find(m=>m.role==='user').parallelRuns[0].workers.find(w=>w.id==='interaction').content.includes('PARTIAL')`));
    const origin=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${origin}`),'停止后刷新');await ready();await openAgent();await unfold();
    assert(await ev(`document.querySelector('.agw-worker[data-state="stopped"]')!==null`));
    await ev(`[...document.querySelectorAll('.agw-turn-actions button')].find(e=>e.textContent.includes('继续处理')).click()`);await until(()=>ev(`${L}.streaming`),'继续');await idle();
    assert.equal(await ev(`${L}.getState().lastError?.message||null`),null);
    const workers=(await json(mock,'/test/parallel-stats')).requests.filter(r=>r.task==='stop'&&r.id!=='lead');
    assert.equal(workers.filter(w=>w.id==='geometry').length,1);assert.equal(workers.filter(w=>w.id==='interaction').length,2);
    const result=JSON.parse(await ev(`${L}.messages.find(m=>m.name==='agent_parallel').content`));assert(result.ok);assert(result.workers.every(w=>w.status==='complete'));
    await unfold();await shot('agent-parallel-resumed');
  });
  await step('SVG 分发专门绘图与检查代理，提纲自动补全为完整源码，主模型同时写入独立标题',async()=>{
    settings.providers[0].models=settings.providers[0].models.map(m=>m.id==='workspace-test'?{...m,vision:true}:m);
    assert((await fetch(base+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).ok);
    const svgProject=(await json(base,'/api/projects',{name:'SVG 精细绘图验收',templateId:'blank'})).project;
    await ev(`${W}.navigate('#/p/'+${JSON.stringify(svgProject.id)})`);await ready();
    await ev(`(async()=>{const settings=await ${W}.api.getSettings();${W}.store.update(s=>{s.settings={...s.settings,...settings}});await ${W}.getEditor().bridge.call('setSlideAttrs',{index:0,attrs:{bg:'#0b1b2a'}});})()`);
    await openAgent();await newChat();await effort('中');
    await input('SVG_PARALLEL_QA 绘制十分详细的 SVG 电机剖面、绕组细节和科学标注');
    await until(()=>ev(`document.querySelectorAll('.agw-workers .agw-worker[data-state="running"]').length>=2`),'SVG 子代理并行');await idle();
    assert.equal(await ev(`${L}.getState().lastError?.message||null`),null);
    const stats=await json(mock,'/test/parallel-stats'),workers=stats.requests.filter(r=>r.task==='svg'&&r.id!=='lead');
    assert.equal(workers.filter(w=>w.id==='drawing').length,2);assert.equal(workers.filter(w=>w.id==='validation').length,1);
    assert(workers.every(w=>w.guide&&w.contract));assert(workers.every(w=>w.model==='workspace-test'));
    assert(stats.requests.some(r=>r.task==='svg'&&r.id==='lead'&&r.independentReady&&r.backgroundActive>0));
    const result=await ev(`(()=>{const turn=${L}.messages.find(m=>m.role==='user');const w=turn.parallelRuns[0].workers.find(w=>w.id==='drawing');const svg=${D}.querySelector('[data-wds-svg] svg');return {status:w.status,checks:w.artifactChecks,groups:svg?.querySelectorAll('g').length,paths:svg?.querySelectorAll('path').length,gradient:!!svg?.querySelector('#motor-copper'),arrow:!!svg?.querySelector('[marker-end="url(#motor-arrow)"]'),labels:svg?.querySelectorAll('text').length,done:document.querySelector('.agw-final')?.textContent,version:turn.versions[${JSON.stringify(svgProject.id)}]};})()`);
    assert.equal(result.status,'complete');assert(result.checks.ok);assert.equal(result.checks.visualInspection,false);
    assert(result.groups>30&&result.paths>70&&result.labels>=7);assert(result.gradient&&result.arrow);
    assert(result.done.includes('SVG_PARALLEL_QA_DONE'));assert(result.version.before&&result.version.after);
    await shot('agent-svg-integrated');
    const html=await(await fetch(base+'/api/projects/'+svgProject.id+'/export')).text();assert(html.includes('motor-stator')&&html.includes('motor-detail'));
    await fs.writeFile(path.join(out,'svg-parallel-export.html'),html);
    const origin=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${origin}`),'SVG 刷新');await ready();
    assert(await ev(`${D}.querySelector('[data-wds-svg]').getAttribute('data-wds-svg').includes('motor-detail')`));
    assert(await ev(`${L}.messages.find(m=>m.role==='user').parallelRuns[0].workers.find(w=>w.id==='drawing').artifactChecks.ok`));
  });
  await step('浏览器无 JavaScript 异常',async()=>assert.deepEqual(report.errors,[]));
}catch(error){report.fatal=error.stack;console.error(error.stack);process.exitCode=1;try{await shot('agent-parallel-failure');}catch{}}
finally{await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'agent-parallel-report.json'),JSON.stringify(report,null,2));cdp?.ws.close();for(const child of children.reverse())child.kill();console.log(report.steps.filter(s=>s.ok).length+'/'+report.steps.length+' checks passed');}
