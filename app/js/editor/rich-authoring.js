import { h } from '../core/dom.js';
import { renderFormula, sanitizeSvg } from '../core/rich-content.js';
import { FONT_PROFILES, availableFonts, recommendFonts } from '../core/fonts.js';
import { initNavigationAuthoring } from './navigation-authoring.js';

export function initRichAuthoring(ctx) {
  initNavigationAuthoring(ctx);
  async function execute(name,args) { const {createToolExecutor}=await import('../agent/tools.js'); const result=await createToolExecutor(ctx).execute(name,args,{permission:'full'}); if(!result.ok)throw new Error(result.error); return result; }
  async function open(type, payload={}) {
    if(!ctx.getEditor()?.ready)throw new Error('请先打开一个工程');
    if(payload.latex||payload.svg)return execute(type==='math'?'deck_insert_math':'deck_insert_svg',payload);
    const math=type==='math', source=h('textarea',{class:'input author-source','aria-label':math?'LaTeX 公式':'SVG 源码'});
    let elementId=payload.elementId||ctx.store.get().selection?.elementId, editing=false;
    source.value=math?'\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}':'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#5267df"/></marker></defs><rect x="40" y="80" width="240" height="130" rx="18" fill="#e8edff"/><rect x="520" y="80" width="240" height="130" rx="18" fill="#e8edff"/><path d="M300 145 H500" stroke="#5267df" stroke-width="4" marker-end="url(#arrow)"/><g font-size="32" text-anchor="middle" fill="#223052"><text x="160" y="156">原因</text><text x="640" y="156">结果</text></g></svg>';
    if(elementId)try{const result=await ctx.getEditor().bridge.call('getElementHtml',{elementId}),doc=new DOMParser().parseFromString(result.html,'text/html'),node=doc.querySelector(math?'[data-wds-latex]':'[data-wds-svg]');if(node){source.value=node.getAttribute(math?'data-wds-latex':'data-wds-svg');editing=true;}}catch{}
    if(!editing)elementId=null;
    const preview=h('div',{class:'author-preview'}), error=h('div',{class:'author-error',role:'status'});
    const update=()=>{try{preview.innerHTML=math?renderFormula(source.value,true):sanitizeSvg(source.value);error.textContent='';}catch(e){error.textContent=e.message;preview.replaceChildren();}};
    source.addEventListener('input',update);update();
    return ctx.dialog.open({title:(editing?'编辑':'插入')+(math?' LaTeX 公式':' SVG 图解'),sub:math?'保留公式源码；选中公式后再次点此入口可编辑':'矢量图形可缩放，用于结构、流程与知识图解',width:'lg',className:'author-dialog',body:h('div',{},source,preview,error),actions:[{label:'取消',kind:'ghost'},{label:editing?'更新':'插入',kind:'primary',onClick:async()=>{try{return await execute(math?'deck_insert_math':'deck_insert_svg',math?{latex:source.value,elementId}:{svg:source.value,elementId});}catch(e){error.textContent=e.message;return false;}}}]});
  }
  ctx.bus.registerCommand('insert.math',(p)=>open('math',p).catch((e)=>ctx.toast.error(e.message)),{label:'LaTeX 公式',group:'插入',icon:'code'});
  ctx.bus.registerCommand('insert.svg',(p)=>open('svg',p).catch((e)=>ctx.toast.error(e.message)),{label:'SVG 图解',group:'插入',icon:'shapes'});
  ctx.bus.registerCommand('design.autoFonts',async(p={})=>{
    if(p.profile)return execute('deck_auto_fonts',p);
    const text=ctx.store.get().project?.name||'', fonts=availableFonts(), select=h('select',{class:'input','aria-label':'字体风格'},FONT_PROFILES.map((f)=>h('option',{value:f.id},f.label))), preview=h('div',{class:'author-preview'});
    const update=()=>{const r=recommendFonts({profile:select.value,text,fonts});preview.replaceChildren(h('h2',{style:{fontFamily:r.heading}},'知识，让表达更清晰'),h('p',{style:{fontFamily:r.body}},'正文保持清楚易读。Knowledge, beautifully explained.'),h('p',{class:'author-hint'},r.reason));};select.addEventListener('change',update);update();
    return ctx.dialog.open({title:'自动选择字体',body:h('div',{},select,preview,h('p',{class:'author-hint'},'检测本机字体后选择标题与正文组合。公式保留数学字体，SVG 内的文字保持原设定。')),width:'lg',actions:[{label:'取消',kind:'ghost'},{label:'应用到工程',kind:'primary',onClick:async()=>{try{return await execute('deck_auto_fonts',{profile:select.value});}catch(e){ctx.toast.error(e.message);return false;}}}]});
  },{label:'自动选择字体',group:'设计',icon:'type'});
}
