import { estimateTokens } from './markdown.js';

export function mergeContinuation(previous, incoming) {
  if (!previous) return incoming;
  if (!incoming) return previous;
  // Providers occasionally repeat the end of the preceding segment after reconnecting.
  const max = Math.min(previous.length, incoming.length, 12000);
  for (let n = max; n >= 24; n--) if (previous.endsWith(incoming.slice(0, n))) return previous + incoming.slice(n);
  return previous + incoming;
}

export function sanitizeConversation(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || !['user', 'assistant', 'tool'].includes(m.role) || m.synthetic) continue;
    if (m.role === 'tool') continue;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const results = new Map();
      let j = i + 1;
      while (messages[j]?.role === 'tool') { results.set(messages[j].tool_call_id, messages[j]); j++; }
      out.push(m);
      for (const call of m.tool_calls) out.push(results.get(call.id) || {
        role: 'tool', tool_call_id: call.id, name: call.function.name,
        content: JSON.stringify({ ok: false, interrupted: true, error: '执行被中止，未取得结果；先检查工程现状，避免重复修改。' }),
      });
      i = j - 1;
    } else out.push(m);
  }
  return out;
}

export function messageTokens(messages) {
  return messages.reduce((sum,m)=>{
    let images=0;
    const text=JSON.stringify(m,(key,value)=>{
      if(key==='image_url'&&value?.url){images++;return {detail:value.detail||'auto',url:'[image]'};}
      if(key==='images'&&Array.isArray(value)){images+=value.length;return '[stored images]';}
      return value;
    });
    return sum+8+estimateTokens(text)+images*1600;
  },0);
}

export function turnBoundaries(messages, start = 0) {
  return messages.map((m, i) => m.role === 'user' && i >= start && !m.synthetic ? i : -1).filter((i) => i >= 0);
}

export function memorySource(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      let r;
      try { r = JSON.parse(m.content); } catch { return `工具 ${m.name}: 已返回结果，可通过 tool_result_read 读取 ${m.tool_call_id}`; }
      return `工具 ${m.name} (${m.tool_call_id}): ` + JSON.stringify({ ok: r.ok, summary: r.summary, error: r.error, path: r.path, elementId: r.elementId, opId: r.opId });
    }
    return `${m.role}: ${m.brief ? m.brief + '\n\n' : ''}${m.content || ''}` + (m.tool_calls?.length ? '\n工具调用: ' + JSON.stringify(m.tool_calls) : '')
      + (m.assetPaths?.length ? '\nAsset paths: ' + m.assetPaths.join(', ') : '')
      + (m.docs?.length ? '\n附件：' + m.docs.map((d) => `${d.name} (resultId:${d.resultId}，可用 tool_result_read 分页读取)`).join('；') : '');
  }).join('\n\n');
}

// Bound every summarization request, including conversations imported from older versions.
export function memoryChunk(text, budget, measure = estimateTokens) {
  if (!text.length) return '';
  let lo = 1, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
  }
  let end = lo;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  end = Math.max(1, end);
  return text.slice(0, end);
}
export function memoryChunks(text, budget) {
  const chunks = [];
  while (text.length) {
    const chunk = memoryChunk(text, budget);
    chunks.push(chunk); text = text.slice(chunk.length);
  }
  return chunks;
}
