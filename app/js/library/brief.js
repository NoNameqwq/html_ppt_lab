/* ==========================================================================
   一句话开演：只填主题 → 选方向 / 场景 / 页数 → 建工程并让 Agent 直接生成整套
   - 提示词由 agent/blueprints.js 生成（与系统提示词、deck_compose 共用同一套蓝图）
   ========================================================================== */

import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { ART_DIRECTIONS, SCENES, buildCreationBrief, getDirection } from '../agent/blueprints.js';

let ctx = null;

export async function init(_ctx) {
  ctx = _ctx;
  ctx.bus.registerCommand('file.brief', () => openBriefDialog(), {
    label: '一句话开演',
    group: '文件',
    icon: 'sparkles',
  });
}

const SAMPLE = '为一个做低温酸奶的新品牌做发布演示，主打「0 蔗糖」和 72 小时冷链';

function chip(label, active, onClick, tip) {
  const b = h('button', {
    type: 'button',
    class: 'brief-chip' + (active ? ' is-active' : ''),
    'data-tip': tip || label,
  }, label);
  b.addEventListener('click', onClick);
  return b;
}

function waitForProject(projectId, timeout = 24000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const snap = ctx.store.get();
      const id = snap.project && snap.project.id;
      if (id === projectId && snap.deck && snap.deck.ready) { resolve(true); return; }
      if (Date.now() - started > timeout) { resolve(false); return; }
      setTimeout(tick, 200);
    };
    tick();
  });
}

export async function openBriefDialog() {
  if (!ctx) return { ok: false, error: '模块未初始化' };
  const state = {
    topic: '',
    sceneId: 'auto',
    directionId: 'auto',
    pages: 8,
    autoStart: true,
    creating: false,
  };

  const preview = h('div', { class: 'brief-preview' }, '选一个场景，或者直接写主题');
  const topic = h('textarea', {
    class: 'brief-topic',
    rows: '3',
    maxlength: '400',
    placeholder: '例如：' + SAMPLE,
  });
  topic.addEventListener('input', () => { state.topic = topic.value; paintPreview(); });
  const sampleBtn = h('button', { type: 'button', class: 'brief-sample' }, '用示例');
  sampleBtn.addEventListener('click', () => {
    topic.value = SAMPLE;
    state.topic = SAMPLE;
    paintPreview();
    topic.focus();
  });

  const sceneRow = h('div', { class: 'brief-chips' });
  const dirRow = h('div', { class: 'brief-chips' });
  const pageRow = h('div', { class: 'brief-chips brief-chips--tight' });

  const renderScenes = () => {
    sceneRow.replaceChildren();
    sceneRow.append(chip('自动', state.sceneId === 'auto', () => {
      state.sceneId = 'auto';
      renderScenes();
      paintPreview();
    }, '按主题自动判断叙事结构'));
    for (const s of SCENES) {
      sceneRow.append(chip(s.name, state.sceneId === s.id, () => {
        state.sceneId = s.id;
        if (state.directionId === 'auto') state.directionId = s.direction;
        state.pages = s.pages;
        renderScenes();
        renderDirections();
        renderPages();
        paintPreview();
      }, s.name + ' · 默认 ' + s.pages + ' 页'));
    }
  };

  const renderDirections = () => {
    dirRow.replaceChildren();
    dirRow.append(chip('自动匹配', state.directionId === 'auto', () => {
      state.directionId = 'auto';
      renderDirections();
      paintPreview();
    }, '按主题关键词自动选一个视觉方向'));
    for (const d of ART_DIRECTIONS) {
      dirRow.append(chip(d.name, state.directionId === d.id, () => {
        state.directionId = d.id;
        renderDirections();
        paintPreview();
      }, d.tagline));
    }
  };

  const renderPages = () => {
    pageRow.replaceChildren();
    for (const n of [6, 8, 10, 12]) {
      pageRow.append(chip(n + ' 页', state.pages === n, () => {
        state.pages = n;
        renderPages();
        paintPreview();
      }));
    }
  };

  function currentDirection() {
    if (state.directionId !== 'auto') return getDirection(state.directionId);
    const brief = buildCreationBrief({ topic: state.topic || '主题', sceneId: state.sceneId, pages: state.pages });
    return brief.direction;
  }

  function paintPreview() {
    const dir = currentDirection();
    const scene = SCENES.find((s) => s.id === state.sceneId);
    const bits = [];
    bits.push(state.topic.trim() ? '《' + state.topic.trim().slice(0, 22) + '》' : '一句话主题');
    bits.push(dir ? dir.name : '视觉方向');
    bits.push(state.pages + ' 页');
    if (scene) bits.push(scene.name);
    preview.textContent = '将生成：' + bits.join(' · ');
  }

  const auto = h('input', { type: 'checkbox' });
  auto.checked = true;
  auto.addEventListener('change', () => { state.autoStart = auto.checked; });

  const body = h('div', { class: 'brief-dialog' },
    h('div', { class: 'brief-hero' },
      h('div', { class: 'brief-kicker', html: icon('sparkles', 13) }, h('span', null, 'ONE LINE STUDIO')),
      h('h2', { class: 'brief-title' }, '说一句，直接出片'),
      h('p', { class: 'brief-sub' }, '写下主题或内容，其余交给内置创作提示词：视觉方向、分页脚本、动效节奏、转场叠加都按成品标准执行。')),
    h('div', { class: 'brief-field' },
      h('div', { class: 'brief-label' }, h('span', null, '主题 / 内容'), sampleBtn),
      topic),
    h('div', { class: 'brief-field' },
      h('div', { class: 'brief-label' }, h('span', null, '场景')),
      sceneRow),
    h('div', { class: 'brief-field' },
      h('div', { class: 'brief-label' }, h('span', null, '视觉方向')),
      dirRow),
    h('div', { class: 'brief-row' },
      h('div', { class: 'brief-field brief-field--pages' },
        h('div', { class: 'brief-label' }, h('span', null, '页数')),
        pageRow),
      h('label', { class: 'brief-auto' }, auto, h('span', null, '创建后立刻开始生成'))),
    h('div', { class: 'brief-foot' }, preview));

  renderScenes();
  renderDirections();
  renderPages();
  paintPreview();
  setTimeout(() => topic.focus(), 60);

  const res = await ctx.dialog.open({
    title: '一句话开演',
    sub: '只给主题 · 自动排版 · 自动加动效',
    width: 'lg',
    body,
    className: 'dialog--brief',
    actions: [
      { label: '取消', value: null, kind: 'ghost' },
      {
        label: '创建并生成',
        kind: 'primary',
        onClick: async (modal) => {
          if (state.creating) return false;
          const text = (topic.value || '').trim();
          if (text.length < 2) {
            ctx.toast.warn('先写一句主题，比如「给一款咖啡做品牌提案」');
            topic.focus();
            return false;
          }
          state.creating = true;
          const btns = [...(modal?.querySelectorAll('.modal-foot .btn') || [])];
          for (const b of btns) b.disabled = true;
          try {
            const name = text.length > 34 ? text.slice(0, 34) + '…' : text;
            const created = await ctx.api.createProject({ name, templateId: 'blank' });
            const project = created && created.project;
            if (!project || !project.id) throw new Error('服务端未返回工程信息');
            const brief = buildCreationBrief({
              topic: text,
              sceneId: state.sceneId === 'auto' ? '' : state.sceneId,
              directionId: state.directionId === 'auto' ? '' : state.directionId,
              pages: state.pages,
            });
            ctx.toast.ok('已创建「' + (project.name || name) + '」');
            ctx.bus.emit('library:refresh', { projectId: project.id });
            const hash = '#/p/' + encodeURIComponent(project.id);
            if (typeof ctx.navigate === 'function') ctx.navigate(hash);
            else location.hash = hash;
            if (state.autoStart) {
              const ready = await waitForProject(project.id);
              if (!ready) ctx.toast.warn('画布还在加载，Agent 可能需要你再说一次');
              setTimeout(() => {
                ctx.bus.runCommand('agent.send', { text: brief.display, brief: brief.brief });
              }, 500);
            } else {
              setTimeout(() => ctx.bus.runCommand('app.toggleAgent'), 700);
            }
            return { project };
          } catch (err) {
            console.error('[brief] 创建失败', err);
            ctx.toast.error('创建失败：' + (err?.message || err));
            for (const b of btns) b.disabled = false;
            state.creating = false;
            return false;
          }
        },
      },
    ],
  });
  return res && res.project ? { ok: true, project: res.project } : { ok: false, canceled: true };
}
