import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { favoriteStore } from '../server/favorites.mjs';
import { favoriteId, normalizeFavorite, FAVORITE_MAX_CHARS } from '../app/js/core/favorite-data.js';
import { API_CATALOG, apiURL } from '../app/js/agent/api-catalog.js';
import { createToolExecutor, mutationProject } from '../app/js/agent/tools.js';

const sample = { name:'图解', html:'<div><svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg><img src="data:image/png;base64,YWJj"></div>', css:'@keyframes wave{to{opacity:1}}', w:640, h:360, sourceProject:'original' };
test('Favorites persist outside projects, list lightweight metadata, rename without replacing source, and delete independently', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wds-favorites-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=favoriteStore(root), a=await store.save(sample), b=await store.save({...sample,name:'第二个'});
  assert.equal(favoriteId(a.id),a.id);assert.notEqual(a.id,b.id);
  const second=favoriteStore(root);assert.equal((await second.read(a.id)).html,sample.html);
  const rows=await second.list();assert.equal(rows.length,2);assert(!('html' in rows[0]));assert(!('css' in rows[0]));assert.equal(rows[0].chars,sample.html.length+sample.css.length);
  const renamed=await second.update(a.id,{name:'跨工程图解',html:'<script>bad</script>'});
  assert.equal(renamed.name,'跨工程图解');assert.equal(renamed.html,sample.html);assert.equal(renamed.createdAt,a.createdAt);
  assert.deepEqual(await second.remove(a.id),{ok:true});assert.equal((await store.list()).length,1);
  await assert.rejects(store.read(a.id),{status:404});assert.equal((await store.read(b.id)).name,'第二个');
});
test('Favorites reject invalid dimensions, oversized source, empty names and path traversal', () => {
  for(const id of ['../settings','el-../../secret','el-abc','/el-12345678','el-12345678/other'])assert.throws(()=>favoriteId(id),{status:400});
  for(const change of [{name:' '},{html:''},{w:-2},{h:Infinity},{w:20000},{css:'a'.repeat(FAVORITE_MAX_CHARS)}])assert.throws(()=>normalizeFavorite({...sample,...change}),{status:400});
});
test('Favorites refuse directory and file symlinks', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wds-favorites-links-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'outside'));await fs.symlink(path.join(root,'outside'),path.join(root,'linked'),'junction');
  await assert.rejects(favoriteStore(path.join(root,'linked')).save(sample),/链接/);
  // Directory links can be created without Windows Developer Mode.
  const store=favoriteStore(path.join(root,'actual'));await store.save(sample);
  await fs.symlink(path.join(root,'outside'),path.join(root,'actual','el-12345678.json'),'junction');
  await assert.rejects(store.read('el-12345678'),/无效/);
});
test('Favorites APIs are discoverable, URL encoded, and mutations respect project checkpoints and permissions', async () => {
  for(const id of ['elements.list','elements.get','elements.save','elements.update','elements.delete'])assert(API_CATALOG.some(op=>op.id===id));
  assert.equal(apiURL(API_CATALOG.find(op=>op.id==='elements.get'),null,{elementId:'el-12345678'}),'/api/elements/el-12345678?elementId=el-12345678');
  const ctx={store:{get:()=>({project:{id:'current'}})},bus:{hasCommand:()=>true,listCommands:()=>[],runCommand:async()=>({ok:true})}};
  assert.equal(mutationProject(ctx,'app_run_command',{name:'favorites.save'}),null);
  assert.equal(mutationProject(ctx,'app_run_command',{name:'favorites.insert'}),'current');
  assert.equal(mutationProject(ctx,'app_call_api',{operation:'elements.save'}),null);
  const tools=createToolExecutor(ctx);
  assert.equal((await tools.execute('app_run_command',{name:'favorites.insert',payload:{favoriteId:'el-12345678'}},{permission:'read'})).ok,false);
  assert.equal((await tools.execute('app_run_command',{name:'favorites.save'},{permission:'edit'})).ok,false);
  assert.equal((await tools.execute('app_run_command',{name:'favorites.open'},{permission:'full'})).ok,false);
  assert.equal((await tools.execute('app_call_api',{operation:'elements.delete',query:{elementId:'el-12345678'}},{permission:'edit'})).ok,false);
  ctx.api={getFavoriteElement:async()=>({element:{html:'<div><script type="application/json" data-wds-three-scene>'+JSON.stringify({code:'root.add(new THREE.Mesh());'})+'</script></div>'}})};
  assert.equal((await tools.execute('app_run_command',{name:'favorites.insert',payload:{favoriteId:'el-12345678'}},{permission:'edit'})).ok,false);
  assert.equal((await tools.execute('app_run_command',{name:'favorites.insert',payload:{favoriteId:'el-12345678'}},{permission:'full'})).ok,true);
});
