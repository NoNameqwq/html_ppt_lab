/**
 * 兼容模式时间线播放器（独立于原稿分页/运行时）
 * 由 server 在 raw 工程的放映页 / 编辑页注入；时间线数据来自 #wpx-timeline。
 * 暴露 window.__WPTL__：play/pause/seek/getState/getTimeline/setTimeline/seekPage
 */
(function () {
  'use strict';
  var data = null;
  var anims = [];
  var playing = false;
  var time = 0;
  var raf = 0;
  var last = 0;
  var editing = /[?&]wpx=edit/.test(location.search);
  var overlayNodes = [];

  function $(sel, root) { try { return (root || document).querySelector(sel); } catch (e) { return null; } }
  function $$(sel, root) { try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; } }
  function stage() { return document.getElementById('stage') || document.getElementById('app') || document.body; }

  function readData() {
    var node = document.getElementById('wpx-timeline');
    if (!node) return null;
    try { return JSON.parse(node.textContent || 'null'); } catch (e) { return null; }
  }

  function frameFromProps(props, useTransform) {
    props = props || {};
    var frame = {};
    if (props.opacity != null) frame.opacity = Number(props.opacity);
    if (props.transform) frame.transform = String(props.transform);
    else if (useTransform) {
      if (props.x != null || props.y != null || props.scale != null || props.rotate != null) {
        frame.transform = 'translate(' + (Number(props.x) || 0) + 'px,' + (Number(props.y) || 0) + 'px) rotate(' + (Number(props.rotate) || 0) + 'deg) scale(' + (props.scale == null ? 1 : Number(props.scale)) + ')';
      }
    } else {
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
      if (parts.length) frame.filter = parts.join(' ');
    }
    if (props.clipPath) frame.clipPath = String(props.clipPath);
    return frame;
  }

  function buildFrames(kfs, total, trackEasing) {
    var list = (kfs || []).slice().sort(function (a, b) { return (Number(a.t) || 0) - (Number(b.t) || 0); });
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
      Object.keys(keys).forEach(function (key) { f[key] = k.__frame[key] != null ? k.__frame[key] : defaults[key]; });
      f.easing = k.easing || trackEasing || 'linear';
      return f;
    });
    if (frames[0].offset > 0) { var head = Object.assign({}, frames[0]); head.offset = 0; frames.unshift(head); }
    if (frames[frames.length - 1].offset < 1) { var tail = Object.assign({}, frames[frames.length - 1]); tail.offset = 1; frames.push(tail); }
    return frames;
  }

  function killLayers() {
    overlayNodes.forEach(function (n) { try { n.remove(); } catch (e) { /* ignore */ } });
    overlayNodes = [];
  }

  function ensureLayers(t) {
    killLayers();
    (t.tracks || []).forEach(function (track) {
      var selector = String(track.selector || '');
      if (!selector || $(selector)) return;
      var m = /data-wpx-tl\s*=\s*["']([^"']+)["']/.exec(selector);
      if (!m) return;
      var name = m[1];
      var el = document.createElement('div');
      el.setAttribute('data-wpx-tl', name);
      el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      if (name === 'flash') el.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:0;z-index:80;pointer-events:none';
      else if (name === 'black') el.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;z-index:80;pointer-events:none';
      else if (name === 'fly') el.style.cssText = 'position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px 0 0 -48px;border-radius:50%;background:var(--wpx-accent,#E1402B);opacity:0;z-index:70;pointer-events:none';
      else if (name === 'shutter') el.style.cssText = 'position:absolute;inset:0;background:#0A0A0B;opacity:0;z-index:80;pointer-events:none';
      else el.style.cssText = 'position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px;background:var(--wpx-accent,#E1402B);opacity:0;z-index:70;pointer-events:none';
      stage().appendChild(el);
      overlayNodes.push(el);
    });
  }

  function build() {
    anims.forEach(function (a) { try { a.anim.cancel(); } catch (e) { /* ignore */ } });
    anims = [];
    data = readData();
    if (!data || !Array.isArray(data.tracks)) return;
    ensureLayers(data);
    var total = Number(data.duration) || 8000;
    data.tracks.forEach(function (track) {
      if (!track || track.hidden) return;
      var targets = $$(track.selector || '');
      if (!targets.length) return;
      var frames = buildFrames(track.keyframes, total, track.easing);
      if (!frames) return;
      targets.forEach(function (el) {
        try {
          var anim = el.animate(frames, { duration: total, fill: 'both', easing: 'linear' });
          anim.pause();
          anim.currentTime = time;
          anims.push({ el: el, anim: anim });
        } catch (e) { /* ignore */ }
      });
    });
    apply(time);
  }

  function apply(t) {
    var total = data ? (Number(data.duration) || 0) : 0;
    time = Math.max(0, Math.min(total, Number(t) || 0));
    anims.forEach(function (a) { try { a.anim.currentTime = time; } catch (e) { /* ignore */ } });
  }

  function tick(now) {
    if (!playing) return;
    var dt = Math.max(0, now - last);
    last = now;
    var total = data ? (Number(data.duration) || 0) : 0;
    apply(time + dt);
    if (time >= total) {
      if (data && data.loop) apply(0);
      else { playing = false; return; }
    }
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (!data) build();
    if (!data) return false;
    playing = true;
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    return true;
  }
  function pause() { playing = false; cancelAnimationFrame(raf); return true; }
  function seek(t) { apply(t); return time; }
  function getState() { return { playing: playing, time: time, duration: data ? (Number(data.duration) || 0) : 0, hasTimeline: !!data }; }
  function getTimeline() { return data ? JSON.parse(JSON.stringify(data)) : null; }
  function setTimeline(next) {
    data = next || null;
    var node = document.getElementById('wpx-timeline');
    if (!node) { node = document.createElement('script'); node.type = 'application/json'; node.id = 'wpx-timeline'; document.body.appendChild(node); }
    node.textContent = JSON.stringify(data || { version: 2, duration: 8000, tracks: [] });
    build();
    apply(0);
    if (!editing && data && data.autoplay !== false) play();
    return true;
  }
  function pageStart(index) {
    if (!data) return 0;
    var pages = Array.isArray(data.pages) ? data.pages : [];
    if (pages[index] && Number(pages[index].start) >= 0) return Number(pages[index].start) || 0;
    return Math.max(0, index * (Number(data.pageDuration) || 1000));
  }
  function seekPage(index) {
    if (!data) return;
    if (data.followPages === false) return;
    apply(pageStart(index));
    if (!playing && data.autoplay !== false) play();
  }

  window.__WPTL__ = { play: play, pause: pause, seek: seek, getState: getState, getTimeline: getTimeline, setTimeline: setTimeline, seekPage: seekPage, refresh: build };

  function start() {
    var tries = 0;
    (function wait() {
      var slides = document.querySelectorAll('.slide, [data-slide], #stage > section');
      if (slides.length || tries > 80) {
        build();
        if (!editing && data && data.autoplay !== false && (data.tracks || []).length) {
          setTimeout(function () { play(); }, 400);
        }
        return;
      }
      tries += 1;
      setTimeout(wait, 100);
    })();
    var lastIndex = -1;
    setInterval(function () {
      if (!data) return;
      var slides = $$('.slide, [data-slide], #stage > section');
      var cur = 0;
      for (var i = 0; i < slides.length; i++) {
        var c = slides[i].classList;
        if (c.contains('live') || c.contains('active') || c.contains('current') || c.contains('show')) { cur = i; break; }
      }
      if (cur !== lastIndex) {
        lastIndex = cur;
        build();
        seekPage(cur);
      }
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
