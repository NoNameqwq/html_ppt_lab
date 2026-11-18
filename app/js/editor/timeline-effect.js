import { h } from '../core/dom.js';

const escape = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function editTimelineEffect(ctx, track, pages) {
  const model = track.content || { type: 'html', value: track.html || '', color: '#e1402b', size: 96, direction: 'left', duration: 900 };
  const name = h('input', { class: 'input', value: track.name, 'aria-label': '特效名称' });
  const type = h('select', { class: 'input', 'aria-label': '特效内容类型' }, ...[['text','文字'],['image','图片 URL'],['html','HTML / SVG'],['selection','当前选中元素副本']].map(([value,label])=>h('option',{value},label)));
  type.value = model.type;
  const value = h('textarea', { class: 'input tl-effect-code', 'aria-label': '特效内容', rows: 5, value: model.value, placeholder: '文字、图片地址或 HTML / SVG' });
  const css = h('textarea', { class: 'input tl-effect-code', 'aria-label': '特效 CSS', rows: 3, value: track.css || '', placeholder: '可选 CSS，使用此轨道选择器限定范围' });
  const color = h('input', { class: 'input', type:'color', value:model.color || '#e1402b', 'aria-label':'特效颜色' });
  const size = h('input', { class: 'input', type:'number', min:8, max:1200, value:model.size || 96, 'aria-label':'特效尺寸' });
  const direction = h('select', { class:'input', 'aria-label':'飞入方向' }, ...[['left','左侧'],['right','右侧'],['top','上方'],['bottom','下方']].map(([v,l])=>h('option',{value:v},l)));
  direction.value=model.direction || 'left';
  const duration = h('input', { class:'input', type:'number', min:100, max:30000, value:model.duration || 900, 'aria-label':'特效时长' });
  const frames = h('textarea', { class:'input tl-effect-code', rows:6, 'aria-label':'特效关键帧 JSON', value:JSON.stringify(track.keyframes,null,2) });
  value.value=model.value || '';css.value=track.css || '';frames.value=JSON.stringify(track.keyframes,null,2);
  const error = h('p', { class:'tl-effect-error', role:'alert' });
  const preview = h('iframe', { class:'tl-effect-preview', sandbox:'', title:'特效内容预览' });
  let copied = model.type==='selection' ? model.value || '' : '';
  const markup = () => {
    const s=Math.max(8,Math.min(1200,Number(size.value)||96)), c=color.value;
    let content=type.value==='text' ? escape(value.value) : type.value==='image' ? `<img src="${escape(value.value)}" style="width:100%;height:100%;object-fit:contain">` : type.value==='selection' ? copied : value.value;
    if(type.value==='html') return content;
    return `<div style="position:absolute;left:50%;top:50%;width:${type.value==='text'?'max-content':s+'px'};max-width:90%;height:${type.value==='text'?'auto':s+'px'};font-size:${s}px;color:${c};translate:-50% -50%;z-index:75;opacity:0">${content}</div>`;
  };
  const update=()=>{preview.srcdoc=`<!doctype html><style>html,body{margin:0;width:1920px;height:1080px;background:#161a23;color:white}body{transform:scale(.25);transform-origin:0 0}${css.value}</style>${markup().replace(/opacity:\s*0\b/g,'opacity:1')}`;};
  type.addEventListener('change',async()=>{
    if(type.value==='selection') {
      const selected=ctx.store.get().selection;
      if(!selected?.elementId) {error.textContent='请先在画布选中要飞入的元素';return;}
      const res=await ctx.getEditor().bridge.call('getElementHtml',{elementId:selected.elementId});
      const temp=document.createElement('template');temp.innerHTML=res.html||'';
      temp.content.querySelectorAll('[data-wpx-el],[id]').forEach(n=>{n.removeAttribute('data-wpx-el');n.removeAttribute('id');});
      const root=temp.content.firstElementChild;if(root){Object.assign(root.style,{position:'relative',left:'0px',top:'0px',width:'100%',height:'100%',translate:'none'});}
      copied=temp.innerHTML; value.value=copied;
    }
    update();
  });
  const field=(label,input)=>h('label',{},h('span',{},label),input);
  const body=h('div',{class:'tl-effect-form'},
    h('div',{class:'tl-effect-grid'},field('名称',name),field('内容类型',type)),
    field('飞入内容',value),h('div',{class:'tl-effect-grid'},field('颜色',color),field('字号 / 尺寸 px',size),field('飞入方向',direction),field('时长 ms',duration)),
    h('button',{class:'btn btn--sm',onclick:()=>{
      const d=Math.max(100,Math.min(30000,Number(duration.value)||900)), x=direction.value==='left'?-960:direction.value==='right'?960:0,y=direction.value==='top'?-640:direction.value==='bottom'?640:0;
      frames.value=JSON.stringify(pages.flatMap(p=>{const end=p.start+Math.min(d,p.duration);return [{t:p.start,page:p.index,props:{opacity:0,x,y,scale:.7}},{t:p.start+(end-p.start)*.5,page:p.index,props:{opacity:1,x:0,y:0,scale:1}},{t:end,page:p.index,props:{opacity:0,x:-x*.5,y:-y*.5,scale:1}}];}),null,2);
    }},'按方向与时长生成关键帧'),
    field('CSS',css),h('details',{},h('summary',{},'关键帧 JSON · 自定义动效'),frames),preview,error);
  [direction,duration].forEach(input=>input.addEventListener('change',()=>body.querySelector('button').click()));
  body.addEventListener('input',update); update();
  return ctx.dialog.open({title:'编辑特效内容',sub:'可用文字、图片、SVG 或任意 HTML 组合；关键帧控制跨页动画。',width:'lg',body,
    actions:[{label:'取消',value:null},{label:'保存特效',kind:'primary',onClick:()=>{
      try {
        const parsed=JSON.parse(frames.value);
        if(!Array.isArray(parsed)||parsed.some(k=>!Number.isFinite(Number(k.t))||!k.props||typeof k.props!=='object')) throw new Error('关键帧应是包含 t 和 props 的数组');
        if(!markup().trim())throw new Error('请填写特效内容');
        const keyframes=parsed.map(k=>({...k,id:k.id||'kf'+Math.random().toString(36).slice(2,10),t:Number(k.t)})).sort((a,b)=>a.t-b.t);
        return {...track,name:name.value.trim()||'自定义特效',html:markup(),css:css.value,keyframes,content:{type:type.value,value:type.value==='selection'?copied:value.value,color:color.value,size:Number(size.value),direction:direction.value,duration:Number(duration.value)}};
      } catch(e) {error.textContent=e.message;return false;}
    }}]});
}
