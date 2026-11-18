import { h } from '../core/dom.js';
import { normalizeCompaction } from './compaction.js';

export function createCompactionForm(getProviders, value, getActive) {
  const draft = normalizeCompaction(value);
  const el = h('section', { class: 'ais-compaction' }, h('strong', {}, '上下文压缩'),
    h('p', {}, '接近上下文上限时，自动将较早对话整理为工作记忆。可单独选择压缩模型，原始消息仍完整保留。留空跟随当前正在工作的对话模型；子代理协作时跟随当前角色。'));
  const fields = h('div', { class: 'ais-role-inputs' });
  el.append(fields);
  function refresh() {
    const providers = getProviders();
    const provider = h('select', { class: 'input', 'aria-label': '上下文压缩服务' }, h('option', { value: '' }, '跟随当前对话服务'),
      ...providers.map(p => h('option', { value: p.id }, p.name)));
    if (draft.providerId && !providers.some(p => p.id === draft.providerId)) provider.append(h('option', { value: draft.providerId }, '服务已移除 · 请重新选择'));
    provider.value = draft.providerId;
    const list = h('datalist', { id: 'ais-compaction-models' });
    const model = h('input', { class: 'input', value: draft.model, list: list.id, placeholder: '留空跟随默认模型，或输入模型 ID', 'aria-label': '上下文压缩模型' });
    const populate = () => {
      const p = providers.find(p => p.id === (provider.value || getActive?.()?.providerId));
      list.replaceChildren(...(p?.models || []).map(m => h('option', { value: m.id || m.name })));
      model.placeholder = provider.value ? '留空使用此服务的默认模型' : '留空跟随当前对话模型';
    };
    provider.addEventListener('change', () => { draft.providerId = provider.value; draft.model = ''; model.value = ''; populate(); });
    model.addEventListener('input', () => { draft.model = model.value.trim(); });
    populate();
    fields.replaceChildren(h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, '压缩服务'), provider),
      h('label', { class: 'ais-field' }, h('span', { class: 'ais-label' }, '压缩模型'), model, list));
  }
  refresh();
  return { el, refresh, getValue: () => {
    if (draft.providerId && !getProviders().some(p => p.id === draft.providerId)) throw new Error('上下文压缩服务已被移除，请重新选择或设为跟随当前对话服务。');
    return normalizeCompaction(draft);
  } };
}
