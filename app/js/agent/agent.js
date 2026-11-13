/* Agent workspace UI, rebuilt independently from the editor's design system. */
import { h, readFileAsDataURL } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { createAgentLoop } from './loop.js';
import { createThreadView } from './thread-view.js';
import { attachMarkdownActions } from './markdown.js';
import { resolveActive, getProviders, loadSettings, openSettings } from './settings.js';
import { PERMISSION_LEVELS, normalizePermission } from './tools.js';
import { loadCatalog, openManager } from './skills.js';
import { openSearchSettings } from './search-settings.js';
import { openImageSettings } from './image-settings.js';
import { ACCEPT, extractFile, fileExt } from './attachments.js';
import { createVersionHistory } from './version-history.js';

const read = (key, fallback = '') => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage disabled */ } };
const glyph = (name, size = 17) => h('span', { class: 'agw-glyph', html: icon(name, size) });
const iconButton = (label, name, action, className = '') => h('button', { type: 'button', class: 'agw-icon ' + className, title: label, 'aria-label': label, onClick: action }, glyph(name));

export async function init(ctx) {
  const panel = document.getElementById('agent-panel'); if (!panel) return;
  const app = document.getElementById('app');
  let loop, activeTurn = null, lastTurn = null, pinned = true, menu = null, files = [], queue = [];
  let preparing = false, slashIndex = 0, slashItems = [], sessionKey = '';
  let permission = normalizePermission(read('wds:agent:permission', 'full'));
  let effort = read('wds:agent:effort', 'auto'), web = read('wds:agent:webSearch', '0') === '1';
  let appearance = ctx.store.get().ui.theme === 'dark' ? 'dark' : 'light';
  let fullscreen = false;
  const shell = h('div', { class: 'agw-shell', 'data-appearance': appearance });
  const title = h('span', { class: 'agw-title' }, '新对话'), projectContext = h('span', { class: 'agw-project' });
  const thread = h('div', { class: 'agw-feed', role: 'log', 'aria-label': '对话记录', 'aria-live': 'off', tabindex: '0' });
  const viewport = h('div', { class: 'agw-viewport' }, thread);
  const jump = iconButton('回到最新消息', 'arrow-down', () => { pinned = true; scroll(); }, 'agw-jump hidden'); viewport.append(jump);
  const status = h('div', { class: 'agw-status', role: 'status', 'aria-live': 'polite' });
  const attachments = h('div', { class: 'agw-attachments hidden' }), queued = h('div', { class: 'agw-queue hidden' });
  const plan = h('details', { class: 'agw-plan hidden' }), planLabel = h('span'), planBody = h('div', { class: 'agw-plan-body' });
  plan.append(h('summary', {}, glyph('list-ordered', 14), planLabel, glyph('chevron-down', 12)), planBody);
  const input = h('textarea', { class: 'agw-input', rows: '2', placeholder: '与 Agent 一起创作', 'aria-label': '给 Agent 的消息', spellcheck: 'false' });
  const slash = h('div', { class: 'agw-slash hidden', role: 'listbox', 'aria-label': '应用命令' });
  const fileInput = h('input', { class: 'hidden', type: 'file', multiple: true, accept: ACCEPT });
  const modelLabel = h('span', { class: 'agw-model-label' }, '选择模型'), effortLabel = h('span', { class: 'agw-effort-label' });
  const model = h('button', { type: 'button', class: 'agw-model', 'aria-label': '选择模型' }, modelLabel, glyph('chevron-down', 13));
  const effortButton=h('button',{type:'button',class:'agw-effort','aria-label':'选择思考强度',onClick:()=>showMenu(effortButton,'思考强度',['auto','low','medium','high'].map((id)=>({label:({auto:'自动',low:'低',medium:'中',high:'高'})[id],selected:effort===id,icon:'brain',action:()=>{effort=id;write('wds:agent:effort',id);loop.setOptions(toolOptions());refreshControls();}})))},glyph('brain',14),effortLabel);
  const access = iconButton('工作权限', 'shield', () => openPermissions()), plus = iconButton('添加附件与工具', 'plus', () => openAddMenu());
  const send = iconButton('发送消息', 'arrow-up', () => { if (loop.streaming) loop.stop(); else safe(() => submit()); }, 'agw-submit');
  const enqueue = iconButton('加入队列', 'arrow-up', () => safe(() => submit()), 'agw-enqueue hidden');
  const compose = h('div', { class: 'agw-compose' }, slash, attachments, input,
    h('div', { class: 'agw-compose-tools' }, plus, access, h('span', { class: 'agw-spacer' }), model, effortButton, enqueue, send));
  const composer = h('div', { class: 'agw-composer' }, plan, queued, status, compose, fileInput);
  const more = iconButton('对话选项', 'more-horizontal', () => openMore()), history = iconButton('对话历史', 'history', () => safe(openHistory));
  const create = iconButton('新对话', 'plus', () => safe(() => loop.newChat())), close = iconButton('收起对话', 'panel-right', () => setOpen(false));
  const maximize = iconButton('全屏对话', 'maximize', () => setFullscreen(!fullscreen));
  const header = h('header', { class: 'agw-header' }, glyph('folder', 18), h('div', { class: 'agw-heading' }, title, projectContext), maximize, more, history, create, close);
  const resize = h('div', { class: 'agw-resize', role: 'separator', 'aria-label': '调整对话宽度', 'aria-orientation': 'vertical', tabindex: '0' });
  shell.append(header, viewport, composer); panel.replaceChildren(shell, resize); panel.classList.add('agent-workspace');
  const draftKey = () => `wds:agent:draft:${loop?.projectId || 'workspace'}:${loop?.getState().sessionId || 'default'}`;
  const notify = (error) => ctx.toast.error(error?.message || String(error));
  const safe = (fn) => Promise.resolve().then(fn).catch(notify);
  const versions = createVersionHistory(ctx, { getLoop: () => loop, onRestored: () => { queue = []; renderQueue(); } });
  const toolOptions = () => ({ permission, reasoningEffort: effort, webSearch: web });
  let followFrame = null;
  function scroll() {
    if (!pinned || followFrame != null) return;
    const previous = thread.scrollTop;
    followFrame = requestAnimationFrame(() => {
      followFrame = null;
      // A queued paint must not overwrite an upward scroll that happened since scheduling.
      if (!pinned || thread.scrollTop < previous - 1) { pinned = false; jump.classList.remove('hidden'); return; }
      thread.scrollTop = thread.scrollHeight;
    });
  }
  const followResize = new ResizeObserver(() => scroll());
  const feedContent = () => [...thread.children].forEach((node) => followResize.observe(node));
  thread.addEventListener('scroll', () => { pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 64; jump.classList.toggle('hidden', pinned); }, { passive: true });
  thread.addEventListener('wheel', (e) => { if (e.deltaY < 0) { pinned = false; jump.classList.remove('hidden'); } }, { passive: true });
  function setOpen(open) {
    if (!open && fullscreen) setFullscreen(false);
    app.dataset.agent = open ? 'open' : 'closed'; ctx.store.update((s) => { s.agent.open = !!open; s.ui.agentOpen = !!open; });
    ctx.bus.emit('agent:toggle', { open }); window.dispatchEvent(new Event('resize'));
    if (open) { refreshControls(); input.focus(); scroll(); } return { ok: true, open };
  }
  const inertBefore = new Map();
  function setFullscreen(open) {
    const before = panel.getBoundingClientRect(); fullscreen = !!open;
    if (fullscreen) setOpen(true);
    app.dataset.agentFullscreen = String(fullscreen); panel.dataset.fullscreen = String(fullscreen);
    maximize.title = fullscreen ? '退出全屏对话' : '全屏对话'; maximize.setAttribute('aria-label', maximize.title);
    maximize.replaceChildren(glyph(fullscreen ? 'minimize' : 'maximize'));
    for (const el of [document.getElementById('titlebar'), document.getElementById('ribbon'), document.getElementById('main'), document.getElementById('statusbar')].filter(Boolean)) {
      if (fullscreen) { if (!inertBefore.has(el)) inertBefore.set(el, el.inert); el.inert = true; }
      else { el.inert = inertBefore.get(el) || false; inertBefore.delete(el); }
    }
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && before.width > 0) {
      const after = panel.getBoundingClientRect();
      panel.animate([{ transform: `translate(${before.left-after.left}px,${before.top-after.top}px) scale(${before.width/after.width},${before.height/after.height})`, transformOrigin:'0 0' }, { transform:'none', transformOrigin:'0 0' }], { duration:240, easing:'cubic-bezier(.2,.8,.2,1)' });
    }
    write('wds:agent:fullscreen', String(fullscreen)); window.dispatchEvent(new Event('resize')); input.focus(); scroll();
    return {ok:true,fullscreen};
  }
  function syncAppearance() {
    appearance = ctx.store.get().ui.theme === 'dark' ? 'dark' : 'light';
    shell.dataset.appearance = appearance; if (menu) menu.dataset.appearance = appearance;
  }
  ctx.bus.on('ui:theme', syncAppearance);
  ctx.store.subscribe(() => { if (appearance !== ctx.store.get().ui.theme) syncAppearance(); });
  function context() {
    const s = ctx.store.get(); projectContext.textContent = s.project ? s.project.name + (s.deck.total ? ` · ${s.deck.current + 1}/${s.deck.total}` : '') : '工作区';
    title.textContent = loop?.messages.find((m) => m.role === 'user' && !m.versionEvent)?.content || '新对话'; title.title = title.textContent;
  }
  function refreshControls() {
    const active = resolveActive(ctx), cfg = loop?.getState(), efforts = { auto: '自动', low: '低', medium: '中', high: '高' };
    modelLabel.textContent = active.model || '选择模型'; effortLabel.textContent = efforts[effort] || '自动';
    model.title = `${active.provider?.name || '配置模型'} · ${active.model || ''} · 思考强度：${efforts[effort] || '自动'}`;
    access.replaceChildren(glyph(permission === 'read' ? 'lock' : 'shield', 17)); access.title = '工作权限：' + (PERMISSION_LEVELS.find((p) => p.id === permission)?.label || '完全访问'); access.dataset.permission = permission;
    const running = !!loop?.streaming;
    send.replaceChildren(glyph(running ? 'stop' : 'arrow-up', running ? 13 : 18)); send.setAttribute('aria-label', running ? '停止生成' : '发送消息'); send.title = running ? '停止生成' : '发送消息'; send.classList.toggle('is-stop', running);
    send.disabled = preparing || !!cfg?.loading || (!running && !input.value.trim() && !files.length); enqueue.classList.toggle('hidden', !running || !input.value.trim());
    input.placeholder = running ? '补充需求，Enter 加入队列' : '与 Agent 一起创作'; context();
  }
  function grow() { input.style.height = 'auto'; input.style.height = Math.min(190, Math.max(65, input.scrollHeight)) + 'px'; }
  function saveDraft() { write(draftKey(), input.value); }
  function closeMenu() { menu?.remove(); menu = null; }
  function showMenu(anchor, label, items) {
    closeMenu(); const popup = h('div', { class: 'agw-menu', 'data-appearance': appearance, role: 'menu', 'aria-label': label });
    popup.append(h('div', { class: 'agw-menu-heading' }, label));
    for (const item of items) {
      if (item.divider) { popup.append(h('hr')); continue; }
      if (item.heading) { popup.append(h('div', { class: 'agw-menu-heading' }, item.heading)); continue; }
      popup.append(h('button', { type: 'button', role: 'menuitem', class: 'agw-menu-item', onClick: () => { closeMenu(); safe(item.action); } }, glyph(item.icon || 'circle', 15),
        h('span', { class: 'agw-menu-copy' }, h('span', {}, item.label), item.description ? h('small', {}, item.description) : null), item.selected ? glyph('check', 14) : null));
    }
    document.body.append(popup); menu = popup; const r = anchor.getBoundingClientRect(), box = popup.getBoundingClientRect();
    popup.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, r.right - box.width)) + 'px';
    popup.style.top = (r.top > innerHeight * .5 ? Math.max(8, r.top - box.height - 8) : Math.min(innerHeight - box.height - 8, r.bottom + 8)) + 'px'; popup.querySelector('button')?.focus();
  }
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target) && !header.contains(e.target) && !compose.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const hadPopup=!!menu||!slash.classList.contains('hidden'); closeMenu(); slash.classList.add('hidden');
      if (fullscreen && !hadPopup && !document.querySelector('.modal-wrap') && !document.body.classList.contains('is-presenting')) setFullscreen(false);
    }
    if (!menu || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault(); const buttons = [...menu.querySelectorAll('button')], current = buttons.indexOf(document.activeElement); buttons[(current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  });
  function openPermissions() {
    showMenu(access, '工作权限', PERMISSION_LEVELS.map((p) => ({ label: p.label, description: p.tip, selected: p.id === permission, icon: p.id === 'read' ? 'lock' : 'shield', action: () => {
      permission = p.id; write('wds:agent:permission', p.id); loop.setOptions(toolOptions()); refreshControls();
    } })));
  }
  async function settings() {
    await openSettings(ctx, { getSkills: () => loop.skills, onChangeSkills: (ids) => loop.setSkills(ids), skillsCatalog: await loadCatalog(ctx) });
    await loadSettings(ctx, { force: true }); refreshControls();
  }
  function openMore() {
    const expanded = panel.dataset.expanded === 'true';
    showMenu(more, '对话', [
      { label: '版本历史', description: '查看工程快照与对话回退', icon: 'history', action: () => versions.open() },
      { label: '模型设置', icon: 'settings', action: settings },
      { label: '设计技能', icon: 'sparkles', action: async () => openManager(ctx, { catalog: await loadCatalog(ctx), enabled: loop.skills, onChange: (ids) => loop.setSkills(ids) }) },
      { label: '生图设置', icon: 'image', action: () => openImageSettings(ctx) },
      { label: '联网搜索设置', icon: 'globe', action: () => openSearchSettings(ctx) }, { divider: true },
      { label: expanded ? '恢复侧栏宽度' : '展开阅读', icon: 'maximize', action: () => { panel.dataset.expanded = String(!expanded); setWidth(expanded ? 500 : Math.min(820, innerWidth - 32)); } },
      { label: fullscreen ? '退出全屏对话' : '全屏对话', icon: fullscreen ? 'minimize' : 'maximize', action: () => setFullscreen(!fullscreen) },
      { label: appearance === 'dark' ? '切换浅色主题' : '切换深色主题', description:'与编辑器同步', icon:appearance==='dark'?'sun':'moon', action:()=>ctx.bus.runCommand('app.toggleTheme') },
      { label: '导出对话 Markdown', icon: 'download', action: () => {
        const text = loop.messages.filter((m) => m.role !== 'tool').map((m) => `## ${m.role === 'user' ? '你' : 'Agent'}\n\n${m.content || ''}`).join('\n\n');
        const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const a = h('a', { href: url, download: 'WebDeck-对话.md' }); a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
      } },
      { label: '上下文用量', icon: 'info', action: () => {
        const c = loop.getState().context; ctx.toast.info(c ? `上下文约 ${Math.round(c.tokens / 1000)}k / ${Math.round(c.limit / 1000)}k，${c.folded || 0} 条早期记录已整理为记忆。原文完整保留。` : '开始对话后可查看用量');
      } },
    ]);
  }
  async function openHistory() {
    await loop.flush(); const data = await loop.listSessions();
    showMenu(history, '对话历史', (data.chats || []).map((chat) => ({ label: chat.title, description: `${chat.turns} 条消息`, icon: 'message', selected: chat.id === loop.getState().sessionId,
      action: () => loop.load(loop.projectId, chat.id) })).concat([{ divider: true }, { label: '新对话', icon: 'plus', action: () => loop.newChat() }]));
  }
  function openAddMenu() {
    showMenu(plus, '添加与工具', [
      { label: '添加图片或文档', description: 'PDF · Word · PPT · Markdown', icon: 'paperclip', action: () => fileInput.click() },
      { label: '导入 PPT 或网页', icon:'import',action:()=>ctx.bus.runCommand('file.import') },
      { label: '自定义模板',icon:'layout',action:()=>ctx.bus.runCommand('templates.manage') },
      { label: '生图设置', description: ctx.store.get().settings.imageGeneration?.enabled ? '已开启 · 可自动生成配图' : '未开启 · 手动配置后使用', icon: 'image', action: () => openImageSettings(ctx) },
      { label: web ? '关闭联网搜索' : '开启联网搜索', selected: web, icon: 'globe', action: () => { web = !web; write('wds:agent:webSearch', web ? '1' : '0'); loop.setOptions(toolOptions()); refreshControls(); } },
      { label: '查看全部应用命令', icon: 'terminal', action: () => { input.value = '/'; input.focus(); grow(); updateSlash(); } },
    ]);
  }
  model.addEventListener('click', () => {
    const active = resolveActive(ctx), providers = getProviders(ctx).filter((p) => p.keySet);
    if (!providers.length) { safe(settings); return; } const items = [];
    for (const p of providers) {
      items.push({ heading: p.name });
      for (const m of p.models.length ? p.models : [{ id: p.model }]) if (m.id) items.push({ label: m.name || m.id, selected: active.providerId === p.id && active.model === m.id, icon: 'cpu', action: () => { loop.setProvider(p.id, m.id); refreshControls(); } });
    }
    items.push({ divider: true }, { heading: '思考强度' });
    for (const [id, label] of [['auto', '自动'], ['low', '低'], ['medium', '中'], ['high', '高']]) items.push({ label, selected: effort === id, icon: 'brain', action: () => { effort = id; write('wds:agent:effort', id); loop.setOptions(toolOptions()); refreshControls(); } });
    items.push({ divider: true }, { label: '配置模型…', icon: 'settings', action: settings }); showMenu(model, '模型', items);
  });
  function renderFiles() {
    attachments.replaceChildren(); attachments.classList.toggle('hidden', !files.length);
    for (const file of files) {
      const remove = iconButton('移除 ' + file.name, 'x', () => { files = files.filter((f) => f !== file); renderFiles(); refreshControls(); });
      const preview = file.image ? h('img', { src: file.image, alt: file.name }) : glyph('file-text', 18);
      const text = file.status === 'reading' ? '读取中…' : file.status === 'error' ? file.error : file.warning || (file.pages ? file.pages + ' 页' : file.kindLabel || file.kind);
      attachments.append(h('div', { class: 'agw-file', 'data-status': file.status }, preview, h('div', {}, h('strong', {}, file.name), h('small', {}, text)), remove));
    }
  }
  async function addFiles(incoming) {
    for (const source of incoming) {
      if (files.length >= 6) { ctx.toast.warn('最多添加 6 个附件'); break; }
      if (source.size > 30 * 1024 * 1024) { ctx.toast.warn(source.name + ' 超过 30MB'); continue; }
      const isImage = source.type.startsWith('image/');
      if (!isImage && !ACCEPT.split(',').includes('.' + fileExt(source.name))) { ctx.toast.warn('不支持该文件类型：' + source.name); continue; }
      const file = { name: source.name, status: 'reading', kind: isImage ? '图片' : '文档' }; files.push(file); renderFiles();
      try {
        if (isImage) file.image = await readFileAsDataURL(source);
        else { const data = await extractFile(source); if (data.error) throw new Error(data.error); Object.assign(file, data); if (data.images) file.scanImages = data.images; }
        if(/\.pptx?$/i.test(source.name)){
          const staged=await ctx.api.stageImport({fileName:source.name,dataUrl:await readFileAsDataURL(source)});
          file.text=(file.text||'')+'\n\nPowerPoint 原文件已暂存。如需解析为 HTML，请调用 app_call_api，operation=projects.import，body='+JSON.stringify({importId:staged.importId,fileName:source.name,pptMode:'editable'})+'。导入会创建独立工程，报告会列出转换差异。';
        }
        file.status = 'ready';
      } catch (err) { file.status = 'error'; file.error = err.message; }
      renderFiles(); refreshControls();
    }
  }
  fileInput.addEventListener('change', async () => { await addFiles([...fileInput.files]); fileInput.value = ''; });
  input.addEventListener('paste', (e) => { if (e.clipboardData?.files.length) { e.preventDefault(); safe(() => addFiles([...e.clipboardData.files])); } });
  compose.addEventListener('dragover', (e) => { e.preventDefault(); compose.classList.add('is-dragging'); }); compose.addEventListener('dragleave', () => compose.classList.remove('is-dragging'));
  compose.addEventListener('drop', (e) => { e.preventDefault(); compose.classList.remove('is-dragging'); safe(() => addFiles([...e.dataTransfer.files])); });
  function renderQueue() {
    queued.replaceChildren(); queued.classList.toggle('hidden', !queue.length);
    queue.forEach((item) => queued.append(h('div', { class: 'agw-queued' }, glyph('message', 14), h('span', {}, item.text || '附件消息'), h('small', {}, '排队中'), iconButton('移除排队消息', 'x', () => { queue = queue.filter((q) => q !== item); renderQueue(); }))));
  }
  async function submit(brief) {
    if (preparing || loop.getState().loading) return;
    if (files.some((f) => f.status === 'reading')) { ctx.toast.warn('附件还在读取中'); return; }
    if (files.some((f) => f.status === 'error')) { ctx.toast.warn('请先移除读取失败的附件'); return; }
    const text = input.value.trim(); if (!text && !files.length) return; const active = resolveActive(ctx);
    if (!active.providerId || !active.model || !active.provider?.keySet) { safe(settings); return; }
    preparing = true; refreshControls(); const ready = files.slice(), images = [], assetPaths = [], docs = [];
    try {
      for (const f of ready) {
        if (f.image) {
          images.push(f.image);
          if (ctx.store.get().project?.id) { const asset = await ctx.api.uploadAssetDataUrl(ctx.store.get().project.id, f.name, f.image); if (asset.url) assetPaths.push(asset.url); }
        }
        if (f.scanImages) images.push(...f.scanImages);
        if (f.text || f.kind === 'doc' || f.kind === '文档') docs.push({ name: f.name, text: f.text || '', pages: f.pages, kindLabel: f.kindLabel || '文档', truncated: f.truncated, warning: f.warning });
      }
      const item = { text, images, options: { brief, assetPaths, docs } };
      input.value = ''; files = []; grow(); renderFiles(); saveDraft(); slash.classList.add('hidden');
      if (loop.streaming) { queue.push(item); renderQueue(); } else { pinned = true; safe(() => loop.send(item.text, item.images, item.options)); }
    } catch (err) { notify(err); } finally { preparing = false; refreshControls(); }
  }
  function updateSlash() {
    const text = input.value.trim(); if (!text.startsWith('/') || text.includes('\n')) { slash.classList.add('hidden'); return; }
    const q = text.slice(1).toLowerCase(); slashItems = ctx.bus.listCommands().filter((c) => !q || `${c.label || ''} ${c.name}`.toLowerCase().includes(q)).slice(0, 7); slashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1));
    slash.replaceChildren(...slashItems.map((c, i) => h('button', { type: 'button', role: 'option', 'aria-selected': String(i === slashIndex), class: i === slashIndex ? 'is-active' : '', onClick: () => runSlash(c) }, glyph('terminal', 14), h('span', {}, c.label || c.name), h('code', {}, c.name)))); slash.classList.toggle('hidden', !slashItems.length);
  }
  function runSlash(command) { if (!command) return; input.value = ''; saveDraft(); slash.classList.add('hidden'); safe(() => ctx.bus.runCommand(command.name)); grow(); }
  input.addEventListener('input', () => { grow(); saveDraft(); updateSlash(); refreshControls(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!slash.classList.contains('hidden')) {
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashItems.length) % slashItems.length; updateSlash(); return; }
      if (e.key === 'Enter') { e.preventDefault(); runSlash(slashItems[slashIndex]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); safe(() => submit()); }
  });
  function welcome() {
    if (thread.children.length) return; const project = ctx.store.get().project;
    const box = h('div', { class: 'agw-welcome' }, glyph('terminal', 26), h('h2', {}, '一起，把想法变成作品。'), h('p', {}, project ? '描述你想完成的事，剩下的交给我。' : '从一个想法开始，或接着完善你的工程。'));
    const prompts = project ? [['打磨这份演示', '分析当前工程，先给出具体的改进建议。'], ['设计交互动效', '检查当前页并设计一套有节奏的动画，直接完成。'], ['从主题开始创作', '帮我创作一套演示，先和我确认主题和用途。']] : [['看看我的工程', '列出我的工程及其基本信息。'], ['新建一份演示', '查看模板，并为我创建一个空白演示工程。']];
    const list = h('div', { class: 'agw-suggestions' }); prompts.forEach(([label, text]) => list.append(h('button', { type: 'button', onClick: () => { input.value = text; grow(); saveDraft(); refreshControls(); input.focus(); } }, label, glyph('arrow-up-right', 13)))); box.append(list); thread.append(box);
  }
  function removeWelcome() { thread.querySelector('.agw-welcome')?.remove(); }
  function userMessage(msg) {
    if (msg.versionEvent) { thread.append(h('div', { class: 'agw-version-event' }, glyph('history', 13), msg.content)); return; }
    removeWelcome(); const content = h('div', { class: 'agw-user-content' }, msg.content || '');
    for (const image of msg.images || []) content.append(h('img', { src: image, alt: '附件图片' }));
    for (const doc of msg.docs || []) content.append(h('span', { class: 'agw-user-file', title: doc.warning || '' }, glyph('file-text', 14), doc.name + (doc.warning ? ' · ' + doc.warning : '')));
    const edit = iconButton('编辑消息', 'edit', () => { input.value = msg.content; grow(); input.focus(); refreshControls(); });
    const revert = h('button', { type: 'button', class: 'agw-text-button agw-user-revert hidden', title: '回退工程和对话到本轮修改之前', onClick: () => safe(async () => {
      const result = await versions.detail(msg.versions?.[loop.projectId]?.before, { rewind: true });
      if (result?.conversation) { input.value = msg.content || ''; grow(); saveDraft(); refreshControls(); input.focus(); }
    }) }, glyph('undo', 13), '回退到此处');
    revert.classList.toggle('hidden', !msg.versions?.[loop.projectId]?.before);
    thread.append(h('article', { class: 'agw-user', 'data-message-id': msg.id }, content, h('div', { class: 'agw-user-actions' }, revert, edit))); feedContent(); context();
  }
  async function undo(ids) {
    for (const id of [...ids].reverse()) {
      const history = ctx.store.get().history, index = history.ops.findIndex((op) => op.opId === id); if (index < 0 || index >= history.cursor) continue;
      if (index === history.cursor - 1) { const result = await ctx.bus.runCommand('app.undo'); if (result?.ok === false) throw new Error(result.error); }
      else { const editor = ctx.getEditor(); if (!editor?.bridge) throw new Error('编辑器尚未就绪'); await editor.bridge.call('applyOp', { op: history.ops[index], direction: 'undo' }); const ops = history.ops.slice(); ops.splice(index, 1); ctx.store.setHistory(ops, history.cursor - 1); }
    }
  }
  function newTurn(streaming, user = loop.messages.findLast((m) => m.role === 'user' && !m.versionEvent)) {
    removeWelcome(); const view = createThreadView({ streaming, scroll, resume: () => loop.resume(), undo,
      openProject: (id)=>{setFullscreen(false);ctx.navigate('#/p/'+encodeURIComponent(id));},
      versions: () => safe(() => versions.open({ ids: Object.values(user?.versions?.[loop.projectId] || {}).filter((v) => typeof v === 'string') })) });
    if (user) view.el.dataset.turnId = user.turnId || user.id;
    view.setVersion(!!user?.versions?.[loop.projectId]?.before);
    view.setDeliveries(user?.deliveries);
    thread.append(view.el); feedContent(); return view;
  }
  function replay(messages) {
    if (followFrame != null) cancelAnimationFrame(followFrame); followFrame = null;
    followResize.disconnect(); thread.replaceChildren(); activeTurn = null; lastTurn = null; let turn = null, user = null;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]; if (msg.synthetic) continue;
      if (msg.role === 'user') { turn?.finish({}, { replay: true }); turn?.disableResume(); turn = null; if (!msg.versionEvent) user = msg; userMessage(msg); }
      if (msg.role === 'assistant') {
        turn ||= newTurn(false, user); turn.beginRound(); if (msg.reasoning) turn.setReasoning(msg.reasoning); if (msg.content) turn.setContent(msg.content);
        const results = new Map(); let j = i + 1; while (messages[j]?.role === 'tool') { results.set(messages[j].tool_call_id, messages[j]); j++; }
        for (const c of msg.tool_calls || []) { const row = turn.ensureTool(c), result = results.get(c.id); if (result) { try { row.setResult(JSON.parse(result.content)); } catch { row.setMissing(); } } else row.setMissing(); }
        turn.finishRound(msg, { incomplete: msg.incomplete, aborted: msg.aborted }); i = j - 1;
      }
    }
    turn?.finish({}, { replay: true }); lastTurn = turn; welcome(); context(); pinned = true; scroll();
  }
  function errorView(error) {
    const node = h('div', { class: 'agw-error', role: 'alert' }, glyph('alert', 15), h('div', {}, h('strong', {}, '处理已暂停，进度已保留'), h('p', {}, error.message || String(error)),
      h('button', { type: 'button', class: 'agw-text-button', onClick: () => { node.remove(); loop.resume(); } }, '继续处理'))); thread.append(node); scroll();
  }
  loop = createAgentLoop(ctx, {
    onUserMessage(msg) { if (followFrame != null) cancelAnimationFrame(followFrame); followFrame = null; lastTurn?.disableResume(); activeTurn = null; lastTurn = null; plan.classList.add('hidden'); userMessage(msg); pinned = true; scroll(); },
    onAssistantStart(meta) { activeTurn ||= newTurn(true); lastTurn = activeTurn; if (meta.continued) activeTurn.continuation({}); activeTurn.beginRound(); scroll(); },
    onAssistantDelta(text) { activeTurn?.setContent(text); }, onReasoningDelta(text) { activeTurn?.setReasoning(text); scroll(); },
    onToolCalls(calls) { activeTurn?.setToolCalls(calls); }, onAssistantEnd(msg, meta) { activeTurn?.noteRoundEnd(msg, meta); },
    onToolStart(call) { lastTurn?.toolStart(call); }, onToolResult(call, result) { lastTurn?.toolResult(call, result); }, onContinuation(info) { activeTurn?.continuation(info); },
    onStatus(value) {
      const labels = { thinking: '正在思考', streaming: '正在生成', tool: '正在操作', continuing: '继续生成中', reconnecting: '连接恢复中', compacting: '正在整理对话记忆', error: '已暂停', stopped: '已停止' };
      status.textContent = labels[value] || ''; status.dataset.state = value;
    },
    onStreamingChange(running) { refreshControls(); if (!running && activeTurn) { activeTurn.finish(); activeTurn = null; } },
    onAborted() { activeTurn?.finish({}, { aborted: true }); }, onError(error) {
      if (activeTurn && !activeTurn.hasContent()) { activeTurn.el.remove(); lastTurn = null; }
      else activeTurn?.finish({}, { incomplete: true });
      activeTurn = null; errorView(error);
    }, onLoadingChange() { refreshControls(); },
    onSessionLoaded({ messages }) {
      const key = draftKey(); if (sessionKey && sessionKey !== key) queue = []; sessionKey = key; renderQueue(); files = []; renderFiles(); plan.classList.add('hidden');
      input.value = read(key); grow(); replay(messages); refreshControls();
    },
    onNeedSetup() { safe(settings); }, onBeforeResume() { thread.querySelectorAll('.agw-error').forEach((e) => e.remove()); activeTurn = lastTurn?.reopen() || null; pinned = true; },
    onVersionsChanged(msg) {
      const row = [...thread.querySelectorAll('.agw-user')].find((el) => el.dataset.messageId === msg.id);
      row?.querySelector('.agw-user-revert')?.classList.toggle('hidden', !msg.versions?.[loop.projectId]?.before);
      lastTurn?.setVersion(!!msg.versions?.[loop.projectId]?.before);
    },
    onDeliveriesChanged(msg) { lastTurn?.setDeliveries(msg.deliveries); },
    onCheckpointError(error) { ctx.toast.warn('工程进度已保留，但交付版本保存失败：' + error.message); },
    onProjectDetached() { write(draftKey(), input.value); context(); },
    onSaveError() { status.textContent = '会话保存失败，本机备份已保留'; status.dataset.state = 'error'; },
    onDone(info) {
      refreshControls();
      if (ctx.agentDeletedProjectId) { ctx.agentDeletedProjectId = null; ctx.navigate('#/'); return; }
      if (!info.aborted && !info.error && queue.length) { const item = queue.shift(); renderQueue(); safe(() => loop.send(item.text, item.images, item.options)); }
    },
  });
  loop.setOptions(toolOptions()); ctx.agent = { loop }; attachMarkdownActions(thread);
  function setWidth(width) { const value = Math.max(340, Math.min(innerWidth, width)); document.documentElement.style.setProperty('--agent-w', value + 'px'); write('wds:agent:width', String(value)); window.dispatchEvent(new Event('resize')); }
  setWidth(Number(read('wds:agent:width', '500')) || 500);
  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault(); resize.setPointerCapture(e.pointerId); resize.classList.add('is-dragging');
    const move = (e) => setWidth(innerWidth - e.clientX), end = () => { resize.classList.remove('is-dragging'); resize.removeEventListener('pointermove', move); };
    resize.addEventListener('pointermove', move); resize.addEventListener('pointerup', end, { once: true }); resize.addEventListener('pointercancel', end, { once: true });
  });
  resize.addEventListener('keydown', (e) => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setWidth(panel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24)); } });
  const sendPayload = async (payload) => {
    setOpen(true); const p = typeof payload === 'string' ? { text: payload } : payload || {};
    if (p.images || p.docs) {
      if (loop.streaming) { queue.push({ text: p.text || '', images: p.images || [], options: { brief: p.brief, docs: p.docs || [], assetPaths: p.assetPaths || [] } }); renderQueue(); return { ok: true, queued: true }; }
      return loop.send(p.text, p.images || [], { brief: p.brief, docs: p.docs || [], assetPaths: p.assetPaths || [] });
    }
    input.value = p.text || ''; grow(); return submit(p.brief);
  };
  ctx.bus.registerCommand('app.toggleAgent', () => setOpen(app.dataset.agent !== 'open')); ctx.bus.registerCommand('agent.toggle', () => setOpen(app.dataset.agent !== 'open'));
  ctx.bus.registerCommand('agent.send', (payload) => { safe(() => sendPayload(payload)); return { ok: true }; }); ctx.bus.registerCommand('agent.stop', () => loop.stop()); ctx.bus.registerCommand('agent.newChat', () => loop.newChat());
  ctx.bus.registerCommand('agent.toggleSkill', (p) => ({ ok: true, skills: loop.toggleSkill(typeof p === 'string' ? p : p?.id || p?.skillId) }));
  ctx.bus.registerCommand('agent.openSettings', () => { safe(settings); return { ok: true }; }); ctx.bus.registerCommand('agent.openSearchSettings', () => { safe(() => openSearchSettings(ctx)); return { ok: true }; });
  ctx.bus.registerCommand('agent.openSkills', () => { safe(async () => openManager(ctx, { catalog: await loadCatalog(ctx), enabled: loop.skills, onChange: (ids) => loop.setSkills(ids) })); return { ok: true }; });
  ctx.bus.registerCommand('agent.openVersions', () => { safe(() => versions.open()); return { ok: true }; });
  ctx.bus.registerCommand('agent.fullscreen', (p={}) => setFullscreen(p.open ?? !fullscreen), {label:'全屏对话',group:'Agent',icon:'maximize'});
  ctx.bus.on('project:open', (data) => { closeMenu(); safe(() => loop.load((data.project || data).id)); context(); }); ctx.bus.on('route:change', (route) => { closeMenu(); if (route.name === 'library') safe(() => loop.load(null)); context(); });
  for (const event of ['selection:change', 'slide:change', 'deck:ready', 'project:renamed']) ctx.bus.on(event, context);
  ctx.bus.on('agent:plan', (data) => {
    if (!data?.plan) return; const steps = data.plan, done = steps.filter((s) => s.status === 'done').length;
    plan.classList.remove('hidden'); planLabel.textContent = done === steps.length ? `已完成 ${done} 项任务` : `${done}/${steps.length} · ${steps.find((s) => s.status === 'running')?.title || '任务计划'}`;
    planBody.replaceChildren(...steps.map((s) => h('div', { class: 'agw-plan-step', 'data-state': s.status }, glyph(s.status === 'done' ? 'check' : s.status === 'running' ? 'loading' : 'circle', 13), s.title)));
  });
  window.addEventListener('beforeunload', () => { saveDraft(); loop.flush(); }); safe(async () => { await loadSettings(ctx); refreshControls(); });
  await loop.load(ctx.store.get().project?.id || null); welcome(); refreshControls(); syncAppearance();
  if (read('wds:agent:fullscreen') === 'true' && app.dataset.agent==='open') setFullscreen(true);
  return { panel, loop };
}
export default { init };
