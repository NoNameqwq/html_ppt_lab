import { h } from '../core/dom.js';
import { isSkillForced, normalizeUserInstructions, importUserSkills, skillFromMarkdown } from '../core/user-instructions.js';

export function createUserInstructionsForm(value) {
  const draft = normalizeUserInstructions(value);
  const el = h('div', { class: 'user-instructions-form' });
  const enabled = h('input', { type: 'checkbox', 'aria-label': '启用自定义系统提示词' });
  enabled.checked = draft.enabled;
  const prompt = h('textarea', { class: 'input', rows: 7, 'aria-label': '自定义系统提示词', placeholder: '例如：优先采用简洁的学术风格，标题使用中文……' });
  prompt.value = draft.prompt;
  const list = h('div', { class: 'user-skill-list' });
  const status = h('p', { role: 'status', class: 'author-hint' });
  let reading = false;
  function render() {
    list.replaceChildren(...draft.skills.map(skill => {
      const toggle = h('input', { type: 'checkbox', 'aria-label': '启用 ' + skill.name }); toggle.checked = skill.enabled;
      toggle.addEventListener('change', () => { skill.enabled = toggle.checked; });
      const force = h('input', { type: 'checkbox' });
      force.checked = isSkillForced(draft, skill.id);
      force.addEventListener('change', () => {
        draft.skillForceOverrides = { ...draft.skillForceOverrides, [skill.id]: force.checked };
      });
      const name = h('input', { class: 'input', 'aria-label': 'Skill 名称', value: skill.name });
      const summary = h('summary', {}, skill.name);
      name.addEventListener('input', () => { skill.name = name.value; summary.textContent = name.value || '未命名 Skill'; });
      const content = h('textarea', { class: 'input', rows: 7, 'aria-label': 'Skill 正文' }); content.value = skill.content;
      content.addEventListener('input', () => { skill.content = content.value; });
      const remove = h('button', { type: 'button', class: 'btn btn--sm', onClick: () => { draft.skills = draft.skills.filter(s => s !== skill); render(); } }, '移除');
      return h('details', { class: 'user-skill-card' }, summary, h('label', {}, toggle, ' 启用此 Skill'), h('label', {}, force, ' 强制读取并注入'), name, h('small', {}, skill.source || '手动新建'), content, remove);
    }));
  }
  async function readFiles(input) {
    if (reading || !input.files?.length) return;
    reading = true; status.textContent = '正在读取 Skill…';
    try {
      const imported = await importUserSkills(input.files);
      if (!imported.length) throw new Error('没有找到 SKILL.md 或 Markdown 文件');
      const next = normalizeUserInstructions({ ...draft, prompt: prompt.value, skills: [...draft.skills, ...imported] });
      draft.skills = next.skills; render();
      status.textContent = '已导入 ' + imported.length + ' 个 Skill，保存后生效';
    } catch (e) { status.textContent = e.message; }
    finally { reading = false; input.value = ''; }
  }
  const input = h('input', { type: 'file', multiple: true, accept: '.md', class: 'hidden' });
  const folder = h('input', { type: 'file', multiple: true, webkitdirectory: '', class: 'hidden' });
  input.addEventListener('change', () => readFiles(input)); folder.addEventListener('change', () => readFiles(folder));
  el.append(h('h3', {}, '自定义系统提示词'), h('p', { class: 'author-hint' }, '仅追加用户指令，不能编辑或替换内置系统提示词。保存后用于所有会话的后续模型请求及子代理。'), h('label', {}, enabled, ' 启用自定义系统提示词'), prompt,
    h('h3', {}, '我的 Skill'), h('p', { class: 'author-hint' }, '导入 Markdown，或选择含 SKILL.md 的文件夹。文件夹中的文本参考文件会一并保存为副本；源文件修改后需重新导入，脚本不会自动执行。内置 Skill 保持只读。自定义内容合计最多 2MB。'),
    h('div', { class: 'user-skill-actions' }, h('button', { type: 'button', class: 'btn btn--sm', onClick: () => { draft.skills.push(skillFromMarkdown('# 新 Skill\n\n在这里填写指导内容。', '手动新建')); render(); } }, '新建 Skill'), h('button', { type: 'button', class: 'btn btn--sm', onClick: () => input.click() }, '导入 Markdown'), h('button', { type: 'button', class: 'btn btn--sm', onClick: () => folder.click() }, '挂载文件夹')), input, folder, status, list);
  render();
  return { el, getValue() { if (reading) throw new Error('Skill 仍在读取，请稍候保存'); return normalizeUserInstructions({ ...draft, prompt: prompt.value, enabled: enabled.checked }); } };
}

export function openUserInstructions(ctx) {
  const form = createUserInstructionsForm(ctx.store.get().settings?.agent?.userInstructions);
  return ctx.dialog.open({ title: '自定义指令与 Skill', sub: '独立保存到本地用户设置，内置内容只读', width: 'lg', body: form.el, actions: [
    { label: '取消', value: false, kind: 'ghost' },
    { label: '保存', kind: 'primary', onClick: async () => {
      try {
        const userInstructions = form.getValue();
        const data = await ctx.api.putUserSettings({ agent: { userInstructions } });
        ctx.store.update(s => { s.settings.agent = data.agent; });
        ctx.agent?.loop?.refreshContext();
        ctx.toast.ok('自定义指令与 Skill 已保存');
        return true;
      } catch (e) { ctx.toast.error(e.message); return false; }
    } },
  ] });
}
