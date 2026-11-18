import { h } from '../core/dom.js';

const field = (label, control, hint) => h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, label), control, hint ? h('small', { class: 'ais-subline' }, hint) : null);

export function createImageSettingsForm(ctx, current = {}) {
  const enabled = h('input', { type: 'checkbox', 'aria-label': '允许 Agent 使用生图服务' }); enabled.checked = current.enabled === true;
  const base = h('input', { class: 'input', value: current.baseUrl || '', placeholder: 'https://api.openai.com/v1', 'aria-label': '生图服务地址' });
  const key = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: current.keySet ? '已配置，留空保留' : '输入生图服务 API Key', 'aria-label': '生图 API Key' });
  const clear = h('input', { type: 'checkbox', 'aria-label': '清除已保存的生图密钥' });
  const model = h('input', { class: 'input', value: current.model && current.model !== 'auto' ? current.model : '', placeholder: '自动选择 GPT 图像模型', 'aria-label': '生图模型', list: 'ais-image-models' });
  const list = h('datalist', { id: 'ais-image-models' });
  const status = h('div', { class: 'ais-status', role: 'status', 'aria-live': 'polite' });
  const picked = h('div', { class: 'ais-subline' });
  const fetchButton = h('button', { type: 'button', class: 'btn btn--sm' }, '重新获取模型');
  let models = current.models || [], timer, controller, sequence = 0, disposed = false;
  const showModels = () => {
    list.replaceChildren(...models.map((m) => h('option', { value: m.id })));
    picked.textContent = model.value.trim() ? `指定模型：${model.value.trim()}${models.length ? ` · 已发现 ${models.length} 个生图模型` : ''}` : models.length ? `已发现 ${models.length} 个生图模型 · 自动优先 ${models[0].id}` : `默认 GPT 图像协议 · 未能获取列表时使用 ${current.defaultModel || 'gpt-image-1.5'}，也可指定模型`;
  };
  const getPatch = () => ({ enabled: enabled.checked, baseUrl: base.value.trim(), apiKey: key.value.trim(), clearKey: clear.checked,
    model: model.value.trim() || 'auto', models, size: 'auto', quality: 'auto', responseFormat: 'auto' });
  async function discover() {
    clearTimeout(timer); controller?.abort(); const ticket = ++sequence;
    if (!base.value.trim() || (!key.value.trim() && (!current.keySet || clear.checked))) { status.textContent = '填写 API Key 和 Base URL 后自动获取模型'; return; }
    controller = new AbortController(); fetchButton.disabled = true; status.textContent = '正在获取生图模型…';
    status.className = 'ais-status ais-status--loading';
    try {
      const data = await ctx.api.fetchImageModels({ baseUrl: base.value.trim(), apiKey: key.value.trim(), clearKey: clear.checked }, controller.signal);
      if (ticket !== sequence || disposed) return;
      models = data.models; showModels(); status.className = 'ais-status ais-status--ok'; status.textContent = '已从服务获取模型，保存后生效';
    } catch (e) {
      if (ticket !== sequence || disposed || e.name === 'AbortError') return;
      status.className = 'ais-status ais-status--warn'; status.textContent = e.message;
    } finally { if (ticket === sequence && !disposed) fetchButton.disabled = false; }
  }
  const changed = () => {
    ++sequence; controller?.abort(); clearTimeout(timer); models = []; showModels(); fetchButton.disabled = false;
    status.textContent = '填写完成后自动获取模型'; timer = setTimeout(discover, 800);
  };
  base.addEventListener('input', changed); key.addEventListener('input', changed); clear.addEventListener('change', changed);
  fetchButton.addEventListener('click', discover);
  model.addEventListener('input', showModels);
  const el = h('div', { class: 'ais-service-form ais-image-form' },
    h('div', { class: 'ais-section-heading' }, h('strong', {}, '让 Agent 为演示生成配图'), h('p', {}, '提供 API Key 和 Base URL，其余生成参数由 Agent 按内容与构图选择。')),
    h('label', { class: 'image-settings-switch' }, enabled, h('span', {}, h('strong', {}, '允许 Agent 使用生图服务'), h('small', {}, '默认关闭，手动开启并保存后生效。生成可能产生服务商费用。'))),
    field('Base URL', base, '兼容 OpenAI Images API，也支持完整 /images/generations 地址。'),
    field('API Key', key, '密钥仅保存在本地服务端，不发送给对话模型。'),
    h('label', { class: 'ssearch-check' }, clear, '清除已保存的生图密钥'),
    h('div', { class: 'ais-actions' }, fetchButton), picked, status,
    h('details', { class: 'ais-adv' }, h('summary', {}, '高级 · 指定模型'), h('div', { class: 'ais-adv-body' }, field('模型 ID（留空自动）', model, '可选择已发现模型；非标准服务可手动指定。尺寸、质量、背景及格式由 Agent 决定。'), list)),
    h('p', { class: 'ais-subline' }, '模型获取只查询列表，不生成图片。生成的图片会保存为工程素材并自动放入页面。'));
  showModels();
  return { el, getPatch, activate: () => { if (!models.length) discover(); }, dispose: () => { disposed = true; ++sequence; clearTimeout(timer); controller?.abort(); } };
}

export async function openImageSettings(ctx) { const { openSettings } = await import('./settings.js'); return openSettings(ctx, { section: 'image' }); }
