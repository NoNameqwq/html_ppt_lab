import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolExecutor,getToolDefinitionsForPermission} from '../app/js/agent/tools.js';

function fixture(){
  const calls=[],snapshot={project:{id:'three-test'},deck:{current:0,total:1},history:{ops:[],cursor:0},selection:null};
  const editor={iframe:{contentWindow:{__WDS_THREE__:{getState:()=>({count:1,instances:[{ready:true,elementId:'structure'}]})}}},bridge:{ready:true,call:async(name,params={})=>{
    calls.push({name,params});
    if(name==='getState')return {current:0,slides:[{id:'page'}]};
    if(name==='getElementHtml')return {html:'<div class="wpx-el" data-wpx-el="structure" style="left:30px;width:1200px"><div data-wds-three></div></div>'};
    if(name==='insertElement')return {elementId:'structure',op:{type:'insert',opId:'insert-3d'}};
    if(name==='setText')return {op:{type:'html',opId:'update-3d'}};
    return {};
  }}};
  const ctx={store:{get:()=>snapshot,update:fn=>fn(snapshot),pushOp:op=>{snapshot.history.ops.push(op);snapshot.history.cursor++;return op;}},bus:{emit(){}},getEditor:()=>editor};
  return {calls,ctx,executor:createToolExecutor(ctx)};
}
const scene={camera:{position:[4,3,5]},objects:[{id:'body',geometry:{type:'box',args:[2,1,3]},material:{color:'#66aaff'}}]};

test('Declarative 3D uses editable HTML, preserves source and creates undoable changes',async()=>{
  const f=fixture();let checkpoints=0;
  const result=await f.executor.execute('deck_insert_3d',{scene,label:'Crystal',x:0,y:0,w:1400,h:800},{permission:'edit',beforeMutation:async()=>checkpoints++});
  assert(result.ok);assert.equal(result.opId,'insert-3d');assert.equal(checkpoints,1);
  const inserted=f.calls.find(c=>c.name==='insertElement').params;
  assert.equal(inserted.x,0);assert.equal(inserted.y,0);assert.equal(inserted.w,1400);assert.equal(inserted.type,'html');
  assert(inserted.html.includes('data-wds-three-scene'));assert(inserted.html.includes('"id":"body"'));assert(!inserted.html.includes('cdn'));
  const updated=await f.executor.execute('deck_insert_3d',{elementId:'structure',scene},{permission:'edit'});
  assert.equal(updated.opId,'update-3d');assert.equal(f.calls.filter(c=>c.name==='insertElement').length,1);
  assert(f.calls.find(c=>c.name==='setText').params.html.includes('data-wds-three'));
});
test('3D source code permission is checked before version checkpoints or writes, including compose',async()=>{
  const f=fixture();let checkpoints=0;
  for(const [name,args] of [['deck_insert_3d',{code:'root.add(new THREE.Group());'}],['deck_compose',{slides:[{name:'Scene',elements:[{type:'three',code:'root.add(new THREE.Group());'}]}]}],['app_run_command',{name:'insert.three',payload:{code:'root.add(new THREE.Group());'}}]]){
    const denied=await f.executor.execute(name,args,{permission:'edit',beforeMutation:async()=>checkpoints++});assert.equal(denied.ok,false);assert(denied.error.includes('完全访问'));
  }
  assert.equal(checkpoints,0);assert.equal(f.calls.length,0);
  const accepted=await f.executor.execute('deck_insert_3d',{code:'root.add(new THREE.Group());'},{permission:'full'});assert(accepted.ok);
  assert(!getToolDefinitionsForPermission('read').some(t=>t.function.name==='deck_insert_3d'));
  assert(getToolDefinitionsForPermission('read').some(t=>t.function.name==='deck_get_3d_state'));
});
test('Invalid scene and missing source cannot write a component; state reads actual runtime',async()=>{
  const f=fixture();
  for(const args of [{},{scene:{objects:[{geometry:{type:'not-real'}}]}}]){
    const result=await f.executor.execute('deck_insert_3d',args,{permission:'full'});assert.equal(result.ok,false);
  }
  assert.equal(f.calls.length,0);
  assert.deepEqual(await f.executor.execute('deck_get_3d_state',{}, {permission:'read'}),{ok:true,count:1,instances:[{ready:true,elementId:'structure'}]});
});

test('3D state recovers a missing runtime through the editor bridge and waits for scene initialization',async()=>{
  const f=fixture(),editor=f.ctx.getEditor();let refreshed=false;
  delete editor.iframe.contentWindow.__WDS_THREE__;
  editor.bridge.call=async name=>{
    assert.equal(name,'ensureThree');
    editor.iframe.contentWindow.__WDS_THREE__={refresh:async()=>{await new Promise(r=>setTimeout(r,5));refreshed=true;},getState:()=>({count:1,instances:[{ready:refreshed}]})};
  };
  const result=await f.executor.execute('deck_get_3d_state',{}, {permission:'read'});
  assert.equal(result.ok,true);assert.equal(result.instances[0].ready,true);
});
