/* ==========================================================================
   附件解析：图片 / PDF / DOCX / PPTX / 文本（无第三方依赖，pdf.js 本地内置）
   - 图片：压缩后 dataURL，走视觉模型
   - PDF：pdf.js 抽文字；扫描页渲染成图片走视觉
   - DOCX / PPTX：浏览器原生 DecompressionStream 解 zip 后抽文字
   ========================================================================== */

export const ACCEPT = 'image/*,.pdf,.docx,.pptx,.txt,.md,.csv,.json';
const MAX_TEXT_PER_FILE = 24000;
const MAX_PDF_PAGES = 30;
const MAX_SCAN_IMAGES = 4;

const EXT_ICON = {
  pdf: 'file-text', docx: 'file-text', doc: 'file-text', pptx: 'file-text',
  txt: 'file-text', md: 'file-text', csv: 'file-text', json: 'file-code',
};

export function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function fileKindLabel(ext) {
  if (ext === 'pdf') return 'PDF';
  if (ext === 'docx' || ext === 'doc') return 'Word';
  if (ext === 'pptx') return 'PPT';
  if (ext === 'csv') return 'CSV';
  if (ext === 'md') return 'Markdown';
  if (ext === 'json') return 'JSON';
  return (ext || '文本').toUpperCase();
}

export function iconForExt(ext) {
  return EXT_ICON[ext] || 'file-text';
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function xmlToText(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- ZIP（docx / pptx 本质是 zip） ---------- */

async function inflateEntry(u8, method) {
  if (method === 0) return new TextDecoder().decode(u8);
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压（需要 Chrome/Edge 103+）');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

async function unzipText(buf, wanted) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  const min = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= min; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文档');
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  let p = cdOffset;
  const result = {};
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.slice(p + 46, p + 46 + nameLen));
    if (wanted(name)) {
      const lnLen = dv.getUint16(localOff + 26, true);
      const leLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lnLen + leLen;
      const data = u8.slice(start, start + compSize);
      result[name] = await inflateEntry(data, method);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return result;
}

async function readDocx(file) {
  const entries = await unzipText(await file.arrayBuffer(), (n) => n === 'word/document.xml');
  const xml = entries['word/document.xml'];
  if (!xml) throw new Error('DOCX 里没有正文');
  return { text: xmlToText(xml) };
}

async function readPptx(file) {
  const entries = await unzipText(await file.arrayBuffer(), (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const names = Object.keys(entries).sort((a, b) => Number((a.match(/(\d+)/) || [0, 0])[1]) - Number((b.match(/(\d+)/) || [0, 0])[1]));
  if (!names.length) throw new Error('PPTX 里没有幻灯片文本');
  const pages = names.map((n, i) => '[第 ' + (i + 1) + ' 页] ' + xmlToText(entries[n])).filter((t) => t.replace(/\[第 \d+ 页\]/, '').trim());
  return { text: pages.join('\n\n'), pages: names.length };
}

/* ---------- PDF ---------- */

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/app/vendor/pdfjs/pdf.min.mjs').then((mod) => {
      const lib = mod.default || mod;
      lib.GlobalWorkerOptions.workerSrc = '/app/vendor/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

async function renderPage(page, maxWidth = 1400) {
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(2, maxWidth / viewport.width);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function readPdf(file) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const total = doc.numPages;
  const limit = Math.min(total, MAX_PDF_PAGES);
  const parts = [];
  const scans = [];
  for (let i = 1; i <= limit; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = (content.items || []).map((it) => it.str || '').join(' ').replace(/\s+/g, ' ').trim();
    if (pageText.length >= 8) {
      parts.push('[第 ' + i + ' 页] ' + pageText);
    } else if (scans.length < MAX_SCAN_IMAGES) {
      /* 扫描页：没有文字层，渲染成图片交给视觉模型 */
      scans.push(await renderPage(page));
      parts.push('[第 ' + i + ' 页] （扫描页，已转为图片）');
    }
  }
  try { doc.destroy(); } catch { /* ignore */ }
  return { text: parts.join('\n\n'), pages: total, images: scans, truncated: total > limit };
}

/* ---------- 入口 ---------- */

export async function extractFile(file) {
  const ext = fileExt(file.name);
  const base = { name: file.name, size: file.size, ext, kindLabel: fileKindLabel(ext) };
  try {
    if (ext === 'pdf') {
      const r = await readPdf(file);
      return { ...base, kind: 'doc', text: r.text.slice(0, MAX_TEXT_PER_FILE), pages: r.pages, images: r.images || [], scanned: (r.images || []).length, truncated: r.truncated || r.text.length > MAX_TEXT_PER_FILE };
    }
    if (ext === 'docx') {
      const r = await readDocx(file);
      return { ...base, kind: 'doc', text: r.text.slice(0, MAX_TEXT_PER_FILE), truncated: r.text.length > MAX_TEXT_PER_FILE };
    }
    if (ext === 'pptx') {
      const r = await readPptx(file);
      return { ...base, kind: 'doc', text: r.text.slice(0, MAX_TEXT_PER_FILE), pages: r.pages, truncated: r.text.length > MAX_TEXT_PER_FILE };
    }
    if (['txt', 'md', 'csv', 'json'].includes(ext) || (file.type || '').startsWith('text/')) {
      const text = await file.text();
      return { ...base, kind: 'doc', text: text.slice(0, MAX_TEXT_PER_FILE), truncated: text.length > MAX_TEXT_PER_FILE };
    }
    if (ext === 'doc') throw new Error('旧版 .doc 暂不支持，请另存为 .docx 或 PDF');
    throw new Error('不支持的文件类型：' + (ext || file.type || '未知'));
  } catch (err) {
    return { ...base, kind: 'doc', error: err && err.message ? err.message : String(err) };
  }
}

export function summaryOf(att) {
  if (att.kind === 'image') return '图片';
  const bits = [att.kindLabel || '文件'];
  if (att.pages) bits.push(att.pages + ' 页');
  if (att.text) {
    const n = att.text.length;
    bits.push(n >= 1000 ? (Math.round(n / 100) / 10) + 'k 字' : n + ' 字');
  }
  if (att.scanned) bits.push(att.scanned + ' 张扫描页');
  return bits.join(' · ');
}
