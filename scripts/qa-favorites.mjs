import assert from 'node:assert/strict';

// Used by the two isolated real-browser suites: HTTP editor and file:// editor.
export async function qaFavorites({ev,cdp,until,shot,mode}) {
  const W='window.__WDS__', E=W+'.getEditor()', D=E+'.iframe.contentDocument';
  const command=(name,p={})=>ev(`${W}.bus.runCommand(${JSON.stringify(name)},${JSON.stringify(p)})`);
  const ready=()=>until(()=>ev(`!!${E}?.ready&&!${W}.agent.loop.getState().loading`),'收藏测试编辑器');
  const open=async()=>{await ev(`void ${W}.bus.runCommand('favorites.open')`);await until(()=>ev(`!!document.querySelector('.favorite-dialog')`),'收藏库');};
  const close=async()=>{await ev(`document.querySelector('.favorite-dialog .modal-close').click()`);await until(()=>ev(`!document.querySelector('.favorite-dialog')`),'关闭收藏库');};
  const source=await ev(`${W}.api.createProject({name:'收藏来源',templateId:'blank'})`);
  await ev(`${W}.navigate('#/p/'+${JSON.stringify(source.project.id)})`);await ready();
  const original=await ev(`(async()=>{
    const ctx=${W},asset=await ctx.api.uploadAssetDataUrl(${JSON.stringify(source.project.id)},'favorite.png','data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII=');
    const d=${D},style=d.createElement('style');style.textContent='.favorite-qa-title::before{content:"★";color:rgb(200,30,90)} @keyframes favorite-qa-pulse{to{opacity:.8}}';d.head.append(style);
    return ${E}.bridge.insertElement({type:'html',x:100,y:100,w:640,h:360,html:'<div style="position:relative;width:640px;height:360px;background:#132c45;color:#e3f5ff;font-family:serif"><h2 class="favorite-qa-title" style="font-size:52px;margin:16px">跨工程 SVG 图解</h2><img width="80" height="80" src="'+asset.url+'"><svg width="160" height="100" viewBox="0 0 160 100"><defs><linearGradient id="favorite-qa-gradient"><stop stop-color="#56cfee"/><stop offset="1" stop-color="#9aaeff"/></linearGradient></defs><rect width="160" height="100" fill="url(#favorite-qa-gradient)"/></svg><span style="animation:favorite-qa-pulse 10s infinite">动态标注</span></div>'});
  })()`);
  await ev(`${E}.bridge.select(${JSON.stringify(original.elementId)})`);
  // Exercise the right-click entry and name prompt, not just the storage API.
  await ev(`(()=>{const d=${D},el=d.querySelector('[data-wpx-el="${original.elementId}"]');el.dispatchEvent(new (${E}.iframe.contentWindow.MouseEvent)('contextmenu',{bubbles:true,cancelable:true,clientX:180,clientY:200,button:2}))})()`);
  await until(()=>ev(`Array.from(document.querySelectorAll('.ctx-menu button')).some(b=>b.textContent.includes('收藏元素'))`),'右键收藏入口');
  await ev(`Array.from(document.querySelectorAll('.ctx-menu button')).find(b=>b.textContent.includes('收藏元素')).click()`);
  await until(()=>ev(`!!document.querySelector('.modal input')`),'收藏名称');
  await ev(`(()=>{const m=document.querySelector('.modal');m.querySelector('input').value='蓝色知识图解';m.querySelector('.modal-foot .btn--primary').click()})()`);
  const item=await until(async()=>{const r=await ev(`${W}.api.listFavoriteElements()`);return r.elements.find(x=>x.name==='蓝色知识图解');},'保存元素');
  const full=(await ev(`${W}.api.getFavoriteElement(${JSON.stringify(item.id)})`)).element;
  assert.equal(full.w,640);assert.equal(full.h,360);assert(full.html.includes('data:image/png;base64,'));assert(full.css.includes('::before'));assert(full.css.includes('@keyframes'));assert(!full.html.includes('/p/'+source.project.id));
  await ev(`${E}.bridge.call('setAbsoluteSize',{elementId:'${original.elementId}',w:320,h:180,keepRatio:true})`);
  const scaled=await ev(`${E}.bridge.call('captureFavorite',{elementId:'${original.elementId}'})`);assert(Math.abs(scaled.w-320)<1&&Math.abs(scaled.h-180)<1,JSON.stringify({w:scaled.w,h:scaled.h}));
  await open();
  await until(()=>ev(`document.querySelector('.favorite-preview')?.srcdoc.includes('<h2')`),'收藏真实预览');
  await shot('favorites-library-'+mode);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert(await ev(`(()=>{const r=document.querySelector('.favorite-card').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`));
  await shot('favorites-mobile-'+mode);await cdp.send('Emulation.clearDeviceMetricsOverride');await close();
  const target=await ev(`${W}.api.createProject({name:'收藏目标',templateId:'blank'})`);
  await ev(`${W}.navigate('#/p/'+${JSON.stringify(target.project.id)})`);await ready();
  // Delete the source project; all reused assets must continue to work.
  await ev(`${W}.api.deleteProject(${JSON.stringify(source.project.id)})`);
  await open();await ev(`document.querySelector('[data-favorite-insert="${item.id}"]').click()`);
  await until(()=>ev(`!document.querySelector('.favorite-dialog')&&!!${D}.querySelector('[data-favorite-id="${item.id}"]')`),'跨工程插入');
  const second=await command('favorites.insert',{favoriteId:item.id,x:20,y:30});assert(second.ok,JSON.stringify(second));
  const inspect=()=>ev(`(()=>{const d=${D},w=${E}.iframe.contentWindow,roots=Array.from(d.querySelectorAll('[data-favorite-id="${item.id}"]'));return roots.map(root=>{const svg=root.querySelector('rect'),fill=svg.style.fill||svg.getAttribute('fill'),id=/#([^)"]+)/.exec(fill)?.[1];return {id:root.id,font:w.getComputedStyle(root.querySelector('h2')).fontSize,pseudo:w.getComputedStyle(root.querySelector('h2'),'::before').content,image:root.querySelector('img').naturalWidth,gradient:!!root.querySelector('[id="'+id+'"]'),animation:w.getComputedStyle(root.querySelector('span')).animationName,w:root.style.width,h:root.style.height}})})()`);
  await until(async()=>{const r=await inspect();return r.length===2&&r.every(x=>x.image>0);},'跨工程图片加载');
  const copies=await inspect();assert(copies.every(x=>x.font==='52px'&&x.pseudo.includes('★')&&x.gradient&&x.w==='640px'&&x.h==='360px'),JSON.stringify(copies));assert.notEqual(copies[0].id,copies[1].id);assert.notEqual(copies[0].animation,copies[1].animation);
  await command('app.undo');assert.equal((await inspect()).length,1);await command('app.redo');assert.equal((await inspect()).length,2);
  await ev(`${E}.saveNow({reason:'favorites-qa'})`);
  const exported=await ev(`fetch(${W}.api.exportUrl(${JSON.stringify(target.project.id)})).then(r=>r.text())`);
  assert(exported.includes('data:image/png;base64,'));assert(exported.includes(item.id));assert(!exported.includes('/p/'+source.project.id+'/'));
  const before=await ev('performance.timeOrigin');await cdp.send('Page.reload');
  await until(()=>ev(`performance.timeOrigin!==${before}&&!!${W}?.agent?.loop&&!!${E}?.ready`),'收藏刷新');await ready();
  assert.equal((await inspect()).length,2);assert((await ev(`${W}.api.listFavoriteElements()`)).elements.some(x=>x.id===item.id));
  await ev(`${W}.agent.loop.newChat()`);
  const count=await ev(`${W}.agent.loop.messages.length`);await open();await ev(`document.querySelector('[data-favorite-attach="${item.id}"]').click()`);
  await until(()=>ev(`!document.querySelector('.favorite-dialog')&&!!document.querySelector('.agw-file')`),'收藏聊天附件');
  assert.equal(await ev(`${W}.agent.loop.messages.length`),count);
  assert((await ev(`document.querySelector('.agw-file').innerText`)).includes('蓝色知识图解'));
  await shot('favorites-chat-'+mode);
  await ev(`(()=>{const i=document.querySelector('.agw-input');i.value='FAVORITES_QA 使用这个收藏图解，保留配色。';i.dispatchEvent(new Event('input'));i.focus()})()`);
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>ev(`${W}.agent.loop.messages.some(m=>m.role==='assistant'&&m.content?.includes('收藏素材与完整副本已收到'))&&!${W}.agent.loop.streaming`),'Agent 实际接收素材并插入',30000);
  const messages=await ev(`${W}.agent.loop.messages`),user=messages.findLast(m=>m.role==='user');assert.equal(JSON.parse(user.docs[0].text.slice(user.docs[0].text.indexOf('\n{')+1)).html,full.html);assert(user.versions[target.project.id].before);assert(user.versions[target.project.id].after);
  assert.equal((await inspect()).length,3);
  // Deleting the library item must not remove the page/chat copies.
  await open();await ev(`document.querySelector('[aria-label="重命名 蓝色知识图解"]').click()`);
  await until(()=>ev(`document.querySelectorAll('.modal').length===2`),'重命名');
  await ev(`(()=>{const m=Array.from(document.querySelectorAll('.modal')).at(-1);m.querySelector('input').value='已验证图解';m.querySelector('.btn--primary').click()})()`);
  await until(()=>ev(`!!document.querySelector('[aria-label="删除 已验证图解"]')`),'收藏重命名完成');
  await ev(`document.querySelector('[aria-label="删除 已验证图解"]').click()`);await until(()=>ev(`document.querySelectorAll('.modal').length===2`),'删除确认');
  await ev(`Array.from(document.querySelectorAll('.modal')).at(-1).querySelector('.btn--primary').click()`);
  await until(()=>ev(`!document.querySelector('.favorite-card')`),'删除收藏');await close();assert.equal((await inspect()).length,3);
  assert(await ev(`${W}.agent.loop.messages.findLast(m=>m.role==='user').docs[0].text.includes('蓝色知识图解')`));
  if(mode==='static')assert.equal(await ev(`Object.keys(window.__WDS_STATIC__.state.elements).length`),0);
  const rawFavorite=(await ev(`${W}.api.saveFavoriteElement(${JSON.stringify(full)})`)).element;
  const raw=(await ev(`${W}.api.importProject({mode:'raw',name:'收藏原稿验收',fileName:'favorite-raw.html',content:'<!doctype html><html><head><style>body{margin:0}.slide{position:relative;width:1920px;height:1080px;background:#edf3f8}</style></head><body><section class="slide active" id="raw-page"><h1>原稿收藏验收</h1></section></body></html>'})`)).project;
  await ev(`${W}.navigate('#/p/'+${JSON.stringify(raw.id)})`);await until(()=>ev(`${E}.projectId===${JSON.stringify(raw.id)}&&!!${E}.ready&&${W}.store.get().deck.raw`),'原稿收藏编辑器');
  const rawInserted=await command('favorites.insert',{favoriteId:rawFavorite.id,x:150,y:180});assert(rawInserted.ok,JSON.stringify(rawInserted));
  const rawCount=()=>ev(`${D}.querySelectorAll('[data-favorite-id="${rawFavorite.id}"]').length`);
  assert.equal(await rawCount(),1);await command('app.undo');assert.equal(await rawCount(),0);await command('app.redo');assert.equal(await rawCount(),1);
  await ev(`${E}.saveNow({reason:'favorites-raw-qa'})`);
  const rawOrigin=await ev('performance.timeOrigin');await cdp.send('Page.reload');await until(()=>ev(`performance.timeOrigin!==${rawOrigin}&&!!${E}?.ready&&!!${D}.querySelector('[data-favorite-id="${rawFavorite.id}"]')`),'原稿补丁保存恢复');
  const rawExport=await ev(`fetch(${W}.api.exportUrl(${JSON.stringify(raw.id)})).then(r=>r.text())`);assert(rawExport.includes(rawFavorite.id));assert(rawExport.includes('data:image/png;base64,'));
  return {crossProject:true,embeddedAssets:true,svg:true,pseudo:true,animationIsolation:true,undoRedo:true,chat:true,persistence:true};
}

export function favoriteReply(messages) {
  const user=messages.findLast(m=>m.role==='user'),text=typeof user?.content==='string'?user.content:'';
  if(!text.includes('FAVORITES_QA'))return null;
  const id=/favoriteId[:=\\"\s]+(el-[a-z0-9-]+)/.exec(text)?.[1];
  if(!text.includes('收藏元素的完整副本')||!id)return {content:'收藏测试未收到完整附件。'};
  if(messages.some(m=>m.role==='tool'&&m.tool_call_id==='favorites-qa-insert'))return {content:'收藏素材与完整副本已收到，已在当前页面插入。'};
  return {tool_calls:[{index:0,id:'favorites-qa-insert',type:'function',function:{name:'app_run_command',arguments:JSON.stringify({name:'favorites.insert',payload:{favoriteId:id,x:240,y:220}})}}]};
}
