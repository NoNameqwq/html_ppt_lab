import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
import {parse} from 'acorn';
import {createExportPlan,optimizeExportScript,optimizeExportCss} from '../app/js/core/export-plan.js';
import {deckDocument} from '../server/deck-document.mjs';
import {createDocuments,asData} from '../app/js/standalone/documents.js';

const full=(body='',head='')=>'<!doctype html><html><head>'+head+'</head><body>'+body+'</body></html>';
const native=(body='',head='')=>full(body+'<script id="wpx-fx" src="/editor/fx-presets.js"></script><script id="wpx-runtime" src="/editor/deck-runtime.js"></script>',head);
const report=html=>JSON.parse(parseHTML(html).document.querySelector('#wds-export-manifest').textContent);
const fx=await readFile(new URL('../editor/fx-presets.js',import.meta.url),'utf8');
const deck=await readFile(new URL('../editor/deck-runtime.js',import.meta.url),'utf8');
const web=await readFile(new URL('../editor/web-runtime.js',import.meta.url),'utf8');
const mathCss='@font-face{font-family:KaTeX_Main;src:url(fonts/main.woff2) format("woff2"),url(fonts/main.woff) format("woff"),url(fonts/main.ttf) format("truetype")}@font-face{font-family:KaTeX_Unused;src:url(fonts/unused.woff2) format("woff2")}.katex{font:normal 1.21em KaTeX_Main,serif}.unused-math{font-family:KaTeX_Unused}';
const mathLink='<link rel="stylesheet" href="/app/vendor/katex/katex.min.css">';
const formula='<span class="katex">x</span>';
function fixture(html,{kind='native',patches=[],timeline=null,config={},extra={}}={}){
  const files={'index.html':html,'project.json':JSON.stringify({kind}),'.raw-edits.json':JSON.stringify({patches}),'.raw-timeline.json':JSON.stringify({timeline}),'.raw-deck.json':JSON.stringify({config}),...extra};
  const resources={'/editor/fx-presets.js':fx,'/editor/deck-runtime.js':deck,'/app/vendor/katex/katex.min.css':mathCss,'/app/vendor/katex/fonts/main.woff2':'WOFF2_MAIN','/app/vendor/katex/fonts/main.woff':'UNNEEDED_WOFF','/app/vendor/katex/fonts/main.ttf':'UNNEEDED_TTF','/app/vendor/katex/fonts/unused.woff2':'UNNEEDED_FAMILY'};
  const reads=[];
  const read=async name=>files[name]===undefined?null:Buffer.from(files[name]);
  const shared=async name=>{reads.push(name);return resources[name]!==undefined?Buffer.from(resources[name]):readFile(new URL('..'+name,import.meta.url)).catch(()=>null);};
  const browser=async()=>{
    const all={...resources};
    for(const name of ['timeline-content','presentation-tools','three-runtime','raw-patches','timeline-player','web-runtime','present-shell'])all['/editor/'+name+'.js']=(await shared('/editor/'+name+'.js')).toString();
    all['/app/vendor/three/three-bundle.js']='window.WDS_THREE={THREE:{REVISION:"test"}};';
    const state={projects:{demo:{files,meta:{kind},versions:[{id:'saved',files,meta:{kind}}]}}};
    return createDocuments(state,{resources:Object.fromEntries(Object.entries(all).map(([k,v])=>[k,asData(k,v)]))});
  };
  return {files,resources,reads,read,shared,browser};
}

test('Plain exports exclude unused formula assets, 3D, FX, and timeline but keep presentation controls',async()=>{
  const f=fixture(native('<section class="wpx-slide">Text only</section>',mathLink));
  const html=await deckDocument({...f,portable:true}),r=report(html);
  assert.deepEqual(r.features,{three:false,math:false,timeline:false,timelineContent:false});
  assert(!html.includes('data:font/'));assert(!html.includes('global.WPX_FX'));
  assert(!html.includes('data-wds-runtime="timeline-content"'));assert(!html.includes('three-bundle'));
  assert(html.includes('data-wds-runtime="presentation-tools"'));
  assert(!f.reads.some(p=>/\.(woff2?|ttf)$/.test(p)));
});

test('Preset pruning keeps only the selected implementation and its working helpers',()=>{
  const plan=createExportPlan(full('<div data-wpx-anim="fadeUp"></div>'));
  const output=optimizeExportScript(fx,'fx',plan),context={window:{},console};
  vm.runInNewContext(output,context);
  assert.deepEqual(Object.keys(context.window.WPX_FX),['fadeUp']);
  let frames;
  context.window.WPX_FX.fadeUp.play({animate(k){frames=k;return {finished:Promise.resolve(),cancel(){}};}},{});
  assert(frames.length>=2);assert(output.length<fx.length/2);
});

test('Transition pruning retains grouped case bodies, custom scripts, and the fallback',async()=>{
  const custom='window.__WPX__.registerTransition("myTransition", (a,b)=>b.animate([{opacity:0},{opacity:1}],{duration:500}).finished);';
  const f=fixture(native('<section class="wpx-slide" data-transition="pushLeft"></section><script>'+custom+'</script>'));
  const html=await deckDocument({...f,portable:true}),code=parseHTML(html).document.querySelector('#wpx-runtime').textContent;
  parse(code,{ecmaVersion:'latest'});
  assert(/case ['"]pushLeft['"]:/.test(code));assert(/case ['"]push['"]:/.test(code));assert(code.includes('default:'));
  assert(!/case ['"]shatter['"]:/.test(code));assert(!/case ['"]mosaic['"]:/.test(code));
  assert(!code.includes('k.__frame'));assert(html.includes('<script>'+custom+'</script>'));
});

test('Font selection understands shorthand inheritance and retains WOFF2 only',()=>{
  const plan=createExportPlan(full(formula));
  const css=optimizeExportCss(mathCss,plan,{math:true});
  assert(css.includes('main.woff2'));assert(!css.includes('main.woff)'));assert(!css.includes('main.ttf'));
  assert(!css.includes('unused.woff2'));assert(plan.fontFamilies.has('KaTeX_Main'));
});

test('CSS keyframes are referenced across files and unused definitions are removed',()=>{
  const plan=createExportPlan(full('<div class="box"></div>','<style>.box{animation:shared 1s}</style>'));
  const css=optimizeExportCss('@keyframes shared{to{opacity:1}}@keyframes unused{to{opacity:0}}',plan);
  assert(css.includes('@keyframes shared'));assert(!css.includes('@keyframes unused'));
});

test('Dynamic CSS and effect registries preserve dependent implementations',()=>{
  const plan=createExportPlan(full('<script>window.WPX_FX[location.hash].play(el,{});el.classList.add(location.hash);</script>'));
  const optimized=optimizeExportScript(fx,'fx',plan),a={window:{}},b={window:{}};
  vm.runInNewContext(fx,a);vm.runInNewContext(optimized,b);
  assert.deepEqual(Object.keys(a.window.WPX_FX),Object.keys(b.window.WPX_FX));
  assert(optimizeExportCss(mathCss,plan).includes('unused.woff2'));
  const unknown=createExportPlan(full('<script>function invalid(</script>'));
  assert(unknown.three&&unknown.dynamicEffects&&unknown.dynamicTransitions&&unknown.timeline);
  assert(unknown.warnings.length);
});

test('Overlay pruning removes unused implementations and keeps selected shared branches',()=>{
  for(const kind of ['deck','web-runtime']){
    const source=kind==='deck'?deck:web;
    const plan=createExportPlan(full('<section data-wpx-tr-fx="flash"></section>'));
    const code=optimizeExportScript(source,kind,plan);
    assert(!code.includes("fx === 'fly'"));assert(!code.includes("fx === 'sweep'"));
    assert(code.includes("fx === 'flash'"));assert(code.includes('veil'));
  }
});

test('Dynamic DOM attributes and generated resource loaders fall back conservatively',()=>{
  for(const code of ['el.setAttribute(name,value)','Object.assign(el.dataset, props)','el.dataset[key]=value','document.createElement("script")','window.__WPX__.setTimeline(data)']){
    const p=createExportPlan(full('<script>'+code+'</script>'));
    assert(p.three&&p.math&&p.dynamicEffects&&p.dynamicTransitions&&p.timeline,code);
  }
});

test('Literal JS-generated content and raw attributes contribute dependencies without executing scripts',()=>{
  const p=createExportPlan(full('<script>throw new Error("must not run");root.innerHTML=\'<div data-wpx-anim="blurIn" data-wds-three></div>\';</script>'),{patches:[{attrs:{'data-wpx-anim':'fadeUp','data-wpx-tr-fx':'flash'}}]});
  assert(p.three);assert(p.effects.has('blurIn')&&p.effects.has('fadeUp'));assert(p.overlays.has('flash'));
  const clean=createExportPlan(full('<script>const documentation="data-wds-three";</script>'));
  assert(!clean.three);
  const template=createExportPlan(full('<script>root.innerHTML=`<div data-wpx-anim="fadeUp"></div>`;</script>'));
  assert(template.effects.has('fadeUp'));assert(!template.three);assert(!template.dynamicEffects);
  const hidden=createExportPlan(full(),{timeline:{tracks:[{hidden:true,html:'<div data-wds-three></div>',css:'.katex{font-family:KaTeX_Main}'}]}});
  assert(!hidden.three&&!hidden.timeline&&!hidden.timelineContent);
});

test('Local custom scripts are analyzed and user code is never rewritten as CSS or HTML',async()=>{
  const code='window.exportTest = "url(assets/missing.png) <img src=\'assets/missing.png\'>";';
  const f=fixture(full('<script src="custom.js"></script>'),{extra:{'custom.js':code}});
  const html=await deckDocument({...f,portable:true});
  assert(html.includes(code));assert(!report(html).features.three);
  const docs=await f.browser(),browser=docs.documentFor('/api/projects/demo/export');assert(browser.includes(code));
});

test('Repeated formulas embed one CSS/font payload; ordinary unused font files are never read',async()=>{
  const f=fixture(native((mathLink+formula).repeat(12)));
  const html=await deckDocument({...f,portable:true});
  assert.equal((html.match(/data:font\/woff2;base64/g)||[]).length,1);
  assert.equal((html.match(/@font-face/g)||[]).length,1);
  assert(!f.reads.some(p=>/main\.(woff|ttf)$|unused/.test(p)));
  const docs=await f.browser(),browser=docs.documentFor('/api/projects/demo/export');
  assert.equal((browser.match(/data:font\/woff2;base64/g)||[]).length,1);
  assert.deepEqual(report(browser).fonts,report(html).fonts);
});

test('Raw patch and timeline fragments bundle assets globally without nesting runtimes or altering JS/LaTeX',async()=>{
  const userJs='const tex="\\\\frac{url(assets/x.png)}{x}";';
  const f=fixture(full('<div id="stage"><section class="slide active"></section></div>'),{kind:'raw',patches:[{type:'insert',slide:0,html:full(mathLink+formula)},{type:'js',js:userJs}],timeline:{duration:1000,tracks:[{id:'svg',html:mathLink+'<svg><text class="katex">x</text></svg>',selector:'#draw',keyframes:[{t:0,props:{opacity:0}},{t:1000,props:{opacity:1}}]}]}});
  for(const html of [await deckDocument({...f,portable:true}),(await f.browser()).documentFor('/api/projects/demo/export')]){
    const doc=parseHTML(html).document,patches=JSON.parse(doc.querySelector('#wpx-raw-patches').textContent);
    assert.equal(patches[1].js,userJs);
    assert(!patches[0].html.includes('data-wds-runtime'));
    assert.equal((html.match(/data:font\/woff2;base64/g)||[]).length,1);
    assert(doc.head.textContent.includes('@font-face'));
    assert(report(html).features.timeline&&report(html).features.timelineContent);
  }
});

test('Raw CSS dedup preserves element paths used by edit patches',async()=>{
  const f=fixture(full('<section class="slide">'+mathLink+formula+mathLink+'<h1>Target</h1></section>'),{kind:'raw',patches:[{type:'attr',slide:0,path:'3',attrs:{title:'updated'}}]});
  for(const html of [await deckDocument({...f,portable:true}),(await f.browser()).documentFor('/api/projects/demo/export')])assert.equal(parseHTML(html).document.querySelector('.slide').children[3].localName,'h1');
});

test('Reimported optimized HTML does not accumulate runtime or formula payloads',async()=>{
  const f=fixture(native(mathLink+formula+'<div data-wpx-anim="fadeUp"></div>'));
  const first=await deckDocument({...f,portable:true});f.files['index.html']=first;
  const second=await deckDocument({...f,portable:true});
  const doc=parseHTML(second).document;
  for(const kind of ['fx','deck','presentation-tools','export-manifest'])assert.equal(doc.querySelectorAll('[data-wds-runtime="'+kind+'"]').length,1);
  assert.equal((second.match(/data:font\/woff2;base64/g)||[]).length,1);
  assert(!report(second).features.three);assert(second.length<first.length*1.02);
});

test('Browser project and saved-version exports use identical plans; live editing retains capabilities',async()=>{
  const f=fixture(native('<section class="wpx-slide"><div data-wpx-anim="fadeUp"></div></section>'));
  const docs=await f.browser(),server=report(await deckDocument({...f,portable:true}));
  for(const url of ['/api/projects/demo/export','/api/projects/demo/versions/saved/export']){
    const r=report(docs.documentFor(url));assert.deepEqual(r.features,server.features);assert.deepEqual(r.effects,server.effects);
    assert.deepEqual(r.transitions,server.transitions);
  }
  const edit=docs.documentFor('/p/demo/index.html?wpx=edit');
  assert(edit.includes('__WDS_THREE_RUNTIME_URL__'));assert(edit.includes('data-wds-runtime="timeline-content"'));assert(!edit.includes('id="wds-export-manifest"'));
});
