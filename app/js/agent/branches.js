import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';

export function createBranchManager(ctx, getLoop) {
  async function fork(versionId) {
    const loop = getLoop();
    if (loop.streaming || loop.getState().loading) throw new Error('请先停止生成，再创建分支');
    const name = await ctx.dialog.prompt('创建项目分支', { placeholder: '例如：另一种视觉方案', sub: versionId ? '从此处的对话和完整项目状态建立独立分支' : '从当前对话和完整项目状态建立独立分支', okLabel: '创建并切换' });
    if (!name?.trim()) return;
    const result = await loop.forkBranch({ name: name.trim(), ...(versionId ? { versionId } : {}) });
    ctx.toast.ok('已创建分支「' + name.trim() + '」');
    return result;
  }
  async function open() {
    const loop = getLoop();
    if (!loop.projectId) throw new Error('请先打开工程');
    if (loop.streaming || loop.getState().loading) throw new Error('请先停止生成，再切换分支');
    const projectId = loop.projectId, list = h('div', { class: 'agw-branch-list' });
    const body = h('div', { class: 'agw-branches' }, h('p', {}, '每个分支独立保存对话、页面、素材、动画和编辑状态。切换前自动保存当前分支。'), list);
    let active = true;
    async function refresh() {
      const data = await ctx.api.listProjectBranches(projectId);
      const items = data.branches.length ? data.branches : [{ id: loop.getState().sessionId, name: '主分支' }];
      list.replaceChildren(...items.map(branch => {
        const current = branch.id === loop.getState().sessionId;
        const switchButton = h('button', { type: 'button', class: 'btn btn--sm', disabled: current, onClick: async () => {
          if (!active || loop.projectId !== projectId) return;
          switchButton.disabled = true;
          try { await loop.switchBranch(branch.id); await refresh(); ctx.toast.ok('已切换到「' + branch.name + '」'); }
          catch (error) { ctx.toast.error(error.message); switchButton.disabled = false; }
        } }, current ? '当前分支' : '切换');
        const rename = h('button', { type: 'button', class: 'btn btn--sm', disabled: !data.branches.length, onClick: async () => {
          const name = await ctx.dialog.prompt('重命名分支', { value: branch.name });
          if (!name?.trim() || !active || loop.projectId !== projectId) return;
          try { await loop.renameBranch(branch.id, name.trim()); await refresh(); }
          catch (error) { ctx.toast.error(error.message); }
        } }, '重命名');
        return h('div', { class: 'agw-branch-row' }, h('span', { html: icon('folder', 18) }),
          h('div', { class: 'agw-branch-info' }, h('strong', {}, branch.name), h('small', {}, branch.origin ? '从历史节点建立的分支' : '独立的对话与项目状态')), rename, switchButton);
      }));
    }
    await refresh();
    return ctx.dialog.open({ title: '项目分支', sub: ctx.store.get().project?.name, width: 'lg', body,
      onClose: () => { active = false; }, actions: [
        { label: '从当前状态新建分支', kind: 'primary', onClick: async () => { if (await fork()) await refresh(); return false; } },
        { label: '关闭', value: true, kind: 'ghost' },
      ] });
  }
  return { open, fork };
}
