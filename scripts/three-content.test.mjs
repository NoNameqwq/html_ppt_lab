import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeThreeScene,threeMarkup} from '../app/js/core/three-content.js';

test('3D source preserves editable nested geometry, materials, camera and controls',()=>{
  const source={camera:{position:[5,3,6],target:[0,0,0]},controls:{enablePan:true,enableZoom:true},objects:[{type:'group',position:[1,0,0],children:[{id:'ring',geometry:{type:'torus',args:[1.5,.3,16,48]},material:{color:'#ff8a3c'},rotation:[.3,.4,0]}]}]};
  const copy=normalizeThreeScene(source);assert.deepEqual(copy,source);assert.notEqual(copy,source);
  const html=threeMarkup({scene:source,code:'scene.add(new THREE.AxesHelper(2)); return { update(t,dt){root.rotation.y += dt;} };',label:'A "3D" <structure>'});
  assert(html.includes('data-wds-three'));assert(html.includes('aria-label="A &quot;3D&quot; &lt;structure&gt;"'));assert(!html.includes('<canvas'));
  const json=JSON.parse(/data-wds-three-scene>([\s\S]*?)<\/script>/.exec(html)[1]);assert.deepEqual(json.scene,source);assert.match(json.code,/AxesHelper/);assert.equal(json.version,1);
});
test('3D JSON script cannot be closed by labels, geometry metadata or factory source',()=>{
  const code='// </script><script>alert(1)</script>\nreturn {};';
  const html=threeMarkup({scene:{objects:[],description:'</script>'},code,label:'</script>'});
  assert.equal((html.match(/<script/g)||[]).length,1);assert.equal((html.match(/<\/script>/g)||[]).length,1);
  assert(html.includes('\\u003c/script>'));assert.equal(JSON.parse(/data-wds-three-scene>([\s\S]*?)<\/script>/.exec(html)[1]).code,code);
});
test('3D schema rejects invalid geometry, non-finite coordinates, cyclic and oversized source',()=>{
  assert.throws(()=>threeMarkup({scene:{objects:[{geometry:{type:'invented'}}]}}),/未知/);
  assert.throws(()=>threeMarkup({scene:{camera:{position:[1,2]}}}),/三个/);
  assert.throws(()=>threeMarkup({scene:{objects:[{position:[Infinity,1,2]}]}}),/有限数字/);
  assert.throws(()=>threeMarkup({scene:{objects:[{scale:'wrong'}]}}),/三个/);
  assert.throws(()=>threeMarkup({scene:{camera:{fov:180}}}),/0–180/);
  const circular={};circular.self=circular;assert.throws(()=>threeMarkup({scene:circular}),/序列化/);
  assert.throws(()=>threeMarkup({code:'x'.repeat(250001)}),/250000/);
  assert.throws(()=>threeMarkup({scene:{objects:Array.from({length:2001},()=>({type:'group'}))}}),/过大/);
  let nested={type:'group'};for(let i=0;i<34;i++)nested={type:'group',children:[nested]};assert.throws(()=>threeMarkup({scene:{objects:[nested]}}),/32/);
});
