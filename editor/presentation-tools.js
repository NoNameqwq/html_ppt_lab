/* Offline presentation controls. No server, libraries, or external icons required. */
(function () {
  'use strict';
  if (window.__WDS_PRESENTATION__ || /[?&]wpx=(edit|thumb|capture)(?:&|$)/.test(location.search) || window.__WPX_CAPTURE__) return;
  window.__WDS_PRESENTATION__ = { version: 1 };
  function start() {
    var mode = 'browse', cursor = false, exited = false, active = null, page = -1, pages = {}, wheelAt = 0, touch = null, fullTried = false;
    var navigation = Promise.resolve(), requestedPage = null;
    var paths = {
      pen: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/>',
      eraser: '<path d="m14 3 7 7-11 11H6l-5-5zM7 10l7 7M10 21h12"/>',
      cursor: '<path d="m5 3 14 10-7 1-3 7z"/>',
      prev: '<path d="m14 5-7 7 7 7"/>', next: '<path d="m10 5 7 7-7 7"/>',
      exit: '<path d="M9 4H4v16h5m6-12 5 4-5 4m-7-4h12"/>',
      undo: '<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"/>',
      clear: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
      fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>'
    };
    var style = document.createElement('style'); style.id = 'wds-presentation-style';
    style.textContent = 'html[data-wds-cursor="hide"],html[data-wds-cursor="hide"] body,html[data-wds-cursor="hide"] body *{cursor:none!important}'
      + '#wds-present-tools,#wds-present-tools *,#wds-present-exit,#wds-present-exit *{cursor:auto!important;box-sizing:border-box;letter-spacing:normal!important}'
      + '#wds-present-tools{position:fixed;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483600;display:flex;align-items:center;gap:3px;padding:6px;border:1px solid rgba(255,255,255,.2);border-radius:16px;background:rgba(23,27,37,.62);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 8px 35px #0003;color:#fff;font:12px/1.4 system-ui,sans-serif;max-width:calc(100vw - 20px);touch-action:manipulation;user-select:none;opacity:.65;transition:opacity .2s,transform .2s}'
      + '#wds-present-tools:hover,#wds-present-tools:focus-within{opacity:1}#wds-present-tools button{position:relative;display:grid;place-items:center;flex-shrink:0;width:40px;height:40px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;touch-action:manipulation;font:inherit}'
      + '#wds-present-tools button:hover{background:#ffffff24}#wds-present-tools button[aria-pressed="true"]{background:#b4b9ff40;color:#d7dbff}#wds-present-tools button:focus-visible{outline:2px solid #c5c7ff;outline-offset:-2px}#wds-present-tools svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}'
      + '#wds-present-tools .wds-tool-sep{height:22px;width:1px;background:#ffffff26;margin:0 4px}#wds-present-tools .wds-page{min-width:42px;text-align:center;font-variant-numeric:tabular-nums;color:#ddd}'
      + '#wds-present-tools .wds-pen-options{position:absolute;left:0;bottom:calc(100% + 8px);display:flex;align-items:center;gap:10px;padding:10px;background:rgba(23,27,37,.9);border:1px solid #ffffff30;border-radius:12px;backdrop-filter:blur(18px)}#wds-present-tools .wds-pen-options[hidden]{display:none}#wds-present-tools input[type=color]{width:32px;height:28px;padding:0;border:0;background:none}#wds-present-tools input[type=range]{width:90px;accent-color:#b7baff}'
      + '#wds-present-ink{position:fixed;inset:0;width:100%;height:100%;z-index:2147483500;pointer-events:none;touch-action:none}'
      + '#wds-present-exit{position:fixed;inset:0;z-index:2147483640;display:grid;place-content:center;gap:24px;text-align:center;background:#14171ff5;color:#f4f5fa;font:24px system-ui,sans-serif}#wds-present-exit[hidden]{display:none}#wds-present-exit button{padding:12px 24px;font:16px system-ui;border:1px solid #ffffff40;border-radius:12px;background:#ffffff18;color:inherit} @media(max-width:600px){#wds-present-tools{left:10px;bottom:max(10px,env(safe-area-inset-bottom));gap:0;padding:4px;border-radius:12px}#wds-present-tools button{width:36px;height:42px}#wds-present-tools .wds-tool-sep{margin:0 2px}#wds-present-tools .wds-page{min-width:36px}} @media(prefers-reduced-motion:reduce){#wds-present-tools{transition:none}}';
    style.textContent+='#wds-present-tools[hidden]{display:none}@media(max-width:380px){#wds-present-tools [data-tool=fullscreen]{display:none}}';
    document.head.appendChild(style);
    var canvas = document.createElement('canvas'); canvas.id = 'wds-present-ink'; canvas.setAttribute('aria-hidden','true');
    var toolbar = document.createElement('div'); toolbar.id = 'wds-present-tools'; toolbar.setAttribute('role','toolbar'); toolbar.setAttribute('aria-label','放映工具');
    var context = canvas.getContext('2d'), color = document.createElement('input'), width = document.createElement('input');
    color.type='color';color.value='#ff565f';color.setAttribute('aria-label','画笔颜色');width.type='range';width.min=1;width.max=20;width.value=4;width.setAttribute('aria-label','画笔粗细');
    var options=document.createElement('div');options.className='wds-pen-options';options.hidden=true;
    function button(id,label,fn,toggle) {
      var b=document.createElement('button');b.type='button';b.dataset.tool=id;b.title=label;b.setAttribute('aria-label',label);
      if(toggle)b.setAttribute('aria-pressed','false');
      b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+paths[id]+'</svg>';
      b.addEventListener('click',function(e){e.stopPropagation();fn(b);});return b;
    }
    function separator(){var d=document.createElement('span');d.className='wds-tool-sep';return d;}
    var pen=button('pen','画笔 (P)',function(){setMode(mode==='pen'?'browse':'pen');},true);
    var eraser=button('eraser','橡皮 (E)',function(){setMode(mode==='eraser'?'browse':'eraser');},true);
    var pointer=button('cursor','显示鼠标 (V)',function(){cursor=!cursor;updateCursor();},true);
    options.append(color,width,button('undo','撤销笔迹',function(){(pages[page]||[]).pop();redraw();}),button('clear','清除本页笔迹',function(){pages[page]=[];redraw();}));
    var label=document.createElement('span');label.className='wds-page';label.setAttribute('aria-live','polite');
    toolbar.append(options,pen,eraser,pointer,separator(),button('prev','上一页 (←)',function(){navigate(-1);}),label,button('next','下一页 (→)',function(){navigate(1);}),separator(),button('fullscreen','全屏 (F)',function(){if(document.fullscreenElement)document.exitFullscreen().catch(function(){});else fullscreen();}),button('exit','退出放映 (Esc)',exit));
    var exitView=document.createElement('div');exitView.id='wds-present-exit';exitView.hidden=true;exitView.innerHTML='<span>放映已结束</span>';
    var resume=document.createElement('button');resume.textContent='继续放映';resume.addEventListener('click',function(){exited=false;exitView.hidden=true;toolbar.hidden=false;canvas.hidden=false;updateCursor();fullscreen();});exitView.appendChild(resume);
    document.body.append(canvas,toolbar,exitView);
    function updateCursor(){document.documentElement.dataset.wdsCursor=cursor||exited?'show':'hide';pointer.setAttribute('aria-pressed',String(cursor));}
    function setMode(next){mode=next;active=null;pen.setAttribute('aria-pressed',String(mode==='pen'));eraser.setAttribute('aria-pressed',String(mode==='eraser'));options.hidden=mode==='browse';canvas.style.pointerEvents=mode==='browse'?'none':'auto';}
    function slides(){return Array.from(document.querySelectorAll('.wpx-slide,.slide,[data-slide],#stage>section'));}
    function state(){var native=window.__WPX__;if(native&&native.getState){var s=native.getState();return {index:s.current||0,total:s.total||slides().length};}var list=slides(),i=list.findIndex(function(el){return /(?:^|\s)(?:is-active|active|current|show|live)(?:\s|$)/.test(el.className);});return {index:i<0?Math.max(0,(parseInt(location.hash.slice(1),10)||1)-1):i,total:list.length||1};}
    function area(){var el=document.getElementById('wpx-stage')||document.getElementById('stage'),r=el&&el.getBoundingClientRect();return r&&r.width>0&&r.height>0?r:{left:0,top:0,width:innerWidth,height:innerHeight};}
    function point(e){var r=area();return {x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,p:e.pressure||.5};}
    function draw(stroke){
      var r=area(),pts=stroke.points;if(!pts.length)return;
      context.save();context.globalCompositeOperation=stroke.erase?'destination-out':'source-over';context.strokeStyle=stroke.color;context.fillStyle=stroke.color;context.lineWidth=stroke.width*(r.width/1920);context.lineCap='round';context.lineJoin='round';
      if(pts.length===1){context.beginPath();context.arc(r.left+pts[0].x*r.width,r.top+pts[0].y*r.height,context.lineWidth/2,0,Math.PI*2);context.fill();}
      else {context.beginPath();pts.forEach(function(p,i){context[i?'lineTo':'moveTo'](r.left+p.x*r.width,r.top+p.y*r.height);});context.stroke();}context.restore();
    }
    function redraw(){context.clearRect(0,0,innerWidth,innerHeight);(pages[page]||[]).forEach(draw);if(active)draw(active);}
    function resize(){var ratio=devicePixelRatio||1;canvas.width=Math.round(innerWidth*ratio);canvas.height=Math.round(innerHeight*ratio);context.setTransform(ratio,0,0,ratio,0,0);redraw();}
    function sync(){var s=state();label.textContent=(s.index+1)+' / '+s.total;if(page!==s.index){active=null;page=s.index;redraw();}}
    function navigate(delta){
      if(exited)return;sync();var before=state(),target=Math.max(0,Math.min(before.total-1,(requestedPage==null?before.index:requestedPage)+delta));
      if(window.__WPX__&&window.__WPX__.go) {
        requestedPage=target;
        navigation=navigation.then(function(){
          var tries=0;
          function go(){if(exited)return;return Promise.resolve(window.__WPX__.go(target)).then(function(){sync();if(state().index!==target&&++tries<80)return new Promise(function(resolve){setTimeout(resolve,80);}).then(go);});}
          return go();
        }).catch(function(){}).then(function(){if(requestedPage===target)requestedPage=null;});
      }
      else {['keydown','keyup'].forEach(function(type){document.dispatchEvent(new KeyboardEvent(type,{key:delta>0?'ArrowRight':'ArrowLeft',code:delta>0?'ArrowRight':'ArrowLeft',bubbles:true,cancelable:true}));});setTimeout(function(){if(state().index===before.index)location.hash='#'+(target+1);},450);}
      setTimeout(sync,50);
    }
    function fullscreen(){if(exited||document.fullscreenElement||!document.documentElement.requestFullscreen)return;fullTried=true;try {var p=document.documentElement.requestFullscreen({navigationUI:'hide'});if(p&&p.catch)p.catch(function(){});}catch(e){}}
    function exit(){exited=true;setMode('browse');active=null;canvas.hidden=true;toolbar.hidden=true;exitView.hidden=false;updateCursor();if(document.fullscreenElement)document.exitFullscreen().catch(function(){});if(window.__WPX__)window.__WPX__.timelinePause();if(window.__WPTL__)window.__WPTL__.pause();resume.focus();}
    function stop(e){e.preventDefault();e.stopImmediatePropagation();}
    canvas.addEventListener('pointerdown',function(e){if(e.button!==0)return;stop(e);fullscreen();sync();canvas.setPointerCapture(e.pointerId);active={pointer:e.pointerId,erase:mode==='eraser',width:mode==='eraser'?64:Number(width.value)*3,color:color.value,points:[point(e)]};redraw();});
    canvas.addEventListener('pointermove',function(e){if(!active||active.pointer!==e.pointerId)return;stop(e);active.points.push(point(e));redraw();});
    function finish(e){if(!active||active.pointer!==e.pointerId)return;stop(e);(pages[page]||(pages[page]=[])).push(active);active=null;redraw();}
    canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',finish);
    canvas.addEventListener('click',stop);canvas.addEventListener('dblclick',stop);
    ['touchstart','touchmove','touchend'].forEach(function(type){canvas.addEventListener(type,stop,{passive:false});});
    function own(e){return toolbar.contains(e.target)||exitView.contains(e.target)||e.target===canvas;}
    function interactive(e){return e.target.closest&&e.target.closest('a,button,input,textarea,select,[role=button],[contenteditable=true],[data-wds-target],[data-wds-nav],[data-wpx-target],[data-wds-three],.wpx-hud');}
    toolbar.addEventListener('pointerdown',function(e){e.stopPropagation();fullscreen();});
    ['touchstart','touchmove','touchend'].forEach(function(type){toolbar.addEventListener(type,function(e){e.stopPropagation();},{passive:true});});
    document.addEventListener('touchend',function(e){if(!own(e)&&mode==='browse'&&!interactive(e)&&!exited)e.stopPropagation();},true);
    document.addEventListener('pointerdown',function(e){if(e.isTrusted&&!exited&&!document.fullscreenElement)fullscreen();if(!own(e)&&!interactive(e)&&mode==='browse'&&e.pointerType==='touch')touch={x:e.clientX,y:e.clientY};},true);
    document.addEventListener('pointerup',function(e){if(!touch||own(e))return;var dx=e.clientX-touch.x,dy=e.clientY-touch.y;touch=null;if(Math.abs(dx)>65&&Math.abs(dx)>Math.abs(dy)*1.5){stop(e);navigate(dx<0?1:-1);wheelAt=Date.now();}},true);
    document.addEventListener('click',function(e){if(own(e)||interactive(e)||exited||mode!=='browse'||!e.isTrusted)return;if(Date.now()-wheelAt<450){stop(e);return;}stop(e);navigate(e.clientX<innerWidth*.22?-1:1);},true);
    document.addEventListener('wheel',function(e){if(own(e)||interactive(e)||exited||e.ctrlKey)return;stop(e);if(Date.now()-wheelAt>550&&Math.abs(e.deltaY)>12){wheelAt=Date.now();navigate(e.deltaY>0?1:-1);}},{capture:true,passive:false});
    document.addEventListener('keydown',function(e){
      if(interactive(e)||e.ctrlKey||e.metaKey||e.altKey)return;
      if(e.isTrusted&&!exited&&!document.fullscreenElement)fullscreen();
      var key=e.key.toLowerCase();if(key==='escape'){stop(e);exit();return;}if(exited)return;
      if(['p','e','v','f'].includes(key)){stop(e);if(key==='p')pen.click();if(key==='e')eraser.click();if(key==='v')pointer.click();if(key==='f')toolbar.querySelector('[data-tool=fullscreen]').click();}
      if(e.isTrusted&&['arrowright','arrowleft','pagedown','pageup',' '].includes(key)){stop(e);navigate(key==='arrowleft'||key==='pageup'?-1:1);}
    },true);
    window.addEventListener('resize',resize);window.addEventListener('hashchange',sync);
    updateCursor();resize();sync();setInterval(sync,160);setTimeout(fullscreen,300);
    window.__WDS_PRESENTATION__.getState=function(){return {mode:mode,cursor:cursor,exited:exited,page:page,strokes:(pages[page]||[]).length,fullscreenAttempted:fullTried};};
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
