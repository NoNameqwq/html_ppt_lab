/**
 * WebDeck Studio · Mock AI 服务（OpenAI 兼容，用于 Agent E2E）
 * 启动：node scripts/mock-ai.mjs [port]
 * - GET  /v1/models              → 模型列表（带上下文长度）
 * - POST /v1/chat/completions    → 流式；首轮返回 deck_set_text 工具调用，收到 tool 结果后返回总结文本
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || process.env.MOCK_AI_PORT || 4399);
const MODELS = [
  { id: 'mock-tool', name: 'Mock Tool', context_length: 131072, tool_call: true, reasoning: true },
  { id: 'mock-chat', name: 'Mock Chat', context_length: 65536, tool_call: true },
];

function sse(res, data) {
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS }));
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const toolName = body.tools?.[0]?.function?.name;
    console.log('[mock-ai] chat', body.model, 'msgs=' + messages.length, 'toolResult=' + hasToolResult, 'text=' + userText.slice(0, 60));

    if (!body.stream) {
      if (!hasToolResult) {
        const el = /(e[0-9a-z]{4,})/i.exec(userText)?.[1] || 'e1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-1', object: 'chat.completion', model: body.model,
          choices: [{
            index: 0, finish_reason: 'tool_calls',
            message: {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'deck_set_text', arguments: JSON.stringify({ elementId: el, html: 'MOCK 文本' }) } }],
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-2', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '已完成修改：把该元素的文字改成了「MOCK 文本」。可以在右侧修改记录里撤回。' } }],
        usage: { prompt_tokens: 160, completion_tokens: 30, total_tokens: 190 },
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const base = { id: 'mock-stream', object: 'chat.completion.chunk', model: body.model, choices: [] };
    if (!hasToolResult) {
      const el = /(e[0-9a-z]{4,})/i.exec(userText)?.[1] || 'e1';
      const args = JSON.stringify({ elementId: el, html: 'MOCK 文本' });
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { content: '好的，我来修改这个元素。' }, finish_reason: null }] });
      await sleep(60);
      const half = Math.ceil(args.length / 2);
      sse(res, {
        ...base,
        choices: [{
          index: 0, finish_reason: null,
          delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'deck_set_text', arguments: args.slice(0, half) } }] },
        }],
      });
      await sleep(40);
      sse(res, {
        ...base,
        choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }],
      });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      const text = '已完成修改：把该元素的文字改成了「MOCK 文本」。这次修改已经记入历史，可以单条撤回。';
      sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
      for (let i = 0; i < text.length; i += 8) {
        sse(res, { ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + 8) }, finish_reason: null }] });
        await sleep(20);
      }
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 160, completion_tokens: 40, total_tokens: 200 } });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => console.log('[mock-ai] listening on http://127.0.0.1:' + PORT));
