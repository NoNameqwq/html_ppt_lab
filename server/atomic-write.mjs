import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const busy = error => ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);

export async function retryBusy(action) {
  for (const delay of [0, 30, 80, 160, 300]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      return await action();
    } catch (error) {
      if (!busy(error) || delay === 300) throw error;
    }
  }
}

export async function atomic(file, data) {
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temp, data);
    await retryBusy(() => fs.rename(temp, file));
  } finally {
    await fs.rm(temp, { force: true, maxRetries: 5, retryDelay: 50 });
  }
}
