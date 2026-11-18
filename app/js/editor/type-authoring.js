/**
 * 艺术字工坊（编辑器入口）。
 *
 * 左侧选预设、中间按 1920×1080 真实比例预览、右侧调参数；
 * 生成结果交给 deck_insert_type 工具落到页面，成为可再次编辑的独立元素。
 */
import { h } from '../core/dom.js';
import { TYPE_FONTS, TYPE_GROUPS, TYPE_PRESETS, buildTypeKit, normalizeTypeSpec, typePreset } from '../core/type-kit.js';
import { fetchStrokes } from '../core/stroke-data.js';

const STAGE_W = 1920;
const STAGE_H = 1080;

export function initTypeAuthoring(ctx) {
  async function execute(name, args) {
    const { createToolExecutor } = await import('../agent/tools.js');
    const result = await createToolExecutor(ctx).execute(name, args, { permission: 'full' });
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  /** 读取指定元素上的艺术字规格（用于「编辑艺术字」入口）。 */
  async function readSpec(elementId) {
    if (!elementId) return null;
    try {
      const { html } = await ctx.getEditor().bridge.call('getElementHtml', { elementId });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const node = doc.querySelector('[data-wds-type]');
      if (!node) return null;
      let previous = {};
      try { previous = JSON.parse(node.getAttribute('data-wtk-spec') || '{}'); } catch { /* ignore */ }
      return { ...previous, text: node.getAttribute('data-wtk-text') || previous.text || '', preset: node.getAttribute('data-wds-type') || previous.preset };
    } catch { return null; }
  }

  async function open(payload = {}) {
    if (!ctx.getEditor()?.ready) throw new Error('请先打开一个工程');
    // 只有明确指定预设时才直接落页（Agent / 命令入口）；仅给文字时打开工坊并预填。
    if (payload.preset) return execute('deck_insert_type', payload).catch((e) => { ctx.toast.error(e.message); return null; });

    const selectionId = ctx.store.get().selection?.elementId;
    const existing = payload.elementId ? await readSpec(payload.elementId) : selectionId ? await readSpec(selectionId) : null;
    const targetId = existing ? payload.elementId || selectionId : null;
    let spec = normalizeTypeSpec(existing || { preset: payload.spec?.preset || 'script-swash', text: payload.text || '字由心生', ...(payload.spec || {}) });
    let strokes = {};
    let strokeError = '';
    const token = 'wtk' + Math.random().toString(36).slice(2, 8);

    /* ---------- 画布 ---------- */
    const stage = h('div', { class: 'wtk-studio__preview' });
    const shadow = stage.attachShadow({ mode: 'open' });
    const host = h('div', { style: 'position:absolute;inset:0;overflow:hidden' });
    // 1920×1080 的舞台按比例缩放后居中：用 50%/50% + translate(-50%,-50%)，
    // 不能靠 grid 居中——子元素比容器大时 grid 会从左上开始排，缩放后就跑出可视区。
    const scaler = h('div', { style: `width:${STAGE_W}px;height:${STAGE_H}px;position:absolute;left:50%;top:50%;transform-origin:center center;background:var(--stage,#14161a);box-shadow:0 0 0 1px color-mix(in srgb,var(--ink) 22%,transparent)` });
    const layer = h('div', { style: 'position:absolute;inset:0' });
    scaler.append(layer);
    host.append(scaler);
    const sheet = document.createElement('style');
    sheet.textContent = `
      :host{display:block}
      *{box-sizing:border-box}
      .wtk-play{}
    `;
    shadow.append(sheet, host);

    const note = h('div', { class: 'wtk-studio__note' }, h('span', { class: 'grow' }, '选择左侧风格，右侧调参；预览按 1920×1080 真实比例。'));
    const errorEl = h('span', { class: 'author-error', role: 'status' });

    function fitStage() {
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const k = Math.max(0.08, Math.min((rect.width - 24) / STAGE_W, (rect.height - 24) / STAGE_H));
      scaler.style.transform = `translate(-50%,-50%) scale(${k})`;
    }

    function render() {
      spec = normalizeTypeSpec(spec);
      const built = buildTypeKit(spec, { strokes, token });
      const previous = layer.firstElementChild;
      if (previous) previous.remove();
      const holder = document.createElement('div');
      holder.innerHTML = built.html;
      const el = holder.firstElementChild;
      el.style.position = 'absolute';
      el.style.left = spec.x + 'px';
      el.style.top = spec.y + 'px';
      el.style.width = spec.w + 'px';
      el.style.height = spec.h + 'px';
      el.classList.add('wtk-play');
      layer.append(el);
      // 笔画类需要重新播放，避免停留终态
      if (spec.split === 'stroke') requestAnimationFrame(() => { el.classList.remove('wtk-play'); void el.offsetWidth; el.classList.add('wtk-play'); });
      note.querySelector('.grow').textContent = strokeError || describe();
      autoStage();
    }

    function describe() {
      const preset = typePreset(spec.preset);
      return `${preset.label} · ${spec.font}${spec.split === 'stroke' ? ' · 笔画数据已内联' : ''}`;
    }

    /* ---------- 左侧预设 ---------- */
    const rail = h('div', { class: 'wtk-studio__rail' });
    const presetButtons = new Map();
    for (const group of TYPE_GROUPS) {
      const items = TYPE_PRESETS.filter((p) => p.group === group.id);
      if (!items.length) continue;
      rail.append(h('div', { class: 'wtk-group-title' }, group.label));
      for (const preset of items) {
        const button = h('button', {
          class: 'wtk-preset', type: 'button', 'data-preset': preset.id,
          onclick: () => {
            const keep = { text: spec.text, x: spec.x, y: spec.y, w: spec.w, h: spec.h };
            const defaults = { ...preset.defaults };
            spec = normalizeTypeSpec({ ...keep, preset: preset.id, ...defaults });
            syncControls();
            refreshStrokes();
            markActive();
            render();
          },
        },
        h('strong', {}, preset.label, presetTag(preset)),
        h('small', {}, preset.hint));
        presetButtons.set(preset.id, button);
        rail.append(button);
      }
    }
    function markActive() {
      for (const [id, button] of presetButtons) button.classList.toggle('is-active', id === spec.preset);
      const active = presetButtons.get(spec.preset);
      if (active) active.scrollIntoView({ block: 'nearest' });
    }

    /* ---------- 右侧参数 ---------- */
    const side = h('div', { class: 'wtk-studio__side' });

    const textInput = h('textarea', { class: 'input', rows: 2, 'aria-label': '文字内容', placeholder: '输入要设计的文字' });
    textInput.value = spec.text;
    textInput.addEventListener('input', () => { spec.text = textInput.value; refreshStrokes(); render(); });

    const fontSelect = h('select', { class: 'input', 'aria-label': '字体' },
      Object.entries(TYPE_FONTS).map(([key, f]) => h('option', { value: key }, f.label)));
    fontSelect.addEventListener('change', () => { spec.font = fontSelect.value; spec.italic = Boolean(TYPE_FONTS[fontSelect.value]?.italic); syncControls(); render(); });

    const sizeRange = rangeControl('字号', 16, 400, 1, (v) => { spec.size = Number(v); render(); });
    const weightRange = rangeControl('字重', 100, 900, 50, (v) => { spec.weight = Number(v); render(); });
    const spacingRange = rangeControl('字距', -0.1, 0.6, 0.005, (v) => { spec.letterSpacing = Number(v); render(); }, (v) => Number(v).toFixed(3));
    const staggerRange = rangeControl('逐字间隔', 0, 0.4, 0.005, (v) => { spec.stagger = Number(v); render(); }, (v) => Number(v).toFixed(3) + 's');
    const strokeRange = rangeControl('笔画粗细', 1, 160, 1, (v) => { spec.strokeWidth = Number(v); render(); });

    const colorA = colorInput('主色', () => spec.color, (v) => { spec.color = v; render(); });
    const colorB = colorInput('辅色', () => spec.color2, (v) => { spec.color2 = v; render(); });

    const alignSeg = h('div', { class: 'wtk-seg', role: 'group', 'aria-label': '对齐' },
      [['left', '左'], ['center', '中'], ['right', '右']].map(([value, label]) =>
        h('button', { type: 'button', 'data-align': value, onclick: () => { spec.align = value; syncControls(); render(); } }, label)));

    const stageBg = h('input', { type: 'color', value: '#14161a', 'aria-label': '预览底色', title: '预览底色（只影响预览，不写进作品）' });
    // 预览底色默认用当前页的真实背景，所见即所得；手动选过之后不再覆盖。
    let stagePicked = false;
    const setStage = (color) => { scaler.style.setProperty('--stage', color); stageBg.value = toHex(color); };
    const autoStage = () => {
      if (stagePicked) return;
      setStage(pageBackground() || (luminance(spec.color) < 0.55 ? '#f5f3ee' : '#14161a'));
    };
    stageBg.addEventListener('input', () => { stagePicked = true; scaler.style.setProperty('--stage', stageBg.value); });

    /** 当前页实际背景色：颜色对比与预览都以它为准。 */
    function pageBackground() {
      try {
        const doc = ctx.getEditor()?.iframe?.contentDocument;
        const slides = Array.from(doc?.querySelectorAll('.wpx-slide, .slide, [data-slide]') || []);
        const page = slides.find((s) => s.classList.contains('is-active')) || slides[0];
        if (!page) return null;
        const cs = doc.defaultView.getComputedStyle(page);
        return cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : null;
      } catch { return null; }
    }

    const italicToggle = toggle('斜体', () => spec.italic, (v) => { spec.italic = v; render(); });
    const upperToggle = toggle('大写', () => spec.uppercase, (v) => { spec.uppercase = v; render(); });
    const loopToggle = toggle('循环播放', () => spec.loop, (v) => { spec.loop = v; render(); });

    side.append(
      field('文字内容', textInput),
      field('字体', fontSelect),
      sizeRange.el, weightRange.el, spacingRange.el,
      colorRow([colorA, colorB]),
      alignSeg,
      staggerRange.el, strokeRange.el,
      h('div', { class: 'wtk-row' }, italicToggle.el, upperToggle.el, loopToggle.el),
      field('预览底色', h('div', { class: 'wtk-swatches' }, stageBg,
        ...['#14161a', '#f5f3ee', '#0b0d12', '#ffffff', '#1b1f2a'].map((c) => h('button', {
          class: 'wtk-chip', type: 'button', title: c, 'aria-label': '预览底色 ' + c,
          style: { background: c },
          onclick: () => { stagePicked = true; setStage(c); },
        })))),
      h('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: () => {
          const el = layer.querySelector('[data-wds-type]');
          if (el) { el.classList.remove('wtk-play'); void el.offsetWidth; el.classList.add('wtk-play'); }
        },
      }, '重播动画'),
    );

    function syncControls() {
      textInput.value = spec.text;
      fontSelect.value = spec.font;
      sizeRange.set(spec.size); weightRange.set(spec.weight);
      spacingRange.set(spec.letterSpacing); staggerRange.set(spec.stagger);
      strokeRange.set(spec.strokeWidth);
      colorA.set(spec.color); colorB.set(spec.color2);
      for (const b of alignSeg.children) b.classList.toggle('is-active', b.dataset.align === spec.align);
      italicToggle.set(); upperToggle.set(); loopToggle.set();
      const isStroke = spec.split === 'stroke';
      staggerRange.el.hidden = !/^motion-/.test(spec.preset);
      strokeRange.el.hidden = !(isStroke || ['outline', 'sticker', 'stroke-fill'].includes(spec.preset));
      loopToggle.el.hidden = !isStroke;
    }

    async function refreshStrokes() {
      if (spec.split !== 'stroke') { strokes = {}; strokeError = ''; return; }
      const chars = Array.from(spec.text).filter((c) => c.trim());
      if (!chars.length) { strokes = {}; strokeError = '请输入汉字'; render(); return; }
      note.querySelector('.grow').textContent = '正在取笔画数据…';
      try {
        strokes = await fetchStrokes(spec.text);
        const missing = chars.filter((c) => !strokes[c]);
        strokeError = missing.length ? `以下字符没有笔画数据，将显示为普通文字：${missing.join(' ')}` : '';
      } catch (err) {
        strokes = {};
        strokeError = `笔画数据不可用：${err.message}（可运行 node scripts/pack-hanzi.mjs 后重试）`;
      }
      render();
    }

    /* ---------- 组装对话框 ---------- */
    const body = h('div', { class: 'wtk-studio' }, rail, stage, side);
    const wrap = h('div', {}, body, note, errorEl);
    // 首帧必须在打开之前画好：dialog.open 返回的 Promise 要等对话框关闭才结束，
    // 放在 await 之后会让预览一直是空的。
    markActive();
    syncControls();
    render();

    const closing = ctx.dialog.open({
      title: targetId ? '编辑艺术字' : '艺术字工坊',
      sub: '花体英文 · 中文字形 · 特效 · 纹理 · 阴影 · 填充动效 · 汉字笔画',
      width: 'xl',
      className: 'wtk-studio-modal',
      body: wrap,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: targetId ? '更新' : '插入到当前页', kind: 'primary',
          onClick: async () => {
            try {
              const payload = { ...spec, elementId: targetId || undefined };
              await execute('deck_insert_type', payload);
              return true;
            } catch (err) {
              errorEl.textContent = err.message;
              return false;
            }
          },
        },
      ],
    });

    // 对话框挂载后再适配画布尺寸并取笔画数据
    const mounted = () => {
      fitStage();
      autoStage();
      refreshStrokes();
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => fitStage());
        ro.observe(stage);
        closing.then(() => ro.disconnect(), () => ro.disconnect());
      }
    };
    requestAnimationFrame(mounted);
    return await closing;
  }

  ctx.bus.registerCommand('insert.type', (p) => open(p).catch((e) => ctx.toast.error(e.message)),
    { label: '艺术字', group: '插入', icon: 'type' });

  /** 右键菜单：把选中的普通文字一键转成艺术字，并保留原文。 */
  ctx.bus.registerCommand('format.typeStudio', async (p = {}) => {
    const elementId = p.elementId || ctx.store.get().selection?.elementId;
    let text = '';
    if (elementId) {
      try {
        const { html } = await ctx.getEditor().bridge.call('getElementHtml', { elementId });
        text = new DOMParser().parseFromString(html, 'text/html').body.textContent.trim().slice(0, 200);
      } catch { /* ignore */ }
    }
    return open({ elementId: undefined, text: text || undefined });
  }, { label: '艺术字工坊', group: '设计', icon: 'type' });

  return { open };
}

/* ---------------- 小控件 ---------------- */
function field(label, node) {
  return h('label', { class: 'wtk-field' }, h('span', {}, label), node);
}
function rangeControl(label, min, max, step, onInput, format = (v) => String(Math.round(v))) {
  const value = h('b', {});
  const input = h('input', { type: 'range', min, max, step, 'aria-label': label });
  const el = h('label', { class: 'wtk-field' }, h('span', {}, label, value), input);
  input.addEventListener('input', () => { onInput(input.value); value.textContent = format(Number(input.value)); });
  return {
    el,
    set(v) { input.value = v; value.textContent = format(Number(v)); },
  };
}
function colorInput(label, get, onChange) {
  const input = h('input', { type: 'color', 'aria-label': label, title: label });
  const hex = h('span', { class: 'author-hint', style: 'font-family:var(--ui-mono);font-size:11px' });
  input.addEventListener('input', () => { onChange(input.value); hex.textContent = input.value.toUpperCase(); });
  const wrap = h('label', { class: 'wtk-field' }, h('span', {}, label), input, hex);
  return { el: wrap, set(v) { input.value = toHex(v); hex.textContent = String(v).toUpperCase(); }, get };
}
function colorRow(nodes) {
  return h('div', { class: 'wtk-swatches' }, ...nodes.map((n) => n.el));
}
function toggle(label, get, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => onChange(input.checked));
  const el = h('label', { class: 'wtk-toggle' }, input, label);
  return { el, set() { input.checked = Boolean(get()); } };
}
/** 预设右侧的小标签：笔画类标注数据来源，字体与名称重复时不重复显示。 */
function presetTag(preset) {
  if (preset.split === 'stroke') return h('em', {}, '笔画');
  const label = TYPE_FONTS[preset.font]?.label;
  return label && label !== preset.label ? h('em', {}, label) : null;
}

/** 相对亮度（0–1），用于决定预览底色。 */
function luminance(color) {
  const hex = toHex(String(color || '#ffffff')).slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function toHex(value) {
  const v = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('');
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#000000';
  probe.fillStyle = v;
  const out = probe.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(out) ? out : '#000000';
}
