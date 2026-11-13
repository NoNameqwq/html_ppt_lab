import JSZip from 'jszip';
export async function pptxFixture(){
  const zip=new JSZip(),ns='xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  zip.file('ppt/presentation.xml',`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels','<Relationships><Relationship Id="first" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="second" Type="x/slide" Target="slides/slide2.xml"/></Relationships>');
  const shape=(text)=>`<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="635000" y="635000"/><a:ext cx="6350000" cy="1270000"/></a:xfrm><a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="EDF1FF"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="3200" b="1"><a:solidFill><a:srgbClr val="223344"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const picture='<p:pic><p:nvPicPr><p:cNvPr id="3" name="图片"/></p:nvPicPr><p:blipFill><a:blip r:embed="image"/></p:blipFill><p:spPr><a:xfrm><a:off x="635000" y="2540000"/><a:ext cx="1905000" cy="1905000"/></a:xfrm></p:spPr></p:pic>';
  const table='<p:graphicFrame><p:xfrm><a:off x="3175000" y="2540000"/><a:ext cx="5715000" cy="1905000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="2857500"/><a:gridCol w="2857500"/></a:tblGrid><a:tr h="1905000"><a:tc><a:txBody><a:p><a:r><a:t>可编辑表格</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:p><a:r><a:t>42</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
  zip.file('ppt/slides/slide1.xml',`<p:sld ${ns}><p:cSld><p:spTree>${shape('第二页 · Source One')}</p:spTree></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide2.xml',`<p:sld ${ns}><p:cSld><p:spTree>${shape('第一页 · Source Two')}${picture}${table}</p:spTree></p:cSld><p:timing/></p:sld>`);
  zip.file('ppt/slides/_rels/slide2.xml.rels','<Relationships><Relationship Id="image" Type="x/image" Target="../media/image1.png"/></Relationships>');
  zip.file('ppt/media/image1.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1cAAAAASUVORK5CYII=','base64'));
  return zip.generateAsync({type:'nodebuffer'});
}
