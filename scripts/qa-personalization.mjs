import assert from 'node:assert/strict';

export async function qaEfficiency({ev,cdp,until,shot,mode,providerId,model}) {
  const W='window.__WDS__',L=W+'.agent.loop';
  const reload=async()=>{const t=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${t}&&!!${W}?.agent?.loop&&!${L}.getState().loading`),'效率设置刷新');await ev(`${W}.bus.runCommand('agent.fullscreen',{open:true})`);};
  const choose=async(label)=>{await ev(`document.querySelector('.agw-effort').click()`);await ev(`[...document.querySelectorAll('.agw-menu-item')].find(b=>b.querySelector('.agw-menu-copy>span').textContent===${JSON.stringify(label)}).click()`);};
  assert.equal(await ev(`document.querySelector('.agw-fast').getAttribute('aria-pressed')`),'false');
  await ev(`${W}.bus.runCommand('agent.fullscreen',{open:true});document.querySelector('.agw-fast').click()`);await choose('关闭思考');
  assert.equal(await ev(`${L}.getOptions().reasoningEffort`),'none');await reload();
  assert.equal(await ev(`${L}.getOptions().reasoningEffort`),'none');assert.equal(await ev(`document.querySelector('.agw-fast').getAttribute('aria-pressed')`),'true');
  await ev(`(async()=>{const ctx=${W};await ctx.agent.loop.newChat();ctx.agent.loop.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)});const stream=ctx.api.chatStream.bind(ctx.api);window.__fastCalls=[];
    ctx.api.chatStream=async(p,cb,signal,...rest)=>{window.__fastCalls.push(p);if(!window.__fastRelease)await new Promise(r=>window.__fastRelease=r);return stream(p,cb,signal,...rest)};void ctx.agent.loop.send('FOLLOWUP 快速生成和计时验收');})()`);
  await until(()=>ev(`!!window.__fastRelease&&!document.querySelector('.agw-generation-timer').classList.contains('hidden')`),'真实请求生成计时');
  await until(()=>ev(`document.querySelector('.agw-generation-timer').textContent!=='用时 0:00'`),'计时持续增长');
  assert(await ev(`document.querySelector('.agw-fast').disabled&&document.querySelector('.agw-effort').disabled`));
  assert.equal(await ev(`document.querySelector('.agw-status').textContent`),'正在准备');
  assert(await ev(`window.__fastCalls[0].reasoning_effort==='none'&&window.__fastCalls[0].messages[0].content.includes('## Fast generation mode')&&window.__fastCalls[0].messages[0].content.includes('## Efficient execution')`));
  await shot('efficient-generation-desktop-'+mode);
  const theme=await ev(`${W}.store.get().ui.theme`);
  for(const appearance of ['light','dark']){
    await ev(`${W}.store.get().ui.theme!==${JSON.stringify(appearance)}&&${W}.bus.runCommand('app.toggleTheme')`);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await until(()=>ev(`(()=>{const r=document.querySelector('.agw-compose-options').getBoundingClientRect(),buttons=[...document.querySelectorAll('.agw-compose-options button')];return r.left>=-1&&r.right<=innerWidth+1&&buttons.every(b=>{const x=b.getBoundingClientRect();return x.left>=r.left-1&&x.right<=r.right+1&&x.width>50})})()`),'窄屏选项布局完成');
    await shot('efficient-generation-mobile-'+appearance+'-'+mode);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');await ev(`${W}.store.get().ui.theme!==${JSON.stringify(theme)}&&${W}.bus.runCommand('app.toggleTheme');window.__fastRelease()`);
  await until(()=>ev(`!${L}.streaming`),'快速生成完成');
  const timing=await ev(`${L}.messages.findLast(m=>m.role==='user').generationTiming`);assert(timing.elapsedMs>=1000);assert.equal(timing.status,'complete');
  const note=await ev(`[...document.querySelectorAll('.agw-turn-note')].at(-1).textContent`);assert(note.includes('用时 0:'));
  await reload();assert.equal(await ev(`[...document.querySelectorAll('.agw-turn-note')].at(-1).textContent`),note);
  assert.equal(await ev(`${L}.messages.findLast(m=>m.role==='user').generationTiming.elapsedMs`),timing.elapsedMs);
  await ev(`document.querySelector('.agw-fast').click()`);await choose('自动');await ev(`${W}.bus.runCommand('agent.fullscreen',{open:false});${W}.navigate('#/')`);
  await until(()=>ev(`${W}.route.name==='library'&&!!document.querySelector('.lib-title')&&!${L}.getState().loading`),'首页字体');
  const sizes=await ev(`(()=>{const title=getComputedStyle(document.querySelector('.lib-title')),body=getComputedStyle(document.body),card=document.querySelector('.lib-card-title');return {title:parseFloat(title.fontSize),body:body.fontFamily,card:card?parseFloat(getComputedStyle(card).fontSize):17}})()`);
  assert(sizes.title>=42&&sizes.title>sizes.card*2);assert(!sizes.body.includes('SimSun'));
  await cdp.send('DOM.enable');await cdp.send('CSS.enable');const root=await cdp.send('DOM.getDocument');
  const node=await cdp.send('DOM.querySelector',{nodeId:root.root.nodeId,selector:'.lib-scope-tab'});
  const fonts=await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId});
  assert(!fonts.fonts.some(f=>/^(?:NSimSun|SimSun|宋体)$/i.test(f.familyName)),JSON.stringify(fonts));
  await shot('typography-library-'+mode);
  return {fastMode:true,noThinking:true,liveTimer:true,historyTimer:true,readableUi:true,fonts:fonts.fonts.map(f=>f.familyName)};
}

// Run the same UI and persistence contract through HTTP and file:// backends.
export async function qaPersonalization({ ev, cdp, until, shot, mode, baseUrl, providerId, model }) {
  const W='window.__WDS__', L=W+'.agent.loop';
  const ready=()=>until(()=>ev(`!!${W}?.agent?.loop&&!${L}.getState().loading`),'个性化工作台就绪');
  const reload=async()=>{const t=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${t}&&!!${W}?.agent?.loop`),'个性化刷新');await ready();};
  const openSettings=async()=>{await ev(`void ${W}.bus.runCommand('agent.openSettings')`);await until(()=>ev(`!!document.querySelector('.ais-dialog')`),'模型设置');};
  const save=async()=>{await ev(`document.querySelector('.ais-dialog .modal-foot .btn--primary').click()`);await until(()=>ev(`!document.querySelector('.ais-dialog')`),'保存模型设置');};
  const tab=()=>ev(`document.querySelector('.ais-tab[data-pid="qa-display"]').click()`);
  const menu=async()=>{await ev(`document.querySelector('.agw-model').click()`);await until(()=>ev(`!!document.querySelector('.agw-menu')`),'聊天模型菜单');return ev(`document.querySelector('.agw-menu').textContent`);};

  assert.equal(await ev(`document.querySelector('.agw-motion').getAttribute('aria-pressed')`),'false');
  await ev(`(async()=>{const ctx=${W};await ctx.agent.loop.newChat();ctx.agent.loop.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)});ctx.agent.loop.setOptions({reasoningEffort:'auto'});ctx.bus.runCommand('agent.fullscreen',{open:true});document.querySelector('.agw-motion').click()})()`);
  assert.equal(await ev(`document.querySelector('.agw-motion').getAttribute('aria-pressed')`),'true');
  await reload();
  assert.equal(await ev(`document.querySelector('.agw-motion').getAttribute('aria-pressed')`),'true');
  await ev(`(()=>{const ctx=${W},stream=ctx.api.chatStream.bind(ctx.api);window.__motionPrompts=[];
    ctx.agent.loop.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)});ctx.agent.loop.setOptions({reasoningEffort:'auto'});
    ctx.api.chatStream=async(p,cb,signal,...rest)=>{window.__motionPrompts.push(p.messages[0].content);if(!window.__motionRelease)await new Promise(r=>window.__motionRelease=r);return stream(p,cb,signal,...rest)};
    void ctx.agent.loop.send('FOLLOWUP 华丽动效开关验收');})()`);
  await until(()=>ev(`!!window.__motionRelease&&${L}.streaming`),'生成期间动效开关锁定');
  assert(await ev(`document.querySelector('.agw-motion').disabled`));
  await ev(`document.querySelector('.agw-motion').click();window.__motionRelease()`);
  await until(()=>ev(`!${L}.streaming`),'华丽动效请求结束');
  assert(await ev(`window.__motionPrompts[0].includes('Transitions MUST')&&window.__motionPrompts[0].includes('A real timeline MUST')`));
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await ev(`${W}.bus.runCommand('agent.fullscreen',{open:true})`);
  assert(await ev(`(()=>{const r=document.querySelector('.agw-motion').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0})()`));
  await shot('creative-motion-mobile-'+mode);await cdp.send('Emulation.clearDeviceMetricsOverride');
  await ev(`document.querySelector('.agw-motion').click()`);
  const off=await ev(`${L}.send('FOLLOWUP 关闭华丽动效验收')`);assert(off.ok,off.error);
  assert(await ev(`!window.__motionPrompts.at(-1).includes('Transitions MUST')`));
  await ev(`${W}.bus.runCommand('agent.fullscreen',{open:false})`);

  const p=(await ev(`${W}.api.createProject({name:'归档验收 ${mode}',templateId:'blank'})`)).project;
  const pid=JSON.stringify(p.id);
  await ev(`(async()=>{const api=${W}.api;await api.putChat(${pid},{messages:[{role:'user',content:'ARCHIVE_CHAT_SAVED'}],skills:[]},'archive-qa');await api.createVersion(${pid},{label:'ARCHIVE_VERSION_SAVED'});${W}.navigate('#/');${W}.bus.emit('library:refresh')})()`);
  const filesBefore=await ev(`${W}.api.getFile(${pid},'index.html')`), versionsBefore=await ev(`${W}.api.listVersions(${pid})`);
  const card=`.lib-card[data-id="${p.id}"]`;
  await until(()=>ev(`!!document.querySelector(${JSON.stringify(card)})`),'归档工程卡片');
  const action=async(label)=>{await ev(`document.querySelector(${JSON.stringify(card+' .lib-card-more')}).click()`);await ev(`[...document.querySelectorAll('.lib-card-menu .menu-item')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);};
  await action('归档');
  await until(()=>ev(`!document.querySelector(${JSON.stringify(card)})`),'进行中隐藏归档工程');
  assert((await ev(`${W}.api.getProject(${pid})`)).project.archivedAt>0);
  await reload();await ev(`document.querySelector('[data-scope="archived"]').click()`);
  await until(()=>ev(`!!document.querySelector(${JSON.stringify(card)})`),'归档持久化');
  assert.equal(await ev(`getComputedStyle(document.querySelector('.lib-samples-section')).display`),'none');
  await shot('archived-projects-'+mode);
  assert.deepEqual(await ev(`${W}.api.getFile(${pid},'index.html')`),filesBefore);
  assert.deepEqual(await ev(`${W}.api.listVersions(${pid})`),versionsBefore);
  assert.equal((await ev(`${W}.api.getChat(${pid},'archive-qa')`)).messages[0].content,'ARCHIVE_CHAT_SAVED');
  const copy=(await ev(`${W}.api.duplicateProject(${pid})`)).project;assert(!copy.archived);
  await action('移出归档');await until(()=>ev(`!document.querySelector(${JSON.stringify(card)})`),'移出归档');
  await ev(`document.querySelector('[data-scope="active"]').click()`);
  await until(()=>ev(`!!document.querySelector(${JSON.stringify(card)})`),'恢复到进行中');
  await ev(`${W}.navigate('#/p/'+${pid})`);await until(()=>ev(`!!${W}.getEditor()?.ready&&${W}.getEditor().projectId===${pid}&&!${L}.getState().loading`),'打开恢复工程');

  await ev(`(async()=>{const ctx=${W};await ctx.api.putUserSettings({providers:[{id:'qa-display',name:'原供应商名称',baseUrl:${JSON.stringify(baseUrl)},apiKey:'fake-display-key',wire:'openai',model:'display-a',models:[{id:'display-a',name:'Display Alpha'},{id:'display-b',name:'Display Beta'}]}]});const s=await ctx.api.getSettings();ctx.store.update(v=>{v.settings={...s,loaded:true}})})()`);
  await openSettings();await tab();
  await ev(`(()=>{const n=document.querySelector('[aria-label="供应商名称"]');n.value='我的测试供应商';n.dispatchEvent(new Event('input'));document.querySelector('[aria-label="聊天中显示 display-b"]').click()})()`);
  assert.equal(await ev(`document.querySelector('.ais-tab[data-pid="qa-display"]').textContent`),'我的测试供应商');
  await ev(`(()=>{const s=document.querySelector('[aria-label="上下文压缩服务"]');s.value='qa-display';s.dispatchEvent(new Event('change'))})()`);
  assert.deepEqual(await ev(`[...document.querySelector('#ais-compaction-models').options].map(o=>o.value)`),['display-a','display-b']);
  // Leave memory selection unchanged for subsequent QA.
  await ev(`(()=>{const s=document.querySelector('[aria-label="上下文压缩服务"]');s.value='';s.dispatchEvent(new Event('change'))})()`);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  await ev(`document.querySelector('.ais-models-toolbar').scrollIntoView({block:'center'})`);
  assert(await ev(`(()=>{const r=document.querySelector('.ais-model-row').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`));
  await shot('model-visibility-mobile-'+mode);await cdp.send('Emulation.clearDeviceMetricsOverride');await save();await reload();
  const saved=(await ev(`${W}.api.getSettings()`)).providers.find(p=>p.id==='qa-display');
  assert.equal(saved.name,'我的测试供应商');assert.deepEqual(saved.visibleModels,['display-a']);assert.equal(saved.models.length,2);
  await ev(`${L}.setOptions({reasoningEffort:'auto'});${L}.setProvider('qa-display','display-b')`);
  const filtered=await menu();assert(filtered.includes('Display Alpha'));assert(!filtered.includes('Display Beta'));assert(filtered.includes('我的测试供应商'));
  assert.equal(await ev(`${L}.getState().model`),'display-b');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await openSettings();await tab();
  await ev(`document.querySelector('[aria-label="聊天模型全选"]').click()`);await save();
  const all=await menu();assert(all.includes('Display Alpha')&&all.includes('Display Beta'));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await openSettings();await tab();
  await ev(`document.querySelector('[aria-label="聊天模型全选"]').click()`);await save();
  const none=await menu();assert(!none.includes('Display Alpha')&&!none.includes('Display Beta'));assert(none.includes('配置模型'));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));${L}.setProvider(${JSON.stringify(providerId)},${JSON.stringify(model)})`);
  return {motionPrompt:true,defaultOff:true,persistent:true,archiveRestoresAllData:true,customProviderName:true,visibleModels:true,selectAll:true,hideAll:true};
}
