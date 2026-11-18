import {XMLValidator,XMLParser} from '../../vendor/xml-parser.mjs';

// Completeness checks only. Geometric correctness and appearance still require
// inspection of the sanitized, integrated drawing in its destination page.
export function checkSvgArtifact(content) {
  const text=String(content||''),fences=[...text.matchAll(/```(?:svg|xml|html)?\s*\n([\s\S]*?)```/gi)];
  const candidates=fences.map(m=>m[1].trim()).filter(s=>/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(s));
  const source=candidates.at(-1)||(/<svg\b[\s\S]*<\/svg\s*>/i.exec(text)?.[0]);
  if(!source)return {ok:false,error:'Return one complete SVG source document, including its closing svg tag, in an svg code fence.'};
  if(/<!DOCTYPE|<!ENTITY/i.test(source))return {ok:false,error:'Use a self-contained SVG without a DTD or entity declarations.'};
  if(source.length>1000000)return {ok:false,error:'The SVG exceeds the insertion limit of 1,000,000 characters. Use symbol/use for repeated components or split responsibilities into separately bounded assets without omitting essential detail.'};
  const valid=XMLValidator.validate(source);
  if(valid!==true)return {ok:false,error:'SVG XML is incomplete or malformed: '+valid.err.msg};
  try{
    const data=new XMLParser({ignoreAttributes:false,processEntities:false}).parse(source),svg=data.svg;
    if(!svg)return {ok:false,error:'The artifact must have one SVG root.'};
    const rootKeys=Object.keys(data).filter(k=>!k.startsWith('?'));
    if(rootKeys.length!==1||Array.isArray(svg))return {ok:false,error:'Return one standalone SVG root per drawing task.'};
    const viewBox=String(svg['@_viewBox']||'').trim().split(/[\s,]+/).map(Number);
    if(viewBox.length!==4||viewBox.some(v=>!Number.isFinite(v))||viewBox[2]<=0||viewBox[3]<=0)return {ok:false,error:'Supply a valid viewBox="minX minY width height" matching the shared drawing bounds.'};
    if(svg['@_xmlns']!=='http://www.w3.org/2000/svg')return {ok:false,error:'Set xmlns="http://www.w3.org/2000/svg" on the SVG root.'};
    return {ok:true,kind:'svg',characters:source.length,viewBox,checks:['well-formed XML','complete root','valid viewBox','SVG namespace'],visualInspection:false};
  }catch(error){return {ok:false,error:'SVG parsing failed: '+error.message};}
}
