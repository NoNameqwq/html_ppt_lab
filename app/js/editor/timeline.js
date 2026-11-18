/* 动画时间线 2.0：独立于分页的全局动画轨道
 * - 跨页：一条轨道可以贯穿多页，分页只决定播放头位置
 * - 分页状态：每一页记录一次图层位置 / 效果（自动落在分页切换点的关键帧上）
 * - 多条轨道：元素轨道 + 贯穿层（屏闪 / 飞入 / 光带 / 快门）
 * 数据存在 deck 的 <script id="wpx-timeline">（raw 工程存 .raw-timeline.json），运行时 __WPX__ / __WPTL__ 播放。 */

import { h } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { editTimelineEffect } from './timeline-effect.js';

const PAGE_DEFAULT = 1600;
const EASINGS = [
  ['cubic-bezier(.22,1,.36,1)', '柔和（推荐）'],
  ['linear', '线性'],
  ['ease-out', '缓出'],
  ['ease-in', '缓入'],
  ['cubic-bezier(.7,0,.3,1)', '强调'],
  ['steps(6,end)', '步进'],
];

let ctx = null;
let panel = null;
let open = false;
let timeline = null;
let selectedTrackId = null;
let selectedKfId = null;
let currentTime = 0;
let playing = false;
let pollTimer = 0;
let saveTimer = 0;
let dragState = null;
let pagesModal = null;

const uid = (p) => p + Math.random().toString(36).slice(2, 8);
const ic = (name, size = 15) => h('span', { class: 'ic-wrap', html: icon(name, size) });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function bridge() { try { return ctx?.getEditor?.()?.bridge || null; } catch { return null; } }
function deck() { return (ctx?.store?.get()?.deck) || {}; }
function selection() { return (ctx?.store?.get()?.selection) || null; }
function toast(msg, type = 'info', duration) { try { ctx.toast(msg, { type, duration }); } catch { /* ignore */ } }
function isRaw() { const d = deck(); return d.raw === true || d.mode === 'raw'; }
function projectId() { try { return ctx?.store?.get()?.project?.id || ''; } catch { return ''; } }
function total() { return Number(timeline?.duration) || 1; }
function pageCount() { return Number(deck().total) || 0; }
function trackById(id) { return (timeline?.tracks || []).find((t) => t.id === id) || null; }
function kfById(track, id) { return (track?.keyframes || []).find((k) => k.id === id) || null; }

async function call(method, params) {
  const b = bridge();
  if (!b?.ready) throw new Error('画布尚未就绪');
  return b.call(method, params || {});
}

/* ---------------- 数据 ---------------- */

function defaultTimeline() {
  const n = pageCount() || 1;
  return {
    version: 2,
    pageDuration: PAGE_DEFAULT,
    followPages: true,
    autoplay: true,
    loop: false,
    duration: n * PAGE_DEFAULT,
    pages: [],
    tracks: [],
  };
}

function ensurePages(t) {
  const n = pageCount() || 1;
  const pd = Number(t.pageDuration) || PAGE_DEFAULT;
  t.pageDuration = pd;
  const names = (deck().slides || []).map((s) => s.name || '');
  let start=0;
  t.pages = Array.from({ length: n }, (_, i) => { const duration=Math.max(100,Number(t.pages?.[i]?.duration)||pd);const p={index:i,start,duration,name:names[i]||`第 ${i+1} 页`};start+=duration;return p; });
  t.duration = Math.max(start,Number(t.duration)||0);
  return t;
}

function normalize(t) {
  if (!t || !Array.isArray(t.tracks)) return defaultTimeline();
  t.version = 2;
  if (t.followPages == null) t.followPages = true;
  if (t.autoplay == null) t.autoplay = true;
  (t.tracks || []).forEach((tr) => {
    tr.id = tr.id || uid('tr');
    if(tr.kind==='overlay'&&!tr.html){const kind=/data-wpx-tl\s*=\s*["']([^"']+)/.exec(tr.selector||'')?.[1];if(OVERLAY_PRESETS[kind])tr.html=OVERLAY_PRESETS[kind].html;}
    tr.keyframes = (tr.keyframes || []).map((k) => ({
      id: k.id || uid('kf'),
      t: Number(k.t) || 0,
      props: k.props || {},
      easing: k.easing || '',
      page: k.page != null ? k.page : undefined,
    }));
  });
  return t;
}

async function rawGetTimeline() {
  const id = projectId();
  if (!id) return null;
  const res = await fetch('/api/projects/' + encodeURIComponent(id) + '/timeline');
  if (!res.ok) return null;
  const data = await res.json();
  return data.timeline || null;
}
async function rawPutTimeline(tl) {
  const id = projectId();
  if (!id) return;
  const res=await fetch('/api/projects/' + encodeURIComponent(id) + '/timeline', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeline: tl }),
  });
  if(!res.ok)throw new Error('时间线保存失败：HTTP '+res.status);
}

async function saveTimeline(immediate) {
  clearTimeout(saveTimer);
  const run = async () => {
    try {
      if (isRaw()) await rawPutTimeline(timeline);
      await call('setTimeline', { timeline });
      await call('timelineRefresh');
      await call('timelineSeek', { time: currentTime });
      try { ctx.getEditor()?.markDirty?.(); } catch { /* ignore */ }
    } catch (err) {
      toast('时间线保存失败：' + (err?.message || err), 'error', 2600);
    }
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 220);
}

async function loadTimeline() {
  let stored = null;
  if (isRaw()) stored = await rawGetTimeline();
  else { const res = await call('getTimeline'); stored = res?.timeline || null; }
  timeline = normalize(stored || defaultTimeline());
  ensurePages(timeline);
  selectedTrackId = timeline.tracks[0]?.id || null;
  selectedKfId = null;
  currentTime = 0;
  playing = false;
  try { await call('setTimeline', { timeline, silent:true }); } catch { /* ignore */ }
  await call('timelineSeek', { time: 0 }).catch(() => { });
}

/* ---------------- 读取画布 ---------------- */

async function captureProps(track) {
  try {
    const res = await call('getTimelineStyle', track?.selector ? { selector: track.selector } : {});
    return res?.props || { opacity: 1 };
  } catch {
    return { opacity: 1 };
  }
}

function elemSelector(sel) {
  if (!sel?.elementId) return '';
  return `[data-wpx-el="${sel.elementId}"]`;
}

/* ---------------- 轨道 ---------------- */

async function addTrackFromSelection(opts = {}) {
  if (!timeline) await loadTimeline();
  if (!timeline) { toast('时间线还没准备好', 'warn'); return false; }
  ensurePages(timeline);
  const sel = opts.elementId ? { elementId: opts.elementId } : selection();
  let selector = elemSelector(sel);
  if (!selector) {
    const answer = await ctx.dialog.prompt('轨道目标选择器', {
      title: '新建动画轨道',
      placeholder: 'CSS 选择器，例如 [data-wpx-tl="flash"] 或 .my-layer',
      value: '',
    });
    if (!answer) return false;
    selector = String(answer).trim();
  }
  if (!selector) return false;
  const dup = (timeline.tracks || []).find((t) => t.kind !== 'overlay' && t.selector === selector);
  if (dup) {
    selectedTrackId = dup.id;
    selectedKfId = dup.keyframes[0]?.id || null;
    if (!open) toggle(true); else render();
    toast('这个元素已经有一条轨道，已选中它', 'info', 2000);
    return true;
  }
  const label = (sel?.text ? String(sel.text).replace(/\s+/g, ' ').slice(0, 14) : '') || (sel?.type === 'image' ? '图片' : sel?.type === 'shape' ? '形状' : '元素');
  const track = {
    id: uid('tr'),
    name: label + ' · 轨道',
    selector,
    kind: 'element',
    easing: EASINGS[0][0],
    syncPages: true,
    keyframes: [],
  };
  const props = await captureProps(track);
  const p = { ...props };
  for (const page of timeline.pages || []) {
    track.keyframes.push({ id: uid('kf'), t: page.start, props: { ...p }, page: page.index });
  }
  if (!track.keyframes.length) track.keyframes.push({ id: uid('kf'), t: 0, props: { ...p } });
  timeline.tracks.push(track);
  selectedTrackId = track.id;
  selectedKfId = track.keyframes[0]?.id || null;
  await saveTimeline(true);
  if (!open) toggle(true); else render();
  toast('已创建跨页轨道（每个分页切换点都有自动关键帧）', 'ok', 2400);
  return true;
}

async function addKeyframe(updateOnly) {
  const track = trackById(selectedTrackId);
  if (!track) { toast('先选择一条轨道', 'warn'); return; }
  const t = Math.round(currentTime);
  let kf = track.keyframes.find((k) => Math.abs(k.t - t) < 24);
  if (!kf) { kf = { id: uid('kf'), t, props: {} }; track.keyframes.push(kf); }
  kf.props = await captureProps(track);
  kf.page = pageAt(t).index;
  track.keyframes.sort((a, b) => a.t - b.t);
  selectedKfId = kf.id;
  await saveTimeline(true);
  render();
  if (!updateOnly) toast('已在 ' + (t / 1000).toFixed(2) + 's 添加关键帧', 'ok', 1400);
}

async function pageKeyframes() {
  const track = trackById(selectedTrackId);
  if (!track) { toast('先选择一条轨道', 'warn'); return; }
  const props = await captureProps(track);
  let added = 0;
  for (const p of timeline.pages || []) {
    const hit = track.keyframes.find((k) => Math.abs(k.t - p.start) < 20);
    if (hit) { hit.page = p.index; continue; }
    track.keyframes.push({ id: uid('kf'), t: p.start, props: { ...props }, page: p.index });
    added += 1;
  }
  track.keyframes.sort((a, b) => a.t - b.t);
  track.syncPages = true;
  await saveTimeline(true);
  render();
  toast(added ? `已在 ${added} 个分页切换点添加关键帧` : '每个分页切换点已经有关键帧', 'ok', 2000);
}

async function deleteTrack(id) {
  const i = (timeline.tracks || []).findIndex((t) => t.id === id);
  if (i < 0) return;
  const track = timeline.tracks[i];
  if (!track.html && String(track.selector || '').includes('data-wpx-tl=')) {
    await call('deleteGlobalElement', { selector: track.selector }).catch(() => { });
  }
  timeline.tracks.splice(i, 1);
  selectedTrackId = timeline.tracks[0]?.id || null;
  selectedKfId = null;
  await saveTimeline(true);
  render();
  toast('已删除轨道', 'ok', 1200);
}

/* ---------------- 贯穿层生成器 ---------------- */

const OVERLAY_PRESETS = {
  ripple: {
    name:'涟漪扩散',
    html:'<div style="position:absolute;left:50%;top:50%;width:300px;height:300px;margin:-150px;border:12px solid #a7b7ff;border-radius:50%;opacity:0;z-index:75"></div>',
    easing:'ease-out',
    frames:(p,end)=>[{t:p.start,props:{opacity:0,scale:.1}},{t:Math.min(end,p.start+120),props:{opacity:.9,scale:.3}},{t:Math.min(end,p.start+1100),props:{opacity:0,scale:5}}],
  },
  orbit: {
    name:'星环旋转',
    html:'<div style="position:absolute;left:50%;top:50%;width:500px;height:500px;margin:-250px;border:3px solid #c5b1ff;border-radius:50%;opacity:0;z-index:75"><svg viewBox="0 0 500 500" width="500" height="500"><circle cx="250" cy="0" r="20" fill="#c5b1ff"/><path d="M250 20V480M20 250H480" stroke="#c5b1ff" opacity=".25"/></svg></div>',
    easing:'linear',
    frames:(p,end)=>[{t:p.start,props:{opacity:0,scale:.6,rotate:0}},{t:Math.min(end,p.start+200),props:{opacity:.8,scale:1,rotate:60}},{t:Math.min(end,p.start+1400),props:{opacity:0,scale:1.4,rotate:360}}],
  },
  flash: {
    name: '屏闪层',
    html: '<div data-wpx-tl="flash" style="position:absolute;inset:0;background:#fff;opacity:0;z-index:80;pointer-events:none"></div>',
    easing: 'ease-out',
    frames: (p, end) => [
      { t: p.start, props: { opacity: 0 } },
      { t: Math.min(end, p.start + 50), props: { opacity: 0.95 } },
      { t: Math.min(end, p.start + 240), props: { opacity: 0 } },
    ],
  },
  black: {
    name: '黑场',
    html: '<div data-wpx-tl="black" style="position:absolute;inset:0;background:#000;opacity:0;z-index:80;pointer-events:none"></div>',
    easing: 'ease-out',
    frames: (p, end) => [
      { t: p.start, props: { opacity: 0 } },
      { t: Math.min(end, p.start + 90), props: { opacity: 1 } },
      { t: Math.min(end, p.start + 320), props: { opacity: 0 } },
    ],
  },
  fly: {
    name: '飞入元素',
    html: '<div data-wpx-tl="fly" style="position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:50%;background:var(--wpx-accent,#E1402B);opacity:0;z-index:70;pointer-events:none"></div>',
    easing: 'cubic-bezier(.22,1,.36,1)',
    frames: (p, end) => [
      { t: p.start, props: { opacity: 0, x: -640, y: 0, scale: 0.4, rotate: -50 } },
      { t: Math.min(end, p.start + 380), props: { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 } },
      { t: Math.min(end, p.start + 720), props: { opacity: 1, x: 0, y: 0, scale: 1, rotate: 0 } },
      { t: Math.min(end, p.start + 980), props: { opacity: 0, x: 720, y: 0, scale: 0.6, rotate: 30 } },
    ],
  },
  sweep: {
    name: '光带',
    html: '<div data-wpx-tl="sweep" style="position:absolute;top:0;bottom:0;left:-40%;width:36%;background:var(--wpx-accent,#E1402B);opacity:0;z-index:75;pointer-events:none;filter:blur(1px)"></div>',
    easing: 'cubic-bezier(.4,0,.1,1)',
    frames: (p, end) => [
      { t: p.start, props: { opacity: 0, x: 0 } },
      { t: Math.min(end, p.start + 60), props: { opacity: 0.9, x: 0 } },
      { t: Math.min(end, p.start + 480), props: { opacity: 0.9, x: 3600 } },
      { t: Math.min(end, p.start + 520), props: { opacity: 0, x: 3600 } },
    ],
  },
  shutter: {
    name: '快门',
    html: '<div data-wpx-tl="shutter" style="position:absolute;inset:0;background:#0A0A0B;opacity:0;z-index:80;pointer-events:none"></div>',
    easing: 'steps(4,end)',
    frames: (p, end) => [
      { t: p.start, props: { opacity: 0 } },
      { t: Math.min(end, p.start + 40), props: { opacity: 1 } },
      { t: Math.min(end, p.start + 190), props: { opacity: 1 } },
      { t: Math.min(end, p.start + 340), props: { opacity: 0 } },
    ],
  },
};

async function addOverlay(kind) {
  if (!timeline) await loadTimeline();
  if(kind==='custom') {
    const id=uid('fx');
    const fresh={id,name:'自定义特效',kind:'overlay',selector:`[data-wpx-tl="${id}"]`,html:'<div style="position:absolute;inset:25%;background:radial-gradient(circle,#7c6cff,transparent);opacity:0"></div>',easing:'ease-out',keyframes:[{t:0,props:{opacity:0,scale:.2}},{t:600,props:{opacity:1,scale:1}},{t:1400,props:{opacity:0,scale:1.5}}]};
    const edited=await editTimelineEffect(ctx,fresh,timeline.pages);
    if(!edited)return;
    timeline.tracks.push(edited);selectedTrackId=id;selectedKfId=null;await saveTimeline(true);if(!open)toggle(true);else render();return;
  }
  const preset = OVERLAY_PRESETS[kind];
  if (!preset) return;
  const selector = `[data-wpx-tl="${kind}"]`;
  const existing = (timeline.tracks || []).find((t) => t.kind === 'overlay' && t.selector === selector);
  if (existing) {
    selectedTrackId = existing.id;
    selectedKfId = existing.keyframes[0]?.id || null;
    if (!open) toggle(true); else render();
    toast('「' + preset.name + '」已经存在，已选中该轨道', 'info', 2000);
    return;
  }
  const end = timeline.duration;
  let track = { id: uid('tr'), name: preset.name, html:preset.html, selector, kind: 'overlay', easing: preset.easing, syncPages: true, keyframes: [] };
  for (const p of timeline.pages || []) {
    preset.frames(p, end).forEach((f) => {
      if (f.t <= end) track.keyframes.push({ id: uid('kf'), t: f.t, props: { ...f.props }, page: p.index });
    });
  }
  const seen = new Set();
  track.keyframes = track.keyframes.filter((k) => {
    const key = Math.round(k.t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.t - b.t);
  if(kind==='fly') { track.content={type:'text',value:'飞入文字',color:'#e1402b',size:96,direction:'left',duration:980}; const edited=await editTimelineEffect(ctx,track,timeline.pages);if(!edited)return;track=edited; }
  timeline.tracks.push(track);
  selectedTrackId = track.id;
  selectedKfId = track.keyframes[0]?.id || null;
  await saveTimeline(true);
  if (!open) toggle(true); else render();
  toast('已添加「' + preset.name + '」：每个分页切换都会触发', 'ok', 2600);
}

/* ---------------- 播放 ---------------- */

async function play() {
  try {
    await call('timelinePlay');
    playing = true;
    paintPlayBtn();
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const st = await call('timelineState');
        currentTime = st?.time || 0;
        playing = !!st?.playing;
        paintPlayhead();
        paintPlayBtn();
        if (!playing) clearInterval(pollTimer);
      } catch { clearInterval(pollTimer); }
    }, 100);
  } catch (err) { toast('播放失败：' + (err?.message || err), 'error'); }
}

async function pause() {
  try { await call('timelinePause'); } catch { /* ignore */ }
  playing = false;
  clearInterval(pollTimer);
  paintPlayBtn();
}

async function seek(t, opts = {}) {
  currentTime = clamp(Number(t) || 0, 0, total());
  if (opts.page != null) {
    try { await ctx.getEditor()?.goSlide?.(opts.page); } catch { /* ignore */ }
  }
  try { await call('timelineSeek', { time: currentTime }); } catch { /* ignore */ }
  paintPlayhead();
}

/* ---------------- 渲染 ---------------- */

function pageAt(t) {
  const pages = timeline?.pages || [];
  let cur = pages[0] || { index: 0, start: 0, duration: timeline?.pageDuration || PAGE_DEFAULT };
  for (const p of pages) if (t >= p.start - 1) cur = p;
  return cur;
}

function paintPlayBtn() {
  if (!panel) return;
  const b = panel.querySelector('[data-act="play"]');
  if (b) { b.replaceChildren(ic(playing ? 'pause' : 'play', 15)); b.dataset.tip = playing ? '暂停' : '播放'; }
}

function paintPlayhead() {
  if (!panel) return;
  const pct = (currentTime / total()) * 100;
  panel.querySelectorAll('.tl2-playhead').forEach((n) => { n.style.left = pct + '%'; });
  const label = panel.querySelector('.tl2-time');
  if (label) label.innerHTML = '<b>' + (currentTime / 1000).toFixed(2) + '</b>s <span>/ ' + (total() / 1000).toFixed(2) + 's</span>';
  const page = pageAt(currentTime);
  const tag = panel.querySelector('.tl2-page-tag');
  if (tag) tag.textContent = 'P' + (page.index + 1);
}

function renderRuler() {
  const ruler = panel.querySelector('.tl2-ruler');
  if (!ruler) return;
  ruler.replaceChildren();
  const T = total();
  const pages = timeline.pages || [];
  const wide = ruler.clientWidth / Math.max(1, pages.length);
  pages.forEach((p) => {
    const seg = h('button', {
      type: 'button', class: 'tl2-seg' + (p.index === (Number(deck().current) || 0) ? ' is-current' : ''),
      style: `left:${(p.start / T) * 100}%;width:${(p.duration / T) * 100}%`,
      title: `${p.name || '第 ' + (p.index + 1) + ' 页'} · ${(p.start / 1000).toFixed(2)}s`,
    });
    if (wide > 26) seg.append(h('span', {}, 'P' + (p.index + 1)));
    seg.addEventListener('click', (e) => {
      e.stopPropagation();
      seek(p.start, { page: p.index });
    });
    ruler.append(seg);
  });
  const head = h('div', { class: 'tl2-playhead' });
  ruler.append(head);
}

function renderTracks() {
  const side = panel.querySelector('.tl2-side-list');
  const lanes = panel.querySelector('.tl2-lanes');
  if (!side || !lanes) return;
  side.replaceChildren();
  lanes.replaceChildren();
  const T = total();
  const tracks = timeline.tracks || [];
  if (!tracks.length) {
    lanes.append(h('div', { class: 'tl2-empty' },
      h('strong', {}, '还没有动画轨道'),
      h('span', {}, '选中画布元素后点「+ 轨道」；或直接生成屏闪 / 飞入 / 光带，它们会贯穿全片。')));
  }
  tracks.forEach((track) => {
    const isActive = track.id === selectedTrackId;
    const row = h('div', { class: 'tl2-track' + (isActive ? ' is-active' : '') },
      h('span', { class: 'tl2-dot', style: `background:${trackColor(track)}` }),
      h('span', { class: 'tl2-name', title: track.selector }, track.name || track.id),
      h('span', { class: 'tl2-count' }, track.keyframes.length + 'k'),
      h('button', { type: 'button', class: 'tl2-eye', title: track.hidden ? '显示轨道' : '隐藏轨道', html: icon(track.hidden ? 'eye-off' : 'eye', 13) }));
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tl2-eye')) {
        track.hidden = !track.hidden;
        saveTimeline(true).then(render);
        return;
      }
      selectedTrackId = track.id;
      selectedKfId = null;
      render();
    });
    row.addEventListener('dblclick', async () => {
      const next = await ctx.dialog.prompt('轨道名称', { title: '重命名轨道', value: track.name || '' });
      if (next != null) { track.name = String(next).trim() || track.name; saveTimeline(true); render(); }
    });
    side.append(row);

    const lane = h('div', { class: 'tl2-lane' + (isActive ? ' is-active' : '') + (track.hidden ? ' is-off' : '') });
    lane.addEventListener('dblclick', async (e) => {
      if (e.target !== lane) return;
      const r = lane.getBoundingClientRect();
      const t = Math.round(clamp(((e.clientX - r.left) / r.width) * T, 0, T));
      selectedTrackId = track.id;
      currentTime = t;
      try { await call('timelineSeek', { time: t }); } catch { /* ignore */ }
      await addKeyframe(true);
    });
    track.keyframes.forEach((kf) => {
      const dot = h('button', {
        type: 'button',
        class: 'tl2-kf' + (track.id === selectedTrackId && kf.id === selectedKfId ? ' is-active' : ''),
        style: `left:${(kf.t / T) * 100}%`,
        title: (kf.t / 1000).toFixed(2) + 's · 不透明度 ' + (kf.props?.opacity ?? 1),
        'data-kf': kf.id,
      });
      dot.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        selectedTrackId = track.id;
        selectedKfId = kf.id;
        render();
        const r = lane.getBoundingClientRect();
        dragState = { kind: 'kf', track, kf, lane: r };
        const move = (ev) => {
          if (!dragState || dragState.kind !== 'kf') return;
          const t = Math.round(clamp(((ev.clientX - r.left) / r.width) * T, 0, T));
          kf.t = t;
          kf.page = pageAt(t).index;
          const node = panel.querySelector(`.tl2-kf[data-kf="${kf.id}"]`);
          if (node) node.style.left = (t / T) * 100 + '%';
          const timeField = panel.querySelector('[data-field="kf-time"]');
          if (timeField) timeField.value = String(t);
        };
        const up = () => {
          dragState = null;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          track.keyframes.sort((a, b) => a.t - b.t);
          saveTimeline(true).then(() => render());
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedTrackId = track.id;
        selectedKfId = kf.id;
        currentTime = kf.t;
        call('timelineSeek', { time: kf.t }).catch(() => { });
        const pg = pageAt(kf.t);
        if (pg.index !== (Number(deck().current) || 0)) {
          ctx.getEditor()?.goSlide?.(pg.index)?.then?.(() => call('timelineSeek', { time: kf.t }).catch(() => { }));
        }
        render();
      });
      lane.append(dot);
    });
    lanes.append(lane);
  });
  const head = h('div', { class: 'tl2-playhead tl2-playhead--lanes' });
  lanes.append(head);
  // 两侧滚动同步
  lanes.onscroll = () => { side.scrollTop = lanes.scrollTop; };
  side.onscroll = () => { lanes.scrollTop = side.scrollTop; };
}

function trackColor(track) {
  if (track.kind === 'overlay') return 'var(--accent)';
  const palette = ['#3E7BD6', '#4FA97C', '#C43E1C', '#8A63D2', '#D6A23E'];
  let n = 0;
  for (let i = 0; i < (timeline.tracks || []).length; i++) if (timeline.tracks[i].id === track.id) n = i;
  return palette[n % palette.length];
}

function field(label, input, hintLabel) {
  return h('label', { class: 'tl2-field' },
    h('span', { class: 'tl2-flabel' }, label),
    input,
    hintLabel ? h('span', { class: 'tl2-fhint' }, hintLabel) : null);
}

function numInput(value, step, onChange, opts = {}) {
  const inp = h('input', { class: 'input tl2-input', type: 'number', step: String(step), value: String(value ?? 0) });
  if (opts.min != null) inp.min = String(opts.min);
  if (opts.max != null) inp.max = String(opts.max);
  inp.addEventListener('change', () => onChange(Number(inp.value)));
  return inp;
}

function renderInspector() {
  const box = panel.querySelector('.tl2-inspector');
  if (!box) return;
  box.replaceChildren();
  const track = trackById(selectedTrackId);
  const kf = kfById(track, selectedKfId);

  const head = h('div', { class: 'tl2-ins-head' },
    h('strong', {}, kf ? '关键帧' : track ? '轨道' : '检查器'),
    h('span', { class: 'tl2-grow' }),
    kf ? h('button', { type: 'button', class: 'tl2-mini danger', title: '删除关键帧' }, ic('trash', 13)) : null);
  if (kf) {
    head.lastChild.addEventListener('click', async () => {
      track.keyframes = track.keyframes.filter((k) => k.id !== kf.id);
      selectedKfId = track.keyframes[0]?.id || null;
      await saveTimeline(true);
      render();
    });
  }
  box.append(head);

  if (!track) {
    box.append(h('div', { class: 'tl2-ins-empty' },
      h('p', {}, '选中一个画布元素，或点「+ 轨道」，就能给它做一条贯穿多页的动画线。'),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => addTrackFromSelection() }, '用当前选中元素建轨道')));
    return;
  }

  box.append(h('div', { class: 'tl2-ins-track' },
    h('code', {}, track.selector),
    h('div', { class: 'tl2-ins-actions' },
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => addKeyframe() }, '加帧'),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => pageKeyframes() }, '每页'),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => openPageStates(track) }, '分页状态'))));
  if(track.kind==='overlay' || track.html) box.append(h('button',{type:'button',class:'btn btn--sm tl-edit-content',onclick:async()=>{
    const edited=await editTimelineEffect(ctx,track,timeline.pages);if(!edited)return;Object.assign(track,edited);await saveTimeline(true);render();
  }},'编辑飞入内容 / SVG'));
  box.append(h('button',{type:'button',class:'btn btn--sm tl-edit-content',onclick:()=>deleteTrack(track.id)},'删除轨道'));

  if (!kf) {
    box.append(h('div', { class: 'tl2-ins-empty' },
      h('p', {}, '这条轨道有 ' + track.keyframes.length + ' 个关键帧。点时间线上的菱形选中它，或拖到别的位置。')));
    return;
  }

  const props = kf.props || {};
  const timeInput = numInput(kf.t, 10, (v) => { kf.t = clamp(v, 0, total()); kf.page = pageAt(kf.t).index; saveTimeline(true).then(render); }, { min: 0, max: total() });
  timeInput.dataset.field = 'kf-time';
  const opacity = numInput(props.opacity ?? 1, 0.05, (v) => { kf.props.opacity = clamp(v, 0, 1); saveTimeline(); }, { min: 0, max: 1 });
  const x = numInput(props.x ?? 0, 1, (v) => { kf.props.x = v; saveTimeline(); });
  const y = numInput(props.y ?? 0, 1, (v) => { kf.props.y = v; saveTimeline(); });
  const scale = numInput(props.scale ?? 1, 0.02, (v) => { kf.props.scale = v; saveTimeline(); }, { min: 0.01 });
  const rotate = numInput(props.rotate ?? 0, 1, (v) => { kf.props.rotate = v; saveTimeline(); });
  const blur = numInput(props.blur ?? 0, 0.5, (v) => { kf.props.blur = v; saveTimeline(); }, { min: 0 });

  const grid = h('div', { class: 'tl2-grid2' },
    field('时间 ms', timeInput),
    field('不透明度', opacity),
    field('偏移 X', x),
    field('偏移 Y', y),
    field('缩放', scale),
    field('旋转 °', rotate),
    field('模糊 px', blur));

  const easing = h('select', { class: 'input tl2-input' },
    ...EASINGS.map(([v, l]) => h('option', { value: v }, l)));
  easing.value = kf.easing || '';
  if (!kf.easing) easing.insertBefore(h('option', { value: '' }, '跟随轨道'), easing.firstChild);
  easing.addEventListener('change', () => { kf.easing = easing.value; saveTimeline(); });

  const easeRow = h('div', { class: 'tl2-grid2' },
    field('缓动', easing),
    field('页面', h('div', { class: 'tl2-static' }, 'P' + ((kf.page ?? pageAt(kf.t).index) + 1))));

  const grab = h('button', { type: 'button', class: 'btn btn--sm', onclick: async () => {
    const now = await captureProps(track);
    kf.props = now;
    await saveTimeline(true);
    render();
    toast('已抓取画布当前状态', 'ok', 1400);
  } }, '抓取画布当前值');

  box.append(grid, easeRow, h('div', { class: 'tl2-ins-foot' }, grab));
}

function render() {
  if (!panel) return;
  renderRuler();
  renderTracks();
  renderInspector();
  paintPlayhead();
  paintPlayBtn();
  const follow = panel.querySelector('[data-act="follow"]');
  if (follow) follow.classList.toggle('is-on', timeline.followPages !== false);
  const auto = panel.querySelector('[data-act="autoplay"]');
  if (auto) auto.classList.toggle('is-on', timeline.autoplay !== false);
  const badge = panel.querySelector('.tl2-track-count');
  if (badge) badge.textContent = (timeline.tracks || []).length + ' 轨';
}

/* ---------------- 分页状态（每页图层位置 / 效果） ---------------- */

function openPageStates(track) {
  if (!track) { toast('先选择一条轨道', 'warn'); return; }
  if (pagesModal) { pagesModal.remove(); pagesModal = null; }
  const rows = [];
  const wrap = h('div', { class: 'tl2-pages-body' });
  const table = h('div', { class: 'tl2-pages-table' });

  const headRow = h('div', { class: 'tl2-pages-row tl2-pages-head' },
    h('span', {}, '页'), h('span', {}, '起点'), h('span', {}, 'X'), h('span', {}, 'Y'),
    h('span', {}, '缩放'), h('span', {}, '不透明度'), h('span', {}, ''), h('span', {}, ''));
  table.append(headRow);

  timeline.pages.forEach((p) => {
    let kf = track.keyframes.find((k) => Math.abs(k.t - p.start) < 20);
    if (!kf) {
      kf = { id: uid('kf'), t: p.start, props: { ...(track.keyframes[0]?.props || { opacity: 1 }) }, page: p.index };
      track.keyframes.push(kf);
      track.keyframes.sort((a, b) => a.t - b.t);
    }
    const props = kf.props;
    const mk = (key, step, min) => {
      const inp = h('input', { class: 'input tl2-input', type: 'number', step: String(step), value: String(props[key] ?? (key === 'opacity' ? 1 : key === 'scale' ? 1 : 0)) });
      if (min != null) inp.min = String(min);
      inp.addEventListener('change', () => { props[key] = Number(inp.value); saveTimeline(); });
      return inp;
    };
    const row = h('div', { class: 'tl2-pages-row' },
      h('button', { type: 'button', class: 'tl2-page-btn', onclick: () => seek(p.start, { page: p.index }) }, 'P' + (p.index + 1)),
      h('span', { class: 'tl2-pages-time' }, (p.start / 1000).toFixed(2) + 's'),
      mk('x', 1), mk('y', 1), mk('scale', 0.05, 0.01), mk('opacity', 0.05, 0),
      h('button', { type: 'button', class: 'tl2-mini', title: '抓取当前画布状态' }, ic('cursor-select', 13)),
      h('button', { type: 'button', class: 'tl2-mini', title: '跳到该页' }, ic('chevron-right', 13)));
    row.children[6].addEventListener('click', async () => {
      seek(p.start, { page: p.index });
      await new Promise((r) => setTimeout(r, 260));
      const now = await captureProps(track);
      kf.props = now;
      await saveTimeline(true);
      openPageStates(track);
      toast('已记录 P' + (p.index + 1) + ' 的位置', 'ok', 1400);
    });
    row.children[7].addEventListener('click', () => seek(p.start, { page: p.index }));
    table.append(row);
    rows.push(row);
  });

  wrap.append(table);
  const modal = h('div', { class: 'tr-modal-backdrop tl2-pages-modal' },
    h('div', { class: 'tr-modal' },
      h('div', { class: 'tr-modal-head' },
        h('strong', { class: 'tr-modal-title' }, '分页状态'),
        h('span', { class: 'tl2-pages-sub' }, track.name + ' · 每一页的图层位置与效果'),
        h('span', { class: 'tl2-grow' }),
        h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { pagesModal.remove(); pagesModal = null; saveTimeline(true).then(render); } }, '完成')),
      wrap,
      h('div', { class: 'tl2-pages-foot' }, '每一行对应一个分页切换点；改了数字就写进该页起点的关键帧 —— 这就是「跨页 + 分页状态」。')));
  document.body.append(modal);
  pagesModal = modal;
  modal.addEventListener('pointerdown', (e) => { if (e.target === modal) { pagesModal = null; modal.remove(); saveTimeline(true).then(render); } });
}

/* ---------------- 面板 ---------------- */

function buildPanel() {
  panel = h('div', { class: 'timeline-panel tl2', id: 'timeline-panel' });
  const resize = h('div', { class: 'tl2-resize', title: '拖动调整高度' });
  const head = h('div', { class: 'tl2-head' },
    h('span', { class: 'tl2-title' }, '动画时间线'),
    h('span', { class: 'tl2-badge' }, '跨页 · 多轨'),
    h('span', { class: 'tl2-track-count' }, '0 轨'),
    h('button', { type: 'button', class: 'tl2-icon', 'data-act': 'play', 'data-tip': '播放' }, ic('play', 15)),
    h('button', { type: 'button', class: 'tl2-icon', 'data-act': 'stop', 'data-tip': '回到起点' }, ic('stop', 14)),
    h('span', { class: 'tl2-time' }, '0.00s'),
    h('span', { class: 'tl2-page-tag' }, 'P1'),
    h('span', { class: 'tl2-grow' }),
    h('button', { type: 'button', class: 'btn btn--sm', 'data-act':'agent', onclick:()=>{
      const track=trackById(selectedTrackId);
      ctx.bus.runCommand('agent.draft',{text:`请设计动画时间线${track?'，调整轨道「'+track.name+'」（id: '+track.id+'，selector: '+track.selector+'）':''}。先用 deck_get_timeline 读取现有时间线，保留其它轨道。可生成新的 HTML / SVG 特效及 CSS、关键帧，再用 deck_set_timeline 保存。\n我的要求：`});
    }},ic('sparkles',14),'Agent'),
    h('button', { type: 'button', class: 'tl2-icon', 'data-act': 'follow', 'data-tip': '跟随分页：切页时播放头对齐到该页起点' }, ic('link', 14)),
    h('button', { type: 'button', class: 'tl2-icon', 'data-act': 'autoplay', 'data-tip': '放映时自动播放时间线' }, ic('play-circle', 14)),
    h('button', { type: 'button', class: 'btn btn--sm', 'data-act': 'addTrack' }, ic('plus', 13), h('span', {}, '轨道')),
    h('button', { type: 'button', class: 'btn btn--sm', 'data-act': 'addKf' }, ic('plus', 13), h('span', {}, '关键帧')),
    h('button', { type: 'button', class: 'btn btn--sm', 'data-act': 'fx' }, ic('zap', 13), h('span', {}, '特效'), ic('chevron-down', 12)),
    h('button', { type: 'button', class: 'tl2-icon', 'data-act': 'close', 'data-tip': '关闭' }, ic('close', 15)));

  const side = h('div', { class: 'tl2-side' },
    h('div', { class: 'tl2-side-head' }, '轨道'),
    h('div', { class: 'tl2-side-list' }));
  const main = h('div', { class: 'tl2-main' },
    h('div', { class: 'tl2-ruler' }),
    h('div', { class: 'tl2-lanes' }));
  const inspector = h('div', { class: 'tl2-inspector' });
  const body = h('div', { class: 'tl2-body' }, side, main, inspector);
  const foot = h('div', { class: 'tl2-foot' },
    h('span', {}, '拖动关键帧改时间 · 双击轨道空白加帧 · 点分页标记跳页'),
    h('span', { class: 'tl2-grow' }),
    h('span', {}, '时间线独立于分页，可贯穿多页；「分页状态」为每页记录图层位置'));

  panel.append(resize, head, body, foot);
  document.getElementById('editor-view')?.append(panel);
  panel.classList.add('hidden');

  panel.querySelector('[data-act="play"]').addEventListener('click', () => (playing ? pause() : play()));
  panel.querySelector('[data-act="stop"]').addEventListener('click', async () => { await pause(); seek(0); });
  panel.querySelector('[data-act="close"]').addEventListener('click', () => toggle(false));
  panel.querySelector('[data-act="addTrack"]').addEventListener('click', () => addTrackFromSelection());
  panel.querySelector('[data-act="addKf"]').addEventListener('click', () => addKeyframe());
  panel.querySelector('[data-act="fx"]').addEventListener('click', (e) => {
    e.stopPropagation();
    openFxMenu(panel.querySelector('[data-act="fx"]'));
  });
  const rulerEl = panel.querySelector('.tl2-ruler');
  const seekAt = (e) => {
    const r = rulerEl.getBoundingClientRect();
    seek(clamp(((e.clientX - r.left) / r.width) * total(), 0, total()));
  };
  rulerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.tl2-seg')) return;
    dragState = { kind: 'head' };
    seekAt(e);
    const move = (ev) => seekAt(ev);
    const up = () => {
      dragState = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const pg = pageAt(currentTime);
      if (pg.index !== (Number(deck().current) || 0)) {
        const p = ctx.getEditor()?.goSlide?.(pg.index);
        if (p && p.then) p.then(() => call('timelineSeek', { time: currentTime }).catch(() => { })).catch(() => { });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  panel.querySelector('[data-act="follow"]').addEventListener('click', (e) => {
    timeline.followPages = timeline.followPages === false;
    e.currentTarget.classList.toggle('is-on', timeline.followPages !== false);
    saveTimeline(true);
  });
  panel.querySelector('[data-act="autoplay"]').addEventListener('click', (e) => {
    timeline.autoplay = timeline.autoplay === false;
    e.currentTarget.classList.toggle('is-on', timeline.autoplay !== false);
    saveTimeline(true);
  });

  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const move = (ev) => {
      const next = clamp(startH + (startY - ev.clientY), 220, Math.min(window.innerHeight - 140, 620));
      document.documentElement.style.setProperty('--tl-h', next + 'px');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTimeout(() => { try { ctx.getEditor()?.refresh?.(); } catch { /* ignore */ } }, 30);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

let fxMenu = null;
function openFxMenu(anchor) {
  if (fxMenu) { fxMenu.remove(); fxMenu = null; return; }
  const menu = h('div', { class: 'tl2-menu' });
  [['flash', '屏闪', 'zap'], ['fly', '飞入元素…', 'move'], ['sweep', '光带', 'arrow-right'], ['shutter', '快门', 'layers'], ['black', '黑场', 'moon'],['ripple','涟漪','circle'],['orbit','星环','sparkles'],['custom','自定义 HTML / SVG…','code']].forEach(([kind, label, iconName]) => {
    const b = h('button', { type: 'button' }, ic(iconName, 14), h('span', {}, label));
    b.addEventListener('click', () => { menu.remove(); fxMenu = null; addOverlay(kind); });
    menu.append(b);
  });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 180, r.left)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
  fxMenu = menu;
  setTimeout(() => {
    const off = (ev) => { if (fxMenu && !fxMenu.contains(ev.target)) { fxMenu.remove(); fxMenu = null; document.removeEventListener('pointerdown', off, true); } };
    document.addEventListener('pointerdown', off, true);
  }, 0);
}

function toggle(next) {
  try { ctx.bus.emit('ui:closeMenus'); } catch { /* ignore */ }
  if (typeof next === 'boolean') open = next;
  else open = !open;
  if (!panel) buildPanel();
  if (open) {
    loadTimeline().then(() => {
      panel.classList.remove('hidden');
      document.getElementById('app')?.classList.add('timeline-open');
      render();
      setTimeout(() => { try { ctx.getEditor()?.refresh?.(); } catch { /* ignore */ } }, 60);
    }).catch((err) => toast('加载时间线失败：' + (err?.message || err), 'error'));
  } else {
    panel.classList.add('hidden');
    document.getElementById('app')?.classList.remove('timeline-open');
    pause();
    setTimeout(() => { try { ctx.getEditor()?.refresh?.(); } catch { /* ignore */ } }, 60);
  }
}

function addToggleButton() {
  const bar = document.getElementById('canvas-toolbar');
  if (!bar || bar.querySelector('[data-act="timeline"]')) return;
  const btn = h('button', { type: 'button', class: 'canvas-tool canvas-tool--label', 'data-act': 'timeline', 'data-tip': '动画时间线（跨页多轨）' },
    ic('film', 15), h('span', {}, '时间线'));
  btn.addEventListener('click', () => toggle());
  bar.append(btn);
}

export async function init(context) {
  ctx = context;
  buildPanel();
  addToggleButton();
  ctx.bus.on('deck:ready', () => { if (open) loadTimeline().then(render).catch(() => { }); });
  ctx.bus.on('timeline:changed',()=>{if(open)loadTimeline().then(render).catch(()=>{});});
  ctx.bus.on('deck:change', async () => {
    if (!open || !timeline || dragState) return;
    const n = pageCount();
    if (!n || timeline.pages.length === n) return;
    ensurePages(timeline);
    (timeline.tracks || []).forEach((tr) => {
      if (!tr.syncPages) return;
      const base = tr.keyframes[0]?.props || { opacity: 1 };
      timeline.pages.forEach((p) => {
        if (!tr.keyframes.some((k) => Math.abs(k.t - p.start) < 20)) {
          tr.keyframes.push({ id: uid('kf'), t: p.start, props: { ...base }, page: p.index });
        }
      });
      tr.keyframes.sort((a, b) => a.t - b.t);
    });
    await saveTimeline(true);
    render();
  });
  ctx.bus.registerCommand('app.toggleTimeline', () => { toggle(); return { ok: true }; });
  ctx.bus.registerCommand('timeline.addSelected', async (payload) => {
    const ok = await addTrackFromSelection(payload || {});
    return ok ? { ok: true } : { ok: false };
  });
  ctx.bus.registerCommand('timeline.addOverlay', async (payload = {}) => { await addOverlay(payload.kind || 'flash'); return { ok: true }; });
  ctx.bus.registerCommand('timeline.play', async () => { await play(); return { ok: true }; });
  ctx.bus.registerCommand('timeline.pause', async () => { await pause(); return { ok: true }; });
  ctx.bus.on('ui:tab', () => { setTimeout(addToggleButton, 80); });
  setTimeout(addToggleButton, 600);
}

export default { init };
