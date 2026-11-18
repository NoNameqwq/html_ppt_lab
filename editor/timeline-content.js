/* Shared by native decks and imported HTML. Track markup is data, rebuilt on refresh. */
(function () {
  'use strict';
  if (window.__WPTL_CONTENT__) return;
  window.__WPTL_CONTENT__ = function (timeline, stage) {
    document.querySelectorAll('[data-wpx-timeline-layer]').forEach(function (n) { n.remove(); });
    document.querySelectorAll('[data-wpx-timeline-legacy]').forEach(function(n){n.style.display=n.getAttribute('data-wpx-timeline-legacy');n.removeAttribute('data-wpx-timeline-legacy');});
    (timeline && timeline.tracks || []).forEach(function (track) {
      if (!track.html || track.hidden) return;
      var template = document.createElement('template'); template.innerHTML = track.html;
      template.content.querySelectorAll('script,iframe,object,embed').forEach(function (n) { n.remove(); });
      template.content.querySelectorAll('*').forEach(function (n) {
        Array.from(n.attributes).forEach(function (a) { if (/^on/i.test(a.name)) n.removeAttribute(a.name); });
      });
      var el = template.content.childElementCount === 1 ? template.content.firstElementChild : document.createElement('div');
      if (!el.parentNode) el.appendChild(template.content);
      var selector = String(track.selector || ''), match = /data-wpx-tl\s*=\s*["']([^"']+)["']/.exec(selector);
      try {document.querySelectorAll(selector).forEach(function(n){if(n.hasAttribute('data-wpx-tl-layer')){n.setAttribute('data-wpx-timeline-legacy',n.style.display);n.style.display='none';}});}catch(e){}
      if (match) el.setAttribute('data-wpx-tl', match[1]);
      else if (/^#[\w-]+$/.test(selector)) el.id = selector.slice(1);
      else if (/^\.[\w-]+$/.test(selector)) el.classList.add(selector.slice(1));
      el.setAttribute('data-wpx-timeline-layer', track.id || 'effect');
      if (!el.style.position) el.style.position = 'absolute';
      el.style.pointerEvents = 'none';
      stage.appendChild(el);
      if (track.css) {
        var style = document.createElement('style'); style.setAttribute('data-wpx-timeline-layer', track.id || 'effect');
        style.textContent = track.css; document.head.appendChild(style);
      }
    });
  };
})();
