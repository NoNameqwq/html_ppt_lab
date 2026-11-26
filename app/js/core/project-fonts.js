export const PROJECT_FONT_PATH = '/app/vendor/project-fonts/';

const families = [
  ['tsanger-feibai', '仓耳非白', 'sans', [[300, '仓耳非白W02.ttf'], [400, '仓耳非白W03.ttf']]],
  ['huiwen-mincho', '汇文明朝体 GBK', 'serif', [[400, '汇文明朝体GBKv1.001.ttf']]],
  ['huiwen-kaishu', '汇文正楷', 'serif', [[400, '汇文正楷v1.001.ttf']]],
  ['maoken-heavy', '猫啃网扛重族宋', 'serif', [[900, '猫啃网扛重族宋(完整版).ttf']]],
  ['maoken-yanbo', '猫啃网烟波宋', 'serif', [
    [200, '猫啃网烟波宋-E.ttf'], [300, '猫啃网烟波宋-L.ttf'], [400, '猫啃网烟波宋-R.ttf'],
    [600, '猫啃网烟波宋-S.ttf'], [700, '猫啃网烟波宋-B.ttf'], [900, '猫啃网烟波宋-H.ttf'],
  ]],
  ['ebas', '全字库说文解字', 'serif', [[400, '全字库说文解字.ttf']]],
  ['xiangcui-typewriter', '香萃打字机体', 'mono', [[300, '香萃打字机体 W15.ttf'], [400, '香萃打字机体 W35.ttf']]],
  ['xiangcui-kesong', '香萃刻宋', 'serif', [[400, '香萃刻宋（目前最新版）.ttf']]],
  ['yunfeng-hanchan', '云峰寒蝉体', 'sans', [[400, '云峰寒蝉体.ttf']]],
  ['aoyagi', '青柳隶书', 'serif', [[400, 'aoyagireisyosimo_ttf_2_01.ttf']]],
  ['aozora', '青空明朝', 'serif', [[100, 'AozoraMincho-thin.ttf'], [300, 'AozoraMinchoLight.ttf']]],
  ['boutique-bitmap', '精品点阵体 9×9', 'mono', [[400, 'BoutiqueBitmap9x9_1.92.ttf'], [700, 'BoutiqueBitmap9x9_Bold_1.92.ttf']]],
  ['dinglie-xida', '丁列细打体', 'sans', [[400, 'dingliexidafont (20250329V2).ttf']]],
  ['potta-one', 'Potta One', 'sans', [[400, 'FZ-PottaOne-Regular.ttf']]],
  ['like-jianjian', 'Like 简简体', 'sans', [[400, 'LikeJianJianTi-Regular.ttf']]],
  ['lxgw-marker', '霞鹜漫黑', 'sans', [[400, 'LXGWMarkerGothic-Regular.ttf']]],
  ['pop-maru', 'id-PopMaru', 'sans', [[400, 'maru401.ttf']]],
  ['ma-shan-zheng', '马善政毛笔楷书', 'serif', [[400, 'MaShanZheng-Regular.ttf']]],
  ['qiji', '齐伋体', 'serif', [[400, 'qiji-combo.ttf']]],
  ['sotyr-fangsong', '朱雀仿宋', 'serif', [[400, 'SotyrFangsong-Regular.ttf']]],
  ['sotyr-fangsong-s2t', '朱雀仿宋 S2T', 'serif', [[400, 'SotyrFangsong-S2T-Regular.ttf']]],
  ['soukou-mincho', '装甲明朝', 'serif', [[400, 'SoukouMincho.ttf']]],
  ['sa3m-serif', '思源三宋', 'serif', [
    [100, 'Source-Sa3mSerifCN-ExtraLight.ttf'], [300, 'Source-Sa3mSerifCN-Light.ttf'],
    [400, 'Source-Sa3mSerifCN-Regular.ttf'], [900, 'Source-Sa3mSerifCN-Heavy.ttf'],
  ]],
];

export const PROJECT_FONTS = families.map(([id, label, category, faces]) => {
  const family = 'wds-font-' + id;
  const fallback = { serif: 'serif', sans: 'sans-serif', mono: 'monospace' }[category];
  return {
    family, label, category, stack: `"${family}","${label}",${fallback}`,
    faces: faces.map(([weight, name]) => ({
      weight,
      url: PROJECT_FONT_PATH + encodeURIComponent(name).replace(/[()']/g, char => '%' + char.charCodeAt(0).toString(16)),
    })),
  };
});

export function projectFontFace(font, face, url = face.url) {
  return `@font-face{font-family:"${font.family}";src:url("${url}") format("truetype");font-weight:${face.weight};font-style:normal;font-display:swap}`;
}

export function projectFontCss(fonts = PROJECT_FONTS) {
  return fonts.flatMap(font => font.faces.map(face => projectFontFace(font, face))).join('\n');
}

export function projectFontsIn(source) {
  const used = new Set(source.match(/wds-font-[a-z0-9-]+/gi)?.map(name => name.toLowerCase()));
  return PROJECT_FONTS.filter(font => used.has(font.family));
}

export function projectFontStyle(css, mode = 'live') {
  return css ? `<style data-wds-project-fonts="${mode}">${css}</style>` : '';
}

export function prependProjectFontStyle(html, css, mode) {
  const style = projectFontStyle(css, mode);
  if (!style) return html;
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, head => head + style) : style + html;
}

export function editorProjectFonts() {
  return globalThis.location?.protocol === 'file:' ? [] : PROJECT_FONTS;
}
