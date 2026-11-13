/**
 * 兼容模式补丁应用器（用于放映页 / 导出文件）
 * 原稿 HTML/JS 不动，只在原稿初始化完成后把编辑补丁应用到对应元素上，因此原稿动效 100% 保留。
 * 补丁由编辑器 bridge.buildPatches(history ops) 生成，存于工程 .raw-edits.json。
 */
(function () {
  'use strict';
  var dataEl = document.getElementById('wpx-raw-patches');
  if (!dataEl) return;
  var patches = [];
  try { patches = JSON.parse(dataEl.textContent || '[]'); } catch (e) { patches = []; }
  if (!patches.length) return;

  function slides() {
    var raw = [];
    function add(sel) {
      try {
        Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
          if (raw.indexOf(el) < 0) raw.push(el);
        });
      } catch (e) { /* ignore */ }
    }
    add('#stage > .slide');
    add('.slide');
    add('[data-slide]');
    if (!raw.length) add('#stage > section, #app section');
    return raw.filter(function (el) {
      var p = el.parentElement;
      while (p) { if (raw.indexOf(p) >= 0) return false; p = p.parentElement; }
      return true;
    });
  }

  function resolve(slide, path) {
    var parts = String(path == null ? '' : path).split('.').filter(function (x) { return x !== ''; });
    var n = slide;
    for (var i = 0; i < parts.length; i++) {
      n = n.children[Number(parts[i])];
      if (!n) return null;
    }
    return n;
  }

  function apply(onlySlide) {
    var sl = slides();
    patches.forEach(function (p, idx) {
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
        var slide = sl[p.slide];
        if (!slide) return;
        if (p.type === 'bg') { slide.style.background = p.bg; return; }
        if (p.type === 'slide-html') {
          var tmp = document.createElement('div');
          tmp.innerHTML = p.html || '';
          var ns = tmp.firstElementChild;
          if (ns) slide.innerHTML = ns.innerHTML;
          return;
        }
        var t = p.path ? resolve(slide, p.path) : slide;
        if (!t) return;
        if (p.type === 'html') {
          t.innerHTML = p.html == null ? '' : p.html;
        } else if (p.type === 'style') {
          if (p.cssText) t.setAttribute('style', p.cssText); else t.removeAttribute('style');
        } else if (p.type === 'attr') {
          Object.keys(p.attrs || {}).forEach(function (k) {
            var v = p.attrs[k];
            if (v == null) t.removeAttribute(k); else t.setAttribute(k, String(v));
          });
        } else if (p.type === 'insert') {
          var marker = 'raw-' + idx;
          if (t.querySelector('[data-wpx-raw-patch="' + marker + '"]')) return;
          var w = document.createElement('div');
          w.innerHTML = p.html || '';
          var n = w.firstElementChild;
          if (n) {
            n.setAttribute('data-wpx-raw-patch', marker);
            t.insertBefore(n, t.children[p.index] || null);
          }
        } else if (p.type === 'delete') {
          t.remove();
        }
      } catch (e) { /* ignore */ }
    });
  }

  function currentIndex(sl) {
    for (var i = 0; i < sl.length; i++) {
      var c = sl[i].classList;
      if (c && (c.contains('live') || c.contains('active') || c.contains('current') || c.contains('show') || c.contains('is-active'))) return i;
    }
    return 0;
  }

  /* 等原稿把幻灯片建出来（动态 deck 可能异步） */
  var tries = 0;
  var timer = setInterval(function () {
    var sl = slides();
    if (sl.length) { apply(null); clearInterval(timer); }
    else if (++tries > 80) { clearInterval(timer); }
  }, 100);

  /* 动态 deck：切页后补当前页（所有补丁应用都是幂等的） */
  var last = -1;
  setInterval(function () {
    var sl = slides();
    if (!sl.length) return;
    var cur = currentIndex(sl);
    if (cur !== last) { last = cur; apply(cur); }
  }, 320);
})();
