import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {convertPptx} from './pptx.mjs';

let busy=false;
export async function convertPowerPoint(bytes,{fileName='演示.pptx',name='演示',mode='editable'}={}) {
  if(mode!=='faithful'&&/\.pptx$/i.test(fileName))return convertPptx(bytes,{name});
  if(process.platform!=='win32')throw new Error('旧版 .ppt 和外观优先导入需要 Windows 与 Microsoft PowerPoint。也可先另存为 .pptx 后使用可编辑解析。');
  if(busy)throw new Error('PowerPoint 正在转换另一个文件，请稍后重试');
  busy=true;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wds-ppt-'));
  try {
    const source=path.join(dir,'source'+(/\.ppt$/i.test(fileName)?'.ppt':'.pptx')),output=path.join(dir,mode==='faithful'?'slides':'converted.pptx'),result=path.join(dir,'result.json'),request=path.join(dir,'request.json');
    await fs.writeFile(source,bytes);if(mode==='faithful')await fs.mkdir(output);
    await fs.writeFile(request,JSON.stringify({source,output,result,mode}));
    const script=fileURLToPath(new URL('../scripts/powerpoint-convert.ps1',import.meta.url));
    await new Promise((resolve,reject)=>{
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-RequestPath',request],{windowsHide:true,stdio:['ignore','ignore','pipe']});
      let stderr='',timeout=false;child.stderr.on('data',(b)=>stderr+=b.toString());
      const timer=setTimeout(()=>{timeout=true;child.kill();},90000);
      child.once('error',(e)=>{clearTimeout(timer);reject(e);});child.once('exit',(code)=>{clearTimeout(timer);code===0?resolve():reject(new Error(timeout?'PowerPoint 转换超过 90 秒，请检查文件密码或弹窗，关闭残留 PowerPoint 后重试。':stderr.includes('WDS_POWERPOINT_RUNNING')?'请先关闭正在运行的 PowerPoint，再使用旧版 PPT 或外观优先导入；PPTX 可直接选择可编辑解析。':stderr.includes('WDS_PPT_SLIDES_LIMIT')?'支持最多 300 页的 PowerPoint 文件。':stderr.trim()||'无法启动 PowerPoint，请确认本机已安装并完成首次启动。'));});
    });
    if(mode!=='faithful')return convertPptx(await fs.readFile(output),{name});
    const files=(await fs.readdir(output)).filter((f)=>/\.png$/i.test(f)).sort((a,b)=>numSuffix(a)-numSuffix(b));
    if(!files.length)throw new Error('PowerPoint 没有导出任何页面');
    const assets=new Map(),slides=files.map((file,i)=>{const rel=`assets/ppt-slide-${i+1}.png`;return `<section class="wpx-slide" data-id="ppt-s${i+1}" data-name="第 ${i+1} 页" data-transition="fade"><div class="wpx-canvas"><img class="wpx-el wpx-image" data-wpx-el="ppt-e${i+1}" src="${rel}" style="left:0;top:0;width:1920px;height:1080px;object-fit:contain"></div></section>`;});
    let total=0;for(let i=0;i<files.length;i++){const bytes=await fs.readFile(path.join(output,files[i]));total+=bytes.length;if(total>200*1024*1024)throw new Error('转换后的页面图片超过 200MB，请拆分演示文稿');assets.set(`assets/ppt-slide-${i+1}.png`,bytes);}
    const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor/deck-runtime.css" data-wpx-inline="css"></head><body class="wpx-body"><div id="wpx-app" data-w="1920" data-h="1080"><div id="wpx-stage">${slides.join('')}</div><div class="wpx-hud"></div></div><script src="/editor/fx-presets.js"></script><script src="/editor/deck-runtime.js"></script></body></html>`;
    return {html,assets,report:{slides:files.length,images:files.length,warnings:['外观优先模式将每页保存为图片，原稿中的文字和形状不可单独编辑；可添加新的网页元素。']}};
  } finally {
    busy=false;
    // The path is an absolute directory allocated by mkdtemp under the OS temp root.
    if(path.dirname(dir)===os.tmpdir()&&path.basename(dir).startsWith('wds-ppt-'))await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
function numSuffix(file){return Number(/(\d+)\D*$/.exec(file)?.[1]||0);}
