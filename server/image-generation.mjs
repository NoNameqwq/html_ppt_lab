import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const DEFAULT_IMAGE_SETTINGS = Object.freeze({ enabled: false, baseUrl: '', model: '', apiKey: '', size: 'auto', quality: 'auto', responseFormat: 'auto' });
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', '512x512', '256x256'];
export function publicImageSettings(config = {}) {
  const c = { ...DEFAULT_IMAGE_SETTINGS, ...config };
  return { enabled: c.enabled === true, baseUrl: c.baseUrl, model: c.model, size: c.size, quality: c.quality, responseFormat: c.responseFormat,
    keySet: Boolean(c.apiKey), configured: Boolean(c.baseUrl && c.model && c.apiKey) };
}
export function updateImageSettings(current, patch = {}) {
  const c = { ...DEFAULT_IMAGE_SETTINGS, ...current };
  for (const key of ['baseUrl', 'model']) if (patch[key] !== undefined) c[key] = String(patch[key]).trim().slice(0, 1000);
  if (c.baseUrl) {
    let url; try { url = new URL(c.baseUrl); } catch { throw problem('生图服务地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw problem('请填写不含账号、参数的 HTTP(S) 服务地址');
  }
  if (patch.clearKey) c.apiKey = '';
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) c.apiKey = patch.apiKey.trim();
  if (patch.size !== undefined) { if (!SIZES.includes(patch.size)) throw problem('不支持的图片尺寸'); c.size = patch.size; }
  if (patch.quality !== undefined) { if (!['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(patch.quality)) throw problem('不支持的图片质量'); c.quality = patch.quality; }
  if (patch.responseFormat !== undefined) { if (!['auto', 'b64_json', 'url'].includes(patch.responseFormat)) throw problem('不支持的图片返回格式'); c.responseFormat = patch.responseFormat; }
  if (patch.enabled !== undefined) c.enabled = patch.enabled === true;
  if (c.enabled && !publicImageSettings(c).configured) throw problem('请先填写生图服务地址、模型和 API Key，再手动开启');
  return c;
}
async function limitedBody(response, limit, signal) {
  if (Number(response.headers.get('content-length')) > limit) throw problem('生图服务返回文件过大', 502);
  const chunks = []; let total = 0;
  for await (const chunk of response.body || []) {
    signal?.throwIfAborted(); total += chunk.length;
    if (total > limit) { await response.body.cancel?.().catch(() => {}); throw problem('生图服务返回文件过大', 502); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function imageExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return 'png';
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 13 && /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'gif';
  throw problem('生图服务未返回有效的 PNG / JPEG / WebP / GIF 图片', 502);
}
let inFlight = 0;
export async function generateImage({ config, body = {}, projectDir, signal, stillEnabled = async () => true }) {
  if (config?.enabled !== true) throw problem('生图功能未开启，请由用户在「生图设置」中手动开启', 403);
  const c = updateImageSettings(config, {});
  const prompt = String(body.prompt || '').trim();
  if (!prompt || prompt.length > 24000) throw problem('生图提示词需为 1–24000 字符');
  if (inFlight >= 2) throw problem('生图任务繁忙，请等待当前图片生成完成', 429);
  const payload = { model: c.model, prompt, n: 1 };
  const size = body.size || c.size, quality = body.quality || c.quality;
  if (!SIZES.includes(size)) throw problem('不支持的图片尺寸');
  if (!['auto', 'low', 'medium', 'high', 'standard', 'hd'].includes(quality)) throw problem('不支持的图片质量');
  // Omitting optional fields is compatible with both GPT Image and older Images services.
  if (size !== 'auto') payload.size = size;
  if (quality !== 'auto') payload.quality = quality;
  if (c.responseFormat !== 'auto') payload.response_format = c.responseFormat;
  const base = c.baseUrl.replace(/\/+$/, '');
  const endpoint = /\/images\/generations$/.test(base) ? base : base + '/images/generations';
  const timeout = AbortSignal.timeout(180000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  inFlight++;
  try {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.apiKey }, body: JSON.stringify(payload), signal: combined, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw problem(`生图服务返回 HTTP ${response.status}，请检查模型、额度和接口配置`, 502); }
    let data; try { data = JSON.parse((await limitedBody(response, 30 * 1024 * 1024, combined)).toString('utf8')); }
    catch (e) { if (e.status) throw e; throw problem('生图服务返回非 JSON 或连接中断', 502); }
    const item = data.data?.[0]; let bytes;
    if (item?.b64_json) {
      if (typeof item.b64_json !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(item.b64_json)) throw problem('图片 base64 内容无效', 502);
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (item?.url) {
      let url; try { url = new URL(item.url); } catch { throw problem('图片下载地址无效', 502); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw problem('图片下载地址无效', 502);
      const image = await fetch(url, { signal: combined, redirect: 'error' });
      if (!image.ok) throw problem('生成成功，但图片下载失败，请重试', 502);
      bytes = await limitedBody(image, 20 * 1024 * 1024, combined);
    } else throw problem('生图服务未返回 data[0].b64_json 或 data[0].url', 502);
    if (bytes.length > 20 * 1024 * 1024) throw problem('图片超过 20MB', 502);
    const ext = imageExtension(bytes);
    combined.throwIfAborted();
    if (!await stillEnabled()) throw problem('用户已关闭生图，本次结果未写入工程', 403);
    const relative = 'assets/generated-' + crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 20) + '.' + ext;
    await fs.mkdir(path.join(projectDir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(projectDir, relative), bytes);
    return { ok: true, url: relative, size: bytes.length, model: c.model, revisedPrompt: String(item.revised_prompt || '').slice(0, 24000) };
  } catch (e) {
    if (e.status) throw e;
    if (combined.aborted) throw problem(signal?.aborted ? '生图已取消' : '生图超过 3 分钟，请重试', 504);
    throw problem('连接生图服务失败，请检查服务地址与网络', 502);
  } finally { inFlight--; }
}
