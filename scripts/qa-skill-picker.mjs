import assert from 'node:assert/strict';

export async function qaSkillPicker({ ev, cdp, until, shot, mode }) {
  const L = 'window.__WDS__.agent.loop', W = 'window.__WDS__';
  const selected = await ev(`${L}.skills`);
  const original = await ev(`${W}.store.get().settings.agent?.userInstructions || {}`);
  const appearance = await ev(`${W}.store.get().ui.theme`), wasOpen = await ev(`document.querySelector('#app').dataset.agent==='open'`);
  const ready = () => until(() => ev(`!${L}.getState().loading&&!!document.querySelector('.agw-skills')`), 'Skill 快捷栏就绪');
  const open = async (fullscreen = true) => {
    await ev(`if(document.querySelector('#app').dataset.agent!=='open')${W}.bus.runCommand('app.toggleAgent');
      ${W}.bus.runCommand('agent.fullscreen',{open:${fullscreen}})`);
    await until(() => ev(`!document.querySelector('#agent-panel').getAnimations().some(animation=>animation.playState==='running')`), '聊天栏展开完成');
    await ev(`document.querySelector('.agw-skills').click()`);
    assert.equal(await ev(`document.querySelector('.agw-skills').getAttribute('aria-expanded')`), 'true');
  };
  async function clickForce(id) {
    const point = await until(() => ev(`(() => {
      const control = document.querySelector('[data-force-skill-id="${id}"]');
      const target = control.closest('.agw-skill-force');
      target.scrollIntoView({ block: 'nearest' });
      const rect = target.getBoundingClientRect();
      const x = rect.right - 12, y = rect.top + rect.height / 2;
      return target.contains(document.elementFromPoint(x, y)) && { x, y };
    })()`), '可点击的强制控件');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  }
  const id = selected[0]; assert(id);
  await open(false);
  await ev(`(() => {
    const api = ${W}.api;
    const original = api.putUserSettings;
    api.putUserSettings = async () => {
      api.putUserSettings = original;
      return api.getSettings();
    };
  })()`);
  await clickForce(id);
  await until(() => ev(`[...document.querySelectorAll('.toast--error')].some(el => el.textContent.includes('强制设置未保存'))`), '旧后端丢弃强制设置时提示重启');
  assert.equal(await ev(`document.querySelector('[data-force-skill-id="${id}"]').getAttribute('aria-checked')`), 'false');
  await clickForce(id);
  await until(() => ev(`!document.querySelector('.agw-skills').disabled`), '内置 Skill 强制设置保存');
  assert.equal(await ev(`document.querySelector('[data-force-skill-id="${id}"]').getAttribute('aria-checked')`), 'true');
  assert.equal(await ev(`document.querySelectorAll('[data-force-skill-id][aria-checked=true]').length`), 1);
  await ev(`document.querySelector('[data-skill-id="${id}"]').click()`);
  assert(!(await ev(`${L}.skills`)).includes(id));
  assert.equal(await ev(`document.querySelector('.agw-skills').getAttribute('aria-expanded')`), 'true');
  await ev(`${L}.flush()`);
  const time = await ev('performance.timeOrigin'); await cdp.send('Page.reload');
  await until(() => ev(`performance.timeOrigin!==${time}&&!!${W}?.agent?.loop`), 'Skill 选择刷新'); await ready();
  assert(!(await ev(`${L}.skills`)).includes(id));
  assert.equal(await ev(`${W}.api.getSettings().then(s=>s.agent.userInstructions.skillForceOverrides[${JSON.stringify(id)}])`), true);
  await ev(`(async()=>{const ctx=${W};const saved=(await ctx.api.getSettings()).agent.userInstructions;const data=await ctx.api.putUserSettings({agent:{userInstructions:{...saved,skills:[...saved.skills,{id:'user-quick-test',name:'快捷测试技能',content:'Keep this unique skill instruction.',enabled:true}]}}});ctx.store.update(s=>{s.settings.agent=data.agent})})()`);
  await open();
  await ev(`document.querySelector('[aria-label="搜索 Skill"]').value='快捷测试';document.querySelector('[aria-label="搜索 Skill"]').dispatchEvent(new Event('input'))`);
  assert.equal(await ev(`[...document.querySelectorAll('.agw-skill-row')].filter(el=>!el.classList.contains('hidden')).length`), 1);
  await ev(`document.querySelector('[data-skill-id="user-quick-test"]').click()`);
  await until(() => ev(`!document.querySelector('.agw-skills').disabled`), '自定义 Skill 保存');
  assert.equal(await ev(`${W}.api.getSettings().then(s=>s.agent.userInstructions.skills.find(s=>s.id==='user-quick-test').enabled)`), false);
  await clickForce('user-quick-test');
  await until(() => ev(`!document.querySelector('.agw-skills').disabled`), '自定义 Skill 强制设置保存');
  assert.equal(await ev(`${W}.api.getSettings().then(s=>s.agent.userInstructions.skillForceOverrides['user-quick-test'])`), true);
  assert.equal(await ev(`document.querySelector('[data-skill-id="user-quick-test"]').checked`), false);
  await ev(`document.querySelector('[aria-label="搜索 Skill"]').value='';document.querySelector('[aria-label="搜索 Skill"]').dispatchEvent(new Event('input'))`);
  await ev(`${W}.bus.runCommand('agent.toggleSkill',{id:${JSON.stringify(id)}})`);
  assert.equal(await ev(`document.querySelector('[data-skill-id="${id}"]').checked`), true);
  for (const theme of ['light', 'dark']) {
    await ev(`${W}.store.get().ui.theme!==${JSON.stringify(theme)}&&${W}.bus.runCommand('app.toggleTheme')`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await until(() => ev(`(()=>{const r=document.querySelector('.agw-skill-picker').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`), '窄屏 Skill 面板定位');
    await shot('skill-picker-'+mode+'-'+theme);
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await ev(`document.querySelector('[aria-label="搜索 Skill"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  assert.equal(await ev(`document.activeElement===document.querySelector('.agw-skills')`), true);
  assert.equal(await ev(`document.querySelector('.agw-skills').getAttribute('aria-expanded')`), 'false');
  await ev(`(async()=>{const ctx=${W};ctx.agent.loop.setSkills(${JSON.stringify(selected)});const data=await ctx.api.putUserSettings({agent:{userInstructions:${JSON.stringify(original)}}});ctx.store.update(s=>{s.settings.agent=data.agent});ctx.bus.runCommand('agent.fullscreen',{open:false})})()`);
  await ev(`${W}.store.get().ui.theme!==${JSON.stringify(appearance)}&&${W}.bus.runCommand('app.toggleTheme');(document.querySelector('#app').dataset.agent==='open')!==${wasOpen}&&${W}.bus.runCommand('app.toggleAgent')`);
  return { builtinPersistence: true, customPersistence: true, externalSync: true, search: true, narrowThemes: true, keyboard: true };
}
