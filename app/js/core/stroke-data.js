/**
 * 取汉字笔画数据：服务端按字符返回（/api/hanzi），本地缓存与并发合并。
 * 静态版（单个 HTML）走同一路：standalone backend 里注册了 '/api/hanzi'。
 */
const cache = new Map();
const pending = new Map();

function endpoint(chars, set) {
  return `/api/hanzi?chars=${encodeURIComponent(chars)}&set=${encodeURIComponent(set)}`;
}

/** 返回 {char: {strokes, medians, radStrokes}}；取不到时返回空对象（调用方回退为普通文字）。 */
export async function fetchStrokes(text, { set = 'common', signal } = {}) {
  const chars = [...new Set(String(text || '').split(''))].filter((c) => /[㐀-鿿豈-﫿]/.test(c) && !cache.has(c));
  if (!chars.length) return resolveAll(String(text || ''));
  const key = chars.sort().join('');
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      const res = await fetch(endpoint(chars.join(''), set), { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.error?.message || ''; } catch { /* ignore */ }
        throw new Error(detail || `笔画数据请求失败（${res.status}）`);
      }
      const data = await res.json();
      for (const ch of Object.keys(data.strokes || {})) {
        cache.set(ch, { strokes: data.strokes[ch], medians: data.medians?.[ch] || [], radStrokes: data.radicals?.[ch] || [] });
      }
      // 服务端明确返回缺失的字符也记下，避免反复请求
      for (const ch of data.missing || []) cache.set(ch, null);
      return data;
    })().finally(() => pending.delete(key)));
  }
  await pending.get(key);
  return resolveAll(String(text || ''));
}

function resolveAll(text) {
  const out = {};
  for (const ch of new Set(Array.from(text))) {
    const hit = cache.get(ch);
    if (hit) out[ch] = hit;
  }
  return out;
}

/** 是否已缓存某个字符的数据（用于同步预览时判断是否需要等异步）。 */
export function hasStrokeData(char) {
  return Boolean(cache.get(char));
}

export function strokeCacheSize() {
  return cache.size;
}
