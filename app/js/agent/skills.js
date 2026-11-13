/* Agent 技能系统：GET /api/skills 目录、启用状态、composer pills、管理弹窗 */

import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';

/* 服务端不可用时的兜底目录（正文为空，只保证 UI 可用） */
export const FALLBACK_SKILLS = [
  { id: 'motion-design', name: '动效设计', desc: '缓动、时长、节奏与多元素编排原则', category: 'design', default: true },
  { id: 'layout-typography', name: '版式与字体层级', desc: '网格、字号层级、留白与对齐规范', category: 'design', default: true },
  { id: 'color-system', name: '配色与主题', desc: '主题变量、60-30-10、对比度与派色技巧', category: 'design', default: false },
  { id: 'deck-narrative', name: '演示叙事', desc: '叙事骨架、每页一个论点、节奏与视觉连续', category: 'content', default: false },
  { id: 'html-deck-craft', name: 'Deck 代码规范', desc: '本 deck 格式的 HTML/CSS/JS 编辑规范与禁忌', category: 'code', default: true },
  { id: 'image-treatment', name: '图片处理', desc: '裁切、蒙版、构图与图片排版技巧', category: 'design', default: false },
];

const CATEGORY_LABEL = { design: '设计', content: '内容', code: '代码', other: '其它' };

export function categoryLabel(id) {
  return CATEGORY_LABEL[id] || CATEGORY_LABEL.other;
}

let catalogCache = null;
let inflight = null;

function normalizeSkill(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || id),
    desc: String(raw.desc || ''),
    category: String(raw.category || 'design'),
    default: !!raw.default,
    source: typeof raw.source === 'string' ? raw.source : '',
    license: typeof raw.license === 'string' ? raw.license : '',
    content: typeof raw.content === 'string' ? raw.content : '',
  };
}

/** 读取技能目录（缓存 + 兜底） */
export async function loadCatalog(ctx, opts = {}) {
  if (catalogCache && !opts.force) return catalogCache;
  if (inflight && !opts.force) return inflight;
  inflight = (async () => {
    let list = null;
    try {
      const data = await ctx.api.skills();
      const raw = Array.isArray(data && data.skills) ? data.skills : [];
      if (raw.length) list = raw.map(normalizeSkill).filter(Boolean);
    } catch (err) {
      console.warn('[agent/skills] 获取技能目录失败，使用内置兜底目录', err);
    }
    if (!list || !list.length) {
      list = FALLBACK_SKILLS.map((s) => normalizeSkill(s));
    }
    catalogCache = list;
    try {
      ctx.store.update((s) => { s.settings.skillsCatalog = list; });
    } catch { /* ignore */ }
    return catalogCache;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 同步取缓存（不可用时返回兜底目录） */
export function getCachedCatalog() {
  return catalogCache || FALLBACK_SKILLS.map((s) => normalizeSkill(s));
}

/** 默认启用的技能 id */
export function defaultSkillIds(catalog) {
  const list = Array.isArray(catalog) && catalog.length ? catalog : getCachedCatalog();
  return list.filter((s) => s.default).map((s) => s.id);
}

/** 过滤出合法且存在的技能 id */
export function normalizeEnabledIds(catalog, ids) {
  const list = Array.isArray(catalog) && catalog.length ? catalog : getCachedCatalog();
  const valid = new Set(list.map((s) => s.id));
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const s = String(id || '').trim();
    if (s && valid.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 生成追加到 system prompt 的技能正文 */
export function getEnabledContent(catalog, ids) {
  const list = Array.isArray(catalog) && catalog.length ? catalog : getCachedCatalog();
  const enabled = new Set(Array.isArray(ids) ? ids : []);
  const parts = [];
  for (const s of list) {
    if (!enabled.has(s.id)) continue;
    const content = String(s.content || '').trim();
    if (!content) continue;
    parts.push('### ' + s.name + '（' + s.id + '）\n' + content);
  }
  return parts.join('\n\n');
}

/** 兼容旧命名 */
export const buildSkillsText = getEnabledContent;

/* ---------- 技能管理弹窗 ---------- */

/**
 * 打开技能管理弹窗。
 * @param {object} ctx
 * @param {{catalog:Array, enabled:string[], onChange:(ids:string[])=>void}} opts
 */
export function openManager(ctx, opts = {}) {
  const catalog = Array.isArray(opts.catalog) && opts.catalog.length ? opts.catalog : getCachedCatalog();
  let enabled = Array.isArray(opts.enabled) ? [...opts.enabled] : [];

  const body = h('div', { class: 'ask' });
  body.append(h('div', { class: 'ask-intro' },
    h('span', { html: icon('sparkles', 14) }),
    h('span', { class: 'grow' }, '启用后，技能正文会追加到 Agent 的系统提示词，随本工程会话保存。')
  ));

  const groups = new Map();
  for (const s of catalog) {
    const key = s.category || 'design';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const notify = () => {
    try { opts.onChange && opts.onChange([...enabled]); } catch (err) { console.warn('[agent/skills] 保存技能开关失败', err); }
  };

  for (const [cat, list] of groups) {
    const section = h('div', { class: 'ask-group' });
    section.append(h('div', { class: 'ask-group-title' }, categoryLabel(cat)));
    for (const s of list) {
      const input = h('input', { type: 'checkbox' });
      input.dataset.skill = s.id;
      input.checked = enabled.includes(s.id);
      input.addEventListener('change', () => {
        if (input.checked) {
          if (!enabled.includes(s.id)) enabled = [...enabled, s.id];
        } else {
          enabled = enabled.filter((id) => id !== s.id);
        }
        notify();
      });
      const row = h('label', { class: 'ask-row' },
        h('div', { class: 'ask-row-main' },
          h('div', { class: 'ask-row-head' },
            h('span', { class: 'ask-row-name' }, s.name),
            h('span', { class: 'badge badge--muted' }, s.id)
          ),
          h('div', { class: 'ask-row-desc' }, s.desc || ''),
          /^https:\/\/github\.com\//.test(s.source || '') ? h('a', { href: s.source, target: '_blank', rel: 'noopener', class: 'author-hint', onClick: (e) => e.stopPropagation() }, '开源来源 · ' + s.license) : null
        ),
        h('span', { class: 'switch' }, input, h('i'))
      );
      section.append(row);
    }
    body.append(section);
  }

  return ctx.dialog.open({
    title: '技能管理',
    sub: '内置前端技能 · 开关随工程会话持久化',
    width: 'lg',
    body,
    actions: [
      {
        label: '恢复默认',
        kind: 'ghost',
        onClick: () => {
          enabled = defaultSkillIds(catalog);
          for (const input of body.querySelectorAll('.ask-row input[data-skill]')) {
            input.checked = enabled.includes(input.dataset.skill);
          }
          notify();
          return false;
        },
      },
      { label: '完成', value: true, kind: 'primary' },
    ],
  });
}
