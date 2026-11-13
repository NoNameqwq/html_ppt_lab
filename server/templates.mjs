import {promises as fs} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import {openArchive,archivePath} from './archive.mjs';

const ignored=(name)=>name.startsWith('.')&&!['.raw-edits.json','.raw-timeline.json','.raw-deck.json'].includes(name)||['project.json','template.json'].includes(name);
export function templateStore({customRoot,builtinRoot}) {
  const directory=(id)=>{
    if(!/^[a-zA-Z0-9_-]+$/.test(id||''))throw new Error('模板 ID 无效');
    return path.join(id.startsWith('custom-')?customRoot:builtinRoot,id);
  };
  async function read(id,rel='index.html'){archivePath(rel);return fs.readFile(path.join(directory(id),rel));}
  async function list(){await fs.mkdir(customRoot,{recursive:true});const out=[];for(const e of await fs.readdir(customRoot,{withFileTypes:true}))if(e.isDirectory()&&e.name.startsWith('custom-'))try{out.push({...JSON.parse(await read(e.name,'template.json')),id:e.name,custom:true,preview:`/templates/${e.name}/index.html?wpx=thumb`});}catch{}return out;}
  async function files(dir) {
    const out=new Map();let total=0;
    async function walk(at,prefix='') {for(const entry of await fs.readdir(at,{withFileTypes:true})) {
      if(!prefix&&ignored(entry.name))continue;
      const file=path.join(at,entry.name),rel=prefix+entry.name,stat=await fs.lstat(file);
      if(stat.isSymbolicLink())throw new Error('模板不能包含符号链接');
      archivePath(rel);if(stat.isDirectory())await walk(file,rel+'/');else if(stat.isFile()){total+=stat.size;if(total>200*1024*1024)throw new Error('模板资源总量超过 200MB');out.set(rel,await fs.readFile(file));}
    }}await walk(dir);return out;
  }
  async function save({name,desc='',content,bytes,fileName,projectDir,converted,kind}) {
    let entries=new Map(),sourceMeta={};
    if(projectDir){entries=await files(projectDir);sourceMeta=JSON.parse(await fs.readFile(path.join(projectDir,'project.json'),'utf8'));kind=sourceMeta.kind;}
    else if(converted){entries=new Map(converted.assets);entries.set('index.html',Buffer.from(converted.html));kind='native';}
    else if(bytes&&/\.zip$/i.test(fileName||'')) {
      const zip=await openArchive(bytes),names=Object.keys(zip.files).filter((n)=>!zip.files[n].dir),indices=names.filter((n)=>/(^|\/)index\.html$/i.test(n));
      const root=names.includes('index.html')?'':indices.length===1?indices[0].slice(0,-10):null;
      if(root===null)throw new Error('模板 ZIP 需要包含唯一的 index.html');
      for(const file of names)if(file.startsWith(root)) {
        const rel=file.slice(root.length);archivePath(rel);
        if(rel==='template.json'){sourceMeta=JSON.parse(await zip.file(file).async('string'));continue;}
        if(ignored(rel.split('/')[0]))continue;
        entries.set(rel,await zip.file(file).async('nodebuffer'));
      }
      kind=sourceMeta.kind||'raw';
    } else {entries.set('index.html',Buffer.from(content||bytes||''));kind=kind||'raw';}
    const html=entries.get('index.html')?.toString();if(!html||!/<(?:html|body|section|div)\b/i.test(html))throw new Error('模板缺少有效的 HTML 网页');
    if(!['native','raw'].includes(kind))kind='raw';
    const id='custom-'+Date.now().toString(36)+'-'+crypto.randomBytes(4).toString('hex'),dir=directory(id);
    const meta={id,name:String(name||sourceMeta.name||'自定义模板').trim().slice(0,80)||'自定义模板',desc:String(desc||sourceMeta.desc||'').slice(0,300),kind,theme:sourceMeta.theme||'custom',slides:(html.match(/class=["'][^"']*\bwpx-slide\b/g)||[]).length||sourceMeta.slideCount||1,cover:typeof sourceMeta.cover==='object'?sourceMeta.cover:{bg:sourceMeta.cover||'#f4f4f4',fg:sourceMeta.coverFg||'#222',accent:sourceMeta.coverAccent||'#5267df'},custom:true,createdAt:Date.now()};
    await fs.mkdir(dir,{recursive:true});
    try {for(const [rel,data]of entries){const target=path.join(dir,archivePath(rel));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data);}await fs.writeFile(path.join(dir,'template.json'),JSON.stringify(meta,null,2));}
    catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
    return meta;
  }
  async function update(id,changes){if(!id.startsWith('custom-'))throw new Error('内置模板不能修改');const meta=JSON.parse(await read(id,'template.json'));for(const key of ['name','desc'])if(changes[key]!=null)meta[key]=String(changes[key]).trim().slice(0,key==='name'?80:300);if(!meta.name)throw new Error('名称不能为空');await fs.writeFile(path.join(directory(id),'template.json'),JSON.stringify(meta,null,2));return meta;}
  async function remove(id){const dir=directory(id);if(!id.startsWith('custom-')||path.dirname(dir)!==path.resolve(customRoot))throw new Error('只能删除自定义模板');await fs.rm(dir,{recursive:true,force:true});}
  async function exportZip(id){const zip=new JSZip(),dir=directory(id);for(const[rel,data]of await files(dir))zip.file(rel,data);zip.file('template.json',await read(id,'template.json'));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});}
  return {directory,read,list,save,update,remove,exportZip,files};
}
