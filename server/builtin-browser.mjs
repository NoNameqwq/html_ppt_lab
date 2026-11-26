import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { BROWSER_PROXY_HEADER, browserURL, startBrowserProxy } from './browser-network.mjs';

const VIEWPORT = { width: 1280, height: 800 };
const IDLE_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 8;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

async function launchChromium(proxy) {
  const options = {
    headless: true, chromiumSandbox: true, timeout: 12000,
    proxy: { server: proxy, bypass: '<-loopback>' },
    args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
  };
  if (process.env.CHROME_PATH) return chromium.launch({ ...options, executablePath: process.env.CHROME_PATH });
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ ...options, channel }); }
    catch (error) { if (!/not found|doesn.t exist|ENOENT/i.test(error.message)) throw error; }
  }
  throw bad('未检测到 Chrome 或 Edge。安装其一，或通过 CHROME_PATH 指定浏览器路径。', 503);
}

const selectors = 'a[href],button,summary,[role="button"],[role="tab"]';
async function observe(session, offset) {
  const { page, targets } = session;
  await Promise.allSettled(targets.map(target => target.dispose()));
  session.targets = [];
  session.snapshot = randomUUID();
  // Retain DOM identity for the numbered controls so delayed actions cannot
  // inadvertently click a different element after the page changes.
  const handles = await page.evaluateHandle(selector => Array.from(document.querySelectorAll(selector))
    .filter(node => {
      const rect = node.getBoundingClientRect();
      return !node.matches(':disabled,[aria-disabled="true"]') && rect.width > 0 && rect.height > 0 &&
        !(node.form && node.type === 'submit') &&
        rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth &&
        getComputedStyle(node).visibility === 'visible';
    }).slice(0, 32), selectors);
  try {
    session.targets = [...await handles.getProperties()].filter(([id]) => /^\d+$/.test(id))
      .sort(([a], [b]) => Number(a) - Number(b)).flatMap(([, handle]) => handle.asElement() || []);
  } finally { await handles.dispose(); }
  const targetsView = await Promise.all(session.targets.map(async (target, index) => {
    const element = await target.evaluate(node => ({
      label: (node.getAttribute('aria-label') || node.innerText || node.getAttribute('title') || node.querySelector('img')?.alt || node.tagName).replace(/\s+/g, ' ').trim().slice(0, 150),
      href: typeof node.href === 'string' ? node.href.slice(0, 4096) : '',
    }));
    return { index: index + 1, ...element };
  }));
  const content = await page.evaluate(offset => {
    const body = document.body;
    const text = (document.querySelector('main,[role="main"],article') || body)?.innerText || '';
    const position = Math.min(text.length, offset);
    const end = Math.min(text.length, position + 12000);
    return { title: document.title.slice(0, 200), text: text.slice(position, end), nextOffset: end < text.length ? end : null, scrollY, viewportHeight: innerHeight };
  }, offset);
  return { ok: true, url: page.url(), snapshot: session.snapshot, targets: targetsView, ...content };
}

export function createBuiltinBrowser({ launch = launchChromium, startProxy = startBrowserProxy } = {}) {
  const sessions = new Map(), pending = new Map();
  let engine, closed = false;
  function connect() {
    return engine ||= (async () => {
      const proxy = await startProxy();
      try {
        const browser = await launch(proxy.url);
        browser.once('disconnected', () => {
          engine = null;
          for (const key of sessions.keys()) void release(key);
          void proxy.close();
        });
        return browser;
      } catch (error) {
        await proxy.close();
        engine = null;
        throw error;
      }
    })();
  }
  async function release(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    await session.context.close().catch(() => {});
    await session.proxy?.close();
  }
  async function open(key, localOrigin) {
    if (new Set([...sessions.keys(), ...pending.keys(), key]).size > MAX_SESSIONS) {
      const idle = [...sessions].filter(([id]) => !pending.has(id)).sort((a, b) => a[1].usedAt - b[1].usedAt);
      if (!idle.length) throw bad('内置浏览器正忙。请稍后重试。', 429);
      await release(idle[0][0]);
    }
    const browser = await connect();
    const proxy = localOrigin ? await startProxy({ localOrigin }) : null;
    let context;
    try {
      context = await browser.newContext({
        viewport: VIEWPORT, acceptDownloads: false, serviceWorkers: 'block',
        ...(proxy && { proxy: { server: proxy.url, bypass: '<-loopback>' }, ignoreHTTPSErrors: true }),
      });
      await context.route('**/*', route => {
        try { browserURL(route.request().url(), { localOrigin }); }
        catch { return route.abort('blockedbyclient'); }
        return route.continue();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(16000);
      page.on('popup', popup => void popup.close().catch(() => {}));
      const session = { page, context, localOrigin, proxy, usedAt: Date.now(), targets: [], snapshot: '' };
      sessions.set(key, session);
      return session;
    } catch (error) {
      await context?.close().catch(() => {});
      await proxy?.close();
      throw error;
    }
  }
  async function run(key, args, signal) {
    signal?.throwIfAborted();
    if (closed) throw bad('内置浏览器正在关闭。', 503);
    const { action } = args;
    if (action === 'close') { await release(key); return { ok: true, open: false }; }
    const url = action === 'open' ? browserURL(args.url, { allowLoopback: true }) : null;
    const localOrigin = url?.hostname === '127.0.0.1' ? url.origin : '';
    let session = sessions.get(key);
    if (!session && !url) {
      if (action === 'inspect') return { ok: true, open: false };
      throw bad('内置浏览器还没有打开网页。');
    }
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw bad('正文偏移量必须是非负整数。');
    const cancel = () => { void release(key); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (url && session && session.localOrigin !== localOrigin) {
        await release(key);
        session = null;
      }
      session ||= await open(key, localOrigin);
      if (signal?.aborted) { await release(key); signal.throwIfAborted(); }
      const { page } = session;
      session.usedAt = Date.now();
      let response;
      try {
        if (url) response = await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        if (action === 'back') response = await page.goBack({ waitUntil: 'domcontentloaded' });
        if (action === 'reload') response = await page.reload({ waitUntil: 'domcontentloaded' });
        if (action === 'scroll') {
          const pixels = args.pixels;
          if (!Number.isInteger(pixels) || Math.abs(pixels) > 4000) throw bad('滚动距离须为 -4000 至 4000 像素。');
          await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
          await page.mouse.wheel(0, pixels);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        if (action === 'click') {
          const target = session.targets[args.index - 1];
          if (!target || !Number.isInteger(args.index) || args.snapshot !== session.snapshot) throw bad('控件编号已失效，请先重新读取页面。', 409);
          const link = await target.evaluate(node => typeof node.href === 'string'
            ? { href: node.href, newTab: Boolean(node.target && node.target !== '_self') }
            : null);
          if (link && !/^javascript:/i.test(link.href)) browserURL(link.href, { localOrigin: session.localOrigin });
          if (link?.newTab && !/^javascript:/i.test(link.href)) response = await page.goto(link.href, { waitUntil: 'domcontentloaded' });
          else {
            await target.click();
            await page.waitForLoadState('domcontentloaded');
          }
        }
      } catch (error) {
        if (error.status || signal?.aborted) throw error;
        throw bad(error.name === 'TimeoutError' ? '网页操作超时。可以尝试刷新或换一个来源。' : '网页无法打开或控件已变化。请检查网址，或重新读取页面。', 502);
      }
      if (page.url() === 'about:blank') return { ok: true, open: false };
      browserURL(page.url(), { localOrigin: session.localOrigin });
      const proxyStatus = response?.headers()[BROWSER_PROXY_HEADER];
      if (proxyStatus === 'blocked') throw bad('网页跳转到了当前浏览会话无法访问的地址。');
      if (proxyStatus === 'unavailable') throw bad(session.localOrigin ? '无法连接本地网页。请确认服务已经启动并检查端口。' : '无法连接网页。', 502);
      const snapshot = await observe(session, offset);
      if (response) snapshot.httpStatus = response.status();
      if (action === 'screenshot' || args.preview === true) {
        const bytes = await page.screenshot({ type: 'jpeg', quality: 82, timeout: 10000 });
        snapshot.images = ['data:image/jpeg;base64,' + bytes.toString('base64')];
      }
      return { ...snapshot, open: true };
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  const sweep = setInterval(() => {
    for (const [key, session] of sessions) {
      if (!pending.has(key) && Date.now() - session.usedAt > IDLE_MS) void release(key);
    }
  }, 60000);
  sweep.unref();
  return {
    async operate(key, args, signal) {
      if (!['open', 'inspect', 'click', 'scroll', 'back', 'reload', 'screenshot', 'close'].includes(args?.action)) throw bad('未知浏览器操作。');
      if (pending.has(key)) throw bad('当前浏览器正在处理另一个操作。', 409);
      const deadline = AbortSignal.timeout(35000);
      const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const work = run(key, args, operationSignal);
      pending.set(key, work);
      try {
        return await work;
      } catch (error) {
        if (deadline.aborted && !signal?.aborted) throw bad('浏览器操作超过等待时间。请重新打开网页。', 504);
        throw error;
      } finally { pending.delete(key); }
    },
    async close() {
      closed = true;
      clearInterval(sweep);
      await Promise.all([...sessions.keys()].map(release));
      const browser = await engine?.catch(() => null);
      await browser?.close().catch(() => {});
    },
  };
}
