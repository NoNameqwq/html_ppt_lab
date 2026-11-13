/* Durable project checkpoints. Conversations and the checkpoint store live outside the tree. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readChat, saveChat } from './chat-store.mjs';

const locks = new Map();
export async function withProjectLock(dir, fn) {
  const previous = locks.get(dir) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(dir, next);
  try { return await next; } finally { if (locks.get(dir) === next) locks.delete(dir); }
}
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const kept = (name) => /^(\.versions|\.chats|\.git)$/i.test(name) || /^\.chat\.json(?:\.|$)/i.test(name);
const idOf = () => 'v-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
const storePath = (dir, ...parts) => path.join(dir, '.versions', ...parts);
async function stat(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function directory(file) {
  await fs.mkdir(file, { recursive: true });
  const s = await fs.lstat(file);
  if (!s.isDirectory() || s.isSymbolicLink()) throw error('版本目录不能是链接：' + path.basename(file));
}
async function init(dir) {
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink()) throw error('工程目录不能是链接');
  await directory(storePath(dir));
  await directory(storePath(dir, 'manifests'));
  await directory(storePath(dir, 'blobs'));
}
async function atomic(file, data) {
  const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { await fs.writeFile(temp, data); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
function validPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || path.posix.isAbsolute(rel)
    || rel.split('/').some((s) => !s || s === '.' || s === '..' || /[<>"|?*]|[. ]$/.test(s)) || kept(rel.split('/')[0])) throw error('版本文件路径无效');
  return rel;
}
async function tree(dir) {
  const files = [];
  async function walk(at, prefix = '') {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      if (!prefix && kept(entry.name)) continue;
      const rel = validPath(prefix + entry.name), file = path.join(at, entry.name), s = await fs.lstat(file);
      if (s.isSymbolicLink()) throw error('工程含链接，无法安全建立版本：' + rel);
      if (s.isDirectory()) await walk(file, rel + '/');
      else if (s.isFile()) files.push({ path: rel, file, size: s.size });
      else throw error('不支持的工程文件：' + rel);
    }
  }
  await walk(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function putBlob(dir, data) {
  const digest = hash(data), file = storePath(dir, 'blobs', digest);
  const existing = await stat(file);
  if (!existing) await atomic(file, data);
  else if (!existing.isFile() || existing.isSymbolicLink() || hash(await fs.readFile(file)) !== digest) throw error('版本数据损坏，请保留现场并检查磁盘', 409);
  return digest;
}
async function blob(dir, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw error('版本数据摘要无效', 409);
  const file = storePath(dir, 'blobs', digest), s = await stat(file);
  if (!s?.isFile() || s.isSymbolicLink()) throw error('版本数据缺失', 409);
  const data = await fs.readFile(file);
  if (hash(data) !== digest) throw error('版本数据校验失败，未更改工程', 409);
  return data;
}
const publicVersion = ({ files, chatHash, legacyData, ...v }) => ({ ...v, fileCount: Object.keys(files).length, bytes: Object.values(files).reduce((n, f) => n + f.size, 0), hasConversation: !!chatHash });
export async function captureVersion(dir, options = {}) {
  await init(dir);
  const id = idOf(), files = {};
  for (const file of await tree(dir)) {
    const data = await fs.readFile(file.file);
    files[file.path] = { hash: await putBlob(dir, data), size: data.length };
  }
  const conversation = options.conversation && typeof options.conversation === 'object' ? {
    sessionId: String(options.conversation.sessionId || 'default'), projectId: String(options.conversation.projectId || ''),
    turnId: String(options.conversation.turnId || ''), phase: options.conversation.phase === 'before' ? 'before' : 'after',
  } : null;
  let chatHash;
  if (conversation && options.chat) {
    const chat = structuredClone(options.chat);
    if (conversation.phase === 'after') {
      const turn = chat.messages?.find((m) => m.role === 'user' && m.turnId === conversation.turnId);
      if (turn) {
        turn.versions ||= {}; turn.versions[conversation.projectId] ||= {}; turn.versions[conversation.projectId].after = id;
        if(options.delivery){
          const project=JSON.parse((await fs.readFile(path.join(dir,'project.json'),'utf8')));
          turn.deliveries=[...(turn.deliveries||[]).filter((d)=>d.projectId!==conversation.projectId),{projectId:conversation.projectId,versionId:id,name:project.name,slideCount:project.slideCount||1,status:options.delivery.status==='complete'?'complete':'partial',createdAt:Date.now()}];
        }
      }
    }
    chatHash = await putBlob(dir, Buffer.from(JSON.stringify(chat)));
  }
  const version = { schema: 1, id, createdAt: Date.now(), label: String(options.label || '手动保存').slice(0, 200),
    kind: ['before', 'after', 'backup'].includes(options.kind) ? options.kind : 'manual', files, conversation, ...(chatHash ? { chatHash } : {}) };
  await atomic(storePath(dir, 'manifests', id + '.json'), JSON.stringify(version));
  return publicVersion(version);
}
async function readVersion(dir, id) {
  await init(dir);
  if (/^legacy-[\dT-Z-]+$/.test(id)) {
    const file = storePath(dir, id.slice(7) + '.html'), s = await stat(file);
    if (!s?.isFile() || s.isSymbolicLink()) throw error('版本不存在', 404);
    const data = await fs.readFile(file);
    return { schema: 0, id, createdAt: s.mtimeMs, label: '旧版 HTML 备份', kind: 'legacy', files: { 'index.html': { hash: hash(data), size: data.length } }, legacyData: data };
  }
  if (!/^v-[a-z0-9]+-[a-f0-9]{12}$/.test(id || '')) throw error('版本 ID 无效');
  const file = storePath(dir, 'manifests', id + '.json'), s = await stat(file);
  if (!s?.isFile() || s.isSymbolicLink()) throw error('版本不存在', 404);
  const v = JSON.parse(await fs.readFile(file, 'utf8'));
  if (v.schema !== 1 || v.id !== id || !v.files || Array.isArray(v.files)) throw error('版本清单损坏', 409);
  for (const rel of Object.keys(v.files)) validPath(rel);
  return v;
}
export async function listVersions(dir) {
  await init(dir);
  const versions = [];
  for (const name of await fs.readdir(storePath(dir, 'manifests'))) {
    if (!name.endsWith('.json')) continue;
    // A damaged manifest stays visible as an error instead of disappearing silently.
    try { versions.push(publicVersion(await readVersion(dir, name.slice(0, -5)))); }
    catch { versions.push({ id: name.slice(0, -5), label: '损坏的版本记录', corrupt: true, createdAt: 0 }); }
  }
  for (const name of await fs.readdir(storePath(dir))) if (/^[\dT-Z-]+\.html$/.test(name)) {
    const { legacyData, ...v } = await readVersion(dir, 'legacy-' + name.slice(0, -5)); versions.push(publicVersion(v));
  }
  return versions.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}
export async function inspectVersion(dir, id) {
  const v = await readVersion(dir, id), current = {};
  for (const f of await tree(dir)) current[f.path] = { hash: hash(await fs.readFile(f.file)), size: f.size };
  const paths = v.kind === 'legacy' ? ['index.html'] : [...new Set([...Object.keys(current), ...Object.keys(v.files)])].sort();
  const changes = paths.filter((p) => current[p]?.hash !== v.files[p]?.hash).map((p) => ({ path: p,
    action: !current[p] ? 'restore' : !v.files[p] ? 'remove' : 'replace', currentBytes: current[p]?.size || 0, versionBytes: v.files[p]?.size || 0 }));
  const { legacyData, ...rest } = v;
  return { version: publicVersion(rest), changes };
}

// Read verified bytes from a snapshot, independently of the live project files.
export async function readVersionFile(dir, id, rel) {
  validPath(rel);
  const version=await readVersion(dir,id), entry=version.files[rel];
  if(!entry)return null;
  return version.kind==='legacy'?version.legacyData:blob(dir,entry.hash);
}

/* All blobs are verified and staged before the first project file is touched. A journal
   permits rollback if the process exits during the directory swaps. Call under the project lock. */
export async function recoverVersionTransaction(dir) {
  const journal = storePath(dir, 'transaction.json');
  if (!(await stat(journal))) return;
  await init(dir);
  const tx = JSON.parse(await fs.readFile(journal, 'utf8'));
  if (!/^v-[a-z0-9]+-[a-f0-9]{12}$/.test(tx.id)) throw error('版本恢复日志无效', 409);
  const stage = storePath(dir, 'transactions', tx.id), old = path.join(stage, 'old');
  for (const name of tx.names) {
    validPath(name);
    if (name.includes('/')) throw error('版本恢复日志无效', 409);
    const moved = await stat(path.join(old, name));
    if (moved) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true });
      await fs.rename(path.join(old, name), path.join(dir, name));
    } else if (!tx.original.includes(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
  if (tx.chat) await saveChat(dir, tx.sessionId, JSON.parse((await blob(dir, tx.chat)).toString()));
  await fs.rm(journal, { force: true });
  await fs.rm(stage, { recursive: true, force: true });
}
export async function restoreVersion(dir, id, options = {}) {
  await init(dir);
  const version = await readVersion(dir, id);
  const chat = options.rewindConversation && version.chatHash ? JSON.parse((await blob(dir, version.chatHash)).toString()) : null;
  if (options.rewindConversation && !chat) throw error('此版本没有对应的对话快照');
  const txId = idOf(), stage = storePath(dir, 'transactions', txId);
  await directory(storePath(dir, 'transactions')); await directory(stage);
  await directory(path.join(stage, 'next')); await directory(path.join(stage, 'old'));
  let journalWritten = false;
  try {
    for (const [rel, f] of Object.entries(version.files)) {
      const data = version.kind === 'legacy' ? version.legacyData : await blob(dir, f.hash);
      if (data.length !== f.size) throw error('版本文件大小校验失败', 409);
      const target = path.join(stage, 'next', rel);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data);
    }
    // Validate the live tree (including links) before backing it up or removing anything.
    await tree(dir);
    const sessionId = version.conversation?.sessionId || 'default';
    const currentChat = chat ? await readChat(dir, sessionId) : null;
    const backup = await captureVersion(dir, { kind: 'backup', label: '回退前自动备份',
      ...(chat ? { conversation: { ...version.conversation, phase: 'after', turnId: '' }, chat: currentChat } : {}) });
    let archivedSession = null;
    if (chat) {
      archivedSession = 'branch-' + txId;
      await saveChat(dir, archivedSession, { ...currentChat, title: '回退前分支 · ' + (currentChat.messages?.find((m) => m.role === 'user')?.content || '对话').slice(0, 50), origin: { sessionId, versionId: id } });
    }
    const original = (await fs.readdir(dir)).filter((n) => !kept(n));
    const incoming = await fs.readdir(path.join(stage, 'next'));
    const names = version.kind === 'legacy' ? ['index.html'] : [...new Set([...original, ...incoming])];
    const journal = storePath(dir, 'transaction.json');
    await atomic(journal, JSON.stringify({ id: txId, names, original, ...(chat ? { sessionId, chat: await putBlob(dir, Buffer.from(JSON.stringify(currentChat))) } : {}) }));
    journalWritten = true;
    for (const name of names) {
      if (await stat(path.join(dir, name))) await fs.rename(path.join(dir, name), path.join(stage, 'old', name));
      if (incoming.includes(name)) await fs.rename(path.join(stage, 'next', name), path.join(dir, name));
    }
    if (chat) await saveChat(dir, sessionId, chat);
    await fs.rm(journal, { force: true }); journalWritten = false;
    return { ok: true, version: publicVersion(version), backup, conversation: chat ? { sessionId, archivedSession } : null };
  } catch (e) {
    if (journalWritten) await recoverVersionTransaction(dir);
    throw e;
  } finally { if (!journalWritten || !(await stat(storePath(dir, 'transaction.json')))) await fs.rm(stage, { recursive: true, force: true }); }
}
