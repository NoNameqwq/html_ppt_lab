import { h } from '../core/dom.js';

export function initThreeAuthoring(ctx) {
  const execute=async(args)=>{
    const {createToolExecutor}=await import('../agent/tools.js');
    const result=await createToolExecutor(ctx).execute('deck_insert_3d',args,{permission:'full'});
    if(!result.ok)throw new Error(result.error);
    return result;
  };
  ctx.bus.registerCommand('insert.three',async(payload={})=>{
    try {
      if(!ctx.getEditor()?.ready)throw new Error('请先打开一个工程');
      if(payload.scene||payload.code)return await execute(payload);
      let elementId=payload.elementId||ctx.store.get().selection?.elementId,existing=null;
      if(elementId)try {
        const res=await ctx.getEditor().bridge.call('getElementHtml',{elementId});
        const source=new DOMParser().parseFromString(res.html,'text/html').querySelector('[data-wds-three-scene]');
        if(source)existing=JSON.parse(source.textContent);
      }catch{}
      if(!existing)elementId=null;
      const label=h('input',{class:'input','aria-label':'结构名称',value:existing?.label||'可交互的三维结构'});
      const source=h('textarea',{class:'input author-source','aria-label':'3D 场景结构 JSON',spellcheck:'false'});
      source.value=JSON.stringify(existing?.scene||{background:null,camera:{position:[5,4,7],target:[0,0,0]},objects:[{id:'core',geometry:{type:'icosahedron',args:[1.5,1]},material:{color:'#7e8fff',roughness:.3,metalness:.2}},{type:'grid',size:10,divisions:10}]},null,2);
      const code=h('textarea',{class:'input author-source','aria-label':'自定义 Three.js 代码',spellcheck:'false',placeholder:'const mesh = new THREE.Mesh(...); root.add(mesh);'});
      code.value=existing?.code||'';
      const error=h('p',{class:'author-error',role:'status'});
      return await ctx.dialog.open({title:existing?'编辑 3D 结构':'插入 3D 结构',sub:'可从基础结构开始，再让 Agent 按要求构建复杂模型。引擎和操控器随网页离线导出。',width:'lg',body:h('div',{},h('label',{},'结构名称',label),h('label',{},'场景结构',source),h('details',{},h('summary',{},'高级：自定义 Three.js 代码'),code),h('p',{class:'author-hint'},'编辑时点击「操控 3D」。鼠标拖动旋转，滚轮缩放，右键拖动平移；触摸支持单指旋转和双指缩放、平移。'),error),actions:[{label:'取消',kind:'ghost'},{label:existing?'更新结构':'插入结构',kind:'primary',onClick:async()=>{try{return await execute({scene:JSON.parse(source.value),code:code.value,label:label.value,elementId});}catch(e){error.textContent=e.message;return false;}}}]});
    }catch(error){ctx.toast.error(error.message);return {ok:false,error:error.message};}
  },{label:'交互式 3D 结构',group:'插入',icon:'box'});
}
