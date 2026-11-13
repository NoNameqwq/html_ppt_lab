/**
 * WebDeck Studio · deck 运行时
 * 由 deck 文件内联（在 fx-presets.js 之后）。负责：舞台缩放、翻页与切换、动效播放、
 * 导入页的 CSS/WAAPI 动效重放、放映 HUD、编辑模式、缩略图模式。
 * 对外暴露 window.__WPX__（bridge 使用）。
 */
(function () {
  'use strict';

  var W = 1920, H = 1080;
  var params = new URLSearchParams(location.search);
  var modeParam = params.get('wpx');
  var mode = modeParam === 'edit' ? 'edit' : modeParam === 'thumb' ? 'thumb' : 'present';
  var thumbSlide = parseInt(params.get('slide') || '0', 10);
  var FX = window.WPX_FX || {};
  var EASES = window.WPX_EASES || {};
  window.WPX_TRANSITIONS = window.WPX_TRANSITIONS || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var easeOf = function (k) { return EASES[k] || (typeof k === 'string' ? k : EASES.expo); };

  var app = null, stage = null, hud = null;
  var slides = [];
  var current = -1;
  var editing = false;
  var busy = false;
  var activeAnims = [];
  var clickQueue = [];
  var autoTimer = null;
  var idleTimer = null;
  var listeners = new Map();
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  /* ---------- 时间线（独立于分页，可跨页） ---------- */
  var timeline = null;
  var timelineAnims = [];
  var timelinePlaying = false;
  var timelineTime = 0;
  var timelineRaf = 0;
  var timelineLast = 0;

  /* ---------- 放映鼠标 / 右键菜单 ---------- */
  var mouseMode = 'advance';   // advance=点击翻页 | anim=只播动画 | off=不响应
  var ctxMenu = null;
  var ctxOff = null;

  /* ---------- 事件 ---------- */
  function on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return function () { listeners.get(evt).delete(fn); };
  }
  function off(evt, fn) { listeners.get(evt) && listeners.get(evt).delete(fn); }
  function emit(evt, data) {
    var set = listeners.get(evt);
    if (!set) return;
    set.forEach(function (fn) { try { fn(data); } catch (e) { console.warn('[WPX] 事件错误', evt, e); } });
  }

  /* ---------- 模型 ---------- */
  function readModel() {
    var node = $('#wpx-data');
    if (!node) return {};
    try { return JSON.parse(node.textContent || '{}'); } catch (e) { return {}; }
  }
  var model = readModel();

  function slideName(i) {
    var s = slides[i];
    if (s && s.dataset.name) return s.dataset.name;
    var m = (model.slides || [])[i];
    return (m && m.name) || ('第 ' + (i + 1) + ' 页');
  }

  /* ---------- 舞台 ---------- */
  function fit() {
    if (!stage) return;
    var s = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.setProperty('--wpx-scale', s);
    stage.style.setProperty('--s', s);
    // 让编辑器的 iframe 铺满时也能正确 letterbox
    document.documentElement.style.setProperty('--wpx-fit', s);
  }

  function applyBgs() {
    slides.forEach(function (s) {
      var bg = s.dataset.bg;
      if (!bg) return;
      var canvas = $('.wpx-canvas', s);
      if (canvas && canvas.style.background && canvas.style.background !== '') return;
      s.style.background = bg;
    });
  }

  /* ---------- 动画 ---------- */
  function parseParams(el) {
    try { return JSON.parse(el.getAttribute('data-wpx-anim-params') || '{}'); } catch (e) { return {}; }
  }

  function clearAnims() {
    activeAnims.forEach(function (a) { try { a.cancel(); } catch (e) { } });
    activeAnims = [];
    clickQueue = [];
    primed = [];
    primedClick = [];
    if (window.WPX_FX_UTIL) {
      slides.forEach(function (s) { window.WPX_FX_UTIL.restoreAll(s); });
    }
  }

  function animCtx(instant) {
    return { instant: !!instant, editing: editing, stage: stage, mode: mode };
  }

  /* ---------- 动画句柄工具：预置首帧 → 播放（避免“先显示终态再跳回首帧”的抽搐） ---------- */
  var primed = [];        // 已创建但暂停在第一帧的动画句柄
  var primedClick = [];   // click 触发：保持暂停，点击时播放

  function eachAnim(handle, fn) {
    if (!handle) return;
    if (handle.anim) { try { fn(handle.anim); } catch (e) { /* ignore */ } }
    if (Array.isArray(handle.parts)) handle.parts.forEach(function (p) { eachAnim(p, fn); });
  }
  function pauseHandle(handle) { eachAnim(handle, function (a) { try { a.pause(); } catch (e) { /* ignore */ } }); }
  function playHandle(handle) {
    eachAnim(handle, function (a) {
      try {
        if (a.playState === 'paused') a.play();
      } catch (e) { /* ignore */ }
    });
  }
  function cancelHandle(handle) { try { handle.cancel(); } catch (e) { /* ignore */ } }

  function playOne(item, instant, opts) {
    opts = opts || {};
    var fx = FX[item.name];
    if (!fx) return null;
    var res = null;
    try { res = fx.play(item.el, item.params, animCtx(instant)); } catch (e) { console.warn('[WPX] 动效失败', item.name, e); }
    if (!res) return null;
    activeAnims.push(res);
    if (opts.prime) { pauseHandle(res); primed.push(res); }
    return res;
  }

  function collectAnims(slideEl) {
    return $$('[data-wpx-anim]', slideEl).filter(function (el) {
      return !el.closest('.wpx-hud');
    }).map(function (el) {
      return {
        el: el,
        name: el.getAttribute('data-wpx-anim'),
        params: parseParams(el),
      };
    });
  }

  function groupAnims(slideEl) {
    var items = collectAnims(slideEl);
    var auto = [], click = [], after = [];
    items.forEach(function (it) {
      var trig = (it.params && it.params.trigger) || 'auto';
      if (trig === 'click') click.push(it);
      else if (trig === 'after') after.push(it);
      else auto.push(it);
    });
    return { items: items, auto: auto, click: click, after: after };
  }

  /** 预置：创建动画但暂停在第一帧（调用时目标页尚未显示） */
  function primeSlideAnims(slideEl) {
    if (!slideEl) return;
    var g = groupAnims(slideEl);
    primedClick = [];
    g.auto.forEach(function (it) { playOne(it, false, { prime: true }); });
    g.after.forEach(function (it) { playOne(it, false, { prime: true }); });
    g.click.forEach(function (it) {
      var res = playOne(it, false, { prime: true });
      primedClick.push({ item: it, res: res });
    });
    clickQueue = primedClick;
    if (g.items.length) emit('animstart', { total: g.items.length });
  }

  /** 释放：让预置动画从第一帧开始播放（同一帧内完成，不闪终态） */
  function releasePrimed() {
    var list = primed;
    primed = [];
    list.forEach(function (h) { playHandle(h); });
  }

  function playSlideAnims(slideEl, instant) {
    if (!slideEl) return;
    primeSlideAnims(slideEl);
    if (!instant) releasePrimed();
  }

  function playNextClickAnim() {
    var entry = clickQueue.shift();
    if (!entry) return false;
    if (entry.res) playHandle(entry.res);
    else if (entry.item) playOne(entry.item, false);
    return true;
  }

  /* ---------- 导入页捕获的 WAAPI 动画重放 ---------- */
  function applyCaptured(slideEl, instant, opts) {
    opts = opts || {};
    if (!slideEl) return;
    var holders = $$('[data-wpx-waapi]', slideEl);
    if (slideEl.hasAttribute && slideEl.hasAttribute('data-wpx-waapi')) holders.unshift(slideEl);
    if (!holders.length) return;
    holders.forEach(function (holder) {
      var records;
      try { records = JSON.parse(holder.getAttribute('data-wpx-waapi') || '[]'); } catch (e) { return; }
      if (!Array.isArray(records)) return;
      records.forEach(function (rec) {
        if (!rec || !rec.keyframes) return;
        var target = null;
        try { target = rec.sel ? holder.querySelector(rec.sel) || slideEl.querySelector(rec.sel) : null; } catch (e) { target = null; }
        if (!target) return;
        var timing = Object.assign({}, rec.timing || {});
        if (timing.iterations === -1) timing.iterations = Infinity;
        if (typeof timing.duration !== 'number') timing.duration = 800;
        timing.fill = 'both';
        if (instant) { timing.duration = 1; timing.delay = 0; timing.iterations = 1; }
        try {
          var a = target.animate(rec.keyframes, timing);
          var handle = {
            anim: a,
            cancel: function () { try { a.cancel(); } catch (e) { /* ignore */ } },
            finished: a.finished ? a.finished.catch(function () { }) : Promise.resolve(),
          };
          if (opts.prime) { a.pause(); primed.push(handle); }
          activeAnims.push(handle);
        } catch (e) { /* 忽略单条失败 */ }
      });
    });
  }

  /* ---------- 原稿转场重放（转换时捕获到 slide 根节点上的 WAAPI 动画） ---------- */
  function readTrRecords(slideEl, which) {
    if (!slideEl) return [];
    var raw = slideEl.getAttribute('data-wpx-tr-' + which);
    if (!raw) return [];
    try {
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function playCapturedTransition(prevEl, nextEl) {
    var inRecs = readTrRecords(nextEl, 'in');
    var outRecs = readTrRecords(prevEl, 'out');
    var duration = parseInt(nextEl.getAttribute('data-wpx-tr-duration') || '0', 10) || 800;
    duration = Math.max(300, Math.min(4000, duration));
    var anims = [];
    function apply(el, recs) {
      if (!el || !recs.length) return;
      recs.forEach(function (rec) {
        if (!rec || !rec.keyframes) return;
        var timing = Object.assign({}, rec.timing || {});
        if (timing.iterations === -1) timing.iterations = Infinity;
        if (typeof timing.duration !== 'number') timing.duration = duration;
        timing.fill = 'both';
        try { anims.push(el.animate(rec.keyframes, timing)); } catch (e) { /* ignore */ }
      });
    }
    nextEl.style.zIndex = '3';
    if (prevEl) prevEl.style.zIndex = '2';
    apply(nextEl, inRecs);
    apply(prevEl, outRecs);
    return new Promise(function (resolve) {
      setTimeout(function () {
        anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* ignore */ } });
        if (prevEl) { prevEl.classList.remove('is-active'); prevEl.style.zIndex = ''; }
        nextEl.style.zIndex = '';
        resolve();
      }, duration + 60);
    });
  }

  /** 完整预览切换：用当前页/下一页的克隆在画布内真实播放（不改当前页） */
  function previewTransition(name, duration) {
    var curEl = slides[current] || null;
    if (!curEl) return Promise.resolve(false);
    var nextEl = slides[current + 1] || slides[current - 1] || curEl;
    var wrap = document.createElement('div');
    wrap.className = 'wpx-tr-preview';
    wrap.style.cssText = 'position:absolute;inset:0;z-index:3;overflow:hidden;pointer-events:none';
    function cloneFor(el) {
      var c = el.cloneNode(true);
      c.classList.add('is-active');
      c.style.cssText = 'position:absolute;inset:0;margin:0;visibility:visible;opacity:1;transform:none;z-index:auto';
      var cv = $('.wpx-canvas', c);
      if (cv) cv.classList.add('live');
      $$('.wpx-hud,.wpx-bridge', c).forEach(function (n) { n.remove(); });
      return c;
    }
    var a = cloneFor(curEl);
    var b = cloneFor(nextEl);
    wrap.appendChild(a);
    wrap.appendChild(b);
    stage.appendChild(wrap);
    var d = duration || 800;
    applyTransitionFx(nextEl, d);
    var custom = customTransitionFor(name);
    var done = custom
      ? Promise.resolve(custom(a, b, { duration: d, editing: false, preview: true }))
      : transitionTo(a, b, name, d);
    return Promise.resolve(done).then(function () {
      setTimeout(function () { wrap.remove(); }, 120);
      return true;
    }).catch(function () {
      wrap.remove();
      return false;
    });
  }

  function customTransitionFor(name) {
    if (!name) return null;
    var key = String(name).replace(/^custom:/, '');
    var reg = window.WPX_TRANSITIONS;
    return reg && typeof reg[key] === 'function' ? reg[key] : null;
  }

  /* ---------- 切换 ---------- */
  function transitionTo(prevEl, nextEl, name, duration) {
    var d = duration || 800;
    var anims = [];
    function A(el, kf, opt) {
      try {
        var a = el.animate(kf, Object.assign({ fill: 'both' }, opt || {}));
        anims.push(a);
        return a;
      } catch (e) { return null; }
    }
    var expo = easeOf('expo');
    var inOut = easeOf('inOut');
    nextEl.style.zIndex = '3';
    if (prevEl) prevEl.style.zIndex = '2';
    var outDur = Math.round(d * 0.75);
    switch (name) {
      case 'flash': {
        var fl = document.createElement('div');
        fl.style.cssText = 'position:absolute;inset:0;z-index:5;background:#fff;opacity:0;pointer-events:none';
        stage.appendChild(fl);
        A(fl, [{ opacity: 0 }, { opacity: 1, offset: 0.22 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: d, easing: inOut });
        if (prevEl) A(prevEl, [{ opacity: 1 }, { opacity: 0 }], { duration: 1, delay: Math.round(d * 0.22) });
        A(nextEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: Math.round(d * 0.6) });
        setTimeout(function () { fl.remove(); }, d + 120);
        break;
      }
      case 'push':
      case 'pushLeft':
        if (prevEl) A(prevEl, [{ transform: 'translateX(0)' }, { transform: 'translateX(-100%)' }], { duration: d, easing: inOut });
        A(nextEl, [{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: d, easing: inOut });
        break;
      case 'pushRight':
        if (prevEl) A(prevEl, [{ transform: 'translateX(0)' }, { transform: 'translateX(100%)' }], { duration: d, easing: inOut });
        A(nextEl, [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }], { duration: d, easing: inOut });
        break;
      case 'pushUp':
        if (prevEl) A(prevEl, [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], { duration: d, easing: inOut });
        A(nextEl, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: d, easing: inOut });
        break;
      case 'pushDown':
        if (prevEl) A(prevEl, [{ transform: 'translateY(0)' }, { transform: 'translateY(100%)' }], { duration: d, easing: inOut });
        A(nextEl, [{ transform: 'translateY(-100%)' }, { transform: 'translateY(0)' }], { duration: d, easing: inOut });
        break;
      case 'zoom':
        if (prevEl) A(prevEl, [{ transform: 'scale(1)', opacity: 1, filter: 'blur(0)' }, { transform: 'scale(1.18)', opacity: 0, filter: 'blur(10px)' }], { duration: outDur, easing: inOut });
        A(nextEl, [{ transform: 'scale(.84)', opacity: 0, filter: 'blur(12px)' }, { transform: 'scale(1)', opacity: 1, filter: 'blur(0)' }], { duration: d, easing: expo });
        break;
      case 'zoomOut':
        if (prevEl) A(prevEl, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.72)', opacity: 0 }], { duration: outDur, easing: inOut });
        A(nextEl, [{ transform: 'scale(1.24)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: d, easing: expo });
        break;
      case 'flipX':
        if (prevEl) A(prevEl, [{ transform: 'perspective(2000px) rotateY(0)', opacity: 1 }, { transform: 'perspective(2000px) rotateY(-88deg)', opacity: 0 }], { duration: outDur, easing: inOut });
        A(nextEl, [{ transform: 'perspective(2000px) rotateY(88deg)', opacity: 0 }, { transform: 'perspective(2000px) rotateY(0)', opacity: 1 }], { duration: d, easing: expo });
        break;
      case 'flipY':
        if (prevEl) A(prevEl, [{ transform: 'perspective(2000px) rotateX(0)', opacity: 1 }, { transform: 'perspective(2000px) rotateX(86deg)', opacity: 0 }], { duration: outDur, easing: inOut });
        A(nextEl, [{ transform: 'perspective(2000px) rotateX(-86deg)', opacity: 0 }, { transform: 'perspective(2000px) rotateX(0)', opacity: 1 }], { duration: d, easing: expo });
        break;
      case 'iris':
        A(nextEl, [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(150% at 50% 50%)' }], { duration: d, easing: expo });
        if (prevEl) A(prevEl, [{ opacity: 1 }, { opacity: 0.4 }], { duration: d, easing: inOut });
        break;
      case 'split':
        A(nextEl, [{ clipPath: 'inset(0 50% 0 50%)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: d, easing: inOut });
        if (prevEl) A(prevEl, [{ opacity: 1 }, { opacity: 0.3 }], { duration: d, easing: inOut });
        break;
      case 'wipeUp':
        A(nextEl, [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: d, easing: expo });
        break;
      case 'wipeDown':
        A(nextEl, [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: d, easing: expo });
        break;
      case 'curtain':
        if (prevEl) A(prevEl, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.94)', opacity: 0 }], { duration: outDur, easing: inOut });
        A(nextEl, [{ clipPath: 'inset(0 0 0 50%)', opacity: 0 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], { duration: d, easing: expo });
        break;
      case 'bars':
      case 'blinds': {
        var bars = document.createElement('div');
        bars.style.cssText = 'position:absolute;inset:0;z-index:4;display:flex;pointer-events:none';
        for (var i = 0; i < 12; i++) {
          var b = document.createElement('i');
          b.style.cssText = 'flex:1;height:100%;background:var(--wpx-accent,#E1402B);transform-origin:top;transform:scaleY(0)';
          bars.appendChild(b);
        }
        stage.appendChild(bars);
        var arr = $$('i', bars);
        arr.forEach(function (b, i2) {
          A(b, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 260, delay: i2 * 22, easing: inOut });
          A(b, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], { duration: 300, delay: 300 + i2 * 20, easing: expo });
        });
        A(nextEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: 320 });
        setTimeout(function () { bars.remove(); }, d + 200);
        break;
      }
      case 'dissolve':
        if (prevEl) A(prevEl, [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(14px)' }], { duration: outDur, easing: inOut });
        A(nextEl, [{ opacity: 0, filter: 'blur(16px)', transform: 'scale(1.02)' }, { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' }], { duration: d, easing: expo });
        break;
      case 'glitch': {
        var kf = [];
        for (var g = 0; g <= 8; g++) kf.push({ transform: 'translateX(' + (Math.random() * 24 - 12) + 'px)', opacity: 1 - g * 0.09, offset: g / 8 });
        if (prevEl) A(prevEl, kf, { duration: Math.min(480, outDur), easing: 'steps(2,end)' });
        A(nextEl, [{ opacity: 0, clipPath: 'inset(46% 0 46% 0)' }, { opacity: 1, clipPath: 'inset(0 0 0 0)' }], { duration: d, delay: 160, easing: expo });
        break;
      }
      case 'slide':
        if (prevEl) A(prevEl, [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-8%)', opacity: 0 }], { duration: outDur, easing: inOut });
        A(nextEl, [{ transform: 'translateY(8%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: d, easing: expo });
        break;
      case 'mosaic': {
        var mcols = 8, mrows = 5;
        var grid = document.createElement('div');
        grid.style.cssText = 'position:absolute;inset:0;z-index:4;display:grid;pointer-events:none;grid-template-columns:repeat(' + mcols + ',1fr);grid-template-rows:repeat(' + mrows + ',1fr)';
        var tiles = [];
        for (var mr = 0; mr < mrows; mr++) {
          for (var mc = 0; mc < mcols; mc++) {
            var tile = document.createElement('i');
            tile.style.cssText = 'background:var(--wpx-accent,#E1402B);transform:scale(0)';
            grid.appendChild(tile);
            tiles.push({ el: tile, c: mc, r: mr });
          }
        }
        stage.appendChild(grid);
        tiles.forEach(function (t) {
          var delay = (t.c + t.r) * 22;
          A(t.el, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 240, delay: delay, easing: inOut });
          A(t.el, [{ transform: 'scale(1)' }, { transform: 'scale(0)' }], { duration: 260, delay: 260 + delay, easing: expo });
        });
        A(nextEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: 300 });
        setTimeout(function () { grid.remove(); }, d + 300);
        break;
      }
      case 'clock': {
        var sweep = document.createElement('div');
        sweep.style.cssText = 'position:absolute;left:50%;top:50%;width:2600px;height:2600px;margin:-1300px 0 0 -1300px;border-radius:50%;z-index:4;pointer-events:none;background:conic-gradient(from -90deg, var(--wpx-accent,#E1402B) 0deg 180deg, transparent 180deg 360deg)';
        stage.appendChild(sweep);
        A(sweep, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(180deg)' }], { duration: d, easing: inOut });
        A(nextEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: Math.round(d * 0.55) });
        setTimeout(function () { sweep.remove(); }, d + 120);
        break;
      }
      case 'fold':
        if (prevEl) A(prevEl, [{ transform: 'perspective(1600px) rotateX(0)', opacity: 1, transformOrigin: 'top' }, { transform: 'perspective(1600px) rotateX(88deg)', opacity: 0, transformOrigin: 'top' }], { duration: outDur, easing: inOut });
        A(nextEl, [{ transform: 'perspective(1600px) rotateX(-88deg)', opacity: 0, transformOrigin: 'top' }, { transform: 'perspective(1600px) rotateX(0)', opacity: 1, transformOrigin: 'top' }], { duration: d, easing: expo });
        break;
      case 'shutter': {
        var sh = document.createElement('div');
        sh.style.cssText = 'position:absolute;inset:0;z-index:4;display:flex;pointer-events:none';
        var shb = [];
        for (var si = 0; si < 14; si++) {
          var sb = document.createElement('i');
          sb.style.cssText = 'flex:1;height:100%;background:var(--wpx-accent,#E1402B);transform-origin:bottom;transform:scaleY(0)';
          sh.appendChild(sb);
          shb.push(sb);
        }
        stage.appendChild(sh);
        shb.forEach(function (b, i3) {
          A(b, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 240, delay: i3 * 18, easing: inOut });
          A(b, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], { duration: 300, delay: 280 + i3 * 16, easing: expo });
        });
        A(nextEl, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: 300 });
        setTimeout(function () { sh.remove(); }, d + 260);
        break;
      }
      case 'fade':
      default:
        if (prevEl) A(prevEl, [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(10px)' }], { duration: outDur, easing: inOut });
        A(nextEl, [{ opacity: 0 }, { opacity: 1 }], { duration: d, easing: expo });
        break;
    }
    return new Promise(function (resolve) {
      setTimeout(function () {
        anims.forEach(function (a) { try { a.cancel(); } catch (e) { } });
        if (prevEl) { prevEl.classList.remove('is-active'); prevEl.style.zIndex = ''; }
        nextEl.style.zIndex = '';
        resolve();
      }, d + 60);
    });
  }

  /* ---------- 转场叠加层：屏闪 / 飞入元素（不属于任何一页，切页时短暂出现在舞台顶层） ---------- */
  function applyTransitionFx(slideEl, duration) {
    var fx = slideEl && (slideEl.dataset.wpxTrFx || slideEl.getAttribute('data-wpx-tr-fx'));
    if (!fx || fx === 'none') return;
    var d = Math.max(240, Number(duration) || 800);
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--wpx-accent') || '#E1402B';
    var wrap = document.createElement('div');
    wrap.className = 'wpx-tr-fx';
    wrap.style.cssText = 'position:absolute;inset:0;z-index:9;pointer-events:none;overflow:hidden';
    var anims = [];
    function A(el, kf, opt) { try { anims.push(el.animate(kf, Object.assign({ fill: 'both' }, opt || {}))); } catch (e) { /* ignore */ } }
    if (fx === 'flash' || fx === 'black' || fx === 'color') {
      var veil = document.createElement('div');
      var bg = fx === 'flash' ? '#fff' : fx === 'black' ? '#000' : accent;
      veil.style.cssText = 'position:absolute;inset:0;background:' + bg + ';opacity:0';
      wrap.appendChild(veil);
      A(veil, [{ opacity: 0 }, { opacity: 0.92, offset: 0.16 }, { opacity: 0.92, offset: 0.42 }, { opacity: 0 }], { duration: Math.round(d * 0.7), delay: Math.round(d * 0.12), easing: 'cubic-bezier(.3,0,.2,1)' });
    } else if (fx === 'fly') {
      for (var i = 0; i < 5; i++) {
        var bar = document.createElement('i');
        var h = 8 + i * 5;
        bar.style.cssText = 'position:absolute;left:-30%;top:' + (18 + i * 15) + '%;width:' + (46 + i * 9) + '%;height:' + h + 'px;background:' + (i % 2 ? accent : 'rgba(255,255,255,.86)') + ';transform:translateX(-40%) skewX(-18deg);opacity:0';
        wrap.appendChild(bar);
        A(bar, [
          { transform: 'translateX(-60%) skewX(-18deg)', opacity: 0 },
          { transform: 'translateX(40%) skewX(-18deg)', opacity: 1, offset: 0.22 },
          { transform: 'translateX(180%) skewX(-18deg)', opacity: 0 },
        ], { duration: Math.round(d * 0.62), delay: i * 34, easing: 'cubic-bezier(.2,.9,.2,1)' });
      }
    } else if (fx === 'sweep') {
      var band = document.createElement('div');
      band.style.cssText = 'position:absolute;top:0;bottom:0;left:-40%;width:32%;background:' + accent + ';filter:blur(2px);opacity:.9';
      wrap.appendChild(band);
      A(band, [{ transform: 'translateX(0) skewX(-12deg)' }, { transform: 'translateX(460%) skewX(-12deg)' }], { duration: Math.round(d * 0.8), delay: Math.round(d * 0.1), easing: 'cubic-bezier(.4,0,.1,1)' });
      var band2 = document.createElement('div');
      band2.style.cssText = 'position:absolute;top:0;bottom:0;left:-40%;width:10%;background:#fff;opacity:.75';
      wrap.appendChild(band2);
      A(band2, [{ transform: 'translateX(0) skewX(-12deg)' }, { transform: 'translateX(1500%) skewX(-12deg)' }], { duration: Math.round(d * 0.8), delay: Math.round(d * 0.16), easing: 'cubic-bezier(.4,0,.1,1)' });
    } else if (fx === 'bars') {
      for (var b2 = 0; b2 < 7; b2++) {
        var line = document.createElement('i');
        line.style.cssText = 'position:absolute;left:0;right:0;top:' + (b2 * 16 + 4) + '%;height:2px;background:rgba(255,255,255,.72);transform:scaleX(0);transform-origin:left';
        wrap.appendChild(line);
        A(line, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }, { transform: 'scaleX(0)', transformOrigin: 'right' }], { duration: Math.round(d * 0.5), delay: b2 * 26, easing: 'cubic-bezier(.3,0,.2,1)' });
      }
    }
    stage.appendChild(wrap);
    setTimeout(function () {
      anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* ignore */ } });
      wrap.remove();
    }, d + 420);
  }


  function buildHud() {
    hud = $('.wpx-hud');
    if (!hud) return;
    hud.innerHTML = '';
    if (mode !== 'present') { hud.style.display = 'none'; return; }
    var prog = document.createElement('div');
    prog.className = 'wpx-progress';
    for (var i = 0; i < slides.length; i++) prog.appendChild(document.createElement('i'));
    var count = document.createElement('div');
    count.className = 'wpx-hud-count';
    var btns = document.createElement('div');
    btns.className = 'wpx-hud-btns';
    var btnPrev = document.createElement('button');
    btnPrev.textContent = 'PREV';
    var btnNext = document.createElement('button');
    btnNext.textContent = 'NEXT';
    var btnFull = document.createElement('button');
    btnFull.textContent = 'FULL';
    var btnReplay = document.createElement('button');
    btnReplay.textContent = 'REPLAY';
    btns.append(btnPrev, btnNext, btnFull, btnReplay);
    var hint = document.createElement('div');
    hint.className = 'wpx-hud-hint';
    hint.textContent = '← → 翻页　空格 下一步　右键 菜单　F 全屏　R 重播';
    hud.append(prog, count, btns, hint);
    btnPrev.onclick = function (e) { e.stopPropagation(); prev(); };
    btnNext.onclick = function (e) { e.stopPropagation(); next(); };
    btnFull.onclick = function (e) { e.stopPropagation(); toggleFullscreen(); };
    btnReplay.onclick = function (e) { e.stopPropagation(); replay(); };
    setTimeout(function () { hint.classList.add('is-hidden'); }, 5200);
    hud.addEventListener('mousemove', function () {
      hud.classList.remove('is-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { hud.classList.add('is-idle'); }, 2600);
    });
    paintHud();
  }

  function paintHud() {
    if (!hud || mode !== 'present') return;
    var bars = $$('.wpx-progress i', hud);
    bars.forEach(function (b, i) {
      b.className = i === current ? 'on cur' : i < current ? 'on' : '';
    });
    var count = $('.wpx-hud-count', hud);
    if (count) count.innerHTML = '<b>' + String(current + 1).padStart(2, '0') + '</b> / ' + String(slides.length).padStart(2, '0');
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () { });
  }

  /* ---------- 元素点击交互（data-wpx-action） ---------- */
  function readMouseMode() {
    var v = document.body.getAttribute('data-wpx-mouse');
    return v === 'anim' || v === 'off' ? v : 'advance';
  }
  function setMouseMode(v) {
    mouseMode = v === 'anim' || v === 'off' ? v : 'advance';
    document.body.setAttribute('data-wpx-mouse', mouseMode);
    return mouseMode;
  }

  function actionLabel(act) {
    var s = String(act || '');
    if (s === 'next') return '下一页';
    if (s === 'prev') return '上一页';
    if (s === 'replay') return '重播动画';
    if (s === 'timeline') return '播放时间线';
    if (s.indexOf('go:') === 0) return '跳到第 ' + s.slice(3) + ' 页';
    if (s.indexOf('url:') === 0) return '打开链接';
    return s;
  }

  function runAction(act, el) {
    var s = String(act || '').trim();
    if (!s) return false;
    if (s === 'next') { next(); return true; }
    if (s === 'prev') { prev(); return true; }
    if (s === 'first') { go(0); return true; }
    if (s === 'last') { go(slides.length - 1); return true; }
    if (s === 'replay') { if (el && el.getAttribute('data-wpx-anim')) playOne({ el: el, name: el.getAttribute('data-wpx-anim'), params: parseParams(el) }, false); else replay(); return true; }
    if (s === 'timeline') { timelinePlaying ? timelinePause() : timelinePlay(); return true; }
    if (s.indexOf('go:') === 0) { var n = parseInt(s.slice(3), 10); if (n >= 1) go(n - 1); return true; }
    if (s.indexOf('url:') === 0) { var url = s.slice(4).trim(); if (url) window.open(url, '_blank', 'noopener'); return true; }
    if (s.indexOf('js:') === 0) { try { (new Function(s.slice(3))).call(window); } catch (e) { console.warn('[WPX] 交互脚本失败', e); } return true; }
    return false;
  }

  /* ---------- 放映右键菜单 ---------- */
  function closeCtx() {
    if (ctxMenu) { try { ctxMenu.remove(); } catch (e) { /* ignore */ } }
    ctxMenu = null;
    if (ctxOff) { try { ctxOff(); } catch (e) { /* ignore */ } ctxOff = null; }
  }

  function ctxItem(label, hint, fn, opts) {
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wpx-ctx-item' + (opts.active ? ' is-active' : '') + (opts.danger ? ' is-danger' : '');
    var main = document.createElement('span');
    main.textContent = label;
    b.appendChild(main);
    if (hint) {
      var k = document.createElement('kbd');
      k.textContent = hint;
      b.appendChild(k);
    }
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeCtx();
      try { fn(); } catch (err) { console.warn('[WPX] 菜单动作失败', err); }
    });
    return b;
  }

  function ctxSep() {
    var s = document.createElement('div');
    s.className = 'wpx-ctx-sep';
    return s;
  }

  function openCtx(x, y, targetEl) {
    closeCtx();
    var menu = document.createElement('div');
    menu.className = 'wpx-ctx';
    menu.setAttribute('role', 'menu');

    var head = document.createElement('div');
    head.className = 'wpx-ctx-head';
    head.innerHTML = '<b>' + String(current + 1).padStart(2, '0') + '</b><span>/ ' + String(slides.length).padStart(2, '0') + '</span><i>' + (slideName(current)).slice(0, 18) + '</i>';
    menu.appendChild(head);

    if (targetEl) {
      var act = targetEl.getAttribute('data-wpx-action');
      if (act) {
        menu.appendChild(ctxItem('触发交互 · ' + actionLabel(act), '', function () { runAction(act, targetEl); }));
        menu.appendChild(ctxSep());
      }
    }

    menu.appendChild(ctxItem('上一页', '←', function () { prev(); }, { active: false }));
    menu.appendChild(ctxItem('下一页', '→', function () { next(); }));

    var grid = document.createElement('div');
    grid.className = 'wpx-ctx-pages';
    slides.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wpx-ctx-page' + (i === current ? ' is-active' : '');
      b.textContent = String(i + 1);
      b.title = slideName(i);
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeCtx(); go(i); });
      grid.appendChild(b);
    });
    menu.appendChild(grid);
    menu.appendChild(ctxSep());

    menu.appendChild(ctxItem('全屏', 'F', function () { toggleFullscreen(); }));
    menu.appendChild(ctxItem('重播本页', 'R', function () { replay(); }));
    if (timeline) {
      menu.appendChild(ctxItem(timelinePlaying ? '暂停时间线' : '播放时间线', 'T', function () { timelinePlaying ? timelinePause() : timelinePlay(); }));
    }
    menu.appendChild(ctxSep());

    var modeRow = document.createElement('div');
    modeRow.className = 'wpx-ctx-row';
    var modeLabel = document.createElement('span');
    modeLabel.className = 'wpx-ctx-label';
    modeLabel.textContent = '左键';
    modeRow.appendChild(modeLabel);
    [['advance', '翻页'], ['anim', '只播动画'], ['off', '不响应']].forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wpx-ctx-chip' + (mouseMode === pair[0] ? ' is-active' : '');
      b.textContent = pair[1];
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        setMouseMode(pair[0]);
        toastHint(pair[0] === 'advance' ? '左键：翻页' : pair[0] === 'anim' ? '左键：只播动画' : '左键：不响应');
        closeCtx();
      });
      modeRow.appendChild(b);
    });
    menu.appendChild(modeRow);

    menu.appendChild(ctxSep());
    menu.appendChild(ctxItem('退出放映', 'Esc', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (window.opener) window.close();
      else toastHint('按 Esc 可退出全屏');
    }, { danger: false }));

    document.body.appendChild(menu);
    var r = menu.getBoundingClientRect();
    var left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 2));
    var top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y + 2));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    ctxMenu = menu;
    var onDoc = function (e) { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtx(); };
    var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeCtx(); } };
    setTimeout(function () {
      document.addEventListener('pointerdown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    ctxOff = function () {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  var hintEl = null, hintTimer = 0;
  function toastHint(text) {
    if (mode !== 'present') return;
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.className = 'wpx-toast';
      document.body.appendChild(hintEl);
    }
    hintEl.textContent = text;
    hintEl.classList.add('is-on');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hintEl.classList.remove('is-on'); }, 1800);
  }

  /* ---------- 翻页 ---------- */
  function setCanvasLive(slideEl, on) {
    if (!slideEl) return;
    var canvas = $('.wpx-canvas', slideEl);
    if (!canvas) return;
    if (on) {
      if (!canvas.classList.contains('live')) {
        canvas.classList.remove('live');
        void canvas.offsetWidth;
        canvas.classList.add('live');
      }
    } else {
      canvas.classList.remove('live');
    }
  }

  function go(index, opts) {
    opts = opts || {};
    if (busy && !opts.force) return Promise.resolve(current);
    if (index < 0) index = 0;
    if (index >= slides.length) index = slides.length - 1;
    if (index === current && !opts.force) return Promise.resolve(current);
    var instant = opts.instant != null ? opts.instant : (editing || mode === 'thumb');
    var prevEl = slides[current];
    var nextEl = slides[index];
    if (!nextEl) return Promise.resolve(current);
    clearAnims();
    var task;

    if (instant || !prevEl) {
      /* 首屏 / 编辑 / 缩略图：直接显示；放映首屏也要先预置首帧再显示，避免抽搐 */
      slides.forEach(function (s) { s.classList.remove('is-active'); });
      if (!instant) {
        setCanvasLive(nextEl, true);
        primeSlideAnims(nextEl);
        applyCaptured(nextEl, false, { prime: true });
        nextEl.classList.add('is-active');
        task = Promise.resolve();
      } else {
        nextEl.classList.add('is-active');
        setCanvasLive(nextEl, true);
        applyCaptured(nextEl, true);
        task = Promise.resolve();
      }
    } else {
      /* 有上一页：先把目标页预置到第一帧（此时尚未显示），再显示并开始转场 */
      busy = true;
      setCanvasLive(nextEl, true);
      primeSlideAnims(nextEl);
      applyCaptured(nextEl, false, { prime: true });
      slides.forEach(function (s, i) { if (i !== current) s.classList.remove('is-active'); });
      nextEl.classList.add('is-active');
      var duration = parseInt(nextEl.dataset.transitionDuration || '800', 10) || 800;
      applyTransitionFx(nextEl, duration);
      var inRecs = readTrRecords(nextEl, 'in');
      var outRecs = readTrRecords(prevEl, 'out');
      var custom = customTransitionFor(nextEl.dataset.transition);
      if (inRecs.length || outRecs.length) {
        task = playCapturedTransition(prevEl, nextEl);
      } else if (custom) {
        task = Promise.resolve()
          .then(function () { return custom(prevEl, nextEl, { duration: duration, stage: stage }); })
          .catch(function (e) { console.warn('[WPX] 自定义转场失败', e); })
          .then(function () {
            if (prevEl) { prevEl.classList.remove('is-active'); prevEl.style.zIndex = ''; }
            nextEl.style.zIndex = '';
          });
      } else {
        task = transitionTo(prevEl, nextEl, nextEl.dataset.transition || 'fade', duration);
      }
      task = task.then(function () { busy = false; });
    }

    current = index;
    if (timeline) {
      if (timeline.followPages !== false) {
        try { applyTimelineTime(timelinePageStart(index)); } catch (e) { /* ignore */ }
      }
      if (mode === 'present' && timeline.autoplay !== false && (timeline.tracks || []).length && !timelinePlaying) {
        try { timelinePlay(); } catch (e) { /* ignore */ }
      }
    }
    /* 目标页已显示：释放预置动画（从第一帧开始播放，不闪终态） */
    releasePrimed();
    return task.then(function () {
      slides.forEach(function (s, i) { if (i !== index) setCanvasLive(s, false); });
      paintHud();
      emit('slidechange', { index: current });
      return current;
    });
  }

  function next() {
    if (busy) return;
    if (mode === 'present' && playNextClickAnim()) return;
    if (current < slides.length - 1) go(current + 1);
  }
  function prev() {
    if (busy) return;
    if (current > 0) go(current - 1);
  }
  function replay() {
    var slide = slides[current];
    if (!slide) return;
    clearAnims();
    var wasEditing = editing;
    if (wasEditing) document.body.classList.remove('wpx-editing');
    setCanvasLive(slide, false);
    void slide.offsetWidth;
    // 预置首帧 → 显示 → 释放播放，避免重播时先闪终态
    primeSlideAnims(slide);
    applyCaptured(slide, false, { prime: true });
    setCanvasLive(slide, true);
    releasePrimed();
    if (wasEditing) {
      setTimeout(function () { if (editing) document.body.classList.add('wpx-editing'); }, 2200);
    }
  }

  function setEditing(v) {
    editing = !!v;
    document.body.classList.toggle('wpx-editing', editing);
    if (editing) {
      clearAnims();
      if (slides[current]) applyCaptured(slides[current], true);
    } else if (slides[current]) {
      clearAnims();
      applyCaptured(slides[current], false);
    }
    emit('editing', { editing: editing });
  }

  /* ---------- 输入 ---------- */
  function bindInput() {
    if (mode === 'present') {
      window.addEventListener('keydown', function (e) {
        if (e.target && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
        var k = e.key;
        if (k === 'ArrowRight' || k === 'ArrowDown' || k === ' ' || k === 'PageDown' || k === 'Enter') { e.preventDefault(); next(); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); prev(); }
        else if (k === 'Home') { e.preventDefault(); go(0); }
        else if (k === 'End') { e.preventDefault(); go(slides.length - 1); }
        else if (k === 'f' || k === 'F') { toggleFullscreen(); }
        else if (k === 'r' || k === 'R') { replay(); }
        else if (k === 't' || k === 'T') { if (timeline) { timelinePlaying ? timelinePause() : timelinePlay(); } }
        else if (k === 'a' || k === 'A') {
          if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
          else autoTimer = setInterval(function () { if (current < slides.length - 1) next(); }, 6000);
        }
      });
      app.addEventListener('click', function (e) {
        if (e.button && e.button !== 0) return;
        if (e.target.closest && e.target.closest('.wpx-hud-btns,.wpx-ctx')) return;
        var actEl = e.target.closest && e.target.closest('[data-wpx-action]');
        if (actEl) {
          var act = actEl.getAttribute('data-wpx-action');
          if (act && runAction(act, actEl)) { e.preventDefault(); return; }
        }
        if (mouseMode === 'off') return;
        if (playNextClickAnim()) return;
        if (mouseMode === 'anim') return;
        next();
      });
      /* 右键：一定是自己的菜单，绝不是网页默认菜单 */
      document.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        if (mode !== 'present') return;
        var el = e.target && e.target.closest ? e.target.closest('[data-wpx-el]') : null;
        openCtx(e.clientX, e.clientY, el);
      }, true);
      var wheelLock = false;
      window.addEventListener('wheel', function (e) {
        if (mouseMode === 'off') return;
        if (wheelLock || Math.abs(e.deltaY) < 24) return;
        wheelLock = true;
        setTimeout(function () { wheelLock = false; }, 520);
        if (e.deltaY > 0) next(); else prev();
      }, { passive: true });
      var touchX = 0, touchY = 0;
      window.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
      window.addEventListener('touchend', function (e) {
        var dx = e.changedTouches[0].clientX - touchX;
        var dy = e.changedTouches[0].clientY - touchY;
        if (Math.abs(dx) > 50 || Math.abs(dy) > 50) { if (Math.abs(dx) > Math.abs(dy)) { dx < 0 ? next() : prev(); } else { dy < 0 ? next() : prev(); } }
      }, { passive: true });
      window.addEventListener('hashchange', function () {
        var h = parseInt((location.hash || '').replace('#', ''), 10);
        if (!isNaN(h) && h >= 1 && h <= slides.length && h - 1 !== current) go(h - 1);
      });
    }
  }

  /* ---------- 对外 API ---------- */
  function getState() {
    var rect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: W, height: H };
    return {
      mode: mode,
      current: current,
      total: slides.length,
      w: W, h: H,
      editing: editing,
      mouseMode: mouseMode,
      slides: slides.map(function (s, i) {
        return {
          index: i,
          id: s.dataset.id || ('s' + (i + 1)),
          name: slideName(i),
          transition: s.dataset.transition || 'fade',
          transitionFx: s.dataset.wpxTrFx || 'none',
          duration: parseInt(s.dataset.transitionDuration || '800', 10),
        };
      }),
      stage: { left: rect.left, top: rect.top, width: rect.width, height: rect.height, scale: rect.width / W },
      model: model,
    };
  }

  function injectThumbStyle() {
    var st = document.createElement('style');
    st.id = 'wpx-thumb-force';
    st.textContent = '*,*::before,*::after{animation-duration:.001s!important;animation-delay:0s!important;animation-iteration-count:1!important;animation-fill-mode:both!important;transition:none!important}';
    document.head.appendChild(st);
  }

  /** 幻灯片结构变化后重建索引（bridge 增删页后调用） */
  function refresh() {
    slides = $$('.wpx-slide', stage);
    if (current >= slides.length) current = slides.length - 1;
    if (current < 0) current = 0;
    applyBgs();
    buildHud();
    fit();
    slides.forEach(function (s, i) { s.classList.toggle('is-active', i === current); });
    var activeCanvas = slides[current] ? $('.wpx-canvas', slides[current]) : null;
    if (activeCanvas) activeCanvas.classList.add('live');
    paintHud();
    buildTimelineAnimations();
    return getState();
  }

  function init() {
    app = $('#wpx-app');
    stage = $('#wpx-stage');
    if (!app || !stage) { readyResolve(); return; }
    slides = $$('.wpx-slide', stage);
    document.body.classList.add('wpx-mode-' + mode);
    mouseMode = readMouseMode();
    document.body.setAttribute('data-wpx-mouse', mouseMode);
    if (mode === 'edit') { editing = true; document.body.classList.add('wpx-editing'); }
    if (mode === 'thumb') injectThumbStyle();
    applyBgs();
    fit();
    window.addEventListener('resize', fit);
    buildHud();
    bindInput();
    var start = 0;
    if (mode === 'thumb') start = isNaN(thumbSlide) ? 0 : Math.max(0, Math.min(slides.length - 1, thumbSlide));
    else {
      var h = parseInt((location.hash || '').replace('#', ''), 10);
      if (!isNaN(h) && h >= 1 && h <= slides.length) start = h - 1;
    }
    current = -1;
    go(start, { instant: mode !== 'present', force: true }).then(function () {
      buildTimelineAnimations();
      if (mode === 'present' && timeline && timeline.autoplay !== false && (timeline.tracks || []).length) {
        applyTimelineTime(timelinePageStart(current));
        timelinePlay();
      }
      readyResolve();
      emit('ready', { mode: mode, state: getState() });
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit).catch(function () { });
  }

  /* ---------- 时间线 ---------- */
  function readTimeline() {
    var node = document.getElementById('wpx-timeline');
    if (!node) return null;
    try { return JSON.parse(node.textContent || 'null'); } catch (e) { return null; }
  }

  function timelinePageStart(index) {
    if (!timeline) return 0;
    var pages = Array.isArray(timeline.pages) ? timeline.pages : [];
    var p = pages[index];
    if (p && Number(p.start) >= 0) return Number(p.start) || 0;
    var pageDuration = Number(timeline.pageDuration) || 1000;
    return Math.max(0, index * pageDuration);
  }

  function frameFromProps(props, useTransform) {
    props = props || {};
    var frame = {};
    if (props.opacity != null) frame.opacity = Number(props.opacity);
    if (props.transform) {
      frame.transform = String(props.transform);
    } else if (useTransform) {
      var any = props.x != null || props.y != null || props.scale != null || props.rotate != null;
      if (any) frame.transform = 'translate(' + (Number(props.x) || 0) + 'px,' + (Number(props.y) || 0) + 'px) rotate(' + (Number(props.rotate) || 0) + 'deg) scale(' + (props.scale == null ? 1 : Number(props.scale)) + ')';
    } else {
      /* 独立属性：和元素自身的 transform 叠加，不互相覆盖（每页移动图层就靠这个） */
      if (props.x != null || props.y != null) frame.translate = (Number(props.x) || 0) + 'px ' + (Number(props.y) || 0) + 'px';
      if (props.scale != null) frame.scale = String(Number(props.scale) || 1);
      if (props.rotate != null) frame.rotate = (Number(props.rotate) || 0) + 'deg';
    }
    if (props.filter) frame.filter = String(props.filter);
    else {
      var parts = [];
      if (props.blur != null) parts.push('blur(' + Number(props.blur) + 'px)');
      if (props.brightness != null) parts.push('brightness(' + Number(props.brightness) + ')');
      if (props.saturate != null) parts.push('saturate(' + Number(props.saturate) + ')');
      if (props.hue != null) parts.push('hue-rotate(' + Number(props.hue) + 'deg)');
      if (parts.length) frame.filter = parts.join(' ');
    }
    if (props.clipPath) frame.clipPath = String(props.clipPath);
    return frame;
  }

  /** 关键帧帧集合补齐：不同帧属性不一致会让 WAAPI 报错，用前值/默认值填满 */
  function buildFrames(kfs, total, trackEasing) {
    var list = kfs.slice().sort(function (a, b) { return (Number(a.t) || 0) - (Number(b.t) || 0); });
    if (!list.length) return null;
    var useTransform = list.some(function (k) { return k && k.props && k.props.transform; });
    var keys = {};
    list.forEach(function (k) {
      var f = frameFromProps(k.props, useTransform);
      k.__frame = f;
      Object.keys(f).forEach(function (key) { keys[key] = true; });
    });
    var defaults = { opacity: 1, transform: 'none', filter: 'none', clipPath: 'none', translate: '0px 0px', scale: '1', rotate: '0deg' };
    var frames = list.map(function (k) {
      var f = { offset: Math.max(0, Math.min(1, (Number(k.t) || 0) / total)) };
      Object.keys(keys).forEach(function (key) {
        f[key] = k.__frame[key] != null ? k.__frame[key] : defaults[key];
      });
      f.easing = k.easing || trackEasing || 'linear';
      return f;
    });
    if (frames[0].offset > 0) {
      var head = Object.assign({}, frames[0]);
      head.offset = 0;
      frames.unshift(head);
    }
    if (frames[frames.length - 1].offset < 1) {
      var tail = Object.assign({}, frames[frames.length - 1]);
      tail.offset = 1;
      frames.push(tail);
    }
    return frames;
  }

  function buildTimelineAnimations() {
    timelineAnims.forEach(function (a) { try { a.anim.cancel(); } catch (e) { /* ignore */ } });
    timelineAnims = [];
    timeline = readTimeline();
    if (!timeline || !Array.isArray(timeline.tracks)) return;
    var total = Number(timeline.duration) || 8000;
    timeline.tracks.forEach(function (track) {
      if (!track || track.hidden || !track.selector) return;
      var targets = [];
      try { targets = $$(track.selector); } catch (e) { targets = []; }
      if (!targets.length) return;
      var frames = buildFrames(track.keyframes || [], total, track.easing);
      if (!frames) return;
      targets.forEach(function (el) {
        try {
          var anim = el.animate(frames, { duration: total, fill: 'both', easing: 'linear' });
          anim.pause();
          anim.currentTime = timelineTime;
          timelineAnims.push({ track: track, el: el, anim: anim });
        } catch (e) { /* ignore */ }
      });
    });
    applyTimelineTime(timelineTime);
  }

  function applyTimelineTime(t) {
    var total = timeline ? (Number(timeline.duration) || 0) : 0;
    timelineTime = Math.max(0, Math.min(total, Number(t) || 0));
    timelineAnims.forEach(function (a) { try { a.anim.currentTime = timelineTime; } catch (e) { /* ignore */ } });
    emit('timeline', { playing: timelinePlaying, time: timelineTime, duration: total });
    return timelineTime;
  }

  function timelineTick(now) {
    if (!timelinePlaying) return;
    var dt = Math.max(0, now - timelineLast);
    timelineLast = now;
    var total = timeline ? (Number(timeline.duration) || 0) : 0;
    applyTimelineTime(timelineTime + dt);
    if (timelineTime >= total) {
      if (timeline && timeline.loop) applyTimelineTime(0);
      else { timelinePlaying = false; emit('timeline', { playing: false, time: timelineTime, duration: total }); return; }
    }
    timelineRaf = requestAnimationFrame(timelineTick);
  }

  function timelinePlay() {
    if (!timeline) buildTimelineAnimations();
    if (!timeline) return { ok: false, error: '没有时间线' };
    timelinePlaying = true;
    timelineLast = performance.now();
    cancelAnimationFrame(timelineRaf);
    timelineRaf = requestAnimationFrame(timelineTick);
    emit('timeline', { playing: true, time: timelineTime, duration: Number(timeline.duration) || 0 });
    return { ok: true };
  }

  function timelinePause() {
    timelinePlaying = false;
    cancelAnimationFrame(timelineRaf);
    emit('timeline', { playing: false, time: timelineTime, duration: timeline ? (Number(timeline.duration) || 0) : 0 });
    return { ok: true, time: timelineTime };
  }

  function timelineSeek(t) {
    applyTimelineTime(t);
    return { ok: true, time: timelineTime };
  }

  function setTimelineData(data) {
    timeline = data || null;
    buildTimelineAnimations();
    applyTimelineTime(0);
    return { ok: true };
  }

  function getTimelineData() {
    return timeline ? JSON.parse(JSON.stringify(timeline)) : null;
  }

  window.__WPX__ = {
    version: '1.0',
    ready: ready,
    mode: mode,
    init: init,
    getState: getState,
    go: go,
    next: next,
    prev: prev,
    replay: replay,
    setEditing: setEditing,
    playAnimations: function (idx) {
      if (idx != null && idx !== current) return go(idx, { instant: true }).then(function () { replay(); });
      replay();
    },
    stopAnimations: clearAnims,
    on: on,
    off: off,
    getSlideEl: function (i) { return slides[i] || null; },
    getCanvasEl: function (i) { var s = slides[i]; return s ? $('.wpx-canvas', s) : null; },
    applyWaapi: applyCaptured,
    refresh: refresh,
    /** 注册自定义转场（Agent / 用户 JS 可调用）：fn(outEl, inEl, ctx) → Promise|void */
    registerTransition: function (name, fn) {
      if (!name || typeof fn !== 'function') return { ok: false };
      window.WPX_TRANSITIONS = window.WPX_TRANSITIONS || {};
      window.WPX_TRANSITIONS[String(name)] = fn;
      return { ok: true, name: String(name) };
    },
    listTransitions: function () {
      return Object.keys(window.WPX_TRANSITIONS || {});
    },
    previewTransition: previewTransition,
    getTimeline: getTimelineData,
    setTimeline: setTimelineData,
    timelinePlay: timelinePlay,
    timelinePause: timelinePause,
    timelineSeek: timelineSeek,
    timelineRefresh: buildTimelineAnimations,
    timelineGetState: function () {
      return { playing: timelinePlaying, time: timelineTime, duration: timeline ? (Number(timeline.duration) || 0) : 0, hasTimeline: !!timeline };
    },
    runAction: runAction,
    setMouseMode: setMouseMode,
    setTransition: function (i, name) { if (slides[i]) slides[i].dataset.transition = name; },
    serializeState: function () { return { mode: mode, current: current, model: model }; },
    setDeckFlags: function (flags) {
      if (!flags) return;
      if (flags.grain != null) document.body.dataset.wpxGrain = flags.grain ? 'on' : 'off';
      if (flags.vignette != null) document.body.dataset.wpxVignette = flags.vignette ? 'on' : 'off';
      if (flags.clickAdvance != null) document.body.dataset.wpxClickAdvance = flags.clickAdvance ? 'on' : 'off';
      if (flags.mouseMode) setMouseMode(flags.mouseMode);
    },
    getMouseMode: function () { return mouseMode; },
    setMouseMode: setMouseMode,
    getTimelineColors: function () { return { accent: getComputedStyle(document.documentElement).getPropertyValue('--wpx-accent') || '#E1402B' }; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
