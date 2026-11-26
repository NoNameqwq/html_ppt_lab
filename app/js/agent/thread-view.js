import { h, copyText } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { createStreamMarkdown } from './markdown.js';
import { mergeContinuation } from './conversation.js';
import { getToolMeta } from './tools.js';
import { formatElapsed } from './generation-time.js';

const glyph = (name, size = 15) => h('span', { class: 'agw-glyph', html: icon(name, size) });
const button = (label, name, action) => h('button', { type: 'button', class: 'agw-icon', title: label, 'aria-label': label, onClick: action }, glyph(name));

/** Chronological progress while running; one collapsible process and a visible final answer. */
export function createThreadView({ streaming = false, scroll, resume, undo, versions, rewind, fork, openProject, getElapsedMs }) {
  const el = h('article', { class: 'agw-turn', 'aria-label': '助手回复', 'data-running': String(streaming) });
  const ledger = h('details', { class: 'agw-ledger hidden', open: true });
  const ledgerLabel = h('span', {}, '正在处理');
  const ledgerBody = h('div', { class: 'agw-ledger-body' });
  ledger.append(h('summary', {}, glyph('chevron-down', 12), ledgerLabel), ledgerBody);
  const foot = h('div', { class: 'agw-turn-actions hidden' });
  const copy = button('复制回复', 'copy', async () => {
    await copyText(parts.map((p) => p.content).filter(Boolean).join('\n\n'));
    copy.replaceChildren(glyph('check')); setTimeout(() => copy.replaceChildren(glyph('copy')), 1200);
  });
  const again = h('button', { type: 'button', class: 'agw-text-button hidden', onClick: () => resume() }, glyph('play', 12), '继续处理');
  const note = h('span', { class: 'agw-turn-note' });
  const version = h('button', { type: 'button', class: 'agw-text-button agw-turn-version hidden', onClick: () => versions?.() }, glyph('history', 13), '本轮版本');
  const revert = h('button', { type: 'button', class: 'agw-text-button hidden', onClick: () => rewind?.() }, glyph('undo', 13), '回溯到此处');
  const branch = h('button', { type: 'button', class: 'agw-text-button hidden', onClick: () => fork?.() }, glyph('copy', 13), '从此处分支');
  const deliveries=h('div',{class:'agw-deliveries hidden'});
  foot.append(copy, again, version, revert, branch, note); el.append(ledger, deliveries, foot);
  const parts = [], tools = new Map();
  let previewCleanup=[];
  let part = null, continued = false, finished = false, incomplete = false, stopped = false, failureCount = 0;
  const started = performance.now();
  let savedDuration=0,replayed=false;
  function refreshTiming() {
    if(!finished)return;
    const elapsed=Number(getElapsedMs?.())||savedDuration||(replayed?0:performance.now()-started),duration=elapsed>0?'用时 '+formatElapsed(elapsed):'';
    note.textContent=[stopped?'已停止':incomplete?'尚未完成':'',duration,stopped?'进度已保留':''].filter(Boolean).join(' · ');
  }
  function beginRound() {
    if (continued && parts.length) { continued = false; part = parts.at(-1); part.carry = part.content; return; }
    closePart();
    const md = h('div', { class: 'agw-prose hidden' }); ledgerBody.append(md);
    part = { md, content: '', carry: '', stream: createStreamMarkdown(md, { minInterval: 60 }), thought: null }; parts.push(part);
    ledger.classList.remove('hidden');
  }
  function current() { if (!part) beginRound(); return part; }
  function closePart() { if (part) { part.stream.finish(part.content); part = null; } }
  function ensureTool(call) {
    if (tools.has(call.id)) return tools.get(call.id);
    ledger.classList.remove('hidden');
    const meta = getToolMeta(call.function.name), detail = h('details', { class: 'agw-operation', 'data-state': 'pending' });
    let args; try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
    const target = call.function.name === 'browser_use' ? (args.url || args.action || '') :
      args.path || args.name || args.operation || args.elementId || (Number.isInteger(args.index) ? '第 ' + (args.index + 1) + ' 页' : '');
    const label = h('span', { class: 'agw-operation-label' }, meta.label), targetLabel = h('span', { class: 'agw-operation-target' }, String(target)), mark = h('span', { class: 'agw-operation-mark' });
    detail.append(h('summary', {}, glyph(meta.kind === 'read' ? 'terminal' : 'edit'), label, targetLabel, mark));
    const more = h('div', { class: 'agw-operation-detail' }); detail.append(more); ledgerBody.append(detail);
    const workerList=h('div',{class:'agw-workers hidden','aria-label':'并行子代理进度'}),workerRows=new Map();
    detail.after(workerList);
    const workerStates={pending:'等待中',running:'生成中',tool:'查看工程',complete:'已完成',error:'失败',stopped:'已停止'};
    function setWorkers(workers=[]){
      if(!workers.length)return;
      workerList.classList.remove('hidden');
      for(const worker of workers){
        let row=workerRows.get(worker.id);
        if(!row){
          const node=h('details',{class:'agw-worker','data-state':worker.status||'pending'}),name=h('strong',{},worker.id),model=h('small',{}),state=h('span',{class:'agw-worker-state'}),body=h('div',{class:'agw-worker-body'}),task=h('p',{class:'agw-worker-task'}),output=h('pre',{class:'agw-worker-output'}),error=h('p',{class:'agw-worker-error',role:'status'});
          node.append(h('summary',{},glyph('cpu',13),h('span',{class:'agw-worker-name'},name,model),state),body);body.append(task,output,error);workerList.append(node);
          row={node,name,model,state,task,output,error,worker:null};
          row.render=()=>{if(!node.open)return;task.textContent=row.worker.task||'';output.textContent=row.worker.content||'尚无输出';error.textContent=row.worker.error||'';};node.addEventListener('toggle',row.render);workerRows.set(worker.id,row);
        }
        const artifactLabel={svg:'SVG 绘图',three:'3D 建模',analysis:'分析核查'}[worker.artifact];
        row.worker=worker;row.node.dataset.state=worker.status||'pending';row.name.textContent=[artifactLabel,worker.label||worker.role||'子代理',worker.id].filter(Boolean).join(' · ');row.model.textContent=worker.model||'';row.state.textContent=workerStates[worker.status]||worker.status;row.render();
      }
      const done=workers.filter(w=>w.status==='complete').length;
      targetLabel.textContent=`${done}/${workers.length} 完成`;
      scroll();
    }
    let result = null, rendered = false;
    const render = () => {
      if (!detail.open || rendered) return; rendered = true;
      more.append(h('div', { class: 'agw-detail-label' }, call.function.name), h('pre', {}, JSON.stringify(args, null, 2)));
      if (result) {
        more.append(h('div', { class: 'agw-detail-label' }, '返回结果'), h('pre', {}, JSON.stringify({...result,images:undefined,workers:undefined}, null, 2)));
        for(const src of result.images||[])if(/^data:image\//.test(src))more.append(h('img',{class:'agw-capture-preview',src,alt:'Agent 查看的页面画面'}));
      }
      if (result?.url) more.append(h('a', { href: result.url, target: '_blank', rel: 'noopener' }, '打开结果 ↗'));
      if (result?.opId) {
        const revert = h('button', { type: 'button', class: 'agw-text-button', onClick: async () => {
          revert.disabled = true;
          try { await undo(result.opIds?.length ? result.opIds : [result.opId]); revert.textContent = '已撤回'; }
          catch (err) { revert.disabled = false; revert.textContent = err.message; }
        } }, '撤回这次修改'); more.append(revert);
      }
    };
    detail.addEventListener('toggle', render);
    const row = {
      el: detail,
      setWorkers,
      setState(state) { detail.dataset.state = state; ledgerLabel.textContent = meta.label + (target ? ' · ' + target : ''); scroll(); },
      setResult(value) {
        const wasError=detail.dataset.state==='error';
        result = value; detail.dataset.state = value?.ok === false || value?.error ? 'error' : value?.status==='running'?'running':'done';
        if(value?.workers)setWorkers(value.workers);
        if(wasError)failureCount=Math.max(0,failureCount-1);
        if (detail.dataset.state === 'error') { mark.textContent = '失败'; failureCount++; }
        else mark.textContent=detail.dataset.state==='running'?'后台运行':'';
        if (value?.summary) targetLabel.textContent = value.summary;
        rendered = false; more.replaceChildren(); render(); scroll();
      },
      setMissing() { this.setResult({ ok: false, error: '操作被中止，未取得结果；请先检查当前状态。' }); },
    };
    tools.set(call.id, row); return row;
  }
  return {
    el, beginRound, ensureTool,
    setDeliveries(items=[]) {
      previewCleanup.forEach((f)=>f());previewCleanup=[];
      deliveries.replaceChildren();deliveries.classList.toggle('hidden',!items.length);
      for(const item of items) {
        if(!item.projectId||!item.versionId)continue;
        const root=`/api/projects/${encodeURIComponent(item.projectId)}/versions/${encodeURIComponent(item.versionId)}`;
        const preview=h('div',{class:'agw-delivery-preview'}),frame=h('iframe',{src:root+'/preview?wpx=thumb&slide=0',title:item.name+' · 交付预览',sandbox:'allow-scripts',loading:'lazy',tabindex:'-1','aria-hidden':'true'});
        preview.append(frame);
        const resize=new ResizeObserver(()=>{frame.style.transform=`scale(${preview.clientWidth/1920})`;});resize.observe(preview);
        frame.addEventListener('load',()=>{frame.style.transform=`scale(${preview.clientWidth/1920})`;},{once:true});
        const play=h('a',{class:'agw-delivery-play',href:root+'/present',target:'_blank',rel:'noopener'},glyph('play',14),'放映');
        const edit=h('button',{type:'button',class:'agw-text-button',onClick:()=>openProject?.(item.projectId)},glyph('edit',13),'编辑');
        const download=h('a',{class:'agw-text-button',href:root+'/export',download:''},glyph('download',13),'导出');
        const card=h('section',{class:'agw-delivery','aria-label':'对话交付'},preview,h('div',{class:'agw-delivery-info'},h('span',{class:'agw-delivery-caption'},item.status==='partial'?'进度版本':'本轮交付'),h('strong',{},item.name),h('small',{},`${item.slideCount} 页 · 已保存此轮版本`),h('div',{class:'agw-delivery-actions'},play,edit,download)));
        deliveries.append(card);
        // Disconnect detached previews when conversation history is rebuilt.
        const observer=new MutationObserver(()=>{if(!el.isConnected){resize.disconnect();observer.disconnect();}});observer.observe(document.getElementById('agent-panel'),{childList:true,subtree:true});previewCleanup.push(()=>{resize.disconnect();observer.disconnect();});
      }
      scroll();
    },
    setVersion(available) { version.classList.toggle('hidden', !available); revert.classList.toggle('hidden', !available || !rewind); branch.classList.toggle('hidden', !available || !fork); },
    setContent(text) { const p = current(); p.content = mergeContinuation(p.carry, text); p.md.classList.remove('hidden'); p.stream.update(p.content); scroll(); },
    setReasoning(text) {
      const p = current();
      if (!p.thought) {
        ledger.classList.remove('hidden');
        const body = h('div', { class: 'agw-thought-text' }), label = h('span', {}, '思考中');
        p.thought = h('details', { class: 'agw-thought' }, h('summary', {}, glyph('brain', 14), label, glyph('chevron-down', 11)), body);
        p.thought.body = body; p.thought.label = label; ledgerBody.insertBefore(p.thought,p.md);
      }
      p.thought.body.textContent = text;
    },
    setToolCalls(calls) { (calls || []).forEach(ensureTool); },
    toolStart(call) { ensureTool(call).setState('running'); },
    toolResult(call, result) { ensureTool(call).setResult(result); },
    parallelUpdate(event){const row=tools.get(event.toolCallId);if(row)row.setResult(event);},
    noteRoundEnd(msg, meta = {}) {
      if(Number(msg.duration)>0)savedDuration=Number(msg.duration);
      const p = current();
      if (typeof msg.content === 'string') { p.content = msg.content; p.stream.finish(p.content); p.md.classList.toggle('hidden', !p.content); }
      if (p.thought) p.thought.label.textContent = '查看思考过程';
      incomplete = !!msg.incomplete || !!meta.incomplete; stopped = !!msg.aborted || !!meta.aborted;
    },
    finishRound(msg, meta) { this.noteRoundEnd(msg, meta); closePart(); },
    setRole(meta) {
      const p=current();
      if(!p.role) {p.role=h('div',{class:'agw-role', 'data-role':meta.role},glyph(meta.role==='review'?'check-circle':'cpu',13),h('span',{},meta.label),h('small',{},meta.model||''));ledgerBody.insertBefore(p.role,p.thought||p.md);}
    },
    continuation(info) { continued = true; ledgerLabel.textContent = info.unexpected ? '连接恢复中…' : '继续生成…'; },
    reopen() { finished = false; incomplete = false; stopped = false; foot.classList.add('hidden'); el.dataset.running = 'true';for(const p of parts)if(p.md.parentNode===el){p.md.classList.remove('agw-final');ledgerBody.append(p.md);}ledger.open = true; return this; },
    disableResume() { again.classList.add('hidden'); },
    refreshTiming,
    hasContent() { return parts.some((p) => p.content) || tools.size > 0; },
    finish(msg = {}, meta = {}) {
      if (finished) return; finished = true; closePart(); stopped ||= !!meta.aborted; incomplete ||= !!meta.incomplete;
      el.dataset.running = 'false';
      // Only the last prose response stays outside the collapsed process. Earlier
      // commentary, thoughts, and tools keep their original execution order.
      const final=parts.findLast(p=>p.content);
      if(final){final.md.classList.add('agw-final');el.insertBefore(final.md,deliveries);}
      ledgerLabel.textContent = tools.size ? `已执行 ${tools.size} 项操作${failureCount ? ' · ' + failureCount + ' 项失败' : ''}` : '查看思考过程';
      ledger.classList.toggle('hidden',!ledgerBody.querySelector('.agw-operation,.agw-thought,.agw-role')&&!parts.some(p=>p!==final&&p.content));
      ledger.open = failureCount > 0 || incomplete || stopped;
      foot.classList.remove('hidden'); again.classList.toggle('hidden', !stopped && !incomplete);
      replayed=!!meta.replay;refreshTiming();
      if (!parts.some((p) => p.content) && !tools.size && !incomplete && !stopped) el.remove(); scroll();
    },
  };
}
