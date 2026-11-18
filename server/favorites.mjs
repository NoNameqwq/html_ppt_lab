import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { favoriteId, normalizeFavorite, favoriteSummary } from '../app/js/core/favorite-data.js';

export function favoriteStore(root) {
  const base = path.resolve(root);
  async function init() {
    await fs.mkdir(base, { recursive: true });
    const s = await fs.lstat(base);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('收藏目录不能是链接');
  }
  const file = id => path.join(base, favoriteId(id) + '.json');
  async function read(id) {
    await init(); const target = file(id);
    try {
      const s = await fs.lstat(target); if (!s.isFile() || s.isSymbolicLink()) throw new Error('收藏文件无效');
      const data = JSON.parse(await fs.readFile(target, 'utf8'));
      return { ...normalizeFavorite(data, data), updatedAt: data.updatedAt, id: favoriteId(id) };
    } catch (e) { if (e.code === 'ENOENT') throw Object.assign(new Error('收藏不存在'), { status: 404 }); throw e; }
  }
  async function write(item) {
    const target = file(item.id), temp = target + '.' + crypto.randomUUID() + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify(item), { flag: 'wx' }); await fs.rename(temp, target); }
    finally { await fs.rm(temp, { force: true }); }
    return item;
  }
  return {
    read,
    async list() { await init(); const rows = []; for (const name of await fs.readdir(base)) if (/^el-[a-z0-9-]+\.json$/.test(name)) rows.push(favoriteSummary(await read(name.slice(0, -5)))); return rows.sort((a,b) => b.createdAt - a.createdAt); },
    async save(body) { await init(); return write({ ...normalizeFavorite(body), id: 'el-' + crypto.randomUUID() }); },
    async update(id, body) { const previous = await read(id); return write({ ...normalizeFavorite({ name: body.name, description: body.description }, previous), id }); },
    async remove(id) { await read(id); await fs.unlink(file(id)); return { ok: true }; },
  };
}
