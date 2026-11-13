/* 联网搜索设置：独立界面（Provider / API Key / Base URL / 结果数 / 测试） */
import { h } from '../core/dom.js';

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek 搜索', baseUrl: 'https://api.deepseek.com', hint: '复用 DeepSeek API Key 即可；接口 /v1/tools/search' },
  { id: 'tavily', label: 'Tavily', baseUrl: 'https://api.tavily.com', hint: 'Tavily Search API，需要 Tavily API Key' },
];

function field(label, control, hint) {
  return h('div', { class: 'ssearch-field' },
    h('div', { class: 'ssearch-label' }, label),
    control,
    hint ? h('div', { class: 'ssearch-hint' }, hint) : null);
}

export async function openSearchSettings(ctx) {
  let settings = {};
  try { settings = await ctx.api.getSettings(); } catch { settings = {}; }
  const cur = settings.search || {};
  const initialProvider = PROVIDERS.some((p) => p.id === cur.provider) ? cur.provider : 'deepseek';
  const meta = () => PROVIDERS.find((p) => p.id === providerSel.value) || PROVIDERS[0];

  const providerSel = h('select', { class: 'input ssearch-input' },
    ...PROVIDERS.map((p) => h('option', { value: p.id }, p.label)));
  providerSel.value = initialProvider;

  const keyInput = h('input', {
    class: 'input ssearch-input', type: 'password', autocomplete: 'off',
    placeholder: cur.keySet ? '已配置（' + (cur.masked || '') + '），留空保持不变' : '粘贴搜索 API Key',
  });
  const clearKey = h('input', { type: 'checkbox' });
  const baseInput = h('input', { class: 'input ssearch-input', type: 'text', value: cur.baseUrl || PROVIDERS[0].baseUrl });
  const maxInput = h('input', { class: 'input ssearch-input', type: 'number', min: '1', max: '10', value: String(cur.maxResults || 5) });
  const providerHint = h('div', { class: 'ssearch-hint' }, meta().hint);
  const status = h('div', { class: 'ssearch-status' }, '');

  providerSel.addEventListener('change', () => {
    providerHint.textContent = meta().hint;
    baseInput.value = meta().baseUrl;
    status.textContent = '';
  });

  const body = h('div', { class: 'ssearch' },
    h('div', { class: 'ssearch-intro' }, 'Agent 的「联网」开启后可使用 web_search 工具。只需配置一个搜索服务。'),
    field('搜索服务', providerSel),
    providerHint,
    field('API Key', keyInput,
      cur.keySet ? '已配置 Key；留空保持不变。勾选下方「清除 Key」可删除。' : 'DeepSeek 搜索会复用 AI 设置里的 DeepSeek Key；也可单独填写。'),
    h('label', { class: 'ssearch-check' }, clearKey, h('span', {}, '清除已保存的搜索 Key')),
    field('Base URL', baseInput),
    field('每次结果条数', maxInput, '1–10，默认 5。'),
    h('div', { class: 'ssearch-actions' },
      h('button', { type: 'button', class: 'btn btn--sm', 'data-act': 'test' }, '测试连接'),
      status));

  const testBtn = body.querySelector('[data-act="test"]');
  const saveDraft = async () => {
    const patch = {
      search: {
        provider: providerSel.value,
        baseUrl: baseInput.value.trim(),
        maxResults: Math.min(10, Math.max(1, Number(maxInput.value) || 5)),
      },
    };
    if (keyInput.value.trim()) patch.search.apiKey = keyInput.value.trim();
    if (clearKey.checked) patch.search.clearKey = true;
    await ctx.api.putSettings(patch);
    keyInput.value = '';
    clearKey.checked = false;
    return patch;
  };
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    status.textContent = '测试中…';
    try {
      await saveDraft();
      const res = await fetch('/api/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'DeepSeek', count: 3 }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && (data.error.message + (data.error.detail ? '：' + data.error.detail : ''))) || ('HTTP ' + res.status));
      status.textContent = '连接成功：返回 ' + ((data.results && data.results.length) || 0) + ' 条结果';
      status.className = 'ssearch-status is-ok';
      ctx.toast.ok('联网搜索连接成功');
    } catch (err) {
      status.textContent = '连接失败：' + (err?.message || err);
      status.className = 'ssearch-status is-error';
      ctx.toast.error('联网搜索连接失败');
    } finally {
      testBtn.disabled = false;
    }
  });

  const result = await ctx.dialog.open({
    title: '联网搜索设置',
    sub: 'Agent 联网工具（DeepSeek Search / Tavily）',
    body,
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      {
        label: '保存', kind: 'primary', onClick: async () => {
          try { await saveDraft(); ctx.toast.ok('联网搜索设置已保存'); return true; }
          catch (err) { ctx.toast.error('保存失败：' + (err?.message || err)); return false; }
        },
      },
    ],
  });
  return result === true;
}

export default { openSearchSettings };
