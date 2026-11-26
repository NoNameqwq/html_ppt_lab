import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { defaultSkillIds } from './skills.js';
import { isSkillForced, normalizeUserInstructions } from '../core/user-instructions.js';
import { loadSettings } from './settings.js';

// The quick picker uses the same conversation skills and user settings as the
// full managers. It does not maintain a second selection or inject prompts.
export function createSkillPicker(ctx, getLoop, onManage) {
  let opened = false, saving = false, pendingForce = null, signature = '', rows = [];
  const count = h('span'), search = h('input', { type: 'search', placeholder: '搜索 Skill', 'aria-label': '搜索 Skill' });
  const list = h('div', { class: 'agw-skill-list' });
  const empty = h('p', { class: 'agw-skill-empty hidden' }, '没有匹配的 Skill');
  const button = h('button', { type: 'button', class: 'agw-skills', 'aria-label': '快捷调整 Skill', 'aria-expanded': 'false', 'aria-controls': 'agw-skill-picker', onClick: () => setOpen(!opened) }, h('span', { html: icon('sparkles', 15) }), count);
  const closeButton = h('button', { type: 'button', 'aria-label': '关闭 Skill 面板', onClick: () => setOpen(false) }, h('span', { html: icon('x', 15) }));
  const reset = h('button', { type: 'button', onClick: () => { if (!busy()) getLoop().setSkills(defaultSkillIds(getLoop().getState().catalog)); } }, '恢复内置默认');
  const manage = h('button', { type: 'button', onClick: () => { setOpen(false); onManage(); } }, '管理 / 导入');
  const popup = h('section', { id: 'agw-skill-picker', class: 'agw-skill-picker hidden', role: 'dialog', 'aria-label': '快捷调整 Skill' },
    h('div', { class: 'agw-skill-heading' }, h('strong', {}, 'Skill'), closeButton), search, list, empty,
    h('div', { class: 'agw-skill-footer' }, reset, manage));
  const busy = () => saving || !getLoop() || getLoop().streaming || getLoop().getState().loading;
  function setOpen(value) {
    opened = value && !busy(); popup.classList.toggle('hidden', !opened); button.setAttribute('aria-expanded', String(opened));
    if (opened) { refresh(); search.focus(); } else if (value === false) button.focus();
  }
  function filter() {
    const query = search.value.trim().toLocaleLowerCase(); let visible = 0;
    for (const row of rows) { const match = row.text.includes(query); row.el.classList.toggle('hidden', !match); if (match) visible++; }
    empty.classList.toggle('hidden', visible > 0);
  }
  async function savePreference(edit, force = null) {
    if (busy()) return;
    saving = true;
    pendingForce = force;
    refresh();
    try {
      const settings = await loadSettings(ctx);
      if (!settings.loaded) throw new Error(settings.error || '无法读取 Skill 设置，请重试');
      const data = normalizeUserInstructions(settings.agent?.userInstructions);
      edit(data);
      const result = await ctx.api.putUserSettings({ agent: { userInstructions: normalizeUserInstructions(data) } });
      if (force && isSkillForced(result.agent?.userInstructions, force.id) !== force.checked) {
        throw new Error('强制设置未保存。请关闭后端启动窗口，重新运行一键启动 BAT，再刷新页面。');
      }
      ctx.store.update(s => { s.settings.agent = result.agent; });
      getLoop().refreshContext();
    } catch (error) { ctx.toast.error(error.message); }
    finally { saving = false; pendingForce = null; refresh(); }
  }
  function refresh() {
    const state = getLoop()?.getState(), own = ctx.store.get().settings?.agent?.userInstructions;
    const entries = [...(state?.catalog || []).map(skill => ({ ...skill, scope: 'conversation', enabled: state.skills.includes(skill.id) })),
      ...(own?.skills || []).map(skill => ({ ...skill, scope: 'user', enabled: skill.enabled !== false }))];
    const selected = entries.filter(skill => skill.enabled), locked = busy();
    count.textContent = 'Skill · ' + selected.length;
    button.title = selected.length ? '已启用：' + selected.map(skill => skill.name).join('、') : '未启用 Skill，点击选择';
    button.classList.toggle('is-on', selected.length > 0); button.disabled = locked; reset.disabled = locked; manage.disabled = locked;
    if (state?.streaming || state?.loading) { opened = false; popup.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); }
    const next = JSON.stringify(entries.map(({ id, name, desc, scope }) => ({ id, name, desc, scope })));
    if (signature !== next) {
      signature = next; rows = entries.map(skill => {
        const input = h('input', { type: 'checkbox', 'aria-label': '启用 ' + skill.name, 'data-skill-id': skill.id });
        input.addEventListener('change', () => {
          if (busy()) { refresh(); return; }
          if (skill.scope === 'user') {
            const enabled = input.checked;
            void savePreference(data => {
              data.skills = data.skills.map(item => item.id === skill.id ? { ...item, enabled } : item);
            });
          } else getLoop().toggleSkill(skill.id);
        });
        const forced = h('button', {
          type: 'button', class: 'agw-skill-force', role: 'checkbox', 'aria-checked': 'false',
          'aria-label': '强制读取并注入 ' + skill.name, 'data-force-skill-id': skill.id,
          title: '强制读取并注入此 Skill',
        }, h('span', { class: 'agw-skill-force-check', 'aria-hidden': 'true', html: icon('check', 12) }), '强制');
        forced.addEventListener('click', () => {
          if (busy()) return;
          const checked = forced.getAttribute('aria-checked') !== 'true';
          void savePreference(data => {
            data.skillForceOverrides = { ...data.skillForceOverrides, [skill.id]: checked };
          }, { id: skill.id, checked });
        });
        const selection = h('label', { class: 'agw-skill-selection' }, input,
          h('span', {}, h('strong', {}, skill.name), h('small', {}, (skill.scope === 'user' ? '自定义 · 全局' : '内置 · 当前对话') + (skill.desc ? ' · ' + skill.desc : ''))));
        const el = h('div', { class: 'agw-skill-row' }, selection, forced);
        return { id: skill.id, input, forced, el, text: (skill.name + ' ' + skill.id + ' ' + (skill.desc || '')).toLocaleLowerCase() };
      });
      list.replaceChildren(...rows.map(row => row.el)); filter();
    }
    for (const row of rows) {
      row.input.checked = selected.some(skill => skill.id === row.id);
      const checked = pendingForce?.id === row.id ? pendingForce.checked : isSkillForced(own, row.id);
      row.forced.setAttribute('aria-checked', String(checked));
      row.input.disabled = locked;
      row.forced.setAttribute('aria-disabled', String(locked));
    }
  }
  search.addEventListener('input', filter);
  popup.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } });
  document.addEventListener('pointerdown', event => { if (opened && !popup.contains(event.target) && !button.contains(event.target)) { opened = false; popup.classList.add('hidden'); button.setAttribute('aria-expanded', 'false'); } });
  ctx.store.subscribe(refresh);
  return { button, popup, refresh };
}
