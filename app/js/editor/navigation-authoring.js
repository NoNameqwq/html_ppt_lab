import { h } from '../core/dom.js';
import { NAVIGATION_STYLES } from '../core/deck-navigation.js';

export function initNavigationAuthoring(ctx) {
  ctx.bus.registerCommand('insert.navigation', async () => {
    try {
      const editor = ctx.getEditor?.();
      if (!editor?.ready) throw new Error('请先打开一个演示工程');
      const state = await editor.bridge.call('getState', {});
      if (state.raw || state.capabilities?.structure === false) throw new Error('动画目录用于原生演示；导入的网页原稿可通过 Agent 保留原结构设计导航');
      if (state.slides.length < 3) throw new Error('目录至少需要两个目标页面，请先完成章节页面');
      const index = state.current, projectId = ctx.store.get().project.id, slideId = state.slides[index].id;
      const style = h('select', { class: 'input', 'aria-label': '目录设计' }, ...NAVIGATION_STYLES.map((s) => h('option', { value: s.id }, s.label)));
      const hint = h('p', { class: 'author-hint' }, NAVIGATION_STYLES[0].hint);
      style.addEventListener('change', () => { hint.textContent = NAVIGATION_STYLES.find((s) => s.id === style.value).hint; });
      const title = h('input', { class: 'input', value: '探索路径', 'aria-label': '目录标题', maxlength: '24' });
      const list = h('div', { class: 'author-fields' }), rows = [], error = h('div', { class: 'author-error', role: 'status' });
      const targets = state.slides.filter((_, i) => i !== index);
      const add = () => {
        if (rows.length >= 6) return;
        const select = h('select', { class: 'input', 'aria-label': '章节目标页面' }, ...targets.map((s) => h('option', { value: String(s.index) }, `${s.index + 1}. ${s.name}`)));
        const target = targets[rows.length % targets.length]; select.value = String(target.index);
        const name = h('input', { class: 'input', value: target.name, 'aria-label': '章节标题', maxlength: '24' });
        select.addEventListener('change', () => { name.value = state.slides[Number(select.value)].name; });
        const row = { select, name }, el = h('div', { class: 'author-row' }, name, select,
          h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => { rows.splice(rows.indexOf(row),1); el.remove(); } }, '移除'));
        rows.push(row); list.append(el);
      };
      for (let i = 0; i < Math.min(4, targets.length); i++) add();
      await ctx.dialog.open({ title: '设计章节目录', sub: `替换第 ${index + 1} 页 · 目录占一页，保持总页数`, width: 'lg',
        body: h('div', { class: 'author-fields' }, title, style, hint, list, h('button', { type: 'button', class: 'btn', onClick: add }, '添加章节'),
          h('p', { class: 'author-hint' }, '放映进入目录时章节依次展开；点击章节后选中图形放大进入目标页。页面调整顺序后链接保持有效。'), error),
        actions: [{ label: '取消', kind: 'ghost' }, { label: '应用目录到当前页', kind: 'primary', onClick: async () => {
          try {
            const latest = await editor.bridge.call('getState', {});
            if (ctx.store.get().project.id !== projectId || latest.slides[index]?.id !== slideId) throw new Error('工程或页序已变化，请重新打开目录设计');
            const { createToolExecutor } = await import('../agent/tools.js');
            const chapters = rows.map((r) => ({ title: r.name.value.trim(), slideIndex: Number(r.select.value) }));
            if (chapters.some((c) => !c.title)) throw new Error('请填写每个章节的标题');
            const result = await createToolExecutor(ctx).execute('deck_set_navigation', { index, style: style.value, title: title.value.trim(), chapters }, { permission: 'full' });
            if (!result.ok) throw new Error(result.error); return result;
          } catch (e) { error.textContent = e.message; return false; }
        } }],
      });
    } catch (e) { ctx.toast.error(e.message); }
  }, { label: '动画章节目录', group: '插入', icon: 'list' });
}
