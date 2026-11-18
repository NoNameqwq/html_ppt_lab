import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { portableFavorite, insertFavorite } from '../core/favorite-content.js';

export function initFavorites(ctx) {
  const run = fn => async args => { try { return await fn(args || {}); } catch(e) { ctx.toast.error(e.message); return { ok:false,error:e.message }; } };
  async function save(args) {
    const editor=ctx.getEditor?.(),elementId=args.elementId||ctx.store.get().selection?.elementId;
    if(!editor?.bridge?.ready||!elementId)throw new Error('请先选择要收藏的元素');
    const suggested=(ctx.store.get().selection?.text||'收藏元素').trim().slice(0,40);
    const name=args.name||await ctx.dialog.prompt('收藏元素',{sub:'为元素起个名字，便于在其他工程中使用。',value:suggested,okLabel:'收藏'});
    if(name===null||name===undefined)return {ok:false,cancelled:true};
    const snapshot=await editor.bridge.call('captureFavorite',{elementId});
    const content=await portableFavorite({...snapshot,name,sourceProject:ctx.store.get().project?.name||''});
    const result=await ctx.api.saveFavoriteElement(content);ctx.toast.ok('已加入元素收藏');ctx.bus.emit('favorites:changed');return {ok:true,...result};
  }
  async function insert(args) {
    const {element}=await ctx.api.getFavoriteElement(args.favoriteId);
    return insertFavorite(ctx,element,args);
  }
  async function open({mode='insert'}={}) {
    const {elements}=await ctx.api.listFavoriteElements();let items=elements,query='',shown=24;
    const search=h('input',{class:'input favorite-search',type:'search',placeholder:'搜索名称、内容或来源工程','aria-label':'搜索收藏元素'});
    const status=h('p',{class:'favorite-status','aria-live':'polite'}),grid=h('div',{class:'favorite-grid'}),more=h('button',{type:'button',class:'btn btn--sm'},'显示更多');
    const body=h('div',{class:'favorite-library'},h('div',{class:'favorite-toolbar'},search,h('span',{html:icon('star',18)})),status,grid,more);
    const cache=new Map();const read=async id=>{if(!cache.has(id))cache.set(id,ctx.api.getFavoriteElement(id).then(r=>r.element));return cache.get(id);};
    let observer;
    const close=()=>body.closest('.modal')?.querySelector('.modal-close')?.click();
    const safe=fn=>async()=>{try{await fn();}catch(e){ctx.toast.error(e.message);}};
    function render() {
      observer?.disconnect();grid.replaceChildren();
      const filtered=items.filter(item=>[item.name,item.description,item.sourceProject].join(' ').toLowerCase().includes(query));
      status.textContent=filtered.length?filtered.length+' 个收藏 · 可跨工程使用':'还没有匹配的收藏。在画布中右键元素，选择「收藏元素」。';
      more.hidden=filtered.length<=shown;
      observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);preview(entry.target);}});
      async function preview(frame) {
        try {const item=await read(frame.dataset.favoriteId);if(!frame.isConnected)return;
          const scale=Math.min(220/item.w,130/item.h,1);
          frame.srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#eee}#favorite-stage{position:absolute;left:50%;top:50%;width:${item.w}px;height:${item.h}px;transform:translate(-50%,-50%) scale(${scale});transform-origin:center}${item.css.replace(/<\/style/gi,'<\\/style')}</style><div id="favorite-stage">${item.html}</div>`;
        }catch(e){frame.title='预览不可用：'+e.message;}
      }
      for(const item of filtered.slice(0,shown)) {
        const frame=h('iframe',{class:'favorite-preview',sandbox:'',tabindex:'-1',title:item.name+'预览','data-favorite-id':item.id});
        const rename=h('button',{type:'button',class:'btn btn--sm btn--ghost','aria-label':'重命名 '+item.name,html:icon('edit',14),onClick:safe(async()=>{
          const name=await ctx.dialog.prompt('重命名收藏',{value:item.name});if(name===null||name===undefined)return;
          const {element}=await ctx.api.updateFavoriteElement(item.id,{name});items=items.map(v=>v.id===item.id?{...v,name:element.name}:v);cache.delete(item.id);render();
        })});
        const remove=h('button',{type:'button',class:'btn btn--sm btn--ghost','aria-label':'删除 '+item.name,html:icon('trash',14),onClick:safe(async()=>{
          if(!await ctx.dialog.confirm('删除「'+item.name+'」？已插入页面或发送到聊天的副本会保留。',{title:'删除收藏'}))return;
          await ctx.api.deleteFavoriteElement(item.id);items=items.filter(v=>v.id!==item.id);cache.delete(item.id);render();ctx.bus.emit('favorites:changed');
        })});
        const put=h('button',{type:'button',class:'btn btn--sm'+(mode==='insert'?' btn--primary':''),'data-favorite-insert':item.id},'插入页面');
        put.disabled=!ctx.getEditor?.()?.ready;
        put.addEventListener('click',safe(async()=>{put.disabled=true;try{await insertFavorite(ctx,await read(item.id));ctx.toast.ok('已插入收藏元素');close();}finally{put.disabled=!ctx.getEditor?.()?.ready;}}));
        const attach=h('button',{type:'button',class:'btn btn--sm'+(mode==='chat'?' btn--primary':''),'data-favorite-attach':item.id,onClick:safe(async()=>{
          const result=await ctx.bus.runCommand('agent.attachFavorite',{element:await read(item.id)});if(result.ok===false)throw new Error(result.error);close();
        })},'添加到聊天');
        const card=h('article',{class:'favorite-card'},frame,h('div',{class:'favorite-card-heading'},h('strong',{},item.name),rename,remove),
          h('p',{class:'favorite-description'},item.description||item.type||'HTML 元素'),h('small',{},Math.round(item.w)+' × '+Math.round(item.h)+(item.sourceProject?' · '+item.sourceProject:'')),h('div',{class:'favorite-actions'},put,attach));
        grid.append(card);observer.observe(frame);
      }
    }
    search.addEventListener('input',()=>{query=search.value.trim().toLowerCase();shown=24;render();});more.addEventListener('click',()=>{shown+=24;render();});
    render();
    await ctx.dialog.open({title:'元素收藏',sub:'保存一次，在不同工程和 Agent 聊天中复用',body,width:'lg',className:'favorite-dialog',actions:[{label:'关闭',kind:'ghost',value:true}],onClose:()=>observer?.disconnect()});
  }
  ctx.bus.registerCommand('favorites.save',run(save),{label:'收藏选中元素',group:'收藏',icon:'star',parameters:{elementId:'可选，默认选中元素',name:'收藏名称'}});
  ctx.bus.registerCommand('favorites.insert',run(insert),{label:'插入收藏元素',group:'收藏',icon:'star',parameters:{favoriteId:'收藏 ID',x:'可选',y:'可选'}});
  ctx.bus.registerCommand('favorites.open',run(open),{label:'元素收藏库',group:'收藏',icon:'star'});
}
