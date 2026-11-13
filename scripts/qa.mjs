/**
 * WebDeck Studio · QA 脚本
 * 无头 Chrome + CDP（Node 内置 WebSocket）：启动/复用服务 → 截图文件库、编辑器、Agent →
 * 跑一遍核心交互（选中、改字、插入、撤销、保存、动画）→ 收集 console error。
 *
 * 用法：node scripts/qa.mjs [--keep]
 * 产物：docs/shots/*.png、docs/shots/qa-report.json
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHOTS = path.join(ROOT, 'docs', 'shots');
const BASE = process.env.WDS_BASE || 'http://127.0.0.1:4321';
const DEBUG_PORT = Number(process.env.WDS_DEBUG_PORT || 9333);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const keep = process.argv.includes('--keep');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- CDP ---------------- */
class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this.ws.addEventListener('message', (ev) => this._onMessage(ev.data));
  }
  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    const list = this.handlers.get(msg.method);
    if (list) for (const fn of list) { try { fn(msg.params); } catch { /* ignore */ } }
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 30000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function waitHttp(url, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch { /* retry */ }
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + url);
    await sleep(250);
  }
}

/** 校验是本项目服务（/api/health JSON ok），避免被本机其它占用同端口的程序误判 */
async function waitServer(timeout = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) {
        const data = await r.json().catch(() => null);
        if (data && data.ok === true) return true;
      }
    } catch { /* retry */ }
    if (Date.now() - start > timeout) return false;
    await sleep(300);
  }
}

/* ---------------- 环境 ---------------- */
async function ensureServer() {
  if (await waitServer(1200)) return null;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, WDS_LOG: '0' } });
  const ok = await waitServer(20000);
  if (!ok) throw new Error('服务启动失败或端口被其它程序占用: ' + BASE);
  return child;
}

async function launchChrome() {
  const userData = path.join(os.tmpdir(), 'wds-qa-chrome-' + Date.now());
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + userData,
    '--window-size=1440,900',
    'about:blank',
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore' });
  await waitHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`, 20000);
  let page = null;
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
    await sleep(200);
  }
  if (!page) throw new Error('没有找到可调试页面');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  return { child, cdp, userData };
}

/* ---------------- 页面辅助 ---------------- */
class Page {
  constructor(cdp) {
    this.cdp = cdp;
    this.errors = [];
    this.warnings = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      this.errors.push('[exception] ' + (d.exception?.description || d.text || 'unknown'));
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      if (p.type === 'error') this.errors.push('[console.error] ' + text);
      else if (p.type === 'warning') this.warnings.push('[console.warn] ' + text);
    });
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') this.errors.push('[log] ' + (p.entry.text || '') + ' ' + (p.entry.url || ''));
    });
    cdp.on('Page.javascriptDialogOpening', () => {
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { });
    });
  }
  async init() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
  }
  async goto(url, waitMs = 1500) {
    await this.cdp.send('Page.navigate', { url });
    await sleep(waitMs);
  }
  async eval(expression, awaitPromise = true) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error('页面脚本异常: ' + msg);
    }
    return r.result?.value;
  }
  async waitFor(expression, timeout = 8000, interval = 250) {
    const start = Date.now();
    for (;;) {
      try {
        const v = await this.eval(expression);
        if (v) return v;
      } catch { /* retry */ }
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }
  async screenshot(name) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, name + '.png');
    await fs.writeFile(file, Buffer.from(r.data, 'base64'));
    return file;
  }
  async closeOverlays() {
    try {
      await this.eval(`(() => {
        try { window.__WDS__ && window.__WDS__.dialog && window.__WDS__.dialog.closeAll(); } catch (e) {}
        try { window.__WDS__ && window.__WDS__.overlay && window.__WDS__.overlay.closeAll && window.__WDS__.overlay.closeAll(); } catch (e) {}
        document.querySelectorAll('.modal-wrap').forEach((n) => n.remove());
        return true;
      })()`);
    } catch { /* ignore */ }
    await sleep(280);
  }
  resetErrors() { this.errors = []; this.warnings = []; }
}

/* ---------------- 主流程 ---------------- */
const report = { startedAt: new Date().toISOString(), base: BASE, steps: [], errors: [], warnings: [] };
const qaProjectIds = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? null });
    console.log('  ✓', name, `(${Date.now() - t0}ms)`, detail ? '→ ' + JSON.stringify(detail).slice(0, 180) : '');
    return detail;
  } catch (err) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: err.message });
    console.error('  ✗', name, '→', err.message);
    throw err;
  }
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  console.log('WebDeck Studio QA ·', BASE);
  const serverChild = await ensureServer();
  console.log('  ✓ 服务就绪');
  const { child: chromeChild, cdp } = await launchChrome();
  const page = new Page(cdp);
  await page.init();

  try {
    /* 0. 建一个测试工程 */
    const project = await step('创建测试工程', async () => {
      const r = await fetch(BASE + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'QA 自动化演示', templateId: 'ink' }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(data));
      qaProjectIds.push(data.project.id);
      return data.project;
    });

    /* 1. 文件库 */
    await step('打开文件库', async () => {
      page.resetErrors();
      await page.goto(BASE + '/?qa=1', 2200);
      await page.waitFor("document.querySelectorAll('#library-view .lib-card:not(.lib-card--skeleton)').length > 0", 8000);
      await sleep(400);
      const info = await page.eval(`(() => {
        const view = document.querySelector('#library-view');
        return {
          cards: view ? view.querySelectorAll('.lib-card:not(.lib-card--skeleton)').length : 0,
          text: view ? view.innerText.slice(0, 160) : '(missing)',
          route: window.__WDS__ ? window.__WDS__.route.name : null,
        };
      })()`);
      await page.screenshot('01-library');
      return info;
    });

    /* 2. 编辑器 */
    const editorInfo = await step('打开编辑器', async () => {
      page.resetErrors();
      await page.goto(BASE + '/?qa=1#/p/' + encodeURIComponent(project.id), 3800);
      const bridgeReady = await page.waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge && window.__WDS__.getEditor().bridge.ready)", 12000);
      const state = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const st = await ed.bridge.call('getState');
        return { bridgeReady: true, current: st.current, total: st.total, stage: st.stage, slides: st.slides.slice(0, 3) };
      })()`);
      await page.screenshot('02-editor');
      return { bridgeReady: !!bridgeReady, ...state };
    });

    /* 3. 选中 + 改字 + 撤销 */
    await step('选中元素并修改文字', async () => {
      const sel = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const st = await ed.bridge.call('getState');
        const pts = [];
        for (let y = 120; y < 1000; y += 80) for (let x = 120; x < 1800; x += 120) pts.push([x, y]);
        for (const [x, y] of pts) {
          const s = await ed.bridge.call('selectAt', { x, y });
          if (s && s.elementId) return s;
        }
        return null;
      })()`);
      if (!sel) throw new Error('没有选中任何元素');
      const result = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const before = window.__WDS__.store.get().history.ops.length;
        const r = await ed.bridge.call('setText', { elementId: ${JSON.stringify(sel.elementId)}, html: 'QA 自动化标题' });
        await new Promise((r2) => setTimeout(r2, 300));
        const after = window.__WDS__.store.get().history.ops.length;
        const el = await ed.bridge.call('getElementHtml', { elementId: ${JSON.stringify(sel.elementId)} });
        return { before, after, opPushed: after > before, textNow: (el.html || '').slice(0, 80) };
      })()`);
      if (!result.opPushed) throw new Error('change 事件没有入历史');
      await page.screenshot('03-edited');
      return { selected: { id: sel.elementId, type: sel.type, text: (sel.text || '').slice(0, 40) }, ...result };
    });

    await step('撤销修改', async () => {
      const r = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const before = await ed.bridge.call('getSelection');
        const r = await window.__WDS__.bus.runCommand('app.undo');
        await new Promise((r2) => setTimeout(r2, 400));
        const sel = await ed.bridge.call('getSelection');
        const h = await ed.bridge.call('getElementHtml', { elementId: sel ? sel.elementId : ${JSON.stringify('')} });
        return { ok: !!(r && r.ok !== false), textAfter: sel ? (sel.text || '').slice(0, 40) : null };
      })()`);
      await page.screenshot('04-undo');
      return r;
    });

    /* 4. 插入 + 动画 + 保存 */
    await step('插入元素并应用动画', async () => {
      const r = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const ins = await ed.bridge.call('insertElement', { type: 'text', x: 220, y: 780, w: 900, h: 120, html: 'QA 插入的文本框', styles: { 'font-size': '48px', color: '#E1402B' } });
        const anim = await ed.bridge.call('setAnimation', { elementId: ins.elementId, anim: { name: 'fadeUp', params: { delay: 100, duration: 800 } } });
        const anims = await ed.bridge.call('getSlideAnimations', { index: 0 });
        return { elementId: ins.elementId, animOk: !!(anim && anim.op), animCount: anims.length };
      })()`);
      await page.screenshot('05-insert-anim');
      return r;
    });

    await step('保存工程', async () => {
      const r = await page.eval(`(async () => {
        await window.__WDS__.bus.runCommand('app.save');
        await new Promise((r2) => setTimeout(r2, 1200));
        return { saving: window.__WDS__.store.get().ui.saving, ops: window.__WDS__.store.get().history.ops.length };
      })()`);
      const file = await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html').then((x) => x.json());
      return { ...r, fileSize: file.size, hasQaText: file.content.includes('QA 插入的文本框'), hasAnim: file.content.includes('data-wpx-anim') };
    });

    /* 5. 幻灯片操作 */
    await step('新增/复制/删除幻灯片', async () => {
      const r = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const st0 = await ed.bridge.call('getState');
        const added = await ed.bridge.call('addSlide', { afterIndex: 0 });
        const dup = await ed.bridge.call('duplicateSlide', { index: added.index });
        const st1 = await ed.bridge.call('getState');
        const del = await ed.bridge.call('deleteSlide', { index: dup.index });
        const st2 = await ed.bridge.call('getState');
        return { before: st0.total, afterAdd: st1.total, afterDelete: st2.total, current: st2.current };
      })()`);
      await page.screenshot('06-slides');
      return r;
    });

    /* 6. 切换 + 主题 */
    await step('应用切换与主题', async () => {
      const r = await page.eval(`(async () => {
        const ed = window.__WDS__.getEditor();
        const t = await ed.bridge.call('setSlideAttrs', { index: 0, attrs: { transition: 'iris' } });
        const th = await ed.bridge.call('setThemeVars', { vars: { '--wpx-accent': '#2C6E68' } });
        return { transition: !!(t && t.op), theme: !!(th && th.op) };
      })()`);
      await page.screenshot('07-theme');
      return r;
    });

    /* 7. Agent 面板 + 设置 */
    await step('打开 Agent 面板', async () => {
      page.resetErrors();
      await page.eval("window.__WDS__.bus.runCommand('app.toggleAgent')");
      await page.waitFor("document.querySelector('#app').dataset.agent === 'open'", 4000);
      const info = await page.eval(`(() => {
        const p = document.querySelector('#agent-panel');
        const s = window.__WDS__.store.get();
        return {
          visible: !!p && p.offsetHeight > 100,
          text: p ? p.innerText.slice(0, 200) : '',
          debug: { project: s.project && s.project.id, route: s.route, agentOpen: s.agent.open },
        };
      })()`);
      await page.screenshot('08-agent');
      return info;
    });

    await step('打开 AI 设置', async () => {
      await page.eval("window.__WDS__.bus.runCommand('agent.openSettings')");
      await sleep(900);
      const info = await page.eval(`(() => {
        const root = document.getElementById('overlay-root');
        const wrap = document.querySelector('.modal-wrap') || document.querySelector('[class*="ais-"]') || document.querySelector('.modal');
        return {
          visible: !!wrap,
          overlayHtml: root ? root.innerHTML.slice(0, 300) : '',
          text: wrap ? wrap.innerText.slice(0, 260) : '',
        };
      })()`);
      await page.screenshot('09-settings');
      return info;
    });

    /* 8. 缩略图接口 */
    await step('缩略图接口', async () => {
      const r = await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id) + '/thumb?slide=0');
      const html = await r.text();
      return { status: r.status, length: html.length, hasStage: html.includes('wpx-stage'), hasThumbCss: html.includes('thumb.css') };
    });

    /* 8.5 命令覆盖检查 */
    await step('命令覆盖检查', async () => {
      const expected = [
        'app.save', 'app.undo', 'app.redo', 'app.export', 'app.present', 'app.presentCurrent', 'app.reloadDeck',
        'file.new', 'file.import', 'file.rename', 'file.delete', 'file.duplicate',
        'slide.add', 'slide.duplicate', 'slide.delete', 'slide.move', 'slide.select', 'slide.setTransition',
        'slide.applyTransitionAll', 'slide.setBackground', 'slide.setName', 'slide.previewAnimation',
        'edit.cut', 'edit.copy', 'edit.paste', 'edit.delete', 'edit.selectAll', 'edit.duplicate',
        'text.bold', 'text.italic', 'text.underline', 'text.strike', 'text.fontFamily', 'text.fontSize',
        'text.color', 'text.highlight', 'text.align', 'text.lineHeight', 'text.letterSpacing', 'text.style',
        'insert.text', 'insert.image', 'insert.shape', 'insert.line', 'insert.icon', 'insert.html',
        'arrange.front', 'arrange.back', 'arrange.forward', 'arrange.backward',
        'arrange.alignLeft', 'arrange.alignCenter', 'arrange.alignRight', 'arrange.alignTop',
        'arrange.alignMiddle', 'arrange.alignBottom', 'arrange.distributeH', 'arrange.distributeV',
        'element.rotate', 'element.opacity', 'element.animation', 'element.animationRemove',
        'element.animationPreview', 'element.lock', 'element.unlock',
        'design.theme', 'design.fontPair', 'design.background', 'design.grain', 'design.vignette',
        'view.zoom', 'view.grid', 'view.rulers', 'view.dark', 'view.fullscreen', 'view.slidePanel',
        'agent.newChat', 'agent.stop', 'agent.send', 'agent.toggleSkill', 'agent.openSettings', 'agent.toggle',
        'history.open', 'history.revertTo', 'history.undo', 'history.redo',
        'app.toggleAgent', 'app.toggleInspector', 'app.toggleSlidePanel', 'app.zoomIn', 'app.zoomOut',
        'app.zoomReset', 'app.zoomFit', 'app.commandPalette', 'app.settings', 'app.toggleTheme',
      ];
      const registered = await page.eval(`window.__WDS__.bus.listCommands().map(c => c.name)`);
      const missing = expected.filter((n) => !registered.includes(n));
      return { total: registered.length, missing, missingCount: missing.length };
    });

    /* 9. 回到文件库 */
    await step('返回文件库', async () => {
      page.resetErrors();
      await page.closeOverlays();
      await page.goto(BASE + '/?qa=1#/', 2200);
      await page.waitFor("!!document.querySelector('#library-view')", 5000);
      await page.closeOverlays();
      await sleep(400);
      await page.screenshot('10-library-final');
      return await page.eval("document.querySelector('#library-view').innerText.slice(0,120)");
    });

    /* 10. 导入转换（--convert 时执行） */
    if (process.argv.includes('--convert')) {
      const convertSample = async (sampleId, shotName) => {
        // 每次转换前回到应用文件库，确保 __WDS__ 可用
        page.resetErrors();
        await page.goto(BASE + '/?qa=1#/', 2000);
        await page.waitFor("!!(window.__WDS__ && window.__WDS__.bus)", 8000);
        const imported = await fetch(BASE + '/api/projects/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sampleId }),
        }).then((r) => r.json());
        if (!imported.project) throw new Error('导入示例失败: ' + JSON.stringify(imported).slice(0, 300));
        const project = imported.project;
        qaProjectIds.push(project.id);
        const started = Date.now();
        await page.eval(`(() => {
          window.__CONV__ = { done: false };
          window.__WDS__.bus.runCommand('file.convert', { project: ${JSON.stringify(project)} })
            .then((r) => { window.__CONV__ = { done: true, result: r }; })
            .catch((e) => { window.__CONV__ = { done: true, error: String((e && e.message) || e) }; });
          return 'started';
        })()`, false);
        const done = await page.waitFor("!!(window.__CONV__ && window.__CONV__.done)", 180000, 800);
        if (!done) throw new Error('转换超时（' + sampleId + '）');
        const conv = await page.eval('window.__CONV__');
        const meta = await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id)).then((r) => r.json());
        const file = await fetch(BASE + '/api/projects/' + encodeURIComponent(project.id) + '/file?path=index.html').then((r) => r.json());
        const waapiCount = (String(file.content).match(/data-wpx-waapi=/g) || []).length;
        const trInSlides = (String(file.content).match(/data-wpx-tr-in=/g) || []).length;
        const trOutSlides = (String(file.content).match(/data-wpx-tr-out=/g) || []).length;
        const detail = {
          sampleId, ms: Date.now() - started, conv,
          kind: meta.project && meta.project.kind,
          slideCount: meta.project && meta.project.slideCount,
          fileSize: file.size,
          hasImportedCss: String(file.content).includes('id="wpx-imported"'),
          hasRuntime: String(file.content).includes('id="wpx-runtime"'),
          waapiSlides: waapiCount,
          transitionSlides: trInSlides,
          transitionOutSlides: trOutSlides,
          reportTransitions: conv?.result?.report?.transitions ?? null,
        };
        // 打开转换后的编辑器并截图
        page.resetErrors();
        await page.closeOverlays();
        await page.goto(BASE + '/?qa=1#/p/' + encodeURIComponent(project.id), 3800);
        await page.waitFor("document.getElementById('app').dataset.route === 'editor' && !!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge)", 15000);
        await sleep(1200);
        await page.closeOverlays();
        const st = await page.eval(`(async () => { const ed = window.__WDS__.getEditor(); return await ed.bridge.call('getState'); })()`);
        await page.screenshot(shotName);
        detail.editor = { total: st.total, current: st.current };
        // 放映模式截图（第一页）+ 验证原稿转场与动画首帧
        await page.goto(BASE + '/p/' + encodeURIComponent(project.id) + '/index.html', 2600);
        const present = await page.eval("window.__WPX__ ? window.__WPX__.getState() : null");
        await page.screenshot(shotName + '-present');
        const transitionCheck = await page.eval(`(async () => {
          if (!window.__WPX__) return null;
          const before = window.__WPX__.getState();
          // 翻到第 2 页，200ms 后检查：section 根节点上是否有转场动画、元素是否处于入场首帧
          window.__WPX__.go(1, { instant: false });
          await new Promise((r) => setTimeout(r, 220));
          const anims = document.getAnimations();
          const slideAnims = anims.filter((a) => {
            const t = a.effect && a.effect.target;
            return t && t.classList && t.classList.contains('wpx-slide');
          }).length;
          const active = document.querySelector('.wpx-slide.is-active');
          const firstAnimEl = active && active.querySelector('[data-wpx-anim]');
          const opacity = firstAnimEl ? parseFloat(getComputedStyle(firstAnimEl).opacity) : null;
          await new Promise((r) => setTimeout(r, 1400));
          return { from: before.current, slideAnims, firstAnimOpacity: opacity, to: window.__WPX__.getState().current };
        })()`);
        detail.present = present ? { mode: present.mode, total: present.total, current: present.current } : null;
        detail.transitionCheck = transitionCheck;
        return detail;
      };
      await step('转换 motion-100（100 页）', () => convertSample('motion-100', '11-converted-motion'));
      await step('转换 bloom-live（8 页）', () => convertSample('bloom-live', '12-converted-bloom'));
    }

    /* 11. Agent 工具调用 E2E（--agent 时执行，使用本地 Mock AI） */
    if (process.argv.includes('--agent')) {
      let mockChild = null;
      try {
        await waitHttp('http://127.0.0.1:4399/health', 1200);
      } catch {
        mockChild = spawn(process.execPath, ['scripts/mock-ai.mjs'], { cwd: ROOT, stdio: 'ignore' });
        await waitHttp('http://127.0.0.1:4399/health', 12000);
      }
      await step('配置 Mock AI Provider', async () => {
        await fetch(BASE + '/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: [{ id: 'mock', name: 'Mock AI', baseUrl: 'http://127.0.0.1:4399/v1', keyEnv: 'MOCK_AI_KEY', wire: 'openai', model: 'mock-tool', models: [], apiKey: 'test-key' }] }),
        });
        const models = await fetch(BASE + '/api/ai/models', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: 'mock' }),
        }).then((r) => r.json());
        await fetch(BASE + '/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: [{ id: 'mock', model: 'mock-tool', models: models.models || [] }] }),
        });
        const pub = await fetch(BASE + '/api/settings').then((r) => r.json());
        const p = pub.providers.find((x) => x.id === 'mock');
        return { models: (models.models || []).map((m) => m.id + ':' + (m.badges || []).join('/')), provider: p ? { keySet: p.keySet, masked: p.masked, model: p.model } : null };
      });

      await step('Agent 工具调用 E2E（Mock）', async () => {
        page.resetErrors();
        await page.closeOverlays();
        const editorUrl = BASE + '/?qa=1#/p/' + encodeURIComponent(project.id);
        await page.goto(editorUrl, 2600);
        // 写入模型选择后强制刷新，让 Agent 重新读取 settings + localStorage
        await page.eval(`localStorage.setItem('wds:agent:model', JSON.stringify({providerId:'mock',model:'mock-tool'})); location.reload(); true`);
        await sleep(4200);
        await page.waitFor("!!(window.__WDS__ && window.__WDS__.getEditor && window.__WDS__.getEditor() && window.__WDS__.getEditor().bridge)", 15000);
        await page.eval("window.__WDS__.bus.runCommand('app.toggleAgent')");
        await page.waitFor("document.querySelector('#app').dataset.agent === 'open'", 5000);
        await page.waitFor("(document.querySelector('#agent-panel .agent-model-name')?.textContent || '').includes('mock')", 12000);
        await sleep(700);
        const modelLabel = await page.eval("document.querySelector('#agent-panel .agent-model-name')?.textContent || ''");
        const target = await page.eval(`(async () => {
          const ed = window.__WDS__.getEditor();
          const data = await ed.bridge.call('getSlideHtml', { index: 0 });
          const doc = new DOMParser().parseFromString(data.html, 'text/html');
          const el = doc.querySelector('.wpx-text[data-wpx-el]') || doc.querySelector('[data-wpx-el]');
          if (!el) return null;
          const id = el.getAttribute('data-wpx-el');
          await ed.bridge.call('select', { elementId: id });
          return { elementId: id, text: (el.textContent || '').slice(0, 40) };
        })()`);
        if (!target) throw new Error('没有找到可编辑元素');
        await page.eval(`window.__WDS__.bus.runCommand('agent.send', { text: ${JSON.stringify('把 ' + target.elementId + ' 的文字改成 MOCK 文本')} }); true`);
        const changed = await page.waitFor(`(async () => {
          const ed = window.__WDS__.getEditor();
          const h = await ed.bridge.call('getElementHtml', { elementId: ${JSON.stringify(target.elementId)} });
          return !!(h && h.html && h.html.includes('MOCK'));
        })()`, 30000, 700);
        const agentOps = await page.eval("window.__WDS__.store.get().history.ops.filter(o => o.source === 'agent').length");
        const msgs = await page.eval("document.querySelectorAll('#agent-panel .agent-msg').length");
        /* Agent 3.0 结构：一次请求合并为一条消息（多轮），工具收进活动组，上下文条有数字 */
        const ui = await page.eval(`(() => {
          const p = document.getElementById('agent-panel');
          const q = (s) => p.querySelectorAll(s);
          return {
            turns: q('.agent-msg--assistant').length,
            rounds: q('.agent-ai-round').length,
            activities: q('.agent-activity:not(.hidden)').length,
            tools: q('.agent-tool').length,
            ctx: (p.querySelector('.agent-ctx-label') || {}).textContent || '',
            hasCtxBar: !!p.querySelector('.agent-ctxbar'),
            hasPlanDock: !!p.querySelector('.agent-plan-dock'),
          };
        })()`);
        if (ui.turns !== 1 || ui.rounds < 2 || ui.activities < 1 || !/上下文/.test(ui.ctx)) {
          throw new Error('Agent 3.0 界面结构异常: ' + JSON.stringify(ui));
        }
        await sleep(600);
        await page.screenshot('13-agent-tool');
        const undoClicked = await page.eval(`(() => {
          const btns = [...document.querySelectorAll('#agent-panel button')];
          const btn = btns.find((b) => /撤回/.test(b.textContent || ''));
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        await sleep(1000);
        const afterUndo = await page.eval(`(async () => {
          const ed = window.__WDS__.getEditor();
          const h = await ed.bridge.call('getElementHtml', { elementId: ${JSON.stringify(target.elementId)} });
          return { hasMock: !!(h && h.html && h.html.includes('MOCK')), ops: window.__WDS__.store.get().history.ops.length };
        })()`);
        return { modelLabel, target, changed: !!changed, agentOps, messages: msgs, ui, undoClicked, afterUndo };
      });

      await step('清理 Mock 配置', async () => {
        await fetch(BASE + '/api/settings', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ removeProviders: ['mock'] }),
        });
        await page.eval("localStorage.removeItem('wds:agent:model'); true").catch(() => { });
        if (mockChild) { try { mockChild.kill(); } catch { /* ignore */ } }
        return { ok: true };
      });
    }

    /* 12. 清理 QA 产生的测试工程（保留展示工程） */
    if (!process.argv.includes('--keep-projects') && qaProjectIds.length) {
      await step('清理 QA 测试工程', async () => {
        let deleted = 0;
        for (const id of qaProjectIds) {
          try {
            const r = await fetch(BASE + '/api/projects/' + encodeURIComponent(id), { method: 'DELETE' });
            if (r.ok) deleted += 1;
          } catch { /* ignore */ }
        }
        return { deleted, ids: qaProjectIds.length };
      });
    }

    report.errors = page.errors;
    report.warnings = page.warnings.slice(0, 20);
  } catch (err) {
    report.fatal = err.message;
    report.errors = page.errors;
    try { await page.screenshot('99-fatal'); } catch { /* ignore */ }
    console.error('\nQA 失败:', err.message);
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(SHOTS, 'qa-report.json'), JSON.stringify(report, null, 2), 'utf8');
    const failed = report.steps.filter((s) => !s.ok);
    console.log('\n结果:', report.steps.length - failed.length, '/', report.steps.length, '步骤通过');
    if (report.errors.length) {
      console.log('\nConsole/页面错误 (' + report.errors.length + '):');
      for (const e of report.errors.slice(0, 25)) console.log('  -', e.slice(0, 300));
    }
    if (report.warnings.length) {
      console.log('\n警告 (' + report.warnings.length + '，前 10):');
      for (const w of report.warnings.slice(0, 10)) console.log('  -', w.slice(0, 200));
    }
    cdp.close();
    if (!keep) {
      try { chromeChild.kill(); } catch { /* ignore */ }
      if (serverChild) { try { serverChild.kill(); } catch { /* ignore */ } }
    }
    process.exit(failed.length || report.fatal ? 1 : 0);
  }
}

main();
