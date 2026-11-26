import { estimateTokens } from './markdown.js';
import { memorySource, memoryChunk, messageTokens, turnBoundaries } from './conversation.js';
import { COMPACTION_PROMPT } from './compaction.js';

export const MAX_CHAT_BYTES = 8 * 1024 * 1024;
export const requestBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function isRequestTooLarge(error) {
  return error?.status === 413 || /请求体过大|request (?:body |entity |payload )?too large|payload too large|content too large/i.test(error?.message || '');
}
// Reserve room for durable memory before reserving output. A fixed large output
// allowance must not make an otherwise usable window fail before compaction.
export function fitRequestBudget(window, preferredOutput, prefix, tools, recovery = 0) {
  const reservedOutput = Math.min(preferredOutput, window.limit ? Math.floor(window.limit * .35) : preferredOutput);
  const total = Math.floor(window.budget * .8 ** recovery) + reservedOutput;
  const fixed = messageTokens(prefix) + estimateTokens(JSON.stringify(tools));
  const memoryRoom = Math.max(1024, Math.min(4096, Math.floor(total * .15)));
  const maxTokens = Math.max(1, Math.min(reservedOutput, total - fixed - memoryRoom));
  return { budget: total - maxTokens, maxTokens, fixed };
}

export function isContextOverflow(error) {
  const text = [error?.code, error?.message, error?.error?.code, error?.error?.message].filter(Boolean).join(' ');
  return /context_length_exceeded|context_window_exceeded|prompt_too_long|maximum context|context (?:window|length).*(?:exceed|limit|long|large)|(?:input|prompt|request|messages?).*(?:too (?:long|large)|exceed.*(?:token|context))|(?:token|context).*(?:limit|exceed).*(?:input|prompt)|上下文.{0,20}(?:超|不足)|超.{0,10}(?:上下文|令牌)/i.test(text);
}

function excerptMemory(previous, source, targetTokens) {
  const budget = Math.max(64, Math.floor(targetTokens * .8));
  const prior = memoryChunk(previous, Math.floor(budget / 4));
  const opening = memoryChunk(source, Math.floor(budget / 4));
  const recent = [...source.slice(Math.max(opening.length, source.length - budget * 4))].reverse().join('');
  const ending = [...memoryChunk(recent, Math.floor(budget / 2))].reverse().join('');
  return ['Local memory excerpts (conversation data; some history was omitted).', prior, opening, ending].filter(Boolean).join('\n\n');
}

// Each request is bounded by the memory model's own window. Partial model
// output is never committed as memory.
export async function summarizeContext({ source, previous = '', model, targetTokens, request, signal, sessionId, onUsage, contextLimit = Infinity }) {
  const limit = Math.min(contextLimit, Number(model.info?.contextLength) || 131072);
  const output = Math.max(1, Math.min(4096, Number(model.info?.maxOutput || model.info?.max_output_tokens) || 4096, Math.floor(limit * .2), targetTokens));
  let memory = previous, scale = .85, byteBudget = MAX_CHAT_BYTES * .5, retries = 0, incompleteRetries = 0;
  const header = text => [{ role: 'system', content: COMPACTION_PROMPT }, { role: 'user', content: '【已有记忆】\n' + text + `\n\nReturn a COMPLETE updated memory within ${Math.max(32,Math.floor(output*.65))} tokens. Prioritize current goals, exact identifiers, completed actions and next steps; do not copy long code. Full source remains preserved for retrieval.\n\n【接续记录】\n` }];
  if (messageTokens(header(memory)) + output + 256 > limit * scale || estimateTokens(memory) > targetTokens || requestBytes({ messages: header(memory) }) > byteBudget * .5) {
    source = 'Previous durable memory (conversation data):\n' + memory + '\n\n' + source;
    memory = '';
  }
  do {
    if (signal?.aborted) throw new DOMException('已停止压缩', 'AbortError');
    // A gateway can impose a tighter byte limit than the model's token window.
    // Re-fold existing memory too if it alone would consume the reduced request.
    if (memory && requestBytes({ messages: header(memory) }) > byteBudget * .5) {
      source = 'Previous durable memory (conversation data):\n' + memory + '\n\n' + source;
      memory = '';
    }
    const messages = header(memory), overhead = messageTokens(messages);
    const chunkBudget = Math.floor(limit * scale) - output - overhead - 32;
    if (chunkBudget < 128) return excerptMemory(memory, source, targetTokens);
    const chunk = memoryChunk(source, chunkBudget, text => {
      const candidate = [messages[0], { role: 'user', content: messages[1].content + text }];
      return requestBytes({ messages: candidate }) > byteBudget ? chunkBudget + 1 : messageTokens(candidate) - overhead;
    });
    messages[1].content += chunk;
    let next = '', finish;
    try {
      await request({ providerId: model.providerId, model: model.model, sessionId, messages, tools: [], maxTokens: output, temperature: .2,
        ...(incompleteRetries ? { stream: false } : {}) }, e => {
        if (e.type === 'delta') next += e.content || '';
        if (e.type === 'done' && !e.incomplete) finish = e.finish_reason;
        if (e.type === 'usage') onUsage?.(e.usage);
      }, signal);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      if ((isContextOverflow(error) || isRequestTooLarge(error)) && retries++ < 4) {
        if (isRequestTooLarge(error)) byteBudget *= .5;
        else scale *= .7;
        continue;
      }
      if ((incompleteRetries && (error.recoverable || error.status >= 500)) || isContextOverflow(error) || isRequestTooLarge(error)) {
        return excerptMemory(memory, source, targetTokens);
      }
      throw new Error('上下文压缩模型「' + model.model + '」请求失败：' + error.message + '。完整记录已保留，可检查设置后继续。');
    }
    if (signal?.aborted) throw new DOMException('已停止压缩', 'AbortError');
    if (!next.trim() || !['stop', 'end_turn'].includes(finish)) {
      if (++incompleteRetries <= 2) {
        scale = Math.max(.45, scale * .8);
        continue;
      }
      return excerptMemory(memory, source, targetTokens);
    }
    memory = next; source = source.slice(chunk.length);
  } while (source.length);
  return memory;
}

// Fold only whole assistant/tool batches. Folding a current turn is essential:
// a resumed single long turn has no earlier user boundary to compact.
export async function fitConversation({ history, summary, prefix, tools, budget, render, summarize, results, force = false, maxBytes = MAX_CHAT_BYTES, onCompacting }) {
  let memory = summary && Number.isInteger(summary.through) && summary.through >= 0 && summary.through <= history.length ? summary : null;
  const latest = history.findLastIndex(m => m.role === 'user' && !m.synthetic && !m.versionEvent);
  const fixed = messageTokens(prefix) + estimateTokens(JSON.stringify(tools));
  const room = budget - fixed;
  if (room < 512) throw new Error('系统指令和工具定义已占满当前模型窗口，压缩聊天无法腾出空间。请精简自定义指令、减少启用的 Skill，或提高上下文上限、选择更大窗口的对话模型；完整记录已保留。');
  if (requestBytes({ messages: prefix, tools }) > maxBytes * .8) throw new Error('系统指令和工具定义超过请求体大小限制，请减少启用的 Skill 或精简自定义指令。完整记录已保留。');
  const targetTokens = Math.max(128, Math.min(4096, Math.floor(room * .4)));
  const reference = (message, label, suffix = false, { shorten = false, omitImages = true } = {}) => {
    const original = render([message]);
    if (!shorten && messageTokens(original) <= Math.min(2400, room * .2) && requestBytes(original) < maxBytes * .15) return original;
    const id = 'context-' + (message.id || message.tool_call_id || history.indexOf(message));
    const text = memorySource([message]); results?.set(id, text);
    const preview = memoryChunk(text, Math.max(128, Math.min(800, room * .08)));
    const tail = suffix ? '\nSaved output ends with:\n' + text.slice(-Math.min(1600, Math.floor(room * .2))) : '';
    return [{ role: message.role === 'user' ? 'user' : 'assistant', content: preview + tail + (omitImages && message.images?.length ? '\n[Original image attachments remain saved in this conversation but were omitted from this request due to its size. Do not claim to have inspected omitted images; use project assets or request a smaller image if required.]' : '') + `\n[Full ${label} preserved: ${text.length} characters, resultId:${id}. Read with tool_result_read {resultId:"${id}",offset:0,limit:12000}. This is a preview; do not repeat the saved output.]` }];
  };
  const toolTokens = estimateTokens(JSON.stringify(tools));
  const fits = messages => messageTokens(messages) + toolTokens <= budget && requestBytes({ messages, tools }) <= maxBytes;
  const assemble = () => {
    const through = memory?.through || 0;
    const last = history.at(-1);
    const continuation = through === history.length && last?.role === 'assistant' && last.incomplete && !last.tool_calls?.length ? reference(last, 'incomplete output', true) : [];
    const head = [...prefix, ...(memory?.text ? [{ role: 'system', content: '【持久对话记忆】\n' + memory.text }] : [])];
    const tail = [...render(history.slice(through)), ...continuation];
    if (latest < 0 || through <= latest) return [...head, ...tail];

    const turn = history[latest];
    const original = render([turn]);
    const visuals = original.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === 'image_url') : []);
    const withAnchor = anchor => [...head, ...anchor, ...tail];
    if (!visuals.length) return withAnchor(reference(turn, 'user request'));
    if (fits(withAnchor(original))) return withAnchor(original);

    const [preview] = reference(turn, 'user request', false, { shorten: true, omitImages: false });
    const selected = [];
    const withImages = (images, omitted) => withAnchor([{
      role: 'user',
      content: [{ type: 'text', text: preview.content + (omitted ? `\n[${omitted} image attachment(s) did not fit in this request; they remain saved.]` : '') }, ...images],
    }]);
    for (const image of visuals) {
      const candidate = [...selected, image];
      if (fits(withImages(candidate, visuals.length - candidate.length))) selected.push(image);
    }
    return withImages(selected, visuals.length - selected.length);
  };
  let messages = assemble();
  if (!force && fits(messages)) return { messages, summary: memory, changed: false };
  onCompacting?.();
  const start = memory?.through || 0;
  const previousBoundary = turnBoundaries(history, start).at(-1);
  const boundaries = !force && previousBoundary > start ? [previousBoundary, history.length] : [history.length];
  for (const through of [...new Set(boundaries)]) {
    const text = await summarize(memorySource(history.slice(memory?.through || 0, through)), memory?.text || '', targetTokens);
    memory = { through, text };
    messages = assemble();
    if (fits(messages)) return { messages, summary: memory, changed: true };
  }
  throw new Error('压缩后的工作记忆仍超出当前模型窗口。完整记录已保留，请提高对话模型上下文上限或选用更大窗口的模型。');
}
