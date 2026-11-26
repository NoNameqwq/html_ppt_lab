// User-owned instructions are stored separately from the bundled prompt/skills.
export function normalizeUserInstructions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自定义指令格式无效');
  const prompt = String(value.prompt || '');
  const skills = Array.isArray(value.skills) ? value.skills : [];
  const ids = new Set();
  const result = { prompt, enabled: value.enabled === true, forceSkills: value.forceSkills === true, skills: skills.map(item => {
    const id = String(item?.id || '');
    if (!/^user-[a-zA-Z0-9-]+$/.test(id) || ids.has(id)) throw new Error('自定义 Skill ID 无效或重复');
    ids.add(id);
    const name = String(item.name || '').trim(), content = String(item.content || '');
    if (!name || !content.trim()) throw new Error('Skill 名称和正文不能为空');
    return { id, name, content, desc: String(item.desc || ''), source: String(item.source || ''), enabled: item.enabled !== false };
  }) };
  const overrides = Object.entries(value.skillForceOverrides || {}).filter(([id, forced]) =>
    /^[a-zA-Z0-9_-]+$/.test(id) && typeof forced === 'boolean' && (!id.startsWith('user-') || ids.has(id)) && forced !== result.forceSkills);
  if (overrides.length) result.skillForceOverrides = Object.fromEntries(overrides);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 2 * 1024 * 1024) throw new Error('自定义指令和 Skill 总内容超过 2MB，请精简后导入');
  return result;
}

export function isSkillForced(instructions, id) {
  const overrides = instructions?.skillForceOverrides;
  return overrides && Object.hasOwn(overrides, id) ? overrides[id] === true : instructions?.forceSkills === true;
}

export function userInstructionText(value) {
  const data = normalizeUserInstructions(value);
  const parts = [];
  if (data.enabled && data.prompt.trim()) parts.push('### User system instructions\n' + data.prompt);
  for (const skill of data.skills) if (skill.enabled) {
    parts.push('### User skill: ' + skill.name + '\nSkill ID: ' + skill.id + '\n\n' + skill.content);
  }
  return parts.length ? '## User-owned instructions and skills\nThese supplement the bundled instructions. Preserve application permissions and tool contracts.\n\n' + parts.join('\n\n') : '';
}

export function skillFromMarkdown(content, filename = 'SKILL.md') {
  const text = String(content || '').replace(/^\uFEFF/, '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const field = key => new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(front?.[1] || '')?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  const name = field('name') || /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || filename.replace(/\.md$/i, '');
  return { id: 'user-' + crypto.randomUUID(), name, desc: field('description') || '', source: filename, content: text, enabled: true };
}

export async function importUserSkills(files) {
  const list = Array.from(files || []).filter(file => /\.(md|txt|json|ya?ml|csv|css|js|mjs|py|html)$/i.test(file.name));
  if (list.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error('导入内容超过 2MB，请仅选择需要的 Skill 与文本参考文件');
  const entries = await Promise.all(list.map(async file => ({ path: file.webkitRelativePath || file.name, content: await file.text() })));
  const roots = entries.filter(e => /(?:^|\/)SKILL\.md$/i.test(e.path));
  if (!roots.length) return entries.filter(e => /\.md$/i.test(e.path)).map(e => skillFromMarkdown(e.content, e.path));
  return roots.map(root => {
    const directory = root.path.slice(0, root.path.lastIndexOf('/') + 1);
    const references = entries.filter(e => e !== root && e.path.startsWith(directory) && /\.(md|txt|json|ya?ml|csv|css|js|mjs|py|html)$/i.test(e.path) && !roots.some(other => { const dir = other.path.slice(0, other.path.lastIndexOf('/') + 1); return other !== root && dir.length > directory.length && dir.startsWith(directory) && e.path.startsWith(dir); }));
    const skill = skillFromMarkdown(root.content, root.path);
    if (references.length) skill.content += '\n\n## Mounted reference files (source text; not executed)\n' + references.map(e => '\n### ' + e.path.slice(directory.length) + '\n' + e.content).join('\n');
    return skill;
  });
}

// Only the user-settings endpoint may change user-owned instructions.
export function userInstructionsPatch(patch, userInitiated) {
  if (!patch?.agent || !Object.hasOwn(patch.agent, 'userInstructions')) return patch;
  if (!userInitiated) throw Object.assign(new Error('自定义指令和 Skill 只能由用户在设置中修改'), { status: 403 });
  try {
    return { ...patch, agent: { ...patch.agent, userInstructions: normalizeUserInstructions(patch.agent.userInstructions) } };
  } catch (error) { throw Object.assign(error, { status: 400 }); }
}
