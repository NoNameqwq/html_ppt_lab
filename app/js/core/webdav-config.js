export const DEFAULT_WEBDAV = { enabled:false, baseUrl:'', username:'', password:'', folder:'WebDeck', autoBackup:true, dailyTime:'03:00', timeZone:'Asia/Shanghai', includeSettings:false };
export const davError = (message,status=400) => Object.assign(new Error(message),{status});
export function normalizeWebDAV(patch={},previous=DEFAULT_WEBDAV) {
  const next={...DEFAULT_WEBDAV,...previous};
  for(const key of ['enabled','autoBackup','includeSettings'])if(patch[key]!==undefined)next[key]=patch[key]===true;
  for(const key of ['baseUrl','username','folder','dailyTime','timeZone'])if(patch[key]!==undefined)next[key]=String(patch[key]).trim();
  if(patch.clearPassword)next.password='';else if(typeof patch.password==='string'&&patch.password)next.password=patch.password;
  if(next.baseUrl){
    let url;try{url=new URL(next.baseUrl);}catch{throw davError('WebDAV 地址无效');}
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw davError('请填写不含账号、密码、查询参数的 HTTP(S) WebDAV 地址');
    next.baseUrl=url.href.replace(/\/+$/,'')+'/';
  }
  if(next.username.length>500||next.password.length>4096||next.username.includes(':'))throw davError('WebDAV 账号或密码格式无效');
  next.folder=next.folder.replace(/^\/+|\/+$/g,'');
  if(!next.folder||next.folder.length>300||next.folder.split('/').some(p=>!p||p==='.'||p==='..'||/[\\\x00-\x1f?#]/.test(p)))throw davError('请填写有效的备份目录，例如 WebDeck');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(next.dailyTime))throw davError('备份时间格式应为 HH:mm');
  try{new Intl.DateTimeFormat('en',{timeZone:next.timeZone}).format();}catch{throw davError('备份时区无效');}
  if(next.enabled&&!next.baseUrl)throw davError('挂载前请填写 WebDAV 地址');
  return Object.fromEntries(Object.keys(DEFAULT_WEBDAV).map(key=>[key,next[key]]));
}
export function publicWebDAV(config={}) { const {password,...rest}=normalizeWebDAV({},config);return {...rest,passwordSet:!!password}; }
export function backupDay(time,zone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(time);
  const get=t=>parts.find(p=>p.type===t).value;
  return {date:`${get('year')}-${get('month')}-${get('day')}`,time:`${get('hour')}:${get('minute')}`};
}
export function backupDue(config,status={},now=Date.now()) {
  if(!config.enabled||!config.autoBackup||status.busy)return false;
  if(status.lastAttemptAt&&now-status.lastAttemptAt<10*60*1000&&status.lastError)return false;
  if(!status.lastSuccessAt)return true;
  const today=backupDay(now,config.timeZone);let slot=today.date;
  if(today.time<config.dailyTime)slot=new Date(Date.parse(slot+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  return backupDay(status.lastSuccessAt,config.timeZone).date<slot;
}
