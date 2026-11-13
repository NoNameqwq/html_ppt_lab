/* 服务端 API 客户端 */

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
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
  getChat: (id) => request('/api/projects/' + enc(id) + '/chat'),
  putChat: (id, payload) => request('/api/projects/' + enc(id) + '/chat', { method: 'PUT', body: payload }),

  /* ---------- 设置 / AI ---------- */
  getSettings: () => request('/api/settings'),
  putSettings: (patch) => request('/api/settings', { method: 'PUT', body: patch }),
  fetchModels: (payload) => request('/api/ai/models', { method: 'POST', body: payload }),
  skills: () => request('/api/skills'),
  templates: () => request('/api/templates'),
  samples: () => request('/api/samples'),
  fsList: (path) => request('/api/fs/list?path=' + enc(path || '')),
  fsRead: (path) => request('/api/fs/read?path=' + enc(path || '')),

  /**
   * AI 流式对话。
   * @param {object} payload {providerId, model, messages, tools, temperature, maxTokens}
   * @param {(evt:{type:string,[k:string]:any})=>void} onEvent
   * @param {AbortSignal} signal
   */
  async chatStream(payload, onEvent, signal) {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try { const j = await res.json(); detail = j?.error?.message || j?.message || ''; } catch { /* ignore */ }
      throw new ApiError(detail || `AI 请求失败 (${res.status})`, res.status);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try { onEvent(JSON.parse(data)); } catch (err) { console.warn('[api] SSE 解析失败', data.slice(0, 200), err); }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    }
    if (buf) handleLine(buf);
  },
};

export default api;
