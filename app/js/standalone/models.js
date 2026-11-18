import { proxyChat } from '../../../server/agent-proxy.mjs';

export const networkHint = (e) => e instanceof TypeError ? new Error('浏览器无法连接此 API。请检查网络、Base URL，以及服务商是否允许跨域 CORS（本地文件 Origin: null）；也可切换 BAT 后端模式。') : e;
export async function remote(fetcher, url, init) { try { return await fetcher(url, init); } catch (e) { throw networkHint(e); } }
export function modelInfo(raw) {
  const id = typeof raw === 'string' ? raw : raw.id || raw.name;
  return { ...(typeof raw === 'object' ? raw : {}), id, name: raw.name || id,
    contextLength: Number(raw.contextLength || raw.context_length || raw.context_window) || 131072,
    maxOutput: Number(raw.maxOutput || raw.max_output_tokens) || 16384, tools: raw.tools !== false, vision: raw.vision === true || /gpt|claude|gemini|vision/i.test(id), reasoning: /reason|gpt|claude|gemini|deepseek/i.test(id) };
}
export async function fetchModels(fetcher, config, image = false, signal) {
  const base = (config.baseUrl || '').replace(/\/+$/, '').replace(/\/images\/generations$/, '');
  if (!/^https?:\/\//.test(base) || !config.apiKey) throw new Error('请填写 API Key 和 HTTP(S) Base URL');
  const headers={Authorization:'Bearer '+config.apiKey};
  if(!image&&config.wire==='anthropic')Object.assign(headers,{'x-api-key':config.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'});
  const response = await remote(fetcher, base + '/models', { headers, signal: signal || AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('获取模型失败：HTTP ' + response.status);
  const data = await response.json(), list = Array.isArray(data) ? data : data.data || data.models || [];
  let models = list.map(modelInfo).filter((m) => m.id);
  if (image) models = models.filter((m) => /gpt-image|chatgpt-image|dall-e|imagen|flux|stable-diffusion/i.test(m.id) || m.capabilities?.image_generation || m.output_modalities?.includes('image'));
  if (!models.length) throw new Error('服务未返回' + (image ? '可识别的生图' : '') + '模型，可在高级选项中指定 ID');
  if (image) models.sort((a,b) => Number(/gpt.*image/i.test(b.id))-Number(/gpt.*image/i.test(a.id)) || b.id.localeCompare(a.id,undefined,{numeric:true}));
  return { models, source: 'upstream', recommended: models[0].id };
}
export function chatResponse(fetcher, config, body, signal) {
  let streamController, ended = false; const listeners = new Set(), encoder = new TextEncoder();
  const end = () => { if (!ended) { ended = true; streamController.close(); } };
  const res = {
    get destroyed() { return ended; }, get writableEnded() { return ended; },
    writeHead() {}, flushHeaders() {}, on(_, fn) { listeners.add(fn); }, off(_, fn) { listeners.delete(fn); },
    write(text) { if (!ended) streamController.enqueue(encoder.encode(text)); }, end,
  };
  const stream = new ReadableStream({ start(controller) { streamController = controller; }, cancel() { for (const fn of listeners) fn(); ended = true; } });
  signal?.addEventListener('abort', () => { for (const fn of listeners) fn(); end(); }, { once: true });
  const model = body.model || config.model, wire = config.wire === 'auto' ? /claude|anthropic/i.test(model) ? 'anthropic' : 'openai' : config.wire || 'openai';
  if (!config.baseUrl || !config.apiKey || !model) throw new Error('请先配置对话服务、API Key 和模型');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey };
  if (wire === 'anthropic') Object.assign(headers, { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  // Reuse the same streaming parser and compatibility retries as the Node backend.
  // The global fetch adapter passes absolute upstream URLs to native fetch.
  queueMicrotask(() => proxyChat({ req: {}, res, wire, headers, base: config.baseUrl.replace(/\/+$/, ''), model, messages: body.messages || [], tools: body.tools || [],
    maxTokens: body.maxTokens || 16384, temperature: body.temperature ?? .7, stream: body.stream !== false,
    reasoningEffort: body.reasoning_effort === 'auto' ? '' : body.reasoning_effort, toolChoice: body.toolChoice?.function?.name || '' }).catch((e) => { res.write('data: '+JSON.stringify({type:'error',message:networkHint(e).message})+'\n\n');end(); }));
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
