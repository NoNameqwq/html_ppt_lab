/**
 * WebDeck Studio · 动效预设库
 * window.WPX_FX        { name: {cat,label,desc,params,chars?,play(el,params,ctx)} }
 * window.WPX_FX_CATALOG [{id,label,items:[{name,label,desc,defaults}]}]
 * 以经典脚本形式提供（既被内联进 deck，也被编辑器 UI 以 <script> 加载）。
 */
(function (global) {
  'use strict';

  /* ---------- 缓动 ---------- */
  function springEase(zeta, cycles, n) {
    n = n || 60; cycles = cycles || 1.1; zeta = zeta || 0.34;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = i === n ? 1 : 1 - Math.exp(-zeta * 7.5 * t) * Math.cos(cycles * Math.PI * 2 * t);
      pts.push(y.toFixed(4) + (i === 0 ? '' : ' ' + (t * 100).toFixed(1) + '%'));
    }
    return 'linear(' + pts.join(',') + ')';
  }

  const EASES = {
    expo: 'cubic-bezier(.16,1,.3,1)',
    smooth: 'cubic-bezier(.22,.9,.24,1)',
    inOut: 'cubic-bezier(.7,0,.2,1)',
    back: 'cubic-bezier(.34,1.56,.64,1)',
    spring: springEase(0.32, 1.15),
    soft: 'cubic-bezier(.33,1,.68,1)',
    linear: 'linear',
    steps: 'steps(4,end)',
  };

  const DEFAULT_PARAMS = {
    delay: 0, duration: 900, easing: 'expo', trigger: 'auto', loop: false,
    distance: 56, stagger: 60, direction: 'up', intensity: 1,
  };

  function merge(params) {
    return Object.assign({}, DEFAULT_PARAMS, params || {});
  }
  function ease(name) { return EASES[name] || name || EASES.expo; }

  /* ---------- 字符拆分 ---------- */
  const SPLIT_STATE = new WeakMap();

  function splitChars(el) {
    if (SPLIT_STATE.has(el)) return SPLIT_STATE.get(el).spans;
    if (el.children.length) return [el];
    const text = el.textContent || '';
    if (!text.trim()) return [el];
    const html = el.innerHTML;
    const spans = [];
    el.textContent = '';
    for (const ch of Array.from(text)) {
      const s = document.createElement('span');
      s.textContent = ch === ' ' ? '\u00A0' : ch;
      s.style.display = 'inline-block';
      s.style.willChange = 'transform,opacity,filter';
      s.style.transformOrigin = '50% 100%';
      el.appendChild(s);
      spans.push(s);
    }
    SPLIT_STATE.set(el, { spans, html });
    return spans;
  }

  function restoreChars(el) {
    const st = SPLIT_STATE.get(el);
    if (!st) return;
    try { el.innerHTML = st.html; } catch { /* ignore */ }
    SPLIT_STATE.delete(el);
  }

  function restoreAll(root) {
    if (!root) return;
    if (SPLIT_STATE.has(root)) restoreChars(root);
    root.querySelectorAll && root.querySelectorAll('*').forEach((n) => {
      if (SPLIT_STATE.has(n)) restoreChars(n);
    });
  }

  /* ---------- 动画执行 ---------- */
  function run(el, keyframes, options, ctx) {
    const opt = Object.assign({ fill: 'both' }, options);
    if (ctx && ctx.instant) {
      opt.duration = 1;
      opt.delay = 0;
      opt.iterations = 1;
      opt.fill = 'both';
    }
    try {
      const anim = el.animate(keyframes, opt);
      const finished = anim.finished ? anim.finished.catch(() => { }) : Promise.resolve();
      return {
        cancel() { try { anim.cancel(); } catch { /* ignore */ } },
        anim,
        finished,
      };
    } catch (err) {
      console.warn('[WPX_FX] animate 失败', err);
      return { cancel() { }, anim: null, finished: Promise.resolve() };
    }
  }

  function combo(parts, ctx, after) {
    const list = parts.filter(Boolean);
    const finished = Promise.all(list.map((p) => p.finished)).then(() => { if (after) after(); });
    return {
      cancel() { list.forEach((p) => p.cancel()); if (after) after(); },
      finished,
      parts: list,
    };
  }

  /* ---------- 预设 ---------- */
  const FX = {};

  function def(name, cat, label, desc, fn, extra) {
    FX[name] = Object.assign({ name, cat, label, desc, play: fn }, extra || {});
  }

  const dirs = {
    up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  };

  /* ===== 文字类（元素级） ===== */
  def('fadeIn', 'text', '淡入', '最简单的出现方式，适合次要信息', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ opacity: 0 }, { opacity: 1 }], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('fadeUp', 'text', '上浮淡入', '从下方浮起并淡入，最常用的入场', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'translateY(' + p.distance + 'px)', filter: 'blur(6px)' },
      { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('fadeDown', 'text', '下落淡入', '从上方落下，适合标题', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'translateY(-' + p.distance + 'px)', filter: 'blur(6px)' },
      { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('slideInLeft', 'text', '左侧滑入', '从左侧进入，适合分栏内容', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'translateX(-' + (p.distance * 2.4) + 'px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('slideInRight', 'text', '右侧滑入', '从右侧进入，与左入形成对位', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'translateX(' + (p.distance * 2.4) + 'px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('zoomIn', 'text', '放大入场', '由小到大，强调视觉焦点', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'scale(.86)' },
      { opacity: 1, transform: 'scale(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('zoomOutIn', 'text', '缩小入场', '由大到小落定，更有气势', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'scale(1.22)' },
      { opacity: 1, transform: 'scale(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('blurIn', 'text', '模糊成像', '从模糊到清晰，克制而高级', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, filter: 'blur(' + (14 * p.intensity) + 'px)', transform: 'scale(1.04)' },
      { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('springPop', 'text', '弹簧弹入', '带回弹的弹性入场，活泼', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'scale(.4) rotate(-6deg)' },
      { opacity: 1, transform: 'scale(1) rotate(0deg)' },
    ], { duration: p.duration, delay: p.delay, easing: ease('spring') }, ctx);
  });

  def('rotateIn', 'text', '旋转落位', '旋转归位，适合图标与小标题', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'rotate(-120deg) scale(.4)' },
      { opacity: 1, transform: 'rotate(0deg) scale(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease('back') }, ctx);
  });

  def('flipInX', 'text', '绕轴翻入', '3D 翻转进入，空间感强', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'perspective(1200px) rotateX(-88deg)' },
      { opacity: 1, transform: 'perspective(1200px) rotateX(0deg)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('clipUp', 'text', '遮罩升行', '内容从下方遮罩中升起', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { clipPath: 'inset(100% 0 0 0)', opacity: 0 },
      { clipPath: 'inset(0% 0 0 0)', opacity: 1 },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('clipWipe', 'text', '渐变擦除', '从左到右擦出内容', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { clipPath: 'inset(0 100% 0 0)' },
      { clipPath: 'inset(0 -1% 0 0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('lineMask', 'text', '整行遮罩', '整行从遮罩中推上来，适合大标题', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { clipPath: 'inset(0 0 100% 0)', transform: 'translateY(18%)' },
      { clipPath: 'inset(0 0 0% 0)', transform: 'translateY(0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('charDrop', 'text', '逐字下落', '逐字错峰落下，节奏感强', (el, params, ctx) => {
    const p = merge(params);
    if (ctx && ctx.instant) return run(el, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 }, ctx);
    const spans = splitChars(el);
    const parts = spans.map((s, i) => run(s, [
      { opacity: 0, transform: 'translateY(-' + (p.distance * 3) + 'px)', filter: 'blur(8px)' },
      { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' },
    ], { duration: p.duration, delay: p.delay + i * p.stagger, easing: ease('spring') }, ctx));
    return combo(parts, ctx, () => restoreChars(el));
  }, { chars: true });

  def('charStagger', 'text', '逐字放大', '逐字放大落位，适合短标题', (el, params, ctx) => {
    const p = merge(params);
    if (ctx && ctx.instant) return run(el, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 }, ctx);
    const spans = splitChars(el);
    const parts = spans.map((s, i) => run(s, [
      { opacity: 0, transform: 'scale(2.2)', filter: 'blur(10px)' },
      { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
    ], { duration: p.duration, delay: p.delay + i * p.stagger, easing: ease(p.easing) }, ctx));
    return combo(parts, ctx, () => restoreChars(el));
  }, { chars: true });

  def('typewriter', 'text', '打字机', '逐字出现 + 光标闪烁', (el, params, ctx) => {
    const p = merge(params);
    if (ctx && ctx.instant) return run(el, [{ opacity: 1 }, { opacity: 1 }], { duration: 1 }, ctx);
    const spans = splitChars(el);
    const parts = spans.map((s, i) => {
      s.style.opacity = '0';
      return run(s, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: p.delay + i * Math.max(40, p.stagger), easing: 'steps(1,end)' }, ctx);
    });
    const caret = document.createElement('span');
    caret.className = 'wpx-caret';
    caret.textContent = '|';
    caret.style.cssText = 'display:inline-block;width:2px;margin-left:4px;color:var(--wpx-accent,#E1402B);font-weight:300;animation:wpxCaret .7s steps(1) infinite';
    el.appendChild(caret);
    return combo(parts, ctx, () => { try { caret.remove(); } catch { } restoreChars(el); });
  }, { chars: true });

  def('trackingIn', 'text', '字距收拢', '字距从松到紧，气质开场', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { letterSpacing: (p.distance * 2.4) + 'px', opacity: 0 },
      { letterSpacing: '0px', opacity: 1 },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('strokeFill', 'text', '描边转实心', '描边字逐渐填充为实心', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { color: 'rgba(0,0,0,0)', webkitTextStroke: '1.5px currentColor', transform: 'scale(1.03)' },
      { color: 'inherit', webkitTextStroke: '0px currentColor', transform: 'scale(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('blockReveal', 'text', '色块揭示', '色块滑过，文字被揭示', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { clipPath: 'inset(0 100% 0 0)' },
      { clipPath: 'inset(0 0% 0 0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  /* ===== 形状类 ===== */
  def('shapeSpring', 'shape', '形状弹入', '弹性缩放出现，适合色块/卡片', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'scale(.2) rotate(-10deg)' },
      { opacity: 1, transform: 'scale(1) rotate(0)' },
    ], { duration: p.duration, delay: p.delay, easing: ease('spring') }, ctx);
  });

  def('shapeRotate', 'shape', '形状旋入', '旋转进入，适合装饰元素', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'rotate(180deg) scale(.4)' },
      { opacity: 1, transform: 'rotate(0deg) scale(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease('back') }, ctx);
  });

  def('shapeWipe', 'shape', '斜切揭示', '对角线扫开，适合图片/色块', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { clipPath: 'polygon(0 0, 0 0, 0 100%, 0 100%)' },
      { clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('shapeFlip', 'shape', '翻转卡片', '3D 翻转出现', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { opacity: 0, transform: 'perspective(1200px) rotateY(92deg)' },
      { opacity: 1, transform: 'perspective(1200px) rotateY(0deg)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('shapeBounce', 'shape', '弹跳落位', '多次衰减的落地弹跳', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { transform: 'translateY(-' + (p.distance * 4) + 'px)', opacity: 0, offset: 0, easing: 'cubic-bezier(.5,0,.9,.4)' },
      { transform: 'translateY(0)', opacity: 1, offset: 0.45, easing: 'cubic-bezier(.3,.6,.5,1)' },
      { transform: 'translateY(-' + (p.distance * 0.7) + 'px)', offset: 0.62, easing: 'cubic-bezier(.5,0,.9,.4)' },
      { transform: 'translateY(0)', offset: 0.78, easing: 'cubic-bezier(.3,.6,.5,1)' },
      { transform: 'translateY(-' + (p.distance * 0.24) + 'px)', offset: 0.9 },
      { transform: 'translateY(0)', offset: 1 },
    ], { duration: p.duration * 1.4, delay: p.delay }, ctx);
  });

  /* ===== 循环/强调 ===== */
  def('pulse', 'loop', '脉冲', '轻微缩放呼吸，提示重点', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { transform: 'scale(1)' }, { transform: 'scale(' + (1 + 0.045 * p.intensity) + ')' }, { transform: 'scale(1)' },
    ], { duration: p.duration * 1.6, delay: p.delay, iterations: Infinity, easing: ease('inOut') }, ctx);
  });

  def('breathe', 'loop', '呼吸', '透明度起伏，安静不抢戏', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ opacity: 0.55 }, { opacity: 1 }, { opacity: 0.55 }],
      { duration: p.duration * 2.4, delay: p.delay, iterations: Infinity, easing: ease('inOut') }, ctx);
  });

  def('shake', 'loop', '抖动', '短促抖动，表达强调/警示', (el, params, ctx) => {
    const p = merge(params);
    const k = [];
    for (let i = 0; i <= 8; i++) {
      k.push({ transform: 'translate(' + ((i % 2 ? 1 : -1) * 4 * p.intensity) + 'px,' + ((i % 3 ? 1 : -1) * 2 * p.intensity) + 'px)', offset: i / 8 });
    }
    return run(el, k, { duration: p.duration, delay: p.delay, iterations: Infinity, easing: 'steps(2,end)' }, ctx);
  });

  def('swing', 'loop', '摆动', '轻微摆动，适合标签/挂饰', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ transform: 'rotate(-2.4deg)' }, { transform: 'rotate(2.4deg)' }],
      { duration: p.duration, delay: p.delay, iterations: Infinity, direction: 'alternate', easing: ease('inOut') }, ctx);
  });

  def('floatY', 'loop', '浮动', '上下漂浮，增加呼吸感', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ transform: 'translateY(0)' }, { transform: 'translateY(-' + (10 * p.intensity) + 'px)' }],
      { duration: p.duration, delay: p.delay, iterations: Infinity, direction: 'alternate', easing: ease('inOut') }, ctx);
  });

  def('marqueeX', 'loop', '横向循环', '水平缓慢移动，适合装饰带', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ transform: 'translateX(0)' }, { transform: 'translateX(-' + (p.distance * 2) + 'px)' }],
      { duration: p.duration * 3, delay: p.delay, iterations: Infinity, easing: 'linear' }, ctx);
  });

  def('hueFlow', 'loop', '色相流动', '色相缓慢旋转，适合氛围图形', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ filter: 'hue-rotate(0deg)' }, { filter: 'hue-rotate(360deg)' }],
      { duration: p.duration * 4, delay: p.delay, iterations: Infinity, easing: 'linear' }, ctx);
  });

  def('glowPulse', 'loop', '光晕呼吸', '发光强度起伏，适合深色背景', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { filter: 'drop-shadow(0 0 0 rgba(225,64,43,0))' },
      { filter: 'drop-shadow(0 0 ' + (26 * p.intensity) + 'px rgba(225,64,43,.85))' },
      { filter: 'drop-shadow(0 0 0 rgba(225,64,43,0))' },
    ], { duration: p.duration * 1.8, delay: p.delay, iterations: Infinity, easing: ease('inOut') }, ctx);
  });

  /* ===== 强调（一次性） ===== */
  def('underlineGrow', 'emphasis', '下划线展开', '细线从左侧展开，适合标题强调', (el, params, ctx) => {
    const p = merge(params);
    const before = el.style.cssText;
    el.style.backgroundImage = 'linear-gradient(var(--wpx-accent,#E1402B),var(--wpx-accent,#E1402B))';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundPosition = '0 100%';
    el.style.backgroundSize = '0% 2px';
    const anim = run(el, [{ backgroundSize: '0% 2px' }, { backgroundSize: '100% 2px' }],
      { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
    return combo([anim], ctx, () => { el.style.cssText = before; });
  });

  def('sweepLight', 'emphasis', '扫光', '亮度扫过，适合图片/卡片', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [
      { filter: 'brightness(1)' },
      { filter: 'brightness(' + (1 + 0.5 * p.intensity) + ')', offset: 0.45 },
      { filter: 'brightness(1)' },
    ], { duration: p.duration, delay: p.delay, easing: ease('inOut') }, ctx);
  });

  def('glitch', 'emphasis', '故障抖动', '错位抖动，适合强调/转场', (el, params, ctx) => {
    const p = merge(params);
    const k = [];
    for (let i = 0; i <= 8; i++) {
      k.push({
        transform: 'translateX(' + ((Math.random() * 14 - 7) * p.intensity) + 'px)',
        clipPath: 'inset(' + (Math.random() * 14) + '% 0 ' + (Math.random() * 14) + '% 0)',
        offset: i / 8,
      });
    }
    k.push({ transform: 'translateX(0)', clipPath: 'inset(0 0 0 0)', offset: 1 });
    return run(el, k, { duration: p.duration, delay: p.delay, easing: 'steps(2,end)' }, ctx);
  });

  def('colorPop', 'emphasis', '颜色跳动', '饱和度短暂提升，提示变化', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ filter: 'saturate(1)' }, { filter: 'saturate(' + (1 + 1.4 * p.intensity) + ')' }, { filter: 'saturate(1)' }],
      { duration: p.duration, delay: p.delay, easing: ease('inOut') }, ctx);
  });

  /* ===== 退场 ===== */
  def('fadeOut', 'exit', '淡出', '简单淡出', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ opacity: 1 }, { opacity: 0 }], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('flyOut', 'exit', '飞出', '向指定方向飞出', (el, params, ctx) => {
    const p = merge(params);
    const d = dirs[p.direction] || dirs.up;
    return run(el, [
      { opacity: 1, transform: 'translate(0,0)' },
      { opacity: 0, transform: 'translate(' + (-d.x * p.distance * 3) + 'px,' + (-d.y * p.distance * 3) + 'px)' },
    ], { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  def('zoomOut', 'exit', '缩小消失', '缩小平移消失', (el, params, ctx) => {
    const p = merge(params);
    return run(el, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.7)' }],
      { duration: p.duration, delay: p.delay, easing: ease(p.easing) }, ctx);
  });

  /* ===== 目录 ===== */
  const CATS = [
    { id: 'text', label: '文字', hint: '标题、正文的入场' },
    { id: 'shape', label: '形状', hint: '色块、图片、卡片' },
    { id: 'loop', label: '循环', hint: '持续的氛围动效' },
    { id: 'emphasis', label: '强调', hint: '一次性的提示' },
    { id: 'exit', label: '退场', hint: '离开画面' },
  ];

  const CATALOG = CATS.map((cat) => ({
    id: cat.id,
    label: cat.label,
    hint: cat.hint,
    items: Object.values(FX).filter((f) => f.cat === cat.id).map((f) => ({
      name: f.name, label: f.label, desc: f.desc, chars: Boolean(f.chars),
      defaults: Object.assign({}, DEFAULT_PARAMS, f.defaults || {}),
    })),
  }));

  global.WPX_FX = FX;
  global.WPX_FX_CATALOG = CATALOG;
  global.WPX_EASES = EASES;
  global.WPX_FX_UTIL = { merge, ease, run, splitChars, restoreChars, restoreAll, springEase, DEFAULT_PARAMS };
})(typeof window !== 'undefined' ? window : globalThis);
