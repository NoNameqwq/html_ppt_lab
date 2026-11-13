import { h } from '../core/dom.js';

// Capture the target at menu-open time: changing the selection must never redirect a redo.
export async function openRedoDialog(ctx, target) {
  const projectId = target.projectId;
  const requirements = h('textarea', { class: 'input author-source', 'aria-label': '重做要求',
    placeholder: '例如：保留原文，改成左右对照；使用柔和的展开动画；突出关键公式。', rows: '5' });
  const preserve = h('input', { type: 'checkbox', checked: true });
  const error = h('div', { class: 'author-error', role: 'status' });
  let submitted = false;
  return ctx.dialog.open({
    title: target.elementId ? '重做这个元素' : '重做这一页',
    sub: `${target.projectName || '当前工程'} · 第 ${target.index + 1} 页${target.typeLabel ? ' · ' + target.typeLabel : ''}`,
    className: 'redo-dialog', width: 'lg',
    body: h('div', {}, h('p', { class: 'author-hint' }, '说明你希望怎样调整，确认后 Agent 才会开始。'),
      requirements, h('label', { class: 'ssearch-check' }, preserve, h('span', {}, '保留现有内容与含义')), error),
    actions: [{ label: '取消', kind: 'ghost', value: null }, {
      label: '发送给 Agent', kind: 'primary', onClick: async () => {
        if (submitted) return false;
        if (ctx.store.get().project?.id !== projectId) { error.textContent = '工程已切换，请在目标工程重新打开此窗口。'; return false; }
        submitted = true;
        const editor = ctx.getEditor?.();
        try {
          const state = await editor?.bridge?.call('getState', {});
          const slide = state?.slides?.[target.index];
          if (!slide || (target.slideId && slide.id !== target.slideId)) throw new Error('页面顺序已变化，请重新选择重做目标。');
          if (target.elementId) await editor.bridge.call('getElementHtml', { elementId: target.elementId });
          const scope = target.elementId ? `先读取元素（id: ${target.elementId}），仅重做这个元素` : `先读取第 ${target.index + 1} 页，重做该页版式与动效`;
          const text = `【工程「${target.projectName || '当前工程'}」第 ${target.index + 1} 页】${scope}，保持可编辑。${preserve.checked ? '保留现有内容与含义。' : ''}\n用户补充要求：${requirements.value.trim() || '沿用当前视觉语言，改善排版、层次和讲解效果。'}`;
          await ctx.bus.runCommand('agent.send', { text });
          return true;
        } catch (e) { submitted = false; error.textContent = e.message; return false; }
      },
    }],
  });
}
