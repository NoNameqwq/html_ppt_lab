/* Local deterministic model for browser acceptance; never reads real provider keys. */
import http from 'node:http';
const port = Number(process.env.AGENT_MOCK_PORT || 4619);
const streams = new Map();
let generatedImages = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const text = '已经完成修改，整份演示的视觉节奏现在更加统一。\n\n### 这次做了什么\n\n- 读取工程与当前页面，保留原有内容。\n- 插入一句新的说明文字，修改已记录在历史中。\n- 检查页面状态，生成可以继续编辑的结果。\n\n| 项目 | 结果 |\n| --- | --- |\n| 工程状态 | 已保存 |\n| 内容检查 | 通过 |\n| 后续修改 | 可以继续 |\n\n你可以接着告诉我需要调整的细节。';
http.createServer(async (req, res) => {
  if (req.url === '/test/image-stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ generatedImages })); return; }
  if (req.url === '/v1/images/generations' && req.method === 'POST') {
    for await (const _ of req) { /* consume */ } generatedImages++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bZsAAAAASUVORK5CYII=' }] })); return;
  }
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'workspace-test', context_length: 131072, tool_call: true }] })); return; }
  let raw = ''; for await (const c of req) raw += c;
  const payload = JSON.parse(raw), msgs = payload.messages || [];
  const user = [...msgs].reverse().find((m) => m.role === 'user');
  const userText = typeof user?.content === 'string' ? user.content : user?.content?.find((b) => b.type === 'text')?.text || '';
  const names = new Map(msgs.flatMap((m) => (m.tool_calls || []).map((c) => [c.id, c.function.name])));
  const current = msgs.slice(msgs.lastIndexOf(user) + 1).map((m) => m.role === 'tool' ? { ...m, name: names.get(m.tool_call_id) } : m);
  const key = payload.model + JSON.stringify(user), n = streams.get(key) || 0;
  streams.set(key, n + 1);
  if (userText.includes('ERROR401')) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '模拟密钥错误' } })); return; }
  const send = (delta, finish = null) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
  const done = (reason = 'stop') => { send({}, reason); res.write('data: [DONE]\n\n'); res.end(); };
  const emitCalls = async (list) => {
    for (let i = 0; i < list.length; i++) {
      const c = list[i], half = Math.floor(c.function.arguments.length / 2);
      send({ tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments.slice(0, half) } }] });
      await sleep(45); send({ tool_calls: [{ index: i, function: { arguments: c.function.arguments.slice(half) } }] });
    }
    done('tool_calls');
  };
  if (payload.stream === false) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '非流式完整回答。' }, finish_reason: 'stop' }] })); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  if (userText.includes('IMAGE_INSERT_TEST')) {
    if (!current.some((m) => m.role === 'tool')) await emitCalls([call('image-insert-'+n,'deck_generate_image',{prompt:'知识花园中的一片叶子，柔和自然，右侧构图，留白',index:2,x:1450,y:700,w:240,h:200})]);
    else { send({content:'已生成配图并保存为本地素材，放入第三页。'}); done(); } return;
  }
  if(userText.includes('RICH_TEST')){
    const answer=String.raw`公式 $E=mc^2$，其中质量为 $m$。

$$\frac{-b\pm\sqrt{b^2-4ac}}{2a}$$

\`\`\`svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><rect x="40" y="50" width="260" height="150" rx="20" fill="#e8edff"/><text x="170" y="140" text-anchor="middle" font-size="32" fill="#243258">原因</text><path d="M330 125H490" stroke="#5267df" stroke-width="4"/><rect x="520" y="50" width="240" height="150" rx="20" fill="#e8edff"/><text x="640" y="140" text-anchor="middle" font-size="32" fill="#243258">结果</text></svg>
\`\`\`

图解与公式已完整显示。`.replaceAll('\\`','`');
    for(let i=0;i<answer.length;i+=30){if(res.destroyed)return;send({content:answer.slice(i,i+30)});await sleep(12);}done();return;
  }
  if(userText.includes('PPT_IMPORT_TEST')){
    if(!current.some((m)=>m.role==='tool'))await emitCalls([call('ppt-import-'+n,'app_call_api',{operation:'projects.import',body:{importId:/upload-[a-z0-9-]+/.exec(userText)?.[0],fileName:'fixture.pptx',pptMode:'editable'}})]);
    else{send({content:'已将 PowerPoint 解析为可编辑网页，原文件与转换报告已保存。'});done();}return;
  }
  if (userText.includes('DELETE_CURRENT_TEST')) {
    if (!current.some((m) => m.role === 'tool')) await emitCalls([call('delete-' + n, 'app_call_api', { operation: 'projects.delete' })]);
    else { send({ content: '当前测试工程已删除，对话保留在工作区。' }); done(); }
    return;
  }
  if (userText.includes('STOP_TEST')) {
    if (msgs.some((m) => m.role === 'system' && String(m.content).includes('继续完成用户上一次任务'))) { send({ content: '续接已完成，先前进度仍然保留。' }); done(); return; }
    send({ content: '停止测试：这段正文应当完整保留。' });
    const interval = setInterval(() => { if (!res.destroyed) send({ content: '正在生成更多内容。' }); }, 80);
    res.on('close', () => clearInterval(interval)); return;
  }
  if (userText.includes('LENGTH_TEST')) {
    send({ content: n === 0 ? '第一段：开场。' : n === 1 ? '第二段：继续。' : '第三段：完成。' }); done(n < 2 ? 'length' : 'stop'); return;
  }
  if (userText.includes('DROP_TEST')) {
    send({ content: n === 0 ? '断流前保留下来的文字。' : '重连后完整的后半段。' }); if (n === 0) res.end(); else done(); return;
  }
  if (userText.includes('LONG_TEST')) {
    const long = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段：这是用于验证长回答阅读的内容，用户向上滚动时不应被强制拉回底部。\n\n`).join('') + 'END_OF_LONG_REPLY';
    for (let i = 0; i < long.length; i += 70) { if (res.destroyed) return; send({ content: long.slice(i, i + 70) }); await sleep(20); }
    done(); return;
  }
  if (userText.includes('QUEUE_TEST')) { send({ content: '正在处理排队测试。' }); await sleep(2000); send({ content: '第一项已完成。' }); done(); return; }
  if (userText.includes('FOLLOWUP') || userText.includes('ATTACHMENT') || userText.includes('MEMORY_TEST')) {
    send({ content: '收到你的补充。' + (msgs.some((m) => String(m.content).includes('品牌色使用蓝色')) ? '仍然记得品牌色使用蓝色。' : '') }); done(); return;
  }
  if (!current.some((m) => m.role === 'tool')) {
    send({ content: '我会先检查工程，再调整当前页面并复核结果。' });
    send({ reasoning_content: '读取工程状态，找到可修改的页面与元素，保留原有设计内容。' });
    await sleep(150);
    await emitCalls([call('plan-' + n, 'update_plan', { plan: [{ title: '读取工程', status: 'running' }, { title: '修改页面', status: 'pending' }, { title: '检查结果', status: 'pending' }] }), call('read-' + n, 'deck_get_state', {})]); return;
  }
  if (!current.some((m) => m.role === 'tool' && m.name === 'deck_insert_text')) {
    send({ reasoning_content: '现在插入说明文字，并检查网页接口与工程信息。' });
    await emitCalls([call('insert-' + n, 'deck_insert_text', { text: 'Agent 全新工作台验收', x: 160, y: 700, w: 1200, h: 90, styles: { fontSize: '46px' } }), call('apis-' + n, 'app_list_apis', {}), call('get-' + n, 'app_call_api', { operation: 'projects.get' })]); return;
  }
  if (!current.some((m) => m.role === 'tool' && m.name === 'update_plan' && m.content.includes('已完成 3'))) {
    await emitCalls([call('verify-' + n, 'deck_get_state', {}), call('done-' + n, 'update_plan', { plan: [{ title: '读取工程', status: 'done' }, { title: '修改页面', status: 'done' }, { title: '检查结果', status: 'done' }] })]); return;
  }
  for (let i = 0; i < text.length; i += 8) { if (res.destroyed) return; send({ content: text.slice(i, i + 8) }); await sleep(18); }
  done();
}).listen(port, '127.0.0.1', () => console.log('Agent mock: http://127.0.0.1:' + port));
