const DEFAULTS={enabled:false,baseUrl:'',apiKey:'',model:'auto',models:[],size:'auto',quality:'auto',responseFormat:'auto'};
const SIZES=['auto','1024x1024','1536x1024','1024x1536','1792x1024','1024x1792','512x512','256x256'];
const QUALITIES=['auto','low','medium','high','standard','hd'];
export function publicImageSettings(config={}){
  const c={...DEFAULTS,...config};
  return {enabled:c.enabled===true,baseUrl:c.baseUrl,model:c.model,models:c.models,size:c.size,quality:c.quality,responseFormat:c.responseFormat,defaultModel:'gpt-image-1.5',keySet:!!c.apiKey,configured:!!(c.baseUrl&&c.apiKey)};
}
export function updateImageSettings(current={},patch={}){
  const next={...DEFAULTS,...current};
  for(const key of ['baseUrl','model'])if(patch[key]!==undefined)next[key]=String(patch[key]).trim().slice(0,1000);
  next.model||='auto';
  if(next.baseUrl){let url;try{url=new URL(next.baseUrl);}catch{throw new Error('生图服务地址无效');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('请填写 HTTP(S) Base URL');}
  if(patch.apiKey!==undefined&&typeof patch.apiKey!=='string')throw new Error('API Key 需为文本');
  next.apiKey=patch.clearKey?'':patch.apiKey?.trim()||current.apiKey||'';
  if(next.baseUrl!==current.baseUrl||patch.apiKey?.trim()||patch.clearKey)next.models=[];
  if(Array.isArray(patch.models))next.models=patch.models.slice(0,200).map(m=>({id:String(m?.id||'').slice(0,200)})).filter(m=>m.id);
  for(const [key,values]of [['size',SIZES],['quality',QUALITIES],['responseFormat',['auto','b64_json','url']]]){
    if(patch[key]!==undefined){if(!values.includes(patch[key]))throw new Error('不支持的生图参数：'+key);next[key]=patch[key];}
  }
  if(patch.enabled!==undefined)next.enabled=patch.enabled===true;
  if(next.enabled&&!(next.baseUrl&&next.apiKey))throw new Error('请先填写生图服务地址和 API Key，再手动开启');
  return next;
}
export function generationPayload(config,body,models){
  const prompt=String(body.prompt||'').trim();if(!prompt||prompt.length>24000)throw new Error('生图提示词需为 1–24000 字符');
  const model=body.model||(config.model==='auto'?models[0]?.id||'gpt-image-1.5':config.model);
  const allowed=new Set([...models.map(m=>m.id),...(config.model==='auto'?['gpt-image-1.5']:[config.model])]);
  if(!allowed.has(model))throw new Error('生图模型未配置或未发现');
  const payload={model,prompt,n:1},gpt=/(?:gpt-image|chatgpt-image)/i.test(model);
  const size=body.size||config.size||'auto',quality=body.quality||config.quality||'auto';
  if(!SIZES.includes(size)||!QUALITIES.includes(quality))throw new Error('不支持的图片尺寸或质量');
  if(gpt&&(!['auto','1024x1024','1536x1024','1024x1536'].includes(size)||['standard','hd'].includes(quality)))throw new Error('GPT 生图尺寸或质量无效');
  if(size!=='auto')payload.size=size;if(quality!=='auto')payload.quality=quality;
  if(!gpt&&config.responseFormat&&config.responseFormat!=='auto')payload.response_format=config.responseFormat;
  for(const[key,remoteKey,values]of [['background','background',['auto','opaque','transparent']],['outputFormat','output_format',['png','jpeg','webp']]]){
    if(body[key]!==undefined){if(!gpt||!values.includes(body[key]))throw new Error('不支持的生图参数：'+key);payload[remoteKey]=body[key];}
  }
  if(body.background==='transparent'&&body.outputFormat==='jpeg')throw new Error('透明背景请选择 PNG 或 WebP');
  if(body.outputCompression!==undefined){if(!gpt||!['jpeg','webp'].includes(body.outputFormat)||!Number.isInteger(body.outputCompression)||body.outputCompression<0||body.outputCompression>100)throw new Error('压缩质量需为 0–100 且图片格式为 JPEG / WebP');payload.output_compression=body.outputCompression;}
  return payload;
}
