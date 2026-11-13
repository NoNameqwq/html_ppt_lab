/**
 * WebDeck Studio · 本地服务
 * 零依赖 Node HTTP 服务：静态资源 + 工程文件管理 + 导入 + 缩略图 + AI 代理（DeepSeek / OpenCode Go）
 * 启动：node server.mjs   默认 http://127.0.0.1:4321
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(ROOT, 'app');
const EDITOR_DIR = path.join(ROOT, 'editor');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const SKILLS_DIR = path.join(ROOT, 'skills');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const DATA_DIR = path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const MODELS_CACHE_FILE = path.join(DATA_DIR, 'models-dev.json');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const VERSION = '1.0.0';
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
};

const DEFAULT_PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY', apiKey: '', model: 'deepseek-chat', models: [], wire: 'openai',
  },
  {
    id: 'opencode', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1',
    keyEnv: 'OPENCODE_GO_API_KEY', apiKey: '', model: '', models: [], wire: 'auto',
  },
];

/* ==========================================================================
   基础工具
   ========================================================================== */
const log = (...args) => console.log('[wds]', ...args);
const now = () => Date.now();
const enc = encodeURIComponent;

async function ensureDirs() {
  for (const d of [PROJECTS_DIR, DATA_DIR, SAMPLES_DIR, SKILLS_DIR, TEMPLATES_DIR]) {
    await fs.mkdir(d, { recursive: true });
  }
  if (!(await exists(SETTINGS_FILE))) await writeJson(SETTINGS_FILE, defaultSettings());
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
}
function defaultSettings() {
  return {
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })),
    ui: { theme: 'light' },
    agent: { temperature: 0.7, contextLimit: 100000000, maxTokens: 0, streaming: true },
    search: { provider: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com', maxResults: 5 },
  };
}
function genId(name = 'deck') {
  const slug = String(name || 'deck').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'deck';
  return `${slug}-${crypto.randomBytes(3).toString('hex')}`;
}
function countSlides(html) {
  return (String(html).match(/<section\b[^>]*class\s*=\s*["'][^"']*\bwpx-slide\b[^"']*["']/gi) || []).length;
}
/** 兼容模式：统计任意 .slide 元素（静态原稿），动态生成的返回 0 */
function countAnySlides(html) {
  const a = countSlides(html);
  if (a) return a;
  return (String(html).match(/class\s*=\s*["'][^"']*\bslide\b[^"']*["']/gi) || []).length;
}
function safeRel(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const norm = path.posix.normalize(clean);
  if (norm.startsWith('..') || norm.includes('/../')) throw new Error('非法路径');
  return norm;
}
function within(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, status, message, detail) {
  json(res, status, { error: { code: status, message, detail } });
}
async function readBody(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/* ==========================================================================
   工程
   ========================================================================== */
function projectDir(id) {
  const dir = path.join(PROJECTS_DIR, id);
  if (!within(PROJECTS_DIR, dir)) throw Object.assign(new Error('非法工程 id'), { status: 400 });
  return dir;
}
async function readProject(id) {
  const dir = projectDir(id);
  const meta = await readJson(path.join(dir, 'project.json'));
  if (!meta) return null;
  const indexFile = path.join(dir, 'index.html');
  let stat = null;
  try { stat = await fs.stat(indexFile); } catch { /* ignore */ }
  let slideCount = meta.slideCount;
  if (!slideCount && stat) {
    try { slideCount = countSlides(await fs.readFile(indexFile, 'utf8')); } catch { /* ignore */ }
  }
  return {
    ...meta,
    id,
    slideCount: slideCount || 0,
    size: stat?.size || 0,
    updatedAt: meta.updatedAt || stat?.mtimeMs || now(),
    hasOriginal: await exists(path.join(dir, 'original', 'index.html')),
  };
}
async function listProjects() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = await readProject(e.name).catch(() => null);
    if (p) out.push(p);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

const INLINE_RUNTIME_CACHE = new Map();
async function runtimeAssets() {
  if (INLINE_RUNTIME_CACHE.size) return Object.fromEntries(INLINE_RUNTIME_CACHE);
  const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return ''; } };
  const [css, fx, rt] = await Promise.all([
    read(path.join(EDITOR_DIR, 'deck-runtime.css')),
    read(path.join(EDITOR_DIR, 'fx-presets.js')),
    read(path.join(EDITOR_DIR, 'deck-runtime.js')),
  ]);
  INLINE_RUNTIME_CACHE.set('css', css);
  INLINE_RUNTIME_CACHE.set('fx', fx);
  INLINE_RUNTIME_CACHE.set('runtime', rt);
  return { css, fx, runtime: rt };
}
function invalidateRuntimeCache() { INLINE_RUNTIME_CACHE.clear(); }

async function buildDeckFromTemplate(templateId) {
  const dir = path.join(TEMPLATES_DIR, templateId || 'blank');
  let html = null;
  try { html = await fs.readFile(path.join(dir, 'index.html'), 'utf8'); } catch { html = null; }
  if (!html) html = fallbackDeck(templateId);
  const rt = await runtimeAssets();
  html = html.replace(/<link\b[^>]*data-wpx-inline=["']css["'][^>]*>/i, () => `<style id="wpx-runtime-css">${rt.css}</style>`);
  html = html.replace(/<script\b[^>]*src=["'][^"']*fx-presets\.js["'][^>]*>\s*<\/script>/i, () => `<script id="wpx-fx">${rt.fx}</script>`);
  html = html.replace(/<script\b[^>]*src=["'][^"']*deck-runtime\.js["'][^>]*>\s*<\/script>/i, () => `<script id="wpx-runtime">${rt.runtime}</script>`);
  if (!/id=["']wpx-runtime["']/.test(html)) {
    html = html.replace('</body>', () => `<style id="wpx-runtime-css">${rt.css}</style>\n<script id="wpx-fx">${rt.fx}</script>\n<script id="wpx-runtime">${rt.runtime}</script>\n</body>`);
  }
  return html;
}

function fallbackDeck(templateId) {
  if (templateId === 'blank') {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>空白演示</title>
<style id="wpx-theme">:root{--wpx-bg:#FFFFFF;--wpx-fg:#111113;--wpx-fg-2:#3F3F46;--wpx-muted:#8A8A90;--wpx-accent:#D92B1E;--wpx-accent-2:#1F6F68;--wpx-line:#E4E4E7;--wpx-serif:"Songti SC","Source Han Serif SC","Noto Serif SC",SimSun,serif;--wpx-sans:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;--wpx-latin:"Inter","Helvetica Neue",Arial,sans-serif}</style>
<link rel="stylesheet" href="/editor/deck-runtime.css" data-wpx-inline="css">
</head><body class="wpx-body" data-wpx-grain="off" data-wpx-vignette="off">
<div id="wpx-app" data-w="1920" data-h="1080"><div id="wpx-stage">
<section class="wpx-slide" data-id="s1" data-name="空白页" data-transition="fade" data-bg="#FFFFFF"><div class="wpx-canvas"></div></section>
</div><div class="wpx-hud" aria-hidden="true"></div></div>
<script type="application/json" id="wpx-data">${JSON.stringify({ title: '空白演示', w: 1920, h: 1080, theme: 'mono', slides: [{ id: 's1', name: '空白页', transition: 'fade' }] })}</script>
<script src="/editor/fx-presets.js" data-wpx-inline="js"></script>
<script src="/editor/deck-runtime.js" data-wpx-inline="js"></script>
</body></html>`;
  }
  const titles = {
    blank: ['未命名演示', '开始创作', '谢谢观看'],
    ink: ['墨韵', '骨白与朱砂', '谢谢观看'],
    bloom: ['繁花', '绽放的时刻', '谢谢观看'],
    minimal: ['简洁演示', '少即是多', '谢谢观看'],
  }[templateId] || ['未命名演示', '第二页', '谢谢观看'];
  const slides = titles.map((t, i) => `
    <section class="wpx-slide" data-id="s${i + 1}" data-name="${t}" data-transition="fade" data-bg="#0A0A0B">
      <div class="wpx-canvas">
        <div class="wpx-el wpx-text" data-wpx-el="e${i * 10 + 1}" data-wpx-anim="fadeUp" data-wpx-anim-params='{"delay":80,"duration":900}'
             style="left:140px;top:360px;width:1200px;font:400 140px/1.15 var(--wpx-serif);letter-spacing:2px;color:var(--wpx-fg)">${t}</div>
        <div class="wpx-el wpx-shape" data-wpx-el="e${i * 10 + 2}" data-wpx-anim="underlineGrow"
             style="left:144px;top:560px;width:280px;height:2px;background:var(--wpx-accent)"></div>
      </div>
    </section>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${titles[0]}</title>
<style id="wpx-theme">:root{--wpx-bg:#0A0A0B;--wpx-fg:#F2EAE0;--wpx-fg-2:#C9C1B6;--wpx-muted:#8A8A90;--wpx-accent:#E1402B;--wpx-accent-2:#2C6E68;--wpx-line:rgba(242,234,224,.18);--wpx-serif:"Songti SC","Source Han Serif SC","Noto Serif SC",SimSun,serif;--wpx-sans:"PingFang SC","Helvetica Neue","Microsoft YaHei",sans-serif;--wpx-latin:"Inter","Helvetica Neue",Arial,sans-serif}</style>
<link rel="stylesheet" href="/editor/deck-runtime.css" data-wpx-inline="css">
</head><body class="wpx-body">
<div id="wpx-app" data-w="1920" data-h="1080"><div id="wpx-stage">${slides}</div><div class="wpx-hud" aria-hidden="true"></div></div>
<script type="application/json" id="wpx-data">${JSON.stringify({ title: titles[0], w: 1920, h: 1080, theme: 'ink', slides: titles.map((t, i) => ({ id: 's' + (i + 1), name: t, transition: 'fade' })) })}</script>
<script src="/editor/fx-presets.js" data-wpx-inline="js"></script>
<script src="/editor/deck-runtime.js" data-wpx-inline="js"></script>
</body></html>`;
}

async function createProject({ name, templateId = 'blank' }) {
  const tplMeta = await readJson(path.join(TEMPLATES_DIR, templateId, 'template.json'), {});
  const finalName = String(name || tplMeta.name || '未命名演示').trim().slice(0, 80);
  const id = genId(finalName);
  const dir = projectDir(id);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'original'), { recursive: true });
  await fs.mkdir(path.join(dir, '.versions'), { recursive: true });
  const html = await buildDeckFromTemplate(templateId);
  await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
  const ts = now();
  const project = {
    id, name: finalName, kind: 'native',
    createdAt: ts, updatedAt: ts,
    slideCount: countSlides(html) || 1,
    theme: tplMeta.theme || 'ink',
    cover: tplMeta.cover?.bg || '#1B1A17',
    coverFg: tplMeta.cover?.fg || '#F2EAE0',
    coverAccent: tplMeta.cover?.accent || '#E1402B',
    origin: { template: templateId },
    hasOriginal: false,
  };
  await writeJson(path.join(dir, 'project.json'), project);
  await writeJson(path.join(dir, '.history.json'), { ops: [], updatedAt: ts });
  await writeJson(path.join(dir, '.chat.json'), { messages: [], skills: [], updatedAt: ts });
  log('创建工程', id, project.name);
  return project;
}

/** 从 HTML 中提取本地资源引用 */
function extractAssetRefs(html) {
  const refs = new Set();
  const push = (raw) => {
    if (!raw) return;
    const v = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!v || v.startsWith('data:') || v.startsWith('http:') || v.startsWith('https:') || v.startsWith('//') || v.startsWith('#') || v.startsWith('/')) return;
    refs.add(v);
  };
  for (const m of html.matchAll(/(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/url\(\s*([^)]+?)\s*\)/gi)) push(m[1]);
  return [...refs];
}

async function importProject({ fileName, content, sourcePath, sampleId, name, mode }) {
  const rawMode = mode === 'raw';
  let html = '';
  let baseDir = null;
  let originFile = '';
  let sampleMeta = null;
  if (sampleId) {
    const dir = path.join(SAMPLES_DIR, sampleId);
    originFile = path.join(dir, 'index.html');
    html = await fs.readFile(originFile, 'utf8');
    baseDir = dir;
    sampleMeta = await readJson(path.join(dir, 'sample.json'), null);
  } else if (sourcePath) {
    const abs = path.resolve(sourcePath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) throw Object.assign(new Error('找不到文件: ' + sourcePath), { status: 404 });
    if (stat.size > 20 * 1024 * 1024) throw Object.assign(new Error('文件过大（>20MB）'), { status: 413 });
    html = await fs.readFile(abs, 'utf8');
    baseDir = path.dirname(abs);
    originFile = abs;
  } else if (content) {
    html = String(content);
  } else {
    throw Object.assign(new Error('缺少导入内容'), { status: 400 });
  }
  if (!html || html.length < 50) throw Object.assign(new Error('HTML 内容为空'), { status: 400 });
  const rawName = name || sampleMeta?.name || (fileName ? fileName.replace(/\.html?$/i, '') : null) || (originFile ? path.basename(originFile, '.html') : '导入的演示');
  const finalName = String(rawName).trim().slice(0, 80) || '导入的演示';
  const id = genId(finalName);
  const dir = projectDir(id);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(dir, 'original'), { recursive: true });
  await fs.mkdir(path.join(dir, '.versions'), { recursive: true });

  const copied = [];
  const rewrites = [];
  if (baseDir) {
    let total = 0;
    for (const ref of extractAssetRefs(html)) {
      const clean = ref.split('?')[0].split('#')[0];
      let srcAbs;
      try { srcAbs = path.resolve(baseDir, decodeURIComponent(clean)); } catch { continue; }
      if (!within(baseDir, srcAbs) && !within(path.dirname(baseDir), srcAbs)) continue;
      let stat = null;
      try { stat = await fs.stat(srcAbs); } catch { continue; }
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) continue;
      total += stat.size;
      if (total > 60 * 1024 * 1024) break;
      const rel = within(baseDir, srcAbs)
        ? path.relative(baseDir, srcAbs)
        : path.join('assets', '_imported', crypto.createHash('md5').update(srcAbs).digest('hex').slice(0, 8) + '-' + path.basename(srcAbs));
      const relPosix = rel.split(path.sep).join('/');
      for (const targetBase of [dir, path.join(dir, 'original')]) {
        const target = path.join(targetBase, relPosix);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(srcAbs, target);
      }
      copied.push(relPosix);
      if (!within(baseDir, srcAbs)) rewrites.push([ref, relPosix]);
    }
    for (const [from, to] of rewrites) html = html.split(from).join(to);
  }
  await fs.writeFile(path.join(dir, 'original', 'index.html'), html, 'utf8');
  if (rawMode) {
    // 兼容模式：index.html 就是可编辑原稿（保留原 script/style/运行时，放映/编辑都不丢动效）
    await fs.writeFile(path.join(dir, 'index.html'), html, 'utf8');
  }

  const ts = now();
  const rawSlideCount = rawMode ? (sampleMeta?.slides || countAnySlides(html) || 0) : 0;
  const project = {
    id, name: finalName, kind: rawMode ? 'raw' : 'imported',
    createdAt: ts, updatedAt: ts,
    slideCount: rawSlideCount, theme: 'ink', cover: '#1B1A17', coverFg: '#F2EAE0', coverAccent: '#E1402B',
    origin: { file: originFile || fileName || '', from: sampleId ? 'sample' : 'import', copiedAssets: copied.length },
    hasOriginal: true,
  };
  await writeJson(path.join(dir, 'project.json'), project);
  await writeJson(path.join(dir, '.history.json'), { ops: [], updatedAt: ts });
  await writeJson(path.join(dir, '.chat.json'), { messages: [], skills: [], updatedAt: ts });
  log('导入工程', id, finalName, '资源', copied.length);
  return project;
}

async function duplicateProject(id) {
  const src = projectDir(id);
  const meta = await readProject(id);
  if (!meta) throw Object.assign(new Error('工程不存在'), { status: 404 });
  const newName = meta.name + ' 副本';
  const newId = genId(newName);
  const dst = projectDir(newId);
  await fs.cp(src, dst, { recursive: true, filter: (s) => !s.includes(path.sep + '.versions') });
  const newMeta = { ...meta, id: newId, name: newName, createdAt: now(), updatedAt: now() };
  await writeJson(path.join(dst, 'project.json'), newMeta);
  return newMeta;
}

async function saveVersion(dir) {
  try {
    const indexFile = path.join(dir, 'index.html');
    if (!(await exists(indexFile))) return;
    const vdir = path.join(dir, '.versions');
    await fs.mkdir(vdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(indexFile, path.join(vdir, stamp + '.html'));
    const files = (await fs.readdir(vdir)).filter((f) => f.endsWith('.html')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 30))) await fs.rm(path.join(vdir, old), { force: true });
  } catch (err) { log('版本备份失败', err.message); }
}

/* ==========================================================================
   运行时升级：把工程内联的 deck-runtime / fx-presets / runtime-css 换成最新版
   （保留工程 DOM 与历史；让旧工程获得新的动效 / 转场能力）
   ========================================================================== */
function extractInlineBlock(html, tag, id) {
  const re = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : null;
}
async function upgradeProjectRuntime(id) {
  const dir = projectDir(id);
  const file = path.join(dir, 'index.html');
  const html = await fs.readFile(file, 'utf8').catch(() => null);
  if (html == null) throw Object.assign(new Error('工程文件不存在'), { status: 404 });
  const rt = await runtimeAssets();
  if (!rt.runtime || !rt.css || !rt.fx) return { ok: false, error: '运行时资源缺失' };
  const curCss = extractInlineBlock(html, 'style', 'wpx-runtime-css');
  const curFx = extractInlineBlock(html, 'script', 'wpx-fx');
  const curRt = extractInlineBlock(html, 'script', 'wpx-runtime');
  if (curCss == null || curRt == null) return { ok: true, changed: false, reason: 'no-inline-runtime' };
  if (curCss === rt.css && curRt === rt.runtime && (curFx == null || curFx === rt.fx)) {
    return { ok: true, changed: false };
  }
  const safe = (text) => String(text || '').replace(/<\/(script|style)/gi, '<\\/$1');
  // 注意：replace 的替换串里 $$ 会被当作转义 $，必须用函数形式返回，否则运行时源码里的 `$$` 会被改坏
  const nextHtml = html
    .replace(/<style\b[^>]*\bid=["']wpx-runtime-css["'][^>]*>[\s\S]*?<\/style>/i, () => `<style id="wpx-runtime-css">${safe(rt.css)}</style>`)
    .replace(/<script\b[^>]*\bid=["']wpx-fx["'][^>]*>[\s\S]*?<\/script>/i, () => `<script id="wpx-fx">${safe(rt.fx)}</script>`)
    .replace(/<script\b[^>]*\bid=["']wpx-runtime["'][^>]*>[\s\S]*?<\/script>/i, () => `<script id="wpx-runtime">${safe(rt.runtime)}</script>`);
  await saveVersion(dir);
  await fs.writeFile(file, nextHtml, 'utf8');
  const project = await readProject(id);
  if (project) {
    project.updatedAt = now();
    project.runtimeUpdatedAt = now();
    await writeJson(path.join(dir, 'project.json'), project);
  }
  log('升级运行时', id, Buffer.byteLength(nextHtml), 'bytes');
  return { ok: true, changed: true, size: Buffer.byteLength(nextHtml) };
}

/* ==========================================================================
   设置 / 技能 / 模板 / 示例
   ========================================================================== */async function getSettings() {
  const settings = (await readJson(SETTINGS_FILE, null)) || defaultSettings();
  const merged = defaultSettings();
  merged.ui = { ...merged.ui, ...(settings.ui || {}) };
  merged.agent = { ...merged.agent, ...(settings.agent || {}) };
  const byId = new Map((settings.providers || []).map((p) => [p.id, p]));
  for (const def of merged.providers) {
    const saved = byId.get(def.id);
    if (saved) Object.assign(def, saved);
  }
  for (const p of settings.providers || []) {
    if (!merged.providers.find((x) => x.id === p.id)) merged.providers.push(p);
  }
  return merged;
}
function publicProvider(p) {
  const envKey = p.keyEnv ? process.env[p.keyEnv] : '';
  const settingsKey = p.apiKey || '';
  const key = settingsKey || envKey || '';
  return {
    id: p.id, name: p.name, baseUrl: p.baseUrl, keyEnv: p.keyEnv, wire: p.wire || 'openai',
    model: p.model || '', models: p.models || [],
    keySet: Boolean(key),
    keySource: settingsKey ? 'settings' : envKey ? 'env' : null,
    masked: key ? key.slice(0, 3) + '…' + key.slice(-4) : '',
  };
}
async function getPublicSettings() {
  const settings = await getSettings();
  return {
    providers: settings.providers.map(publicProvider),
    ui: settings.ui,
    agent: settings.agent,
    search: publicSearchSettings(settings),
    skillsCatalog: await listSkills(),
  };
}

function searchApiKey(search, settings) {
  const s = search || {};
  if (s.apiKey) return s.apiKey;
  if (s.provider === 'tavily') return process.env.TAVILY_API_KEY || '';
  if (s.provider === 'deepseek' || !s.provider) {
    const p = (settings.providers || []).find((x) => x.id === 'deepseek');
    return p ? providerKey(p) : (process.env.DEEPSEEK_API_KEY || '');
  }
  return '';
}

function publicSearchSettings(settings) {
  const s = settings.search || {};
  const key = searchApiKey(s, settings);
  return {
    provider: s.provider || 'deepseek',
    baseUrl: s.baseUrl || (s.provider === 'tavily' ? 'https://api.tavily.com' : 'https://api.deepseek.com'),
    maxResults: Number(s.maxResults) || 5,
    keySet: Boolean(key),
    keySource: s.apiKey ? 'settings' : (key ? 'env/provider' : null),
    masked: key ? key.slice(0, 3) + '…' + key.slice(-4) : '',
  };
}

async function handleSearch(body = {}) {
  const settings = await getSettings();
  const cfg = settings.search || {};
  const provider = cfg.provider === 'tavily' ? 'tavily' : 'deepseek';
  const query = String(body.query || '').trim();
  if (!query) throw Object.assign(new Error('缺少搜索词 query'), { status: 400 });
  const count = Math.min(20, Math.max(1, Number(body.count || cfg.maxResults || 5)));
  const key = searchApiKey(cfg, settings);
  if (!key) throw Object.assign(new Error('未配置搜索 API Key，请在「联网搜索设置」中填写'), { status: 400 });
  let url;
  let payload;
  let headers;
  if (provider === 'tavily') {
    const base = String(cfg.baseUrl || 'https://api.tavily.com').replace(/\/+$/, '');
    url = base + '/search';
    payload = { api_key: key, query, max_results: count, search_depth: 'basic', include_answer: false };
    headers = { 'Content-Type': 'application/json' };
  } else {
    const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    url = /\/v1$/.test(base) ? base + '/tools/search' : base + '/v1/tools/search';
    payload = { query, count, need_content: true };
    headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
  }
  let upstream;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    clearTimeout(timer);
  } catch (err) {
    throw Object.assign(new Error('连接搜索服务失败: ' + err.message), { status: 502 });
  }
  const text = await upstream.text().catch(() => '');
  if (!upstream.ok) {
    throw Object.assign(new Error(`搜索服务返回 ${upstream.status}`), { status: 502, detail: text.slice(0, 1200) });
  }
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('搜索服务返回非 JSON'), { status: 502 }); }
  const arr = Array.isArray(data.results) ? data.results : [];
  const results = arr.slice(0, count).map((r) => ({
    title: String(r.title || ''),
    url: String(r.url || ''),
    snippet: String(r.snippet || r.summary || r.content || '').slice(0, 600),
    content: String(r.content || r.summary || '').slice(0, 2000),
    site: r.site_name || r.site || '',
    date: r.date || '',
    score: r.rerank_score != null ? r.rerank_score : (r.score != null ? r.score : null),
  }));
  return { ok: true, provider, query, count: results.length, results };
}
async function updateSettings(patch = {}) {
  const settings = await getSettings();
  if (patch.ui) settings.ui = { ...settings.ui, ...patch.ui };
  if (patch.agent) settings.agent = { ...settings.agent, ...patch.agent };
  if (patch.search) {
    const s = settings.search || { provider: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com', maxResults: 5 };
    for (const k of ['provider', 'baseUrl', 'maxResults']) if (patch.search[k] !== undefined) s[k] = patch.search[k];
    if (patch.search.clearKey) s.apiKey = '';
    else if (typeof patch.search.apiKey === 'string' && patch.search.apiKey.trim()) s.apiKey = patch.search.apiKey.trim();
    settings.search = s;
  }
  if (Array.isArray(patch.removeProviders) && patch.removeProviders.length) {
    const remove = new Set(patch.removeProviders.map(String));
    settings.providers = (settings.providers || []).filter((p) => !remove.has(p.id));
  }
  if (Array.isArray(patch.providers)) {
    for (const incoming of patch.providers) {
      if (!incoming || !incoming.id) continue;
      let p = settings.providers.find((x) => x.id === incoming.id);
      if (!p) {
        p = { id: incoming.id, name: incoming.name || incoming.id, baseUrl: incoming.baseUrl || '', keyEnv: incoming.keyEnv || '', apiKey: '', model: '', models: [], wire: 'openai' };
        settings.providers.push(p);
      }
      for (const k of ['name', 'baseUrl', 'keyEnv', 'model', 'wire']) if (incoming[k] !== undefined) p[k] = incoming[k];
      if (Array.isArray(incoming.models)) p.models = incoming.models;
      if (incoming.clearKey) p.apiKey = '';
      else if (typeof incoming.apiKey === 'string' && incoming.apiKey.trim()) p.apiKey = incoming.apiKey.trim();
    }
  }
  await writeJson(SETTINGS_FILE, settings);
  return getPublicSettings();
}
function resolveProvider(settings, providerId) {
  return settings.providers.find((p) => p.id === providerId) || settings.providers[0];
}
function providerKey(provider, explicitKey) {
  return explicitKey || provider.apiKey || (provider.keyEnv ? process.env[provider.keyEnv] : '') || '';
}

async function listSkills() {
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const raw = await fs.readFile(path.join(SKILLS_DIR, e.name), 'utf8').catch(() => '');
    if (!raw) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    const meta = {};
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const m = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(line.trim());
        if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    const body = fm ? raw.slice(fm[0].length) : raw;
    out.push({
      id: meta.id || e.name.replace(/\.md$/, ''),
      name: meta.name || e.name.replace(/\.md$/, ''),
      desc: meta.desc || '',
      category: meta.category || 'general',
      default: meta.default === 'true',
      content: body.trim(),
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return out;
}

async function listTemplates() {
  const entries = await fs.readdir(TEMPLATES_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJson(path.join(TEMPLATES_DIR, e.name, 'template.json'), null);
    const html = await fs.readFile(path.join(TEMPLATES_DIR, e.name, 'index.html'), 'utf8').catch(() => '');
    out.push({
      id: e.name,
      name: meta?.name || e.name,
      desc: meta?.desc || '',
      theme: meta?.theme || 'ink',
      slides: meta?.slides || countSlides(html) || 0,
      cover: meta?.cover || { bg: '#1B1A17', fg: '#F2EAE0', accent: '#E1402B' },
      order: meta?.order ?? 99,
    });
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

async function listSamples() {
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!(await exists(path.join(SAMPLES_DIR, e.name, 'index.html')))) continue;
    const meta = await readJson(path.join(SAMPLES_DIR, e.name, 'sample.json'), null);
    out.push({
      id: e.name,
      name: meta?.name || e.name,
      desc: meta?.desc || '',
      file: path.join(SAMPLES_DIR, e.name, 'index.html'),
      slides: meta?.slides || 0,
      theme: meta?.theme || 'ink',
      cover: meta?.cover || { bg: '#0A0A0B', fg: '#F2EAE0', accent: '#E1402B' },
    });
  }
  return out;
}

/* ==========================================================================
   缩略图
   ========================================================================== */
async function readRawPatches(id) {
  const data = await readJson(path.join(projectDir(id), '.raw-edits.json'), { patches: [] });
  return Array.isArray(data.patches) ? data.patches : [];
}

async function readRawTimeline(id) {
  const data = await readJson(path.join(projectDir(id), '.raw-timeline.json'), { timeline: null });
  return data && data.timeline ? data.timeline : null;
}

async function readRawDeck(id) {
  const data = await readJson(path.join(projectDir(id), '.raw-deck.json'), { config: null });
  return (data && data.config) || {};
}

function rawDeckTags(config) {
  const json = JSON.stringify(config || {}).replace(/</g, '\\u003c');
  return `<script id="wpx-deck-config" type="application/json">${json}</script>`
    + '<script src="/editor/fx-presets.js"></script>'
    + '<script src="/editor/web-runtime.js"></script>';
}

function rawTimelineTags(timeline, inlinePlayer) {
  const json = JSON.stringify(timeline).replace(/</g, '\\u003c');
  const tag = `<script id="wpx-timeline" type="application/json">${json}</script>`;
  if (inlinePlayer) return tag + `<script>${inlinePlayer.replace(/<\/script/gi, '<\\/script')}</script>`;
  return tag + '<script src="/editor/timeline-player.js"></script>';
}

function rawPatchTags(patches, inlineApplier) {
  const json = JSON.stringify(patches).replace(/</g, '\\u003c');
  const tag = `<script id="wpx-raw-patches" type="application/json">${json}</script>`;
  if (inlineApplier) return tag + `<script>${inlineApplier.replace(/<\/script/gi, '<\\/script')}</script>`;
  return tag + '<script src="/editor/raw-patches.js"></script>';
}

async function buildThumbHtml(id, slideIndex = 0) {
  const dir = projectDir(id);
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8').catch(() => null);
  if (!html) return null;
  const styles = [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join('\n');
  const sections = [...html.matchAll(/<section\b[^>]*class\s*=\s*["'][^"']*\bwpx-slide\b[^"']*["'][^>]*>[\s\S]*?<\/section>/gi)].map((m) => m[0]);
  if (!sections.length) return null;
  const idx = Math.max(0, Math.min(sections.length - 1, Number(slideIndex) || 0));
  let slide = sections[idx];
  slide = slide.replace(/<section\b([^>]*)>/i, (m, attrs) => {
    let a = attrs;
    if (!/class\s*=\s*["'][^"']*\bis-active\b/.test(a)) {
      a = /class\s*=\s*["']([^"']*)["']/.test(a)
        ? a.replace(/class\s*=\s*["']([^"']*)["']/, (mm, c) => `class="${c} is-active"`)
        : `class="wpx-slide is-active" ${a}`;
    }
    return `<section ${a}>`;
  });
  slide = slide.replace(/<div\b([^>]*class\s*=\s*["'][^"']*wpx-canvas[^"']*["'][^>]*)>/i, (m, attrs) => {
    if (/\blive\b/.test(attrs)) return m;
    return m.replace(/class\s*=\s*["']([^"']*)["']/, (mm, c) => `class="${c} live"`);
  });
  slide = slide.replace(/<section\b([^>]*)\bdata-bg\s*=\s*["']([^"']*)["']([^>]*)>/i, (m, pre, bg, post) => {
    if (/style\s*=\s*["']/i.test(m)) return m;
    return `<section ${pre}data-bg="${bg}"${post} style="background:${bg.replace(/"/g, '&quot;')}">`;
  });
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/p/${enc(id)}/"><title>${title}</title>
${styles}
<link rel="stylesheet" href="/editor/thumb.css">
</head><body class="wpx-body wpx-thumb-body">
<div id="wpx-app" data-w="1920" data-h="1080"><div id="wpx-stage">${slide}</div></div>
<script>document.documentElement.style.setProperty('--s', Math.min(innerWidth/1920, innerHeight/1080));</script>
</body></html>`;
}

/* ==========================================================================
   AI：模型发现 + 能力识别 + 代理
   ========================================================================== */
let modelsDevCache = { at: 0, data: null };
async function loadModelsDev() {
  if (modelsDevCache.data && now() - modelsDevCache.at < 24 * 3600 * 1000) return modelsDevCache.data;
  try {
    const cached = await readJson(MODELS_CACHE_FILE, null);
    if (cached?.data && now() - (cached.at || 0) < 24 * 3600 * 1000) {
      modelsDevCache = { at: cached.at, data: cached.data };
      return cached.data;
    }
  } catch { /* ignore */ }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const res = await fetch('https://models.dev/api.json', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('models.dev ' + res.status);
    const data = await res.json();
    modelsDevCache = { at: now(), data };
    await writeJson(MODELS_CACHE_FILE, { at: now(), data });
    return data;
  } catch (err) {
    log('models.dev 拉取失败（将用启发式）', err.message);
    return modelsDevCache.data || null;
  }
}

function heuristicCapabilities(modelId) {
  const id = String(modelId || '').toLowerCase();
  const caps = { tools: true, vision: false, reasoning: false, contextLength: 65536, family: 'unknown' };
  const set = (family, ctx, tools, vision, reasoning) => Object.assign(caps, { family, contextLength: ctx, tools, vision, reasoning });
  if (/deepseek/.test(id)) {
    caps.family = 'deepseek';
    caps.contextLength = /v3|chat/.test(id) ? 131072 : 65536;
    caps.tools = !/reasoner/.test(id);
    caps.reasoning = /reason|r1/.test(id);
  } else if (/claude|anthropic/.test(id)) {
    set('claude', 200000, true, true, true);
  } else if (/gpt-5|gpt5/.test(id)) {
    set('gpt', 400000, true, true, true);
  } else if (/gpt-4o|gpt-4\.1|gpt-4\.5|o[1-9]/.test(id)) {
    set('gpt', 128000, true, true, /^o[1-9]|reason/.test(id));
  } else if (/gemini/.test(id)) {
    set('gemini', 1000000, true, true, true);
  } else if (/qwen|qwq/.test(id)) {
    set('qwen', 131072, true, /vl|vision/.test(id), /qwq|think/.test(id));
  } else if (/glm/.test(id)) {
    set('glm', 131072, true, /v|vision/.test(id), /think|reason/.test(id));
  } else if (/kimi|moonshot/.test(id)) {
    set('kimi', 131072, true, /vl|vision/.test(id), /thinking|k2/.test(id));
  } else if (/llama/.test(id)) {
    set('llama', 131072, true, false, false);
  } else if (/mistral|mixtral/.test(id)) {
    set('mistral', 131072, true, false, false);
  }
  if (/vl|vision|omni|multimodal/.test(id)) caps.vision = true;
  if (/reason|thinking|r1|o[1-9]/.test(id)) caps.reasoning = true;
  return caps;
}

function findModelsDevEntry(data, modelId) {
  if (!data) return null;
  const want = String(modelId || '').toLowerCase();
  const short = want.includes('/') ? want.split('/').pop() : want;
  for (const provider of Object.values(data)) {
    const models = provider?.models || {};
    for (const [mid, info] of Object.entries(models)) {
      const id = String(mid).toLowerCase();
      if (id === want || id === short || id.endsWith('/' + short)) return info;
    }
  }
  return null;
}

function normalizeModel(id, raw, devEntry) {
  const caps = heuristicCapabilities(id);
  const info = devEntry || {};
  const limit = info.limit || {};
  const contextLength = Number(limit.context || info.context_length || raw?.context_length || raw?.context_window || caps.contextLength) || caps.contextLength;
  const maxOutput = Number(limit.output || info.max_output_tokens || raw?.max_output_tokens || raw?.max_completion_tokens || 0) || 0;
  const tools = Boolean(info.tool_call ?? info.toolCall ?? info.tools ?? raw?.tool_call ?? caps.tools);
  const vision = Boolean(info.modalities?.input?.includes?.('image') ?? info.vision ?? raw?.vision ?? caps.vision);
  const reasoning = Boolean(info.reasoning ?? raw?.reasoning ?? caps.reasoning);
  const badges = [];
  if (tools) badges.push('工具');
  if (vision) badges.push('视觉');
  if (reasoning) badges.push('推理');
  if (contextLength >= 200000) badges.push('长上下文');
  return {
    id: String(id), name: String(info.name || raw?.name || id),
    family: info.family || caps.family,
    contextLength, maxOutput, tools, vision, reasoning,
    badges,
    recommended: tools && !vision,
  };
}

async function fetchModelList({ providerId, baseUrl, apiKey }) {
  const settings = await getSettings();
  const provider = resolveProvider(settings, providerId);
  const base = String(baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  const key = providerKey(provider, apiKey);
  if (!base) throw Object.assign(new Error('缺少 Base URL'), { status: 400 });
  let rawModels = [];
  let source = 'api';
  if (key) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(base + '/models', {
        headers: Object.assign({ Authorization: 'Bearer ' + key, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, openCodeHeaders(base, 'models-' + crypto.createHash('md5').update(String(base)).digest('hex').slice(0, 8))),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        rawModels = arr.map((m) => (typeof m === 'string' ? { id: m } : m));
      } else {
        source = 'error:' + res.status;
      }
    } catch (err) {
      source = 'error:' + err.message;
    }
  } else {
    source = 'no-key';
  }
  if (!rawModels.length) {
    const fallback = provider.id === 'deepseek'
      ? ['deepseek-chat', 'deepseek-reasoner']
      : ['deepseek-v4.1-flash', 'claude-sonnet-4-5', 'gpt-5'];
    rawModels = fallback.map((id) => ({ id, name: id }));
    if (source === 'no-key') source = 'preset';
  }
  const dev = await loadModelsDev();
  const models = rawModels.map((m) => normalizeModel(m.id || m.model || m.name, m, findModelsDevEntry(dev, m.id || m.model || m.name)));
  models.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));
  if (models[0]) models[0].recommended = true;
  return { models, source, baseUrl: base };
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isOpenCodeBase(base) {
  return /opencode\.ai/i.test(String(base || ''));
}

/** HTTP 头只能是 ByteString：把中文等非 ASCII 字符转义成稳定 ASCII */
function asciiHeaderValue(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return 'webdeck-session';
  const out = s.replace(/[^\x20-\x7E]/g, (ch) => '_' + ch.codePointAt(0).toString(16) + '_');
  return out.slice(0, 180) || 'webdeck-session';
}

/** OpenCode Go 要求：客户端 User-Agent + 每个会话稳定的 x-opencode-session（否则 400 MissingSessionID） */
function openCodeHeaders(base, sessionId) {
  if (!isOpenCodeBase(base)) return {};
  return {
    'User-Agent': 'WebDeck-Studio/1.0',
    'x-opencode-session': asciiHeaderValue(sessionId),
  };
}

function chatSessionId(base, body, messages) {
  const explicit = String(body.sessionId || body.projectId || '').trim();
  if (explicit) return explicit;
  try {
    const seed = base + '|' + String(messages?.[0]?.content || '') + '|' + String(messages?.[1]?.content || '');
    return 'wds-' + crypto.createHash('md5').update(seed).digest('hex').slice(0, 16);
  } catch {
    return 'wds-default';
  }
}

async function handleChat(req, res, body) {
  const settings = await getSettings();
  const provider = resolveProvider(settings, body.providerId);
  if (!provider) return fail(res, 400, '未知 provider');
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const key = providerKey(provider);
  if (!key) return fail(res, 400, '未配置 API Key，请在「设置 → AI 模型」中填写');
  const model = body.model || provider.model || '';
  if (!model) return fail(res, 400, '未选择模型');
  const wire = provider.wire === 'auto' ? (/claude|anthropic/i.test(model) ? 'anthropic' : 'openai') : (provider.wire || 'openai');
  const stream = body.stream !== false;
  const maxTokens = Number(body.maxTokens || settings.agent?.maxTokens || 65536);
  const temperature = body.temperature ?? settings.agent?.temperature ?? 0.7;
  const reasoningEffort = body.reasoning_effort && body.reasoning_effort !== 'auto' ? String(body.reasoning_effort) : '';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolChoice = body.toolChoice && typeof body.toolChoice === 'object' && body.toolChoice.function && body.toolChoice.function.name ? String(body.toolChoice.function.name) : '';
  const sessionId = chatSessionId(base, body, messages);

  if (wire === 'anthropic') return proxyAnthropic({ res, base, key, model, messages, tools, maxTokens, temperature, stream, reasoningEffort, sessionId, toolChoice });
  return proxyOpenAI({ res, base, key, model, messages, tools, maxTokens, temperature, stream, reasoningEffort, sessionId, toolChoice });
}

function normalizeOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' } })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
    return { role: m.role, content: m.content };
  });
}

/** 兼容性重试：部分模型拒绝 temperature / reasoning_effort / tool_choice / 过大的 max_tokens，逐项降级 */
async function postJsonWithCompat(url, headers, payload) {
  const post = () => fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  let upstream = await post();
  if (upstream.ok) return { upstream, text: '' };
  let text = await upstream.text().catch(() => '');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let changed = false;
    if ('tool_choice' in payload && /tool[_ ]choice/i.test(text)) { payload.tool_choice = 'auto'; changed = true; }
    else if ('temperature' in payload && /temperature/i.test(text)) { delete payload.temperature; changed = true; }
    else if ('reasoning_effort' in payload && /reasoning[_ ]effort/i.test(text)) { delete payload.reasoning_effort; changed = true; }
    else if ('stream_options' in payload && /stream_options/i.test(text)) { delete payload.stream_options; changed = true; }
    else if ('max_tokens' in payload && /max[_\s-]?tokens|too large|maximum.*tokens|out of range|exceed/i.test(text)) {
      const next = Math.floor(Number(payload.max_tokens || 8192) / 2);
      if (next < 1024) break;
      payload.max_tokens = next;
      changed = true;
    }
    if (!changed) break;
    upstream = await post();
    if (upstream.ok) return { upstream, text: '' };
    text = await upstream.text().catch(() => '');
  }
  return { upstream: null, status: upstream.status, text };
}

async function proxyOpenAI({ res, base, key, model, messages, tools, maxTokens, temperature, stream, reasoningEffort, sessionId, toolChoice }) {
  const payload = { model, messages: normalizeOpenAIMessages(messages), stream, temperature, max_tokens: maxTokens };
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  if (tools.length) { payload.tools = tools; payload.tool_choice = toolChoice ? { type: 'function', function: { name: toolChoice } } : 'auto'; }
  if (stream) payload.stream_options = { include_usage: true };
  let upstream;
  try {
    const headers = Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, openCodeHeaders(base, sessionId));
    const out = await postJsonWithCompat(base + '/chat/completions', headers, payload);
    if (!out.upstream) return fail(res, 502, `AI 服务返回 ${out.status}`, String(out.text || '').slice(0, 1200));
    upstream = out.upstream;
  } catch (err) {
    return fail(res, 502, '连接 AI 服务失败: ' + err.message);
  }
  const ctype = upstream.headers.get('content-type') || '';
  if (!stream || ctype.includes('application/json')) {
    const data = await upstream.json();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const msg = data.choices?.[0]?.message || {};
    if (msg.reasoning_content) sseWrite(res, { type: 'reasoning', content: msg.reasoning_content });
    if (msg.content) sseWrite(res, { type: 'delta', content: msg.content });
    if (msg.tool_calls?.length) sseWrite(res, { type: 'tool_calls', tool_calls: msg.tool_calls });
    if (data.usage) sseWrite(res, { type: 'usage', usage: data.usage });
    sseWrite(res, { type: 'done', finish_reason: data.choices?.[0]?.finish_reason || 'stop' });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const toolCalls = new Map();
  let usage = null;
  let finishReason = null;
  const handle = (payloadStr) => {
    if (!payloadStr || payloadStr === '[DONE]') return;
    let data;
    try { data = JSON.parse(payloadStr); } catch { return; }
    if (data.error) { sseWrite(res, { type: 'error', message: data.error.message || JSON.stringify(data.error) }); return; }
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.reasoning_content) sseWrite(res, { type: 'reasoning', content: delta.reasoning_content });
    if (delta.reasoning) sseWrite(res, { type: 'reasoning', content: delta.reasoning });
    if (delta.content) sseWrite(res, { type: 'delta', content: delta.content });
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolCalls.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
    if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
  } catch (err) {
    sseWrite(res, { type: 'error', message: '流读取失败: ' + err.message });
  }
  if (toolCalls.size) {
    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    for (const c of calls) if (!c.id) c.id = 'call_' + crypto.randomBytes(6).toString('hex');
    sseWrite(res, { type: 'tool_calls', tool_calls: calls });
  }
  if (usage) sseWrite(res, { type: 'usage', usage });
  sseWrite(res, { type: 'done', finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop') });
  res.end();
}

function toAnthropicPayload({ model, messages, tools, maxTokens, temperature, toolChoice }) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('\n')))
    .join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  const payload = { model, max_tokens: maxTokens, messages: out, stream: true };
  if (system) payload.system = system;
  if (temperature != null) payload.temperature = temperature;
  if (tools.length) {
    payload.tools = tools.map((t) => ({ name: t.function?.name, description: t.function?.description, input_schema: t.function?.parameters || { type: 'object', properties: {} } }));
    if (toolChoice) payload.tool_choice = { type: 'tool', name: toolChoice };
  }
  return payload;
}

async function proxyAnthropic({ res, base, key, model, messages, tools, maxTokens, temperature, sessionId, toolChoice }) {
  let upstream;
  try {
    const payload = toAnthropicPayload({ model, messages, tools, maxTokens, temperature, toolChoice });
    const headers = Object.assign({ 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', Authorization: 'Bearer ' + key }, openCodeHeaders(base, sessionId));
    const out = await postJsonWithCompat(base + '/messages', headers, payload);
    if (!out.upstream) return fail(res, 502, `AI 服务返回 ${out.status}`, String(out.text || '').slice(0, 1200));
    upstream = out.upstream;
  } catch (err) {
    return fail(res, 502, '连接 AI 服务失败: ' + err.message);
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let pendingEvent = '';
  let dataLines = [];
  const toolBlocks = new Map();
  let stopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;

  const handleEvent = (event, dataStr) => {
    if (!dataStr) return;
    let data;
    try { data = JSON.parse(dataStr); } catch { return; }
    if (event === 'message_start') {
      const u = data.message?.usage || {};
      inputTokens = Number(u.input_tokens || 0);
      outputTokens = Number(u.output_tokens || 0);
    } else if (event === 'content_block_start') {
      const block = data.content_block;
      if (block?.type === 'tool_use') toolBlocks.set(data.index, { id: block.id, name: block.name, arguments: '' });
      if (block?.type === 'text' && block.text) sseWrite(res, { type: 'delta', content: block.text });
      if (block?.type === 'thinking' && block.thinking) sseWrite(res, { type: 'reasoning', content: block.thinking });
    } else if (event === 'content_block_delta') {
      const d = data.delta;
      if (d?.type === 'text_delta') sseWrite(res, { type: 'delta', content: d.text });
      else if (d?.type === 'thinking_delta') sseWrite(res, { type: 'reasoning', content: d.thinking });
      else if (d?.type === 'input_json_delta') {
        const cur = toolBlocks.get(data.index);
        if (cur) cur.arguments += d.partial_json || '';
      }
    } else if (event === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      const u = data.usage || {};
      if (u.output_tokens != null) outputTokens = Number(u.output_tokens);
      if (u.input_tokens != null) inputTokens = Number(u.input_tokens);
    } else if (event === 'error') {
      sseWrite(res, { type: 'error', message: data.error?.message || JSON.stringify(data.error || data) });
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const rawLine = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const line = rawLine.replace(/\r$/, '');
        if (line === '') {
          if (dataLines.length) handleEvent(pendingEvent, dataLines.join('\n'));
          pendingEvent = '';
          dataLines = [];
          continue;
        }
        if (line.startsWith('event:')) pendingEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length) handleEvent(pendingEvent, dataLines.join('\n'));
  } catch (err) {
    sseWrite(res, { type: 'error', message: '流读取失败: ' + err.message });
  }
  if (toolBlocks.size) {
    const calls = [...toolBlocks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({
      id: v.id || ('call_' + crypto.randomBytes(6).toString('hex')),
      type: 'function',
      function: { name: v.name, arguments: v.arguments || '{}' },
    }));
    sseWrite(res, { type: 'tool_calls', tool_calls: calls });
  }
  if (inputTokens || outputTokens) {
    sseWrite(res, { type: 'usage', usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
  }
  sseWrite(res, { type: 'done', finish_reason: stopReason === 'tool_use' ? 'tool_calls' : (stopReason || (toolBlocks.size ? 'tool_calls' : 'stop')) });
  res.end();
}

/* ==========================================================================
   文件系统浏览（导入用）
   ========================================================================== */
async function fsRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (const l of letters) {
      const p = l + ':\\';
      if (await exists(p)) roots.push({ name: l + ': 盘', path: p, kind: 'drive' });
    }
    const home = os.homedir();
    for (const [name, rel] of [['桌面', 'Desktop'], ['文档', 'Documents'], ['下载', 'Downloads']]) {
      const p = path.join(home, rel);
      if (await exists(p)) roots.push({ name, path: p, kind: 'dir' });
    }
    roots.push({ name: '用户目录', path: home, kind: 'dir' });
  } else {
    roots.push({ name: '/', path: '/', kind: 'drive' }, { name: 'Home', path: os.homedir(), kind: 'dir' });
  }
  return roots;
}
async function fsList(target) {
  const roots = await fsRoots();
  if (!target) return { path: '', parent: null, roots, dirs: [], files: [] };
  const abs = path.resolve(target);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) throw Object.assign(new Error('目录不存在: ' + target), { status: 404 });
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
    const p = path.join(abs, e.name);
    if (e.isDirectory()) dirs.push({ name: e.name, path: p });
    else if (/\.(html?|htm)$/i.test(e.name)) {
      const st = await fs.stat(p).catch(() => null);
      files.push({ name: e.name, path: p, size: st?.size || 0, mtime: st?.mtimeMs || 0, ext: path.extname(e.name) });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, roots, dirs, files };
}

/* ==========================================================================
   静态资源 & 注入
   ========================================================================== */
async function serveStatic(res, filePath, { noStore = false } = {}) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': noStore ? 'no-store' : 'no-cache',
  });
  createReadStream(filePath).pipe(res);
  return true;
}

async function serveProjectFile(req, res, id, relPath) {
  const dir = projectDir(id);
  const target = path.join(dir, safeRel(relPath));
  if (!within(dir, target)) return fail(res, 403, '禁止访问');
  const url = new URL(req.url, 'http://localhost');
  const wpx = url.searchParams.get('wpx');
  const isIndex = path.basename(target).toLowerCase() === 'index.html';  if (isIndex && (wpx === 'edit' || wpx === 'capture')) {
    let html = await fs.readFile(target, 'utf8').catch(() => null);
    if (html == null) return fail(res, 404, '文件不存在');
    if (wpx === 'edit') {
      html = html.replace(/<script[^>]*id=["']wpx-bridge["'][^>]*>\s*<\/script>/gi, '');
      const project = await readProject(id).catch(() => null);
      if (project && project.kind === 'raw') {
        const timeline = await readRawTimeline(id);
        const deckConfig = await readRawDeck(id);
        const tags = (timeline ? rawTimelineTags(timeline, null) : '<script src="/editor/timeline-player.js"></script>') + rawDeckTags(deckConfig);
        html = html.includes('</body>') ? html.replace('</body>', tags + '\n</body>') : html + tags;
      }
      if (html.includes('</body>')) html = html.replace('</body>', '<script id="wpx-bridge" src="/editor/bridge.js"></script>\n</body>');
      else html += '\n<script id="wpx-bridge" src="/editor/bridge.js"></script>';
    } else {
      const accel = `<script>(function(){var st=window.setTimeout,si=window.setInterval;window.__wpxNativeTimeout=st;window.__wpxNativeInterval=si;window.setTimeout=function(fn,ms){var a=[].slice.call(arguments,2);if(typeof ms==='number'&&ms>=200&&ms<=3000){ms=Math.min(ms,60);}return st.apply(window,[fn,ms].concat(a));};window.setInterval=function(fn,ms){var a=[].slice.call(arguments,2);if(typeof ms==='number'&&ms>=200&&ms<=3000){ms=Math.min(ms,60);}return si.apply(window,[fn,ms].concat(a));};window.__WPX_CAPTURE__=true;})();</script>`;
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + accel);
      else html = accel + html;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (wpx === 'thumb') {
    const html = await buildThumbHtml(id, Number(url.searchParams.get('slide') || 0));
    if (!html) return fail(res, 404, '无法生成缩略图');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  // 兼容模式（raw）：放映页注入编辑补丁 + 时间线 + 放映外壳（原稿 HTML 不动，动效完整）
  if (isIndex && relPath === 'index.html') {
    const project = await readProject(id).catch(() => null);
    if (project && project.kind === 'raw') {
      const patches = await readRawPatches(id);
      const timeline = await readRawTimeline(id);
      let tags = '';
      if (patches.length) tags += rawPatchTags(patches, null);
      if (timeline) tags += rawTimelineTags(timeline, null);
      const deckConfig = await readRawDeck(id);
      tags += rawDeckTags(deckConfig);
      tags += '<script src="/editor/present-shell.js"></script>';
      let html = await fs.readFile(target, 'utf8').catch(() => null);
      if (html != null) {
        html = html.includes('</body>') ? html.replace('</body>', tags + '\n</body>') : html + tags;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
    }
  }
  const ok = await serveStatic(res, target);
  if (!ok) fail(res, 404, '文件不存在');
}

/* ==========================================================================
   路由
   ========================================================================== */
const server = http.createServer(async (req, res) => {
  const started = now();
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'Bad URL'); }
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method.toUpperCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    /* ---------- 静态 ---------- */
    if (pathname === '/' || pathname === '/index.html') {
      return serveStatic(res, path.join(APP_DIR, 'index.html'), { noStore: true });
    }
    if (pathname.startsWith('/app/')) {
      const target = path.join(APP_DIR, safeRel(pathname.slice(5)));
      if (!within(APP_DIR, target)) return fail(res, 403, '禁止访问');
      const ok = await serveStatic(res, target, { noStore: true });
      return ok ? undefined : fail(res, 404, '资源不存在');
    }
    if (pathname.startsWith('/editor/')) {
      const target = path.join(EDITOR_DIR, safeRel(pathname.slice(8)));
      if (!within(EDITOR_DIR, target)) return fail(res, 403, '禁止访问');
      const ok = await serveStatic(res, target, { noStore: true });
      return ok ? undefined : fail(res, 404, '资源不存在');
    }
    if (pathname.startsWith('/templates/')) {
      const target = path.join(TEMPLATES_DIR, safeRel(pathname.slice(11)));
      if (!within(TEMPLATES_DIR, target)) return fail(res, 403, '禁止访问');
      const ok = await serveStatic(res, target, { noStore: true });
      return ok ? undefined : fail(res, 404, '模板不存在');
    }
    if (pathname.startsWith('/samples/')) {
      const target = path.join(SAMPLES_DIR, safeRel(pathname.slice(9)));
      if (!within(SAMPLES_DIR, target)) return fail(res, 403, '禁止访问');
      const ok = await serveStatic(res, target, { noStore: true });
      return ok ? undefined : fail(res, 404, '示例不存在');
    }
    const pMatch = /^\/p\/([^/]+)\/(.*)$/.exec(pathname);
    if (pMatch) return serveProjectFile(req, res, pMatch[1], pMatch[2] || 'index.html');
    if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    /* ---------- API ---------- */
    if (pathname === '/api/health') return json(res, 200, { ok: true, version: VERSION, uptime: now() - startedAt });
    if (pathname === '/api/projects' && method === 'GET') return json(res, 200, { projects: await listProjects() });
    if (pathname === '/api/projects' && method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, { project: await createProject(body) });
    }
    if (pathname === '/api/projects/import' && method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, { project: await importProject(body) });
    }
    if (pathname === '/api/settings' && method === 'GET') return json(res, 200, await getPublicSettings());
    if (pathname === '/api/settings' && method === 'PUT') {
      const body = await readJsonBody(req);
      return json(res, 200, await updateSettings(body));
    }
    if (pathname === '/api/skills' && method === 'GET') return json(res, 200, { skills: await listSkills() });
    if (pathname === '/api/templates' && method === 'GET') return json(res, 200, { templates: await listTemplates() });
    if (pathname === '/api/samples' && method === 'GET') return json(res, 200, { samples: await listSamples() });
    if (pathname === '/api/fs/list' && method === 'GET') return json(res, 200, await fsList(url.searchParams.get('path') || ''));
    if (pathname === '/api/fs/read' && method === 'GET') {
      const target = path.resolve(url.searchParams.get('path') || '');
      const stat = await fs.stat(target).catch(() => null);
      if (!stat || !stat.isFile()) return fail(res, 404, '文件不存在');
      if (stat.size > 2 * 1024 * 1024) return fail(res, 413, '文件过大');
      return json(res, 200, { path: target, content: await fs.readFile(target, 'utf8') });
    }
    if (pathname === '/api/ai/models' && method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, await fetchModelList(body));
    }
    if (pathname === '/api/ai/models-cache') {
      const data = await loadModelsDev();
      return json(res, 200, { ok: Boolean(data), providers: data ? Object.keys(data).length : 0 });
    }
    if (pathname === '/api/ai/chat' && method === 'POST') {
      const body = await readJsonBody(req);
      return handleChat(req, res, body);
    }
    if (pathname === '/api/search' && method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, await handleSearch(body));
    }

    /* ---------- 工程子路由 ---------- */
    const m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
    if (m) {
      const id = m[1];
      const sub = m[2] || '';
      const dir = projectDir(id);
      if (!(await exists(dir))) return fail(res, 404, '工程不存在');
      if (sub === '' && method === 'GET') {
        const project = await readProject(id);
        if (!project) return fail(res, 404, '工程不存在');
        const files = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')).map((e) => e.name);
        return json(res, 200, { project, files });
      }
      if (sub === '' && method === 'PATCH') {
        const body = await readJsonBody(req);
        const project = await readProject(id);
        if (!project) return fail(res, 404, '工程不存在');
        const allowed = ['name', 'kind', 'slideCount', 'theme', 'cover', 'coverFg', 'coverAccent', 'origin'];
        for (const k of allowed) if (body[k] !== undefined) project[k] = body[k];
        project.updatedAt = now();
        await writeJson(path.join(dir, 'project.json'), project);
        return json(res, 200, { project });
      }
      if (sub === '' && method === 'DELETE') {
        await fs.rm(dir, { recursive: true, force: true });
        log('删除工程', id);
        return json(res, 200, { ok: true });
      }
      if (sub === '/duplicate' && method === 'POST') return json(res, 200, { project: await duplicateProject(id) });
      if (sub === '/upgrade-runtime' && method === 'POST') return json(res, 200, await upgradeProjectRuntime(id));
      if (sub === '/file' && method === 'GET') {
        const rel = safeRel(url.searchParams.get('path') || 'index.html');
        const target = path.join(dir, rel);
        if (!within(dir, target)) return fail(res, 403, '禁止访问');
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) return fail(res, 404, '文件不存在');
        return json(res, 200, { path: rel, content: await fs.readFile(target, 'utf8'), size: stat.size, mtime: stat.mtimeMs });
      }
      if (sub === '/file' && method === 'PUT') {
        const body = await readJsonBody(req, 80 * 1024 * 1024);
        const rel = safeRel(body.path || 'index.html');
        const target = path.join(dir, rel);
        if (!within(dir, target)) return fail(res, 403, '禁止访问');
        const content = String(body.content ?? '');
        if (rel === 'index.html') await saveVersion(dir);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
        const project = await readProject(id);
        if (project) {
          project.updatedAt = now();
          project.size = Buffer.byteLength(content);
          if (rel === 'index.html') project.slideCount = countSlides(content) || project.slideCount;
          await writeJson(path.join(dir, 'project.json'), project);
        }
        return json(res, 200, { ok: true, savedAt: now(), size: Buffer.byteLength(content) });
      }
      if (sub === '/patches' && method === 'GET') {
        const data = await readJson(path.join(dir, '.raw-edits.json'), { patches: [], updatedAt: 0 });
        return json(res, 200, { patches: Array.isArray(data.patches) ? data.patches : [], updatedAt: data.updatedAt || 0 });
      }
      if (sub === '/patches' && method === 'PUT') {
        const body = await readJsonBody(req, 24 * 1024 * 1024);
        const patches = Array.isArray(body.patches) ? body.patches.slice(0, 2000) : [];
        await writeJson(path.join(dir, '.raw-edits.json'), { patches, updatedAt: now() });
        const project = await readProject(id);
        if (project) { project.updatedAt = now(); await writeJson(path.join(dir, 'project.json'), project); }
        return json(res, 200, { ok: true, count: patches.length, savedAt: now() });
      }
      if (sub === '/deck-config' && method === 'GET') {
        return json(res, 200, { config: await readRawDeck(id) });
      }
      if (sub === '/deck-config' && method === 'PUT') {
        const body = await readJsonBody(req, 1024 * 1024).catch(() => ({}));
        const config = body && body.config && typeof body.config === 'object' ? body.config : {};
        await writeJson(path.join(dir, '.raw-deck.json'), { config, updatedAt: now() });
        return json(res, 200, { ok: true, config });
      }
      if (sub === '/timeline' && method === 'GET') {
        const timeline = await readRawTimeline(id);
        return json(res, 200, { timeline });
      }
      if (sub === '/timeline' && method === 'PUT') {
        const body = await readJsonBody(req, 8 * 1024 * 1024);
        const timeline = body && body.timeline && typeof body.timeline === 'object' ? body.timeline : null;
        await writeJson(path.join(dir, '.raw-timeline.json'), { timeline, updatedAt: now() });
        return json(res, 200, { ok: true, hasTimeline: !!timeline });
      }
      if (sub === '/assets' && method === 'POST') {
        const qname = url.searchParams.get('name') || 'asset';
        const ctype = req.headers['content-type'] || '';
        let buf;
        let ext = path.extname(qname).toLowerCase();
        if (ctype.includes('application/json')) {
          const body = await readJsonBody(req, 40 * 1024 * 1024);
          const dataUrl = body.dataUrl || '';
          const mm = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
          if (!mm) return fail(res, 400, '无效的 dataUrl');
          buf = Buffer.from(mm[2], 'base64');
          if (!ext) ext = '.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[mm[1]] || 'bin');
        } else {
          buf = await readBody(req, 40 * 1024 * 1024);
          if (!ext) ext = '.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[ctype.split(';')[0]] || 'bin');
        }
        if (!buf.length) return fail(res, 400, '空文件');
        const hash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 10);
        const safeName = 'assets/' + hash + ext.replace(/[^.a-z0-9]/gi, '');
        const target = path.join(dir, safeName);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buf);
        return json(res, 200, { url: safeName, size: buf.length });
      }
      if (sub === '/history' && method === 'GET') return json(res, 200, await readJson(path.join(dir, '.history.json'), { ops: [], updatedAt: 0 }));
      if (sub === '/history' && method === 'PUT') {
        const body = await readJsonBody(req, 80 * 1024 * 1024);
        const data = { ops: Array.isArray(body.ops) ? body.ops.slice(-400) : [], updatedAt: now() };
        await writeJson(path.join(dir, '.history.json'), data);
        return json(res, 200, { ok: true });
      }
      if (sub === '/chat' && method === 'GET') return json(res, 200, await readJson(path.join(dir, '.chat.json'), { messages: [], skills: [], updatedAt: 0 }));
      if (sub === '/chat' && method === 'PUT') {
        const body = await readJsonBody(req, 80 * 1024 * 1024);
        const data = { messages: Array.isArray(body.messages) ? body.messages.slice(-200) : [], skills: Array.isArray(body.skills) ? body.skills : [], updatedAt: now() };
        await writeJson(path.join(dir, '.chat.json'), data);
        return json(res, 200, { ok: true });
      }
      if (sub === '/thumb' && method === 'GET') {
        const html = await buildThumbHtml(id, Number(url.searchParams.get('slide') || 0));
        if (!html) return fail(res, 404, '无法生成缩略图');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (sub === '/export' && method === 'GET') {
        const target = path.join(dir, 'index.html');
        let html = await fs.readFile(target, 'utf8').catch(() => null);
        if (!html) return fail(res, 404, '文件不存在');
        const project = await readProject(id);
        // 兼容模式：导出自包含（原稿 + 内联补丁应用器 + 内联时间线播放器）
        if (project && project.kind === 'raw') {
          const patches = await readRawPatches(id);
          const timeline = await readRawTimeline(id);
          let tags = '';
          if (patches.length) {
            const applier = await fs.readFile(path.join(EDITOR_DIR, 'raw-patches.js'), 'utf8').catch(() => '');
            tags += rawPatchTags(patches, applier);
          }
          if (timeline) {
            const player = await fs.readFile(path.join(EDITOR_DIR, 'timeline-player.js'), 'utf8').catch(() => '');
            tags += rawTimelineTags(timeline, player);
          }
          const deckConfig = await readRawDeck(id);
          const cfgJson = JSON.stringify(deckConfig || {}).replace(/</g, '\\u003c');
          tags += `<script id="wpx-deck-config" type="application/json">${cfgJson}</script>`;
          const fxInline = await fs.readFile(path.join(EDITOR_DIR, 'fx-presets.js'), 'utf8').catch(() => '');
          const webInline = await fs.readFile(path.join(EDITOR_DIR, 'web-runtime.js'), 'utf8').catch(() => '');
          if (fxInline) tags += `<script>${fxInline.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
          if (webInline) tags += `<script>${webInline.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
          const shell = await fs.readFile(path.join(EDITOR_DIR, 'present-shell.js'), 'utf8').catch(() => '');
          if (shell) tags += `<script>${shell.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
          if (tags) html = html.includes('</body>') ? html.replace('</body>', tags + '\n</body>') : html + tags;
        }
        const name = (project?.name || id).replace(/[\\/:*?"<>|]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${enc(name)}.html`,
        });
        return res.end(html);
      }
      if (sub === '/reload-runtime' && method === 'POST') { invalidateRuntimeCache(); return json(res, 200, { ok: true }); }
      return fail(res, 404, '未知工程接口: ' + sub);
    }

    return fail(res, 404, 'Not found: ' + pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[wds] 请求异常', req.method, pathname, err);
    if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
    fail(res, status, err.message || '服务器错误');
  } finally {
    if (process.env.WDS_LOG !== '0') {
      const ms = now() - started;
      if (ms > 250 || pathname.startsWith('/api/')) log(req.method, pathname, res.statusCode, ms + 'ms');
    }
  }
});

await ensureDirs();
server.listen(PORT, HOST, () => {
  log(`WebDeck Studio 已启动 → http://${HOST}:${PORT}`);
  log(`工程目录: ${PROJECTS_DIR}`);
});
process.on('SIGINT', () => { log('正在关闭…'); server.close(() => process.exit(0)); });
