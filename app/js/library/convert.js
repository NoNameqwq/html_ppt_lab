/* ==========================================================================
   导入转换：把任意 HTML 网页 PPT 捕获为 WebDeck Studio 原生 deck
   - 隐藏 iframe 加载原稿（优先 server ?wpx=capture 注入计时器加速器，回退 srcdoc 自注入）
   - 收集原稿 CSS / 逐页激活 / WAAPI 动画快照 / 组装原生 deck / 写盘 / PATCH 元数据
   - 进度浮层（0-100%，可取消） + 结果报告浮层（可重试）
   纯逻辑函数（转义/组装/主题/找页）单独导出，便于 node 自测。
   ========================================================================== */

import { h, escapeAttr, escapeHtml, formatBytes } from '../core/dom.js';
import { icon } from '../ui/icons.js';

const RUNTIME_URLS = {
  css: '/editor/deck-runtime.css',
  fx: '/editor/fx-presets.js',
  runtime: '/editor/deck-runtime.js',
};

const STATE_CLASSES = ['live', 'active', 'under', 'current', 'show', 'is-active'];
const ROOT_TRANSIENT_PROPS = ['visibility', 'z-index', 'opacity', 'transform', 'clip-path', 'filter', 'will-change'];
const ACCENT_VARS = ['--accent', '--red', '--vermilion', '--bloom', '--violet', '--primary', '--brand', '--coral', '--highlight'];
const SERIF_VARS = ['--serif', '--ui-serif', '--font-serif', '--title-font'];
const SANS_VARS = ['--sans', '--ui-sans', '--font-sans', '--body-font'];
const LATIN_VARS = ['--latin', '--ui-latin', '--font-latin', '--mono'];

const DEFAULT_SERIF = '"Songti SC","Source Han Serif SC","Noto Serif SC",SimSun,serif';
const DEFAULT_SANS = '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
const DEFAULT_LATIN = '"Inter","Helvetica Neue",Arial,sans-serif';

const MAX_ANIMS_PER_PAGE = 120;
const MAX_WAAPI_JSON = 220 * 1024;
const SETTLE_MS = 190;          // 每页激活后等待原稿脚本跑完（原稿计时器已加速）
const FINISH_WAIT_MS = 40;      // finish() 后再等一帧
const LOAD_TIMEOUT_MS = 20000;
const KEY_WAIT_MS = 1200;       // 单页键盘激活等待上限

let ctx = null;
let activeRun = null;

/* ==========================================================================
   纯逻辑（可被 node 直接 import 自测）
   ========================================================================== */

/** 单引号包裹 HTML 属性值，并把 JSON 里的特殊字符转成实体（浏览器解析后自动还原） */
export function escapeJsonAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 清理原 slide 根节点的 class：去掉 live/active/under/current/show/is-active 状态类 */
export function sanitizeSlideClasses(className) {
  return String(className || '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((c) => !STATE_CLASSES.includes(c))
    .join(' ');
}

/** 把 WAAPI timing 归一化为 JSON 安全结构（Infinity → -1） */
export function normalizeTiming(timing = {}, anim) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  let duration = timing.duration;
  if (duration === 'auto' || typeof duration !== 'number' || !Number.isFinite(duration)) duration = 0;
  const iterations = timing.iterations == null || timing.iterations === Infinity ? -1 : num(timing.iterations);
  return {
    duration,
    delay: num(timing.delay),
    endDelay: num(timing.endDelay),
    iterations,
    direction: timing.direction || 'normal',
    easing: typeof timing.easing === 'string' ? timing.easing : 'linear',
    fill: timing.fill || 'both',
    playbackRate: anim && typeof anim.playbackRate === 'number' && Number.isFinite(anim.playbackRate) ? anim.playbackRate : 1,
  };
}

/** 序列化 `#wpx-theme` 里的 CSS 变量 */
export function themeCssFromVars(vars) {
  const order = [
    '--wpx-bg', '--wpx-fg', '--wpx-fg-2', '--wpx-muted', '--wpx-accent', '--wpx-accent-2',
    '--wpx-line', '--wpx-serif', '--wpx-sans', '--wpx-latin', '--wpx-radius',
    '--wpx-grain-opacity', '--wpx-vignette-opacity',
  ];
  const body = order
    .filter((k) => vars && vars[k] != null && vars[k] !== '')
    .map((k) => `${k}:${String(vars[k]).trim()}`)
    .join(';');
  return `:root{${body}}`;
}

/** 组装单页 section（严格按 SPEC §2 导入页结构） */
export function buildSlideSection({ index, name, canvasClass, innerHtml, waapiJson, transition = 'fade', trInJson = '', trOutJson = '', trDuration = 0 }) {
  const id = 's' + (index + 1);
  const cls = sanitizeSlideClasses(canvasClass || '');
  const canvasCls = ('wpx-canvas ' + cls).trim();
  const attrs = [
    'class="wpx-slide"',
    `data-id="${escapeAttr(id)}"`,
    `data-name="${escapeAttr(name || '第' + (index + 1) + '页')}"`,
    `data-transition="${escapeAttr(transition)}"`,
    'data-origin="imported"',
  ];
  if (waapiJson) attrs.push(`data-wpx-waapi='${escapeJsonAttr(waapiJson)}'`);
  // 原稿转场动画快照：进入本页时应用的动画（in）与离开本页时的动画（out）
  if (trInJson) attrs.push(`data-wpx-tr-in='${escapeJsonAttr(trInJson)}'`);
  if (trOutJson) attrs.push(`data-wpx-tr-out='${escapeJsonAttr(trOutJson)}'`);
  if (trDuration) attrs.push(`data-wpx-tr-duration="${Math.round(trDuration)}"`);
  return `<section ${attrs.join(' ')}><div class="${escapeAttr(canvasCls)}">${innerHtml}</div></section>`;
}

/** 内联进 <style> 时避免提前闭合 */
function safeStyleText(text) {
  return String(text || '').replace(/<\/(style)/gi, '<\\/$1');
}
/** 内联进 <script> 时避免提前闭合 */
function safeScriptText(text) {
  return String(text || '').replace(/<\/(script)/gi, '<\\/$1');
}
function safeJsonText(text) {
  return String(text || '').replace(/<\/(script)/gi, '<\\/$1');
}

/** 组装完整原生 deck（SPEC §2 顺序：imported → theme → css → runtime-css；fx 在 runtime 前） */
export function buildDeckHtml({
  title, importedCss, themeCss, customCss = '', slidesHtml = [], dataJson,
  runtimeCss = '', fxJs = '', runtimeJs = '', runtimeMissing = false,
}) {
  const styles = [
    `<style id="wpx-imported">${safeStyleText(importedCss)}</style>`,
    `<style id="wpx-theme">${safeStyleText(themeCss)}</style>`,
    `<style id="wpx-css">${safeStyleText(customCss)}</style>`,
    runtimeCss
      ? `<style id="wpx-runtime-css">${safeStyleText(runtimeCss)}</style>`
      : '<style id="wpx-runtime-css">/* 运行时 CSS 缺失：请重新转换 */</style>',
  ].join('\n');
  const scripts = [
    `<!-- 由 WebDeck Studio 从原稿转换生成${runtimeMissing ? '（运行时资源缺失，请重新转换）' : ''} -->`,
    fxJs ? `<script id="wpx-fx">${safeScriptText(fxJs)}</script>` : '<script id="wpx-fx">/* fx-presets.js 缺失 */</script>',
    runtimeJs ? `<script id="wpx-runtime">${safeScriptText(runtimeJs)}</script>` : '<script id="wpx-runtime">/* deck-runtime.js 缺失 */</script>',
  ].join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title || '导入的演示')}</title>
${styles}
</head>
<body class="wpx-body" data-wpx-grain="off" data-wpx-vignette="off">
<div id="wpx-app" data-w="1920" data-h="1080">
  <div id="wpx-stage">${slidesHtml.join('\n')}</div>
  <div class="wpx-hud" aria-hidden="true"></div>
</div>
<script type="application/json" id="wpx-data">${safeJsonText(dataJson || '{}')}</script>
${scripts}
</body>
</html>`;
}

/** 在 srcdoc 回退方案里注入 acceleration 预脚本 + base href（保证相对资源可加载） */
export function injectCapturePrep(html, projectId) {
  const src = String(html || '');
  const baseTag = `<base href="/p/${encodeURIComponent(projectId || '')}/original/">`;
  const prep = `<script>${ACCEL_SOURCE}<\/script>`;
  const inject = baseTag + prep;
  if (/<head\b[^>]*>/i.test(src)) return src.replace(/<head\b[^>]*>/i, (m) => m + inject);
  if (/<html\b[^>]*>/i.test(src)) return src.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
  return inject + src;
}

const ACCEL_SOURCE = `(function(){var st=window.setTimeout,si=window.setInterval;window.__wpxNativeTimeout=st;window.__wpxNativeInterval=si;window.setTimeout=function(fn,ms){var a=[].slice.call(arguments,2);if(typeof ms==='number'&&ms>=200&&ms<=3000){ms=Math.min(ms,60);}return st.apply(window,[fn,ms].concat(a));};window.setInterval=function(fn,ms){var a=[].slice.call(arguments,2);if(typeof ms==='number'&&ms>=200&&ms<=3000){ms=Math.min(ms,60);}return si.apply(window,[fn,ms].concat(a));};window.__WPX_CAPTURE__=true;})();`;

/* ---------- 颜色工具 ---------- */

const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', transparent: 'rgba(0,0,0,0)',
  red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080',
};

/** 解析 #hex / rgb() / rgba() / 常用颜色名 → {r,g,b,a}; 失败返回 null */
export function parseColor(input) {
  if (!input || typeof input !== 'string') return null;
  let str = input.trim().toLowerCase();
  if (!str) return null;
  if (NAMED_COLORS[str]) str = NAMED_COLORS[str];
  if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(str);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(str);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

const toHex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

export function colorToHex(c) {
  if (!c) return '#000000';
  return '#' + toHex2(c.r) + toHex2(c.g) + toHex2(c.b);
}

/** 颜色混合：t=0 → a，t=1 → b（保留不透明度取 a 的） */
export function mixColor(a, b, t = 0.5) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return a;
  const w = Math.max(0, Math.min(1, t));
  return colorToHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  });
}

/** 相对亮度（0-1），用于判断深浅主题 */
export function colorLuminance(input) {
  const c = parseColor(input);
  if (!c) return 0;
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** 从 CSS 文本抽取自定义属性值 */
export function extractCssVar(cssText, names = []) {
  const src = String(cssText || '');
  for (const name of names) {
    const re = new RegExp(name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&') + '\\s*:\\s*([^;}]+)');
    const m = re.exec(src);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return '';
}

/**
 * 从原稿取色生成 deck 主题。
 * @param {{bg:string,fg:string,accent:string,serif:string,sans:string,latin:string}} samples
 */
export function themeFromSamples(samples = {}) {
  const bgRaw = parseColor(samples.bg) ? samples.bg : '#0A0A0B';
  let fgRaw = parseColor(samples.fg) ? samples.fg : '#F2EAE0';
  if (colorLuminance(bgRaw) >= 0 && Math.abs(colorLuminance(bgRaw) - colorLuminance(fgRaw)) < 0.12) {
    fgRaw = colorLuminance(bgRaw) > 0.5 ? '#1B1A17' : '#F2EAE0';
  }
  const accentRaw = parseColor(samples.accent) ? samples.accent : '#E1402B';
  const dark = colorLuminance(bgRaw) < 0.42;
  const theme = dark ? 'ink' : 'paper';
  const vars = {
    '--wpx-bg': bgRaw,
    '--wpx-fg': fgRaw,
    '--wpx-fg-2': mixColor(fgRaw, bgRaw, 0.26),
    '--wpx-muted': mixColor(fgRaw, bgRaw, 0.46),
    '--wpx-accent': accentRaw,
    '--wpx-accent-2': mixColor(accentRaw, dark ? '#FFFFFF' : '#000000', dark ? 0.22 : 0.18),
    '--wpx-line': mixColor(fgRaw, bgRaw, 0.82),
    '--wpx-serif': samples.serif || DEFAULT_SERIF,
    '--wpx-sans': samples.sans || DEFAULT_SANS,
    '--wpx-latin': samples.latin || DEFAULT_LATIN,
    '--wpx-radius': '8px',
    '--wpx-grain-opacity': dark ? '0.05' : '0.028',
    '--wpx-vignette-opacity': dark ? '0.42' : '0.18',
  };
  return { id: theme, vars, css: themeCssFromVars(vars), cover: colorToHex(parseColor(bgRaw)), coverFg: colorToHex(parseColor(fgRaw)), coverAccent: colorToHex(parseColor(accentRaw)) };
}

/* ==========================================================================
   转换主流程
   ========================================================================== */

/** 取消信号 */
class ConvertCanceled extends Error {
  constructor() {
    super('已取消转换');
    this.name = 'ConvertCanceled';
    this.canceled = true;
  }
}

export function isConverting() { return Boolean(activeRun); }

/** 注册命令；由 library.js 在 init 时调用 */
export async function init(_ctx) {
  ctx = _ctx;
  ctx.bus.registerCommand('file.convert', (payload) => runConvertFlow(payload || {}), {
    label: '转换为可编辑工程',
    group: '文件',
    icon: 'wand',
    shortcut: '',
  });
}

/**
 * 文件库/导入流程入口：显示进度浮层 → 转换 → 写入 → 报告。
 * @param {{project?:object, projectId?:string, silent?:boolean}} payload
 */
export async function runConvertFlow(payload = {}) {
  if (!ctx) return { ok: false, error: '模块未初始化' };
  if (activeRun) {
    ctx.toast.warn('已有转换任务正在进行中');
    return { ok: false, busy: true, error: '转换进行中' };
  }
  let project = payload.project || null;
  const id = payload.projectId || project?.id;
  if (!id) {
    ctx.toast.error('缺少工程信息，无法转换');
    return { ok: false, error: '缺少工程信息' };
  }
  activeRun = { startedAt: performance.now(), id };
  try {
    if (!project?.hasOriginal) {
      try {
        const { project: fresh } = await ctx.api.getProject(id);
        project = fresh;
      } catch (err) {
        ctx.toast.error('读取工程失败：' + (err.message || err));
        return { ok: false, error: err.message };
      }
    }
    if (!project?.hasOriginal) {
      ctx.toast.error('该工程没有保留原稿，无法转换');
      return { ok: false, error: '没有原稿' };
    }
    const ui = openProgressOverlay({ project });
    const startedAt = performance.now();
    try {
      const report = await convertProject({
        project,
        isCanceled: () => ui.isCanceled(),
        onProgress: (patch) => ui.update(patch),
      });
      report.durationMs = Math.round(performance.now() - startedAt);
      ui.close();
      ctx.bus.emit('library:refresh', { projectId: project.id });
      openReportOverlay({ project, report });
      return { ok: true, report };
    } catch (err) {
      ui.close();
      const canceled = err instanceof ConvertCanceled || err?.canceled;
      ctx.bus.emit('library:refresh', { projectId: id });
      if (canceled) {
        ctx.toast('已取消转换，原稿已保留');
        openReportOverlay({ project, canceled: true });
        return { ok: false, canceled: true };
      }
      console.error('[convert] 转换失败', err);
      openReportOverlay({ project, error: err?.message || String(err) });
      return { ok: false, error: err?.message || String(err) };
    }
  } finally {
    activeRun = null;
  }
}

/** 执行一次完整转换（不负责 UI），返回报告 */
async function convertProject({ project, isCanceled, onProgress }) {
  const tick = (percent, text, detail) => {
    if (typeof onProgress === 'function') onProgress({ percent, text, detail });
  };
  const warnings = [];
  const startedAt = performance.now();

  tick(1, '准备转换…', '读取原稿与运行时资源');
  const runtime = await loadRuntimeAssets(warnings);
  if (runtime.missing) warnings.push('运行时资源（deck-runtime / fx-presets）暂不可用，已写入占位；请稍后重新转换');

  const { html, useServer } = await loadOriginalHtml(project, warnings);
  if (isCanceled()) throw new ConvertCanceled();

  tick(4, '原稿加载中…', useServer ? '已启用服务端捕获预脚本' : '使用 srcdoc 回退模式');
  const frame = createCaptureFrame();
  let win = null;
  let doc = null;
  try {
    win = await loadCaptureFrame(frame, { project, html, useServer });
    doc = frame.contentDocument || win?.document;
    if (!doc) throw new Error('无法访问原稿 iframe 文档（可能跨域）');
    tick(6, '等待原稿稳定…', '等待首屏渲染与字体就绪');
    await wait(800);
    try {
      if (doc.fonts && doc.fonts.ready) await Promise.race([doc.fonts.ready, wait(2500)]);
    } catch { /* ignore */ }
    if (isCanceled()) throw new ConvertCanceled();

    tick(8, '收集原稿样式…');
    const importedCss = collectDocumentCss(doc, warnings);
    const slides = findSlideCandidates(doc);
    if (!slides.length) {
      throw new Error('没有在原稿中找到幻灯片（支持 #stage > .slide / .slide / section[data-slide] / #app section）');
    }
    const total = slides.length;
    if (total > 200) warnings.push(`原稿共 ${total} 页，转换耗时较长（预计约 ${Math.round(total * 0.45)} 秒）`);

    tick(10, `已找到 ${total} 页`, '准备逐页捕获内容与动画');
    if (isCanceled()) throw new ConvertCanceled();

    const activation = { mode: 'keyboard', slow: 0 };
    const sections = [];
    let animCount = 0;
    let failCount = 0;
    let trCount = 0;
    const trInByIndex = new Map();
    const trOutByIndex = new Map();
    // 记录原稿切换时在 slide 根节点上创建的 WAAPI 动画（用于保留原稿转场）
    const transitionRecorder = installTransitionRecorder(win);

    for (let i = 0; i < total; i++) {
      if (isCanceled()) throw new ConvertCanceled();
      const percent = 10 + Math.round((i / total) * 80);
      tick(percent, `捕获第 ${i + 1} / ${total} 页`, i === 0 ? '首屏激活中…' : '');
      try {
        if (transitionRecorder) transitionRecorder.log.length = 0;
        await activateSlide({ win, doc, slides, index: i, activation, warnings });
        await wait(SETTLE_MS);
        // 收集本次切换的原稿转场动画（进入本页 / 离开上一页）
        if (transitionRecorder && i > 0) {
          const trIn = collectSlideTransitionAnims(transitionRecorder, slides[i]);
          const trOut = collectSlideTransitionAnims(transitionRecorder, slides[i - 1]);
          if (trIn.length) trInByIndex.set(i, trIn);
          if (trOut.length) {
            trOutByIndex.set(i - 1, trOut);
            // 上一页 section 已生成：补上它的「离场」转场动画
            if (sections[i - 1]) {
              sections[i - 1] = patchSectionTransitions(sections[i - 1], trInByIndex.get(i - 1) || [], trOut);
            }
          }
        }
        finishSlideAnimations(doc, slides[i]);
        await wait(FINISH_WAIT_MS);
        finishSlideAnimations(doc, slides[i]);
        // 没有捕获到 WAAPI 转场的页：用原稿 HUD 文案猜测转场类型（如 SHUTTER·快门）
        const fallbackTransition = i === 0 ? 'fade' : (detectTransitionLabel(doc) || 'fade');
        const captured = captureSlide({
          win, doc, slideEl: slides[i], index: i, warnings,
          trIn: trInByIndex.get(i) || [],
          trOut: trOutByIndex.get(i) || [],
          transition: fallbackTransition,
        });
        sections.push(captured.section);
        animCount += captured.anims;
        trCount += captured.transitions || 0;
      } catch (err) {
        failCount += 1;
        if (err instanceof ConvertCanceled) throw err;
        warnings.push(`第 ${i + 1} 页捕获失败：${err?.message || err}`);
      }
      // 让出主线程，避免长任务阻塞页面
      await nextFrame();
    }

    if (!sections.length) throw new Error('所有页面都捕获失败，原稿结构可能不受支持');
    if (failCount) warnings.push(`共 ${failCount} 页捕获失败，已跳过`);
    // 统计转场快照总数（in + out）
    trCount = 0;
    trInByIndex.forEach((v) => { trCount += v.length; });
    trOutByIndex.forEach((v) => { trCount += v.length; });

    tick(92, '组装原生 deck…', `共 ${sections.length} 页 · ${animCount} 个动画快照`);
    const theme = sampleSourceTheme(win, doc, slides, importedCss);
    let title = project.name || '导入的演示';
    try { title = doc.title || title; } catch { /* ignore */ }
    const dataJson = JSON.stringify({
      title: project.name || title,
      w: 1920,
      h: 1080,
      theme: theme.id,
      sourceTitle: title,
      slides: sections.map((_, i) => ({ id: 's' + (i + 1), name: `第${i + 1}页`, transition: 'fade' })),
    });
    const deckHtml = buildDeckHtml({
      title: project.name || title,
      importedCss,
      themeCss: theme.css,
      slidesHtml: sections,
      dataJson,
      runtimeCss: runtime.css,
      fxJs: runtime.fx,
      runtimeJs: runtime.runtime,
      runtimeMissing: runtime.missing,
    });

    if (isCanceled()) throw new ConvertCanceled();

    tick(95, '写入工程文件…', `deck 大小 ${formatBytes(deckHtml.length)}`);
    const themePatched = { theme: theme.id, cover: theme.cover, coverFg: theme.coverFg, coverAccent: theme.coverAccent };
    const patchBody = {
      kind: runtime.missing ? 'imported' : 'native',
      slideCount: sections.length,
      theme: themePatched.theme,
      cover: themePatched.cover,
      coverFg: themePatched.coverFg,
      coverAccent: themePatched.coverAccent,
      origin: {
        file: project.origin?.file || '',
        from: project.origin?.from || 'import',
        convertedAt: Date.now(),
      },
    };
    try {
      await ctx.api.putFile(project.id, 'index.html', deckHtml);
    } catch (err) {
      throw new Error('写入 deck 失败：' + (err?.message || err));
    }
    tick(98, '更新工程信息…');
    try {
      await ctx.api.patchProject(project.id, patchBody);
    } catch (err) {
      warnings.push('工程元数据更新失败：' + (err?.message || err));
    }

    tick(100, '转换完成', `${sections.length} 页 · ${animCount} 个动画快照 · ${trCount} 个原稿转场`);
    return {
      ok: true,
      projectId: project.id,
      total,
      slides: sections.length,
      skipped: total - sections.length,
      animations: animCount,
      transitions: trCount,
      cssSize: importedCss.length,
      htmlSize: deckHtml.length,
      runtimeMissing: runtime.missing,
      theme: theme.id,
      warnings,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    try { frame.remove(); } catch { /* ignore */ }
    try {
      if (frame.contentWindow) frame.contentWindow.location.replace('about:blank');
    } catch { /* ignore */ }
  }
}

/* ---------- iframe / 原稿加载 ---------- */

async function loadRuntimeAssets(warnings) {
  const fetchText = async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return '';
      return await res.text();
    } catch {
      return '';
    }
  };
  const [css, fx, runtime] = await Promise.all([
    fetchText(RUNTIME_URLS.css),
    fetchText(RUNTIME_URLS.fx),
    fetchText(RUNTIME_URLS.runtime),
  ]);
  const missing = !css || !fx || !runtime;
  if (missing) {
    if (!css) warnings.push('缺少 deck-runtime.css');
    if (!fx) warnings.push('缺少 fx-presets.js');
    if (!runtime) warnings.push('缺少 deck-runtime.js');
  }
  return { css, fx, runtime, missing };
}

async function loadOriginalHtml(project, warnings) {
  const id = project.id;
  const url = `/p/${encodeURIComponent(id)}/original/index.html?wpx=capture`;
  let html = '';
  let hasPrep = false;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 32) {
        html = text;
        hasPrep = /__WPX_CAPTURE__|__wpxNativeTimeout/.test(text);
      }
    }
  } catch (err) {
    console.warn('[convert] 服务端捕获端点不可用，尝试回退', err);
  }
  if (!hasPrep) {
    // 回退：直接读取原稿文件（server 未注入预脚本时）
    if (!html) {
      try {
        const file = await ctx.api.getFile(id, 'original/index.html');
        html = file.content || '';
      } catch (err) {
        throw new Error('无法读取原稿文件：' + (err?.message || err));
      }
    }
    if (!html) throw new Error('原稿内容为空');
    warnings.push('服务端未注入捕获预脚本，已使用 srcdoc + 前端注入（等效流程）');
  }
  return { html, useServer: hasPrep };
}

function createCaptureFrame() {
  const frame = document.createElement('iframe');
  frame.className = 'cv-capture-frame';
  frame.setAttribute('title', '原稿捕获');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  document.body.appendChild(frame);
  return frame;
}

function loadCaptureFrame(frame, { project, html, useServer }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`原稿加载超时（${Math.round(LOAD_TIMEOUT_MS / 1000)} 秒），请确认原稿可在浏览器中打开`));
    }, LOAD_TIMEOUT_MS);
    frame.addEventListener('load', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 给脚本微任务一点时间
      setTimeout(() => resolve(frame.contentWindow), 30);
    }, { once: true });
    try {
      if (useServer) {
        frame.src = `/p/${encodeURIComponent(project.id)}/original/index.html?wpx=capture`;
      } else {
        frame.srcdoc = injectCapturePrep(html, project.id);
      }
    } catch (err) {
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

/* ---------- CSS 收集 ---------- */

function collectDocumentCss(doc, warnings) {
  const chunks = [];
  for (const style of doc.querySelectorAll('style')) {
    const text = style.textContent || '';
    if (text.trim()) chunks.push(text);
  }
  // 外链样式表（含 @import 展开后的规则），跨域跳过
  const extra = [];
  let sheets = [];
  try { sheets = [...doc.styleSheets]; } catch { sheets = []; }
  for (const sheet of sheets) {
    if (!sheet.href) continue;
    try {
      const rules = sheet.cssRules;
      for (const rule of rules) extra.push(rule.cssText);
    } catch {
      warnings.push('有外链样式表因跨域无法读取，已跳过：' + sheet.href);
    }
  }
  if (extra.length) chunks.push(extra.join('\n'));
  return chunks.join('\n');
}

/* ---------- 找页 / 激活 ---------- */

/**
 * 找页：`#stage > .slide, .slide, section[data-slide], #app section`，
 * 去重、去掉被其他候选包含的嵌套元素、按文档顺序排序。
 */
export function findSlideCandidates(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  const raw = [];
  try { raw.push(...doc.querySelectorAll('#stage > .slide')); } catch { /* ignore */ }
  try {
    for (const el of doc.querySelectorAll('.slide')) if (!raw.includes(el)) raw.push(el);
  } catch { /* ignore */ }
  try {
    for (const el of doc.querySelectorAll('section[data-slide]')) if (!raw.includes(el)) raw.push(el);
  } catch { /* ignore */ }
  if (!raw.length) {
    try {
      for (const el of doc.querySelectorAll('#app section')) if (!raw.includes(el)) raw.push(el);
    } catch { /* ignore */ }
  }
  const set = new Set(raw);
  const top = raw.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
  top.sort((a, b) => {
    try { return a.compareDocumentPosition(b) & 4 ? -1 : 1; } catch { return 0; }
  });
  return top;
}

function readLiveIndices(slides) {
  const primary = [];
  for (let i = 0; i < slides.length; i++) {
    const cl = slides[i].classList;
    if (!cl) continue;
    if (cl.contains('live') || cl.contains('is-active')) primary.push(i);
  }
  if (primary.length) return primary;
  const secondary = [];
  for (let i = 0; i < slides.length; i++) {
    const cl = slides[i].classList;
    if (!cl) continue;
    if (cl.contains('active') || cl.contains('current') || cl.contains('show')) secondary.push(i);
  }
  return secondary;
}

function computedVisibleIndices(win, slides) {
  const out = [];
  for (let i = 0; i < slides.length; i++) {
    try {
      const cs = win.getComputedStyle(slides[i]);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (parseFloat(cs.opacity || '0') > 0.05) out.push(i);
    } catch { /* ignore */ }
  }
  return out;
}

/** 当前 live 页索引（-1 表示识别不到） */
function liveIndexOf(win, doc, slides) {
  const idx = readLiveIndices(slides);
  if (idx.length) return idx[idx.length - 1];
  const vis = computedVisibleIndices(win, slides);
  if (vis.length) return vis[vis.length - 1];
  return -1;
}

function dispatchAdvanceKey(win, doc) {
  const init = {
    key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39,
    bubbles: true, cancelable: true, composed: true,
  };
  try {
    const Ev = win.KeyboardEvent || KeyboardEvent;
    doc.dispatchEvent(new Ev('keydown', init));
    doc.dispatchEvent(new Ev('keyup', init));
  } catch {
    try { doc.dispatchEvent(new Event('keydown')); } catch { /* ignore */ }
  }
}

async function waitActivated(win, doc, slides, index, timeoutMs) {
  const start = performance.now();
  let sawIndex = false;
  for (;;) {
    const idxs = readLiveIndices(slides);
    if (idxs.length === 1 && idxs[0] === index) return true;
    if (idxs.includes(index)) sawIndex = true;
    if (!idxs.length) {
      const vis = computedVisibleIndices(win, slides);
      if (vis.length === 1 && vis[0] === index) return true;
      if (vis.includes(index)) sawIndex = true;
    }
    if (performance.now() - start > timeoutMs) return sawIndex;
    await wait(40);
  }
}

function classActivate(slides, index) {
  slides.forEach((el, i) => {
    if (i === index) {
      el.classList.add('live');
      el.classList.add('active');
    } else {
      for (const c of STATE_CLASSES) el.classList.remove(c);
    }
  });
  try { void slides[index].offsetWidth; } catch { /* ignore */ }
}

/** 激活第 index 页：优先模拟键盘，失败回退类切换（并记录警告） */
async function activateSlide({ win, doc, slides, index, activation, warnings }) {
  const current = liveIndexOf(win, doc, slides);
  if (current === index) return;
  if (activation.mode === 'class') {
    classActivate(slides, index);
    await wait(60);
    return;
  }
  if (current > index) {
    classActivate(slides, index);
    activation.mode = 'class';
    warnings.push(`第 ${index + 1} 页需要后退激活，已切换为直接类切换模式`);
    await wait(60);
    return;
  }
  const timeout = activation.slow >= 3 ? 320 : KEY_WAIT_MS;
  let last = current;
  const maxTries = Math.min(10, Math.max(2, index - current + 2));
  for (let t = 0; t < maxTries; t++) {
    dispatchAdvanceKey(win, doc);
    const reached = await waitActivated(win, doc, slides, index, timeout);
    if (reached) {
      activation.slow = 0;
      return;
    }
    const now = liveIndexOf(win, doc, slides);
    if (now > index) break; // 已经越过目标页，交给类切换兜底
    if (now === last) {
      await wait(110);
      const again = liveIndexOf(win, doc, slides);
      if (again === last) break;
      last = again;
    } else {
      last = now;
    }
    activation.slow += 1;
  }
  classActivate(slides, index);
  activation.mode = 'class';
  warnings.push(`第 ${index + 1} 页无法通过键盘激活，已回退为直接类切换（该页动效内容可能不完整）`);
  await wait(80);
}

function finishAllAnimations(doc) {
  let anims = [];
  try { anims = doc.getAnimations ? doc.getAnimations() : []; } catch { return; }
  for (const anim of anims) {
    try { anim.finish(); } catch { /* 无限循环 / 已取消的动画会抛错，忽略 */ }
  }
}

/** 只结束当前页子树里的动画（比整篇 getAnimations 快很多，语义等价） */
function finishSlideAnimations(doc, slideEl) {
  let anims = [];
  try {
    if (slideEl && typeof slideEl.getAnimations === 'function') {
      anims = slideEl.getAnimations({ subtree: true }) || [];
    }
  } catch { anims = []; }
  if (!anims.length) { finishAllAnimations(doc); return; }
  for (const anim of anims) {
    try { anim.finish(); } catch { /* 忽略无限动画 */ }
  }
}

/* ---------- 单页捕获 ---------- */

function isCssAnimation(win, anim) {
  try { if (win.CSSAnimation && anim instanceof win.CSSAnimation) return true; } catch { /* ignore */ }
  try { if (win.CSSTransition && anim instanceof win.CSSTransition) return true; } catch { /* ignore */ }
  const name = anim && anim.constructor && anim.constructor.name;
  return name === 'CSSAnimation' || name === 'CSSTransition';
}

/* ---------- 原稿转场捕获：记录幻灯片切换期间创建在 slide 根节点上的 WAAPI 动画 ---------- */
function installTransitionRecorder(win) {
  try {
    if (!win || win.__wpxTransitionRecorder) return win.__wpxTransitionRecorder;
    const proto = win.Element && win.Element.prototype;
    if (!proto || typeof proto.animate !== 'function') return null;
    const recorder = { log: [], limit: 400 };
    const orig = proto.animate;
    proto.animate = function wpxRecordedAnimate(keyframes, options) {
      const anim = orig.call(this, keyframes, options);
      try {
        if (recorder.log.length < recorder.limit) recorder.log.push({ target: this, anim });
      } catch { /* ignore */ }
      return anim;
    };
    win.__wpxTransitionRecorder = recorder;
    return recorder;
  } catch {
    return null;
  }
}

/** 收集本次切换中创建在某个 slide 根节点上的动画快照 */
function collectSlideTransitionAnims(recorder, slideEl) {
  if (!recorder || !slideEl) return [];
  const out = [];
  for (const item of recorder.log) {
    if (item.target !== slideEl) continue;
    const snap = snapshotAnimation(item.anim);
    if (!snap || !snap.keyframes || !snap.keyframes.length) continue;
    out.push(snap);
    if (out.length >= 6) break;
  }
  return out;
}

function transitionDurationOf(records) {
  let max = 0;
  for (const rec of records) {
    const t = rec.timing || {};
    const d = (Number(t.delay) || 0) + (Number(t.duration) || 0);
    if (Number.isFinite(d) && d > max) max = d;
  }
  return max;
}

/** 从原稿 HUD 文案里猜测转场类型（很多动效 deck 会在角落显示 “SHUTTER · 快门” 之类） */
const TRANSITION_LABEL_MAP = [
  [/IRIS|圆形揭开|圆/i, 'iris'],
  [/BLIND|百叶/i, 'blinds'],
  [/SHUTTER|快门/i, 'shutter'],
  [/MOSAIC|马赛克/i, 'mosaic'],
  [/CLOCK|时钟/i, 'clock'],
  [/CURTAIN|幕布/i, 'curtain'],
  [/GLITCH|错位|故障/i, 'glitch'],
  [/SPLIT|对开|中缝/i, 'split'],
  [/FLIP|翻页|翻转/i, 'flipX'],
  [/ZOOM|推进|穿越/i, 'zoom'],
  [/MASK|遮罩/i, 'wipeUp'],
  [/DOT|收点/i, 'iris'],
  [/FLASH|闪切/i, 'dissolve'],
  [/SLIDE|推移/i, 'pushUp'],
  [/FADE|淡入/i, 'fade'],
];
function detectTransitionLabel(doc) {
  try {
    const nodes = doc.querySelectorAll('#tr,.tr,[class*="trchip"],[class*="transition"],[class*="hud"] span,[class*="hud"] div');
    for (const el of nodes) {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) continue;
      for (const [re, name] of TRANSITION_LABEL_MAP) {
        if (re.test(text)) return name;
      }
    }
  } catch { /* ignore */ }
  return '';
}

/** 给已捕获的 section 补上转场属性（out 动画要到下一页激活时才知道） */
function patchSectionTransitions(sectionHtml, trIn, trOut) {
  let html = String(sectionHtml || '');
  if (!html) return html;
  html = html.replace(/\sdata-wpx-tr-(?:in|out|duration)='[^']*'/g, '');
  const attrs = [];
  if (trIn && trIn.length) attrs.push(`data-wpx-tr-in='${escapeJsonAttr(JSON.stringify(trIn))}'`);
  if (trOut && trOut.length) attrs.push(`data-wpx-tr-out='${escapeJsonAttr(JSON.stringify(trOut))}'`);
  const dur = transitionDurationOf([...(trIn || []), ...(trOut || [])]);
  if (dur) attrs.push(`data-wpx-tr-duration="${Math.round(dur)}"`);
  if (!attrs.length) return html;
  const idx = html.indexOf('>');
  if (idx < 0) return html;
  return html.slice(0, idx) + ' ' + attrs.join(' ') + html.slice(idx);
}

function snapshotAnimation(anim) {
  try {
    const effect = anim.effect;
    if (!effect || typeof effect.getKeyframes !== 'function') return null;
    const rawFrames = effect.getKeyframes();
    if (!rawFrames || !rawFrames.length) return null;
    const keyframes = [];
    for (const frame of rawFrames) {
      const out = {};
      for (const key of Object.keys(frame)) {
        if (key === 'computedOffset') continue;
        if (key === 'offset') {
          if (typeof frame.offset === 'number' && Number.isFinite(frame.offset)) out.offset = frame.offset;
          continue;
        }
        const value = frame[key];
        if (value == null) continue;
        out[key] = typeof value === 'number' || typeof value === 'string' ? value : String(value);
      }
      keyframes.push(out);
    }
    return { keyframes, timing: normalizeTiming(effect.getTiming(), anim) };
  } catch {
    return null;
  }
}

function cleanRootInlineStyle(clone) {
  const raw = clone.getAttribute('style');
  if (!raw) return;
  const kept = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((decl) => {
      const name = decl.split(':')[0].trim().toLowerCase();
      return !ROOT_TRANSIENT_PROPS.includes(name);
    });
  if (kept.length) clone.setAttribute('style', kept.join('; '));
  else clone.removeAttribute('style');
}

function stripEditorArtifacts(root) {
  const all = [root, ...root.querySelectorAll('*')];
  for (const el of all) {
    if (!el.attributes) continue;
    for (const attr of [...el.attributes]) {
      const name = attr.name;
      if (name === 'data-page-node-id' || name === 'data-node-id') el.removeAttribute(name);
      if (name === 'contenteditable' || name === 'spellcheck') el.removeAttribute(name);
    }
  }
}

/** 捕获单页：克隆 DOM + WAAPI 快照 → section HTML */
function captureSlide({ win, doc, slideEl, index, warnings, trIn = [], trOut = [], transition = 'fade' }) {
  const clone = slideEl.cloneNode(true);
  clone.setAttribute('class', sanitizeSlideClasses(slideEl.getAttribute('class') || '') || 'slide');
  cleanRootInlineStyle(clone);
  stripEditorArtifacts(clone);

  const origEls = [slideEl, ...slideEl.querySelectorAll('*')];
  const cloneEls = [clone, ...clone.querySelectorAll('*')];
  const entries = [];
  let animSeq = 0;
  let jsonSize = 0;
  let skippedByLimit = false;

  for (let i = 0; i < origEls.length; i += 1) {
    if (animSeq >= MAX_ANIMS_PER_PAGE) { skippedByLimit = true; break; }
    const el = origEls[i];
    const cloneEl = cloneEls[i];
    if (!cloneEl) continue;
    let anims = [];
    try { anims = el.getAnimations ? el.getAnimations() : []; } catch { continue; }
    if (!anims.length) continue;
    const waapi = [];
    for (const anim of anims) {
      if (isCssAnimation(win, anim)) continue;
      const snap = snapshotAnimation(anim);
      if (snap) waapi.push(snap);
    }
    if (!waapi.length) continue;
    // 根节点上的 WAAPI 多为原稿转场残留（原稿页面切换动画），跳过不采集
    if (i === 0) continue;
    for (const snap of waapi) {
      if (animSeq >= MAX_ANIMS_PER_PAGE) { skippedByLimit = true; break; }
      animSeq += 1;
      const id = 'a' + animSeq;
      if (!cloneEl.hasAttribute('data-wpx-anim-id')) cloneEl.setAttribute('data-wpx-anim-id', id);
      const animId = cloneEl.getAttribute('data-wpx-anim-id');
      const entry = {
        sel: `:scope [data-wpx-anim-id="${animId}"]`,
        keyframes: snap.keyframes,
        timing: snap.timing,
      };
      const size = JSON.stringify(entry).length;
      if (jsonSize + size > MAX_WAAPI_JSON) { skippedByLimit = true; break; }
      jsonSize += size;
      entries.push(entry);
    }
    if (skippedByLimit) break;
  }
  if (skippedByLimit) warnings.push(`第 ${index + 1} 页动画快照较多，已截断至 ${entries.length} 条`);

  const waapiJson = entries.length ? JSON.stringify(entries) : '';
  const trInJson = trIn && trIn.length ? JSON.stringify(trIn) : '';
  const trOutJson = trOut && trOut.length ? JSON.stringify(trOut) : '';
  const trDuration = transitionDurationOf([...(trIn || []), ...(trOut || [])]);
  const section = buildSlideSection({
    index,
    name: `第${index + 1}页`,
    canvasClass: slideEl.getAttribute('class') || 'slide',
    innerHtml: clone.innerHTML,
    waapiJson,
    transition,
    trInJson,
    trOutJson,
    trDuration,
  });
  return { section, anims: entries.length, transitions: (trIn ? trIn.length : 0) + (trOut ? trOut.length : 0) };
}

/* ---------- 主题采样 ---------- */

function sampleSourceTheme(win, doc, slides, importedCss) {
  const read = (el, prop) => {
    if (!el) return '';
    try { return (win.getComputedStyle(el).getPropertyValue(prop) || '').trim(); } catch { return ''; }
  };
  const first = slides[0] || doc.body;
  let bg = read(first, 'background-color');
  if (!bg || (parseColor(bg) && parseColor(bg).a === 0)) bg = read(doc.body, 'background-color');
  if (!bg || (parseColor(bg) && parseColor(bg).a === 0)) bg = read(doc.documentElement, 'background-color');
  if (!bg || (parseColor(bg) && parseColor(bg).a === 0)) bg = '#0A0A0B';
  const heading = first.querySelector('h1,h2,h3,h4,.title,.h1') || first.querySelector('.txt p,.sub,.desc') || first;
  let fg = read(heading, 'color');
  if (!fg) fg = read(doc.body, 'color');
  if (!fg) fg = '#F2EAE0';
  let accent = '';
  for (const name of ACCENT_VARS) {
    const v = read(doc.documentElement, name);
    if (v && parseColor(v)) { accent = v; break; }
  }
  if (!accent) {
    const accentEl = first.querySelector('.ruleB,.accent,[data-accent],[class*="accent"],[class*="rule"]');
    const v = read(accentEl, 'background-color');
    if (v && parseColor(v) && parseColor(v).a > 0.1) accent = v;
  }
  if (!accent) accent = '#E1402B';
  const serif = extractCssVar(importedCss, SERIF_VARS) || read(heading, 'font-family') || DEFAULT_SERIF;
  const sans = extractCssVar(importedCss, SANS_VARS) || read(doc.body, 'font-family') || DEFAULT_SANS;
  const latin = extractCssVar(importedCss, LATIN_VARS) || DEFAULT_LATIN;
  return themeFromSamples({ bg, fg, accent, serif, sans, latin });
}

/* ==========================================================================
   进度浮层 / 报告浮层
   ========================================================================== */

function overlayRoot() { return document.body; }

function makeOverlay(className) {
  const wrap = h('div', { class: 'cv-overlay ' + (className || '') });
  return wrap;
}

function closeOverlayWithAnim(wrap) {
  if (!wrap || !wrap.isConnected) return;
  const anim = wrap.animate?.(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(.99)' }],
    { duration: 170, easing: 'ease-out', fill: 'both' },
  );
  const done = () => wrap.remove();
  if (anim && anim.finished) anim.finished.then(done).catch(done);
  else done();
}

function openProgressOverlay({ project }) {
  let canceled = false;
  const pctEl = h('span', { class: 'cv-pct' }, '0%');
  const fillEl = h('i', { class: 'cv-bar-fill' });
  const stepEl = h('div', { class: 'cv-step' }, '准备转换…');
  const detailEl = h('div', { class: 'cv-detail' }, '正在读取原稿');
  const pagesEl = h('div', { class: 'cv-pages' }, '');
  const cancelBtn = h('button', { class: 'btn btn--ghost cv-cancel' }, '取消转换');
  const card = h('div', {
    class: 'cv-card cv-card--progress', role: 'dialog', 'aria-modal': 'true', 'aria-label': '正在转换原稿',
  },
  h('div', { class: 'cv-head' },
    h('span', { class: 'cv-head-icon', html: icon('wand', 18) }),
    h('div', { class: 'grow' },
      h('div', { class: 'cv-title' }, '正在转换为可编辑工程'),
      h('div', { class: 'cv-sub' }, project?.name || '导入的演示'))),
  h('div', { class: 'cv-big' }, pctEl),
  h('div', { class: 'cv-bar' }, fillEl),
  stepEl,
  detailEl,
  pagesEl,
  h('div', { class: 'cv-progress-foot' },
    h('div', { class: 'cv-hint' }, '逐页捕获原稿 DOM / CSS / WAAPI 动画，页数较多时请耐心等待；转换可随时取消，原稿会保留。'),
    cancelBtn),
  );
  const wrap = makeOverlay('cv-overlay--progress');
  wrap.appendChild(card);
  overlayRoot().appendChild(wrap);

  const setCanceled = () => {
    if (canceled) return;
    canceled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = '正在取消…';
    stepEl.textContent = '正在取消…';
  };
  cancelBtn.addEventListener('click', setCanceled);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setCanceled();
    }
  };
  document.addEventListener('keydown', onKey, true);

  return {
    isCanceled: () => canceled,
    update({ percent = 0, text = '', detail = '' } = {}) {
      const p = Math.max(0, Math.min(100, Math.round(percent)));
      pctEl.textContent = p + '%';
      fillEl.style.width = p + '%';
      if (text) stepEl.textContent = text;
      detailEl.textContent = detail || '';
      if (/第\s*\d+\s*\/\s*\d+\s*页/.test(text)) pagesEl.textContent = '';
      wrap.classList.toggle('is-near', p > 90);
    },
    close() {
      document.removeEventListener('keydown', onKey, true);
      closeOverlayWithAnim(wrap);
    },
  };
}

function openReportOverlay({ project, report, error, canceled }) {
  const id = project?.id;
  const ok = Boolean(report && report.ok && !canceled && !error);
  const warnings = report?.warnings || [];
  const headIcon = canceled ? 'info' : ok ? 'check-circle' : 'alert';
  const title = canceled ? '已取消转换' : ok ? '转换完成' : '转换未完成';
  const sub = canceled
    ? '原稿已保留，可稍后在工程卡片中重新转换。'
    : ok
      ? `${report.slides} 页 · ${report.animations} 个动画快照 · ${report.transitions || 0} 个原稿转场 · 耗时 ${(report.durationMs / 1000).toFixed(1)}s`
      : (error || '转换过程中出现问题，原稿已保留。');

  const stats = ok
    ? h('div', { class: 'cv-stats' },
      statCell('页数', String(report.slides)),
      statCell('动画快照', String(report.animations)),
      statCell('原稿转场', String(report.transitions || 0)),
      statCell('耗时', (report.durationMs / 1000).toFixed(1) + 's'),
      statCell('deck 体积', formatBytes(report.htmlSize)),
      statCell('主题', report.theme || 'ink'))
    : null;

  const runtimeTip = ok && report.runtimeMissing
    ? h('div', { class: 'cv-warnline' }, '运行时资源缺失：当前 deck 还不能放映，请稍后点「重新转换」。')
    : null;

  const warnList = warnings.length
    ? h('div', { class: 'cv-warnings' },
      h('div', { class: 'cv-warnings-title' }, `警告 · ${warnings.length} 条`),
      ...warnings.slice(0, 10).map((w) => h('div', { class: 'cv-warning-item' }, w)),
      warnings.length > 10 ? h('div', { class: 'cv-warning-item dim' }, `还有 ${warnings.length - 10} 条警告…`) : null)
    : null;

  const buttons = [];
  const close = () => closeOverlayWithAnim(wrap);
  if (ok) {
    buttons.push(h('button', { class: 'btn btn--ghost', onclick: close }, '稍后'));
    if (project?.hasOriginal) {
      buttons.push(h('button', {
        class: 'btn',
        onclick: () => { try { window.open(`/p/${encodeURIComponent(id)}/original/index.html`, '_blank', 'noopener'); } catch { /* ignore */ } },
      }, '放映原稿'));
    }
    buttons.push(h('button', {
      class: 'btn btn--primary',
      onclick: () => {
        close();
        location.hash = '#/p/' + encodeURIComponent(id);
      },
    }, '打开编辑器'));
  } else {
    buttons.push(h('button', { class: 'btn btn--ghost', onclick: close }, '关闭'));
    if (project?.hasOriginal) {
      buttons.push(h('button', {
        class: 'btn',
        onclick: () => { try { window.open(`/p/${encodeURIComponent(id)}/original/index.html`, '_blank', 'noopener'); } catch { /* ignore */ } },
      }, '放映原稿'));
    }
    buttons.push(h('button', {
      class: 'btn btn--accent',
      onclick: () => {
        close();
        runConvertFlow({ project });
      },
    }, '重新转换'));
  }

  const card = h('div', {
    class: `cv-card cv-card--report ${ok ? 'is-ok' : canceled ? 'is-canceled' : 'is-error'}`,
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
  },
  h('div', { class: 'cv-head' },
    h('span', { class: `cv-head-icon ${ok ? 'is-ok' : canceled ? 'is-muted' : 'is-error'}`, html: icon(headIcon, 20) }),
    h('div', { class: 'grow' },
      h('div', { class: 'cv-title' }, title),
      h('div', { class: 'cv-sub' }, sub))),
  stats,
  runtimeTip,
  warnList,
  h('div', { class: 'cv-report-foot' }, ...buttons),
  );
  const wrap = makeOverlay('cv-overlay--report');
  wrap.appendChild(card);
  overlayRoot().appendChild(wrap);
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('keydown', onKey, true);
      closeOverlayWithAnim(wrap);
    }
  };
  document.addEventListener('keydown', onKey, true);
}

function statCell(label, value) {
  return h('div', { class: 'cv-stat' },
    h('b', null, value),
    h('span', null, label));
}

/* ---------- 小工具 ---------- */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
