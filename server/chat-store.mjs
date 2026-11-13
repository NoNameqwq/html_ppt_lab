import { promises as fs } from 'node:fs';
import path from 'node:path';

function chatPath(dir, session) {
  if (!session || session === 'default') return path.join(dir, '.chat.json');
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(session)) throw new Error('会话 ID 无效');
  return path.join(dir, '.chats', session + '.json');
}
export async function readChat(dir, session) {
  try { return JSON.parse(await fs.readFile(chatPath(dir, session), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; return { messages: [], skills: [], updatedAt: 0 }; }
}
export async function saveChat(dir, session, body) {
  const target = chatPath(dir, session);
  const data = { messages: Array.isArray(body.messages) ? body.messages : [], skills: Array.isArray(body.skills) ? body.skills : [], summary: body.summary || null, updatedAt: Date.now(),
    ...(body.title ? { title: String(body.title).slice(0, 120) } : {}), ...(body.origin ? { origin: body.origin } : {}) };
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data), 'utf8');
  await fs.rename(temp, target);
  return { ok: true, updatedAt: data.updatedAt };
}
export async function listChats(dir) {
  const files = await fs.readdir(path.join(dir, '.chats')).catch(() => []);
  const ids = ['default', ...files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))];
  const chats = await Promise.all(ids.map(async (id) => {
    const data = await readChat(dir, id);
    const users = data.messages.filter((m) => m.role === 'user' && !m.synthetic && !m.versionEvent);
    return { id, title: data.title || users[0]?.content?.slice(0, 80) || '新对话', updatedAt: data.updatedAt, turns: users.length, origin: data.origin };
  }));
  return { chats: chats.filter((c) => c.turns).sort((a, b) => b.updatedAt - a.updatedAt) };
}
