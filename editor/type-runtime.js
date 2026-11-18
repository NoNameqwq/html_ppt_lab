/**
 * 艺术字运行时（编辑 / 放映 / 导出共用）。
 *
 * 只做一件事：让带 [data-wds-type] 的作品在所在页真正显示时重新播放动画。
 *   - 静态作品不需要它，外观完全由元素自带的 <style> 决定；
 *   - 动画作品的关键帧也写在元素自带的 <style> 里，这里只负责切换 .wtk-play；
 *   - 缩略图 CSS 会把动画压到 0.001s（直接呈现终态），不需要它。
 *
 * 页面识别不依赖模板结构：向上找最近的「显示中」容器（编辑器用 is-active，
 * 导入网页可能是 active / live / show / current），都找不到就当作已显示。
 * 若脚本本身缺失，CSS 里的暂停规则不会生效，动画照常播放——不会出现空白。
 */
(function () {
  'use strict';
  if (window.__WDS_TYPESET__) return;
  var EDIT = /[?&]wpx=edit/.test(location.search);
  var SLIDE_SELECTOR = '.wpx-slide, .slide, [data-slide], section';
  var ACTIVE = ['is-active', 'active', 'live', 'show', 'current', 'visible'];
  var watchers = [];
  var observed = new WeakSet();
  var playingNow = new WeakMap();

  function play(el) {
    el.classList.remove('wtk-play');
    void el.offsetWidth; // 强制回流，动画从第一帧重新开始
    el.classList.add('wtk-play');
    // 有些作品（例如液体填充的 ::after）走伪元素，WAAPI 拿不到句柄，上面已处理
    el.querySelectorAll('.wtk-text,.wtk-c,.wtk-ch path').forEach(function (node) {
      (node.getAnimations ? node.getAnimations() : []).forEach(function (anim) {
        try { anim.currentTime = 0; } catch (e) { /* 伪元素或已结束的动画忽略 */ }
      });
    });
  }

  /** 是否正处于「显示中」的页。
   *  只看结构和激活类，不看 opacity：切页过渡期间透明度会瞬间为 0，
   *  用透明度判断会把作品误判为隐藏，此后就再也不会重播。 */
  function showing(node) {
    var hit = null;
    for (var cur = node; cur && cur.nodeType === 1 && cur.tagName !== 'BODY'; cur = cur.parentElement) {
      var cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (cur.classList && ACTIVE.some(function (c) { return cur.classList.contains(c); })) return true;
      if (cur.matches && cur.matches(SLIDE_SELECTOR)) hit = cur;
    }
    // 有明确的页容器但没有任何激活类：视为隐藏；没有页容器（非分页网页）就当作已显示
    return !hit;
  }

  function restart(el) {
    var visible = showing(el);
    if (visible) {
      // 只在「从未显示 → 显示」的那一次重播；轮询重复调用不能打断正在跑的动画
      if (playingNow.get(el) === true) return;
      playingNow.set(el, true);
      play(el);
    } else if (playingNow.get(el) !== false) {
      playingNow.set(el, false);
      el.classList.remove('wtk-play');
    }
  }

  function observe(el) {
    if (observed.has(el)) return;
    observed.add(el);
    var root = el.closest(SLIDE_SELECTOR) || document.body;
    var target = root;
    while (target && target.parentElement && target.parentElement !== document.documentElement) target = target.parentElement;
    if (!target || target === document.body) return;
    try {
      var mo = new MutationObserver(function () { restart(el); });
      mo.observe(target, { attributes: true, attributeFilter: ['class', 'style'] });
      watchers.push(mo);
    } catch (e) { /* ignore */ }
  }

  function refresh() {
    document.querySelectorAll('[data-wds-type]').forEach(function (el) {
      observe(el);
      restart(el);
    });
  }

  window.__WDS_TYPESET__ = {
    refresh: refresh,
    /** 手动重播：编辑器「预览」与外部脚本可用。 */
    replay: function (root) {
      (root || document).querySelectorAll('[data-wds-type]').forEach(function (el) {
        play(el);
      });
    },
  };

  function start() {
    document.documentElement.classList.add('wds-type-js');
    refresh();
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].type === 'childList') { refresh(); return; }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', refresh);
    if (!EDIT) {
      // 导入网页常用定时器或自定义类名切页，低频补扫比监听一切更可靠
      var timer = setInterval(refresh, 500);
      window.addEventListener('beforeunload', function () { clearInterval(timer); }, { once: true });
    }
    setTimeout(refresh, 320);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
