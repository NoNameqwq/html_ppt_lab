import { h } from '../core/dom.js';

const field = (label, control, hint) => h('label', { class: 'image-settings-field' }, h('span', {}, label), control, hint ? h('small', { class: 'author-hint' }, hint) : null);
export async function openImageSettings(ctx) {
  const current = (await ctx.api.getSettings()).imageGeneration || {};
  const enabled = h('input', { type: 'checkbox', 'aria-label': '允许 Agent 使用生图服务' }); enabled.checked = current.enabled === true;
  const base = h('input', { class: 'input', value: current.baseUrl || '', placeholder: 'https://api.example.com/v1', 'aria-label': '生图服务地址' });
  const model = h('input', { class: 'input', value: current.model || '', placeholder: '填写服务商提供的图像模型 ID', 'aria-label': '生图模型' });
  const key = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: current.keySet ? '已配置，留空保留' : '输入生图服务 API Key', 'aria-label': '生图 API Key' });
  const clear = h('input', { type: 'checkbox' });
  const size = h('select', { class: 'input', 'aria-label': '图片尺寸' }, ...['auto','1024x1024','1536x1024','1024x1536','1792x1024','1024x1792','512x512','256x256'].map((s) => h('option', { value: s }, s === 'auto' ? '自动（模型默认）' : s))); size.value = current.size || 'auto';
  const quality = h('select', { class: 'input', 'aria-label': '图片质量' }, ...[['auto','自动'],['low','低'],['medium','中'],['high','高'],['standard','Standard（兼容服务）'],['hd','HD（兼容服务）']].map(([value,label]) => h('option', { value }, label))); quality.value = current.quality || 'auto';
  const format = h('select', { class: 'input', 'aria-label': '返回格式' }, ...[['auto','自动（推荐）'],['b64_json','Base64（兼容服务）'],['url','图片 URL（兼容服务）']].map(([value,label]) => h('option', { value }, label))); format.value = current.responseFormat || 'auto';
  const status = h('div', { class: 'author-error', role: 'status' });
  return ctx.dialog.open({ title: '生图设置', sub: '独立的图像模型 · 生成后自动保存并放入页面', width: 'lg', className: 'image-settings-dialog',
    body: h('div', { class: 'author-fields' },
      h('label', { class: 'image-settings-switch' }, enabled, h('span', {}, h('strong', {}, '允许 Agent 使用生图服务'), h('small', {}, '默认关闭。手动开启并保存后，Agent 可根据演示内容生成配图，可能产生服务商费用。'))),
      field('服务地址', base, '兼容 OpenAI Images API；支持 Base URL 或完整 /images/generations 地址。'),
      field('模型 ID', model), field('API Key', key, '密钥仅保存在本地服务端，不发送给对话模型。'),
      h('label', { class: 'ssearch-check' }, clear, '清除已保存的生图密钥'),
      h('div', { class: 'image-settings-grid' }, field('尺寸', size), field('质量', quality), field('返回格式', format)),
      h('p', { class: 'author-hint' }, '可在对话中说“为这一页生成配图并放在右侧”。公式、标题和数据仍由可编辑的 LaTeX / SVG / 文本表达。'), status),
    actions: [{ label: '取消', value: null, kind: 'ghost' }, { label: '保存设置', kind: 'primary', onClick: async () => {
      try {
        const response = await fetch('/api/image-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled.checked, baseUrl: base.value.trim(), model: model.value.trim(), apiKey: key.value.trim(), clearKey: clear.checked, size: size.value, quality: quality.value, responseFormat: format.value }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || '保存失败');
        ctx.store.update((s) => { s.settings.imageGeneration = data.imageGeneration; });
        ctx.toast.ok(data.imageGeneration.enabled ? '生图已开启，可在对话中生成配图' : '生图已关闭'); return true;
      } catch (e) { status.textContent = e.message; return false; }
    } }],
  });
}
