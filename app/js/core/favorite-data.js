export const FAVORITE_MAX_CHARS = 24 * 1024 * 1024;
export function favoriteId(id) {
  if (!/^el-[a-z0-9-]{8,80}$/.test(id || '')) throw Object.assign(new Error('收藏 ID 无效'), { status: 400 });
  return id;
}
export function normalizeFavorite(body, previous = null) {
  const name = String(body?.name ?? previous?.name ?? '收藏元素').trim().slice(0, 100);
  const html = String(body?.html ?? previous?.html ?? '');
  const css = String(body?.css ?? previous?.css ?? '');
  if (!name) throw Object.assign(new Error('收藏名称不能为空'), { status: 400 });
  if (!/<[a-z][\s\S]*>/i.test(html) || html.length + css.length > FAVORITE_MAX_CHARS) throw Object.assign(new Error('收藏内容为空或超过 24MB 上限'), { status: 400 });
  const size = key => {
    const n = Number(body?.[key] ?? previous?.[key] ?? (key === 'w' ? 600 : 320));
    if (!Number.isFinite(n) || n < 1 || n > 16384) throw Object.assign(new Error('收藏尺寸无效'), { status: 400 });
    return n;
  };
  return { schema: 1, name, html, css, w: size('w'), h: size('h'),
    type: String(body?.type ?? previous?.type ?? 'html').slice(0, 30),
    description: String(body?.description ?? previous?.description ?? '').slice(0, 500),
    sourceProject: String(body?.sourceProject ?? previous?.sourceProject ?? '').slice(0, 100),
    createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
}
export function favoriteSummary({ html, css, ...item }) { return { ...item, chars: html.length + (css || '').length }; }

export function favoriteHasCode(html = '') {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try { if (JSON.parse(match[1])?.code?.trim()) return true; } catch { /* Non-scene JSON is inert. */ }
  }
  return false;
}
