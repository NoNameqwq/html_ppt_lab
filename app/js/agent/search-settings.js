import { h } from '../core/dom.js';
const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek 搜索', baseUrl: 'https://api.deepseek.com', hint: '可复用对话模型中的 DeepSeek Key，或单独填写。' },
  { id: 'tavily', label: 'Tavily', baseUrl: 'https://api.tavily.com', hint: '使用 Tavily Search API Key。' },
];
const field = (label, control, hint) => h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, label), control, hint ? h('small', { class: 'ais-subline' }, hint) : null);
export function createSearchSettingsForm(ctx, current = {}) {
  const provider = h('select', { class: 'input', 'aria-label': '搜索服务' }, ...PROVIDERS.map((p) => h('option', { value: p.id }, p.label))); provider.value = current.provider || 'deepseek';
  const base = h('input', { class: 'input', value: current.baseUrl || PROVIDERS[0].baseUrl, 'aria-label': '搜索 Base URL' });
  const key = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: current.keySet ? '已配置，留空保留' : '输入搜索 API Key', 'aria-label': '搜索 API Key' });
  const clear = h('input', { type: 'checkbox' });
  const count = h('input', { class: 'input ais-num', type: 'number', min: '1', max: '10', value: String(current.maxResults || 5), 'aria-label': '搜索结果条数' });
  const hint = h('small', { class: 'ais-subline' }, PROVIDERS.find((p) => p.id === provider.value)?.hint);
  const status = h('div', { class: 'ais-status', role: 'status' });
  const test = h('button', { type: 'button', class: 'btn btn--sm' }, '测试搜索连接');
  const getPatch = () => ({ provider: provider.value, baseUrl: base.value.trim(), apiKey: key.value.trim(), clearKey: clear.checked, maxResults: Math.min(10, Math.max(1, Math.round(Number(count.value) || 5))) });
  provider.addEventListener('change', () => { const meta = PROVIDERS.find((p) => p.id === provider.value); base.value = meta.baseUrl; hint.textContent = meta.hint; status.textContent = ''; });
  test.addEventListener('click', async () => {
    test.disabled = true; status.textContent = '正在测试当前草稿…';
    try { const result = await ctx.api.testSearchSettings(getPatch()); status.className = 'ais-status ais-status--ok'; status.textContent = `连接成功，返回 ${result.count} 条结果 · 草稿尚未保存`; }
    catch (e) { status.className = 'ais-status ais-status--error'; status.textContent = e.message; }
    finally { test.disabled = false; }
  });
  const el = h('div', { class: 'ais-service-form ais-search-form' },
    h('div', { class: 'ais-section-heading' }, h('strong', {}, '为 Agent 提供联网搜索'), h('p', {}, '配置搜索服务后，在对话中开启「联网」即可查找资料。')),
    field('搜索服务', provider), hint, field('Base URL', base), field('API Key', key),
    h('label', { class: 'ssearch-check' }, clear, '清除已保存的搜索密钥'), field('每次结果条数', count, '1–10 条，默认 5 条。'),
    h('div', { class: 'ais-actions' }, test), status);
  return { el, getPatch };
}
export async function openSearchSettings(ctx) { const { openSettings } = await import('./settings.js'); return openSettings(ctx, { section: 'search' }); }
export default { openSearchSettings };
