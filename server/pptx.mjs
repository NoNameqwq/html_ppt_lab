import path from 'node:path';
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { openArchive } from './archive.mjs';

const parser=new XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:'',trimValues:false,parseTagValue:false,parseAttributeValue:false});
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,d=0)=>v!==''&&v!=null&&Number.isFinite(Number(v))?Number(v):d;
const local=(s)=>s.split(':').at(-1);
function nodes(raw=[]) {const tagKey=(r)=>Object.keys(r).find((k)=>!/^[:#?]/.test(k));return raw.filter(tagKey).map((r)=>{const key=tagKey(r);return {tag:local(key),attrs:r[':@']||{},children:nodes(r[key]),text:(r[key]||[]).map((x)=>x['#text']||'').join('')};});}
const child=(n,t)=>n?.children?.find((c)=>c.tag===t),kids=(n,t)=>n?.children?.filter((c)=>c.tag===t)||[];
function all(n,t){return [...(n?.tag===t?[n]:[]),...(n?.children||[]).flatMap((c)=>all(c,t))];}
const attr=(n,k,d='')=>n?.attrs?.[k]??d;
const txt=(n)=>n?(n.text||'')+(n.children||[]).map(txt).join(''):'';
const rgba=(hex,a)=>a===1?hex:`rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;

/** OOXML -> editable WebDeck elements, preserving source slide order and assets. */
export async function convertPptx(bytes,{name='PowerPoint 演示'}={}) {
  const zip=await openArchive(bytes),assets=new Map(),warnings=new Set(),report={slides:0,texts:0,images:0,shapes:0,tables:0,charts:0,warnings:[]};
  const cache=new Map();
  async function xml(file) {
    if(cache.has(file))return cache.get(file);
    const entry=zip.file(file);if(!entry)return null;
    if(entry._data?.uncompressedSize>12*1024*1024)throw new Error('XML 内容过大：'+file);
    const source=await entry.async('string');if(/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('不支持含 DTD 的 Office 文档');
    const result=nodes(parser.parse(source))[0];cache.set(file,result);return result;
  }
  async function rels(file) {
    const source=await xml(path.posix.join(path.posix.dirname(file),'_rels',path.posix.basename(file)+'.rels')),out=new Map();
    for(const rel of kids(source,'Relationship')) {
      if(attr(rel,'TargetMode')==='External')continue;
      const target=attr(rel,'Target'), resolved=path.posix.normalize(target.startsWith('/')?target.slice(1):path.posix.join(path.posix.dirname(file),target));
      if(!resolved.startsWith('../'))out.set(attr(rel,'Id'),{file:resolved,type:attr(rel,'Type').split('/').at(-1)});
    }
    return out;
  }
  const presentation=await xml('ppt/presentation.xml');if(!presentation)throw new Error('文件不是有效的 PPTX 演示文稿');
  const pr=await rels('ppt/presentation.xml'),size=child(presentation,'sldSz'),sw=num(attr(size,'cx'),12192000),sh=num(attr(size,'cy'),6858000);
  if(sw<=0||sh<=0)throw new Error('幻灯片尺寸无效');
  const scale=Math.min(1920/sw,1080/sh),ox=(1920-sw*scale)/2,oy=(1080-sh*scale)/2,px=(v)=>Math.round(num(v)*scale*100)/100;
  const ids=kids(child(presentation,'sldIdLst'),'sldId');if(!ids.length||ids.length>300)throw new Error('支持 1–300 页的 PPTX');
  let serial=0;
  const themeDefaults={dk1:'#000000',lt1:'#ffffff',dk2:'#44546a',lt2:'#e7e6e6',accent1:'#4472c4',accent2:'#ed7d31',accent3:'#a5a5a5',accent4:'#ffc000',accent5:'#5b9bd5',accent6:'#70ad47',tx1:'#000000',bg1:'#ffffff',tx2:'#44546a',bg2:'#e7e6e6'};
  function color(node,theme,fallback='transparent') {
    const c=node?.children?.find((c)=>['srgbClr','schemeClr','sysClr','prstClr'].includes(c.tag));if(!c)return fallback;
    let value=c.tag==='schemeClr'?theme[attr(c,'val')]:c.tag==='sysClr'?'#'+attr(c,'lastClr','000000'):c.tag==='srgbClr'?'#'+attr(c,'val'):{black:'#000000',white:'#ffffff',red:'#ff0000',blue:'#0000ff'}[attr(c,'val')];
    if(!/^#[a-f\d]{6}$/i.test(value||''))value=fallback;
    let rgb=/^#[a-f\d]{6}$/i.test(value)?[1,3,5].map((i)=>parseInt(value.slice(i,i+2),16)):null;
    if(rgb)for(const transform of c.children) {
      const a=num(attr(transform,'val'))/100000;
      if(transform.tag==='tint')rgb=rgb.map((v)=>v+(255-v)*a);
      if(transform.tag==='shade'||transform.tag==='lumMod')rgb=rgb.map((v)=>v*a);
      if(transform.tag==='lumOff')rgb=rgb.map((v)=>v+255*a);
    }
    if(rgb)value='#'+rgb.map((v)=>Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
    return /^#[a-f\d]{6}$/i.test(value)?rgba(value,num(attr(child(c,'alpha'),'val'),100000)/100000):value;
  }
  function fill(node,theme,fallback='transparent') {
    if(child(node,'noFill'))return 'transparent';
    const solid=child(node,'solidFill');if(solid)return color(solid,theme,fallback);
    const grad=child(node,'gradFill');if(grad){const stops=kids(child(grad,'gsLst'),'gs').map((s)=>`${color(s,theme,'#ffffff')} ${num(attr(s,'pos'))/1000}%`);return `linear-gradient(${num(attr(child(grad,'lin'),'ang'))/60000+90}deg,${stops.join(',')})`;}
    return fallback;
  }
  async function image(file) {
    const entry=zip.file(file);if(!entry)return null;
    const ext=path.posix.extname(file).toLowerCase();if(!['.png','.jpg','.jpeg','.gif','.svg','.webp','.bmp'].includes(ext)){warnings.add('部分图片格式（如 EMF/WMF）不能在浏览器直接显示，请使用“外观优先”导入。');return null;}
    const data=await entry.async('nodebuffer'),rel='assets/ppt-'+crypto.createHash('sha256').update(data).digest('hex').slice(0,18)+ext;assets.set(rel,data);return rel;
  }
  function transform(shape,inherited,map) {
    const sp=child(shape,'spPr')||child(shape,'grpSpPr'),xfrm=child(sp,'xfrm')||child(shape,'xfrm')||child(child(inherited,'spPr'),'xfrm');
    const off=child(xfrm,'off'),ext=child(xfrm,'ext'),sx=num(attr(ext,'cx'),sw*.5),sy=num(attr(ext,'cy'),sh*.2);
    return {x:map.x+num(attr(off,'x'))*map.sx,y:map.y+num(attr(off,'y'))*map.sy,w:sx*map.sx,h:sy*map.sy,rotation:num(attr(xfrm,'rot'))/60000,flipH:attr(xfrm,'flipH')==='1',flipV:attr(xfrm,'flipV')==='1',xfrm};
  }
  function box(t){return `left:${px(t.x)+ox}px;top:${px(t.y)+oy}px;width:${Math.max(1,px(t.w))}px;height:${Math.max(1,px(t.h))}px;transform:rotate(${t.rotation}deg) scale(${t.flipH?-1:1},${t.flipV?-1:1});`;}
  function textBody(body,theme,defaults={},masterStyle) {
    if(!body)return '';
    return kids(body,'p').map((p)=>{
      const pp=child(p,'pPr'),lvl=num(attr(pp,'lvl')),style=child(child(body,'lstStyle'),'lvl'+(lvl+1)+'pPr')||child(masterStyle,'lvl'+(lvl+1)+'pPr'),def={...defaults,...(child(style,'defRPr')?.attrs||{}),...(child(pp,'defRPr')?.attrs||{})};
      const align=({ctr:'center',r:'right',just:'justify'})[attr(pp,'algn',attr(style,'algn'))]||'left';
      const bullet=child(pp,'buChar')||child(style,'buChar'),auto=child(pp,'buAutoNum')||child(style,'buAutoNum');
      let runs='';
      for(const run of p.children||[]) {
        if(run.tag==='br'){runs+='<br>';continue;}if(!['r','fld'].includes(run.tag))continue;
        const rp=child(run,'rPr'),rpAttrs={...def,...rp?.attrs},font=child(rp,'ea')||child(rp,'latin'),family=attr(font,'typeface',theme.bodyFont||'Microsoft YaHei').replace(/^\+m[jn]-.*$/,'Microsoft YaHei');
        const text=txt(child(run,'t')),fontSize=Math.max(8,num(rpAttrs.sz,2400)/100*12700*scale);
        const ink=color(child(rp,'solidFill')?rp:child(pp,'defRPr'),theme,theme.tx1||'#111111');
        runs+=`<span style="font-family:${esc(JSON.stringify(family))},sans-serif;font-size:${fontSize}px;font-weight:${rpAttrs.b==='1'?700:400};font-style:${rpAttrs.i==='1'?'italic':'normal'};text-decoration:${rpAttrs.u&&rpAttrs.u!=='none'?'underline':'none'};color:${ink}">${esc(text)}</span>`;
      }
      const before=child(child(pp,'spcBef'),'spcPts'),after=child(child(pp,'spcAft'),'spcPts'),line=child(pp,'lnSpc'),pct=child(line,'spcPct'),points=child(line,'spcPts');
      const lineHeight=pct?num(attr(pct,'val'))/100000:points?px(num(attr(points,'val'))*127)+'px':1.2;
      return `<p style="margin:${px(num(attr(before,'val'))*127)}px 0 ${px(num(attr(after,'val'))*127)}px;text-align:${align};line-height:${lineHeight};padding-left:${px(attr(pp,'marL',attr(style,'marL',0)))}px">${bullet?esc(attr(bullet,'char'))+' ':auto?'• ':''}${runs||'<br>'}</p>`;
    }).join('');
  }
  const slides=[];
  for(let index=0;index<ids.length;index++) {
    const file=pr.get(attr(ids[index],'r:id'))?.file;if(!file)throw new Error('幻灯片顺序引用缺失');
    const slide=await xml(file),sr=await rels(file),layoutFile=[...sr.values()].find((r)=>r.type==='slideLayout')?.file,layout=layoutFile?await xml(layoutFile):null,lr=layoutFile?await rels(layoutFile):new Map(),masterFile=[...lr.values()].find((r)=>r.type==='slideMaster')?.file,master=masterFile?await xml(masterFile):null,mr=masterFile?await rels(masterFile):new Map(),themeFile=[...mr.values()].find((r)=>r.type==='theme')?.file,themeNode=themeFile?await xml(themeFile):null;
    const theme={...themeDefaults};
    for(const item of child(child(themeNode,'themeElements'),'clrScheme')?.children||[])theme[item.tag]=color(item,theme,'#000000');
    const cm=child(master,'clrMap');for(const key of ['tx1','tx2','bg1','bg2'])theme[key]=theme[attr(cm,key,key==='tx1'?'dk1':key==='bg1'?'lt1':key==='tx2'?'dk2':'lt2')];
    theme.bodyFont=attr(child(child(child(child(themeNode,'themeElements'),'fontScheme'),'minorFont'),'ea'),'typeface','Microsoft YaHei');
    const tree=child(child(slide,'cSld'),'spTree'),layoutTree=child(child(layout,'cSld'),'spTree'),masterTree=child(child(master,'cSld'),'spTree');
    const inherited=(shape)=>{const ph=all(shape,'ph')[0];if(!ph)return null;return [...(layoutTree?.children||[]),...(masterTree?.children||[])].find((s)=>{const p=all(s,'ph')[0];return p&&attr(p,'idx','0')===attr(ph,'idx','0')&&attr(p,'type','body')===attr(ph,'type','body');})||[...(layoutTree?.children||[]),...(masterTree?.children||[])].find((s)=>attr(all(s,'ph')[0],'idx','-1')===attr(ph,'idx','0'));};
    let elements='';
    async function draw(shape,relationships,map={x:0,y:0,sx:1,sy:1},background=false) {
      if(shape.tag==='AlternateContent'){const branch=child(shape,'Fallback')||child(shape,'Choice');warnings.add('部分 Office 扩展对象使用兼容表示解析，请检查效果；外观优先模式可保留页面画面。');for(const item of branch?.children||[])await draw(item,relationships,map,background);return;}
      if(!['sp','pic','cxnSp','graphicFrame','grpSp'].includes(shape.tag)){if(!['nvGrpSpPr','grpSpPr','extLst'].includes(shape.tag))warnings.add('部分 Office 对象无法直接转换，请检查导入页面，或使用外观优先模式。');return;}
      const inherit=inherited(shape),t=transform(shape,inherit,map),sp=child(shape,'spPr')||child(inherit,'spPr');
      if(shape.tag==='grpSp') {
        const off=child(t.xfrm,'chOff'),ext=child(t.xfrm,'chExt'),sx=t.w/(num(attr(ext,'cx'))||t.w),sy=t.h/(num(attr(ext,'cy'))||t.h);
        if(t.rotation)warnings.add('旋转组合已展开为单个元素，复杂组合的旋转可能需要微调。');
        for(const item of shape.children)await draw(item,relationships,{x:t.x-num(attr(off,'x'))*sx,y:t.y-num(attr(off,'y'))*sy,sx,sy},background);return;
      }
      const id='ppt-e'+(++serial),data=`class="wpx-el" data-wpx-el="${id}"`,style=box(t);
      if(shape.tag==='pic') {
        const blip=all(shape,'blip')[0],target=relationships.get(attr(blip,'r:embed'))?.file,url=target?await image(target):null;
        if(url){const crop=all(shape,'srcRect')[0],l=num(attr(crop,'l'))/100000,r=num(attr(crop,'r'))/100000,top=num(attr(crop,'t'))/100000,b=num(attr(crop,'b'))/100000;
          elements+=`<div ${data} data-wpx-type="image" style="${style}overflow:hidden"><img alt="${esc(attr(all(shape,'cNvPr')[0],'descr'))}" src="${url}" style="position:absolute;width:${100/Math.max(.01,1-l-r)}%;height:${100/Math.max(.01,1-top-b)}%;left:${-l*100/Math.max(.01,1-l-r)}%;top:${-top*100/Math.max(.01,1-top-b)}%;object-fit:fill"></div>`;report.images++;}else warnings.add('部分图片引用缺失或为外部链接，未能嵌入。');return;
      }
      if(shape.tag==='graphicFrame') {
        const table=all(shape,'tbl')[0];
        if(table){const cols=kids(child(table,'tblGrid'),'gridCol'),rows=kids(table,'tr');
          elements+=`<div ${data} data-wpx-type="text" style="${style}overflow:hidden"><table style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed"><colgroup>${cols.map((c)=>`<col style="width:${px(attr(c,'w'))}px">`).join('')}</colgroup>${rows.map((row)=>`<tr style="height:${px(attr(row,'h'))}px">${kids(row,'tc').map((cell)=>`<td style="border:1px solid #cbd2df;padding:8px;background:${fill(child(cell,'tcPr'),theme,'transparent')}">${textBody(child(cell,'txBody'),theme)}</td>`).join('')}</tr>`).join('')}</table></div>`;report.tables++;return;}
        const chart=all(shape,'chart')[0];
        if(chart){const chartFile=relationships.get(attr(chart,'r:id'))?.file,chartXml=chartFile?await xml(chartFile):null,series=all(chartXml,'ser');
          const vals=series.map((ser)=>all(child(ser,'val'),'pt').map((p)=>num(txt(child(p,'v'))))),categories=all(child(series[0],'cat'),'pt').map((p)=>txt(child(p,'v'))),max=Math.max(1,...vals.flat());
          if(vals.length&&vals[0].length){const n=vals[0].length,bw=800/n/Math.max(1,vals.length);let svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600"><path d="M90 40V510H940" fill="none" stroke="#cbd2df"/>';
            vals.forEach((v,si)=>v.forEach((value,vi)=>{const x=110+vi*800/n+si*bw,height=440*Math.max(0,value)/max;svg+=`<rect x="${x}" y="${510-height}" width="${bw*.8}" height="${height}" fill="${theme['accent'+(si%6+1)]}"/><text x="${x}" y="${495-height}" font-size="18">${value}</text>`;}));categories.forEach((v,i)=>svg+=`<text x="${110+i*800/n}" y="550" font-size="18">${esc(v)}</text>`);svg+='</svg>';elements+=`<div ${data} style="${style}">${svg}</div>`;report.charts++;warnings.add('图表按缓存数据重绘为矢量柱状图，复杂图表样式和动态数据链接不保留。');return;}
        }
        warnings.add('SmartArt、OLE 或不支持的图表未转换，请用“外观优先”保留视觉效果。');return;
      }
      const body=child(shape,'txBody'),ph=all(shape,'ph')[0];
      if(background&&ph)return;
      const bodyPr=child(body,'bodyPr')||child(child(inherit,'txBody'),'bodyPr'),ln=child(sp,'ln'),line=ln&&!child(ln,'noFill')?color(child(ln,'solidFill')?ln:null,theme,theme.tx1):'transparent',width=Math.max(.5,px(attr(ln,'w',12700))),bg=fill(sp,theme),preset=attr(child(sp,'prstGeom'),'prst','rect'),isLine=shape.tag==='cxnSp'||preset==='line';
      let geometry='';
      if(!body||bg!=='transparent'||line!=='transparent'){
        const polygon={triangle:'50% 0,100% 100%,0 100%',rtTriangle:'0 0,100% 100%,0 100%',diamond:'50% 0,100% 50%,50% 100%,0 50%',chevron:'0 0,75% 0,100% 50%,75% 100%,0 100%,25% 50%',hexagon:'25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%'}[preset];
        if(isLine)geometry=`<svg viewBox="0 0 ${Math.max(1,px(t.w))} ${Math.max(1,px(t.h))}" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><path d="M0 0 L${px(t.w)} ${px(t.h)}" stroke="${line==='transparent'?theme.accent1:line}" stroke-width="${width}" fill="none"/></svg>`;
        else geometry=`<div style="position:absolute;inset:0;background:${bg};border:${width}px solid ${line};${preset==='ellipse'?'border-radius:50%;':preset==='roundRect'?'border-radius:20px;':''}${polygon?'clip-path:polygon('+polygon+');':''}"></div>`;
        report.shapes++;
        if(child(sp,'custGeom'))warnings.add('自定义自由曲线已降级为边界框，可用“外观优先”保留形状。');
      }
      const valign=({ctr:'center',b:'flex-end'})[attr(bodyPr,'anchor') ]||'flex-start',padding=['tIns','rIns','bIns','lIns'].map((k)=>px(attr(bodyPr,k,91440))).map((v)=>v+'px').join(' '),masterStyles=child(master,'txStyles'),masterStyle=child(masterStyles,['title','ctrTitle'].includes(attr(ph,'type'))?'titleStyle':'bodyStyle'),defaultRP=all(child(inherit,'txBody'),'defRPr')[0];
      const content=body?textBody(body,theme,defaultRP?.attrs||{},masterStyle):'';
      elements+=`<div ${data} data-wpx-type="${body?'text':'shape'}" style="${style}">${geometry}${body?`<div style="position:relative;width:100%;height:100%;box-sizing:border-box;padding:${padding};display:flex;flex-direction:column;justify-content:${valign};overflow:visible">${content}</div>`:''}</div>`;
      if(body)report.texts++;
      if(all(shape,'oMath').length)warnings.add('Office 数学对象需要重新用 LaTeX 排版，请检查公式。');
    }
    for(const shape of masterTree?.children||[])await draw(shape,mr,undefined,true);
    for(const shape of layoutTree?.children||[])await draw(shape,lr,undefined,true);
    for(const shape of tree?.children||[])await draw(shape,sr);
    const bg=child(child(slide,'cSld'),'bg')||child(child(layout,'cSld'),'bg')||child(child(master,'cSld'),'bg'),background=fill(child(bg,'bgPr'),theme,theme.bg1||'#ffffff');
    const title=txt(all(tree,'t')[0])||'第 '+(index+1)+' 页';
    slides.push(`<section class="wpx-slide" data-id="ppt-s${index+1}" data-name="${esc(title.slice(0,70))}" data-transition="fade" data-bg="${background}" style="background:${background}"><div class="wpx-canvas">${elements}</div></section>`);
    if(child(slide,'timing')||child(slide,'transition'))warnings.add('PowerPoint 动画与转场已替换为网页淡入，可在编辑器中重新设置。');
  }
  report.slides=slides.length;report.warnings=[...warnings];
  const data={title:name,w:1920,h:1080,slides:slides.map((_,i)=>({id:'ppt-s'+(i+1),name:'第 '+(i+1)+' 页',transition:'fade'}))};
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)}</title><link rel="stylesheet" href="/editor/deck-runtime.css" data-wpx-inline="css"><style>:root{--wpx-fg:#111;--wpx-serif:"Microsoft YaHei",sans-serif;--wpx-sans:"Microsoft YaHei",sans-serif}.wpx-el p{margin:0}.wpx-el{box-sizing:border-box}</style></head><body class="wpx-body" data-wpx-grain="off"><div id="wpx-app" data-w="1920" data-h="1080"><div id="wpx-stage">${slides.join('')}</div><div class="wpx-hud"></div></div><script type="application/json" id="wpx-data">${JSON.stringify(data).replace(/</g,'\\u003c')}</script><script src="/editor/fx-presets.js"></script><script src="/editor/deck-runtime.js"></script></body></html>`;
  return {html,assets,report};
}
