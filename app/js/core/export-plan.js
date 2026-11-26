// Shared by server, version exports and the browser-only workbench. Analysis
// never executes project JavaScript. Unknown dynamic usage retains dependencies.
import { parse as parseJS } from 'acorn';
import { generate as generateJS } from 'astring';
import * as cssTree from 'css-tree';
import { parseHTML } from 'linkedom';

const json = text => { try { return JSON.parse(text || 'null'); } catch { return null; } };
const property = n => n?.computed ? n.property?.value : n?.property?.name;
const literal = n => {
  if(n?.type==='Literal'&&typeof n.value==='string')return n.value;
  if(n?.type==='TemplateLiteral'&&!n.expressions.length)return n.quasis.map(q=>q.value.cooked??q.value.raw).join('');
  if(n?.type==='BinaryExpression'&&n.operator==='+'){const left=literal(n.left),right=literal(n.right);if(left!==null&&right!==null)return left+right;}
  return null;
};
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const [key,value] of Object.entries(node)) if (!['start','end','loc'].includes(key)) {
    if (Array.isArray(value)) value.forEach(n=>walk(n,visit)); else if (value && typeof value === 'object') walk(value,visit);
  }
};
const ast = code => parseJS(code,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true});
const safeScript = s => s.replace(/<!--/g,'\\x3c!--').replace(/<\/script/gi,'<\\/script');

export function managedScriptKind(node) {
  const path=(node.getAttribute('src')||'').split(/[?#]/)[0],id=node.id,marker=node.getAttribute('data-wds-runtime');
  if(id==='wpx-bridge'||path.endsWith('/editor/bridge.js'))return 'bridge';
  if(id==='wpx-fx'||path.endsWith('/editor/fx-presets.js'))return 'fx';
  if(id==='wpx-runtime'||path.endsWith('/editor/deck-runtime.js'))return 'deck';
  if(/\/katex(?:\.min)?\.js$/.test(path))return 'math';
  if(['bridge','fx','deck','math','three','three-bundle','timeline-content','presentation-tools','export-manifest','type'].includes(marker))return marker;
  for(const name of ['timeline-player','raw-patches','web-runtime','present-shell','type-runtime'])if(marker===name||path.endsWith('/editor/'+name+'.js'))return name;
  // Recognize exports created before runtime tags were preserved on inlining.
  const text=node.textContent||'';
  if(/window\.__WPTL_CONTENT__\s*=\s*function/.test(text))return 'timeline-content';
  if(/window\.__WPW__\s*=/.test(text)&&text.includes('function onSlideChange()'))return 'web-runtime';
  if(/window\.__WPX_SHELL__\s*=\s*true/.test(text))return 'present-shell';
  if(/window\.__WPTL__\s*=/.test(text)&&text.includes('function readData()'))return 'timeline-player';
  if(text.includes('wpx-raw-patches')&&text.includes('function resolve(slide, path)'))return 'raw-patches';
  if(/global\.WPX_FX\s*=\s*FX/.test(text)&&/function def\(/.test(text))return 'fx';
  if(/window\.__WDS_PRESENTATION__\s*=/.test(text)&&text.includes('wds-present-tools'))return 'presentation-tools';
  return null;
}

export function scriptKind(attrs,code='') {
  const {document}=parseHTML('<html><body><script '+attrs+'></script></body></html>');
  const node=document.querySelector('script');node.textContent=code;return managedScriptKind(node);
}

export function exportReferences(html,{patches=[],timeline=null}={}) {
  const fragments=[html,...patches.map(p=>p.html||''),...(timeline?.tracks||[]).filter(t=>!t.hidden).map(t=>t.html||'')];
  const refs=new Map();
  for(const markup of fragments){const {document}=parseHTML(markup);document.querySelectorAll('link[rel="stylesheet"][href],script[src]').forEach(n=>refs.set(n.getAttribute('href')||n.getAttribute('src'),n.localName==='link'?'css':'js'));}
  return refs;
}

export function createExportPlan(html,{patches=[],timeline=null,config={},sources={}}={}) {
  const {document}=parseHTML(html),effects=new Set(),transitions=new Set(['fade']),overlays=new Set();
  const plan={version:1,effects,transitions,overlays,three:false,math:false,timeline:false,timelineContent:false,typeset:false,
    dynamicEffects:false,dynamicTransitions:false,dynamicCss:false,dynamicThree:false,dynamicTimeline:false,
    warnings:[],fontFamilies:new Set(),fontStylesheets:new Set(),fontPatchStyles:[],fontScriptRefs:new Set(),
    dynamicFontWeights:false,dynamicFontSelectors:false,removed:[],sourceBytes:new TextEncoder().encode(html).length};
  const analysis=document.cloneNode(true);
  const fontDocument=document.cloneNode(true);
  const rawSlides=[...new Set(['#stage > .slide','.slide','[data-slide]'].flatMap(selector=>[...fontDocument.querySelectorAll(selector)]))];
  if(!rawSlides.length)rawSlides.push(...fontDocument.querySelectorAll('#stage > section, #app section'));
  const fontSlides=rawSlides.filter(slide=>!rawSlides.some(other=>other!==slide&&other.contains(slide)));
  analysis.querySelectorAll('script').forEach(n=>{if(managedScriptKind(n))n.remove();});
  function conservative(reason){plan.dynamicEffects=plan.dynamicTransitions=plan.dynamicCss=plan.dynamicThree=plan.dynamicTimeline=true;plan.dynamicFontWeights=plan.dynamicFontSelectors=true;plan.warnings.push(reason);}
  let fragmentCount=0;
  function userCode(code) {
    for(const name of code.match(/wds-font-[a-z0-9-]+/gi)||[])plan.fontScriptRefs.add(name.toLowerCase());
    if(/fontWeight|font-weight|\.font\b|cssText|insertRule|replaceSync/.test(code))plan.dynamicFontWeights=true;
    if(/classList|className|setAttribute|createElement|innerHTML|outerHTML|insertAdjacentHTML/.test(code))plan.dynamicFontSelectors=true;
    let tree;try{tree=ast(code);}catch{try{tree=parseJS(code,{ecmaVersion:'latest',sourceType:'module'});}catch{conservative('Unparsed custom script: dependent features retained.');return;}}
    walk(tree,n=>{
      if(n.type==='Identifier'&&n.name==='THREE')plan.three=true;
      if(n.type==='Identifier'&&['katex','renderMathInElement','MathJax'].includes(n.name)){plan.math=true;plan.dynamicCss=true;}
      if(n.type==='Identifier'&&/^(?:eval|Function)$/.test(n.name))conservative('Dynamic script evaluation: dependent features retained.');
      if(n.type==='ImportDeclaration'||n.type==='ImportExpression')conservative('Imported project script: dependent features retained.');
      if(n.type==='Identifier'&&/^(?:WPX_FX|WPX_FX_UTIL|WPX_FX_CATALOG)$/.test(n.name))plan.dynamicEffects=true;
      if(n.type==='MemberExpression'&&property(n)==='WPX_FX')plan.dynamicEffects=true;
      if(n.type==='MemberExpression'&&property(n)==='WPX_FX_UTIL')plan.dynamicEffects=true;
      if(n.type==='MemberExpression'&&property(n)==='WPX_TRANSITIONS')plan.dynamicTransitions=true;
      if(n.type==='MemberExpression'&&/^timeline|^setTimeline/.test(property(n)||''))plan.dynamicTimeline=true;
      if(n.type==='CallExpression'&&n.callee.type==='MemberExpression') {
        const name=property(n.callee),args=n.arguments;
        if(['setTimeline','setTimelineData'].includes(name))conservative('Runtime timeline replacement: generated content dependencies retained.');
        if(name==='assign'&&args.some(a=>a.type==='MemberExpression'&&['style','dataset'].includes(property(a))))conservative('Dynamic DOM property assignment: dependent features retained.');
        if(name==='createElement'){plan.dynamicCss=true;if(['script','link','style'].includes(literal(args[0])))conservative('Runtime resource creation: dependent features retained.');}
        if(['add','remove','toggle','replace'].includes(name)&&property(n.callee.object)==='classList')plan.dynamicCss=true;
        if(name==='setProperty'||name==='insertRule'||name==='replaceSync')plan.dynamicCss=true;
        if(name==='setTransition'){const value=literal(args[1]);if(value)transitions.add(value);else plan.dynamicTransitions=true;}
        if(name==='setAttribute') {
          const key=literal(args[0]),value=literal(args[1]);
          if(key===null)conservative('Dynamic attribute name: dependent features retained.');
          if(key==='data-wpx-anim'){if(value)effects.add(value);else plan.dynamicEffects=true;}
          if(key==='data-transition'){if(value)transitions.add(value);else plan.dynamicTransitions=true;}
          if(key==='data-wpx-tr-fx'){if(value)overlays.add(value);else plan.dynamicTransitions=true;}
          if(key==='data-wds-three')plan.three=true;
          if(['style','class'].includes(key))plan.dynamicCss=true;
        }
        if(['write','writeln','insertAdjacentHTML'].includes(name)){const value=literal(args.at(-1));if(value!==null)fragment(value);else conservative('Dynamic HTML construction: dependent features retained.');}
      }
      if(n.type==='AssignmentExpression'&&n.left.type==='MemberExpression') {
        const name=property(n.left),value=literal(n.right);
        if(name===undefined&&property(n.left.object)==='dataset')conservative('Dynamic dataset property: dependent features retained.');
        if(name==='wpxTrFx'){if(value)overlays.add(value);else plan.dynamicTransitions=true;}
        if(name==='wdsThree')plan.three=true;
        if(['innerHTML','outerHTML'].includes(name)){if(value!==null)fragment(value);else conservative('Dynamic HTML assignment: dependent features retained.');}
        if(['className','fontFamily','font','animation','animationName','cssText'].includes(name))plan.dynamicCss=true;
        if(value&&['fontFamily','font','cssText','animation','animationName'].includes(name))plan.styleText+='\n'+value;
        if(name==='wpxAnim'){if(value)effects.add(value);else plan.dynamicEffects=true;}
        if(name==='transition'){if(value)transitions.add(value);else plan.dynamicTransitions=true;}
      }
    });
  }
  plan.styleText='';
  function fragment(markup, detachedFonts = true) {
    if(++fragmentCount>2000){conservative('Nested generated markup limit: dependent features retained.');return;}
    const {document:part}=parseHTML('<html><body>'+markup+'</body></html>');
    inspect(part);
    for(const child of [...part.body.childNodes]){
      analysis.body?.appendChild(child.cloneNode(true));
      if(detachedFonts)fontDocument.body?.appendChild(child.cloneNode(true));
    }
  }
  function timelineFonts(track) {
    const part=parseHTML('<html><body>'+track.html+'</body></html>').document;
    part.querySelectorAll('script,iframe,object,embed').forEach(node=>node.remove());
    const element=part.body.children.length===1?part.body.firstElementChild:part.body;
    const selector=String(track.selector||'');
    const marker=/data-wpx-tl\s*=\s*["']([^"']+)["']/.exec(selector);
    const node=element===part.body?fontDocument.createElement('div'):element.cloneNode(true);
    if(element===part.body)node.innerHTML=element.innerHTML;
    if(marker)node.setAttribute('data-wpx-tl',marker[1]);
    else if(/^#[\w-]+$/.test(selector))node.id=selector.slice(1);
    else if(/^\.[\w-]+$/.test(selector))node.classList.add(selector.slice(1));
    node.setAttribute('data-wpx-timeline-layer',track.id||'effect');
    (fontDocument.querySelector('#wpx-stage,#stage')||fontDocument.body)?.appendChild(node);
  }
  function inspect(doc) {
    if(doc.querySelector('[data-wds-three]'))plan.three=true;
    if(doc.querySelector('.katex,[data-wds-latex]'))plan.math=true;
    if(doc.querySelector('[data-wds-type]'))plan.typeset=true;
    doc.querySelectorAll('[data-wpx-anim]').forEach(n=>effects.add(n.getAttribute('data-wpx-anim')));
    doc.querySelectorAll('[data-transition]').forEach(n=>transitions.add(n.getAttribute('data-transition')));
    doc.querySelectorAll('[data-wpx-tr-fx]').forEach(n=>overlays.add(n.getAttribute('data-wpx-tr-fx')));
    doc.querySelectorAll('[data-wpx-action]').forEach(n=>{const value=n.getAttribute('data-wpx-action');if(value.startsWith('js:'))userCode(value.slice(3));});
    doc.querySelectorAll('style').forEach(n=>{
      if(n.hasAttribute('data-wds-project-fonts'))return;
      plan.styleText+='\n'+n.textContent;
    });
    doc.querySelectorAll('link[rel="stylesheet"][href]').forEach(n=>{const code=sources[n.getAttribute('href')];if(code)plan.styleText+='\n'+code;else plan.dynamicCss=true;});
    doc.querySelectorAll('[style]').forEach(n=>plan.styleText+='\n'+n.getAttribute('style'));
    doc.querySelectorAll('script').forEach(n=>{
      if(managedScriptKind(n))return;
      if(n.id==='wpx-timeline'){const value=json(n.textContent);if(value)timelineData(value);return;}
      if(n.id==='wpx-deck-config'){const value=json(n.textContent);if(value)configData(value);return;}
      if(n.id==='wpx-raw-patches'){const value=json(n.textContent);if(Array.isArray(value))value.forEach(patchData);return;}
      if(n.getAttribute('type')?.includes('json'))return;
      if(n.getAttribute('src')){const code=sources[n.getAttribute('src')];if(code!==undefined)userCode(code);else conservative('External project script: dependent features retained.');return;}
      if(n.textContent.trim())userCode(n.textContent);
    });
    doc.querySelectorAll('*').forEach(n=>{for(const a of n.attributes||[])if(/^on/i.test(a.name)&&a.value)userCode(a.value);});
  }
  function applyFontPatch(p) {
    let target=fontSlides[p.slide];
    if(!target)return false;
    for(const index of String(p.path??'').split('.').filter(Boolean))target=target?.children[Number(index)];
    if(!target)return false;
    switch(p.type){
      case 'html': target.innerHTML=p.html||''; return true;
      case 'style': if(p.cssText)target.setAttribute('style',p.cssText);else target.removeAttribute('style');return true;
      case 'attr':
        for(const [key,value] of Object.entries(p.attrs||{})){
          if(value==null)target.removeAttribute(key);else target.setAttribute(key,value);
        }
        return true;
      case 'insert':
      case 'slide-html': {
        const wrapper=fontDocument.createElement('div');
        wrapper.innerHTML=p.html||'';
        const node=wrapper.firstElementChild;
        if(!node)return false;
        if(p.type==='insert')target.insertBefore(node,target.children[p.index]||null);
        else target.innerHTML=node.innerHTML;
        return true;
      }
      case 'delete': target.remove();return true;
      default: return false;
    }
  }
  function patchData(p){
    const applied=applyFontPatch(p);
    if(p.html)fragment(p.html,!applied);
    if(p.css||p.cssText)plan.styleText+='\n'+(p.css||p.cssText);
    if(p.type==='css')plan.fontPatchCss=p.css||'';
    else if(p.css)plan.fontStylesheets.add(p.css);
    if(!applied&&(p.cssText||p.attrs?.style||p.attrs?.['font-family']||p.attrs?.['font-weight']||p.attrs?.face||p.style)){
      const style=p.style?Object.entries(p.style).map(([k,v])=>k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+':'+v).join(';'):'';
      plan.fontPatchStyles.push([p.cssText,p.attrs?.style,p.attrs?.['font-family']&&'font-family:'+p.attrs['font-family'],p.attrs?.['font-weight']&&'font-weight:'+p.attrs['font-weight'],p.attrs?.face&&'font-family:'+p.attrs.face,style].filter(Boolean).join(';'));
    }
    if(!applied&&p.attrs?.class)plan.dynamicFontSelectors=true;
    if(p.js)userCode(p.js);
    for(const [key,value] of Object.entries(p.attrs||{})){
      if(key==='data-wpx-anim'&&value)effects.add(String(value));
      if(key==='data-transition'&&value)transitions.add(String(value));
      if(key==='data-wpx-tr-fx'&&value)overlays.add(String(value));
      if(key==='data-wds-three'&&value!==null)plan.three=true;
      if(key==='data-wds-latex'&&value!==null)plan.math=true;
      if(['style','class'].includes(key))plan.dynamicCss=true;
    }
    if(p.style){plan.styleText+='\n'+Object.entries(p.style).map(([k,v])=>k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+':'+v).join(';');plan.dynamicCss=true;}
    if(p.cssText)plan.dynamicCss=true;
  }
  function timelineData(value){
    if(value.tracks?.some(t=>!t.hidden)||value.pages?.length)plan.timeline=true;
    for(const t of value.tracks||[])if(!t.hidden){
      if(t.html){plan.timelineContent=true;fragment(t.html,false);timelineFonts(t);}
      if(t.css){plan.styleText+='\n'+t.css;plan.fontStylesheets.add(t.css);}
    }
  }
  function configData(value){for(const name of Object.values(value.transitionFx||{}))if(name&&name!=='none')overlays.add(name);}
  inspect(document);patches.forEach(patchData);if(timeline)timelineData(timeline);configData(config);
  if(plan.fontPatchCss)plan.fontStylesheets.add(plan.fontPatchCss);
  fontDocument.querySelectorAll('style:not([data-wds-project-fonts])').forEach(n=>plan.fontStylesheets.add(n.textContent));
  fontDocument.querySelectorAll('link[rel="stylesheet"][href]').forEach(n=>{
    const code=sources[n.getAttribute('href')];
    if(code)plan.fontStylesheets.add(code);
  });
  plan.three ||= plan.dynamicThree;plan.timeline ||= plan.dynamicTimeline;plan.timelineContent ||= plan.dynamicTimeline;
  plan.math ||= plan.dynamicCss;plan.webRuntime=effects.size>0||overlays.size>0||plan.dynamicEffects||plan.dynamicTransitions;
  Object.defineProperty(plan,'document',{value:analysis});
  Object.defineProperty(plan,'fontDocument',{value:fontDocument});
  return plan;
}

// Remove individual built-in implementations using their syntax tree, including
// grouped switch labels. Custom scripts themselves are never rewritten.
export function optimizeExportScript(code,kind,plan) {
  if(!['fx','deck','timeline-content','timeline-player','web-runtime','present-shell','presentation-tools','raw-patches','three'].includes(kind))return code;
  try {
    const tree=ast(code);
    if(kind==='fx'&&!plan.dynamicEffects) {
      walk(tree,n=>{if(n.type==='BlockStatement')n.body=n.body.filter(s=>!(s.type==='ExpressionStatement'&&s.expression.type==='CallExpression'&&s.expression.callee.name==='def'&&!plan.effects.has(literal(s.expression.arguments[0]))));});
      walk(tree,n=>{if(n.type==='BlockStatement')n.body=n.body.filter(s=>!(s.type==='VariableDeclaration'&&s.declarations.every(d=>['CATS','CATALOG'].includes(d.id.name)))&&!(s.type==='ExpressionStatement'&&s.expression.type==='AssignmentExpression'&&property(s.expression.left)==='WPX_FX_CATALOG'));});
    }
    if(kind==='deck'&&!plan.dynamicTransitions)walk(tree,n=>{
      if(n.type!=='FunctionDeclaration'||n.id?.name!=='transitionTo')return;
      walk(n.body,s=>{
        if(s.type!=='SwitchStatement'||s.discriminant.name!=='name')return;
        let group=[];const keep=[];
        for(const c of s.cases){group.push(c);if(c.consequent.length){if(group.some(g=>!g.test||plan.transitions.has(literal(g.test))))keep.push(...group);group=[];}}
        keep.push(...group);s.cases=keep;
      });
    });
    if(kind==='deck'&&!plan.timeline)walk(tree,n=>{
      if(n.type==='FunctionDeclaration'&&['buildTimelineAnimations','applyTimelineTime','timelineTick','timelinePlay','timelinePause','timelineSeek','setTimelineData','getTimelineData','frameFromProps','buildFrames'].includes(n.id?.name))n.body=ast('function stub(){return null;}').body[0].body;
    });
    if(kind==='deck'&&!plan.overlays.size&&!plan.dynamicTransitions)walk(tree,n=>{if(n.type==='FunctionDeclaration'&&n.id?.name==='applyTransitionFx')n.body={type:'BlockStatement',body:[]};});
    if(['deck','web-runtime'].includes(kind)&&!plan.dynamicTransitions)walk(tree,n=>{
      if(n.type!=='FunctionDeclaration'||!['applyTransitionFx','applyFx'].includes(n.id?.name))return;
      if(!plan.overlays.size){n.body={type:'BlockStatement',body:[]};return;}
      const names=test=>{
        if(test.type==='LogicalExpression'&&test.operator==='||'){const left=names(test.left),right=names(test.right);return left&&right?[...left,...right]:null;}
        if(test.type==='BinaryExpression'&&test.operator==='==='&&test.left.name==='fx'&&literal(test.right))return [literal(test.right)];
        return null;
      };
      const prune=statement=>{
        if(statement?.type!=='IfStatement')return statement;
        const uses=names(statement.test);if(!uses)return statement;
        const alternate=prune(statement.alternate);
        if(!uses.some(name=>plan.overlays.has(name)))return alternate;
        statement.alternate=alternate;return statement;
      };
      n.body.body=n.body.body.map(s=>prune(s)).filter(Boolean);
    });
    return generateJS(tree,{indent:'',lineEnd:''});
  }catch{plan.warnings.push('Unparsed built-in '+kind+': original retained.');return code;}
}

function familyNames(value) {return value.split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')).filter(Boolean);}
function fontRules(tree,plan){
  const used=new Set();
  walkCss(tree,n=>{
    if(n.type!=='Rule')return;
    const selectors=cssTree.generate(n.prelude);let matched=true;
    try{matched=!!plan.document.querySelector(selectors.replace(/::(?:before|after|first-letter|first-line)/g,'').replace(/:(?:hover|active|focus|focus-visible|focus-within)\b/g,''));}catch{/* Unsupported selectors retain their fonts. */}
    if(!matched&&!plan.dynamicCss)return;
    for(const decl of n.block.children)if(decl.type==='Declaration'){
      const value=cssTree.generate(decl.value);
      if(decl.property==='font-family')familyNames(value).forEach(f=>used.add(f));
      // KaTeX's base face is declared with the font shorthand and inherited by
      // most glyphs, rather than a separate font-family declaration.
      if(decl.property==='font')for(const name of value.match(/KaTeX_[\w]+/g)||[])used.add(name);
    }
  });
  for(const m of plan.styleText.matchAll(/font-family\s*:\s*([^;}]+)/gi))familyNames(m[1]).forEach(f=>{if(!f.startsWith('KaTeX_'))used.add(f);});
  return used;
}
function walkCss(tree,fn){cssTree.walk(tree,fn);}

export function optimizeExportCss(code,plan,{math=false}={}) {
  if(math&&!plan.math)return '';
  try {
    const tree=cssTree.parse(code),used=fontRules(tree,plan);
    // Definitions do not count as references. Include declarations from all
    // stylesheets so animations shared across multiple files remain available.
    const animationText=(plan.styleText+'\n'+code).replace(/@(?:-webkit-)?keyframes[^{}]*\{(?:[^{}]|\{[^{}]*\})*\}/gi,'');
    const uncertainFont=/font(?:-family)?\s*:[^;}]*(?:var\(|inherit)/i.test(plan.styleText)||/font\s*:/i.test(plan.styleText);
    cssTree.walk(tree,{visit:'Atrule',enter(node,item,list){
      if(node.name==='font-face') {
        const decls=[...node.block.children],family=decls.find(d=>d.property==='font-family');
        const name=family&&familyNames(cssTree.generate(family.value))[0];
        if(name&&!plan.dynamicCss&&!(uncertainFont&&!name.startsWith('KaTeX_'))&&!used.has(name)){list.remove(item);return;}
        if(name)plan.fontFamilies.add(name);
        const src=decls.find(d=>d.property==='src');
        if(src){const value=cssTree.generate(src.value),sources=value.split(/,(?=\s*(?:url|local)\()/i),woff2=sources.find(s=>/woff2/i.test(s));if(woff2)src.value=cssTree.parse(woff2,{context:'value'});}
      }
      if(/^(?:-webkit-)?keyframes$/.test(node.name)&&!plan.dynamicCss){
        const name=cssTree.generate(node.prelude).replace(/^['"]|['"]$/g,'');
        if(!new RegExp('(?:^|[^\\w-])'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^\\w-])').test(animationText))list.remove(item);
      }
    }});
    return cssTree.generate(tree);
  }catch{plan.warnings.push('Unparsed CSS: original retained.');return code;}
}

export function shouldKeepRuntime(kind,plan) {
  if(kind==='bridge')return false;
  if(kind==='fx')return plan.effects.size>0||plan.dynamicEffects;
  if(kind==='timeline-content')return plan.timelineContent;
  if(kind==='timeline-player')return plan.timeline;
  if(kind==='web-runtime')return plan.webRuntime;
  if(kind==='three'||kind==='three-bundle')return plan.three;
  if(kind==='math')return plan.math;
  if(kind==='type')return plan.typeset;
  return true;
}

export function optimizeExportHtml(html,plan) {
  // Preserve author markup byte-for-byte; only change managed blocks and CSS.
  const seen=new Set();
  html=html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,(all,attrs,code)=>{
    if(/\bid=["']wpx-timeline["']/.test(attrs)&&!plan.dynamicTimeline){
      if(!plan.timeline){plan.removed.push('timeline-data');return '';}
      const data=json(code);
      if(data?.tracks?.some(t=>t.hidden)){plan.removed.push('hidden:timeline-tracks');return '<script '+attrs+'>'+JSON.stringify({...data,tracks:data.tracks.filter(t=>!t.hidden)}).replace(/</g,'\\u003c')+'</script>';}
    }
    const kind=scriptKind(attrs,code);
    if(!kind||kind==='export-manifest')return kind==='export-manifest'?'':all;
    if(!shouldKeepRuntime(kind,plan)){plan.removed.push(kind);return '';}
    if(seen.has(kind)){plan.removed.push('duplicate:'+kind);return '';}seen.add(kind);
    const marker=/\bdata-wds-runtime=/.test(attrs)?'':' data-wds-runtime="'+kind+'"';
    return '<script '+attrs+marker+'>'+safeScript(optimizeExportScript(code,kind,plan))+'</script>';
  });
  return html;
}

export function exportManifest(html,plan) {
  const reasons=[...plan.warnings];
  if(plan.dynamicEffects)reasons.push('Dynamic effect registry access: all preset effects retained.');
  if(plan.dynamicTransitions)reasons.push('Dynamic transition selection: all transition implementations retained.');
  if(plan.dynamicCss)reasons.push('Dynamic styles or markup: font families and CSS animations retained.');
  const report={version:1,features:{three:plan.three,math:plan.math,timeline:plan.timeline,timelineContent:plan.timelineContent},effects:[...plan.effects].sort(),transitions:[...plan.transitions].sort(),fonts:[...plan.fontFamilies].sort(),removed:[...new Set(plan.removed)],conservative:[...new Set(reasons)],payloadBytes:new TextEncoder().encode(html).length};
  const tag='<script type="application/json" id="wds-export-manifest" data-wds-runtime="export-manifest">'+JSON.stringify(report).replace(/</g,'\\u003c')+'</script>';
  return html.includes('</body>')?html.replace('</body>',()=>tag+'</body>'):html+tag;
}
