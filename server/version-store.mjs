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
const busy = e => ['EPERM', 'EACCES', 'EBUSY'].includes(e?.code);
async function retryBusy(fn) {
  for (const delay of [0, 30, 80, 160, 300]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try { return await fn(); } catch (e) { if (!busy(e) || delay === 300) throw e; }
  }
}
async function stat(file) { try { return await fs.lstat(file); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; } }
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
  try { await fs.writeFile(temp, data); await retryBusy(() => fs.rename(temp, file)); }
  finally { await fs.rm(temp, { force: true, maxRetries: 5, retryDelay: 50 }); }
}
function validPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || rel.includes(':') || rel.includes('\0') || path.posix.isAbsolute(rel)
    || rel.split('/').some((s) => !s || s === '.' || s === '..' || /[<>"|?*]|[. ]$/.test(s)) || kept(rel.split('/')[0])) throw error('版本文件路径无效');
  return rel;
}
async function tree(dir, directories = [], prefix = '') {
  const files = [];
  async function walk(at, prefix = '') {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      if (!prefix && kept(entry.name)) continue;
      const rel = validPath(prefix + entry.name), file = path.join(at, entry.name), s = await fs.lstat(file);
      if (s.isSymbolicLink()) throw error('工程含链接，无法安全建立版本：' + rel);
      if (s.isDirectory()) { directories.push(rel); await walk(file, rel + '/'); }
      else if (s.isFile()) files.push({ path: rel, file, size: s.size });
      else throw error('不支持的工程文件：' + rel);
    }
  }
  await walk(dir, prefix);
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

const deepestFirst = (a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b);
function parentDirectories(paths) {
  const dirs = new Set();
  for (const rel of paths) {
    let parent = path.posix.dirname(rel);
    while (parent !== '.') { dirs.add(parent); parent = path.posix.dirname(parent); }
  }
  return [...dirs];
}
async function stageFiles(dir, files, destination, legacyData) {
  for (const [rel, f] of Object.entries(files)) {
    validPath(rel);
    const data = legacyData || await blob(dir, f.hash);
    if (data.length !== f.size || hash(data) !== f.hash) throw error('版本文件大小或摘要校验失败，未更改工程', 409);
    const target = path.join(destination, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }
}
async function installFile(source, target) {
  try { await retryBusy(() => fs.rename(source, target)); }
  catch (e) {
    if (!busy(e)) throw e;
    // Windows handles can allow writing while denying delete/rename sharing.
    // The durable journal and verified before-blobs cover interrupted copies.
    await retryBusy(() => fs.copyFile(source, target));
  }
}
async function applyFiles(dir, files, paths, directories, managedDirectories, staged) {
  // Never recursively delete a live directory: unchanged/locked assets stay put.
  // All supplied paths were journaled before mutations and exclude private data.
  await tree(dir);
  for (const rel of [...paths].sort(deepestFirst)) {
    const target = path.join(dir, rel), s = await stat(target);
    if (s?.isFile() && !Object.hasOwn(files, rel)) await retryBusy(() => fs.unlink(target));
  }
  const wanted = new Set(directories);
  for (const rel of [...managedDirectories].sort(deepestFirst)) {
    if (wanted.has(rel)) continue;
    const target = path.join(dir, rel), s = await stat(target);
    if (s?.isDirectory()) await retryBusy(() => fs.rmdir(target));
  }
  for (const rel of [...directories].sort((a, b) => -deepestFirst(a, b))) await directory(path.join(dir, rel));
  for (const [rel, f] of Object.entries(files)) {
    const target = path.join(dir, rel), s = await stat(target);
    if (s?.isFile() && hash(await fs.readFile(target)) === f.hash) continue;
    await installFile(path.join(staged, rel), target);
    if (hash(await fs.readFile(target)) !== f.hash) throw error('版本文件写入校验失败：' + rel, 409);
  }
}
async function cleanupStage(stage) {
  // A committed restore must not turn into a reported failure just because a
  // scanner still holds an obsolete transaction file. Such leftovers are inert.
  try { await fs.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  catch (e) { if (!busy(e) && !['ENOTEMPTY', 'ENOENT'].includes(e.code)) console.warn('[versions] 暂存目录清理失败', e.message); }
}
function validateFileJournal(tx) {
  if (!Array.isArray(tx.paths) || !Array.isArray(tx.beforeDirectories) || !Array.isArray(tx.afterDirectories)
    || !tx.before || typeof tx.before !== 'object' || Array.isArray(tx.before)) throw error('版本恢复日志无效', 409);
  for (const rel of [...tx.paths, ...tx.beforeDirectories, ...tx.afterDirectories, ...Object.keys(tx.before)]) validPath(rel);
  if (Object.keys(tx.before).some(rel => !tx.paths.includes(rel)) || new Set(tx.paths).size !== tx.paths.length) throw error('版本恢复日志无效', 409);
  // No manifest may require the same path to be both a file and an ancestor.
  const beforeDirs = new Set(tx.beforeDirectories), afterDirs = new Set(tx.afterDirectories);
  if (beforeDirs.size !== tx.beforeDirectories.length || afterDirs.size !== tx.afterDirectories.length
    || parentDirectories([...Object.keys(tx.before), ...beforeDirs]).some(rel => !beforeDirs.has(rel))
    || parentDirectories([...afterDirs]).some(rel => !afterDirs.has(rel))
    || [...beforeDirs].some(rel => Object.hasOwn(tx.before, rel))) throw error('版本恢复日志文件结构冲突', 409);
}

// Upgrade old directory-swap journals before touching the live tree. Old backups
// stay intact until commit, so recovery is repeatable even if it is interrupted.
async function upgradeLegacyTransaction(dir, tx, stage, journal) {
  if (!Array.isArray(tx.names) || !Array.isArray(tx.original)) throw error('版本恢复日志无效', 409);
  for (const name of [...tx.names, ...tx.original]) { validPath(name); if (name.includes('/')) throw error('版本恢复日志无效', 409); }
  // Legacy HTML-only restores journaled every original root but managed index.html only.
  if (new Set(tx.names).size !== tx.names.length || new Set(tx.original).size !== tx.original.length) throw error('版本恢复日志无效', 409);
  const liveDirs = [], current = await tree(dir, liveDirs), before = {}, directories = new Set(liveDirs);
  const paths = new Set(current.filter(f => tx.names.includes(f.path.split('/')[0])).map(f => f.path));
  for (const name of tx.names) {
    const moved = path.join(stage, 'old', name), s = await stat(moved);
    if (s?.isSymbolicLink()) throw error('版本恢复备份不能是链接', 409);
    const managed = rel => rel === name || rel.startsWith(name + '/');
    if (s || !tx.original.includes(name)) for (const rel of [...directories]) if (managed(rel)) directories.delete(rel);
    if (!s) {
      if (tx.original.includes(name)) for (const f of current.filter(f => managed(f.path))) before[f.path] = { hash: await putBlob(dir, await fs.readFile(f.file)), size: f.size };
      continue;
    }
    let oldFiles;
    if (s.isFile()) oldFiles = [{ path: name, file: moved, size: s.size }];
    else if (s.isDirectory()) {
      const oldDirs = [];
      oldFiles = await tree(moved, oldDirs, name + '/');
      directories.add(name); oldDirs.forEach(rel => directories.add(rel));
    } else throw error('不支持的版本恢复备份', 409);
    for (const f of oldFiles) { const data = await fs.readFile(f.file); before[f.path] = { hash: await putBlob(dir, data), size: data.length }; paths.add(f.path); }
  }
  const upgraded = { schema: 2, id: tx.id, paths: [...paths], before, beforeDirectories: [...directories], afterDirectories: liveDirs,
    ...(tx.chat ? { chat: tx.chat, sessionId: tx.sessionId } : {}) };
  validateFileJournal(upgraded);
  await atomic(journal, JSON.stringify(upgraded));
  return upgraded;
}

/* Changed files are staged and before-blobs journaled before writes. Recovery
   reconciles files in place instead of renaming directories held by Windows.
   All restore/recovery calls must run under the project lock. */
export async function recoverVersionTransaction(dir) {
  const journal = storePath(dir, 'transaction.json');
  if (!(await stat(journal))) return;
  await init(dir);
  let tx = JSON.parse(await fs.readFile(journal, 'utf8'));
  if (!/^v-[a-z0-9]+-[a-f0-9]{12}$/.test(tx.id)) throw error('版本恢复日志无效', 409);
  const stage = storePath(dir, 'transactions', tx.id);
  await directory(storePath(dir, 'transactions')); await directory(stage);
  if (tx.schema === undefined) tx = await upgradeLegacyTransaction(dir, tx, stage, journal);
  else if (tx.schema !== 2) throw error('版本恢复日志格式不支持', 409);
  validateFileJournal(tx);
  const rollback = path.join(stage, 'rollback'); await directory(rollback);
  // Verify every rollback asset and conversation before modifying anything.
  await stageFiles(dir, tx.before, rollback);
  const chat = tx.chat ? JSON.parse((await blob(dir, tx.chat)).toString()) : null;
  await applyFiles(dir, tx.before, tx.paths, tx.beforeDirectories, [...new Set([...tx.beforeDirectories, ...tx.afterDirectories])], rollback);
  if (chat) await saveChat(dir, tx.sessionId, chat);
  await retryBusy(() => fs.unlink(journal));
  await cleanupStage(stage);
}
export async function restoreVersion(dir, id, options = {}) {
  await init(dir);
  await recoverVersionTransaction(dir);
  const version = await readVersion(dir, id);
  const chat = options.rewindConversation && version.chatHash ? JSON.parse((await blob(dir, version.chatHash)).toString()) : null;
  if (options.rewindConversation && !chat) throw error('此版本没有对应的对话快照');
  const txId = idOf(), stage = storePath(dir, 'transactions', txId);
  await directory(storePath(dir, 'transactions')); await directory(stage);
  await directory(path.join(stage, 'next'));
  let journalWritten = false;
  try {
    if (parentDirectories(Object.keys(version.files)).some(rel => Object.hasOwn(version.files, rel))) throw error('版本文件结构冲突，未更改工程', 409);
    await stageFiles(dir, version.files, path.join(stage, 'next'), version.kind === 'legacy' ? version.legacyData : null);
    // Validate the live tree (including links) before backing it up or removing anything.
    const beforeDirectories = []; await tree(dir, beforeDirectories);
    const sessionId = version.conversation?.sessionId || 'default';
    const currentChat = chat ? await readChat(dir, sessionId) : null;
    const backup = await captureVersion(dir, { kind: 'backup', label: '回退前自动备份',
      ...(chat ? { conversation: { ...version.conversation, phase: 'after', turnId: '' }, chat: currentChat } : {}) });
    let archivedSession = null;
    if (chat) {
      archivedSession = 'branch-' + txId;
      await saveChat(dir, archivedSession, { ...currentChat, title: '回退前分支 · ' + (currentChat.messages?.find((m) => m.role === 'user')?.content || '对话').slice(0, 50), origin: { sessionId, versionId: id } });
    }
    const baseline = await readVersion(dir, backup.id), originals = baseline.files;
    const paths = (version.kind === 'legacy' ? ['index.html'] : [...new Set([...Object.keys(originals), ...Object.keys(version.files)])])
      .filter(rel => originals[rel]?.hash !== version.files[rel]?.hash);
    const before = Object.fromEntries(paths.filter(rel => Object.hasOwn(originals, rel)).map(rel => [rel, originals[rel]]));
    const after = Object.fromEntries(paths.filter(rel => Object.hasOwn(version.files, rel)).map(rel => [rel, version.files[rel]]));
    const afterDirectories = version.kind === 'legacy' ? beforeDirectories : parentDirectories(Object.keys(version.files));
    const journal = storePath(dir, 'transaction.json');
    await atomic(journal, JSON.stringify({ schema: 2, id: txId, paths, before, beforeDirectories, afterDirectories,
      ...(chat ? { sessionId, chat: await putBlob(dir, Buffer.from(JSON.stringify(currentChat))) } : {}) }));
    journalWritten = true;
    await applyFiles(dir, after, paths, afterDirectories, [...new Set([...beforeDirectories, ...afterDirectories])], path.join(stage, 'next'));
    if (chat) await saveChat(dir, sessionId, chat);
    await retryBusy(() => fs.unlink(journal)); journalWritten = false;
    return { ok: true, version: publicVersion(version), backup, conversation: chat ? { sessionId, archivedSession } : null };
  } catch (e) {
    let recovered = false;
    if (journalWritten) {
      try { await recoverVersionTransaction(dir); journalWritten = false; recovered = true; }
      catch (recoveryError) { throw error('回退中断，自动恢复尚未完成；原文件和恢复日志已保留。请释放占用后重试。原因：' + recoveryError.message, 409); }
    }
    if (busy(e)) throw error('版本回退遇到文件占用或权限限制' + (recovered ? '，已恢复回退前的完整工程' : '，未修改工程') + '。请关闭占用素材的外部程序后重试。原因：' + e.message, 409);
    throw e;
  } finally { if (!journalWritten) await cleanupStage(stage); }
}
