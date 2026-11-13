import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';

const time = (value) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const size = (bytes) => bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
const kinds = { before: '修改前', after: '修改后', backup: '回退备份', manual: '手动版本', legacy: '旧版备份' };

export function createVersionHistory(ctx, { getLoop, onRestored }) {
  const fail = (e) => ctx.toast.error(e.message || String(e));
  function available() {
    const loop = getLoop();
    if (!loop.projectId) throw new Error('请先打开一个工程，再查看版本历史');
    if (loop.streaming || loop.getState().loading) throw new Error('请等待当前任务完成或停止生成，再操作版本');
    return loop;
  }
  async function detail(id, { rewind = false } = {}) {
    const loop = available(), projectId = loop.projectId, editor = ctx.getEditor?.();
    const inspect = () => ctx.api.inspectVersion(projectId, id);
    const data = editor?.projectId === projectId && editor.withVersionCheckpoint ? await editor.withVersionCheckpoint(inspect) : await inspect();
    const v = data.version, checkbox = h('input', { type: 'checkbox' });
    checkbox.checked = rewind && v.hasConversation;
    const list = h('div', { class: 'agw-version-changes' });
    for (const file of data.changes) list.append(h('div', { class: 'agw-version-change', 'data-action': file.action },
      h('span', {}, { restore: '+', replace: '~', remove: '−' }[file.action]), h('code', {}, file.path),
      h('small', {}, { restore: '恢复文件', replace: '替换内容', remove: '移除新增文件' }[file.action])));
    if (!data.changes.length) list.append(h('p', { class: 'agw-version-empty' }, '工程文件与此版本一致。'));
    const body = h('div', { class: 'agw-version-detail' }, h('h3', {}, v.label),
      h('p', { class: 'agw-version-meta' }, `${time(v.createdAt)} · ${kinds[v.kind]} · ${v.fileCount} 个文件 · ${size(v.bytes)}`),
      h('p', {}, v.kind === 'legacy' ? '旧备份只包含 index.html。素材、补丁和对话无法从旧备份恢复。' : '恢复源代码、页面、素材、原稿补丁及编辑历史；此版本之后新增的工程文件将被移除。'),
      h('div', { class: 'agw-version-change-title' }, `相对当前工程 · ${data.changes.length} 个文件变化`), list,
      v.hasConversation ? h('label', { class: 'agw-version-rewind' }, checkbox, h('span', {}, '同步回退对话', h('small', {}, '后续消息自动保存为历史分支，可在「对话历史」重新打开。'))) : null,
      h('p', { class: 'agw-version-hint' }, '回退前会自动保存当前工程为一个新版本，可随时恢复。'));
    let restoring = false;
    return ctx.dialog.open({ title: '恢复工程版本', sub: '确认恢复范围后回退', body, width: 'lg', className: 'agw-version-modal', closeOnBackdrop: false,
      actions: [{ label: '取消', kind: 'ghost', value: null }, { label: '恢复此版本', kind: 'primary', onClick: async (modal, finish) => {
        if (restoring) return false;
        restoring = true;
        const button = modal.querySelector('.modal-foot .btn--primary'); button.disabled = true; button.textContent = '正在恢复…';
        try {
          if (getLoop().projectId !== projectId) throw new Error('当前工程已切换，请重新打开版本历史');
          const result = await loop.restoreCheckpoint(id, { rewindConversation: checkbox.checked });
          onRestored?.(result); ctx.toast.ok(result.conversation ? '工程与对话已回退，后续消息已保留为历史分支' : '工程已恢复，回退前版本已自动备份');
          if (result.editorError) ctx.toast.warn(result.editorError);
          finish(result);
        } catch (e) { fail(e); restoring = false; button.disabled = false; button.textContent = '恢复此版本'; }
        return false;
      } }] });
  }
  async function open({ ids = null } = {}) {
    const loop = available(), projectId = loop.projectId;
    const list = h('div', { class: 'agw-version-list' }), message = h('p', { class: 'agw-version-hint' }, '每轮 Agent 修改前后自动保存完整工程。旧对话只能使用当时已有的 HTML 备份。');
    const name = h('input', { class: 'input', 'aria-label': '版本名称', placeholder: '为当前工程保存一个命名版本', maxlength: '200' });
    const save = h('button', { type: 'button', class: 'btn btn--primary' }, '保存版本');
    const body = h('div', { class: 'agw-versions' }, h('div', { class: 'agw-version-create' }, name, save), message, list);
    let refreshToken = 0;
    async function refresh() {
      const token = ++refreshToken;
      const data = await ctx.api.listVersions(projectId);
      if (token !== refreshToken) return;
      const versions = ids ? data.versions.filter((v) => ids.includes(v.id)) : data.versions;
      list.replaceChildren();
      for (const v of versions) {
        const button = h('button', { type: 'button', class: 'agw-version-row', disabled: v.corrupt, onClick: () => detail(v.id).catch(fail), 'data-version-id': v.id },
          h('span', { class: 'agw-version-symbol', html: icon(v.kind === 'backup' ? 'undo' : 'history', 17) }),
          h('span', { class: 'agw-version-info' }, h('strong', {}, v.label), h('small', {}, `${time(v.createdAt)} · ${v.fileCount || 0} 个文件${v.hasConversation ? ' · 含对话快照' : ''}`)),
          h('span', { class: 'agw-version-kind' }, kinds[v.kind] || '无法恢复'));
        list.append(button);
      }
      if (!versions.length) list.append(h('p', { class: 'agw-version-empty' }, '还没有保存的版本。保存当前版本，或让 Agent 完成一次修改后即可回退。'));
    }
    save.addEventListener('click', async () => {
      if (save.disabled) return; save.disabled = true;
      try {
        if (loop.projectId !== projectId) throw new Error('当前工程已切换');
        await loop.createCheckpoint(name.value.trim() || '手动保存 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false }));
        name.value = ''; ids = null; await refresh(); ctx.toast.ok('版本已保存');
      } catch (e) { fail(e); } finally { save.disabled = false; }
    });
    await refresh();
    await ctx.dialog.open({ title: ids ? '本轮工程版本' : '版本历史', sub: ctx.store.get().project?.name || '', body, width: 'lg', className: 'agw-version-modal',
      actions: [...(ids ? [{ label: '查看全部版本', kind: 'ghost', onClick: async (_, finish) => { finish(); await open(); return false; } }] : []), { label: '关闭', value: true, kind: 'ghost' }] });
  }
  return { open, detail };
}
