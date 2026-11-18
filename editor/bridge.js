/**
 * WebDeck Studio · 编辑桥（注入到 deck iframe 内运行）
 * 通过 postMessage 与父窗口通信，负责：元素选择、文字编辑、样式/几何修改、插入删除、
 * 幻灯片结构操作、动画属性、主题/CSS/JS、序列化、撤销/重做的 op 应用。
 * 协议见 docs/SPEC.md §6 / §14。
 */
(function () {
  'use strict';

  var PARENT_ORIGIN = location.origin;
  var MODE_EDIT = /(?:^|[?&])wpx=edit(?:&|$)/.test(location.search) || (window.__WPX__ && window.__WPX__.mode === 'edit');
  var stageEl = null;
  var runtime = null;
  var slides = [];
  var currentIndex = 0;
  var selectedId = null;
  var textEdit = null;          // {el, beforeHtml, elementId, slideIndex}
  var hoverEl = null;
  var dragState = null;
  var transformState = null;
  var pending = new Map();
  var reqSeq = 0;
  /* ---------- 兼容模式（raw：原稿直编，保留原始 JS/CSS/动效） ---------- */
  var RAW_MODE = false;
  var rawSlideEls = [];
  var rawStage = null;
  var rawTimerPatched = false;
  var rawLoadedPatches = [];
  var rawHitLayer = null;
  // Older running servers may inject the latest bridge without the newer 3D
  // runtime. Resolve from this script, never from the user's project base URL.
  var threeRuntimeUrl = window.__WDS_THREE_RUNTIME_URL__ || (document.currentScript && document.currentScript.src ? new URL('three-runtime.js',document.currentScript.src).href : '/editor/three-runtime.js');
  var threeRuntimeLoading = null;
  function threeLoadNotice(message,retry) {
    document.querySelectorAll('[data-wds-three]').forEach(function(host){
      host.querySelectorAll('[data-wds-three-generated="bootstrap"]').forEach(function(node){node.remove();});
      var notice=document.createElement('div');notice.setAttribute('data-wds-three-generated','bootstrap');notice.setAttribute('role','status');
      notice.style.cssText='position:absolute;inset:0;display:grid;place-content:center;gap:12px;padding:24px;box-sizing:border-box;text-align:center;font:18px/1.5 system-ui,sans-serif;color:inherit;background:#80808018;';
      var text=document.createElement('span');text.textContent=message;notice.appendChild(text);
      if(retry){var button=document.createElement('button');button.type='button';button.textContent='重新加载 3D';button.addEventListener('click',refreshThree);notice.appendChild(button);}
      host.appendChild(notice);
    });
  }

  function ensureThreeRuntime() {
    if (!document.querySelector('[data-wds-three]')) return Promise.resolve(null);
    if (window.__WDS_THREE__) return window.__WDS_THREE__.refresh().then(function(){return window.__WDS_THREE__;});
    if (threeRuntimeLoading) return threeRuntimeLoading;
    threeLoadNotice('正在加载 3D 视图…');
    threeRuntimeLoading = new Promise(function(resolve,reject){
      var script=document.createElement('script'),timer;
      function failed(){clearTimeout(timer);script.remove();threeRuntimeLoading=null;var message='3D 运行时加载失败，请重新加载画布或重启 BAT 服务。';threeLoadNotice(message,true);reject(new Error(message));}
      script.src=threeRuntimeUrl;script.setAttribute('data-wds-runtime','three');
      script.onload=function(){clearTimeout(timer);if(!window.__WDS_THREE__){failed();return;}window.__WDS_THREE__.refresh().then(function(){resolve(window.__WDS_THREE__);},failed);};
      script.onerror=failed;timer=setTimeout(failed,15000);document.head.appendChild(script);
    });
    return threeRuntimeLoading;
  }
  function refreshThree() { ensureThreeRuntime().catch(function(error){emit('threeerror',{message:error.message});}); }

  /* ======================================================================
     基础工具
     ====================================================================== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function genId(prefix) { return (prefix || 'x') + Math.random().toString(36).slice(2, 7) + Date.now().toString(36).slice(-3); }
  function post(msg) { try { parent.postMessage(msg, PARENT_ORIGIN); } catch (e) { } }
  function emit(event, data) { post({ type: 'wpx:event', event: event, data: data }); }
  function emitChange(op) {
    refreshThree();
    if (op && RAW_MODE) {
      try {
        if (!op.rawLoc && op.elementId) {
          var locEl = elementById(op.elementId);
          if (locEl) op.rawLoc = rawLocate(locEl);
        }
        if (op.type === 'slide-attrs' && op.after && op.after.bg != null) op.rawBg = op.after.bg;
      } catch (e) { /* ignore */ }
    }
    if (op) emit('change', { op: op });
  }

  function ensureRuntime() {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function wait() {
        if (window.__WPX__ && window.__WPX__.ready) {
          window.__WPX__.ready.then(function () {
            runtime = window.__WPX__;
            resolve(runtime);
          }).catch(function () { resolve(null); });
          return;
        }
        // 原稿没有本工具的运行时：快速进入兼容模式（raw）
        if (!document.getElementById('wpx-runtime') && Date.now() - started > 900) { resolve(null); return; }
        if (Date.now() - started > 12000) { resolve(null); return; }
        setTimeout(wait, 60);
      })();
    });
  }

  function refreshSlides() {
    if (RAW_MODE) {
      rawSlideEls = detectRawSlides();
      slides = rawSlideEls;
      return;
    }
    slides = $$('.wpx-slide', stageEl || document);
  }

  /** 兼容模式：识别原稿幻灯片（与转换器同款选择器，去嵌套、按文档顺序） */
  function detectRawSlides() {
    var raw = [];
    function addAll(sel) {
      try {
        $$(sel, document).forEach(function (el) { if (raw.indexOf(el) < 0) raw.push(el); });
      } catch (e) { /* ignore */ }
    }
    addAll('#stage > .slide');
    addAll('.slide');
    addAll('[data-slide]');
    if (!raw.length) addAll('#stage > section, #app section');
    var set = raw.filter(function (el) {
      var p = el.parentElement;
      while (p) { if (raw.indexOf(p) >= 0) return false; p = p.parentElement; }
      return true;
    });
    set.sort(function (a, b) { try { return a.compareDocumentPosition(b) & 4 ? -1 : 1; } catch (e) { return 0; } });
    return set;
  }

  function rawCurrentIndex() {
    refreshSlides();
    for (var i = 0; i < rawSlideEls.length; i++) {
      var cl = rawSlideEls[i].classList;
      if (cl && (cl.contains('live') || cl.contains('active') || cl.contains('current') || cl.contains('show') || cl.contains('is-active'))) return i;
    }
    for (var j = 0; j < rawSlideEls.length; j++) {
      try {
        var cs = getComputedStyle(rawSlideEls[j]);
        if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '0') > 0.05) return j;
      } catch (e) { /* ignore */ }
    }
    return currentIndex;
  }

  function rawSlideName(el, index) {
    if (!el) return '第 ' + (index + 1) + ' 页';
    try {
      var node = el.querySelector('h1,h2,h3,.title,.no,.hd .no');
      var text = node ? (node.textContent || '').trim() : '';
      if (text) return text.replace(/\s+/g, ' ').slice(0, 40);
    } catch (e) { /* ignore */ }
    return '第 ' + (index + 1) + ' 页';
  }

  function rawState() {
    refreshSlides();
    var cur = rawCurrentIndex();
    currentIndex = cur;
    var sr = stageRect();
    return {
      mode: 'edit',
      raw: true,
      current: cur,
      total: rawSlideEls.length,
      w: 1920,
      h: 1080,
      editing: true,
      slides: rawSlideEls.map(function (el, i) {
        return {
          index: i,
          id: el.getAttribute('data-id') || el.id || ('raw' + (i + 1)),
          name: rawSlideName(el, i),
          transition: el.getAttribute('data-transition') || '',
          duration: 0,
        };
      }),
      stage: { left: sr.left, top: sr.top, width: sr.width, height: sr.height, scale: sr.scale },
      capabilities: { slides: true, animations: true, transitions: false, transitionFx: true, structure: false, text: true, insert: true, themes: false, timeline: true, raw: true },
    };
  }

  function dispatchRawKey(dir) {
    var key = dir > 0 ? 'ArrowRight' : 'ArrowLeft';
    var init = { key: key, code: key, keyCode: dir > 0 ? 39 : 37, which: dir > 0 ? 39 : 37, bubbles: true, cancelable: true, composed: true };
    try {
      var ev = new KeyboardEvent('keydown', init);
      ev.__wpxNav = true;
      window.dispatchEvent(ev);
      document.dispatchEvent(ev);
      window.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch (e) { /* ignore */ }
  }

  /** 兼容模式编辑态：拦住原稿的「点击画面翻页 / 滚轮翻页 / 方向键翻页」，只保留编辑操作 */
  function installRawNavGuards() {
    var navKeys = { ArrowRight: 1, ArrowLeft: 1, ArrowUp: 1, ArrowDown: 1, ' ': 1, PageDown: 1, PageUp: 1, Home: 1, End: 1, Enter: 1 };
    function block(e) {
      if (e.__wpxNav) return;
      var t = e.target;
      if (isThreeUi(t)) return;
      if (t && t.isContentEditable) return;
      if (t && t.closest && t.closest('.wpx-hud')) return;
      e.stopPropagation();
    }
    function blockKeys(e) {
      if (e.__wpxNav) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
      if (navKeys[e.key]) { e.stopPropagation(); e.preventDefault(); }
    }
    try {
      window.addEventListener('click', block, true);
      document.addEventListener('click', block, true);
      window.addEventListener('wheel', block, { capture: true, passive: true });
      window.addEventListener('keydown', blockKeys, true);
      document.addEventListener('keydown', blockKeys, true);
    } catch (e) { /* ignore */ }
  }

  /** 兼容模式切页：优先原稿 hash 深链 → 原稿键盘导航 → 类切换兜底 */
  function rawGo(index) {
    refreshSlides();
    if (!rawSlideEls.length) throw new Error('原稿中未识别到幻灯片');
    index = Math.max(0, Math.min(rawSlideEls.length - 1, Number(index) || 0));
    var cur = rawCurrentIndex();
    if (cur === index) { currentIndex = index; return Promise.resolve({ index: index }); }
    var target = rawSlideEls[index];
    function done() {
      currentIndex = index;
      try {
        if (rawLoadedPatches.length) { applyPatches(rawLoadedPatches, index); ensureElementIds(); }
        var pl = window.__WPTL__;
        if (pl && pl.seekPage) pl.seekPage(index);
      } catch (e) { /* ignore */ }
      return { index: index };
    }
    // 1) hash 深链（多数原稿支持 #n）
    try {
      if (location.hash !== '#' + (index + 1)) location.hash = '#' + (index + 1);
    } catch (e) { /* ignore */ }
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (rawCurrentIndex() === index) { resolve(done()); return; }
        // 2) 原稿键盘导航（编辑器内已加速计时器）
        var dir = index > cur ? 1 : -1;
        var steps = Math.abs(index - cur);
        var doneSteps = 0;
        function step() {
          if (rawCurrentIndex() === index) { resolve(done()); return; }
          if (doneSteps >= steps + 6) { fallback(); return; }
          dispatchRawKey(dir);
          doneSteps += 1;
          setTimeout(function () {
            if (rawCurrentIndex() === index) { resolve(done()); return; }
            step();
          }, 120);
        }
        function fallback() {
          rawSlideEls.forEach(function (el, i) {
            ['live', 'active', 'current', 'show', 'is-active'].forEach(function (c) { el.classList.remove(c); });
            if (i === index) { el.classList.add('live'); el.classList.add('active'); }
          });
          currentIndex = index;
          setTimeout(function () { resolve(done()); }, 80);
        }
        step();
      }, 180);
    });
  }

  /** 兼容模式：真实速度预览原稿切换（临时切到下一页再切回，期间不加速计时器） */
  function rawPreviewTransition(params) {
    refreshSlides();
    if (!rawSlideEls.length) throw new Error('原稿中未识别到幻灯片');
    var cur = rawCurrentIndex();
    var target = cur < rawSlideEls.length - 1 ? cur + 1 : Math.max(0, cur - 1);
    if (target === cur) throw new Error('只有一页，无法预览切换');
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    window.__wpxRawPreview = true;
    return rawGo(target).then(function () {
      return wait(1500);
    }).then(function () {
      return rawGo(cur);
    }).then(function () {
      return wait(900);
    }).then(function () {
      window.__wpxRawPreview = false;
      return { index: cur, raw: true };
    }).catch(function (err) {
      window.__wpxRawPreview = false;
      throw err;
    });
  }

  /** 兼容模式：编辑态覆盖层（拦截原稿鼠标/右键导航，右键转发给父窗口自定义菜单） */
  function installRawHitLayer() {
    if (rawHitLayer) return;
    var layer = document.createElement('div');
    layer.id = 'wpx-raw-hit';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:transparent;cursor:default';
    ['pointerdown', 'pointerup', 'click', 'dblclick', 'touchstart', 'touchend'].forEach(function (type) {
      layer.addEventListener(type, function (e) {
        if (type === 'pointerdown' && clickThreeUiAt(e.clientX,e.clientY)) { e.stopImmediatePropagation(); return; }
        if (type === 'dblclick') {
          var hit = rawEventHit(e);
          if (!hit) blankDoubleClick(e);
          else { try { beginTextEdit(hit.textElementId || hit.elementId); } catch (err) {} }
        }
        e.stopImmediatePropagation();
      }, true);
    });
    layer.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    layer.addEventListener('dblclick', function (e) {
      e.stopImmediatePropagation();
      var hit = rawEventHit(e);
      if (!hit) return;
      try { beginTextEdit(hit.textElementId || hit.elementId); } catch (err) { /* ignore */ }
    }, true);
    layer.addEventListener('wheel', function (e) { e.stopImmediatePropagation(); }, { capture: true, passive: true });
    document.body.appendChild(layer);
    rawHitLayer = layer;
  }

  function setRawHitLayer(enabled) {
    if (rawHitLayer) rawHitLayer.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  /** 覆盖层存在时，用坐标反查元素（临时让出 pointer-events 以便 elementFromPoint 命中真实内容） */
  function rawEventHit(e) {
    var sr = stageRect();
    return hitAt((e.clientX - sr.left) / sr.scale, (e.clientY - sr.top) / sr.scale);
  }

  function blankDoubleClick(e) {
    var sr = stageRect();
    var x = (e.clientX - sr.left) / sr.scale, y = (e.clientY - sr.top) / sr.scale;
    if (x >= 0 && y >= 0 && x < 1920 && y < 1080) emit('blankdblclick', { x: x, y: y });
  }

  /** 兼容模式：加速原稿的转场计时器（编辑导航用，不影响放映原文件） */
  function patchRawTimers() {
    if (rawTimerPatched) return;
    rawTimerPatched = true;
    try {
      var orig = window.setTimeout;
      window.setTimeout = function (fn, ms) {
        var args = Array.prototype.slice.call(arguments, 2);
        if (!window.__wpxRawPreview && typeof ms === 'number' && ms >= 250 && ms <= 3000) ms = Math.min(ms, 90);
        return orig.apply(window, [fn, ms].concat(args));
      };
    } catch (e) { /* ignore */ }
  }

  /* ---------- 兼容模式：编辑补丁层（原稿 HTML 不动，补丁在放映/编辑时应用） ---------- */
  function rawLocate(el) {
    if (!el) return null;
    var slide = el.closest('.slide, [data-slide]');
    if (!slide) return null;
    refreshSlides();
    var slideIndex = rawSlideEls.indexOf(slide);
    if (slideIndex < 0) return null;
    var parts = [];
    var n = el;
    while (n && n !== slide) {
      var p = n.parentElement;
      if (!p) return null;
      parts.unshift(Array.prototype.indexOf.call(p.children, n));
      n = p;
    }
    if (n !== slide) return null;
    return { slide: slideIndex, path: parts.join('.'), parentPath: parts.slice(0, -1).join('.'), index: parts.length ? parts[parts.length - 1] : 0 };
  }

  function rawResolvePath(slide, path) {
    var parts = String(path == null ? '' : path).split('.').filter(function (x) { return x !== ''; });
    var n = slide;
    for (var i = 0; i < parts.length; i++) {
      n = n.children[Number(parts[i])];
      if (!n) return null;
    }
    return n;
  }

  /** 由历史 ops 生成可持久化的补丁（编辑/放映时按序应用，原稿脚本不动） */
  function buildPatches(ops) {
    var out = [];
    (ops || []).forEach(function (op) {
      if (!op || !op.type) return;
      var loc = op.rawLoc;
      try {
        if (op.type === 'html' || op.type === 'text' || op.type === 'style') {
          if (loc && op.after) {
            if (op.after.html != null) out.push({ type: 'html', slide: loc.slide, path: loc.path, html: op.after.html });
            if (op.after.cssText != null) out.push({ type: 'style', slide: loc.slide, path: loc.path, cssText: op.after.cssText });
          }
        } else if (op.type === 'attr') {
          if (loc && op.after) out.push({ type: 'attr', slide: loc.slide, path: loc.path, attrs: op.after.attrs || {} });
        } else if (op.type === 'anim') {
          if (loc) {
            out.push({
              type: 'attr', slide: loc.slide, path: loc.path,
              attrs: {
                'data-wpx-anim': op.after && op.after.name ? op.after.name : null,
                'data-wpx-anim-params': op.after && op.after.name ? JSON.stringify(op.after.params || {}) : null,
              },
            });
          }
        } else if (op.type === 'insert') {
          if (loc && op.after) out.push({ type: 'insert', slide: loc.slide, path: loc.parentPath, index: loc.index, html: op.after.html });
        } else if (op.type === 'delete') {
          if (op.before && op.before.loc) out.push({ type: 'delete', slide: op.before.loc.slide, path: op.before.loc.path });
        } else if (op.type === 'slide-attrs') {
          if (op.after && op.after.bg != null) out.push({ type: 'bg', slide: op.slideIndex, bg: op.after.bg });
        } else if (op.type === 'deck-css') {
          if (op.after) out.push({ type: 'css', css: op.after.css || '' });
        } else if (op.type === 'deck-js') {
          if (op.after) out.push({ type: 'js', js: op.after.js || '' });
        } else if (op.type === 'slide-html') {
          if (op.after && op.after.html) out.push({ type: 'slide-html', slide: op.slideIndex, html: op.after.html });
        }
      } catch (e) { /* ignore */ }
    });
    return out;
  }

  /** 应用补丁（幂等：insert 打标记，重复应用不会重复插入） */
  function applyPatches(patches, onlySlide) {
    refreshSlides();
    (patches || []).forEach(function (p, idx) {
      if (!p) return;
      try {
        if (p.type === 'css') {
          var st = document.getElementById('wpx-raw-css');
          if (!st) { st = document.createElement('style'); st.id = 'wpx-raw-css'; document.head.appendChild(st); }
          st.textContent = p.css || '';
          return;
        }
        if (p.type === 'js') {
          var old = document.getElementById('wpx-raw-js');
          if (old) old.remove();
          var sc = document.createElement('script');
          sc.id = 'wpx-raw-js';
          sc.textContent = p.js || '';
          document.body.appendChild(sc);
          return;
        }
        if (p.slide == null) return;
        if (onlySlide != null && p.slide !== onlySlide) return;
        var slide = rawSlideEls[p.slide];
        if (!slide) return;
        if (p.type === 'bg') { slide.style.background = p.bg; return; }
        if (p.type === 'slide-html') {
          var tmpS = document.createElement('div');
          tmpS.innerHTML = p.html || '';
          var newS = tmpS.firstElementChild;
          if (newS) slide.innerHTML = newS.innerHTML;
          return;
        }
        var target = p.path ? rawResolvePath(slide, p.path) : slide;
        if (!target) return;
        if (p.type === 'html') {
          target.innerHTML = p.html == null ? '' : p.html;
        } else if (p.type === 'style') {
          if (p.cssText) target.setAttribute('style', p.cssText); else target.removeAttribute('style');
        } else if (p.type === 'attr') {
          Object.keys(p.attrs || {}).forEach(function (k) {
            var v = p.attrs[k];
            if (v == null) target.removeAttribute(k); else target.setAttribute(k, String(v));
          });
        } else if (p.type === 'insert') {
          var marker = 'raw-' + idx;
          if (target.querySelector('[data-wpx-raw-patch="' + marker + '"]')) return;
          var wrap = document.createElement('div');
          wrap.innerHTML = p.html || '';
          var node = wrap.firstElementChild;
          if (node) {
            node.setAttribute('data-wpx-raw-patch', marker);
            var ref = target.children[p.index] || null;
            target.insertBefore(node, ref);
          }
        } else if (p.type === 'delete') {
          target.remove();
        }
      } catch (e) { /* ignore */ }
    });
  }

  function rawProjectId() {
    var m = /\/p\/([^/]+)\//.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function loadRawPatches() {
    var id = rawProjectId();
    if (!id) return Promise.resolve([]);
    return fetch('/api/projects/' + encodeURIComponent(id) + '/patches')
      .then(function (r) { return r.ok ? r.json() : { patches: [] }; })
      .then(function (d) {
        var patches = d && Array.isArray(d.patches) ? d.patches : [];
        if (patches.length) applyPatches(patches);
        return patches;
      })
      .catch(function () { return []; });
  }

  function canvasOf(slide) {    if (!slide) return null;
    return $('.wpx-canvas', slide) || (RAW_MODE ? slide : null);
  }

  function slideIndexOf(el) {
    var s = el && el.closest ? (el.closest('.wpx-slide') || (RAW_MODE ? el.closest('.slide, [data-slide]') : null)) : null;
    return s ? slides.indexOf(s) : -1;
  }

  function elementById(id) {
    if (!id) return null;
    return document.querySelector('[data-wpx-el="' + String(id).replace(/"/g, '\\"') + '"]');
  }

  /** 原稿：从光标下挑「最有意义」的元素（文字 / 图片 / 形状），而不是整页 wrapper */
  function rawPickTarget(el, slide) {
    if (!el || !slide) return null;
    var node = el;
    var fallback = null;
    var semantic = /^(h1|h2|h3|h4|h5|h6|p|li|blockquote|figcaption|button|a|label)$/i;
    var slideRect = slide.getBoundingClientRect();
    var slideArea = Math.max(1, slideRect.width * slideRect.height);
    while (node && node !== slide) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      var r = node.getBoundingClientRect();
      var cover = (r.width * r.height) / slideArea;
      var text = (node.innerText || '').trim();
      if (semantic.test(tag) && text && cover < 0.92) return node;
      if (tag === 'img' || tag === 'svg' || tag === 'video' || tag === 'canvas') return node;
      var display = '';
      try { display = getComputedStyle(node).display; } catch (e) { display = ''; }
      if (text && cover < 0.92 && display !== 'inline' && display !== 'contents' && !fallback) fallback = node;
      node = node.parentElement;
    }
    return fallback;
  }

  function topLevelOf(el) {
    if (!el) return null;
    var container = el.closest('.wpx-canvas') || (RAW_MODE ? el.closest('.slide, [data-slide]') : null);
    if (!container) return null;
    var n = el;
    while (n && n.parentElement && n.parentElement !== container) n = n.parentElement;
    return n && n.parentElement === container ? n : null;
  }

  /** 原稿元素 id：按「页序号 + DOM 路径」生成，重开工程后仍然稳定（时间线 / 交互能持续命中） */
  function stableRawId(el) {
    try {
      var slide = el.closest('.slide, [data-slide]');
      if (!slide) return genId('e');
      var idx = rawSlideEls.indexOf(slide);
      if (idx < 0) return genId('e');
      var path = [];
      var n = el;
      while (n && n !== slide) {
        var p = n.parentElement;
        if (!p) break;
        path.unshift(Array.prototype.indexOf.call(p.children, n));
        n = p;
      }
      return 'r' + idx + 'p' + path.join('-');
    } catch (e) { return genId('e'); }
  }

  function ensureElementIds() {
    refreshSlides();
    slides.forEach(function (slide) {
      var canvas = canvasOf(slide);
      if (!canvas) return;
      Array.prototype.forEach.call(canvas.children, function (el) {
        if (!el.dataset.wpxEl) el.dataset.wpxEl = RAW_MODE ? stableRawId(el) : genId('e');
        if (!el.dataset.wpxType) el.dataset.wpxType = detectType(el);
      });
      // 给嵌套文本元素也分配 id：双击任意文字都能精确编辑（标题/段落/span），而不是整块 wrapper
      Array.prototype.forEach.call(canvas.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,span,strong,em,a'), function (el) {
        if (el.closest('[data-wpx-el]') === el) return;
        if (el.querySelector('img,svg,video,canvas,iframe')) return;
        if (!(el.innerText || '').trim()) return;
        if (!el.dataset.wpxEl) el.dataset.wpxEl = RAW_MODE ? stableRawId(el) : genId('t');
        if (!el.dataset.wpxType) el.dataset.wpxType = 'text';
        el.dataset.wpxNested = '1';
      });
    });
  }

  function detectType(el) {
    if(el.matches('[data-wds-three]')||el.querySelector('[data-wds-three]'))return 'html';
    if (!el) return 'html';
    var tag = el.tagName.toLowerCase();
    if (tag === 'img') return 'image';
    if (tag === 'svg' || el.classList.contains('wpx-shape')) return 'shape';
    if (el.classList.contains('wpx-text')) return 'text';
    if (tag === 'hr') return 'shape';
    var text = (el.innerText || '').trim();
    if (text && !el.querySelector('img,svg')) return 'text';
    return 'html';
  }

  function hasText(el) {
    if (!el) return false;
    if(el.matches('[data-wds-three]')||el.querySelector('[data-wds-three]'))return false;
    if (el.querySelector('img,svg,canvas,video')) return Boolean((el.innerText || '').trim());
    return Boolean((el.innerText || '').trim()) || Boolean(el.querySelector('p,h1,h2,h3,h4,h5,h6,span,div'));
  }

  function stageRect() {
    var r = (stageEl || document.body).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, scale: r.width / 1920 };
  }

  function rectInStage(el) {
    var sr = stageRect();
    var r = el.getBoundingClientRect();
    return {
      x: (r.left - sr.left) / sr.scale,
      y: (r.top - sr.top) / sr.scale,
      w: r.width / sr.scale,
      h: r.height / sr.scale,
    };
  }

  function parseTranslate(el) {
    var v = el.style.translate || '';
    if (!v) return { x: 0, y: 0 };
    var parts = v.trim().split(/\s+/);
    var x = parseFloat(parts[0]) || 0;
    var y = parseFloat(parts[1]) || 0;
    return { x: x, y: y };
  }

  function parseRotate(el) {
    var v = el.style.rotate || '';
    var m = /(-?[\d.]+)deg/.exec(v);
    return m ? parseFloat(m[1]) : 0;
  }

  function setTranslate(el, x, y) {
    if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) el.style.removeProperty('translate');
    else el.style.translate = round(x) + 'px ' + round(y) + 'px';
  }

  function setRotate(el, deg) {
    if (Math.abs(deg) < 0.01) el.style.removeProperty('rotate');
    else el.style.rotate = round(deg) + 'deg';
  }

  function round(n) { return Math.round(n * 100) / 100; }

  function styleSnapshot(el) { return el.getAttribute('style') || ''; }

  function makeOp(partial) {
    return Object.assign({
      opId: genId('op'),
      ts: Date.now(),
      label: '修改',
      source: 'ui',
      type: 'style',
      slideIndex: currentIndex,
      elementId: null,
      before: null,
      after: null,
    }, partial);
  }

  function commitOp(op) {
    if (!op) return null;
    emitChange(op);
    return op;
  }

  /* ======================================================================
     选择
     ====================================================================== */
  function selectionInfo(el) {
    if (!el) return null;
    var cs = getComputedStyle(el);
    var type = detectType(el);
    return {
      elementId: el.dataset.wpxEl,
      slideIndex: slideIndexOf(el),
      tag: el.tagName.toLowerCase(),
      type: type,
      rect: rectInStage(el),
      translate: parseTranslate(el),
      rotate: parseRotate(el),
      opacity: Number(cs.opacity),
      zIndex: cs.zIndex,
      text: (el.innerText || '').slice(0, 2000),
      html: (el.innerHTML || '').slice(0, 6000),
      inline: styleSnapshot(el),
      styles: {
        fontFamily: cs.fontFamily,
        fontSize: parseFloat(cs.fontSize) || 16,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        textDecorationLine: cs.textDecorationLine || cs.textDecoration,
        textAlign: cs.textAlign,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        color: toHex(cs.color),
        backgroundColor: toHex(cs.backgroundColor),
        backgroundImage: cs.backgroundImage === 'none' ? '' : cs.backgroundImage,
        borderRadius: cs.borderRadius,
        borderWidth: parseFloat(cs.borderWidth) || 0,
        borderColor: toHex(cs.borderColor),
        borderStyle: cs.borderStyle,
        boxShadow: cs.boxShadow === 'none' ? '' : cs.boxShadow,
        objectFit: cs.objectFit,
        opacity: Number(cs.opacity),
        zIndex: cs.zIndex,
      },
      animation: readAnim(el),
      canEditText: hasText(el) && el.dataset.wpxLocked !== '1',
      editable: el.dataset.wpxLocked !== '1',
      locked: el.dataset.wpxLocked === '1',
      isTopLevel: el.parentElement && el.parentElement.classList.contains('wpx-canvas'),
    };
  }

  function toHex(color) {
    if (!color) return '';
    var m = /rgba?\(([^)]+)\)/.exec(color);
    if (!m) return color;
    var parts = m[1].split(',').map(function (s) { return parseFloat(s.trim()); });
    var a = parts.length > 3 ? parts[3] : 1;
    if (a === 0) return 'transparent';
    function h(n) { return ('0' + Math.round(n).toString(16)).slice(-2); }
    return '#' + h(parts[0]) + h(parts[1]) + h(parts[2]);
  }

  function readAnim(el) {
    var name = el.getAttribute('data-wpx-anim');
    if (!name) return null;
    var params = {};
    try { params = JSON.parse(el.getAttribute('data-wpx-anim-params') || '{}'); } catch (e) { }
    return { name: name, params: params };
  }

  function setSelected(el) {
    if (selectedId) {
      var old = elementById(selectedId);
      if (old) old.classList.remove('wpx-selected');
    }
    selectedId = el ? el.dataset.wpxEl : null;
    if (el) {
      el.classList.add('wpx-selected');
      el.dataset.wpxEl = el.dataset.wpxEl || genId('e');
    }
    emit('selectionchange', { selection: selectionInfo(el) });
  }

  function clearHover() {
    if (hoverEl) { hoverEl.classList.remove('wpx-hover'); hoverEl = null; }
  }

  function hitAt(designX, designY) {
    var sr = stageRect();
    var x = sr.left + designX * sr.scale;
    var y = sr.top + designY * sr.scale;
    if (rawHitLayer) rawHitLayer.style.pointerEvents = 'none';
    var el = document.elementFromPoint(x, y);
    if (rawHitLayer) rawHitLayer.style.pointerEvents = 'auto';
    if (el && el.closest('.wpx-hud')) return null;
    var top = el ? topLevelOf(el) : null;    if (!top && RAW_MODE) {
      // 原稿常用 pointer-events:none，elementFromPoint 拿不到内容：按顶层元素包围盒兜底
      refreshSlides();
      var act = rawSlideEls[rawCurrentIndex()];
      if (act) {
        for (var i = 0; i < act.children.length; i++) {
          var c = act.children[i];
          var r = rectInStage(c);
          if (designX >= r.x && designX <= r.x + r.w && designY >= r.y && designY <= r.y + r.h) {
            if (!c.dataset.wpxEl) c.dataset.wpxEl = RAW_MODE ? stableRawId(c) : genId('e');
            return { el: c, inner: c, rect: r, elementId: c.dataset.wpxEl, slideIndex: rawCurrentIndex() };
          }
        }
      }
      return null;
    }
    if (!top) return null;
    if (RAW_MODE && el) {
      var rawSlide = el.closest('.slide, [data-slide]');
      var pick = rawPickTarget(el, rawSlide);
      if (pick) {
        top = pick;
        if (!top.dataset.wpxEl) top.dataset.wpxEl = stableRawId(top);
        if (!top.dataset.wpxType) top.dataset.wpxType = detectType(top);
      }
    }
    if (top.dataset.wpxLocked === '1' && top.dataset.wpxEl !== selectedId) return null;
    var textEl = el ? el.closest('[data-wpx-nested="1"]') : null;
    if (RAW_MODE && top) {
      var ownTextEl = top;
      var hasText = (ownTextEl.innerText || '').trim().length > 0;
      if (hasText) { textEl = ownTextEl; if (!textEl.dataset.wpxNested && textEl.children.length === 0) textEl.dataset.wpxNested = '1'; }
    }
    return { el: top, inner: el, textEl: textEl, textElementId: textEl ? textEl.dataset.wpxEl : null, rect: rectInStage(top), elementId: top.dataset.wpxEl, slideIndex: slideIndexOf(top) };
  }

  function hitTest(designX, designY) {
    var hit = hitAt(designX, designY);
    if (!hit) return null;
    return { elementId: hit.elementId, textElementId: hit.textElementId || null, slideIndex: hit.slideIndex, rect: hit.rect, type: detectType(hit.el) };
  }

  /* ======================================================================
     文字编辑
     ====================================================================== */
  function beginTextEdit(elementId, selectAll) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在: ' + elementId);
    if (el.dataset.wpxLocked === '1') throw new Error('元素已锁定');
    if (!hasText(el)) throw new Error('该元素没有可编辑文字');
    if (textEdit) endTextEdit();
    setRawHitLayer(false);
    textEdit = { el: el, beforeHtml: el.innerHTML, elementId: el.dataset.wpxEl, slideIndex: slideIndexOf(el) };
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('spellcheck', 'false');
    document.body.classList.add('wpx-text-editing');
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
    var range = document.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    var sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    textEdit.range = range.cloneRange();
    emit('textedit', { editing: true, elementId: el.dataset.wpxEl, slideIndex: textEdit.slideIndex });
    return { ok: true };
  }

  function endTextEdit() {
    if (!textEdit) return { op: null };
    var t = textEdit;
    textEdit = null;
    setRawHitLayer(true);
    document.body.classList.remove('wpx-text-editing');
    try { t.el.removeAttribute('contenteditable'); t.el.removeAttribute('spellcheck'); } catch (e) { }
    try { t.el.blur(); } catch (e) { }
    var after = t.el.innerHTML;
    var op = null;
    if (after !== t.beforeHtml) {
      op = makeOp({
        type: 'html',
        label: '编辑文字',
        elementId: t.elementId,
        slideIndex: t.slideIndex,
        before: { html: t.beforeHtml },
        after: { html: after },
      });
      emitChange(op);
    }
    emit('textedit', { editing: false, elementId: t.elementId });
    setSelected(t.el);
    return { op: op };
  }

  function commitTypedText() {
    if (!textEdit || textEdit.beforeHtml === textEdit.el.innerHTML) return null;
    var t = textEdit;
    var op = makeOp({ type: 'html', label: '编辑文字', elementId: t.elementId, slideIndex: t.slideIndex,
      before: { html: t.beforeHtml }, after: { html: t.el.innerHTML } });
    t.beforeHtml = t.el.innerHTML;
    emitChange(op);
    return op;
  }

  // Pixel sizes must never pass through execCommand's legacy 1–7 font scale.
  function applyPixelSize(el, value, range) {
    var size = parseFloat(value);
    if (!isFinite(size) || size < 1 || size > 1000) throw new Error('字号应在 1–1000 像素之间');
    var whole = !range || range.collapsed;
    if (range && !whole) {
      var full = document.createRange(); full.selectNodeContents(el);
      whole = range.toString() === full.toString();
    }
    if (whole) {
      el.style.setProperty('font-size', size + 'px', 'important');
      Array.from(el.querySelectorAll('*')).forEach(function (node) {
        if (node.closest('svg,.katex,[data-wds-latex]')) return;
        node.style.setProperty('font-size', 'inherit', 'important'); node.removeAttribute('size');
      });
      return;
    }
    var pieces = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), node;
    while ((node = walker.nextNode())) {
      if (!node.textContent || !range.intersectsNode(node) || node.parentElement.closest('svg,.katex,[data-wds-latex]')) continue;
      var start = node === range.startContainer ? range.startOffset : 0;
      var end = node === range.endContainer ? range.endOffset : node.length;
      if (end > start) pieces.push({ node: node, start: start, end: end });
    }
    var spans = [];
    pieces.forEach(function (p) {
      if (p.end < p.node.length) p.node.splitText(p.end);
      var text = p.start ? p.node.splitText(p.start) : p.node;
      var span = document.createElement('span'); span.style.setProperty('font-size', size + 'px', 'important');
      text.parentNode.insertBefore(span, text); span.appendChild(text); spans.push(span);
    });
    if (spans.length) {
      var selected = document.createRange(); selected.setStartBefore(spans[0]); selected.setEndAfter(spans[spans.length - 1]);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(selected);
      if (textEdit) textEdit.range = selected.cloneRange();
    }
  }

  function execTextCommand(command, value) {
    if (!textEdit) return { ok: false, error: '当前不在文字编辑状态' };
    commitTypedText();
    var t = textEdit, el = t.el, before = { html: el.innerHTML, cssText: el.style.cssText };
    try {
      el.focus({ preventScroll: true });
      var range = t.range, sel = window.getSelection();
      if (range && el.contains(range.commonAncestorContainer)) { sel.removeAllRanges(); sel.addRange(range); }
      if (command === 'fontSize') applyPixelSize(el, value, range);
      else if (command === 'lineHeight') el.style.lineHeight = String(value);
      else if (command === 'letterSpacing') el.style.letterSpacing = String(value);
      else {
        document.execCommand('styleWithCSS', false, true);
        if (!document.execCommand(command === 'fontFamily' ? 'fontName' : command, false, value == null ? null : String(value))) return { ok: false };
      }
    } catch (e) { return { ok: false, error: e.message }; }
    var after = { html: el.innerHTML, cssText: el.style.cssText }, op = null;
    if (before.html !== after.html || before.cssText !== after.cssText) {
      op = makeOp({ type: 'html', label: '文字格式', elementId: t.elementId, slideIndex: t.slideIndex, before: before, after: after });
      t.beforeHtml = after.html; emitChange(op);
      emit('selectionchange', { selection: selectionInfo(el) });
    }
    return { ok: true, op: op };
  }

  /* ======================================================================
     样式 / 几何修改
     ====================================================================== */
  function styleMutate(el, apply, label) {
    var before = styleSnapshot(el);
    apply(el);
    var after = styleSnapshot(el);
    if (before === after) return null;
    var op = makeOp({
      type: 'style',
      label: label || '修改样式',
      elementId: el.dataset.wpxEl,
      slideIndex: slideIndexOf(el),
      before: { cssText: before },
      after: { cssText: after },
    });
    emitChange(op);
    return op;
  }

  function setStyles(elementId, styles) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    if (styles && styles['font-size']) {
      if (textEdit && textEdit.el === el) commitTypedText();
      var before = { html: el.innerHTML, cssText: el.style.cssText };
      applyPixelSize(el, styles['font-size']);
      Object.keys(styles).forEach(function (k) { if (k !== 'font-size') el.style.setProperty(k, String(styles[k])); });
      var after = { html: el.innerHTML, cssText: el.style.cssText };
      if (before.html === after.html && before.cssText === after.cssText) return { op: null };
      var sizeOp = makeOp({ type: 'style', label: '修改字号', elementId: elementId, slideIndex: slideIndexOf(el), before: before, after: after });
      if (textEdit && textEdit.el === el) textEdit.beforeHtml = after.html;
      emitChange(sizeOp); emit('selectionchange', { selection: selectionInfo(el) });
      return { op: sizeOp };
    }
    var op = styleMutate(el, function (node) {
      Object.keys(styles || {}).forEach(function (key) {
        var v = styles[key];
        if (v == null || v === '') node.style.removeProperty(key);
        else node.style.setProperty(key, String(v));
      });
    }, '修改样式');
    return { op: op };
  }

  function setAttrs(elementId, attrs) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var before = {}, after = {};
    Object.keys(attrs || {}).forEach(function (k) {
      before[k] = el.getAttribute(k);
      if (attrs[k] == null) el.removeAttribute(k);
      else el.setAttribute(k, String(attrs[k]));
      after[k] = el.getAttribute(k);
    });
    var op = makeOp({ type: 'attr', label: '修改属性', elementId: el.dataset.wpxEl, slideIndex: slideIndexOf(el), before: { attrs: before }, after: { attrs: after } });
    emitChange(op);
    return { op: op };
  }

  function moveElement(elementId, dx, dy) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var before = parseTranslate(el);
    var op = styleMutate(el, function () { setTranslate(el, before.x + (dx || 0), before.y + (dy || 0)); }, '移动元素');
    return { op: op };
  }

  function resizeElement(elementId, w, h, x, y) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var before = parseTranslate(el);
    var beforeRect = rectInStage(el);
    var op = styleMutate(el, function () {
      if (w != null) el.style.width = round(w) + 'px';
      if (h != null) el.style.height = round(h) + 'px';
      if (x != null || y != null) {
        var baseX = beforeRect.x - before.x;
        var baseY = beforeRect.y - before.y;
        setTranslate(el, (x != null ? x : beforeRect.x) - baseX, (y != null ? y : beforeRect.y) - baseY);
      }
    }, '调整大小');
    return { op: op, rect: rectInStage(el) };
  }

  function rotateElement(elementId, deg) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var op = styleMutate(el, function () { setRotate(el, deg || 0); }, '旋转元素');
    return { op: op };
  }

  function absoluteSize(params) {
    var el=elementById(params.elementId);
    if(!el)throw new Error('元素不存在');
    if(el.dataset.wpxLocked==='1')throw new Error('元素已锁定');
    var rect=rectInStage(el), w=Number(params.w), h=Number(params.h);
    if(!(w>0)&&!(h>0))throw new Error('请填写大于 0 的目标像素尺寸');
    var sx=w>0?w/rect.w:h/rect.h, sy=h>0?h/rect.h:sx;
    if(params.keepRatio!==false)sy=sx;
    if(!isFinite(sx)||!isFinite(sy)||sx<=0||sy<=0||sx>100||sy>100)throw new Error('目标尺寸超出可缩放范围');
    var op=styleMutate(el,function(){
      var cs=getComputedStyle(el),parts=String(cs.scale||'none').split(/\s+/),ax=parseFloat(parts[0])||1,ay=parseFloat(parts[1])||ax;
      var tr=parseTranslate(el);
      el.style.setProperty('scale',String(Math.round(ax*sx*1000000)/1000000)+' '+String(Math.round(ay*sy*1000000)/1000000));
      // Preserve the visible top-left even with centered transform origins.
      var next=rectInStage(el);setTranslate(el,tr.x+rect.x-next.x,tr.y+rect.y-next.y);
    },'调整整体绝对大小');
    setSelected(el);
    return {op:op,rect:rectInStage(el)};
  }

  /* ---------- 连续变换（拖动/缩放/旋转预览） ---------- */
  function beginTransform(elementId) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    transformState = {
      el: el,
      elementId: el.dataset.wpxEl,
      slideIndex: slideIndexOf(el),
      beforeStyle: styleSnapshot(el),
      beforeRect: rectInStage(el),
      beforeTranslate: parseTranslate(el),
      beforeRotate: parseRotate(el),
    };
    return { ok: true, before: { rect: transformState.beforeRect, translate: transformState.beforeTranslate, rotate: transformState.beforeRotate } };
  }

  function updateTransform(params) {
    if (!transformState) throw new Error('没有进行中的变换');
    var el = transformState.el;
    var base = transformState;
    var rect = params.rect || null;
    if (rect) {
      if (rect.w != null) el.style.width = round(rect.w) + 'px';
      if (rect.h != null) el.style.height = round(rect.h) + 'px';
      var baseX = base.beforeRect.x - base.beforeTranslate.x;
      var baseY = base.beforeRect.y - base.beforeTranslate.y;
      if (rect.x != null || rect.y != null) {
        setTranslate(el, (rect.x != null ? rect.x : base.beforeRect.x) - baseX, (rect.y != null ? rect.y : base.beforeRect.y) - baseY);
      }
      if (rect.rotate != null) setRotate(el, rect.rotate);
    } else {
      var mode = params.mode || 'move';
      if (mode === 'move') {
        setTranslate(el, base.beforeTranslate.x + (params.dx || 0), base.beforeTranslate.y + (params.dy || 0));
      } else if (mode === 'resize') {
        if (params.w != null) el.style.width = round(params.w) + 'px';
        if (params.h != null) el.style.height = round(params.h) + 'px';
        if (params.dx || params.dy) setTranslate(el, base.beforeTranslate.x + (params.dx || 0), base.beforeTranslate.y + (params.dy || 0));
      } else if (mode === 'rotate') {
        setRotate(el, params.deg || 0);
      }
    }
    return { ok: true, rect: rectInStage(el) };
  }

  function commitTransform() {
    if (!transformState) return { op: null };
    var st = transformState;
    transformState = null;
    var after = styleSnapshot(st.el);
    if (after === st.beforeStyle) return { op: null };
    var op = makeOp({
      type: 'style',
      label: '变换元素',
      elementId: st.elementId,
      slideIndex: st.slideIndex,
      before: { cssText: st.beforeStyle },
      after: { cssText: after },
    });
    emitChange(op);
    return { op: op };
  }

  function cancelTransform() {
    if (!transformState) return { ok: true };
    try { transformState.el.setAttribute('style', transformState.beforeStyle); } catch (e) { }
    transformState = null;
    return { ok: true };
  }

  /* ======================================================================
     插入 / 删除 / 复制
     ====================================================================== */
  function activeSlide() {
    return slides[currentIndex] || slides[0] || null;
  }

  function makeElement(spec) {
    var type = spec.type || 'text';
    var el;
    if (type === 'image') {
      el = document.createElement('img');
      el.className = 'wpx-el wpx-image';
      el.src = spec.src || '';
      el.alt = spec.alt || '';
      if (spec.objectFit) el.style.objectFit = spec.objectFit;
    } else if (type === 'shape') {
      el = document.createElement('div');
      el.className = 'wpx-el wpx-shape';
      var shape = spec.shape || spec.kind || 'rect';
      applyShape(el, shape, spec);
    } else if (type === 'html') {
      el = document.createElement('div');
      el.className = 'wpx-el wpx-html';
      el.innerHTML = spec.html || spec.content || '';
    } else {
      el = document.createElement('div');
      el.className = 'wpx-el wpx-text';
      el.innerHTML = spec.html || spec.content || '双击编辑文字';
      if (!spec.html && !spec.content) el.textContent = '双击编辑文字';
      el.style.cssText = 'white-space:pre-wrap;overflow-wrap:break-word;';
      var st = spec.styles || {};
      Object.keys(st).forEach(function (k) { el.style.setProperty(k, String(st[k])); });
      if (!st['font-size'] && !st.fontSize) el.style.fontSize = '64px';
      if (!st['color'] && !st.color) el.style.color = 'var(--wpx-fg,#F2EAE0)';
      if (!st['font-family'] && !st.fontFamily) el.style.fontFamily = 'var(--wpx-serif,serif)';
      if (!st['line-height'] && !st.lineHeight) el.style.lineHeight = '1.25';
    }
    el.dataset.wpxEl = genId('e');
    el.dataset.wpxType = type;
    el.style.left = round(spec.x != null ? spec.x : 200) + 'px';
    el.style.top = round(spec.y != null ? spec.y : 200) + 'px';
    el.style.width = round(spec.w != null ? spec.w : (type === 'image' ? 480 : 600)) + 'px';
    el.style.height = round(spec.h != null ? spec.h : (type === 'image' ? 320 : (type === 'shape' ? 120 : 'auto'))) + 'px';
    if (type !== 'image' && type !== 'shape' && spec.h == null) el.style.height = 'auto';
    if (spec.fill && type === 'shape') el.style.background = spec.fill;
    if (spec.rotate) setRotate(el, spec.rotate);
    return el;
  }

  function applyShape(el, shape, spec) {
    var fill = spec.fill || 'var(--wpx-accent,#E1402B)';
    var stroke = spec.stroke || '';
    var sw = spec.strokeWidth != null ? spec.strokeWidth : 0;
    el.style.background = fill;
    if (stroke) { el.style.border = sw + 'px solid ' + stroke; }
    if (spec.radius != null) el.style.borderRadius = spec.radius + 'px';
    if (shape === 'circle') el.style.borderRadius = '50%';
    else if (shape === 'ellipse') el.style.borderRadius = '50%';
    else if (shape === 'line') { el.style.height = (spec.h != null ? spec.h : Math.max(1, sw || 2)) + 'px'; el.style.background = fill; }
    else if (shape === 'triangle') { el.style.clipPath = 'polygon(50% 0,100% 100%,0 100%)'; }
    else if (shape === 'arrow') {
      el.style.background = 'none';
      el.innerHTML = '<svg viewBox="0 0 100 40" preserveAspectRatio="none" style="width:100%;height:100%;display:block"><path d="M0 20 H78 M60 2 L98 20 L60 38" fill="none" stroke="' + fill + '" stroke-width="' + (sw || 4) + '" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    } else if (shape === 'star') {
      el.style.clipPath = 'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)';
    } else if (shape === 'diamond') {
      el.style.clipPath = 'polygon(50% 0,100% 50%,50% 100%,0 50%)';
    } else if (shape === 'hexagon') {
      el.style.clipPath = 'polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)';
    }
  }

  function insertElement(spec) {
    var slide = activeSlide();
    if (!slide) throw new Error('没有可用幻灯片');
    var canvas = canvasOf(slide);
    if (!canvas) throw new Error('幻灯片结构异常');
    var el = makeElement(spec || {});
    if(RAW_MODE&&el.querySelector('[data-wds-three]')){
      el.setAttribute('data-wds-three-raw-scale','');
      el.style.position='absolute';
      el.style.boxSizing='border-box';
    }
    canvas.appendChild(el);
    var index = Array.prototype.indexOf.call(canvas.children, el);
    var op = makeOp({
      type: 'insert',
      label: spec.label || '插入元素',
      elementId: el.dataset.wpxEl,
      slideIndex: currentIndex,
      before: null,
      after: { index: index, html: el.outerHTML, slideId: slide.dataset.id },
    });
    emitChange(op);
    setSelected(el);
    return { elementId: el.dataset.wpxEl, op: op };
  }

  /** 把一段元素 HTML 插入指定页（用于「复制到所有页」等批量操作） */
  function insertElementHtml(params) {
    params = params || {};
    if (RAW_MODE && !params.favorite) throw new Error('兼容模式不支持批量插入（原稿结构可能不同）');
    var index = params.slideIndex != null ? params.slideIndex : currentIndex;
    var slide = RAW_MODE ? activeSlide() : slides[index];
    if (!slide) throw new Error('幻灯片不存在');
    var canvas = canvasOf(slide);
    if (!canvas) throw new Error('幻灯片结构异常');
    var html = String(params.html || '').trim();
    if (!html) throw new Error('缺少 HTML');
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var node = tmp.firstElementChild;
    if (!node) throw new Error('HTML 解析失败');
    reassignIds(node);
    canvas.appendChild(node);
    if (!node.dataset.wpxEl) node.dataset.wpxEl = genId('e');
    var pos = Array.prototype.indexOf.call(canvas.children, node);
    var op = makeOp({
      type: 'insert',
      label: params.label || '插入元素',
      elementId: node.dataset.wpxEl,
      slideIndex: index,
      before: null,
      after: { index: pos, html: node.outerHTML, slideId: slide.dataset.id },
    });
    emitChange(op);
    if (params.favorite) setSelected(node);
    return { elementId: node.dataset.wpxEl, op: op };
  }

  function deleteElement(elementId) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var slide = el.closest('.wpx-slide') || (RAW_MODE ? el.closest('.slide, [data-slide]') : null);
    var rawLoc = RAW_MODE ? rawLocate(el) : null;
    var canvas = canvasOf(slide);
    var index = canvas ? Array.prototype.indexOf.call(canvas.children, el) : 0;
    var html = el.outerHTML;
    var slideId = slide ? (slide.dataset.id || slide.id || '') : '';
    var slideIndex = slideIndexOf(el);
    if (textEdit && textEdit.el === el) endTextEdit();
    el.remove();
    if (selectedId === elementId) { selectedId = null; emit('selectionchange', { selection: null }); }
    var op = makeOp({ type: 'delete', label: '删除元素', elementId: elementId, slideIndex: slideIndex, before: { index: index, html: html, slideId: slideId, loc: rawLoc }, after: null });
    emitChange(op);
    return { op: op };
  }

  function duplicateElement(elementId) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var canvas = canvasOf(el.closest('.wpx-slide'));
    var clone = el.cloneNode(true);
    cleanThreeTree(clone);
    reassignIds(clone);
    var t = parseTranslate(clone);
    setTranslate(clone, t.x + 24, t.y + 24);
    el.after(clone);
    var index = Array.prototype.indexOf.call(canvas.children, clone);
    var op = makeOp({ type: 'insert', label: '复制元素', elementId: clone.dataset.wpxEl, slideIndex: currentIndex, before: null, after: { index: index, html: clone.outerHTML, slideId: activeSlide().dataset.id } });
    emitChange(op);
    setSelected(clone);
    return { elementId: clone.dataset.wpxEl, op: op };
  }

  function reassignIds(root) {
    if (root.nodeType !== 1) return;
    if (root.dataset && root.dataset.wpxEl != null) root.dataset.wpxEl = genId('e');
    $$('[data-wpx-el]', root).forEach(function (n) { n.dataset.wpxEl = genId('e'); });
  }

  function getElementHtml(elementId) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    return { html: sourceHtml(el) };
  }

  function captureFavorite(elementId) {
    if (textEdit) endTextEdit();
    var el = elementById(elementId);
    if (!el) throw new Error('请先选择要收藏的元素');
    var clone = el.cloneNode(true), originals = [el].concat(Array.from(el.querySelectorAll('*'))), copies = [clone].concat(Array.from(clone.querySelectorAll('*')));
    if (originals.length > 2500) throw new Error('元素结构过大，请选择更小的部分收藏');
    var css = [], animations = new Set(), fonts = new Set(), prefix = 'favorite-' + genId('p');
    function localReferences(value) {
      return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, function (all, quote, url) {
        try {
          var resolved = new URL(url, document.baseURI), current = new URL(document.baseURI);
          if (resolved.hash && resolved.origin === current.origin && resolved.pathname === current.pathname && resolved.search === current.search && el.querySelector('[id="' + CSS.escape(decodeURIComponent(resolved.hash.slice(1))) + '"]')) return 'url(' + resolved.hash + ')';
        } catch (e) {}
        return all;
      });
    }
    originals.forEach(function (source, i) {
      var selected = source.classList.contains('wpx-selected'), hovered = source.classList.contains('wpx-hover');
      source.classList.remove('wpx-selected', 'wpx-hover');
      try {
      var target = copies[i], cs = getComputedStyle(source);
      target.removeAttribute('contenteditable'); target.classList.remove('wpx-selected', 'wpx-hover');
      // Freeze the element's actual appearance, including inherited styles and
      // resolved CSS variables, without copying unrelated slide styles/scripts.
      var properties = Array.from(cs).filter(function (key) { return !key.startsWith('--') && !['caret-color', 'cursor'].includes(key); });
      properties.forEach(function (key) { target.style.setProperty(key, localReferences(cs.getPropertyValue(key))); });
      fonts.add(cs.fontFamily);
      cs.animationName.split(',').forEach(function (name) { animations.add(name.trim()); });
      ['before', 'after'].forEach(function (kind) {
        var ps = getComputedStyle(source, '::' + kind);
        if (!ps.content || ps.content === 'none' || ps.content === 'normal') return;
        var token = prefix + '-' + i; target.setAttribute('data-favorite-pseudo', token);
        var rules = Array.from(ps).filter(function (key) { return !key.startsWith('--'); }).map(function (key) { return key + ':' + localReferences(ps.getPropertyValue(key)) + ';'; }).join('');
        css.push('[data-favorite-pseudo="' + token + '"]::' + kind + '{' + rules + '}');
      });
      Array.from(target.attributes).forEach(function (a) { if (/^on/i.test(a.name) || a.name === 'srcdoc') target.removeAttribute(a.name); });
      if (source.tagName === 'IMG') { target.setAttribute('src', source.currentSrc || source.src); target.removeAttribute('srcset'); }
      ['src', 'poster'].forEach(function (key) { var value = target.getAttribute(key); if (value && !value.startsWith('data:')) target.setAttribute(key, new URL(value, document.baseURI).href); });
      if (source.namespaceURI === 'http://www.w3.org/2000/svg' && source.tagName.toLowerCase() === 'image') {
        ['href','xlink:href'].forEach(function (key) { var value=target.getAttribute(key); if(value&&!value.startsWith('data:'))target.setAttribute(key,new URL(value,document.baseURI).href); });
      }
      } finally {
        if (selected) source.classList.add('wpx-selected');
        if (hovered) source.classList.add('wpx-hover');
      }
    });
    function collect(rules) {
      Array.from(rules || []).forEach(function (rule) {
        if (rule.type === 5 && Array.from(fonts).some(function (f) { return f.replace(/["']/g,'').includes((rule.style.fontFamily || '').replace(/["']/g,'')); })) css.push(rule.cssText.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,function(all,q,url){return 'url("'+new URL(url,rule.parentStyleSheet.href||document.baseURI).href+'")';}));
        else if (rule.type === 7 && animations.has(rule.name)) css.push(rule.cssText);
        else if (rule.cssRules && rule.type !== 7) collect(rule.cssRules);
      });
    }
    Array.from(document.styleSheets).forEach(function(sheet){try{collect(sheet.cssRules);}catch(e){}});
    cleanThreeTree(clone);
    clone.querySelectorAll('script:not([type="application/json"]),iframe,object,embed,link,style').forEach(function(n){n.remove();});
    if (clone.matches('script,iframe,object,embed,link,style,canvas')) throw new Error('请选择包含内容的元素，不能直接收藏脚本或画布');
    var cs = getComputedStyle(el), rect = rectInStage(el), w = el.offsetWidth || parseFloat(cs.width) || rect.w, h = el.offsetHeight || parseFloat(cs.height) || rect.h;
    clone.style.position = 'absolute'; clone.style.left = '0px'; clone.style.top = '0px'; clone.style.right = 'auto'; clone.style.bottom = 'auto'; clone.style.margin = '0';
    clone.style.width = w + 'px'; clone.style.height = h + 'px'; clone.style.animation = 'none'; clone.style.opacity = '1'; clone.style.visibility = 'visible';
    // Keep visible rotation/scale, but normalize its bounding box to the new origin.
    var matrix = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
    matrix.e = 0; matrix.f = 0;
    var scale = String(cs.scale || '').split(/\s+/), sx = parseFloat(scale[0]) || 1, sy = parseFloat(scale[1]) || sx;
    var rotation = String(cs.rotate || '').split(/\s+/).pop(), angle = parseFloat(rotation) || 0;
    if (/rad$/.test(rotation)) angle *= 180 / Math.PI;
    else if (/turn$/.test(rotation)) angle *= 360;
    matrix = new DOMMatrix().rotate(angle).scale(sx,sy).multiply(matrix);
    var points = [[0,0],[w,0],[0,h],[w,h]].map(function(p){return new DOMPoint(p[0],p[1]).matrixTransform(matrix);});
    var minX = Math.min.apply(null,points.map(function(p){return p.x;})), minY = Math.min.apply(null,points.map(function(p){return p.y;}));
    clone.style.transformOrigin = '0 0'; clone.style.translate = 'none'; clone.style.rotate = 'none'; clone.style.scale = 'none';
    clone.style.transform = 'matrix(' + [matrix.a,matrix.b,matrix.c,matrix.d,-minX,-minY].join(',') + ')';
    w = Math.max.apply(null,points.map(function(p){return p.x;})) - minX;
    h = Math.max.apply(null,points.map(function(p){return p.y;})) - minY;
    return { html: clone.outerHTML, css: css.join('\n'), w: w, h: h, type: el.querySelector('[data-wds-three]') || el.matches('[data-wds-three]') ? 'three' : el.dataset.wpxType || 'html', description: (el.textContent || el.getAttribute('alt') || '').trim().slice(0,500) };
  }

  function setElementHtml(elementId, html) {
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var before = sourceHtml(el,true);
    el.innerHTML = String(html || '');
    var op = makeOp({ type: 'html', label: '修改元素内容', elementId: elementId, slideIndex: slideIndexOf(el), before: { html: before }, after: { html: el.innerHTML } });
    emitChange(op);
    setSelected(el);
    return { op: op };
  }

  function setText(elementId, html) {
    return setElementHtml(elementId, html);
  }

  /* ======================================================================
     动画
     ====================================================================== */
  function normalizeAnim(anim, params, name) {
    if (anim === null) return { name: null, params: {} };
    if (typeof anim === 'string') return { name: anim, params: params || {} };
    if (anim && typeof anim === 'object') return { name: anim.name || name || null, params: anim.params || params || {} };
    return { name: name || null, params: params || {} };
  }

  function setAnimation(params) {
    var el = elementById(params.elementId);
    if (!el) throw new Error('元素不存在');
    var norm = normalizeAnim(params.anim, params.params, params.name);
    var before = readAnim(el);
    if (!norm.name) {
      el.removeAttribute('data-wpx-anim');
      el.removeAttribute('data-wpx-anim-params');
    } else {
      el.setAttribute('data-wpx-anim', norm.name);
      el.setAttribute('data-wpx-anim-params', JSON.stringify(norm.params || {}));
    }
    var op = makeOp({ type: 'anim', label: norm.name ? '添加动画' : '移除动画', elementId: el.dataset.wpxEl, slideIndex: slideIndexOf(el), before: before, after: readAnim(el) });
    emitChange(op);
    return { op: op };
  }

  function getSlideAnimations(index) {
    var slide = RAW_MODE
      ? rawSlideEls[index != null ? index : rawCurrentIndex()]
      : slides[index != null ? index : currentIndex];
    if (!slide) return [];
    return $$('[data-wpx-anim]', slide).map(function (el, i) {
      var anim = readAnim(el);
      var params = anim ? anim.params : {};
      return {
        elementId: el.dataset.wpxEl,
        name: anim ? anim.name : '',
        params: params,
        label: (window.WPX_FX && window.WPX_FX[anim.name] && window.WPX_FX[anim.name].label) || anim.name,
        trigger: params.trigger || 'auto',
        duration: params.duration != null ? params.duration : 900,
        delay: params.delay != null ? params.delay : 0,
        rect: rectInStage(el),
        text: (el.innerText || '').slice(0, 60),
        order: i,
      };
    });
  }

  function previewAnimation(params) {
    if (RAW_MODE) {
      var wid = params && params.elementId;
      if (window.__WPW__) return window.__WPW__.preview(wid);
      if (window.__WPTL__) window.__WPTL__.play();
      return { ok: true };
    }
    var elementId = params && params.elementId;    if (!elementId) {
      if (runtime) runtime.replay();
      return { ok: true };
    }
    var el = elementById(elementId);
    if (!el) throw new Error('元素不存在');
    var anim = readAnim(el);
    if (!anim) return { ok: false, error: '该元素没有动画' };
    var fx = window.WPX_FX && window.WPX_FX[anim.name];
    if (!fx) return { ok: false, error: '未知动画: ' + anim.name };
    var wasEditing = document.body.classList.contains('wpx-editing');
    document.body.classList.remove('wpx-editing');
    try { fx.play(el, anim.params || {}, { instant: false, editing: false, stage: stageEl }); } catch (e) { }
    setTimeout(function () { if (wasEditing) document.body.classList.add('wpx-editing'); }, 2200);
    return { ok: true };
  }

  /** 完整预览切换：native 用运行时克隆两页真实播放；raw 用原稿真实速度切换一次再切回 */
  function previewTransition(params) {
    params = params || {};
    if (RAW_MODE) return rawPreviewTransition(params);
    if (!runtime || typeof runtime.previewTransition !== 'function') {
      throw new Error('当前播放运行时过旧，重新打开工程会自动升级后再试');
    }
    return runtime.previewTransition(params.name, params.duration).then(function (ok) { return { ok: !!ok }; });
  }

  /* ======================================================================
     时间线（独立于分页的全局动画轨道）
     ====================================================================== */
  function rawTimelinePlayer() {
    return window.__WPTL__ || null;
  }

  function getTimeline() {
    if (RAW_MODE) {
      var pl = rawTimelinePlayer();
      return { timeline: pl ? pl.getTimeline() : null };
    }
    var node = document.getElementById('wpx-timeline');
    var data = null;
    if (node) { try { data = JSON.parse(node.textContent || 'null'); } catch (e) { data = null; } }
    if (!data && runtime && runtime.getTimeline) data = runtime.getTimeline();
    return { timeline: data };
  }

  function setTimeline(params) {
    var data = params && params.timeline ? params.timeline : null;
    var before = getTimeline().timeline;
    var changed = JSON.stringify(before) !== JSON.stringify(data);
    var op = changed && !(params && params.silent) ? makeOp({ type: 'timeline', label: '修改动画时间线', before: { timeline: before }, after: { timeline: data } }) : null;
    if (RAW_MODE) {
      var pl = rawTimelinePlayer();
      if (pl) pl.setTimeline(data);
      if (op) emitChange(op);
      return { ok: true, timeline: data, raw: true, op: op };
    }
    var node = document.getElementById('wpx-timeline');
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = 'wpx-timeline';
      (document.body || document.head).appendChild(node);
    }
    node.textContent = JSON.stringify(data || { version: 1, duration: 8000, tracks: [] });
    if (runtime && runtime.setTimeline) runtime.setTimeline(data);
    if (op) emitChange(op);
    return { ok: true, timeline: data, op: op };
  }

  function timelineCall(method, params) {
    if (RAW_MODE) {
      var pl = rawTimelinePlayer();
      if (!pl) throw new Error('兼容模式时间线播放器未就绪，请重新打开工程');
      var map = {
        timelinePlay: 'play',
        timelinePause: 'pause',
        timelineSeek: 'seek',
        timelineGetState: 'getState',
        timelineRefresh: 'refresh',
      };
      var fn = pl[map[method] || method];
      if (typeof fn !== 'function') throw new Error('时间线播放器不支持 ' + method);
      var out = fn.call(pl, params && params.time);
      return out == null ? { ok: true } : out;
    }
    if (!runtime || typeof runtime[method] !== 'function') throw new Error('运行时未就绪或过旧，重新打开工程自动升级');
    return runtime[method](params && params.time);
  }

  /** 贯穿层：插入到 stage（不属于任何单页），可被时间线跨页驱动（屏闪/飞入元素等） */
  function insertGlobalElement(params) {
    var stage = document.getElementById('wpx-stage') || document.getElementById('stage');
    if (!stage) throw new Error('缺少舞台');
    var html = String(params && params.html || '').trim();
    if (!html) throw new Error('缺少 HTML');
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var node = tmp.firstElementChild;
    if (!node) throw new Error('HTML 解析失败');
    if (!node.dataset.wpxTlLayer) node.dataset.wpxTlLayer = '1';
    if (!node.style.position) node.style.position = 'absolute';
    if (!node.style.pointerEvents) node.style.pointerEvents = 'none';
    stage.appendChild(node);
    if (!node.dataset.wpxEl) node.dataset.wpxEl = genId('tl');
    return { ok: true, elementId: node.dataset.wpxEl, selector: '[data-wpx-el="' + node.dataset.wpxEl + '"]', html: node.outerHTML };
  }

  function deleteGlobalElement(params) {
    var selector = String(params && params.selector || '').trim();
    if (!selector) throw new Error('缺少 selector');
    var el = document.querySelector(selector);
    if (!el) return { ok: false, error: '元素不存在' };
    el.remove();
    return { ok: true };
  }

  /** 时间线关键帧取值：读取元素当前计算样式（用于在播放头位置抓帧） */
  function decomposeMatrix(t) {
    if (!t || t === 'none') return { x: 0, y: 0, scale: 1, rotate: 0 };
    var m = t.match(/matrix\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(',').map(parseFloat);
      return { x: p[4] || 0, y: p[5] || 0, scale: Math.sqrt(p[0] * p[0] + p[1] * p[1]) || 1, rotate: Math.atan2(p[1], p[0]) * 180 / Math.PI };
    }
    var m3 = t.match(/matrix3d\(([^)]+)\)/);
    if (m3) {
      var q = m3[1].split(',').map(parseFloat);
      return { x: q[12] || 0, y: q[13] || 0, scale: Math.sqrt(q[0] * q[0] + q[1] * q[1]) || 1, rotate: Math.atan2(q[1], q[0]) * 180 / Math.PI };
    }
    return { x: 0, y: 0, scale: 1, rotate: 0 };
  }

  function existsSelector(params) {
    var selector = String((params && params.selector) || '').trim();
    if (!selector) return { found: false, count: 0 };
    try {
      var list = $$(selector);
      return { found: list.length > 0, count: list.length };
    } catch (e) { return { found: false, count: 0, error: '选择器无效' }; }
  }

  function getTimelineStyle(params) {
    var el = null;
    if (params && params.selector) { try { el = document.querySelector(params.selector); } catch (e) { el = null; } }
    if (!el && params && params.elementId) el = elementById(params.elementId);
    if (!el && selectedId) el = elementById(selectedId);
    if (!el) throw new Error('未选中元素');
    var cs = getComputedStyle(el);
    var tr = decomposeMatrix(cs.transform);
    var ind = { x: 0, y: 0, scale: 1, rotate: 0 };
    var tv = cs.translate && cs.translate !== 'none' ? cs.translate.trim().split(/\s+/) : [];
    if (tv.length) { ind.x = parseFloat(tv[0]) || 0; ind.y = parseFloat(tv[1]) || 0; }
    if (cs.rotate && cs.rotate !== 'none') ind.rotate = parseFloat(cs.rotate) || 0;
    if (cs.scale && cs.scale !== 'none') { var sv = cs.scale.trim().split(/\s+/); ind.scale = parseFloat(sv[0]) || 1; }
    var blur = 0;
    var bm = /blur\(([\d.]+)px\)/.exec(cs.filter || '');
    if (bm) blur = parseFloat(bm[1]) || 0;
    return {
      elementId: el.dataset.wpxEl || null,
      rect: rectInStage(el),
      props: {
        opacity: Math.round(Number(cs.opacity) * 100) / 100,
        x: Math.round((ind.x + tr.x) * 10) / 10,
        y: Math.round((ind.y + tr.y) * 10) / 10,
        scale: Math.round(ind.scale * tr.scale * 1000) / 1000,
        rotate: Math.round((ind.rotate + tr.rotate) * 10) / 10,
        blur: blur,
        filter: cs.filter === 'none' ? 'none' : cs.filter,
        clipPath: cs.clipPath === 'none' ? 'none' : cs.clipPath,
      },
    };
  }

  /* ======================================================================
     幻灯片结构
     ====================================================================== */
  function readModel() {
    var node = document.getElementById('wpx-data');
    if (!node) return { title: document.title, w: 1920, h: 1080, slides: [] };
    try { return JSON.parse(node.textContent || '{}'); } catch (e) { return { title: document.title, w: 1920, h: 1080, slides: [] }; }
  }

  function syncModel() {
    if (RAW_MODE) return readModel();
    refreshSlides();
    var node = document.getElementById('wpx-data');
    var model = readModel();
    model.title = document.title || model.title || '未命名演示';
    model.w = 1920; model.h = 1080;
    model.slides = slides.map(function (s, i) {
      return {
        id: s.dataset.id || ('s' + (i + 1)),
        name: s.dataset.name || ('第 ' + (i + 1) + ' 页'),
        transition: s.dataset.transition || 'fade',
      };
    });
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = 'wpx-data';
      var runtimeScript = document.getElementById('wpx-runtime');
      if (runtimeScript) runtimeScript.before(node);
      else document.body.appendChild(node);
    }
    node.textContent = JSON.stringify(model);
    return model;
  }

  function newSlideSection(opts) {
    opts = opts || {};
    var slide = document.createElement('section');
    slide.className = 'wpx-slide';
    slide.dataset.id = opts.id || ('s' + Math.random().toString(36).slice(2, 6));
    slide.dataset.name = opts.name || '新幻灯片';
    slide.dataset.transition = opts.transition || 'fade';
    if (opts.bg) slide.dataset.bg = opts.bg;
    var canvas = document.createElement('div');
    canvas.className = 'wpx-canvas';
    if (opts.canvasClass) canvas.className += ' ' + opts.canvasClass;
    if (opts.html) canvas.innerHTML = opts.html;
    slide.appendChild(canvas);
    return slide;
  }

  function refreshRuntime() {
    if (RAW_MODE) { refreshSlides(); return; }
    if (runtime && typeof runtime.refresh === 'function') runtime.refresh();
    refreshSlides();
    ensureElementIds();
    syncModel();
  }

  function addSlide(params) {
    if (RAW_MODE) throw new Error('兼容模式不支持修改页结构；可先转换为可编辑工程');
    params = params || {};
    var after = params.afterIndex != null ? params.afterIndex : currentIndex;
    var slide = newSlideSection({ name: params.name || '新幻灯片', html: params.html || '' });
    var ref = slides[after];
    if (ref && ref.parentNode) ref.after(slide);
    else stageEl.appendChild(slide);
    refreshRuntime();
    var index = slides.indexOf(slide);
    if (runtime) runtime.go(index, { instant: true });
    currentIndex = index;
    var op = makeOp({ type: 'slide-add', label: '新增幻灯片', slideIndex: index, elementId: null, before: null, after: { index: index, html: slide.outerHTML, id: slide.dataset.id } });
    emitChange(op);
    return { index: index, op: op };
  }

  function duplicateSlide(params) {
    if (RAW_MODE) throw new Error('兼容模式不支持修改页结构；可先转换为可编辑工程');
    var index = params && params.index != null ? params.index : currentIndex;
    var src = slides[index];
    if (!src) throw new Error('幻灯片不存在');
    var clone = src.cloneNode(true);
    cleanThreeTree(clone);
    clone.dataset.id = 's' + Math.random().toString(36).slice(2, 6);
    clone.dataset.name = (src.dataset.name || '幻灯片') + ' 副本';
    $$('[data-wpx-el]', clone).forEach(function (n) { n.dataset.wpxEl = genId('e'); });
    var canvas = canvasOf(clone);
    if (canvas) canvas.classList.remove('live');
    clone.classList.remove('is-active');
    src.after(clone);
    refreshRuntime();
    var newIndex = slides.indexOf(clone);
    if (runtime) runtime.go(newIndex, { instant: true });
    currentIndex = newIndex;
    var op = makeOp({ type: 'slide-add', label: '复制幻灯片', slideIndex: newIndex, before: null, after: { index: newIndex, html: clone.outerHTML, id: clone.dataset.id } });
    emitChange(op);
    return { index: newIndex, op: op };
  }

  function deleteSlide(params) {
    if (RAW_MODE) throw new Error('兼容模式不支持修改页结构；可先转换为可编辑工程');
    var index = params && params.index != null ? params.index : currentIndex;
    if (slides.length <= 1) throw new Error('至少保留一页');
    var slide = slides[index];
    if (!slide) throw new Error('幻灯片不存在');
    var html = slide.outerHTML;
    var id = slide.dataset.id;
    slide.remove();
    refreshRuntime();
    var next = Math.max(0, Math.min(index, slides.length - 1));
    if (runtime) runtime.go(next, { instant: true });
    currentIndex = next;
    var op = makeOp({ type: 'slide-delete', label: '删除幻灯片', slideIndex: index, before: { index: index, html: html, id: id }, after: null });
    emitChange(op);
    return { op: op };
  }

  function moveSlide(params) {
    if (RAW_MODE) throw new Error('兼容模式不支持修改页结构；可先转换为可编辑工程');
    var from = params.from, to = params.to;
    if (from == null || to == null) throw new Error('缺少参数');
    if (from === to) return { op: null };
    var slide = slides[from];
    if (!slide) throw new Error('幻灯片不存在');
    var ref = slides[to];
    if (from < to) ref.after(slide);
    else ref.before(slide);
    refreshRuntime();
    var newIndex = slides.indexOf(slide);
    if (runtime) runtime.go(newIndex, { instant: true });
    currentIndex = newIndex;
    var op = makeOp({ type: 'slide-move', label: '移动幻灯片', slideIndex: newIndex, before: { from: from, to: to }, after: { from: from, to: to } });
    emitChange(op);
    return { op: op, index: newIndex };
  }

  function setSlideAttrs(params) {
    if (RAW_MODE && params.attrs && (params.attrs.transition != null || params.attrs.duration != null)) {
      throw new Error('原稿切换由网页自己的脚本控制，不能替换成预设切换');
    }
    if (RAW_MODE && params.attrs && params.attrs.transitionFx != null) {
      var rs = rawSlideEls[params.index != null ? params.index : rawCurrentIndex()];
      if (!rs) throw new Error('页面不存在');
      if (!params.attrs.transitionFx || params.attrs.transitionFx === 'none') rs.removeAttribute('data-wpx-tr-fx');
      else rs.setAttribute('data-wpx-tr-fx', String(params.attrs.transitionFx));
      return { ok: true, raw: true, transitionFx: params.attrs.transitionFx };
    }
    var index = params.index != null ? params.index : currentIndex;
    var slide = slides[index];
    if (!slide) throw new Error('幻灯片不存在');
    var attrs = params.attrs || {};
    var before = {}, after = {};
    if (attrs.name != null) { before.name = slide.dataset.name; slide.dataset.name = String(attrs.name); after.name = slide.dataset.name; }
    if (attrs.transition != null) { before.transition = slide.dataset.transition; slide.dataset.transition = String(attrs.transition); after.transition = slide.dataset.transition; }
    if (attrs.transitionFx != null) {
      before.transitionFx = slide.dataset.wpxTrFx;
      if (!attrs.transitionFx || attrs.transitionFx === 'none') slide.removeAttribute('data-wpx-tr-fx');
      else slide.setAttribute('data-wpx-tr-fx', String(attrs.transitionFx));
      after.transitionFx = slide.dataset.wpxTrFx;
    }
    if (attrs.duration != null) { before.duration = slide.dataset.transitionDuration; slide.dataset.transitionDuration = String(attrs.duration); after.duration = slide.dataset.transitionDuration; }
    if (attrs.bg != null) {
      before.bg = slide.dataset.bg;
      slide.dataset.bg = String(attrs.bg);
      after.bg = slide.dataset.bg;
      var canvas = canvasOf(slide);
      if (canvas) { if (attrs.bg === '') { canvas.style.removeProperty('background'); slide.style.removeProperty('background'); } else { slide.style.background = attrs.bg; } }
    }
    syncModel();
    var op = makeOp({ type: 'slide-attrs', label: '修改幻灯片属性', slideIndex: index, before: before, after: after });
    emitChange(op);
    return { op: op };
  }

  function getSlideHtml(params) {
    var index = params && params.index != null ? params.index : currentIndex;
    var slide = slides[index];
    if (!slide) throw new Error('幻灯片不存在');
    return { html: sourceHtml(slide), css: collectStyles() };
  }

  function setSlideHtml(params) {
    var index = params.index != null ? params.index : currentIndex;
    var slide = slides[index];
    if (!slide) throw new Error('幻灯片不存在');
    var before = slide.outerHTML;
    var tmp = document.createElement('div');
    tmp.innerHTML = String(params.html || '');
    var next = tmp.querySelector(':scope > section.wpx-slide');
    if (!next) {
      if (!tmp.innerHTML.trim()) throw new Error('HTML 无效');
      // Tools may provide canvas contents (including a leading <style>). Keep
      // the slide shell and stable ID instead of replacing it with that style.
      next = slide.cloneNode(false);
      var originalCanvas = canvasOf(slide);
      var newCanvas = originalCanvas ? originalCanvas.cloneNode(false) : document.createElement('div');
      newCanvas.classList.add('wpx-canvas'); newCanvas.innerHTML = tmp.innerHTML;
      next.appendChild(newCanvas);
    }
    if (!next.dataset.id) next.dataset.id = slide.dataset.id || ('s' + index);
    slide.replaceWith(next);
    refreshRuntime();
    var newIndex = slides.indexOf(next);
    if (runtime) runtime.go(newIndex, { instant: true });
    currentIndex = newIndex;
    var op = makeOp({ type: 'slide-html', label: '替换幻灯片 HTML', slideIndex: newIndex, before: { html: before }, after: { html: next.outerHTML } });
    emitChange(op);
    return { op: op };
  }

  /* ======================================================================
     主题 / CSS / JS / 标记
     ====================================================================== */
  function collectStyles() {
    return $$('style', document).map(function (s) { return s.textContent || ''; }).join('\n');
  }

  function getStyleEl(id, createWhere) {
    var el = document.getElementById(id);
    if (el) return el;
    el = document.createElement('style');
    el.id = id;
    if (createWhere === 'head') document.head.appendChild(el);
    else document.head.insertBefore(el, document.head.firstChild);
    return el;
  }

  function setDeckCss(css) {
    var el = getStyleEl('wpx-css', 'head');
    var before = el.textContent || '';
    el.textContent = String(css || '');
    var op = makeOp({ type: 'deck-css', label: '修改全局 CSS', before: { css: before }, after: { css: el.textContent } });
    emitChange(op);
    return { op: op };
  }

  function getDeckCss() { var el = document.getElementById('wpx-css'); return { css: el ? el.textContent || '' : '' }; }

  function setDeckJs(js) {
    var el = document.getElementById('wpx-user-js');
    if (!el) {
      el = document.createElement('script');
      el.id = 'wpx-user-js';
      document.body.appendChild(el);
    }
    var before = el.textContent || '';
    el.textContent = String(js || '');
    var op = makeOp({ type: 'deck-js', label: '修改全局 JS', before: { js: before }, after: { js: el.textContent } });
    emitChange(op);
    return { op: op };
  }
  function getDeckJs() { var el = document.getElementById('wpx-user-js'); return { js: el ? el.textContent || '' : '' }; }

  function setThemeVars(vars) {
    if (RAW_MODE) throw new Error('兼容模式不支持主题变量；可先转换为可编辑工程，或用 deck_set_deck_css 直接改 CSS');
    var el = getStyleEl('wpx-theme', 'head');
    var before = el.textContent || '';
    var existing = before;
    Object.keys(vars || {}).forEach(function (key) {
      var value = String(vars[key]);
      var re = new RegExp('(' + key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\s*:\\s*)([^;}]+)(;?)', 'g');
      if (re.test(existing)) existing = existing.replace(re, function (m, p1, p2, p3) { return p1 + value + (p3 || ''); });
      else {
        if (/:root\s*\{/.test(existing)) existing = existing.replace(/:root\s*\{/, ':root{' + key + ':' + value + ';');
        else existing = ':root{' + key + ':' + value + ';}' + existing;
      }
    });
    el.textContent = existing;
    var op = makeOp({ type: 'theme', label: '应用主题', before: { cssText: before }, after: { cssText: el.textContent } });
    emitChange(op);
    return { op: op };
  }

  function setDeckFlags(flags) {
    flags = flags || {};
    var before = getDeckFlags();
    if (flags.grain != null) document.body.dataset.wpxGrain = flags.grain ? 'on' : 'off';
    if (flags.vignette != null) document.body.dataset.wpxVignette = flags.vignette ? 'on' : 'off';
    if (flags.clickAdvance != null) document.body.dataset.wpxClickAdvance = flags.clickAdvance ? 'on' : 'off';
    if (flags.mouseMode != null) document.body.dataset.wpxMouse = (flags.mouseMode === 'anim' || flags.mouseMode === 'off') ? flags.mouseMode : 'advance';
    if (runtime && runtime.setMouseMode && flags.mouseMode != null) runtime.setMouseMode(flags.mouseMode);
    var after = getDeckFlags();
    var op = makeOp({ type: 'deck-flags', label: '修改页面效果', before: before, after: after });
    emitChange(op);
    return { op: op };
  }

  function getDeckFlags() {
    return {
      grain: document.body.dataset.wpxGrain === 'on',
      vignette: document.body.dataset.wpxVignette === 'on',
      clickAdvance: document.body.dataset.wpxClickAdvance === 'on',
      mouseMode: document.body.dataset.wpxMouse || 'advance',
    };
  }

  /* ======================================================================
     序列化
     ====================================================================== */
  function cleanThreeTree(root) {
    root.querySelectorAll('[data-wds-three-generated]').forEach(function(n){n.remove();});
    var hosts=Array.from(root.querySelectorAll('[data-wds-three]'));
    if(root.matches&&root.matches('[data-wds-three]'))hosts.unshift(root);
    hosts.forEach(function(n){['data-wds-three-ready','data-wds-three-interacting','data-wds-three-error'].forEach(function(key){n.removeAttribute(key);});});
    var scaled=Array.from(root.querySelectorAll('[data-wds-three-raw-scale]'));
    if(root.matches&&root.matches('[data-wds-three-raw-scale]'))scaled.unshift(root);
    scaled.forEach(function(n){n.style.removeProperty('zoom');});
    return root;
  }
  function sourceHtml(node,inner) { var clone=cleanThreeTree(node.cloneNode(true));return inner?clone.innerHTML:clone.outerHTML; }
  function serialize() {
    if (RAW_MODE) return { html: rawSerialize() };
    if (textEdit) endTextEdit();
    syncModel();
    if (runtime && runtime.restorePresentationOverrides) runtime.restorePresentationOverrides();
    var clone = document.documentElement.cloneNode(true);
    cleanThreeTree(clone);
    var bridge = clone.querySelector('#wpx-bridge');
    if (bridge) bridge.remove();
    clone.querySelectorAll('#wpx-edit-style,[data-wpx-timeline-layer],[data-wpx-timeline-legacy]').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) {
      n.removeAttribute('contenteditable');
      n.removeAttribute('spellcheck');
    });
    clone.querySelectorAll('.wpx-hover,.wpx-selected').forEach(function (n) { n.classList.remove('wpx-hover', 'wpx-selected'); });
    clone.querySelectorAll('.wpx-slide').forEach(function (s) {
      s.classList.remove('is-active');
      s.style.zIndex = '';
      var canvas = s.querySelector('.wpx-canvas');
      if (canvas) canvas.classList.remove('live');
    });
    clone.querySelectorAll('.wpx-hud').forEach(function (h) { h.innerHTML = ''; });
    var stageClone = clone.querySelector('#wpx-stage');
    if (stageClone) stageClone.removeAttribute('style');
    clone.removeAttribute('style');
    var body = clone.querySelector('body');
    if (body) {
      var keep = ['wpx-body'];
      body.className = keep.join(' ');
      body.removeAttribute('contenteditable');
      body.removeAttribute('spellcheck');
      if (!body.dataset.wpxGrain) body.dataset.wpxGrain = 'off';
      if (!body.dataset.wpxVignette) body.dataset.wpxVignette = 'off';
      if (!body.dataset.wpxClickAdvance) body.dataset.wpxClickAdvance = 'off';
    }
    if (runtime && runtime.ensureVisible) runtime.ensureVisible();
    return { html: '<!doctype html>\n' + clone.outerHTML };
  }

  function getVisualState(params) {
    var slide=RAW_MODE?rawSlideEls[currentIndex]:slides[currentIndex];
    var root=stageEl||document.body,r=root.getBoundingClientRect();
    var nodes=slide?Array.from(slide.querySelectorAll('[data-wpx-el]')):[];
    var elements=nodes.slice(0,300).map(function(el){
      var rect=rectInStage(el),cs=getComputedStyle(el);
      return {elementId:el.dataset.wpxEl,tag:el.tagName.toLowerCase(),text:(el.textContent||'').trim().slice(0,500),rect:rect,
        fontSize:cs.fontSize,fontFamily:cs.fontFamily,lineHeight:cs.lineHeight,color:cs.color,display:cs.display,
        overflowX:el.scrollWidth>el.clientWidth+2,overflowY:el.scrollHeight>el.clientHeight+2,
        outsideCanvas:rect.x<-.5||rect.y<-.5||rect.x+rect.w>1920.5||rect.y+rect.h>1080.5};
    });
    var focus=null;
    if(params&&params.elementId){
      var el=elementById(params.elementId);
      if(!el||slideIndexOf(el)!==currentIndex)throw new Error('截图元素不在指定页面');
      var f=rectInStage(el),x=Math.max(0,f.x-16),y=Math.max(0,f.y-16);
      focus={x:x,y:y,w:Math.min(1920-x,f.w+32),h:Math.min(1080-y,f.h+32)};
    }
    return {index:currentIndex,coordinateSpace:{width:1920,height:1080},viewport:{x:r.left,y:r.top,width:r.width,height:r.height},focus:focus,elements:elements,totalElements:nodes.length};
  }

  function getThumb(params) {
    var index = params && params.index != null ? params.index : currentIndex;
    if (RAW_MODE) {
      refreshSlides();
      var rawEl = rawSlideEls[index];
      if (!rawEl) return { html: '', css: collectStyles(), w: 1920, h: 1080, raw: true };
      var rawClone = rawEl.cloneNode(true);
      snapshotThreeTree(rawClone,rawEl);
      rawClone.classList.add('live');
      rawClone.classList.add('active');
      return { html: rawClone.outerHTML, css: collectStyles(), w: 1920, h: 1080, raw: true };
    }
    var slide = slides[index];
    if (!slide) return { html: '', css: collectStyles(), w: 1920, h: 1080 };
    var clone = slide.cloneNode(true);
    snapshotThreeTree(clone,slide);
    clone.classList.add('is-active');
    var canvas = canvasOf(clone);
    if (canvas) canvas.classList.add('live');
    return { html: clone.outerHTML, css: collectStyles(), w: 1920, h: 1080 };
  }
  function snapshotThreeTree(clone,source) {
    var hosts=source.querySelectorAll('[data-wds-three]');
    clone.querySelectorAll('[data-wds-three]').forEach(function(host,i){
      try {
        var url=window.__WDS_THREE__.capture(hosts[i]);
        host.replaceChildren();var image=document.createElement('img');image.src=url;image.alt=hosts[i].getAttribute('aria-label')||'3D';image.style.cssText='display:block;width:100%;height:100%;object-fit:contain';host.appendChild(image);
      }catch(e){cleanThreeTree(host);}
    });
  }

  /** 兼容模式序列化：保留原稿全部 script/style，只清理编辑桥/编辑态痕迹 */
  function rawSerialize() {
    if (textEdit) endTextEdit();
    var clone = document.documentElement.cloneNode(true);
    cleanThreeTree(clone);
    clone.querySelectorAll('#wpx-bridge').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('#wpx-edit-style').forEach(function (n) { n.remove(); });
    clone.querySelectorAll('[contenteditable]').forEach(function (n) {
      n.removeAttribute('contenteditable');
      n.removeAttribute('spellcheck');
    });
    clone.querySelectorAll('.wpx-hover,.wpx-selected').forEach(function (n) { n.classList.remove('wpx-hover', 'wpx-selected'); });
    return '<!doctype html>\n' + clone.outerHTML;
  }

  /* ======================================================================
     撤销 / 重做：应用 op
     ====================================================================== */
  function insertHtmlAt(slideIndex, index, html) {
    refreshSlides();
    var slide = slides[slideIndex] || activeSlide();
    var canvas = canvasOf(slide);
    if (!canvas) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var node = tmp.firstElementChild;
    if (!node) return;
    var ref = canvas.children[index] || null;
    if (ref) canvas.insertBefore(node, ref);
    else canvas.appendChild(node);
    if (!node.dataset.wpxEl) node.dataset.wpxEl = genId('e');
  }

  function removeElementById(elementId) {
    var el = elementById(elementId);
    if (el) el.remove();
    if (selectedId === elementId) { selectedId = null; emit('selectionchange', { selection: null }); }
  }

  function insertSlideHtml(index, html) {
    refreshSlides();
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var node = tmp.firstElementChild;
    if (!node) return null;
    var ref = slides[index] || null;
    if (ref && ref.parentNode) ref.parentNode.insertBefore(node, ref);
    else stageEl.appendChild(node);
    refreshRuntime();
    return node;
  }

  function applyOp(params) {
    var op = params.op;
    var direction = params.direction || 'undo';
    if (!op) return { ok: false, error: '缺少 op' };
    var target = direction === 'undo' ? op.before : op.after;
    var other = direction === 'undo' ? op.after : op.before;
    var el = op.elementId ? elementById(op.elementId) : null;
    try {
      switch (op.type) {
        case 'timeline':
          setTimeline({ timeline: target && target.timeline, silent: true });
          emit('timelinechange', { timeline: target && target.timeline });
          break;
        case 'style':
          if (!el) throw new Error('元素已不存在');
          if (target && target.cssText != null) { if (target.cssText) el.setAttribute('style', target.cssText); else el.removeAttribute('style'); }
          if (target && target.html != null) el.innerHTML = target.html;
          break;
        case 'text':
        case 'html':
          if (!el) throw new Error('元素已不存在');
          if (target && target.html != null) el.innerHTML = target.html;
          if (target && target.cssText != null) el.style.cssText = target.cssText;
          break;
        case 'attr':
          if (!el) throw new Error('元素已不存在');
          Object.keys((target && target.attrs) || {}).forEach(function (k) {
            var v = target.attrs[k];
            if (v == null) el.removeAttribute(k);
            else el.setAttribute(k, v);
          });
          break;
        case 'anim':
          if (!el) throw new Error('元素已不存在');
          if (!target || !target.name) { el.removeAttribute('data-wpx-anim'); el.removeAttribute('data-wpx-anim-params'); }
          else { el.setAttribute('data-wpx-anim', target.name); el.setAttribute('data-wpx-anim-params', JSON.stringify(target.params || {})); }
          break;
        case 'move':
          if (!el) throw new Error('元素已不存在');
          if (target && target.translate) setTranslate(el, target.translate.x, target.translate.y);
          break;
        case 'insert':
          if (direction === 'undo') removeElementById(op.elementId);
          else if (target && target.html) insertHtmlAt(op.slideIndex, target.index, target.html);
          break;
        case 'delete':
          if (direction === 'undo') {
            if (target && target.html) insertHtmlAt(op.slideIndex, target.index, target.html);
          } else removeElementById(op.elementId);
          break;
        case 'slide-add':
          if (direction === 'undo') {
            refreshSlides();
            var s1 = slides.find(function (s) { return s.dataset.id === (op.after && op.after.id); });
            if (s1) s1.remove();
            refreshRuntime();
            if (runtime) runtime.go(Math.max(0, Math.min(op.slideIndex, slides.length - 1)), { instant: true });
          } else if (other && other.html) {
            insertSlideHtml(op.slideIndex, other.html);
            if (runtime) runtime.go(op.slideIndex, { instant: true });
          }
          break;
        case 'slide-delete':
          if (direction === 'undo') {
            insertSlideHtml(op.slideIndex, op.before.html);
            if (runtime) runtime.go(op.slideIndex, { instant: true });
          } else {
            refreshSlides();
            var s2 = slides[op.slideIndex];
            if (s2) s2.remove();
            refreshRuntime();
            if (runtime) runtime.go(Math.max(0, Math.min(op.slideIndex, slides.length - 1)), { instant: true });
          }
          break;
        case 'slide-move': {
          refreshSlides();
          var mv = direction === 'undo' ? op.before : op.after;
          var from = direction === 'undo' ? op.after.from : op.before.from;
          var to = direction === 'undo' ? op.after.to : op.before.to;
          var slideEl = slides[from];
          if (slideEl) {
            var refEl = slides[to];
            if (refEl) { if (from < to) refEl.after(slideEl); else refEl.before(slideEl); }
            refreshRuntime();
            if (runtime) runtime.go(to, { instant: true });
          }
          break;
        }
        case 'slide-attrs': {
          var slide = slides[op.slideIndex];
          if (!slide) throw new Error('幻灯片不存在');
          var attrs = target || {};
          if (attrs.name != null) slide.dataset.name = attrs.name;
          if (attrs.transition != null) slide.dataset.transition = attrs.transition;
          if (attrs.duration != null) { if (attrs.duration === 'undefined' || attrs.duration == null) delete slide.dataset.transitionDuration; else slide.dataset.transitionDuration = attrs.duration; }
          if (attrs.bg != null) {
            if (attrs.bg === '') { slide.removeAttribute('data-bg'); slide.style.removeProperty('background'); }
            else { slide.dataset.bg = attrs.bg; slide.style.background = attrs.bg; }
          }
          syncModel();
          break;
        }
        case 'slide-html': {
          var targetSlide = slides[op.slideIndex];
          if (!targetSlide) throw new Error('幻灯片不存在');
          var tmp = document.createElement('div');
          tmp.innerHTML = target.html;
          var node = tmp.firstElementChild;
          if (!node) throw new Error('HTML 无效');
          targetSlide.replaceWith(node);
          refreshRuntime();
          if (runtime) runtime.go(op.slideIndex, { instant: true });
          break;
        }
        case 'deck-css': {
          var cssEl = getStyleEl('wpx-css', 'head');
          cssEl.textContent = (target && target.css) || '';
          break;
        }
        case 'deck-js': {
          var jsEl = document.getElementById('wpx-user-js');
          if (!jsEl) { jsEl = document.createElement('script'); jsEl.id = 'wpx-user-js'; document.body.appendChild(jsEl); }
          jsEl.textContent = (target && target.js) || '';
          break;
        }
        case 'theme': {
          var themeEl = getStyleEl('wpx-theme', 'head');
          themeEl.textContent = (target && target.cssText) || '';
          break;
        }
        case 'deck-flags': {
          var f = target || {};
          document.body.dataset.wpxGrain = f.grain ? 'on' : 'off';
          document.body.dataset.wpxVignette = f.vignette ? 'on' : 'off';
          document.body.dataset.wpxClickAdvance = f.clickAdvance ? 'on' : 'off';
          break;
        }
        default:
          return { ok: false, error: '未知 op 类型: ' + op.type };
      }
      syncModel();
      ensureElementIds();
      if (textEdit && !textEdit.el.isConnected) { textEdit.beforeHtml=textEdit.el.innerHTML;endTextEdit(); }
      if (textEdit) {
        textEdit.beforeHtml = textEdit.el.innerHTML;
        var caret=document.createRange();caret.selectNodeContents(textEdit.el);caret.collapse(false);textEdit.range=caret.cloneRange();
        textEdit.el.focus({preventScroll:true});var selection=window.getSelection();selection.removeAllRanges();selection.addRange(caret);
      }
      var sel = selectedId ? elementById(selectedId) : null;
      emit('selectionchange', { selection: sel ? selectionInfo(sel) : null });
      emit('deckchange', { state: getState() });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /* ======================================================================
     状态
     ====================================================================== */
  function getState() {
    if (RAW_MODE) return rawState();
    var st = runtime ? runtime.getState() : { current: currentIndex, total: slides.length, slides: [], stage: stageRect(), editing: true };
    currentIndex = st.current != null ? st.current : currentIndex;
    return {
      mode: 'edit',
      current: st.current,
      total: st.total,
      w: 1920,
      h: 1080,
      editing: true,
      slides: st.slides,
      stage: st.stage,
      capabilities: { slides: true, animations: true, insert: true, structure: true, text: true, timeline: true },
    };
  }

  /* ======================================================================
     事件绑定
     ====================================================================== */
  function isThreeUi(el) {
    return Boolean(el&&el.closest&&el.closest('[data-wds-three-ui],[data-wds-three][data-wds-three-interacting="true"]'));
  }
  function clickThreeUiAt(x,y) {
    var button=Array.from(document.querySelectorAll('[data-wds-three-ui] button,button[data-wds-three-ui]')).find(function(node){var r=node.getBoundingClientRect();return r.width&&r.height&&x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom;});
    if(!button)return false;button.click();return true;
  }
  function isUiTarget(el) {
    return Boolean(el && el.closest && (el.closest('.wpx-hud')||isThreeUi(el)));
  }

  function bindEvents() {
    document.addEventListener('wds-three-ready',function(){emit('threeready',{index:currentIndex});});
    document.addEventListener('wds-three-interaction',function(e){
      var active=!!e.detail?.active;
      if(RAW_MODE)setRawHitLayer(!active);
      if(active){dragState=null;clearHover();}
      emit('threeinteraction',{active:active,elementId:e.detail?.elementId||null});
    });
    /* 右键：拦截网页默认菜单，把坐标与命中元素交给父窗口自定义菜单 */
    document.addEventListener('contextmenu', function (e) {
      if (isUiTarget(e.target)) return;
      e.preventDefault();
      var sr = stageRect();
      post({
        type: 'wpx:event',
        event: 'contextmenu',
        data: {
          clientX: e.clientX,
          clientY: e.clientY,
          designX: (e.clientX - sr.left) / sr.scale,
          designY: (e.clientY - sr.top) / sr.scale,
        },
      });
    }, true);

    document.addEventListener('pointermove', function (e) {
      if (textEdit || dragState || transformState) return;
      var el = e.target;
      if (isUiTarget(el)) { clearHover(); return; }
      var top = null;
      if (RAW_MODE && rawHitLayer && el === rawHitLayer) {
        var hit = rawEventHit(e);
        top = hit && hit.el;
      } else {
        top = topLevelOf(el);
      }
      if (top === hoverEl) return;
      clearHover();
      if (top) { hoverEl = top; top.classList.add('wpx-hover'); }
    }, true);

    document.addEventListener('pointerdown', function (e) {
      if (isUiTarget(e.target)) return;
      if (textEdit && !textEdit.el.contains(e.target) && e.target !== rawHitLayer) {
        endTextEdit();
      }
      var top = null;
      if (RAW_MODE && rawHitLayer && e.target === rawHitLayer) {
        var hit = rawEventHit(e);
        top = hit && hit.el;
        if (!top) { setSelected(null); return; }
      } else {
        top = topLevelOf(e.target);
      }
      if (!top) return;
      if (textEdit && textEdit.el === top) return;
      if (top.dataset.wpxEl !== selectedId) setSelected(top);
      // 已选中的元素允许直接拖动（若父窗口覆盖层没有拦截）
      if (top.dataset.wpxEl === selectedId && !(e.target && e.target.isContentEditable)) {
        dragState = { el: top, startX: e.clientX, startY: e.clientY, before: parseTranslate(top), moved: false, beforeStyle: styleSnapshot(top) };
        try { top.setPointerCapture && top.setPointerCapture(e.pointerId); } catch (err) { }
      }
    }, true);

    document.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      var sr = stageRect();
      var dx = (e.clientX - dragState.startX) / sr.scale;
      var dy = (e.clientY - dragState.startY) / sr.scale;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragState.moved = true;
      setTranslate(dragState.el, dragState.before.x + dx, dragState.before.y + dy);
    }, true);

    document.addEventListener('pointerup', function () {
      if (!dragState) return;
      var st = dragState;
      dragState = null;
      if (!st.moved) return;
      var after = styleSnapshot(st.el);
      if (after === st.beforeStyle) return;
      var op = makeOp({ type: 'style', label: '移动元素', elementId: st.el.dataset.wpxEl, slideIndex: slideIndexOf(st.el), before: { cssText: st.beforeStyle }, after: { cssText: after } });
      emitChange(op);
      setSelected(st.el);
    }, true);

    document.addEventListener('selectionchange', function () {
      if (!textEdit) return;
      var sel = window.getSelection();
      if (sel && sel.rangeCount && textEdit.el.contains(sel.getRangeAt(0).commonAncestorContainer)) textEdit.range = sel.getRangeAt(0).cloneRange();
    });

    document.addEventListener('dblclick', function (e) {
      if (isUiTarget(e.target)) return;
      if (RAW_MODE && e.target === rawHitLayer) return;
      var top = topLevelOf(e.target);
      if (!top) { blankDoubleClick(e); return; }
      if (!hasText(top)) return;
      setSelected(top);
      try { beginTextEdit(top.dataset.wpxEl); } catch (err) { /* ignore */ }
    }, true);

    document.addEventListener('keydown', function (e) {
      var target = e.target;
      var isInput = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      var mod = e.ctrlKey || e.metaKey;
      function forward() {
        post({ type: 'wpx:event', event: 'shortcut', data: { key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey } });
      }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); forward(); return; }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); commitTypedText(); forward(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); commitTypedText(); forward(); return; }
      if (mod && e.key.toLowerCase() === 'd') { if (!isInput) { e.preventDefault(); forward(); } return; }
      if (e.key === 'Escape') { if (textEdit) { e.preventDefault(); endTextEdit(); } forward(); return; }
      if (isInput) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); forward(); return; }
      if (e.key.indexOf('Arrow') === 0) { e.preventDefault(); forward(); return; }
      if (e.key === 'Enter' && selectedId && !textEdit) { e.preventDefault(); var el2 = elementById(selectedId); if (el2 && hasText(el2)) beginTextEdit(selectedId); }
    }, true);

    // 运行时翻页 → 同步选择
    if (runtime && runtime.on) {
      runtime.on('slidechange', function (data) {
        currentIndex = data.index;
        if (selectedId) {
          var el = elementById(selectedId);
          if (!el || slideIndexOf(el) !== currentIndex) { selectedId = null; emit('selectionchange', { selection: null }); }
        }
        emit('slidechange', { index: data.index, state: getState() });
      });
    }
  }

  /* ======================================================================
     RPC 分发
     ====================================================================== */
  var METHODS = {
    ensureThree: function () { return ensureThreeRuntime().then(function(rt){return rt?rt.getState():{count:0,instances:[]};}); },
    getState: function () { return getState(); },
    getVisualState: function (p) { return getVisualState(p); },
    go: function (p) {
      if (RAW_MODE) return rawGo(p.index);
      return runtime.go(p.index, p.opts).then(function (i) { return { index: i }; });
    },
    select: function (p) { var el = elementById(p.elementId); if (!el) throw new Error('元素不存在'); setSelected(el); return selectionInfo(el); },
    selectAt: function (p) { var hit = hitAt(p.x, p.y); if (hit) { setSelected(hit.el); return Object.assign(selectionInfo(hit.el), { textElementId: hit.textElementId || null }); } setSelected(null); return null; },
    deselect: function () { setSelected(null); return null; },
    getSelection: function () { return selectionInfo(elementById(selectedId)); },
    hitTest: function (p) { return hitTest(p.x, p.y); },
    beginTextEdit: function (p) { return beginTextEdit(p.elementId, p.selectAll); },
    commitTextEdit: function () { return {op:commitTypedText()}; },
    setAbsoluteSize: function (p) { return absoluteSize(p); },
    endTextEdit: function () { return endTextEdit(); },
    execTextCommand: function (p) { return execTextCommand(p.command, p.value); },
    setText: function (p) { return setText(p.elementId, p.html != null ? p.html : p.text); },
    setElementHtml: function (p) { return setElementHtml(p.elementId, p.html); },
    getElementHtml: function (p) { return getElementHtml(p.elementId); },
    captureFavorite: function (p) { return captureFavorite(p.elementId); },
    setStyles: function (p) { return setStyles(p.elementId, p.styles); },
    setAttrs: function (p) { return setAttrs(p.elementId, p.attrs); },
    moveElement: function (p) { return moveElement(p.elementId, p.dx, p.dy); },
    resizeElement: function (p) { return resizeElement(p.elementId, p.w, p.h, p.x, p.y); },
    rotateElement: function (p) { return rotateElement(p.elementId, p.deg); },
    beginTransform: function (p) { return beginTransform(p.elementId); },
    updateTransform: function (p) { return updateTransform(p); },
    commitTransform: function (p) { return commitTransform(); },
    cancelTransform: function () { return cancelTransform(); },
    insertElement: function (p) { return insertElement(p); },
    insertElementHtml: function (p) { return insertElementHtml(p); },
    deleteElement: function (p) { return deleteElement(p.elementId); },
    duplicateElement: function (p) { return duplicateElement(p.elementId); },
    setAnimation: function (p) { return setAnimation(p); },
    getSlideAnimations: function (p) { return getSlideAnimations(p.index); },
    previewAnimation: function (p) { return previewAnimation(p); },
    previewTransition: function (p) { return previewTransition(p); },
    getTimeline: function () { return getTimeline(); },
    setTimeline: function (p) { return setTimeline(p); },
    timelinePlay: function (p) { return timelineCall('timelinePlay', p); },
    timelinePause: function (p) { return timelineCall('timelinePause', p); },
    timelineSeek: function (p) { return timelineCall('timelineSeek', p); },
    timelineState: function (p) { return timelineCall('timelineGetState', p); },
    timelineRefresh: function () { return timelineCall('timelineRefresh'); },
    insertGlobalElement: function (p) { return insertGlobalElement(p); },
    deleteGlobalElement: function (p) { return deleteGlobalElement(p); },
    getTimelineStyle: function (p) { return getTimelineStyle(p); },
    existsSelector: function (p) { return existsSelector(p); },
    addSlide: function (p) { return addSlide(p); },
    duplicateSlide: function (p) { return duplicateSlide(p); },
    deleteSlide: function (p) { return deleteSlide(p); },
    moveSlide: function (p) { return moveSlide(p); },
    setSlideAttrs: function (p) { return setSlideAttrs(p); },
    getSlideHtml: function (p) { return getSlideHtml(p); },
    setSlideHtml: function (p) { return setSlideHtml(p); },
    setDeckCss: function (p) { return setDeckCss(p.css); },
    getDeckCss: function () { return getDeckCss(); },
    setDeckJs: function (p) { return setDeckJs(p.js); },
    getDeckJs: function () { return getDeckJs(); },
    setThemeVars: function (p) { return setThemeVars(p.vars); },
    setDeckFlags: function (p) { return setDeckFlags(p); },
    getDeckFlags: function () { return getDeckFlags(); },
    applyOp: function (p) { return applyOp(p); },
    serialize: function () { return serialize(); },
    save: function () { return serialize(); },
    buildPatches: function (p) { return { raw: RAW_MODE, patches: buildPatches((p && p.ops) || []) }; },
    getRawPatches: function () { return { raw: RAW_MODE, patches: rawLoadedPatches }; },
    getThumb: function (p) { return getThumb(p); },
    setEditing: function (p) { if (RAW_MODE) return { ok: true, raw: true }; if (runtime) runtime.setEditing(p.editing !== false); return { ok: true }; },
    reload: function () { setTimeout(function () { location.reload(); }, 30); return { ok: true }; },
  };

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var msg = e.data;
    if (!msg || msg.type !== 'wpx:req') return;
    var id = msg.id;
    var method = msg.method;
    var handler = METHODS[method];
    if (!handler) {
      post({ type: 'wpx:res', id: id, ok: false, error: { code: 'NO_METHOD', message: '不支持的方法: ' + method } });
      return;
    }
    Promise.resolve()
      .then(function () { return handler(msg.params || {}); })
      .then(function (result) {
        post({ type: 'wpx:res', id: id, ok: true, result: result });
      })
      .catch(function (err) {
        post({ type: 'wpx:res', id: id, ok: false, error: { code: 'ERR', message: err && err.message ? err.message : String(err) } });
      });
  });

  /* ======================================================================
     启动
     ====================================================================== */
  function bootRaw() {
    RAW_MODE = true;
    patchRawTimers();
    installRawNavGuards();
    installRawHitLayer();
    // 原稿常给 slide/子元素 pointer-events:none：编辑态注入样式，让点击/选中/双击文字可用
    try {
      if (!document.getElementById('wpx-edit-style')) {
        var st = document.createElement('style');
        st.id = 'wpx-edit-style';
        st.textContent = '.slide,.slide *,[data-slide],[data-slide] *{pointer-events:auto!important}.slide,[data-slide]{cursor:default}';
        document.head.appendChild(st);
      }
    } catch (e) { /* ignore */ }
    rawStage = document.getElementById('stage') || document.getElementById('app') || document.querySelector('#app') || document.body;
    stageEl = rawStage;
    // 等原稿脚本把幻灯片建出来（动态 deck 可能是异步的）
    var started = Date.now();
    (function waitSlides() {
      refreshSlides();
      if (rawSlideEls.length || Date.now() - started > 4000) { finishRaw(); return; }
      setTimeout(waitSlides, 80);
    })();
  }

  function finishRaw() {
    refreshSlides();
    currentIndex = rawCurrentIndex();
    ensureElementIds();
    loadRawPatches().then(function (patches) {
      rawLoadedPatches = patches || [];
      ensureElementIds();
      bindEvents();
      refreshThree();
      window.__WPX_BRIDGE_READY__ = true;
      emit('ready', { mode: 'raw', state: getState() });
    });
  }

  function boot() {
    ensureRuntime().then(function (rt) {
      if (!rt) {
        // 兼容模式：原稿没有本工具运行时，直接以原始 HTML/JS 运行，编辑 DOM
        bootRaw();
        return;
      }
      stageEl = document.getElementById('wpx-stage');
      if (!stageEl) { emit('error', { message: '缺少 #wpx-stage' }); return; }
      if (runtime.mode !== 'edit') {
        try { runtime.setEditing(true); } catch (e) { }
      }
      ensureElementIds();
      var st = runtime.getState();
      currentIndex = st.current || 0;
      if (runtime.applyWaapi) {
        try { runtime.applyWaapi(runtime.getSlideEl(currentIndex), true); } catch (e) { }
      }
      bindEvents();
      syncModel();
      refreshThree();
      window.__WPX_BRIDGE_READY__ = true;
      emit('ready', { mode: 'edit', state: getState() });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
