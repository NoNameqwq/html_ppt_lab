import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_IMAGE_SETTINGS, publicImageSettings, updateImageSettings, discoverImageModels, generateImage } from '../server/image-generation.mjs';
import { getToolDefinitionsForPermission, createToolExecutor } from '../app/js/agent/tools.js';
import { buildNavigationHTML, resolveChapters } from '../app/js/core/deck-navigation.js';
import { buildCreationBrief } from '../app/js/agent/blueprints.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII=', 'base64');
async function fixture(fn) {
  const requests = [], root = await fs.mkdtemp(path.join(os.tmpdir(), 'wds-images-'));
  let mode = 'base64', port;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(mode === 'error' ? 401 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: mode === 'empty' ? [{ id: 'gpt-chat' }] : [{ id: 'flux-test' }, { id: 'gpt-image-1.5' }, { id: 'gpt-image-1' }, { id: 'gpt-chat' }, { id: 'text-embedding-3' }] })); return;
    }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, body: JSON.parse(raw), authorization: req.headers.authorization });
    if (mode === 'error') { res.writeHead(500); res.end('private-provider-detail'); return; }
    if (mode === 'delay') await new Promise((r) => setTimeout(r, 150));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: mode === 'empty' ? [] : [{ b64_json: mode === 'invalid' ? Buffer.from('<svg/>').toString('base64') : mode === 'url' ? undefined : png.toString('base64'), url: mode === 'url' ? `http://127.0.0.1:${port}/image.png` : undefined }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); port = server.address().port;
  const config = updateImageSettings({}, { enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'image-test', apiKey: 'test-secret' });
  try { await fn({ root, config, requests, mode: (v) => { mode = v; } }); }
  finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(root, { recursive: true, force: true }); }
}

test('Images are off by default, configuration validates explicit opt-in and never exposes keys', () => {
  assert.equal(DEFAULT_IMAGE_SETTINGS.enabled, false);
  assert.throws(() => updateImageSettings({}, { enabled: true }), /先填写/);
  assert.throws(() => updateImageSettings({}, { baseUrl: 'file:///key' }), /HTTP/);
  const config = updateImageSettings({}, { baseUrl: 'https://example.com/v1', model: 'image', apiKey: 'test-secret' });
  assert.equal(config.enabled, false); assert.equal(updateImageSettings(config, { apiKey: '' }).apiKey, 'test-secret');
  assert.equal(publicImageSettings(config).configured, true); assert(!JSON.stringify(publicImageSettings(config)).includes('secret'));
  assert.equal(updateImageSettings(config, { clearKey: true }).apiKey, '');
});

test('Disabled image generation cannot make an upstream call or write any file', async () => fixture(async ({ config, root, requests }) => {
  await assert.rejects(() => generateImage({ config: { ...config, enabled: false }, body: { prompt: 'tree' }, projectDir: root }), /未开启/);
  assert.equal(requests.length, 0); assert.deepEqual(await fs.readdir(root), []);
}));

test('Image discovery filters chat/embedding models, prioritizes GPT and never changes opt-in or writes files', async () => fixture(async (f) => {
  const config = updateImageSettings({}, { baseUrl: f.config.baseUrl + '/images/generations', apiKey: 'test-secret' });
  const found = await discoverImageModels(config);
  assert.equal(found.source, 'upstream'); assert.equal(found.recommended, 'gpt-image-1.5');
  assert(!found.models.some((m) => /chat|embedding/.test(m.id))); assert.equal(config.enabled, false);
  assert.deepEqual(await fs.readdir(f.root), []); assert.equal(f.requests.length, 0);
  f.mode('error'); await assert.rejects(() => discoverImageModels(config), /HTTP 401/);
  f.mode('empty'); await assert.rejects(() => discoverImageModels(config), /未返回/);
}));

test('Only API Key and Base URL are required; auto model and Agent-selected GPT parameters reach the upstream', async () => fixture(async (f) => {
  const config = updateImageSettings({}, { enabled: true, baseUrl: f.config.baseUrl, apiKey: 'test-secret' });
  assert.equal(config.model, 'auto');
  const result = await generateImage({ config, projectDir: f.root, body: { prompt: 'leaf', size: '1536x1024', quality: 'high', background: 'transparent', outputFormat: 'webp', outputCompression: 82 } });
  assert.equal(result.model, 'gpt-image-1.5');
  assert.deepEqual(f.requests[0].body, { model: 'gpt-image-1.5', prompt: 'leaf', n: 1, size: '1536x1024', quality: 'high', background: 'transparent', output_format: 'webp', output_compression: 82 });
  const cached = { ...config, models: [{ id: 'gpt-image-1.5' }] };
  for (const body of [{ model: 'unknown' }, { background: 'transparent', outputFormat: 'jpeg' }, { outputFormat: 'png', outputCompression: 50 }, { quality: 'hd' }, { size: '512x512' }]) {
    await assert.rejects(() => generateImage({ config: cached, projectDir: f.root, body: { prompt: 'leaf', ...body } }));
  }
  assert.equal(f.requests.length, 1);
}));

test('Base64 and URL images are verified, saved locally and use the configured model without optional-format assumptions', async () => fixture(async (f) => {
  const result = await generateImage({ config: f.config, body: { prompt: '知识生长的树' }, projectDir: f.root });
  assert(result.url.startsWith('assets/generated-')); assert.equal(result.model, 'image-test'); assert.deepEqual(await fs.readFile(path.join(f.root, result.url)), png);
  assert.deepEqual(f.requests[0].body, { model: 'image-test', prompt: '知识生长的树', n: 1 }); assert.equal(f.requests[0].url, '/v1/images/generations');
  f.mode('url'); const url = await generateImage({ config: { ...f.config, baseUrl: f.config.baseUrl + '/images/generations' }, body: { prompt: 'tree' }, projectDir: f.root });
  assert.equal(url.url, result.url); assert.equal(f.requests[1].url, '/v1/images/generations');
}));

test('Provider failure, empty output and non-raster content never create phantom assets', async () => fixture(async (f) => {
  for (const mode of ['error', 'empty', 'invalid']) { f.mode(mode); await assert.rejects(() => generateImage({ config: f.config, body: { prompt: 'tree' }, projectDir: f.root })); }
  assert.deepEqual(await fs.readdir(f.root), []);
}));

test('Cancellation and switching the feature off while generating prevent asset writes', async () => fixture(async (f) => {
  f.mode('delay'); const controller = new AbortController();
  const pending = generateImage({ config: f.config, body: { prompt: 'tree' }, projectDir: f.root, signal: controller.signal }); setTimeout(() => controller.abort(), 20);
  await assert.rejects(() => pending, /取消/);
  let enabledChecks = 0;
  await assert.rejects(() => generateImage({ config: f.config, body: { prompt: 'tree' }, projectDir: f.root, stillEnabled: async () => ++enabledChecks === 1 }), /已关闭/);
  const requestsBefore = f.requests.length;
  await assert.rejects(() => generateImage({ config: f.config, body: { prompt: 'tree' }, projectDir: f.root, stillEnabled: async () => false }), /未发起/);
  assert.equal(f.requests.length, requestsBefore);
  assert.deepEqual(await fs.readdir(f.root), []);
}));

test('The model receives no image tool until enabled, and cannot enable it through generic settings', async () => {
  const names = (opts) => getToolDefinitionsForPermission('full', opts).map((d) => d.function.name);
  assert(!names({}).includes('deck_generate_image')); assert(names({ imageGeneration: true }).includes('deck_generate_image'));
  assert(!getToolDefinitionsForPermission('read', { imageGeneration: true }).some((d) => d.function.name === 'deck_generate_image'));
  const ctx = { store: { get: () => ({ project: { id: 'test' } }) } };
  const result = await createToolExecutor(ctx).execute('app_call_api', { operation: 'settings.write', body: { imageGeneration: { enabled: true } } }, { permission: 'full' });
  assert.equal(result.ok, false); assert.match(result.error, /手动开启/);
});

test('Directory links use stable IDs, escape labels and validate target/self links', () => {
  const slides = [{ id: 'cover' }, { id: 'toc' }, { id: 'chapter-a', name: 'A' }, { id: 'chapter-b', name: 'B' }];
  const chapters = resolveChapters([{ title: '<svg>', slideIndex: 2 }, { title: 'B', slideIndex: 3 }], slides, 1);
  for (const style of ['petals','orbit','steps']) { const html = buildNavigationHTML({ style, chapters }); assert(html.includes('go-id:chapter-a')); assert(html.includes('&lt;svg&gt;')); assert(!html.includes('<script')); assert(html.includes('prefers-reduced-motion')); }
  assert.throws(() => resolveChapters([{ slideIndex: 1 }], slides, 1), /不能指向自身/);
  assert.throws(() => resolveChapters([{ slideIndex: 2 }, { slideIndex: 2 }], slides, 1), /不同/);
  assert.throws(() => resolveChapters([{ slideIndex: 8 }], slides, 1), /有效页面/);
});

test('Creation briefs leave navigation design to the model within the requested page count', () => {
  for (const pages of [3,5,6,8,16,20]) {
    const brief = buildCreationBrief({ topic: '科学知识', pages });
    const lines = brief.brief.split('\n').filter((l) => /^\d+\. .* \|/.test(l));
    assert.equal(lines.length, pages); assert.equal(lines.some((l) => l.includes('Navigation decision (optional)')), pages >= 6);
    assert(brief.brief.includes('invent its form')||pages<6);
  }
});

test('Custom directories accept original layouts, bind stable IDs and reject broken chapter links',()=>{
  const chapters=resolveChapters([{title:'First',slideIndex:2},{title:'Second',slideIndex:3}],[{id:'cover'},{id:'toc'},{id:'a'},{id:'b'}],1);
  const html='<h1>Research atlas</h1>'+[0,1].map(i=>`<button class="original-${i}" data-wds-target="{{target:${i}}}" data-wpx-action="go-id:{{target:${i}}}">${i}</button>`).join('');
  const out=buildNavigationHTML({style:'custom',chapters,html,css:'.wds-nav-custom button{border-radius:0}'});
  assert(out.includes('data-wds-navigation="custom"'));assert(out.includes('go-id:a'));assert(out.includes('go-id:b'));assert(!out.includes('{{target:'));assert(!out.includes('wds-nav-petals'));
  assert.throws(()=>buildNavigationHTML({style:'custom',chapters,html:html.replaceAll('{{target:1}}','broken')}),/章节/);
  assert.throws(()=>buildNavigationHTML({style:'invented',chapters}),/custom/);
});
