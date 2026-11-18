import assert from 'node:assert/strict';

// Shared acceptance for the HTTP editor and the file:// workbench. All keys are fake.
export async function qaCompaction({ ev, cdp, until, shot, baseUrl, providerId, model, mode }) {
  const L = 'window.__WDS__.agent.loop';
  await ev(`(async()=>{
    const ctx=window.__WDS__;
    await ctx.api.putUserSettings({providers:[{id:'qa-memory',name:'Memory Service',baseUrl:${JSON.stringify(baseUrl)},apiKey:'qa-memory-key',wire:'openai',model:'memory-small',models:[{id:'memory-small',contextLength:8192,maxOutput:512,tools:false}]}],agent:{contextLimit:64000,compaction:{providerId:'',model:''}}});
    const data=await ctx.api.getSettings();ctx.store.update(s=>{s.settings={...data,loaded:true}});
    ${L}.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)});${L}.setOptions({reasoningEffort:'auto'});
    ctx.bus.runCommand('agent.openSettings');
  })()`);
  await until(() => ev(`!!document.querySelector('.ais-compaction')`), '上下文压缩设置');
  await ev(`(()=>{const s=document.querySelector('[aria-label="上下文压缩服务"]');s.value='qa-memory';s.dispatchEvent(new Event('change'));})()`);
  assert.deepEqual(await ev(`Array.from(document.querySelector('#ais-compaction-models').options,o=>o.value)`), ['memory-small']);
  await ev(`(()=>{const m=document.querySelector('[aria-label="上下文压缩模型"]');m.value='memory-small';m.dispatchEvent(new Event('input'));})()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await ev(`document.querySelector('.ais-compaction').scrollIntoView({block:'center'})`);
  assert(await ev(`(()=>{const r=document.querySelector('.ais-compaction').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0})()`));
  await shot('compaction-settings-' + mode);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await ev(`document.querySelector('.ais-dialog .modal-foot .btn--primary').click()`);
  await until(() => ev(`!document.querySelector('.ais-dialog')`), '保存压缩设置');
  const saved = await ev(`window.__WDS__.api.getSettings().then(s=>s.agent.compaction)`);
  assert.deepEqual(saved, { providerId: 'qa-memory', model: 'memory-small' });
  const origin = await ev('performance.timeOrigin'); await cdp.send('Page.reload');
  await until(() => ev(`performance.timeOrigin!==${origin}&&!!window.__WDS__?.agent?.loop&&!${L}.getState().loading`), '压缩设置刷新持久化');
  assert.deepEqual(await ev(`window.__WDS__.api.getSettings().then(s=>s.agent.compaction)`), saved);
  // Populate an isolated conversation, then use real browser -> proxy/direct network -> mock streaming.
  await ev(`(async()=>{
    const ctx=window.__WDS__,loop=ctx.agent.loop;
    await loop.newChat();const state=loop.getState();
    const history=Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:('中文标题、深色背景、保留文件 assets/diagram.svg。'+i).repeat(700)}));
    await ctx.api.putChat(state.projectId,{messages:history,skills:[]},state.sessionId);
    await loop.load(state.projectId,state.sessionId,{discardCurrent:true});
    loop.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)});loop.setOptions({reasoningEffort:'auto'});
    const stream=ctx.api.chatStream.bind(ctx.api);window.__qaMemoryCalls=[];
    ctx.api.chatStream=(p,cb,signal,...rest)=>{window.__qaMemoryCalls.push({providerId:p.providerId,model:p.model,maxTokens:p.maxTokens,tools:p.tools?.length,messages:p.messages});return stream(p,cb,signal,...rest)};
    window.__qaMemoryResult=await loop.send('COMPACTION_QA 继续项目');
  })()`);
  const sent = await ev(`window.__qaMemoryResult`); assert(sent.ok, sent.error);
  const result = await ev(`(()=>{const s=${L}.getState();return {summary:s.summary,messages:s.messages.length,calls:window.__qaMemoryCalls.map(p=>({providerId:p.providerId,model:p.model,maxTokens:p.maxTokens,tools:p.tools})),last:window.__qaMemoryCalls.at(-1).messages}})()`);
  assert(result.calls.length > 2); assert.equal(result.summary.model, 'memory-small'); assert.equal(result.messages, 10);
  assert(result.calls.slice(0, -1).every(p => p.providerId === 'qa-memory' && p.model === 'memory-small' && p.tools === 0 && p.maxTokens <= 512));
  assert.equal(result.calls.at(-1).model, model); assert.equal(result.calls.at(-1).providerId, providerId);
  assert(result.last.some(m => m.role === 'system' && String(m.content).includes('assets/diagram.svg')));
  const state = await ev(`${L}.getState()`);
  assert.equal((await ev(`window.__WDS__.api.getChat(${JSON.stringify(state.projectId)},${JSON.stringify(state.sessionId)})`)).summary.model, 'memory-small');
  // Reload an already exhausted single turn; Continue must compact it without
  // requiring a new user message or losing its original output prefix.
  await ev(`(async()=>{
    const ctx=window.__WDS__,loop=ctx.agent.loop;await loop.newChat();const s=loop.getState();
    const prefix='保存的长代码前缀。'.repeat(24000)+'SAVED_OUTPUT_END';
    await ctx.api.putChat(s.projectId,{messages:[{role:'user',content:'COMPACTION_QA 继续项目'},{role:'assistant',content:prefix,incomplete:true}],skills:[],summary:null},s.sessionId);
    await loop.load(s.projectId,s.sessionId,{discardCurrent:true});await loop.flush(true);
    window.__qaOldTurn={projectId:s.projectId,sessionId:s.sessionId,prefix};
  })()`);
  const beforeReload=await ev('performance.timeOrigin');await cdp.send('Page.reload');
  await until(()=>ev(`performance.timeOrigin!==${beforeReload}&&!!window.__WDS__?.agent?.loop&&!${L}.getState().loading`),'超限旧聊天重载');
  await ev(`(async()=>{const loop=${L};loop.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)});loop.setOptions({reasoningEffort:'auto'});window.__qaOldResume=await loop.resume()})()`);
  assert((await ev('window.__qaOldResume')).ok,'旧单轮应自动压缩并继续');
  assert(await ev(`(()=>{const s=${L}.getState();return s.summary?.model==='memory-small'&&s.messages.length===2&&s.messages[1].content.includes('SAVED_OUTPUT_END')&&s.messages[1].content.length>200000})()`));
}
