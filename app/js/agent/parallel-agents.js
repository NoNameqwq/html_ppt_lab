import { uid } from '../core/dom.js';
import { createToolExecutor, getToolDefinitionsForPermission } from './tools.js';
import { findModel, getProviders, readAgentSettings } from './settings.js';
import { mergeContinuation, sanitizeConversation } from './conversation.js';
import { visualMessages } from './vision-messages.js';
import {visualWorkerPrompt} from './visual-authoring.js';
import {checkSvgArtifact} from './svg-artifact.js';
import { resolveCompaction } from './compaction.js';
import { fitConversation, fitRequestBudget, summarizeContext, isContextOverflow, isRequestTooLarge, MAX_CHAT_BYTES } from './context-recovery.js';

const ROLES = ['design', 'implement', 'review'];
const LABELS = { design: '设计', implement: '实现', review: '检查' };
const abortError = () => new DOMException('已停止并行子代理', 'AbortError');
const FINISH = ['stop', 'end_turn'];
export const parallelDefinition = { type: 'function', function: {
  name: 'agent_parallel',
  description: 'Dispatch 2–4 independent subagent tasks in the background and return immediately with a batchId. Use for detailed SVG illustration, interactive Three.js, and independent implementation tasks. Specify artifact:svg for complete SVG source, three for scene JSON/factory, analysis for plans or reviews. Provide sharedContext with coordinate/viewBox contract, assigned component bounds, anchors, ID prefixes, palette/fonts, layer order and acceptance criteria. Continue independent layout/code while workers run. Use agent_wait only at dependency boundaries; retrieve full artifacts and inspect the integrated project before delivery. Ordinary effort uses the current chat model; extreme effort uses the configured role models. Workers have read-only tools and cannot edit files or delegate. Reuse stable task IDs on retry; successful siblings are cached. A prospective review cannot approve later edits.',
  parameters: { type: 'object', properties: {
    sharedContext:{type:'string',maxLength:50000,description:'Shared drawing/scene contract and reference facts supplied to every worker. Include destination bounds, coordinate system, viewBox/units, component ownership/anchors, layer order, ID namespace, palette, labels and acceptance criteria.'},
    tasks: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: {
      id: { type: 'string', description: 'Stable ID for this task, preserved on retry.' },
      role: { type: 'string', enum: ROLES, description: 'Selects the configured role model only in extreme effort; otherwise uses the active chat model.' },
      artifact:{type:'string',enum:['svg','three','analysis'],description:'Expected deliverable. svg requires complete standalone SVG in a code fence; three requires complete scene JSON/factory code. analysis supplies plans or review evidence. Omit for general tasks.'},
      task: { type: 'string', description: 'Independent, concrete task. Ask for complete implementation code or evidence, shared interfaces and exact integration instructions.' },
    }, required: ['role', 'task'] } },
  }, required: ['tasks'] },
} };

export const parallelStatusDefinition = { type: 'function', function: {
  name: 'agent_parallel_status', description: 'Read background subagent progress and complete available artifacts without waiting. Omit batchId to inspect all batches in this user turn.',
  parameters: { type: 'object', properties: { batchId: { type: 'string' } } },
} };
export const parallelWaitDefinition = { type: 'function', function: {
  name: 'agent_wait', description: 'Wait at a dependency boundary for background subagent artifacts. Omit batchId to wait for all batches; provide batchId and taskIds to wait only for required workers while others continue. Completed outputs are returned in full. A timeout is normal: continue independent work or wait again. Errors and partial output remain visible; never integrate unfinished code.',
  parameters: { type: 'object', properties: { batchId: { type: 'string' }, taskIds: { type: 'array', minItems: 1, items: { type: 'string' } }, timeoutMs: { type: 'integer', minimum: 0, maximum: 60000, description: 'Maximum wait in milliseconds; default 30000. Zero returns immediately.' } } },
} };
export const parallelDefinitions = [parallelDefinition, parallelStatusDefinition, parallelWaitDefinition];

// Only creation/editing requests trigger automatic delegation. Ordinary questions,
// historical mentions and an explicit request to avoid 3D do not start workers.
export function needsParallel3D(text) {
  const s = String(text || '');
  if (!/(?:\b3\s*d\b|three\s*\.?\s*js|三维|立体结构)/i.test(s)) return false;
  if (/(?:不要|不用|无需|不使用|别做|不需要|without|do\s+not|don't)[^，,。！!；;\n]{0,18}(?:3\s*d|three\s*\.?\s*js|三维|立体结构)/i.test(s)) return false;
  if (/^(?:请问|解释|讲解|什么是|如何|怎么|介绍一下|what\s+is|how\s+(?:do|to)|explain\b|describe\b)/i.test(s.trim()) && !/(?:同时|并且|并|然后|and)\s*(?:请)?\s*(?:制作|构建|搭建|生成|实现|加入|添加|画出|绘制|创建|build|create|implement|generate|add|make)/i.test(s)) return false;
  return /制作|构建|搭建|生成|实现|加入|添加|画出|绘制|创建|修改|调整|设计|做(?:个|一个)|我想要|我要|给我|展示.*模型|\b(?:build|create|implement|generate|add|make|construct|model|render|design|edit)\b/i.test(s);
}

// Force specialist work for substantial, explicit drawing requests. A local
// label/color/position fix or a discussion of SVG must stay a focused edit.
export function needsParallelSVG(text) {
  const s=String(text||'').trim();
  const clauses=s.split(/[，,。！!；;\n]|\bbut\b/i);
  return clauses.some(clause=>{
    if(!/(?:\bsvg\b|矢量(?:图|绘|插画)|向量图)/i.test(clause))return false;
    if(/(?:不要|不用|无需|不使用|别|不需要|禁止|without|do\s+not|don't)\s*(?:(?:再|重新|使用|用|绘制|画|制作|生成|create|draw|generate|use)\s*){0,3}(?:svg|矢量|向量)/i.test(clause))return false;
    if(/(?:不要|不用|无需|不需要|不使用|without|do\s+not|don't)[^。！!；;\n]{0,16}(?:子代理|子智能体|并行|subagents?|delegat|parallel)/i.test(s))return false;
    if(/^(?:请问|解释|讲解|什么是|如何|怎么|介绍|what\s+is|how\s+(?:do|to)|explain\b|describe\b)/i.test(clause.trim())&&!/(?:同时|并且|并|然后|and)\s*(?:请)?\s*(?:制作|绘制|画|重绘|创建|生成|draw|create|generate)/i.test(clause))return false;
    if(/(?:只|仅|just|only)[^。!]{0,12}(?:改|调整|修改|change|edit|adjust)[^。!]{0,18}(?:颜色|字号|字体|标签|位置|描边|color|font|label|position|stroke)/i.test(clause))return false;
    return /(?:绘制|画出|画一|重绘|重画|重新[绘画做]|重做|制作|创建|生成|设计|精绘|丰富|精细化|完善(?:整幅|整个|这张|这幅)|详细绘|细化(?:整幅|整个|这张|这幅)|\b(?:draw|redraw|illustrate|create|generate|design|make|build|render|enrich)\b)/i.test(clause);
  });
}

export const needsParallelVisual=text=>needsParallel3D(text)||needsParallelSVG(text);
export const parallelVisualSubject=text=>[needsParallelSVG(text)?'SVG':null,needsParallel3D(text)?'3D':null].filter(Boolean).join(' / ')||'绘图';

function normalizeTasks(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) throw new Error('并行任务需要 2–4 个独立子任务');
  const ids = new Set();
  return value.map((v, i) => {
    const id = String(v?.id || `task-${i + 1}`).trim(), task = String(v?.task || '').trim(), role = v?.role || 'implement';
    if (!id || id.length > 100 || ids.has(id)) throw new Error('并行子任务 ID 必须唯一且不超过 100 字符');
    if (!ROLES.includes(role) || !task || task.length > 50000) throw new Error('并行子任务需要有效角色及 1–50000 字符的具体任务');
    if(v.artifact!==undefined&&!['svg','three','analysis'].includes(v.artifact))throw new Error('子任务 artifact 需为 svg、three 或 analysis');
    const artifact=v.artifact||(role!=='review'&&needsParallelSVG(task)?'svg':undefined);
    ids.add(id); return { id, role, task,...(artifact?{artifact}:{}) };
  });
}

export function prepareParallelBatch(turn, args, { active, team, toolCallId }) {
  const tasks = normalizeTasks(args.tasks);
  const sharedContext=args.sharedContext===undefined?'':args.sharedContext;
  if(typeof sharedContext!=='string'||sharedContext.length>50000)throw new Error('共享绘图契约需为不超过 50000 字符的文本');
  const signature = sharedContext?JSON.stringify({tasks,sharedContext}):JSON.stringify(tasks);
  turn.parallelRuns ||= [];
  const existing = turn.parallelRuns.find(b => b.signature === signature);
  if (existing) { existing.toolCallId=toolCallId; return existing; }
  const batch = { id: uid('parallel'), toolCallId, signature,sharedContext, status: 'pending', createdAt: Date.now(), workers: tasks.map(t => {
    const selected = team ? team.models[t.role] : active;
    if (!selected?.providerId || !selected?.model) throw new Error(`并行${LABELS[t.role]}代理缺少模型配置`);
    return { ...t, label: LABELS[t.role], providerId: selected.providerId, model: selected.model,
      status: 'pending', content: '', reasoning: '', messages: [], attempts: 0 };
  }) };
  turn.parallelRuns.push(batch); return batch;
}

const visibleWorker = w => Object.fromEntries(['id','role','label','task','artifact','artifactChecks','providerId','model','status','content','reasoning','error','startedAt','finishedAt'].filter(k => w[k] !== undefined).map(k => [k,w[k]]));
export function parallelResult(batch) {
  const complete = batch.workers.every(w => w.status === 'complete');
  const stopped = batch.workers.some(w => w.status === 'stopped');
  const running = batch.workers.some(w => ['pending','running','tool'].includes(w.status));
  return { ok: complete || running, accepted: true, complete, status: running ? 'running' : complete ? 'complete' : stopped ? 'stopped' : 'error', ...(stopped ? { aborted: true } : {}), batchId: batch.id,
    sharedContext:batch.sharedContext||'',workers: batch.workers.map(visibleWorker),
    summary: `并行子代理：${batch.workers.filter(w => w.status === 'complete').length}/${batch.workers.length} 完成`,
    ...(!complete && !running ? { error: stopped ? '并行生成已停止，完成的结果已保存；继续时仅恢复未完成子任务。' : '部分并行任务未完成，完整输出已保留。可用相同任务重试失败项。' } : {}),
    integration: running ? 'Continue independent work now. Use agent_wait at dependency boundaries; integrate only complete artifacts. Final review and delivery must account for every worker.' : 'Workers generated code and evidence without modifying shared files. Integrate complete outputs through normal project tools, then inspect the resulting pages. Parallel review does not approve later edits.',
  };
}

export function createParallelRunner({ ctx, request, systemPrompt, prepareSystemPrompt, maxOutput, limits, onUsage, onUpdate, save, withEditorTask }) {
  // Models stream concurrently; editor reads serialize so a temporary screenshot
  // page switch cannot leak another worker's page into a read or capture.
  let editorReads = Promise.resolve();
  const read = withEditorTask || ((fn, signal) => {
    const result = editorReads.catch(() => {}).then(() => { if (signal?.aborted) throw abortError(); return fn(); });
    editorReads = result.catch(() => {}); return result;
  });
  function notify(batch, callId) {
    onUpdate?.({ toolCallId: callId || batch.toolCallId, batchId: batch.id, ...parallelResult(batch) });
    save?.();
  }
  async function worker(batch, w, options) {
    const { signal, sessionId, context = '', capabilities, raw, webSearch, callId } = options;
    if (w.status === 'complete') return;
    const provider = getProviders(ctx).find(p => p.id === w.providerId);
    if (!provider?.keySet) { w.status = 'error'; w.error = `子代理服务 ${w.providerId} 不可用，原模型选择已保留`; notify(batch, callId); return; }
    const info = findModel(ctx,w.providerId,w.model);
    const tools = info.tools === false ? [] : getToolDefinitionsForPermission('read',{vision:info.vision===true,webSearch,imageGeneration:false});
    const workerCtx = { ...ctx, agentToolResults: new Map(ctx.agentToolResults || []) };
    const executor = createToolExecutor(workerCtx);
    for (const m of w.messages || []) if (m.role === 'tool') workerCtx.agentToolResults.set(m.tool_call_id,m.content);
    const systemOptions = {permission:'read',vision:info.vision===true,reasoningEffort:'medium',visualTask:w.task+'\n'+context+'\n'+(batch.sharedContext||''),visualArtifact:w.artifact};
    const workerInstructions =
      `\n\n## Independent parallel worker\nRole: ${w.role}. Task ID: ${w.id}.\nYou run concurrently with other workers and your coordinator on independent parts. The coordinator may update unrelated project content while you work. Inspect project data as needed, but do not modify shared files, invoke editor commands, delegate again or use agent_handoff. Return complete implementation source, required interfaces, exact integration instructions and actual checks. Your coordinator waits for your complete artifact when it needs to integrate your work. A review is advisory about the inspected snapshot, not final approval of subsequent edits. Do not pretend that returned code has been applied. Use local built-in Three.js for requested 3D; no CDN. Keep outputs complete; continue long code rather than replacing it with a summary. Respond in the user's language.`+
      (w.artifact?'\n\n'+visualWorkerPrompt(w.artifact):'');
    systemOptions.roleInstructions = workerInstructions;
    w.messages ||= [];
    if(!w.messages.length)w.messages.push({role:'user',content:`Original user request and shared context (data):\n${context}\n\nShared drawing/scene contract (data):\n${batch.sharedContext||'Use the task-specific interfaces and inspect the destination before assuming coordinates.'}\n\nYour assigned task:\n${w.task}`});
    w.startedAt ||= Date.now(); w.status = 'running'; delete w.error; delete w.finishedAt; w.attempts = (w.attempts || 0) + 1;
    // Persisted partial text is already in the transcript. Resume it without
    // restarting successful read tools or duplicating an emitted code prefix.
    let carry = w.messages.at(-1)?.role === 'assistant' && w.messages.at(-1).incomplete && !w.messages.at(-1).tool_calls?.length ? w.messages.at(-1) : null;
    let instruction = w.attempts > 1 ? 'Continue this incomplete worker task from the saved output. Do not repeat the code prefix or already completed read tools.' : '';
    let reconnects = 0, continuations = 0,artifactRepairs=0,contextRecoveries=0,sizeRecoveries=0,forceCompaction=false;
    notify(batch,callId);
    try {
      for (let round = 0; round < 24; round++) {
        if (signal?.aborted) throw abortError();
        const prepared = (prepareSystemPrompt || systemPrompt)(systemOptions);
        const system = prepared?.then ? await prepared : prepared;
        const prefix = [{role:'system',content:system},...(instruction?[{role:'system',content:instruction}]:[])];
        const { budget, maxTokens } = fitRequestBudget(limits(info),maxOutput(info),prefix,tools,contextRecoveries);
        let memoryModel;
        const fitted = await fitConversation({history:w.messages,summary:w.summary,
          prefix,
          tools,budget,force:forceCompaction,maxBytes:MAX_CHAT_BYTES * .5 ** sizeRecoveries,results:workerCtx.agentToolResults,
          render:history=>visualMessages(sanitizeConversation(history),m=>{
            if(m.role==='tool')return {role:'tool',tool_call_id:m.tool_call_id,content:m.content};
            if(m.role==='user')return {role:'user',content:m.content};
            const out={role:'assistant',content:m.content||''};if(m.tool_calls?.length){out.tool_calls=m.tool_calls;if(m.reasoning)out.reasoning_content=m.reasoning;}return out;
          },info.vision===true),
          summarize:async(source,previous,targetTokens)=>{
            memoryModel ||= resolveCompaction(readAgentSettings(ctx).compaction,w,getProviders(ctx),findModel);
            return summarizeContext({source,previous,targetTokens,model:memoryModel,request,signal,onUsage,
              contextLimit:Number(readAgentSettings(ctx).contextLimit)||131072,
              sessionId:`${sessionId}:parallel:${batch.id}:${w.id}:compaction`});
          }});
        if(fitted.changed){w.summary={...fitted.summary,providerId:memoryModel.providerId,model:memoryModel.model};notify(batch,callId);}
        const messages=fitted.messages;forceCompaction=false;
        const acc = {content:'',reasoning:'',calls:[]};
        let finish = null, failure;
        try {
          await request({providerId:w.providerId,model:w.model,sessionId:`${sessionId}:parallel:${batch.id}:${w.id}`,
            messages,tools,maxTokens,reasoning_effort:w.role==='implement'?'medium':'high'},e=>{
            if(signal?.aborted)return;
            if(e.type==='delta'){acc.content+=e.content||'';w.content=mergeContinuation(w.messages.filter(m=>m.role==='assistant').map(m=>m.content||'').join('\n\n'),acc.content);notify(batch,callId);}
            if(e.type==='reasoning'){acc.reasoning+=e.content||'';w.reasoning=acc.reasoning;notify(batch,callId);}
            if(e.type==='usage')onUsage?.(e.usage);
            if(e.type==='done')finish=e.incomplete?null:e.finish_reason;
            if(e.type==='tool_calls'){
              if(e.snapshot!==false)acc.calls=e.tool_calls||[];
              else for(const p of e.tool_calls||[]){const i=p.index??0;acc.calls[i]||={id:p.id,type:'function',function:{name:'',arguments:''}};const c=acc.calls[i];if(p.id)c.id=p.id;c.function.name+=p.function?.name||'';c.function.arguments+=p.function?.arguments||'';}
            }
          },signal);
        } catch(e) { failure=e; }
        const calls = acc.calls.filter(Boolean);
        let valid=true;
        for(const c of calls)try{const a=JSON.parse(c.function.arguments||'{}');if(!a||typeof a!=='object'||Array.isArray(a))valid=false;}catch{valid=false;}
        const truncated=['length','max_tokens'].includes(finish), interrupted=!!failure||!finish||truncated||!valid||signal?.aborted;
        const usableCalls = interrupted ? [] : calls;
        let message;
        if(carry&&!usableCalls.length){carry.content=mergeContinuation(carry.content,acc.content);carry.reasoning=(carry.reasoning||'')+acc.reasoning;message=carry;
          if(w.summary?.through>w.messages.indexOf(carry))w.summary={...w.summary,through:w.messages.indexOf(carry)};
        }
        else if(acc.content||acc.reasoning||usableCalls.length){message={role:'assistant',content:acc.content,...(acc.reasoning?{reasoning:acc.reasoning}:{}),...(usableCalls.length?{tool_calls:usableCalls}:{})};w.messages.push(message);}
        if(message)message.incomplete=interrupted;
        w.content=w.messages.filter(m=>m.role==='assistant'&&m.content).map(m=>m.content).join('\n\n');notify(batch,callId);
        if(signal?.aborted)throw abortError();
        if(failure&&((isRequestTooLarge(failure)&&sizeRecoveries<3)||(isContextOverflow(failure)&&contextRecoveries<2))){
          if(isRequestTooLarge(failure))sizeRecoveries++;else contextRecoveries++;
          forceCompaction=true;
          carry=message?.role==='assistant'&&!message.tool_calls?.length?message:carry;continue;
        }
        if(failure||!finish){
          const retryable=!failure||failure.recoverable===true||(!failure.status&&failure.recoverable!==false)||[429,502,503,504].includes(failure.status);
          if(!retryable||++reconnects>2)throw failure||new Error('子代理连接多次中断，已保存完整进度');
          carry=message?.role==='assistant'&&!message.tool_calls?.length?message:null;
          instruction='The previous connection ended incompletely. Continue after the saved prefix without repetition. Reissue any unfinished tool call in complete valid JSON; it was not executed.';continue;
        }
        reconnects=0;
        if(truncated||!valid){
          if(++continuations>12)throw new Error('子代理达到连续输出上限，完整进度已保存，可继续');
          carry=message?.role==='assistant'&&!message.tool_calls?.length?message:null;
          instruction=calls.length?'The previous tool arguments were incomplete and not executed. Reissue complete valid JSON.':'Continue exactly after the previous code/text without repeating the saved prefix.';continue;
        }
        if(['refusal','content_filter'].includes(finish))throw new Error('子代理模型未完成请求，已保留输出');
        instruction='';carry=null;
        if(!usableCalls.length){
          if(!FINISH.includes(finish)||!w.content.trim())throw new Error('子代理没有返回完整可见结果');
          if(w.artifact==='svg'){
            w.artifactChecks=checkSvgArtifact(w.content);
            if(!w.artifactChecks.ok){
              if(++artifactRepairs>2)throw new Error('SVG 子代理未交付完整可用源码：'+w.artifactChecks.error);
              instruction='Your SVG artifact is not complete: '+w.artifactChecks.error+' Reissue the FULL corrected standalone SVG in one svg code fence, followed by integration notes. Preserve the required semantic detail; do not summarize or return only a plan.';
              notify(batch,callId);continue;
            }
          }
          w.status='complete';w.finishedAt=Date.now();notify(batch,callId);return;
        }
        w.status='tool';notify(batch,callId);
        for(const call of usableCalls){
          const args=JSON.parse(call.function.arguments||'{}');
          const result=await read(()=>executor.execute(call.function.name,args,{permission:'read',raw,capabilities,webSearch,signal}),signal);
          const {images,...text}=result;
          const m={role:'tool',tool_call_id:call.id,name:call.function.name,content:JSON.stringify(text),...(call.function.name==='deck_capture_slide'&&images?.length?{images}:{})};
          w.messages.push(m);workerCtx.agentToolResults.set(call.id,m.content);notify(batch,callId);
        }
        w.status='running';notify(batch,callId);
      }
      throw new Error('子代理达到 24 步上限，进度已保存，可继续');
    } catch(e) {
      w.messages=sanitizeConversation(w.messages);w.status=signal?.aborted?'stopped':'error';w.error=e.message;w.finishedAt=Date.now();notify(batch,callId);
    }
  }
  return async (batch,options) => {
    batch.status='running';notify(batch,options.callId);
    await Promise.all(batch.workers.map(w=>worker(batch,w,options)));
    batch.status=batch.workers.every(w=>w.status==='complete')?'complete':options.signal?.aborted?'stopped':'error';
    notify(batch,options.callId);return parallelResult(batch);
  };
}
