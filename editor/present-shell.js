/**
 * 兼容模式放映外壳：右键自定义菜单（替代浏览器菜单）+ 左键行为设置。
 * 由 server 注入 raw 工程的放映页（编辑页不注入）。
 * 不改原稿：导航优先用原稿自己的键盘/哈希逻辑（合成键盘事件 / hash）。
 */
(function () {
  'use strict';
  if (window.__WPX_SHELL__) return;
  window.__WPX_SHELL__ = true;

  var KEY = 'wpx:mouse:' + location.pathname;
  var mode = 'native';
  try { mode = localStorage.getItem(KEY) || 'native'; } catch (e) { /* ignore */ }
  var menu = null;
  var offDoc = null;
  var toastEl = null;
  var toastTimer = 0;

  var css = ''
    + '.wpx-ctx{position:fixed;z-index:2147483000;width:236px;padding:5px;background:rgba(14,14,15,.96);'
    + 'border:1px solid rgba(255,255,255,.16);border-radius:3px;box-shadow:0 18px 48px rgba(0,0,0,.55);'
    + 'backdrop-filter:blur(14px);font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#F2EAE0;font-size:12.5px}'
    + '.wpx-ctx-head{display:flex;align-items:baseline;gap:5px;padding:7px 9px 8px;border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:4px}'
    + '.wpx-ctx-head b{font-size:15px;letter-spacing:1px}.wpx-ctx-head span{font-size:10px;letter-spacing:1px;color:rgba(255,255,255,.4)}'
    + '.wpx-ctx-head i{margin-left:auto;font-style:normal;font-size:10px;color:rgba(255,255,255,.45);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.wpx-ctx-item{display:flex;align-items:center;width:100%;padding:7px 9px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:2px}'
    + '.wpx-ctx-item:hover{background:rgba(255,255,255,.1)}'
    + '.wpx-ctx-item kbd{margin-left:auto;font-size:10px;color:rgba(255,255,255,.38);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);border-radius:2px;padding:1px 5px}'
    + '.wpx-ctx-sep{height:1px;background:rgba(255,255,255,.1);margin:4px 2px}'
    + '.wpx-ctx-pages{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:6px 5px 7px;max-height:112px;overflow:auto}'
    + '.wpx-ctx-page{height:22px;border:1px solid rgba(255,255,255,.12);background:transparent;color:rgba(255,255,255,.66);font-size:10.5px;cursor:pointer;border-radius:1px;padding:0}'
    + '.wpx-ctx-page:hover{border-color:#fff;color:#fff}.wpx-ctx-page.is-active{background:#E1402B;border-color:#E1402B;color:#fff}'
    + '.wpx-ctx-row{display:flex;align-items:center;gap:4px;padding:5px 9px 6px}'
    + '.wpx-ctx-label{font-size:10.5px;color:rgba(255,255,255,.42);letter-spacing:1px;margin-right:2px}'
    + '.wpx-ctx-chip{flex:1;border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.7);font-size:10.5px;padding:4px 0;cursor:pointer;border-radius:2px}'
    + '.wpx-ctx-chip:hover{border-color:rgba(255,255,255,.5);color:#fff}.wpx-ctx-chip.is-active{background:rgba(225,64,43,.9);border-color:rgba(225,64,43,.9);color:#fff}'
    + '.wpx-toast{position:fixed;left:50%;bottom:44px;transform:translateX(-50%) translateY(6px);z-index:2147483000;background:rgba(14,14,15,.92);'
    + 'border:1px solid rgba(255,255,255,.16);color:#F2EAE0;font-size:11.5px;letter-spacing:1px;padding:7px 14px;border-radius:2px;opacity:0;transition:opacity .18s,transform .18s;pointer-events:none}'
    + '.wpx-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}';

  function style() {
    var st = document.createElement('style');
    st.id = 'wpx-shell-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function slides() {
    var nodes = document.querySelectorAll('.slide, [data-slide], #stage > section, #stage > .slide');
    return Array.prototype.slice.call(nodes);
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

  function key(name) {
    ['keydown', 'keyup'].forEach(function (type) {
      var e = new KeyboardEvent(type, { key: name, code: name, bubbles: true, cancelable: true });
      document.dispatchEvent(e);
    });
  }

  function go(delta) {
    key(delta > 0 ? 'ArrowRight' : 'ArrowLeft');
    toast(delta > 0 ? '下一页' : '上一页');
  }

  function jump(n) {
    var list = slides();
    if (!list.length) return;
    if (location.hash !== '#' + n) {
      location.hash = '#' + n;
    }
    setTimeout(function () {
      if (currentIndex() !== n - 1) {
        for (var i = 0; i < Math.abs(n - 1 - currentIndex()); i++) key(n - 1 > currentIndex() ? 'ArrowRight' : 'ArrowLeft');
      }
    }, 120);
    toast('跳到第 ' + n + ' 页');
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () { });
  }

  function replay() {
    var btn = document.getElementById('bRe') || document.querySelector('[data-act="replay"],.replay');
    if (btn) btn.click();
    else key('r');
    toast('重播本页');
  }

  function applyMode() {
    try { localStorage.setItem(KEY, mode); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-wpx-mouse', mode);
  }

  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'wpx-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 1500);
  }

  function item(label, hint, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'wpx-ctx-item';
    var s = document.createElement('span');
    s.textContent = label;
    b.appendChild(s);
    if (hint) { var k = document.createElement('kbd'); k.textContent = hint; b.appendChild(k); }
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); close(); try { fn(); } catch (err) { console.warn(err); } });
    return b;
  }

  function sep() {
    var d = document.createElement('div');
    d.className = 'wpx-ctx-sep';
    return d;
  }

  function close() {
    if (menu) { try { menu.remove(); } catch (e) { /* ignore */ } }
    menu = null;
    if (offDoc) { try { offDoc(); } catch (e) { /* ignore */ } offDoc = null; }
  }

  function open(x, y) {
    close();
    var list = slides();
    var cur = currentIndex();
    var m = document.createElement('div');
    m.className = 'wpx-ctx';

    var head = document.createElement('div');
    head.className = 'wpx-ctx-head';
    head.innerHTML = '<b>' + String(cur + 1).padStart(2, '0') + '</b><span>/ ' + String(list.length).padStart(2, '0') + '</span><i>兼容模式 · 原稿</i>';
    m.appendChild(head);

    m.appendChild(item('上一页', '←', function () { go(-1); }));
    m.appendChild(item('下一页', '→', function () { go(1); }));

    if (list.length) {
      var grid = document.createElement('div');
      grid.className = 'wpx-ctx-pages';
      list.forEach(function (s, i) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'wpx-ctx-page' + (i === cur ? ' is-active' : '');
        b.textContent = String(i + 1);
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); close(); jump(i + 1); });
        grid.appendChild(b);
      });
      m.appendChild(grid);
    }
    m.appendChild(sep());
    m.appendChild(item('全屏', 'F', fullscreen));
    m.appendChild(item('重播本页', 'R', replay));
    if (window.__WPTL__) {
      m.appendChild(item('播放 / 暂停时间线', 'T', function () {
        var st = window.__WPTL__.getState();
        if (st.playing) window.__WPTL__.pause(); else window.__WPTL__.play();
      }));
    }
    m.appendChild(sep());

    var row = document.createElement('div');
    row.className = 'wpx-ctx-row';
    var lab = document.createElement('span');
    lab.className = 'wpx-ctx-label';
    lab.textContent = '左键';
    row.appendChild(lab);
    [['native', '原稿'], ['off', '不响应'], ['timeline', '时间线']].forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'wpx-ctx-chip' + (mode === p[0] ? ' is-active' : '');
      b.textContent = p[1];
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        mode = p[0];
        applyMode();
        close();
        toast(p[0] === 'native' ? '左键：原稿行为' : p[0] === 'off' ? '左键：不响应' : '左键：播放时间线');
      });
      row.appendChild(b);
    });
    m.appendChild(row);

    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 2)) + 'px';
    m.style.top = Math.max(8, Math.min(window.innerHeight - r.height - 8, y + 2)) + 'px';
    menu = m;
    var onDoc = function (e) { if (menu && !menu.contains(e.target)) close(); };
    var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    setTimeout(function () {
      document.addEventListener('pointerdown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    offDoc = function () {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  function runAction(el, act) {
    var s = String(act || '').trim();
    if (!s) return false;
    if (s === 'next') { go(1); return true; }
    if (s === 'prev') { go(-1); return true; }
    if (s === 'replay') { replay(); return true; }
    if (s === 'timeline') {
      if (window.__WPTL__) {
        var st = window.__WPTL__.getState();
        if (st.playing) window.__WPTL__.pause(); else window.__WPTL__.play();
      }
      return true;
    }
    if (s.indexOf('go:') === 0) { var n = parseInt(s.slice(3), 10); if (n >= 1) jump(n); return true; }
    if (s.indexOf('url:') === 0) { window.open(s.slice(4), '_blank', 'noopener'); return true; }
    return false;
  }

  function bind() {
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      e.stopPropagation();
      open(e.clientX, e.clientY);
    }, true);

    document.addEventListener('click', function (e) {
      var actEl = e.target && e.target.closest ? e.target.closest('[data-wpx-action]') : null;
      if (actEl) {
        var act = actEl.getAttribute('data-wpx-action');
        if (act && runAction(actEl, act)) { e.preventDefault(); e.stopPropagation(); return; }
      }
      if (mode === 'off') {
        if (e.target.closest && e.target.closest('button,a,input,textarea,.wpx-ctx')) return;
        e.stopPropagation();
        e.preventDefault();
      } else if (mode === 'timeline') {
        if (e.target.closest && e.target.closest('button,a,input,textarea,.wpx-ctx')) return;
        e.stopPropagation();
        e.preventDefault();
        if (window.__WPTL__) {
          var st = window.__WPTL__.getState();
          if (st.playing) window.__WPTL__.pause(); else window.__WPTL__.play();
        }
      }
    }, true);

    window.addEventListener('keydown', function (e) {
      if (e.key === 't' || e.key === 'T') {
        if (window.__WPTL__) {
          var st = window.__WPTL__.getState();
          if (st.playing) window.__WPTL__.pause(); else window.__WPTL__.play();
        }
      }
    });
  }

  function init() {
    style();
    applyMode();
    bind();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
