import { estimateTokens } from './markdown.js';
import { memorySource, memoryChunk, messageTokens, turnBoundaries } from './conversation.js';
import { COMPACTION_PROMPT } from './compaction.js';

export function isContextOverflow(error) {
  const text = [error?.code, error?.message].filter(Boolean).join(' ');
  return /context_length_exceeded|context_window_exceeded|prompt_too_long|maximum context|context (?:window|length).*(?:exceed|limit|long|large)|(?:input|prompt|request|messages?).*(?:too (?:long|large)|exceed.*(?:token|context))|(?:token|context).*(?:limit|exceed).*(?:input|prompt)|上下文.{0,20}(?:超|不足)|超.{0,10}(?:上下文|令牌)/i.test(text);
}

// Each request is bounded by the memory model's own window. Nothing is committed
// until every segment has a complete response, including re-compacting old memory.
export async function summarizeContext({ source, previous = '', model, targetTokens, request, signal, sessionId, onUsage, contextLimit = Infinity }) {
  const limit = Math.min(contextLimit, Number(model.info?.contextLength) || 131072);
  const output = Math.max(1, Math.min(4096, Number(model.info?.maxOutput || model.info?.max_output_tokens) || 4096, Math.floor(limit * .2), targetTokens));
  let memory = previous, scale = .85, retries = 0;
  const header = text => [{ role: 'system', content: COMPACTION_PROMPT }, { role: 'user', content: '【已有记忆】\n' + text + `\n\nReturn a COMPLETE updated memory within ${Math.max(32,Math.floor(output*.65))} tokens. Prioritize current goals, exact identifiers, completed actions and next steps; do not copy long code. Full source remains preserved for retrieval.\n\n【接续记录】\n` }];
  if (messageTokens(header(memory)) + output + 256 > limit * scale || estimateTokens(memory) > targetTokens) {
    source = 'Previous durable memory (conversation data):\n' + memory + '\n\n' + source;
    memory = '';
  }
  do {
    if (signal?.aborted) throw new DOMException('已停止压缩', 'AbortError');
    const messages = header(memory), overhead = messageTokens(messages);
    const chunkBudget = Math.floor(limit * scale) - output - overhead - 32;
    if (chunkBudget < 128) throw new Error('压缩模型窗口无法容纳工作记忆，请配置更大窗口的压缩模型。完整记录已保留。');
    const chunk = memoryChunk(source, chunkBudget, text => messageTokens([messages[0], { role: 'user', content: messages[1].content + text }]) - overhead);
    messages[1].content += chunk;
    let next = '', finish;
    try {
      await request({ providerId: model.providerId, model: model.model, sessionId, messages, tools: [], maxTokens: output, temperature: .2 }, e => {
        if (e.type === 'delta') next += e.content || '';
        if (e.type === 'done' && !e.incomplete) finish = e.finish_reason;
        if (e.type === 'usage') onUsage?.(e.usage);
      }, signal);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      if (isContextOverflow(error) && retries++ < 2) { scale *= .7; continue; }
      throw new Error('上下文压缩模型「' + model.model + '」请求失败：' + error.message + '。完整记录已保留，可检查设置后继续。');
    }
    if (signal?.aborted) throw new DOMException('已停止压缩', 'AbortError');
    if (!next.trim() || !['stop', 'end_turn'].includes(finish)) throw new Error('对话记忆整理未完成，完整记录已保留，可点击继续重试。');
    memory = next; source = source.slice(chunk.length);
  } while (source.length);
  return memory;
}

// Fold only whole assistant/tool batches. Folding a current turn is essential:
// a resumed single long turn has no earlier user boundary to compact.
export async function fitConversation({ history, summary, prefix, tools, budget, render, summarize, results, force = false, onCompacting }) {
  let memory = summary && Number.isInteger(summary.through) && summary.through >= 0 && summary.through <= history.length ? summary : null;
  const latest = history.findLastIndex(m => m.role === 'user' && !m.synthetic && !m.versionEvent);
  const fixed = messageTokens(prefix) + estimateTokens(JSON.stringify(tools));
  const room = budget - fixed;
  if (room < 512) throw new Error('系统指令和工具定义已占满当前模型窗口，压缩聊天无法腾出空间。请提高上下文上限或选择更大窗口的对话模型；完整记录已保留。');
  const targetTokens = Math.max(128, Math.min(4096, Math.floor(room * .4)));
  const reference = (message, label, suffix = false) => {
    const original = render([message]);
    if (messageTokens(original) <= Math.min(2400, room * .2)) return original;
    const id = 'context-' + (message.id || message.tool_call_id || history.indexOf(message));
    const text = memorySource([message]); results?.set(id, text);
    const preview = memoryChunk(text, Math.max(128, Math.min(800, room * .08)));
    const tail = suffix ? '\nSaved output ends with:\n' + text.slice(-Math.min(1600, Math.floor(room * .2))) : '';
    return [{ role: message.role === 'user' ? 'user' : 'assistant', content: preview + tail + `\n[Full ${label} preserved: ${text.length} characters, resultId:${id}. Read with tool_result_read {resultId:"${id}",offset:0,limit:12000}. This is a preview; do not repeat the saved output.]` }];
  };
  const assemble = () => {
    const through = memory?.through || 0;
    const anchor = latest >= 0 && through > latest ? reference(history[latest], 'user request') : [];
    const last = history.at(-1);
    const continuation = through === history.length && last?.role === 'assistant' && last.incomplete && !last.tool_calls?.length ? reference(last, 'incomplete output', true) : [];
    return [...prefix, ...(memory?.text ? [{ role: 'system', content: '【持久对话记忆】\n' + memory.text }] : []), ...anchor, ...render(history.slice(through)), ...continuation];
  };
  let messages = assemble();
  const cost = () => messageTokens(messages) + estimateTokens(JSON.stringify(tools));
  if (!force && cost() <= budget) return { messages, summary: memory, changed: false };
  onCompacting?.();
  const start = memory?.through || 0;
  const previousBoundary = turnBoundaries(history, start).at(-1);
  const boundaries = !force && previousBoundary > start ? [previousBoundary, history.length] : [history.length];
  for (const through of [...new Set(boundaries)]) {
    const text = await summarize(memorySource(history.slice(memory?.through || 0, through)), memory?.text || '', targetTokens);
    memory = { through, text };
    messages = assemble();
    if (cost() <= budget) return { messages, summary: memory, changed: true };
  }
  throw new Error('压缩后的工作记忆仍超出当前模型窗口。完整记录已保留，请提高对话模型上下文上限或选用更大窗口的模型。');
}
