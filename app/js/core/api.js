/* 服务端 API 客户端 */
import { readSSE } from './sse.js';
let workspaceRestoring=false;
export const setWorkspaceRestoring=value=>{workspaceRestoring=!!value;};

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  if(workspaceRestoring&&method!=='GET'&&!path.startsWith('/api/webdav/'))throw new ApiError('正在恢复工作区，请等待刷新',423);
  const opts = { method, headers: { ...headers }, signal };
  if (body !== undefined) {
    if (body instanceof Blob) {
      opts.body = body;
    } else if (typeof body === 'string') {
      opts.body = body;
      opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'text/plain; charset=utf-8';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    }
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* ignore */ }
    const msg = payload?.error?.message || payload?.message || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, payload);
  }
  if (raw) return res;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

const enc = encodeURIComponent;

export const api = {
  getWebDAV:()=>request('/api/webdav/config'),
  putWebDAV:body=>request('/api/webdav/config',{method:'PUT',body}),
  testWebDAV:body=>request('/api/webdav/test',{method:'POST',body}),
  webDAVBackups:()=>request('/api/webdav/backups'),
  webDAVStatus:()=>request('/api/webdav/status'),
  webDAVBackup:()=>request('/api/webdav/backup',{method:'POST',body:{}}),
  webDAVRestore:name=>request('/api/webdav/restore',{method:'POST',body:{name}}),
  webDAVDownload:(name,recovery=false)=>request('/api/webdav/'+(recovery?'recovery':'download')+'?name='+enc(name),{raw:true}),
  /* ---------- 工程 ---------- */
  listProjects: () => request('/api/projects'),
  getProject: (id) => request('/api/projects/' + enc(id)),
  createProject: (payload) => request('/api/projects', { method: 'POST', body: payload }),
  importProject: (payload) => request('/api/projects/import', { method: 'POST', body: payload }),
  patchProject: (id, patch) => request('/api/projects/' + enc(id), { method: 'PATCH', body: patch }),
  deleteProject: (id) => request('/api/projects/' + enc(id), { method: 'DELETE' }),
  duplicateProject: (id) => request('/api/projects/' + enc(id) + '/duplicate', { method: 'POST', body: {} }),
  upgradeRuntime: (id) => request('/api/projects/' + enc(id) + '/upgrade-runtime', { method: 'POST', body: {} }),

  /* ---------- 文件 ---------- */
  getFile: (id, path = 'index.html') => request(`/api/projects/${enc(id)}/file?path=${enc(path)}`),
  putFile: (id, path, content) => request('/api/projects/' + enc(id) + '/file', { method: 'PUT', body: { path, content } }),
  uploadAssetDataUrl: (id, name, dataUrl) => request('/api/projects/' + enc(id) + '/assets', { method: 'POST', body: { name, dataUrl } }),
  uploadAssetBlob: (id, name, blob) => request(`/api/projects/${enc(id)}/assets?name=${enc(name)}`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' } }),
  exportUrl: (id) => '/api/projects/' + enc(id) + '/export',
  getRawPatches: (id) => request('/api/projects/' + enc(id) + '/patches'),
  putRawPatches: (id, patches) => request('/api/projects/' + enc(id) + '/patches', { method: 'PUT', body: { patches: Array.isArray(patches) ? patches : [] } }),
  projectFileUrl: (id, path = 'index.html') => `/p/${enc(id)}/${path.split('/').map(enc).join('/')}`,
  deckEditUrl: (id, extra = '') => `/p/${enc(id)}/index.html?wpx=edit${extra ? '&' + extra : ''}`,

  /* ---------- 历史 / 会话 ---------- */
  getHistory: (id) => request('/api/projects/' + enc(id) + '/history'),
  putHistory: (id, ops) => request('/api/projects/' + enc(id) + '/history', { method: 'PUT', body: { ops } }),
  getChat: (id, session = 'default') => request((id ? '/api/projects/' + enc(id) : '/api/workspace') + '/chat?session=' + enc(session)),
  putChat: (id, payload, session = 'default') => request((id ? '/api/projects/' + enc(id) : '/api/workspace') + '/chat?session=' + enc(session), { method: 'PUT', body: payload }),
  listChats: (id) => request((id ? '/api/projects/' + enc(id) : '/api/workspace') + '/chats'),
  listVersions: (id) => request('/api/projects/' + enc(id) + '/versions'),
  createVersion: (id, body) => request('/api/projects/' + enc(id) + '/versions', { method: 'POST', body }),
  inspectVersion: (id, version) => request('/api/projects/' + enc(id) + '/versions/' + enc(version)),
  restoreVersion: (id, version, body = {}) => request('/api/projects/' + enc(id) + '/versions/' + enc(version) + '/restore', { method: 'POST', body }),

  /* ---------- 设置 / AI ---------- */
  getSettings: () => request('/api/settings'),
  putSettings: (patch) => request('/api/settings', { method: 'PUT', body: patch }),
  putUserSettings: (patch) => request('/api/settings/user', { method: 'PUT', body: patch }),
  fetchImageModels: (payload, signal) => request('/api/image-models', { method: 'POST', body: payload, signal }),
  testSearchSettings: (payload) => request('/api/settings/test-search', { method: 'POST', body: payload }),
  testChatSettings: (payload, onEvent, signal) => api.chatStream(payload, onEvent, signal, '/api/settings/test-chat'),
  fetchModels: (payload, signal) => request('/api/ai/models', { method: 'POST', body: payload, signal }),
  skills: () => request('/api/skills'),
  templates: () => request('/api/templates'),
  listFavoriteElements: () => request('/api/elements'),
  getFavoriteElement: id => request('/api/elements/' + enc(id)),
  saveFavoriteElement: body => request('/api/elements', { method: 'POST', body }),
  updateFavoriteElement: (id, body) => request('/api/elements/' + enc(id), { method: 'PATCH', body }),
  deleteFavoriteElement: id => request('/api/elements/' + enc(id), { method: 'DELETE' }),
  saveTemplate: (body) => request('/api/templates',{method:'POST',body}),
  updateTemplate: (id,body) => request('/api/templates/'+enc(id),{method:'PATCH',body}),
  deleteTemplate: (id) => request('/api/templates/'+enc(id),{method:'DELETE'}),
  stageImport: (body) => request('/api/imports',{method:'POST',body}),
  samples: () => request('/api/samples'),
  fsList: (path) => request('/api/fs/list?path=' + enc(path || '')),
  fsRead: (path) => request('/api/fs/read?path=' + enc(path || '')),

  /**
   * AI 流式对话。
   * @param {object} payload {providerId, model, messages, tools, temperature, maxTokens}
   * @param {(evt:{type:string,[k:string]:any})=>void} onEvent
   * @param {AbortSignal} signal
   */
  async chatStream(payload, onEvent, signal, endpoint = '/api/ai/chat') {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, ...payload }),
      signal,
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try { const j = await res.json(); detail = j?.error?.message || j?.message || ''; } catch { /* ignore */ }
      throw new ApiError(detail || `AI 请求失败 (${res.status})`, res.status);
    }
    for await (const event of readSSE(res.body, { signal })) {
      if (event.data === '[DONE]') continue;
      let data;
      try { data = JSON.parse(event.data); }
      catch { throw new ApiError('收到无法解析的响应，连接可能已中断。', 502); }
      onEvent(data);
    }
  },
};

export default api;
