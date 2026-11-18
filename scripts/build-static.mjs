import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),args=process.argv.slice(2),outIndex=args.indexOf('--output'),configIndex=args.indexOf('--settings');
const output=path.resolve(root,outIndex>=0?args[outIndex+1]:'WebDeck.html');
const mime=(name)=>({css:'text/css',js:'text/javascript',mjs:'text/javascript',woff2:'font/woff2',woff:'font/woff',ttf:'font/ttf',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg'}[path.extname(name).slice(1)]||'application/octet-stream');
const bundle={resources:{},templates:{},samples:{},skills:[],settings:{providers:[{id:'deepseek',name:'DeepSeek',baseUrl:'https://api.deepseek.com/v1',apiKey:'',model:'deepseek-chat',models:[],wire:'openai'},{id:'opencode',name:'OpenCode Go',baseUrl:'https://opencode.ai/zen/go/v1',apiKey:'',model:'',models:[],wire:'auto'}],agent:{contextLimit:100000000,maxTokens:0,temperature:.7,streaming:true},ui:{},search:{provider:'deepseek',baseUrl:'https://api.deepseek.com',maxResults:5},imageGeneration:{enabled:false,baseUrl:'',apiKey:'',model:'auto',models:[]}}};
async function resources(dir){for(const entry of await fs.readdir(path.join(root,dir),{withFileTypes:true})){const name=dir+'/'+entry.name;
  // hanzi stroke data is ~40MB; the static single file serves /api/hanzi as empty and falls back to text.
  if(entry.name==='hanzi'&&dir==='app/vendor')continue;
  if(entry.isDirectory())await resources(name);else {const bytes=await fs.readFile(path.join(root,name));bundle.resources['/'+name]=`data:${mime(name)};base64,${bytes.toString('base64')}`;}}}
await resources('editor');await resources('app/vendor');
for(const type of ['templates','samples'])for(const entry of await fs.readdir(path.join(root,type),{withFileTypes:true})){
  if(!entry.isDirectory())continue;const directory=path.join(root,type,entry.name);let meta;try{meta=JSON.parse(await fs.readFile(path.join(directory,'template.json'),'utf8'));}catch{meta={id:entry.name,name:entry.name,slides:0};}
  const files={};async function scan(dir,prefix=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const name=prefix+e.name;if(e.isDirectory())await scan(path.join(dir,e.name),name+'/');else{const bytes=await fs.readFile(path.join(dir,e.name));files[name]=/\.(html?|css|js|mjs|json|txt|md)$/i.test(name)?bytes.toString():`data:${mime(name)};base64,${bytes.toString('base64')}`;}}}
  await scan(directory);if(files['index.html'])bundle[type][entry.name]={meta:{...meta,id:entry.name},files};
}
async function skills(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name.startsWith('.')||e.name==='licenses')continue;const file=path.join(dir,e.name);if(e.isDirectory())await skills(file);else if(e.name.endsWith('.md')){const raw=await fs.readFile(file,'utf8'),match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);if(!match)continue;const meta=Object.fromEntries(match[1].split(/\r?\n/).map((l)=>/^([a-zA-Z]+):\s*(.*)$/.exec(l)).filter(Boolean).map((m)=>[m[1],m[2]]));if(meta.id)bundle.skills.push({...meta,default:meta.default==='true',content:raw.slice(match[0].length)});}}}
await skills(path.join(root,'skills'));
if(configIndex>=0){const config=JSON.parse(await fs.readFile(path.resolve(root,args[configIndex+1]),'utf8'));bundle.settings={...bundle.settings,...config};console.log('已内置指定配置（此 HTML 为私有文件，含配置中的密钥）');}
const result=await build({entryPoints:[path.join(root,'app/js/standalone/entry.js')],bundle:true,write:false,format:'iife',platform:'browser',target:['chrome110','firefox115','safari17'],minify:true,legalComments:'inline',
  alias:{'node:path':'path-browserify','node:crypto':path.join(root,'app/js/standalone/crypto.js')},define:{global:'globalThis'},
  plugins:[{name:'embedded-pdf',setup(b){b.onResolve({filter:/^data:/},(args)=>({path:args.path,external:true}));b.onLoad({filter:/attachments\.js$/},async({path:file})=>({contents:(await fs.readFile(file,'utf8')).replace("import('/app/vendor/pdfjs/pdf.min.mjs')",`import(${JSON.stringify(bundle.resources['/app/vendor/pdfjs/pdf.min.mjs'])})`).replace("'/app/vendor/pdfjs/pdf.worker.min.mjs'",'window.__WDS_STATIC__.pdfWorkerUrl'),loader:'js'}));
    b.onLoad({filter:/(?:settings|image-settings)\.js$/},async({path:file})=>({contents:(await fs.readFile(file,'utf8')).replaceAll('Key 只存服务端','Key 保存在此浏览器').replaceAll('密钥仅保存在本地服务端','密钥保存在此浏览器或私有 HTML'),loader:'js'}));}}]});
let html=await fs.readFile(path.join(root,'app/index.html'),'utf8');
html=html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g,(tag)=>{const name=/href="([^"]+)"/.exec(tag)?.[1];if(!name)return tag;return `<!-- inline:${name} -->`;});
for(const match of [...html.matchAll(/<!-- inline:([^ ]+) -->/g)]){
  const file=match[1],source=await fs.readFile(path.join(root,file.slice(1)),'utf8');const css=source.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,(all,q,url)=>{if(/^(data:|https?:|#)/.test(url))return all;const name=path.posix.resolve(path.posix.dirname(file),url);return bundle.resources[name]?`url(${bundle.resources[name]})`:all;});html=html.replace(match[0],()=>'<style>'+css.replace(/<\/style/gi,'<\\/style')+'</style>');
}
html=html.replace(/<script\b[^>]*type="module"[^>]*src="[^"]+"[^>]*>\s*<\/script>/g,'');
html=html.replace(/<script\b[^>]*src="(\/editor\/[^"?]+\.js)"[^>]*>\s*<\/script>/g,(tag,name)=>bundle.resources[name]?'<script>'+Buffer.from(bundle.resources[name].split(',')[1],'base64').toString().replace(/<!--/g,'\\x3c!--').replace(/<\/script/gi,'<\\/script')+'</script>':tag);
// HTML tokenizers can enter the double-escaped script state on <!-- followed
// by <script inside a JavaScript string. Escape the comment opener too, so the
// real closing script tag always terminates the bundled workbench.
const data=JSON.stringify(bundle).replace(/</g,'\\u003c'),js=result.outputFiles[0].text.replace(/<!--/g,'\\x3c!--').replace(/<\/script/gi,'<\\/script');
html=html.replace('</body>',()=>`<script id="wds-static-bundle" type="application/json">${data}</script><script>${js}</script></body>`);
await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,html,'utf8');
console.log(`静态工作台已生成：${output}（${(Buffer.byteLength(html)/1024/1024).toFixed(1)} MB）`);
