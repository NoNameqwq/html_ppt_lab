export const AGENT_ROLES = [
  { id:'design', label:'设计与关键代码', description:'制定方案、拆分任务、实现关键逻辑，最后整理交付。' },
  { id:'implement', label:'代码实现', description:'按设计完成各部分代码和大量内容，保留设计约束。' },
  { id:'review', label:'检查', description:'只读核对页面、源码和修改结果，提出问题或通过验收。' },
];
export function normalizeCollaboration(value={}) {
  return Object.fromEntries(AGENT_ROLES.map(({id})=>[id,{providerId:String(value?.[id]?.providerId||'').trim(),model:String(value?.[id]?.model||'').trim()}]));
}
export function resolveCollaboration(ctx, active, findModel, providers, savedModels) {
  const config=normalizeCollaboration(savedModels||ctx.store.get().settings?.agent?.collaboration);
  return Object.fromEntries(AGENT_ROLES.map(({id})=>{
    const choice=config[id],providerId=choice.providerId||active.providerId;
    const provider=providers.find(p=>p.id===providerId);
    const model=choice.model||(choice.providerId?(provider?.model||provider?.models?.[0]?.id):active.model);
    if(!provider?.keySet||!model)throw new Error(`子代理「${AGENT_ROLES.find(r=>r.id===id).label}」未配置可用模型，请检查 API 设置中的三角色模型。`);
    const info=findModel(providers,providerId,model);
    if(info.tools===false)throw new Error(`子代理「${AGENT_ROLES.find(r=>r.id===id).label}」的模型 ${model} 不支持工具调用，请在 API 设置中更换支持工具的模型。`);
    return [id,{providerId,model,info}];
  }));
}
export const handoffDefinition={type:'function',function:{name:'agent_handoff',description:'Hand off to another configured role, request corrections or approve the result. State concrete files, element IDs, constraints and acceptance criteria. Preserve unrelated work.',parameters:{type:'object',properties:{target:{type:'string',enum:['design','implement','review','complete']},task:{type:'string',description:'Concrete implementation task, review findings or evidence for approval.'}},required:['target','task']}}};

export function collaborationPrompt(team) {
  const roleInstructions={
    design:'You are the design and key-code agent. Inspect the project and define a content-specific visual system, original navigation and code structure. Implement key logic, then hand off high-output page implementation to implement. Inspect rendered views with deck_capture_slide when vision is available. Fix design issues returned by review, then hand off for implementation or rechecking.',
    implement:'You are the implementation agent. Follow the shared design and concrete task; actually edit the project through tools. Preserve other work. Capture and refine modified pages when vision is available. Hand off to review with changes and checks, or return major design questions to design.',
    review:'You are the independent read-only reviewer. Read real source/state and use deck_capture_slide to inspect actual rendered pages when vision is available. Check hierarchy, clipping, alignment, labels, navigation, requirements and code. Do not trust earlier claims of completion. Return concrete implementation defects to implement and design defects to design, with element IDs, measured coordinates and suggested fixes. Use target=complete only after actual inspection; state checks and limitations, including unavailable visual inspection. Never claim tests you did not run.',
    final:'You are the lead design agent delivering the result after review approval. This phase is read-only. Explain actual changes, checks and limitations in the user\'s language. Further edits must return to design and pass review again.',
  };
  const models=AGENT_ROLES.map(r=>`${r.id}: ${team.models?.[r.id]?.model||'configured model'}`).join('; ');
  return `## Three-role collaboration\nCurrent phase: ${team.phase}; revisions: ${team.revisions||0}.\nReal model routing is enabled: ${models}. A successful agent_handoff invokes the target model; no shell or external subprocess is needed. Do not simulate delegation in prose or claim agents are unavailable.\n${roleInstructions[team.phase]}\nUse agent_parallel to dispatch 2–4 independent background tasks: each task routes to its configured design, implement or review model and dispatch returns immediately. Continue independent design, key code and page implementation while workers run. Use agent_parallel_status for non-blocking progress. Call agent_wait at dependency boundaries, selecting batchId and taskIds when only certain outputs are needed. Before handoff to review or final approval, collect all complete artifacts, integrate required code and inspect the actual result. In particular, split complex 3D generation into scene/geometry and interaction/validation work. Workers inspect with read-only tools and return complete code; only the coordinator applies edits through normal tools to preserve consistency and checkpoints. Worker observations describe a changing snapshot. Advisory parallel review is not approval of future edits. Use agent_handoff for dependent phase transitions.\nCall agent_handoff with target and a concrete task, files, constraints and acceptance criteria. Earlier assistant messages include other roles; execute only the current role.\nCurrent task (user/project data):\n${team.task||'Complete the user request.'}\n${team.visualLimitation?'Visual capture limitation (disclose; do not claim visual QA passed): '+team.visualLimitation:''}\nUse the user\'s language for commentary and final answers. All permissions, versioning, stopping and recovery rules remain in effect.`;
}
export function handoff(team, target, task) {
  if(!['design','implement','review','complete'].includes(target))return {ok:false,error:'未知交接目标'};
  if(!String(task||'').trim())return {ok:false,error:'需要具体任务或检查依据'};
  if(target===team.phase)return {ok:false,error:'不能把任务交回当前角色，请继续当前工作'};
  if(target==='complete'&&team.phase!=='review')return {ok:false,error:'只有检查代理可以通过验收'};
  if(target==='complete'&&!team.reviewReads)return {ok:false,error:'请先调用只读工具检查真实工程，再根据结果决定通过或退回。'};
  if(target==='complete'&&team.visualReviewRequired&&!team.reviewCaptureAttempted)return {ok:false,error:'请先调用 deck_capture_slide 查看实际页面画面，再提交检查结论。'};
  if(team.phase==='design'&&target==='review'&&!team.implemented)return {ok:false,error:'请先把实现任务交给 implement，完成后再检查。'};
  if(team.phase==='final'&&target!=='design')return {ok:false,error:'最终交付若需修改，请先交回设计代理'};
  if(target==='review'&&team.phase==='review')return {ok:false,error:'请给出检查结论'};
  const from=team.phase,next=target==='complete'?'final':target;
  if((from==='review'&&next!=='final')||next==='design')team.revisions=(team.revisions||0)+1;
  team.phase=next;team.task=String(task);team.transitions=(team.transitions||0)+1;
  if(from==='implement')team.implemented=true;
  if(next==='review'){team.reviewReads=0;team.reviewCaptureAttempted=false;team.reviewCaptures=0;team.visualLimitation='';}
  return {ok:true,from,to:next,summary:`${from} → ${next}：${task}`};
}
