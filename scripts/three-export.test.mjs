import test from 'node:test';
import assert from 'node:assert/strict';
import { deckDocument } from '../server/deck-document.mjs';
import { createDocuments } from '../app/js/standalone/documents.js';

const runtime='window.__WDS_THREE__ = {refresh() {}};';
const engine='window.WDS_THREE={THREE:{REVISION:"test"}};';
const scene='<div data-wds-three><script type="application/json" data-wds-three-scene>{"version":1,"scene":{}}</script></div>';
const source=(content='')=>'<!doctype html><html><head></head><body>'+content+'</body></html>';
function fixture(content,kind='native',patches=[]){
  const files={'index.html':source(content),'project.json':JSON.stringify({kind}),'.raw-edits.json':JSON.stringify({patches})};
  const resources={'/editor/three-runtime.js':runtime,'/app/vendor/three/three-bundle.js':engine};
  const read=async name=>files[name]===undefined?null:Buffer.from(files[name]);
  const shared=async name=>Buffer.from(resources[name]||'/* optional runtime */');
  return {files,resources,read,shared};
}
test('Portable native and raw-patch 3D decks carry engine and controls without app URLs',async()=>{
  for(const f of [fixture(scene),fixture('','raw',[{op:'insert',html:scene}])]){
    const html=await deckDocument({...f,portable:true});
    assert(html.includes(engine));assert(html.includes(runtime));
    assert(!html.includes('src="/app/vendor/three/'));assert(!html.includes('src="/editor/three-runtime.js"'));
  }
});
test('Non-3D exports omit the engine while live preview can bootstrap dynamic components',async()=>{
  const f=fixture('<h1>Regular deck</h1>');
  const portable=await deckDocument({...f,portable:true});
  assert(!portable.includes(engine));assert(!portable.includes(runtime));
  const live=await deckDocument({...f,base:'/p/project/'});
  assert(live.includes('src="/editor/three-runtime.js"'));assert(!live.includes('/app/vendor/three/'));
});
test('Reimporting a portable native deck never accumulates duplicate engines or runtime loops',async()=>{
  const f=fixture(scene),first=await deckDocument({...f,portable:true});
  f.files['index.html']=first;
  const second=await deckDocument({...f,portable:true});
  assert.equal(second.split(engine).length-1,1);assert.equal(second.split(runtime).length-1,1);
  assert(second.includes('data-wds-runtime="three-bundle"'));
});
test('Browser-only documents support dynamic editing, inline native/raw exports, and leave ordinary exports lean',()=>{
  const f=fixture(scene),resources=Object.fromEntries(Object.entries(f.resources).map(([k,v])=>[k,'data:text/javascript;base64,'+Buffer.from(v).toString('base64')]));
  const docs=createDocuments({}, {resources});
  const edited=docs.prepare(source(),'/p/project/index.html',{}, {edit:true});
  assert(edited.includes('__WDS_THREE_URL__'));assert(edited.includes(runtime));
  for(const opts of [{},{raw:true,patches:[{html:scene}]}]){
    const html=docs.prepare(source(opts.raw?'':scene),'/p/project/index.html',{},opts);
    assert(html.includes(engine));assert(html.includes(runtime));assert(!html.includes('src="/app/vendor/three/'));
  }
  const regular=docs.prepare(source(),'/p/project/index.html',{});
  assert(!regular.includes(engine));assert(!regular.includes(runtime));
});
