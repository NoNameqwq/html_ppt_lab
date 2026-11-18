/* WebDeck embedded Three.js runtime. No CDN; source lives in JSON next to each host. */
(function () {
  'use strict';
  if (window.__WDS_THREE__) { window.__WDS_THREE__.refresh(); return; }
  var records = new Map(), rawScales = new Map(), loading = null, scheduled = false, stopped = false;
  var clock = performance.now(), lastTime = clock, raf = 0;
  function editorMode() { return /(?:^|[?&])wpx=edit(?:&|$)/.test(location.search) || document.body.classList.contains('wpx-editing') || (window.__WPX__ && window.__WPX__.mode === 'edit'); }
  function thumbnailMode() { return /(?:^|[?&])wpx=thumb(?:&|$)/.test(location.search) || document.body.classList.contains('wpx-thumb-body'); }
  function generated(tag, role) { var el=document.createElement(tag);el.setAttribute('data-wds-three-generated',role||'');return el; }
  // Imported HTML can have a viewport-sized page instead of a transformed 1920px
  // stage. Scale only marked, editor-inserted 3D wrappers; retain logical px source.
  function releaseRawScale(record) {
    var shared=record.rawScale;if(!shared)return;record.rawScale=null;shared.users.delete(record);
    if(!shared.users.size){shared.observer.disconnect();shared.owner.style.zoom=shared.before;rawScales.delete(shared.owner);}
  }
  function rawScale(record) {
    var owner=record.host.closest('[data-wds-three-raw-scale]');
    if(record.rawScale&&record.rawScale.owner!==owner)releaseRawScale(record);
    if(!owner)return;
    var shared=rawScales.get(owner);
    if(!shared){
      shared={owner:owner,parent:null,before:owner.style.zoom,users:new Set()};
      shared.update=function(){
        if(!owner.isConnected)return;
        var parent=owner.parentElement;
        if(shared.parent!==parent){shared.observer.disconnect();shared.parent=parent;if(parent)shared.observer.observe(parent);}
        var width=parent&&parent.clientWidth;
        if(width>0)owner.style.zoom=String(width/1920);
      };
      shared.observer=new ResizeObserver(shared.update);rawScales.set(owner,shared);
    }
    shared.users.add(record);record.rawScale=shared;shared.update();
  }
  function load() {
    if (window.WDS_THREE && window.WDS_THREE.THREE && window.WDS_THREE.OrbitControls) return Promise.resolve(window.WDS_THREE);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var script = document.createElement('script'),timer;
      function failed(message){clearTimeout(timer);script.remove();loading=null;reject(new Error(message));}
      script.src = window.__WDS_THREE_URL__ || '/app/vendor/three/three-bundle.js';
      script.setAttribute('data-wds-three-vendor', '');
      script.setAttribute('data-wds-runtime', 'three-bundle');
      script.onload = function () { clearTimeout(timer);if(window.WDS_THREE&&window.WDS_THREE.THREE&&window.WDS_THREE.OrbitControls)resolve(window.WDS_THREE);else failed('内置 Three.js 模块不可用'); };
      script.onerror = function () { failed('无法加载内置 Three.js，请重新构建静态版或检查本地服务'); };
      timer=setTimeout(function(){failed('内置 Three.js 加载超时，请检查本地服务后重试');},15000);
      document.head.appendChild(script);
    });
    return loading;
  }
  function color(T, value, fallback) { return new T.Color(value===undefined?fallback:value); }
  function vector(T, value, fallback) { return new T.Vector3().fromArray(Array.isArray(value)?value:fallback); }
  function geometry(T, description) {
    var g=description||{}, args=Array.isArray(g.args)?g.args:[], constructors={
      box:'BoxGeometry',sphere:'SphereGeometry',cylinder:'CylinderGeometry',cone:'ConeGeometry',torus:'TorusGeometry',torusKnot:'TorusKnotGeometry',
      plane:'PlaneGeometry',circle:'CircleGeometry',ring:'RingGeometry',icosahedron:'IcosahedronGeometry',octahedron:'OctahedronGeometry',
      tetrahedron:'TetrahedronGeometry',dodecahedron:'DodecahedronGeometry',capsule:'CapsuleGeometry',
    };
    if(g.type==='polyline')return new T.BufferGeometry().setFromPoints((g.points||[]).map(function(p){return vector(T,p,[0,0,0]);}));
    if(g.type==='lathe')return new T.LatheGeometry((g.points||[]).map(function(p){return new T.Vector2(p[0],p[1]);}),args[0]||32,args[1]||0,args[2]||Math.PI*2);
    if(g.type==='tube')return new T.TubeGeometry(new T.CatmullRomCurve3((g.points||[]).map(function(p){return vector(T,p,[0,0,0]);})),args[0]||64,args[1]||.1,args[2]||8,!!args[3]);
    var C=T[constructors[g.type||'box']];
    if(!C)throw new Error('不支持的几何体：'+g.type);
    return Reflect.construct(C,args);
  }
  function material(T, description, type) {
    var m=description||{},options={color:m.color===undefined?'#8cbaff':m.color};
    ['opacity','transparent','wireframe','roughness','metalness','emissive','emissiveIntensity','flatShading','size','sizeAttenuation','depthWrite','depthTest'].forEach(function(k){if(m[k]!==undefined)options[k]=m[k];});
    if(options.opacity<1)options.transparent=true;
    if(m.side!==undefined)options.side=m.side==='back'?T.BackSide:m.side==='front'?T.FrontSide:T.DoubleSide;
    var C=type==='line'?T.LineBasicMaterial:type==='points'?T.PointsMaterial:m.type==='basic'?T.MeshBasicMaterial:m.type==='normal'?T.MeshNormalMaterial:m.type==='phong'?T.MeshPhongMaterial:T.MeshStandardMaterial;
    var result=new C();Object.keys(options).forEach(function(key){if(!(key in result))delete options[key];});result.setValues(options);return result;
  }
  function object(T, node) {
    var n=node||{},type=n.type||'mesh',el;
    if(type==='group')el=new T.Group();
    else if(type==='axes')el=new T.AxesHelper(n.size||3);
    else if(type==='grid')el=new T.GridHelper(n.size||10,n.divisions||10,n.color===undefined?0x778899:n.color,n.color2===undefined?0x445566:n.color2);
    else if(type==='arrow')el=new T.ArrowHelper(vector(T,n.direction,[0,1,0]).normalize(),new T.Vector3(),n.length||2,n.color===undefined?0xffbd7a:n.color,n.headLength,n.headWidth);
    else if(type==='line')el=new T.Line(geometry(T,n.geometry||{type:'polyline',points:[[0,0,0],[1,1,1]]}),material(T,n.material,'line'));
    else if(type==='points')el=new T.Points(geometry(T,n.geometry),material(T,n.material,'points'));
    else if(type==='mesh')el=new T.Mesh(geometry(T,n.geometry),material(T,n.material));
    else throw new Error('不支持的 3D 节点：'+type);
    if(n.id)el.name=String(n.id);
    if(n.position)el.position.fromArray(n.position);
    if(n.rotation)el.rotation.set(n.rotation[0],n.rotation[1],n.rotation[2]);
    if(n.scale!==undefined){if(Array.isArray(n.scale))el.scale.fromArray(n.scale);else el.scale.setScalar(n.scale);}
    el.castShadow=!!n.castShadow;el.receiveShadow=!!n.receiveShadow;
    (n.children||[]).forEach(function(child){el.add(object(T,child));});
    return el;
  }
  function lamps(T, scene, lights) {
    (lights===undefined?[{type:'ambient',intensity:1.7},{type:'directional',position:[4,6,5],intensity:2.8}]:lights).forEach(function(l){
      var el;
      if(l.type==='directional')el=new T.DirectionalLight(l.color===undefined?0xffffff:l.color,l.intensity===undefined?2:l.intensity);
      else if(l.type==='point')el=new T.PointLight(l.color===undefined?0xffffff:l.color,l.intensity===undefined?20:l.intensity,l.distance||0,l.decay===undefined?2:l.decay);
      else if(l.type==='hemisphere')el=new T.HemisphereLight(l.color===undefined?0xffffff:l.color,l.groundColor===undefined?0x334455:l.groundColor,l.intensity===undefined?1:l.intensity);
      else if(l.type==='spot')el=new T.SpotLight(l.color===undefined?0xffffff:l.color,l.intensity===undefined?20:l.intensity,l.distance||0,l.angle||Math.PI/4,l.penumbra===undefined?.2:l.penumbra,l.decay===undefined?2:l.decay);
      else if(l.type==='ambient')el=new T.AmbientLight(l.color===undefined?0xffffff:l.color,l.intensity===undefined?1:l.intensity);
      else throw new Error('不支持的灯光：'+l.type);
      if(l.position)el.position.fromArray(l.position);
      el.castShadow=!!l.castShadow;scene.add(el);
    });
  }
  function dispose(record) {
    if(record.interacting)setInteractive(record,false);
    record.disposed=true;
    releaseRawScale(record);
    try { if(record.custom&&record.custom.dispose)record.custom.dispose(); } catch(e){console.warn('[WebDeck 3D dispose]',e);}
    if(record.resize)record.resize.disconnect();
    if(record.controls)record.controls.dispose();
    if(record.scene){
      var geometries=new Set(),materials=new Set(),textures=new Set();
      record.scene.traverse(function(node){if(node.geometry)geometries.add(node.geometry);(Array.isArray(node.material)?node.material:node.material?[node.material]:[]).forEach(function(m){materials.add(m);Object.values(m).forEach(function(v){if(v&&v.isTexture)textures.add(v);});});});
      textures.forEach(function(t){t.dispose();});materials.forEach(function(m){m.dispose();});geometries.forEach(function(g){g.dispose();});
    }
    if(record.renderer){record.renderer.dispose();record.renderer.forceContextLoss();}
    (record.removeListeners||[]).forEach(function(fn){fn();});
    record.host.querySelectorAll('[data-wds-three-generated]').forEach(function(el){el.remove();});
    record.host.removeAttribute('data-wds-three-ready');record.host.removeAttribute('data-wds-three-interacting');record.host.removeAttribute('data-wds-three-error');
    records.delete(record.host);
  }
  function setInteractive(record, value) {
    if(value&&editorMode())records.forEach(function(other){if(other!==record&&other.interacting)setInteractive(other,false);});
    var changed=record.interacting!==!!value;
    record.interacting=!!value;
    record.host.setAttribute('data-wds-three-interacting',value?'true':'false');
    if(record.controls)record.controls.enabled=!editorMode()||record.interacting;
    if(record.toggle){record.toggle.setAttribute('aria-pressed',value?'true':'false');record.toggle.textContent=value?'完成 3D 操控':'操控 3D';}
    if(record.surface)record.surface.style.cursor=record.controls&&record.controls.enabled?'grab':'inherit';
    if(changed){var owner=record.host.closest('[data-wpx-el]');document.dispatchEvent(new CustomEvent('wds-three-interaction',{detail:{active:!!value,elementId:owner&&owner.dataset.wpxEl||null}}));}
  }
  function fit(record, options) {
    var T=window.WDS_THREE.THREE,box=new T.Box3().setFromObject(record.scene);
    if(box.isEmpty())return;
    var size=box.getSize(new T.Vector3()),center=box.getCenter(new T.Vector3()),r=Math.max(size.x,size.y,size.z,.1);
    var vertical=Math.tan(record.camera.fov*Math.PI/360),horizontal=vertical*Math.max(record.host.clientWidth,1)/Math.max(record.host.clientHeight,1);
    var distance=r/(2*Math.min(vertical,horizontal))*1.3+r/2;
    record.camera.position.copy(center).add(new T.Vector3(1,.7,1.3).normalize().multiplyScalar(distance));
    record.camera.near=Math.min(.1,r/100);record.camera.far=Math.max(2000,distance*100);record.camera.updateProjectionMatrix();record.controls.target.copy(center);
  }
  function init(host, source, bundle) {
    var record={host:host,source:source,ready:false,error:null,disposed:false,removeListeners:[]};records.set(host,record);
    try {
      var config=JSON.parse(source),options=config.scene||{},T=bundle.THREE;
      rawScale(record);
      host.querySelectorAll('[data-wds-three-generated]').forEach(function(el){el.remove();});
      record.scene=new T.Scene();record.model=new T.Group();record.scene.add(record.model);
      if(options.background!==undefined&&options.background!==null&&options.background!=='transparent')record.scene.background=color(T,options.background,0x111827);
      record.camera=new T.PerspectiveCamera(options.camera&&options.camera.fov||45,1,options.camera&&options.camera.near||.01,options.camera&&options.camera.far||10000);
      record.camera.position.fromArray(options.camera&&options.camera.position||[5,3.5,6]);
      record.renderer=new T.WebGLRenderer({antialias:true,alpha:!record.scene.background,preserveDrawingBuffer:true});
      record.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));record.renderer.outputColorSpace=T.SRGBColorSpace;
      record.renderer.toneMapping=T.ACESFilmicToneMapping;record.renderer.toneMappingExposure=options.exposure===undefined?1:options.exposure;
      record.renderer.shadowMap.enabled=!!options.shadows;
      var surface=record.surface=generated('div','surface');surface.setAttribute('data-wds-three-surface','');
      surface.style.cssText='position:absolute;inset:0;overflow:hidden;touch-action:none;';
      var canvas=record.renderer.domElement;canvas.style.cssText='display:block;width:100%;height:100%;touch-action:none;';canvas.setAttribute('aria-label',config.label||'交互式 3D 结构');canvas.setAttribute('role','img');surface.appendChild(canvas);host.appendChild(surface);
      record.controls=new bundle.OrbitControls(record.camera,canvas);record.controls.enableDamping=true;record.controls.dampingFactor=.08;record.controls.screenSpacePanning=true;
      var c=options.controls||{};
      ['minDistance','maxDistance','minPolarAngle','maxPolarAngle','minAzimuthAngle','maxAzimuthAngle','rotateSpeed','zoomSpeed','panSpeed','autoRotateSpeed'].forEach(function(k){if(c[k]!==undefined)record.controls[k]=c[k];});
      ['enableRotate','enableZoom','enablePan','autoRotate'].forEach(function(k){if(c[k]!==undefined)record.controls[k]=!!c[k];});
      record.controls.target.fromArray(options.camera&&options.camera.target||[0,0,0]);
      (options.objects||[]).forEach(function(n){record.model.add(object(T,n));});lamps(T,record.scene,options.lights);
      var initialPosition=record.camera.position.clone(),initialTarget=record.controls.target.clone();
      if(config.code){
        // Custom project code is an explicit full-permission authoring capability.
        // It receives the existing renderer/controls; it must not create a second loop.
        var result=new Function('THREE','scene','camera','renderer','controls','host','root','"use strict";\n'+config.code)(T,record.scene,record.camera,record.renderer,record.controls,host,record.model);
        record.custom=typeof result==='function'?{update:result}:result||{};
        if(result&&typeof result.then==='function')throw new Error('3D factory 必须同步返回；异步资源可在 factory 内加载并返回 update/dispose');
      }
      // A factory may deliberately place the camera or set a non-origin target.
      // Auto-fit must not replace it merely because scene.camera was omitted.
      var factoryCamera=config.code&&(!record.camera.position.equals(initialPosition)||!record.controls.target.equals(initialTarget));
      if((!options.camera||!options.camera.position)&&!factoryCamera&&options.autoFit!==false)fit(record,options);
      record.controls.update();record.controls.saveState();
      var ui=generated('div','ui');ui.setAttribute('data-wds-three-ui','');ui.style.cssText='position:absolute;right:12px;bottom:12px;display:flex;gap:6px;z-index:5;pointer-events:auto;';
      function button(label){var b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='font:500 16px/1.2 system-ui,sans-serif;color:#fff;background:#172033d9;border:1px solid #ffffff45;border-radius:8px;padding:9px 12px;cursor:pointer;box-shadow:0 3px 12px #0002;';ui.appendChild(b);return b;}
      record.toggle=button('操控 3D');record.toggle.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();setInteractive(record,!record.interacting);});
      var reset=button('复位');reset.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();record.controls.reset();});
      host.appendChild(ui);record.ui=ui;
      record.hint=generated('div','hint');record.hint.style.cssText='position:absolute;left:12px;bottom:14px;font:14px/1.4 system-ui,sans-serif;color:inherit;opacity:.65;pointer-events:none;';record.hint.textContent='拖动旋转 · 滚轮缩放 · 右键平移 · 双指缩放/平移';host.appendChild(record.hint);
      function listen(el,event,fn,options){el.addEventListener(event,fn,options);record.removeListeners.push(function(){el.removeEventListener(event,fn,options);});}
      // Bubble barriers keep page handlers from treating 3D gestures as slide navigation.
      ['pointerdown','pointermove','pointerup','click','dblclick','touchstart','touchmove','touchend','contextmenu','wheel'].forEach(function(type){listen(surface,type,function(e){if(!record.controls.enabled)return;e.stopPropagation();if(type==='contextmenu'||type==='wheel')e.preventDefault();},{passive:false});});
      ['pointerdown','pointerup','click','dblclick','touchstart','touchend','contextmenu'].forEach(function(type){listen(ui,type,function(e){e.stopPropagation();if(type==='contextmenu')e.preventDefault();});});
      function resize(){if(record.disposed||record.thumbnail)return;var w=host.clientWidth,h=host.clientHeight;if(w<1||h<1)return;record.renderer.setSize(w,h,false);record.camera.aspect=w/h;record.camera.updateProjectionMatrix();}
      record.resize=new ResizeObserver(resize);record.resize.observe(host);resize();
      record.ready=true;host.setAttribute('data-wds-three-ready','true');setInteractive(record,false);record.renderer.render(record.scene,record.camera);
      if(thumbnailMode()){
        record.thumbnail=true;record.snapshot=canvas.toDataURL('image/png');
        var preview=generated('img','snapshot');preview.alt=config.label||'3D 结构';preview.src=record.snapshot;preview.style.cssText='display:block;width:100%;height:100%;object-fit:contain;';surface.appendChild(preview);canvas.remove();
        record.resize.disconnect();record.controls.dispose();record.renderer.dispose();record.renderer.forceContextLoss();record.renderer=null;ui.remove();record.hint.remove();
      }
      host.dispatchEvent(new CustomEvent('wds-three-ready',{bubbles:true}));
    } catch(e){fail(record,e);}
  }
  function fail(record,error) {
    var host=record.host,source=record.source;dispose(record);record={host:host,source:source,ready:false,error:String(error&&error.message||error),disposed:false};records.set(host,record);
    host.setAttribute('data-wds-three-error',record.error);
    var fallback=generated('div','error');fallback.setAttribute('role','status');fallback.style.cssText='position:absolute;inset:0;display:grid;place-content:center;padding:28px;box-sizing:border-box;text-align:center;font:20px/1.5 system-ui,sans-serif;color:inherit;background:#80808018;';fallback.textContent='3D 视图不可用：'+record.error;host.appendChild(fallback);
    var retry=document.createElement('button');retry.type='button';retry.textContent='重试 3D 渲染';retry.style.cssText='margin:14px auto 0;padding:8px 14px;cursor:pointer;';retry.addEventListener('click',function(event){event.stopPropagation();dispose(record);refresh();});fallback.appendChild(retry);
    host.dispatchEvent(new CustomEvent('wds-three-error',{bubbles:true,detail:{error:record.error}}));
  }
  function refresh() {
    if(stopped)return Promise.resolve();
    records.forEach(function(r,h){if(!h.isConnected)dispose(r);else if(r.ready)rawScale(r);});
    var hosts=Array.from(document.querySelectorAll('[data-wds-three]')).filter(function(host){return !host.parentElement.closest('[data-wds-three]');});
    var pending=[],waiting=[];
    hosts.forEach(function(host){
      var script=host.querySelector('script[data-wds-three-scene]');if(!script)return;
      var source=script.textContent,previous=records.get(host);
      if(previous&&previous.source===source){if(previous.initialized)waiting.push(previous.initialized);return;}
      if(previous)dispose(previous);
      var done,placeholder={host:host,source:source,ready:false,loading:true,disposed:false};
      placeholder.initialized=new Promise(function(resolve){done=resolve;});waiting.push(placeholder.initialized);
      records.set(host,placeholder);pending.push({host:host,source:source,placeholder:placeholder,done:done});
    });
    if(pending.length)load().then(function(bundle){pending.forEach(function(p){try{if(p.host.isConnected&&records.get(p.host)===p.placeholder)init(p.host,p.source,bundle);}finally{p.done();}});},function(error){pending.forEach(function(p){try{if(records.get(p.host)===p.placeholder)fail(p.placeholder,error);}finally{p.done();}});});
    return Promise.all(waiting).then(function(){});
  }
  function schedule(){if(scheduled||stopped)return;scheduled=true;queueMicrotask(function(){scheduled=false;refresh();});}
  function frame(now){
    if(stopped)return;raf=requestAnimationFrame(frame);var elapsed=(now-clock)/1000,delta=Math.min((now-lastTime)/1000,.1);lastTime=now;
    records.forEach(function(r){
      if(!r.ready||r.disposed||r.thumbnail||!r.host.isConnected)return;
      var editing=editorMode();r.toggle.hidden=!editing;r.controls.enabled=!editing||r.interacting;
      if(r.host.getAttribute('data-wds-three-interacting')!==(r.controls.enabled?'true':'false'))r.host.setAttribute('data-wds-three-interacting',r.controls.enabled?'true':'false');
      var visible=!!r.host.getClientRects().length&&getComputedStyle(r.host).visibility!=='hidden';
      if(!visible&&r.interacting)setInteractive(r,false);
      if(document.hidden||!visible)return;
      try {if(r.custom&&r.custom.update)r.custom.update(elapsed,delta);r.controls.update(delta);r.renderer.render(r.scene,r.camera);}catch(e){fail(r,e);}
    });
  }
  function recordFor(value){if(value&&value.nodeType)return records.get(value.matches('[data-wds-three]')?value:value.querySelector('[data-wds-three]'));var found=null;records.forEach(function(r){var owner=r.host.closest('[data-wpx-el]');if(owner&&owner.dataset.wpxEl===value)found=r;});return found;}
  window.__WDS_THREE__={
    refresh:refresh,
    getState:function(){return {count:records.size,loading:!!loading&&!window.WDS_THREE,instances:Array.from(records.values()).map(function(r){var owner=r.host.closest('[data-wpx-el]');return {elementId:owner&&owner.dataset.wpxEl||null,ready:r.ready,error:r.error||null,interacting:!!(r.controls&&r.controls.enabled),objects:r.model?r.model.children.length:0,camera:r.camera?{position:r.camera.position.toArray(),target:r.controls.target.toArray()}:null,renderer:r.renderer?{width:r.renderer.domElement.width,height:r.renderer.domElement.height}:null};})};},
    capture:function(value){var r=recordFor(value);if(!r||!r.ready)throw new Error('3D 视图尚未就绪');if(r.snapshot)return r.snapshot;r.renderer.render(r.scene,r.camera);return r.renderer.domElement.toDataURL('image/png');},
    setInteractive:function(value,enabled){var r=recordFor(value);if(!r||!r.ready)return false;setInteractive(r,enabled);return true;},
    setInteracting:function(value,enabled){var r=recordFor(value);if(!r||!r.ready)return false;setInteractive(r,enabled);return true;},
    dispose:function(){stopped=true;cancelAnimationFrame(raf);observer.disconnect();records.forEach(dispose);},
  };
  var observer=new MutationObserver(schedule);
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&editorMode()){var active=false;records.forEach(function(r){if(r.interacting){active=true;setInteractive(r,false);}});if(active){e.preventDefault();e.stopImmediatePropagation();}}},true);
  function start(){observer.observe(document.body,{childList:true,subtree:true,characterData:true});refresh();raf=requestAnimationFrame(frame);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  window.addEventListener('pagehide',function(e){if(!e.persisted)window.__WDS_THREE__.dispose();});
})();
