import { favoriteReply } from './qa-favorites.mjs';
/* Local deterministic model for browser acceptance; never reads real provider keys. */
import http from 'node:http';
import {detailedSvgFixture} from './svg-fixture.mjs';
const port = Number(process.env.AGENT_MOCK_PORT || 4619);
const streams = new Map();
let generatedImages = 0;
const imagePayloads = [];
const teamRequests=[];
const parallelStats={requests:[],active:0,maxActive:0};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const text = '已经完成修改，整份演示的视觉节奏现在更加统一。\n\n### 这次做了什么\n\n- 读取工程与当前页面，保留原有内容。\n- 插入一句新的说明文字，修改已记录在历史中。\n- 检查页面状态，生成可以继续编辑的结果。\n\n| 项目 | 结果 |\n| --- | --- |\n| 工程状态 | 已保存 |\n| 内容检查 | 通过 |\n| 后续修改 | 可以继续 |\n\n你可以接着告诉我需要调整的细节。';
http.createServer(async (req, res) => {
  if(req.url==='/test/parallel-stats'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(parallelStats));return;}
  if(req.url==='/test/team-stats'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(teamRequests));return;}
  if (req.url === '/test/image-stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ generatedImages, imagePayloads })); return; }
  if (req.url === '/v1/models' || req.url === '/v1/images/generations/models') {
    if (req.headers.authorization === 'Bearer bad-key') { res.writeHead(401); res.end('{}'); return; }
    if (req.headers.authorization === 'Bearer slow-key') await sleep(1200);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'workspace-test', context_length: 131072, tool_call: true }, { id: req.headers.authorization === 'Bearer slow-key' ? 'gpt-image-stale' : 'gpt-image-1.5' }, { id: 'text-embedding-3' }] })); return;
  }
  if (req.url === '/search' || req.url === '/v1/tools/search') {
    for await (const _ of req) { /* consume */ }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results: [{ title: 'Local search result', url: 'https://example.com', content: 'Presentation layout' }] })); return;
  }
  if (req.url === '/v1/images/generations' && req.method === 'POST') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    imagePayloads.push(JSON.parse(raw)); generatedImages++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII=' }] })); return;
  }
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'workspace-test', context_length: 131072, tool_call: true }] })); return; }
  let raw = ''; for await (const c of req) raw += c;
  const payload = JSON.parse(raw), msgs = payload.messages || [];
  const user = [...msgs].reverse().find((m) => m.role === 'user' && !(Array.isArray(m.content)&&m.content[0]?.text?.startsWith('Visual evidence from deck_capture_slide')));
  const userText = typeof user?.content === 'string' ? user.content : user?.content?.find((b) => b.type === 'text')?.text || '';
  const names = new Map(msgs.flatMap((m) => (m.tool_calls || []).map((c) => [c.id, c.function.name])));
  const current = msgs.slice(msgs.lastIndexOf(user) + 1).map((m) => m.role === 'tool' ? { ...m, name: names.get(m.tool_call_id) } : m);
  const key = payload.model + JSON.stringify(user), n = streams.get(key) || 0;
  streams.set(key, n + 1);
  if (userText.includes('ERROR401')) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '模拟密钥错误' } })); return; }
  const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  const done = (reason = 'stop') => { send({}, reason); res.write('data: [DONE]\n\n'); res.end(); };
  if (userText.includes('PASTE_IMAGE_QA')) {
    const image = Array.isArray(user.content) && user.content.find(block => block.type === 'image_url');
    send({ content: image?.image_url?.url?.startsWith('data:image/png;base64,iVBOR') ? '上游已收到实际图片' : '上游没有收到图片' });
    done();
    return;
  }
  if (userText === '请只回复 OK') { send({ content: 'OK' }); done(); return; }
  const emitCalls = async (list) => {
    for (let i = 0; i < list.length; i++) {
      const c = list[i], half = Math.floor(c.function.arguments.length / 2);
      send({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments.slice(0, half) } }] });
      await sleep(45); send({ tool_calls: [{ index: i, function: { arguments: c.function.arguments.slice(half) } }] });
    }
    done('tool_calls');
  };
  if (payload.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '非流式完整回答。' }, finish_reason: 'stop' }] })); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  const favorite=favoriteReply(msgs);if(favorite){send(favorite);done(favorite.tool_calls?'tool_calls':'stop');return;}
  if(msgs[0]?.content?.startsWith('Maintain a complete working memory')){send({content:'保留中文标题、深色背景，关键文件 assets/diagram.svg；继续完成布局。'});done();return;}
  if(userText.includes('COMPACTION_QA')){send({content:'已根据工作记忆继续。'});done();return;}
  if(userText.includes('SVG_PARALLEL_QA')){
    const workerSystem=msgs.find(m=>m.role==='system'&&String(m.content).includes('Independent parallel worker'));
    if(workerSystem){
      const id=/Task ID: ([\w-]+)/.exec(workerSystem.content)?.[1];
      const entry={id,model:payload.model,task:'svg',attempt:n,guide:workerSystem.content.includes('### 8. Inspect pixels'),contract:userText.includes('motor center 500,350'),tools:(payload.tools||[]).map(t=>t.function.name),startedAt:Date.now()};
      parallelStats.requests.push(entry);parallelStats.active++;parallelStats.maxActive=Math.max(parallelStats.maxActive,parallelStats.active);
      let closed=false;const finish=()=>{if(!closed){closed=true;parallelStats.active--;entry.finishedAt=Date.now();}};res.on('close',finish);
      send({content:id==='drawing'&&n===0?'A plan only: I will draw the motor.':id==='drawing'?'```svg\n':'Semantic review: '});
      await sleep(id==='drawing'?600:1000);
      if(res.destroyed){finish();return;}
      if(id==='drawing'&&n>0)send({content:detailedSvgFixture()+'\n```\nComplete component inventory: housing, stator coils, rotor bars, air gap, shaft/key, field arrows, annotation leaders and winding detail inset. Display at 1200 by 700.'});
      else if(id!=='drawing')send({content:'The supplied motor topology and annotation anchors are consistent for a teaching schematic. Inspect all labels, arrow references and local gradients in the integrated page; this is not approval of a future rendering.'});
      done();finish();return;
    }
    const ready=current.some(m=>m.role==='tool'&&m.tool_call_id.startsWith('svg-layout-')&&JSON.parse(m.content).ok!==false);
    parallelStats.requests.push({id:'lead',task:'svg',startedAt:Date.now(),independentReady:ready,backgroundActive:parallelStats.active,requestedTool:payload.tool_choice?.function?.name});
    const dispatch=current.findLast(m=>m.role==='tool'&&m.name==='agent_parallel');
    if(!dispatch){await emitCalls([call('svg-dispatch-'+n,'agent_parallel',{sharedContext:'viewBox 0 0 1200 700; motor center 500,350; labels in x=880..1190; unique prefix motor-; detail inset x=20 y=420; match dark navy slide.',tasks:[{id:'drawing',role:'implement',artifact:'svg',task:'Draw a complete detailed SVG electric motor section with coils, rotor bars, shaft, air gap, leaders and winding detail inset.'},{id:'validation',role:'review',artifact:'analysis',task:'Check the scientific topology and annotation anchors in the supplied motor contract.'}]})]);return;}
    if(!ready){await emitCalls([call('svg-layout-'+n,'deck_insert_text',{text:'电机的结构与能量传递',x:140,y:80,w:1600,h:110,styles:{color:'#e6f2f6','font-size':'64px','font-weight':'700'}})]);return;}
    const batch=JSON.parse(dispatch.content);
    if(!batch.complete){await emitCalls([call('svg-wait-'+n,'agent_wait',{batchId:batch.batchId})]);return;}
    if(!current.some(m=>m.role==='tool'&&m.name==='deck_insert_svg')){
      const worker=batch.workers.find(w=>w.id==='drawing'),source=[...worker.content.matchAll(/```svg\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
      await emitCalls([call('svg-insert-'+n,'deck_insert_svg',{svg:source,x:300,y:210,w:1440,h:840})]);return;
    }
    if(!current.some(m=>m.role==='tool'&&m.name==='deck_capture_slide')){await emitCalls([call('svg-capture-'+n,'deck_capture_slide',{index:0,scale:.7})]);return;}
    const evidence=msgs.flatMap(m=>Array.isArray(m.content)?m.content:[]).some(b=>b.type==='image_url'&&b.image_url?.url?.startsWith('data:image/png;base64,'));
    send({content:evidence?'SVG_PARALLEL_QA_DONE：完整图解已写入，已收到真实页面画面。':'SVG_PARALLEL_QA_MISSING_PIXELS'});done();return;
  }
  if(userText.includes('PARALLEL_QA')){
    const workerSystem=msgs.find(m=>m.role==='system'&&String(m.content).includes('Independent parallel worker'));
    if(workerSystem){
      const id=/Task ID: ([\w-]+)/.exec(workerSystem.content)?.[1],role=/Role: (\w+)/.exec(workerSystem.content)?.[1];
      const entry={id,role,model:payload.model,task:userText.includes('PARALLEL_QA_STOP')?'stop':userText.includes('PARALLEL_QA_TEAM')?'team':'normal',attempt:n,tools:(payload.tools||[]).map(t=>t.function.name),startedAt:Date.now()};
      parallelStats.requests.push(entry);parallelStats.active++;parallelStats.maxActive=Math.max(parallelStats.maxActive,parallelStats.active);
      let closed=false;const finish=()=>{if(!closed){closed=true;parallelStats.active--;entry.finishedAt=Date.now();}};res.on('close',finish);
      send({content:id==='geometry'?'SCENE_JSON\n':'WORKER_'+id.toUpperCase()+'_PARTIAL\n'});
      await sleep(userText.includes('PARALLEL_QA_STOP')&&id==='interaction'&&n===0?30000:id==='geometry'?850:1400);
      if(res.destroyed){finish();return;}
      send({content:id==='geometry'?JSON.stringify({background:'#17243b',camera:{position:[4,3,5],target:[0,0,0]},objects:[{id:'parallel-cube',type:'mesh',geometry:{type:'box',args:[2,2,2]},material:{color:'#66bbff',metalness:.2,roughness:.4}}]}):'Complete interaction or validation artifact; use built-in OrbitControls and check the integrated scene.'});
      done();finish();return;
    }
    const phase=/Current phase: (\w+)/.exec(msgs.findLast(m=>m.role==='system'&&String(m.content).includes('Three-role collaboration'))?.content||'')?.[1];
    const independentReady=current.some(m=>m.role==='tool'&&m.tool_call_id.startsWith('parallel-lead-layout-')&&JSON.parse(m.content).ok!==false);
    parallelStats.requests.push({id:'lead',phase,model:payload.model,requestedTool:payload.tool_choice?.function?.name,task:userText.includes('PARALLEL_QA_STOP')?'stop':userText.includes('PARALLEL_QA_TEAM')?'team':'normal',startedAt:Date.now(),independentReady,backgroundActive:parallelStats.active});
    if(phase==='review'){
      if(!current.some(m=>m.role==='tool'&&m.name==='deck_read_slide'))await emitCalls([call('parallel-review-read-'+n,'deck_read_slide',{index:0})]);
      else await emitCalls([call('parallel-reviewed-'+n,'agent_handoff',{target:'complete',task:'Read integrated 3D source after insertion; scene and added integration note are present.'})]);return;
    }
    if(phase==='final'){send({content:'PARALLEL_QA_DONE：三角色并行输出已整合，检查代理读取了实际页面。'});done();return;}
    if(phase==='implement'){
      if(!current.some(m=>m.role==='tool'&&m.tool_call_id.startsWith('parallel-integrate-note-')))await emitCalls([call('parallel-integrate-note-'+n,'deck_insert_text',{text:'PARALLEL_INTEGRATED',x:120,y:940,w:900,h:60})]);
      else await emitCalls([call('parallel-to-review-'+n,'agent_handoff',{target:'review',task:'Inspect the actual integrated 3D scene and integration note.'})]);return;
    }
    if(!current.some(m=>m.role==='tool'&&m.name==='agent_parallel')){
      const tasks=[{id:'geometry',role:'implement',task:'Generate complete local Three.js box scene JSON with camera, background and materials. Return SCENE_JSON followed by JSON.'},{id:'interaction',role:phase?'design':'review',task:'Generate interaction integration instructions using built-in controls; do not modify files.'}];
      if(phase)tasks.push({id:'validation',role:'review',task:'Independently inspect current state and propose concrete validation for the future integrated 3D scene.'});
      send({content:'我会在后台生成几何结构、交互与检查方案，同时完成页面布局和标题。'});await emitCalls([call('parallel-dispatch-'+n,'agent_parallel',{tasks})]);return;
    }
    if(!independentReady){send({content:'子代理正在生成场景，我继续完成独立的页面标题与布局。'});await emitCalls([call('parallel-lead-layout-'+n,'deck_insert_text',{text:'并行探索 · 三维结构',x:120,y:100,w:1200,h:90})]);return;}
    const batch=JSON.parse(current.findLast(m=>m.role==='tool'&&m.name==='agent_parallel').content);
    if(!current.some(m=>m.role==='tool'&&m.name==='deck_insert_3d')){
      const geometry=batch.workers?.find(w=>w.id==='geometry');
      if(geometry?.status!=='complete'){send({content:'标题已就绪，现在在场景整合节点等待几何代码，其余子任务继续运行。'});await emitCalls([call('parallel-geometry-wait-'+n,'agent_wait',{batchId:batch.batchId,taskIds:['geometry']})]);return;}
      const scene=JSON.parse(geometry.content.split('SCENE_JSON\n')[1]);
      await emitCalls([call('parallel-scene-'+n,'deck_insert_3d',{label:'并行子代理生成的立方体',scene,x:700,y:180,w:1000,h:700})]);return;
    }
    if(!batch.complete){send({content:'场景已整合，验收前收齐交互与检查结果。'});await emitCalls([call('parallel-final-wait-'+n,'agent_wait',{batchId:batch.batchId})]);return;}
    if(phase==='design'){await emitCalls([call('parallel-to-integrator-'+n,'agent_handoff',{target:'implement',task:'Preserve the integrated generated 3D scene, add an integration note, then request actual review.'})]);return;}
    if(!current.some(m=>m.role==='tool'&&m.name==='deck_get_3d_state')){await emitCalls([call('parallel-actual-state-'+n,'deck_get_3d_state',{})]);return;}
    send({content:'PARALLEL_QA_DONE：并行子代理返回的场景已实际写入页面。'});done();return;
  }
  if(userText.includes('VISUAL_TEST')){
    const image=msgs.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='image_url');
    if(n===0){send({content:'我会先查看实际页面，再根据坐标细调标题。'});await emitCalls([call('visual-before','deck_capture_slide',{index:0,scale:.5})]);}
    else if(n===1){if(!image?.image_url.url.startsWith('data:image/png;base64,')){send({content:'没有收到实际图片'});done();return;}await emitCalls([call('visual-move','deck_move_element',{elementId:'cover-title',dx:12,dy:8})]);}
    else if(n===2)await emitCalls([call('visual-after','deck_capture_slide',{index:0,elementId:'cover-title',scale:1})]);
    else {send({content:'已实际查看修改前后画面，并将标题精确右移 12px、下移 8px。'});done();}return;
  }
  if(userText.includes('TEAM_TEST')) {
    const phase=/Current phase: (\w+)/.exec(msgs.findLast(m=>m.role==='system'&&m.content.includes('Three-role collaboration'))?.content||'')?.[1];
    teamRequests.push({model:payload.model,phase,tools:payload.tools.map(t=>t.function.name)});
    const note=async(value)=>{send({content:value});await sleep(280);};
    if(phase==='design'&&n===0){await note('我会先读取工程，统一设计和关键代码，再拆分实现工作。');await emitCalls([call('team-state','deck_get_state',{})]);}
    else if(phase==='design'){await note('设计已确认，接下来由实现代理完成各部分代码。');await emitCalls([call('team-to-worker','agent_handoff',{target:'implement',task:'插入实现说明文本，并交给检查代理核对。'})]);}
    else if(phase==='implement'&&(n===0||n===2)){await note(n===0?'我正在按设计写入页面内容。':'我会根据检查意见修复实现并再次提交检查。');await emitCalls([call('team-write-'+n,'deck_insert_text',{text:n===0?'TEAM_IMPLEMENTED':'TEAM_FIXED',x:150,y:n===0?700:800,w:900,h:70})]);}
    else if(phase==='implement'){await note('实现已完成，交给检查代理读取真实页面。');await emitCalls([call('team-to-review-'+n,'agent_handoff',{target:'review',task:'检查新增的说明文字、位置和页面结构。'})]);}
    else if(phase==='review'&&(n===0||n===2)){await note('我会查看真实页面画面，检查内容和布局。');await emitCalls([call('team-read-'+n,payload.tools.some(t=>t.function.name==='deck_capture_slide')?'deck_capture_slide':'deck_read_slide',{index:0})]);}
    else if(phase==='review'&&n===1){await note('首次检查发现需要补充一条说明，退回实现代理。');await emitCalls([call('team-reject','agent_handoff',{target:'implement',task:'补充 TEAM_FIXED 说明，保留现有内容。'})]);}
    else if(phase==='review'){await note('已再次读取并核对修复结果。');await emitCalls([call('team-approved','agent_handoff',{target:'complete',task:'已读取真实页面，确认 TEAM_IMPLEMENTED 与 TEAM_FIXED 均存在且保留原有结构。'})]);}
    else {await note('三角色协作已完成，页面内容已写入并经过检查与修复。');done();}return;
  }
  if (userText.includes('IMAGE_INSERT_TEST')) {
    if (!current.some((m) => m.role === 'tool')) await emitCalls([call('image-insert-'+n,'deck_generate_image',{prompt:'知识花园中的一片叶子，柔和自然，右侧构图，留白',size:'1536x1024',quality:'high',background:'transparent',outputFormat:'webp',outputCompression:85,index:2,x:1450,y:700,w:240,h:200})]);
    else { send({content:'已生成配图并保存到当前对话素材目录，尚未插入页面。'}); done(); } return;
  }
  if(userText.includes('RICH_TEST')){
    const answer=String.raw`公式 $E=mc^2$，其中质量为 $m$。

$$\frac{-b\pm\sqrt{b^2-4ac}}{2a}$$

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><rect x="40" y="50" width="260" height="150" rx="20" fill="#e8edff"/><text x="170" y="140" text-anchor="middle" font-size="32" fill="#243258">原因</text><path d="M330 125H490" stroke="#5267df" stroke-width="4"/><rect x="520" y="50" width="240" height="150" rx="20" fill="#e8edff"/><text x="640" y="140" text-anchor="middle" font-size="32" fill="#243258">结果</text></svg>
\`\`\`

图解与公式已完整显示。`.replaceAll('\\`','`');
    for(let i=0;i<answer.length;i+=30){if(res.destroyed)return;send({content:answer.slice(i,i+30)});await sleep(12);}done();return;
  }
  if(userText.includes('PPT_IMPORT_TEST')){
    if(!current.some((m)=>m.role==='tool'))await emitCalls([call('ppt-import-'+n,'app_call_api',{operation:'projects.import',body:{importId:/upload-[a-z0-9-]+/.exec(userText)?.[0],fileName:'fixture.pptx',pptMode:'editable'}})]);
    else{send({content:'已将 PowerPoint 解析为可编辑网页，原文件与转换报告已保存。'});done();}return;
  }
  if (userText.includes('DELETE_CURRENT_TEST')) {
    if (!current.some((m) => m.role === 'tool')) await emitCalls([call('delete-' + n, 'app_call_api', { operation: 'projects.delete' })]);
    else { send({ content: '当前测试工程已删除，对话保留在工作区。' }); done(); }
    return;
  }
  if (userText.includes('STOP_TEST')) {
    if (msgs.some((m) => m.role === 'system' && String(m.content).includes('继续完成用户上一次任务'))) { send({ content: '续接已完成，先前进度仍然保留。' }); done(); return; }
    send({ content: '停止测试：这段正文应当完整保留。' });
    const interval = setInterval(() => { if (!res.destroyed) send({ content: '正在生成更多内容。' }); }, 80);
    res.on('close', () => clearInterval(interval)); return;
  }
  if (userText.includes('LENGTH_TEST')) {
    send({ content: n === 0 ? '第一段：开场。' : n === 1 ? '第二段：继续。' : '第三段：完成。' }); done(n < 2 ? 'length' : 'stop'); return;
  }
  if (userText.includes('DROP_TEST')) {
    send({ content: n === 0 ? '断流前保留下来的文字。' : '重连后完整的后半段。' }); if (n === 0) res.end(); else done(); return;
  }
  if (userText.includes('LONG_TEST')) {
    const long = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段：这是用于验证长回答阅读的内容，用户向上滚动时不应被强制拉回底部。\n\n`).join('') + 'END_OF_LONG_REPLY';
    for (let i = 0; i < long.length; i += 70) { if (res.destroyed) return; send({ content: long.slice(i, i + 70) }); await sleep(20); }
    done(); return;
  }
  if (userText.includes('QUEUE_TEST')) { send({ content: '正在处理排队测试。' }); await sleep(2000); send({ content: '第一项已完成。' }); done(); return; }
  if (userText.includes('FOLLOWUP') || userText.includes('ATTACHMENT') || userText.includes('MEMORY_TEST')) {
    send({ content: '收到你的补充。' + (msgs.some((m) => String(m.content).includes('品牌色使用蓝色')) ? '仍然记得品牌色使用蓝色。' : '') }); done(); return;
  }
  if (!current.some((m) => m.role === 'tool')) {
    send({ content: '我会先检查工程，再调整当前页面并复核结果。' });
    send({ reasoning_content: '读取工程状态，找到可修改的页面与元素，保留原有设计内容。' });
    await sleep(150);
    await emitCalls([call('plan-' + n, 'update_plan', { plan: [{ title: '读取工程', status: 'running' }, { title: '修改页面', status: 'pending' }, { title: '检查结果', status: 'pending' }] }), call('read-' + n, 'deck_get_state', {})]); return;
  }
  if (!current.some((m) => m.role === 'tool' && m.name === 'deck_insert_text')) {
    send({ reasoning_content: '现在插入说明文字，并检查网页接口与工程信息。' });
    await emitCalls([call('insert-' + n, 'deck_insert_text', { text: 'Agent 全新工作台验收', x: 160, y: 700, w: 1200, h: 90, styles: { fontSize: '46px' } }), call('apis-' + n, 'app_list_apis', {}), call('get-' + n, 'app_call_api', { operation: 'projects.get' })]); return;
  }
  if (!current.some((m) => m.role === 'tool' && m.name === 'update_plan' && m.content.includes('已完成 3'))) {
    await emitCalls([call('verify-' + n, 'deck_get_state', {}), call('done-' + n, 'update_plan', { plan: [{ title: '读取工程', status: 'done' }, { title: '修改页面', status: 'done' }, { title: '检查结果', status: 'done' }] })]); return;
  }
  for (let i = 0; i < text.length; i += 8) { if (res.destroyed) return; send({ content: text.slice(i, i + 8) }); await sleep(18); }
  done();
}).listen(port, '127.0.0.1', () => console.log('Agent mock: http://127.0.0.1:' + port));
