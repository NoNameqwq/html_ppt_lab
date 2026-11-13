/**
 * 网页运行时（导入网页 / 原稿页面通用）
 * 不改原稿结构，在页面之上补三件事：
 *   1. 预设动画：扫描 [data-wpx-anim]，在页面切到该页时播放（fx-presets.js 提供动效）
 *   2. 转场叠加：按页面索引执行屏闪/飞入/扫光等叠加层（配置来自 #wpx-deck-config）
 *   3. 对外接口：window.__WPW__（预览 / 重播 / 查询 / 刷新）
 * 编辑页（?wpx=edit）不自动播放，只提供预览；放映页自动播放。
 */
(function () {
  'use strict';
  if (window.__WPW__) return;
  var EDIT = /[?&]wpx=edit/.test(location.search);
  var FX = window.WPX_FX || {};
  var config = readConfig();
  var activeIndex = -1;
  var playedOnce = false;
  var primed = [];
  var activeAnims = [];
  var lastFxAt = 0;

  function readConfig() {
    var node = document.getElementById('wpx-deck-config');
    if (!node) return {};
    try { return JSON.parse(node.textContent || '{}') || {}; } catch (e) { return {}; }
  }

  function slides() {
    return Array.prototype.slice.call(document.querySelectorAll('.slide, [data-slide], #stage > section, #stage > .slide'));
  }

  function currentIndex() {
    var list = slides();
    for (var i = 0; i < list.length; i++) {
      var c = list[i].classList;
      if (c.contains('active') || c.contains('live') || c.contains('current') || c.contains('show') || c.contains('is-active')) return i;
    }
    var h = parseInt((location.hash || '').replace('#', ''), 10);
    if (!isNaN(h) && h >= 1 && h <= list.length) return h - 1;
    return 0;
  }

  function parseParams(el) {
    try { return JSON.parse(el.getAttribute('data-wpx-anim-params') || '{}'); } catch (e) { return {}; }
  }

  function clearAnims() {
    activeAnims.forEach(function (h) { try { h.cancel(); } catch (e) { /* ignore */ } });
    activeAnims = [];
    primed = [];
  }

  function eachHandle(handle, fn) {
    if (!handle) return;
    if (handle.anim) { try { fn(handle.anim); } catch (e) { /* ignore */ } }
    if (Array.isArray(handle.parts)) handle.parts.forEach(function (p) { eachHandle(p, fn); });
  }

  function playOne(item, prime) {
    var fx = FX[item.name];
    if (!fx) return null;
    var res = null;
    try { res = fx.play(item.el, item.params, { instant: false, editing: false, mode: EDIT ? 'edit' : 'present', stage: document.getElementById('stage') }); } catch (e) { console.warn('[WPW] 动效失败', item.name, e); }
    if (!res) return null;
    activeAnims.push(res);
    if (prime) {
      eachHandle(res, function (a) { try { a.pause(); } catch (e) { /* ignore */ } });
      primed.push(res);
    }
    return res;
  }

  function collect(slide) {
    var list = Array.prototype.slice.call(slide.querySelectorAll('[data-wpx-anim]'));
    return list.filter(function (el) { return !el.closest('.wpx-hud'); }).map(function (el) {
      return { el: el, name: el.getAttribute('data-wpx-anim'), params: parseParams(el) };
    });
  }

  function playSlide(slide) {
    if (!slide) return 0;
    clearAnims();
    var items = collect(slide);
    items.forEach(function (it) {
      var trig = (it.params && it.params.trigger) || 'auto';
      if (trig === 'click') return; /* 原稿点击用于翻页，不在网页运行时里抢点击 */
      playOne(it, false);
    });
    return items.length;
  }

  /* ---------- 转场叠加（页面切换瞬间） ---------- */
  function applyFx(index) {
    if (EDIT) return;
    var map = (config && config.transitionFx) || {};
    var fx = map[String(index)] || map[index];
    var list = slides();
    var slide = list[index];
    if (!fx && slide) fx = slide.getAttribute('data-wpx-tr-fx');
    if (!fx || fx === 'none') return;
    var now = Date.now();
    if (now - lastFxAt < 180) return;
    lastFxAt = now;
    var host = document.getElementById('stage') || document.getElementById('app') || document.body;
    var wrap = document.createElement('div');
    wrap.setAttribute('data-wpx-fx', fx);
    wrap.style.cssText = 'position:absolute;inset:0;z-index:2147483000;pointer-events:none;overflow:hidden';
    var accent = getComputedStyle(document.documentElement).getPropertyValue('--wpx-accent') || '#E1402B';
    var anims = [];
    function A(el2, kf, opt) { try { anims.push(el2.animate(kf, Object.assign({ fill: 'both' }, opt || {}))); } catch (e) { /* ignore */ } }
    if (fx === 'flash' || fx === 'black' || fx === 'color') {
      var veil = document.createElement('div');
      veil.style.cssText = 'position:absolute;inset:0;background:' + (fx === 'flash' ? '#fff' : fx === 'black' ? '#000' : accent) + ';opacity:0';
      wrap.appendChild(veil);
      A(veil, [{ opacity: 0 }, { opacity: 0.92, offset: 0.18 }, { opacity: 0.92, offset: 0.44 }, { opacity: 0 }], { duration: 560, delay: 40, easing: 'cubic-bezier(.3,0,.2,1)' });
    } else if (fx === 'fly') {
      for (var i = 0; i < 5; i++) {
        var bar = document.createElement('i');
        bar.style.cssText = 'position:absolute;left:-30%;top:' + (18 + i * 15) + '%;width:' + (46 + i * 9) + '%;height:' + (8 + i * 5) + 'px;background:' + (i % 2 ? accent : 'rgba(255,255,255,.86)') + ';transform:translateX(-40%) skewX(-18deg);opacity:0';
        wrap.appendChild(bar);
        A(bar, [
          { transform: 'translateX(-60%) skewX(-18deg)', opacity: 0 },
          { transform: 'translateX(40%) skewX(-18deg)', opacity: 1, offset: 0.22 },
          { transform: 'translateX(180%) skewX(-18deg)', opacity: 0 },
        ], { duration: 560, delay: i * 34, easing: 'cubic-bezier(.2,.9,.2,1)' });
      }
    } else if (fx === 'sweep') {
      var band = document.createElement('div');
      band.style.cssText = 'position:absolute;top:0;bottom:0;left:-40%;width:32%;background:' + accent + ';filter:blur(2px);opacity:.9';
      wrap.appendChild(band);
      A(band, [{ transform: 'translateX(0) skewX(-12deg)' }, { transform: 'translateX(460%) skewX(-12deg)' }], { duration: 620, delay: 40, easing: 'cubic-bezier(.4,0,.1,1)' });
    } else if (fx === 'bars') {
      for (var b = 0; b < 7; b++) {
        var line = document.createElement('i');
        line.style.cssText = 'position:absolute;left:0;right:0;top:' + (b * 16 + 4) + '%;height:2px;background:rgba(255,255,255,.72);transform:scaleX(0);transform-origin:left';
        wrap.appendChild(line);
        A(line, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }, { transform: 'scaleX(0)', transformOrigin: 'right' }], { duration: 420, delay: b * 26, easing: 'cubic-bezier(.3,0,.2,1)' });
      }
    }
    host.appendChild(wrap);
    setTimeout(function () {
      anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* ignore */ } });
      wrap.remove();
    }, 1300);
  }

  function onSlideChange() {
    var idx = currentIndex();
    if (idx === activeIndex) return;
    activeIndex = idx;
    if (applyFx) applyFx(idx);
    if (!EDIT) {
      var n = playSlide(slides()[idx]);
      if (n > 0) playedOnce = true;
    }
  }

  /* MutationObserver 捕捉原稿切页（class 变化 / hash 路由） */
  function watch() {
    var mo = new MutationObserver(function () { onSlideChange(); });
    mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class', 'style'], childList: true });
    window.addEventListener('hashchange', onSlideChange);
    setInterval(onSlideChange, 350);
    onSlideChange();
    /* 补丁 / 原稿脚本可能在首帧之后才挂上 data-wpx-anim：首屏再补一次 */
    setTimeout(function () { if (!playedOnce) { activeIndex = -1; onSlideChange(); } }, 500);
    setTimeout(function () { if (!playedOnce) { activeIndex = -1; onSlideChange(); } }, 1400);
  }

  window.__WPW__ = {
    get index() { return currentIndex(); },
    slides: slides,
    preview: function (elementId) {
      var el = elementId ? document.querySelector('[data-wpx-el="' + elementId + '"]') : null;
      if (el) {
        var name = el.getAttribute('data-wpx-anim');
        if (name) { playOne({ el: el, name: name, params: parseParams(el) }, false); return { ok: true, name: name }; }
      }
      return { ok: false, error: '元素没有预设动画' };
    },
    replay: function () { return playSlide(slides()[currentIndex()]); },
    refresh: function () { clearAnims(); activeIndex = -1; onSlideChange(); return { ok: true }; },
    setConfig: function (next) { config = next || {}; return { ok: true }; },
    getConfig: function () { return config; },
    applyFx: applyFx,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
