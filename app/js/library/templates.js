import {h,readFileAsDataURL} from '../core/dom.js';

export function initTemplateLibrary(ctx) {
  const fail=(e)=>ctx.toast.error(e.message);
  ctx.bus.registerCommand('templates.save',()=>saveTemplate(ctx).catch(fail),{label:'保存为自定义模板',group:'文件',icon:'save'});
  ctx.bus.registerCommand('templates.import',()=>importTemplate(ctx).catch(fail),{label:'导入模板',group:'文件',icon:'import'});
  ctx.bus.registerCommand('templates.manage',()=>manageTemplates(ctx).catch(fail),{label:'管理模板',group:'文件',icon:'layout'});
}
export async function saveTemplate(ctx) {
  const project=ctx.store.get().project;if(!project)throw new Error('请先打开要保存为模板的工程');
  const name=h('input',{class:'input',value:project.name+' · 模板','aria-label':'模板名称',maxlength:'80'}),desc=h('textarea',{class:'input',placeholder:'模板说明（可选）','aria-label':'模板说明'});
  return ctx.dialog.open({title:'保存为自定义模板',sub:'保存当前内容、字体、版式和素材，之后可以从模板新建工程',body:h('div',{class:'author-fields'},name,desc),actions:[{label:'取消',kind:'ghost'},{label:'保存模板',kind:'primary',onClick:async()=>{try{const saved=await ctx.getEditor()?.saveNow({reason:'template'});if(saved?.ok===false)throw new Error(saved.error||'工程保存失败');const result=await ctx.api.saveTemplate({projectId:project.id,name:name.value,desc:desc.value});ctx.toast.ok('模板已保存');return result;}catch(e){ctx.toast.error(e.message);return false;}}}]});
}
export async function importTemplate(ctx) {
  const name=h('input',{class:'input',placeholder:'模板名称（可选）','aria-label':'模板名称',maxlength:'80'}),file=h('input',{class:'input',type:'file',accept:'.html,.htm,.zip,.ppt,.pptx','aria-label':'模板文件'}),html=h('textarea',{class:'input author-source',placeholder:'也可以在此粘贴完整 HTML 模板','aria-label':'自定义 HTML 模板'}),error=h('p',{class:'author-error',role:'status'});
  let busy=false;
  return ctx.dialog.open({title:'导入 / 自定义模板',sub:'支持 HTML、包含 index.html 与素材的 ZIP、PPT / PPTX',width:'lg',body:h('div',{class:'author-fields'},name,file,h('p',{class:'author-hint'},'单个文件最大 40MB。PPT 会解析为网页元素，转换差异会显示在报告中。'),html,error),actions:[{label:'取消',kind:'ghost'},{label:'导入模板',kind:'primary',onClick:async(modal)=>{if(busy)return false;busy=true;const button=modal.querySelector('.btn--primary');button.disabled=true;try{const source=file.files[0];if(source?.size>40*1024*1024)throw new Error('模板文件超过 40MB');const body=source?{name:name.value||source.name.replace(/\.[^.]+$/,''),fileName:source.name,dataUrl:await readFileAsDataURL(source)}:{name:name.value,content:html.value};const result=await ctx.api.saveTemplate(body);if(result.report?.warnings?.length)await ctx.dialog.open({title:'模板导入报告',body:h('div',{class:'author-report'},result.report.warnings.map((w)=>h('p',{},w)))});ctx.toast.ok('模板已导入');return result;}catch(e){error.textContent=e.message;return false;}finally{busy=false;button.disabled=false;}}}]});
}
export async function manageTemplates(ctx) {
  const list=h('div',{class:'template-list'}),error=h('p',{class:'author-error'});
  async function refresh(){const result=await ctx.api.templates();list.replaceChildren();for(const t of result.templates.filter((t)=>t.custom)){
    const title=h('input',{class:'input',value:t.name,'aria-label':'模板名称'}),save=h('button',{class:'btn btn--sm',onClick:async()=>{try{await ctx.api.updateTemplate(t.id,{name:title.value});ctx.toast.ok('模板名称已更新');}catch(e){error.textContent=e.message;}}},'保存名称'),download=h('a',{class:'btn btn--sm',href:`/api/templates/${encodeURIComponent(t.id)}/export`,download:''},'导出 ZIP'),remove=h('button',{class:'btn btn--sm btn--ghost',onClick:async()=>{try{await ctx.api.deleteTemplate(t.id);await refresh();}catch(e){error.textContent=e.message;}}},'删除');
    list.append(h('div',{class:'template-manage-row'},title,h('small',{},t.slides+' 页'),save,download,remove));
  }if(!list.children.length)list.append(h('p',{class:'author-hint'},'还没有自定义模板。可以导入文件或把当前工程保存为模板。'));}
  const add=h('button',{class:'btn',onClick:async()=>{await importTemplate(ctx);await refresh();}},'导入模板');
  await refresh();return ctx.dialog.open({title:'自定义模板',width:'lg',body:h('div',{},add,list,error)});
}
