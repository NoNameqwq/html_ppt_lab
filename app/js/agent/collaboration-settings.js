import { h } from '../core/dom.js';
import { AGENT_ROLES, normalizeCollaboration } from './collaboration.js';

export function createCollaborationForm(getProviders,value) {
  const draft=normalizeCollaboration(value),el=h('section',{class:'ais-collaboration'},
    h('strong',{},'子代理协作'),h('p',{class:'ais-help'},'「极高」使用下方三角色模型；子任务后台并行时，主模型继续独立工作，在依赖整合和验收节点按需等待。检查可退回修改。其他思考等级的子代理使用当前对话模型。3D 制作先派发场景与交互等任务，再整合检查。设计和检查角色建议选支持图片的模型。留空跟随聊天默认配置。'));
  const render=()=>{
    el.querySelectorAll('.ais-role').forEach(n=>n.remove());
    for(const role of AGENT_ROLES) {
      const cfg=draft[role.id],providers=getProviders();
      const provider=h('select',{class:'input','aria-label':role.label+'服务'},h('option',{value:''},'跟随聊天默认服务'),...providers.map(p=>h('option',{value:p.id},p.name)));
      provider.value=cfg.providerId;
      const list=h('datalist',{id:'ais-role-models-'+role.id});
      const model=h('input',{class:'input',value:cfg.model,list:list.id,placeholder:'留空跟随默认模型','aria-label':role.label+'模型'});
      const populate=()=>{const p=providers.find(p=>p.id===provider.value);list.replaceChildren(...(p?.models||[]).map(m=>h('option',{value:m.id||m.name})));};populate();
      provider.addEventListener('change',()=>{cfg.providerId=provider.value;cfg.model='';model.value='';populate();});
      model.addEventListener('input',()=>{cfg.model=model.value.trim();});
      el.append(h('div',{class:'ais-role','data-role':role.id},h('div',{},h('b',{},role.label),h('p',{},role.description)),h('div',{class:'ais-role-inputs'},provider,model,list)));
    }
  };
  render();return {el,refresh:render,getValue:()=>normalizeCollaboration(draft)};
}
