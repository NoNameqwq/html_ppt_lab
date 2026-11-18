import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {pptxFixture} from './pptx-fixture.mjs';
import {convertPptx} from '../server/pptx.mjs';
import {openArchive} from '../server/archive.mjs';
import {templateStore} from '../server/templates.mjs';
import {markdownToHtml as renderMarkdown} from '../app/js/agent/markdown.js';
import {recommendFonts} from '../app/js/core/fonts.js';
import {deckDocument} from '../server/deck-document.mjs';

test('LaTeX preserves expressions in prose, blocks, tables and fenced code',()=>{
  const md=renderMarkdown(String.raw`行内 $x_1^2$。

$$\frac{1}{2}$$

| 公式 | 值 |
| --- | --- |
| $\alpha$ | 1 |

`+'```js\nconst price="$5";\n```');
  assert.equal((md.match(/class="katex"/g)||[]).length,3);assert(md.includes('md-table-wrap'));assert(md.includes('const price='));assert(md.includes('$5'));assert(!md.includes('\0RICH'));
  const partial=renderMarkdown('尚未完成 $$\\frac{');assert(partial.includes('尚未完成'));assert(partial.includes('$$'));
  const bad=renderMarkdown('$\\doesnotexist$');assert(bad.includes('md-math-error'));assert(bad.includes('doesnotexist'));
});
test('Font recommendations use installed CJK / Latin families with safe fallbacks',()=>{
  const fonts=[{family:'Microsoft YaHei',available:true},{family:'SimSun',available:true},{family:'Noto Serif SC',available:false},{family:'Consolas',available:true}];
  const r=recommendFonts({profile:'auto',text:'数学公式与定理',fonts});assert.equal(r.heading,'SimSun');assert.equal(r.body,'Microsoft YaHei');assert.equal(r.mono,'Consolas');
  assert.equal(recommendFonts({text:'API systems',fonts:[]}).body,'sans-serif');
});
test('PPTX uses presentation relationship order, source transforms, packaged images and editable tables',async()=>{
  const result=await convertPptx(await pptxFixture());assert.equal(result.report.slides,2);assert.equal(result.report.texts,2);assert.equal(result.report.images,1);assert.equal(result.report.tables,1);assert.equal(result.assets.size,1);
  assert(result.html.indexOf('第一页')<result.html.indexOf('第二页'));assert(result.html.includes('left:100px;top:100px;width:1000px;height:200px'));assert(result.html.includes('<table'));assert(result.html.includes('可编辑表格'));assert(result.report.warnings.some((w)=>w.includes('动画')));
});
test('Malformed Office XML, unsafe archive paths and excessive expansion fail explicitly',async()=>{
  const bad=new JSZip();bad.file('ppt/presentation.xml','<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><p:presentation/>');const badBytes=await bad.generateAsync({type:'nodebuffer'});await assert.rejects(()=>convertPptx(badBytes),/DTD/);
  const escape=new JSZip();escape.file('../escape.txt','oops');const escapeBytes=await escape.generateAsync({type:'nodebuffer'});await assert.rejects(()=>openArchive(escapeBytes),/不安全路径/);
  const huge=new JSZip();huge.file('big.txt','x'.repeat(2000));const hugeBytes=await huge.generateAsync({type:'nodebuffer'});await assert.rejects(()=>openArchive(hugeBytes,{maxBytes:1000}),/过大/);
});
test('Custom templates preserve assets and raw state, exclude conversations, round-trip as ZIP and protect built-ins',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wds-template-test-'));
  try{
    const custom=path.join(root,'custom'),builtin=path.join(root,'builtin'),project=path.join(root,'project');await fs.mkdir(project,{recursive:true});
    await fs.writeFile(path.join(project,'index.html'),'<html><body><section class="wpx-slide">Template</section></body></html>');await fs.writeFile(path.join(project,'project.json'),JSON.stringify({kind:'raw',name:'测试'}));await fs.writeFile(path.join(project,'.chat.json'),'private');await fs.writeFile(path.join(project,'.raw-edits.json'),'{"patches":[]}');await fs.mkdir(path.join(project,'assets'));await fs.writeFile(path.join(project,'assets','test.svg'),'<svg/>');
    const store=templateStore({customRoot:custom,builtinRoot:builtin}),t=await store.save({name:'我的模板',projectDir:project});assert.equal(t.kind,'raw');assert.equal((await store.list()).length,1);await assert.rejects(()=>store.read(t.id,'.chat.json'));
    assert.equal((await store.read(t.id,'assets/test.svg')).toString(),'<svg/>');assert(await store.read(t.id,'.raw-edits.json'));
    const bytes=await store.exportZip(t.id),copy=await store.save({bytes,fileName:'test.zip'});assert.equal(copy.name,'我的模板');assert.equal(copy.kind,'raw');await store.update(copy.id,{name:'新名称'});assert.equal((await store.list()).find((x)=>x.id===copy.id).name,'新名称');await store.remove(t.id);await assert.rejects(()=>store.remove('blank'),/自定义模板/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('Portable decks inline mathematical CSS, fonts and local images, including raw patch markup',async()=>{
  const files=new Map([['index.html',Buffer.from('<html><head></head><body><link rel="stylesheet" href="/app/vendor/katex/katex.min.css"><span class="katex">x</span><img src="assets/x.png"><svg><path fill="url(#marker)"/></svg><div style="background:url(assets/x.png)"></div></body></html>')],['project.json',Buffer.from('{"kind":"native"}')],['assets/x.png',Buffer.from('png')]]);
  const shared=async(rel)=>Buffer.from(rel.endsWith('.css')?'@font-face{src:url(fonts/KaTeX.woff2)}':'font');
  const html=await deckDocument({read:async(p)=>files.get(p),shared,portable:true});assert(html.includes('data:font/woff2;base64'));assert(html.includes('data:image/png;base64'));assert(!html.includes('href="/app/vendor'));
  assert(html.includes('fill="url(#marker)"'));assert(html.includes('style="background:url(data:image/png;base64,'));
  files.set('project.json',Buffer.from('{"kind":"raw"}'));files.set('.raw-edits.json',Buffer.from(JSON.stringify({patches:[{html:'<link rel="stylesheet" href="/app/vendor/katex/katex.min.css"><img src="assets/x.png">'}]})));
  const raw=await deckDocument({read:async(p)=>files.get(p),shared,portable:true});assert(raw.includes('data:font/woff2;base64'));assert(raw.includes('wpx-raw-patches'));
});
