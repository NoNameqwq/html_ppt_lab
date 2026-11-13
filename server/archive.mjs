import JSZip from 'jszip';

export function archivePath(value) {
  const name=String(value||'');
  if(!name||name.length>600||/[\\:\0<>"|?*]/.test(name)||name.startsWith('/')||name.split('/').some((p)=>p==='.'||p==='..'||/[. ]$/.test(p)))throw new Error('压缩包包含不安全路径：'+name);
  return name;
}
export async function openArchive(bytes,{maxBytes=200*1024*1024,maxEntries=10000}={}) {
  if(bytes.length>40*1024*1024)throw new Error('文件超过 40MB');
  const zip=await JSZip.loadAsync(bytes),entries=Object.values(zip.files);
  if(entries.length>maxEntries)throw new Error('压缩包文件数量过多');
  let total=0;
  for(const file of entries) {
    archivePath((file.unsafeOriginalName||file.name).replace(/\/$/,''));
    if(((Number(file.unixPermissions)||0)&0o170000)===0o120000)throw new Error('压缩包不允许包含符号链接');
    const size=file._data?.uncompressedSize||0;total+=size;
    if(size>40*1024*1024||total>maxBytes)throw new Error('压缩包展开内容过大');
  }
  return zip;
}
