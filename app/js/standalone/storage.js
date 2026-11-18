const DB_NAME = 'webdeck-standalone-v1';
export async function openStorage(seed = {}, portable = null) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME + (portable?._exportId ? '-' + portable._exportId : ''), 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开浏览器存储，请允许本地文件保存数据，或使用 BAT 模式'));
  });
  const saved = await new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('state');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const state = saved || structuredClone(portable) || { settings: structuredClone(seed), projects: {}, templates: {}, chats: {}, imports: {} };
  let pending = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(state);
    pending = pending.catch(() => {}).then(() => new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(snapshot, 'state');
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(new Error('保存失败：浏览器存储空间不足或不可用，请导出工作区备份'));
    }));
    return pending;
  };
  return { state, persist };
}
