// Capture the actual, unsaved editor DOM. The image and measurements use the same coordinate frame.
export async function captureSlide(ctx,params={},opts={}) {
  const editor=ctx.getEditor?.(),bridge=editor?.bridge;
  if(!bridge?.ready)throw new Error('请先打开工程，等待画布就绪后再截图。');
  if(opts.signal?.aborted)throw new DOMException('已停止截图','AbortError');
  const before=await bridge.call('getState');
  const index=params.index===undefined?before.current:Number(params.index);
  if(!Number.isInteger(index)||index<0||index>=before.slides.length)throw new Error('截图页码无效。');
  const selection=await bridge.call('getSelection');
  let moved=false;
  try {
    if(index!==before.current){await bridge.call('go',{index,opts:{instant:true}});moved=true;}
    const doc=editor.iframe.contentDocument;
    await Promise.race([doc.fonts?.ready||Promise.resolve(),new Promise(r=>setTimeout(r,3000))]);
    if(doc.querySelector('[data-wds-three]')&&!editor.iframe.contentWindow.__WDS_THREE__)await bridge.call('ensureThree',{});
    const three=editor.iframe.contentWindow.__WDS_THREE__;
    if(three){await three.refresh();for(const host of doc.querySelectorAll('[data-wds-three]'))try{three.capture(host);}catch{/* State below reports a failed or unavailable renderer. */}}
    const {default:html2canvas}=await import('../../vendor/html2canvas-pro.mjs');
    const visual=await bridge.call('getVisualState',{elementId:params.elementId});
    let region=params.region||visual.focus||{x:0,y:0,w:1920,h:1080};
    region=Object.fromEntries(['x','y','w','h'].map(k=>[k,Number(region[k])]));
    if(Object.values(region).some(v=>!Number.isFinite(v))||region.w<=0||region.h<=0||region.x<0||region.y<0||region.x+region.w>1920.5||region.y+region.h>1080.5)throw new Error('截图区域必须位于 1920 × 1080 画布内，并具有正宽高。');
    const desired=Math.max(.25,Math.min(1.5,Number(params.scale)||.75));
    const factor=visual.viewport.width/1920;
    const canvas=await html2canvas(doc.documentElement,{
      x:visual.viewport.x+region.x*factor,y:visual.viewport.y+region.y*factor,
      width:region.w*factor,height:region.h*factor,scale:desired/factor,
      logging:false,useCORS:true,allowTaint:false,imageTimeout:5000,backgroundColor:null,
      onclone:clone=>{
        clone.querySelectorAll('.wpx-selected,.wpx-hover').forEach(n=>n.classList.remove('wpx-selected','wpx-hover'));
        clone.querySelectorAll('.wpx-hud,#wds-present-tools,#wds-present-ink,[data-wds-three-ui],[data-wds-three-generated="hint"],[data-html2canvas-ignore]').forEach(n=>n.remove());
      },
    });
    if(opts.signal?.aborted)throw new DOMException('已停止截图','AbortError');
    const images=[canvas.toDataURL('image/png')];
    return {ok:true,index,images,visual:{...visual,viewport:undefined,region,imageWidth:canvas.width,imageHeight:canvas.height,pixelsPerUnit:desired,...(three?{three:three.getState()}:{} )},
      note:'Actual editor DOM rendered to PNG, including built-in Three.js pixels when WebGL is available. Coordinates are slide pixels, not image pixels. External images without CORS may be omitted; video, third-party WebGL, filters, animation and browser-only compositing require separate verification. Inspect visual.three for renderer errors.',
      summary:`已查看第 ${index+1} 页画面（${canvas.width} × ${canvas.height}）及元素坐标`};
  } finally {
    if(moved&&ctx.getEditor?.()===editor&&bridge.ready){
      await bridge.call('go',{index:before.current,opts:{instant:true}}).catch(()=>{});
      if(selection?.elementId)await bridge.call('select',{elementId:selection.elementId}).catch(()=>{});
    }
  }
}
