import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createProjectBranches } from '../app/js/core/project-branches.js';
import { readChat, saveChat } from './chat-store.mjs';
import { captureVersion, restoreVersion, readVersionChat, listVersions } from './version-store.mjs';
import { atomic } from './atomic-write.mjs';

export function projectBranches(dir, projectId) {
  const file = path.join(dir, '.versions', 'branches.json');
  async function validate() {
    for (const target of [dir, path.dirname(file), file]) {
      const stat = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat?.isSymbolicLink()) throw new Error('分支记录不能使用符号链接');
    }
  }
  return createProjectBranches({ projectId,
    readState: async () => { await validate(); try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } },
    writeState: async data => {
      await validate(); await fs.mkdir(path.dirname(file), { recursive: true });
      await atomic(file, JSON.stringify(data));
    },
    readChat: id => readChat(dir, id), saveChat: (id, chat) => saveChat(dir, id, chat),
    deleteChat: id => fs.rm(path.join(dir, '.chats', id + '.json'), { force: true }),
    capture: options => captureVersion(dir, options), restore: (id, options) => restoreVersion(dir, id, options),
    readVersionChat: id => readVersionChat(dir, id),
    findSessionVersion: async id => (await listVersions(dir)).find(v => v.hasConversation && v.conversation?.sessionId === id && v.conversation?.phase === 'after'),
  });
}
