import { randomBytes } from 'node:crypto';
import { readSSE } from '../app/js/core/sse.js';
import { isSendableMessage } from '../app/js/core/chat-messages.js';

function openAIMessage(m) {
  if (m.role === 'assistant') {
    const out = { role: m.role, content: m.content || null };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    // Required by reasoning providers when a tool turn is continued.
    if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
    return out;
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content || '') };
  return { role: m.role, content: m.content };
}

function anthropicPayload(options) {
  const { model, messages, tools, maxTokens, temperature, stream, toolChoice } = options;
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    let role = m.role, content;
    if (role === 'tool') {
      role = 'user';
      content = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') }];
    } else if (role === 'assistant') {
      content = m.content ? [{ type: 'text', text: String(m.content) }] : [];
      for (const c of m.tool_calls || []) content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') });
      if (!content.length) continue;
    } else {
      content = typeof m.content === 'string' ? [{ type: 'text', text: m.content || ' ' }] : m.content.map((b) => {
        if (b.type !== 'image_url') return b;
        const url = b.image_url.url;
        const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
        return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
      });
    }
    if (out.at(-1)?.role === role) out.at(-1).content.push(...content);
    else out.push({ role, content });
  }
  const payload = { model, messages: out, max_tokens: maxTokens, stream };
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  if (system) payload.system = system;
  if (temperature != null) payload.temperature = temperature;
  if (tools.length) payload.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  if (toolChoice) payload.tool_choice = { type: 'tool', name: toolChoice };
  return payload;
}

async function postCompatible(url, headers, payload, signal) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    if (res.ok) return res;
    const detail = await res.text();
    if ([400, 422].includes(res.status)) {
      const removable = ['temperature', 'reasoning_effort', 'stream_options', 'tool_choice'].find((key) => key in payload && detail.includes(key));
      if (removable) { delete payload[removable]; continue; }
      if ('max_tokens' in payload && /max_completion_tokens/.test(detail)) {
        payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; continue;
      }
      const key = 'max_tokens' in payload ? 'max_tokens' : 'max_completion_tokens';
      if (payload[key] > 1024 && /max[_\s-]?(?:completion[_\s-]?)?tokens|maximum.*tokens|out of range|too large/i.test(detail)) {
        const match = /(?:at most|maximum(?: is| of|:)?|less than or equal to)\s*(\d+)/i.exec(detail);
        payload[key] = Math.min(payload[key] - 1, match ? Number(match[1]) : Math.floor(payload[key] / 2));
        continue;
      }
    }
    let message;
    try { const data = JSON.parse(detail); message = data.error?.message || data.message; } catch { /* non-JSON error */ }
    const err = new Error(message || `模型服务返回 ${res.status}：${detail.slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }
  throw new Error('模型参数不兼容，请检查模型和输出上限设置。');
}

/** One honest terminal event; never turn a broken upstream into a successful stop. */
export async function proxyChat({ req, res, wire, headers, base, ...options }) {
  const controller = new AbortController();
  let timeout, heartbeat;
  const touch = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(new Error('模型服务长时间没有响应，请重试。')), 180000); };
  const send = (event) => { if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(event) + '\n\n'); };
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnect);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 10000);
  touch();
  const calls = new Map();
  let finish = null, complete = false, usage = null;
  const callAt = (index) => {
    if (!calls.has(index)) calls.set(index, { id: '', type: 'function', function: { name: '', arguments: '' } });
    return calls.get(index);
  };
  try {
    const { model, messages, tools, maxTokens, temperature, stream, reasoningEffort, toolChoice } = options;
    const anthropic = wire === 'anthropic';
    // Older browser tabs may still send interrupted reasoning as an empty assistant turn.
    const outbound = messages.filter(isSendableMessage);
    const payload = anthropic ? anthropicPayload({ ...options, messages: outbound }) : { model, messages: outbound.map(openAIMessage), stream, max_tokens: maxTokens, temperature };
    if (!anthropic) {
      if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
      if (tools.length) { payload.tools = tools; payload.tool_choice = toolChoice ? { type: 'function', function: { name: toolChoice } } : 'auto'; }
      if (stream) payload.stream_options = { include_usage: true };
    }
    const upstream = await postCompatible(base + (anthropic ? '/messages' : '/chat/completions'), headers, payload, controller.signal);
    touch();
    if ((upstream.headers.get('content-type') || '').includes('application/json')) {
      const data = await upstream.json();
      if (data.error) throw new Error(data.error.message || String(data.error));
      if (anthropic) {
        for (const b of data.content || []) {
          if (b.type === 'text') send({ type: 'delta', content: b.text });
          if (b.type === 'thinking') send({ type: 'reasoning', content: b.thinking });
          if (b.type === 'tool_use') Object.assign(callAt(calls.size), { id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input) } });
        }
        finish = data.stop_reason;
      } else {
        const choice = data.choices?.[0], msg = choice?.message || {};
        if (msg.content) send({ type: 'delta', content: msg.content });
        if (msg.reasoning_content) send({ type: 'reasoning', content: msg.reasoning_content });
        (msg.tool_calls || []).forEach((c, i) => Object.assign(callAt(i), c));
        finish = choice?.finish_reason;
      }
      usage = data.usage;
      complete = !!finish;
    } else {
      for await (const event of readSSE(upstream.body, { signal: controller.signal })) {
        touch();
        if (event.data === '[DONE]') { complete = true; continue; }
        const data = JSON.parse(event.data);
        if (data.error || event.event === 'error') throw new Error(data.error?.message || data.message || '模型服务流错误');
        if (anthropic) {
          const type = event.event || data.type, block = data.content_block, delta = data.delta;
          if (type === 'message_start') usage = { ...data.message?.usage };
          if (type === 'content_block_start') {
            if (block?.type === 'tool_use') Object.assign(callAt(data.index), { id: block.id, function: { name: block.name, arguments: '' } });
            if (block?.text) send({ type: 'delta', content: block.text });
            if (block?.thinking) send({ type: 'reasoning', content: block.thinking });
          }
          if (type === 'content_block_delta') {
            if (delta?.text) send({ type: 'delta', content: delta.text });
            if (delta?.thinking) send({ type: 'reasoning', content: delta.thinking });
            if (delta?.partial_json) callAt(data.index).function.arguments += delta.partial_json;
          }
          if (type === 'message_delta') { finish = delta?.stop_reason || finish; usage = { ...usage, ...data.usage }; }
          if (type === 'message_stop') complete = true;
        } else {
          if (data.usage) usage = data.usage;
          const choice = data.choices?.[0];
          if (!choice) continue;
          finish = choice.finish_reason || finish;
          const delta = choice.delta || {};
          if (delta.content) send({ type: 'delta', content: delta.content });
          if (delta.reasoning_content || delta.reasoning) send({ type: 'reasoning', content: delta.reasoning_content || delta.reasoning });
          for (const part of delta.tool_calls || []) {
            const c = callAt(part.index ?? 0);
            if (part.id) c.id = part.id;
            if (part.function?.name) c.function.name += part.function.name;
            if (part.function?.arguments) c.function.arguments += part.function.arguments;
          }
        }
      }
    }
    if (calls.size) {
      const list = [...calls].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ ...c, id: c.id || 'call_' + randomBytes(8).toString('hex') }));
      // Full snapshots are separate from argument deltas, so clients cannot append twice.
      send({ type: 'tool_calls', tool_calls: list, snapshot: true });
    }
    if (usage) {
      const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0), output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
      send({ type: 'usage', usage: { ...usage, prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
    }
    const reason = ({ end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length' })[finish] || finish;
    send({ type: 'done', finish_reason: reason || (complete ? (calls.size ? 'tool_calls' : 'stop') : null), incomplete: !finish && !complete });
  } catch (err) {
    if (!res.destroyed) send({ type: 'error', message: controller.signal.reason?.message || err.message, status: err.status || 0, recoverable: !err.status || err.status === 429 || err.status >= 500 });
  } finally {
    clearTimeout(timeout); clearInterval(heartbeat);
    res.off('close', disconnect);
    if (!res.destroyed) res.end();
  }
}
