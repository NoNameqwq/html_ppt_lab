/**
 * 艺术字工坊 —— 生成自包含的「字体作品」元素。
 *
 * 一个作品 = 一段 HTML（可再编辑）+ 一段作用域内 `<style>`：
 *   - 静态样式（渐变、描边、阴影、纹理、字体栈）全部写进元素自身的 CSS；
 *   - 动画用唯一命名关键帧，默认暂停，由 editor/type-runtime.js 在所在页显示时
 *     加 `.wtk-play` 触发，放映 / 导出同样依赖它；
 *   - 汉字笔画类作品把笔画路径直接内联进 SVG，导出文件不依赖任何字体或接口。
 *
 * 这个模块不触碰 DOM，可在浏览器、Agent 工具与 Node 测试中复用。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ==========================================================================
   字体栈：优先系统自带 / Office 附带字体，缺失时按同类回退
   ========================================================================== */
export const TYPE_FONTS = {
  script: { label: '花体英文', stack: '"Edwardian Script ITC","Monotype Corsiva","Segoe Script","Brush Script MT","Lucida Handwriting",cursive', italic: true, latin: true },
  blackletter: { label: '哥特体', stack: '"Old English Text MT","UnifrakturCook","Cloister Black",serif', latin: true },
  cursive: { label: '手写体', stack: '"Segoe Script","Bradley Hand","Ink Free","Comic Sans MS",cursive', latin: true },
  didone: { label: '高级衬线', stack: '"Bodoni MT","Didot","Playfair Display",Georgia,"Times New Roman",serif', latin: true },
  condensed: { label: '压缩海报体', stack: '"Haettenschweiler","Arial Narrow","Impact",sans-serif', latin: true },
  typewriter: { label: '打字机', stack: '"Courier New","Nimbus Mono PS",Georgia,serif', latin: true },
  mono: { label: '等宽科技', stack: '"Cascadia Code","JetBrains Mono",Consolas,"DejaVu Sans Mono",monospace' },
  xingkai: { label: '行楷', stack: '"STXingkai","华文行楷","FZShuTi","方正舒体","KaiTi","楷体",STKaiti,serif' },
  kaiti: { label: '楷体', stack: '"KaiTi","楷体","STKaiti","Kiwi SC",serif' },
  lishu: { label: '隶书', stack: '"STLiti","华文隶书","LiSu","隶书","FZLiShu-S01",serif' },
  songti: { label: '宋体', stack: '"Songti SC","STSong","SimSun","宋体",serif' },
  heiti: { label: '黑体', stack: '"Microsoft YaHei","PingFang SC","Noto Sans SC","Heiti SC",sans-serif' },
  round: { label: '圆体', stack: '"YouYuan","幼圆","Yuanti SC","Microsoft YaHei",sans-serif' },
  hupo: { label: '琥珀', stack: '"STHupo","华文琥珀","Microsoft YaHei",sans-serif' },
  caiyun: { label: '彩云', stack: '"STCaiyun","华文彩云","Microsoft YaHei",sans-serif' },
  serif: { label: '衬线', stack: 'Georgia,"Times New Roman","Songti SC",serif' },
  sans: { label: '无衬线', stack: 'Inter,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif' },
};

export function fontStack(key) {
  if (!key) return TYPE_FONTS.sans.stack;
  if (TYPE_FONTS[key]) return TYPE_FONTS[key].stack;
  return /[,"'\s]/.test(String(key)) ? String(key) : `"${String(key)}"`;
}

/* ==========================================================================
   预设目录
   ========================================================================== */
const SHADOW_CHAIN = (offset, color) => {
  const parts = [];
  for (let i = 1; i <= 18; i++) parts.push(`${i * offset[0]}px ${i * offset[1]}px ${color}`);
  return parts.join(',');
};

/**
 * 每个预设：
 *   id / group / label / hint
 *   split: 'none' | 'char' | 'stroke'
 *   font:  默认字体键
 *   defaults: 覆盖全局默认值（颜色等）
 *   css(ctx) -> string   作用域样式；ctx = {token, spec, cls}
 *   html(ctx) -> string  纯文字包装时的内部结构（可选）
 */
export const TYPE_PRESETS = [
  /* ---------------- 花体英文 / 字形 ---------------- */
  {
    id: 'script-swash', group: 'latin', label: '花体手写', hint: '华丽连笔英文，适合主标题与签名式文案', font: 'script',
    defaults: { color: '#F7F3EC', color2: '#E7C9A0', size: 148, italic: true, letterSpacing: -0.01 },
    css: ({ spec }) => `
.wtk--script-swash .wtk-text{font-style:italic;text-shadow:0 .04em .02em rgba(0,0,0,.18),0 .02em 0 var(--wtk-fg2)}
.wtk--script-swash .wtk-text{filter:drop-shadow(0 .06em .18em rgba(0,0,0,.35))}`,
  },
  {
    id: 'blackletter', group: 'latin', label: '哥特体', hint: '中世纪黑体，适合仪式感、复古主题', font: 'blackletter',
    defaults: { color: '#161310', color2: '#8C1C13', size: 132, letterSpacing: 0.01 },
    css: ({ spec }) => `
.wtk--blackletter .wtk-text{text-transform:uppercase;letter-spacing:.02em;text-shadow:.03em .03em 0 var(--wtk-fg2)}
.wtk--blackletter::after{content:'';position:absolute;left:8%;right:8%;bottom:.06em;height:.06em;background:linear-gradient(90deg,transparent,var(--wtk-fg2),transparent);opacity:.7}`,
  },
  {
    id: 'didone', group: 'latin', label: '高级衬线', hint: '高对比 Didone 字形，杂志与奢侈品语气', font: 'didone',
    defaults: { color: '#101014', color2: '#7C6A45', size: 140, letterSpacing: -0.015 },
    css: () => `
.wtk--didone .wtk-text{font-weight:600;letter-spacing:-.02em;text-shadow:0 .02em 0 rgba(0,0,0,.06)}`,
  },
  {
    id: 'condensed', group: 'latin', label: '压缩海报体', hint: '超窄字重，适合大字号、强冲击标题', font: 'condensed',
    defaults: { color: '#F5F3EF', size: 190, letterSpacing: -0.03 },
    css: () => `
.wtk--condensed .wtk-text{text-transform:uppercase;font-weight:800;line-height:.92;letter-spacing:-.035em}`,
  },
  {
    id: 'typewriter', group: 'latin', label: '打字机', hint: '机械衬线 + 微旧化，档案与叙事主题', font: 'typewriter',
    defaults: { color: '#22201C', size: 96, letterSpacing: 0.02 },
    css: () => `
.wtk--typewriter .wtk-text{font-weight:700;text-shadow:.02em .02em 0 rgba(0,0,0,.12);background-image:repeating-linear-gradient(0deg,rgba(0,0,0,.05) 0 1px,transparent 1px 3px);-webkit-background-clip:text;background-clip:text}`,
  },
  {
    id: 'mono-tech', group: 'latin', label: '等宽科技', hint: '终端质感，适合产品名、参数与代码语气', font: 'mono',
    defaults: { color: '#7CF7C4', size: 104, letterSpacing: 0.04 },
    css: ({ spec }) => `
.wtk--mono-tech .wtk-text{letter-spacing:.04em;text-shadow:0 0 .35em color-mix(in srgb,var(--wtk-fg) 45%,transparent)}
.wtk--mono-tech::before{content:'';position:absolute;inset:auto;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,transparent,var(--wtk-fg),transparent);opacity:.6}`,
  },
  {
    id: 'xingkai', group: 'cjk', label: '行楷诗韵', hint: '行楷书写感，适合诗词、文化与人文标题', font: 'xingkai',
    defaults: { color: '#1D1A16', color2: '#B23A2E', size: 132, letterSpacing: 0.06 },
    css: () => `
.wtk--xingkai .wtk-text{letter-spacing:.06em;text-shadow:0 .02em 0 rgba(0,0,0,.08)}
.wtk--xingkai .wtk-c{transform:rotate(var(--tilt,0deg))}`,
  },
  {
    id: 'lishu', group: 'cjk', label: '隶书碑意', hint: '横平竖直、波磔舒展，适合庄重与历史题材', font: 'lishu',
    defaults: { color: '#2A2118', size: 128, letterSpacing: 0.08 },
    css: () => `
.wtk--lishu .wtk-text{letter-spacing:.1em;text-shadow:.02em .02em 0 rgba(0,0,0,.1)}`,
  },
  {
    id: 'seal', group: 'cjk', label: '朱印', hint: '印章质感：红底反白，适合署名、章节印信', font: 'heiti',
    defaults: { color: '#FBF5EA', color2: '#B4281F', size: 96, letterSpacing: 0.04 },
    css: () => `
.wtk--seal .wtk-text{background:var(--wtk-fg2);color:var(--wtk-fg);padding:.16em .22em;border-radius:.06em;box-shadow:inset 0 0 0 .035em color-mix(in srgb,var(--wtk-fg) 55%,transparent),0 .02em .18em rgba(0,0,0,.28);-webkit-background-clip:border-box;background-clip:border-box;letter-spacing:.06em}
.wtk--seal .wtk-text{background-image:radial-gradient(circle at 30% 25%,rgba(255,255,255,.16),transparent 55%)}`,
  },
  {
    id: 'stele', group: 'cjk', label: '碑刻', hint: '凹刻质感：深色底、内阴影与凿痕', font: 'songti',
    defaults: { color: '#D9CEBB', color2: '#3B3228', size: 120, letterSpacing: 0.12 },
    css: () => `
.wtk--stele .wtk-text{font-weight:700;letter-spacing:.14em;color:var(--wtk-fg);text-shadow:-1px -1px 0 var(--wtk-fg2),1px 1px 0 rgba(255,255,255,.35),0 .04em .12em rgba(0,0,0,.5)}`,
  },
  {
    id: 'round', group: 'cjk', label: '圆润可爱', hint: '圆体字形，适合教学、儿童与轻松内容', font: 'round',
    defaults: { color: '#2A2A33', color2: '#FF8A5B', size: 116, letterSpacing: 0.02 },
    css: () => `
.wtk--round .wtk-text{font-weight:700;text-shadow:.02em .02em 0 var(--wtk-fg2)}`,
  },
  {
    id: 'hupo', group: 'cjk', label: '琥珀厚描', hint: '琥珀体厚重造型，喜感与视觉重量兼备', font: 'hupo',
    defaults: { color: '#FFC94A', color2: '#5A2E00', size: 126, letterSpacing: 0.03 },
    css: () => `
.wtk--hupo .wtk-text{font-weight:700;-webkit-text-stroke:.045em var(--wtk-fg2);paint-order:stroke fill;text-shadow:0 .05em 0 var(--wtk-fg2),0 .06em .18em rgba(0,0,0,.35)}`,
  },
  {
    id: 'caiyun', group: 'cjk', label: '彩云双描', hint: '空心双描边，适合喜庆与装饰性大字', font: 'caiyun',
    defaults: { color2: '#C2413A', size: 136, letterSpacing: 0.04 },
    css: () => `
.wtk--caiyun .wtk-text{color:transparent;-webkit-text-stroke:.03em var(--wtk-fg2);text-shadow:.03em .03em 0 rgba(255,255,255,.35)}`,

  },

  /* ---------------- 字体特效 ---------------- */
  {
    id: 'outline', group: 'effect', label: '空心描边', hint: '只有轮廓没有填充，适合叠在图片或色块上', font: 'heiti',
    defaults: { color: '#F7F6F2', size: 150, letterSpacing: 0.02 },
    css: ({ spec }) => `
.wtk--outline .wtk-text{color:transparent;-webkit-text-stroke:${clamp(num(spec.strokeWidth, 4), 1, 40)}px var(--wtk-fg);letter-spacing:.02em}`,
  },
  {
    id: 'neon', group: 'effect', label: '霓虹灯', hint: '多层外发光，深色底上效果最佳', font: 'heiti',
    defaults: { color: '#F4FBFF', color2: '#39E6FF', size: 132, letterSpacing: 0.04 },
    css: () => `
.wtk--neon .wtk-text{color:var(--wtk-fg);text-shadow:0 0 .06em var(--wtk-fg2),0 0 .22em var(--wtk-fg2),0 0 .6em var(--wtk-fg2)}
.wtk--neon .wtk-text{animation:wtkNeonFlicker 5s steps(1,end) infinite}
@keyframes wtkNeonFlicker{0%,93%,95%,100%{opacity:1}94%{opacity:.72}}`,
  },
  {
    id: 'gold', group: 'effect', label: '烫金', hint: '金箔渐变 + 细描边，适合典礼、证书、封面', font: 'didone',
    defaults: { color: '#F6D98A', color2: '#8C5B1E', size: 138, letterSpacing: 0.01 },
    css: () => `
.wtk--gold .wtk-text{background-image:linear-gradient(100deg,#8C5B1E 0%,#D9AE5A 18%,#FFF3C4 38%,#E3B864 52%,#8C5B1E 70%,#E8C57C 88%,#8C5B1E 100%);-webkit-background-clip:text;background-clip:text;color:transparent;background-size:220% 100%;filter:drop-shadow(0 .02em .02em rgba(0,0,0,.45)) drop-shadow(0 .01em 0 rgba(255,255,255,.25))}`,
  },
  {
    id: 'chrome', group: 'effect', label: '金属铬', hint: '银白铬面高光，适合科技与未来主题', font: 'condensed',
    defaults: { color: '#F2F6FA', size: 160, letterSpacing: -0.01 },
    css: () => `
.wtk--chrome .wtk-text{background-image:linear-gradient(180deg,#FDFEFF 0%,#DDE6EE 28%,#8FA0AE 47%,#F7FAFC 52%,#B6C3CE 68%,#6F7D89 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 .04em 0 rgba(0,0,0,.35))}`,
  },
  {
    id: 'glass', group: 'effect', label: '玻璃拟态', hint: '半透明磨砂质感，适合浅色底与轻盈主题', font: 'sans',
    defaults: { color: '#FFFFFF', color2: '#8FB7FF', size: 120, letterSpacing: 0.01 },
    css: () => `
.wtk--glass .wtk-text{color:color-mix(in srgb,var(--wtk-fg) 72%,transparent);-webkit-text-stroke:1px rgba(255,255,255,.65);paint-order:stroke fill;text-shadow:0 .02em .1em rgba(0,0,0,.28),0 0 .35em var(--wtk-fg2)}`,
  },
  {
    id: 'emboss', group: 'effect', label: '浮雕', hint: '压印进纸面：上亮下暗的细微浮雕', font: 'heiti',
    defaults: { color: '#E9E4DA', color2: '#A79E8F', size: 120, letterSpacing: 0.02 },
    css: () => `
.wtk--emboss .wtk-text{color:var(--wtk-fg);text-shadow:-1px -1px 0 rgba(255,255,255,.7),1px 1px 0 rgba(0,0,0,.35),0 .03em .08em rgba(0,0,0,.2)}`,
  },
  {
    id: 'extrude3d', group: 'effect', label: '立体挤出', hint: '等距厚度 + 落影，适合标题与数字', font: 'heiti',
    defaults: { color: '#FF6A4D', color2: '#8C2A1B', size: 140, letterSpacing: 0.02 },
    css: ({ spec }) => `
.wtk--extrude3d .wtk-text{color:var(--wtk-fg);text-shadow:${SHADOW_CHAIN([3, 3], 'var(--wtk-fg2)')},.08em .12em .22em rgba(0,0,0,.35)}`,
  },
  {
    id: 'retro-offset', group: 'effect', label: '复古错位', hint: '青品红双色错位，复古印刷与赛博语气', font: 'condensed',
    defaults: { color: '#F4F1EA', color2: '#FF4E8A', size: 164, letterSpacing: 0.01 },
    css: () => `
.wtk--retro-offset{isolation:isolate}
.wtk--retro-offset .wtk-text{position:relative;color:var(--wtk-fg);text-shadow:-.035em .035em 0 var(--wtk-fg2),.035em -.035em 0 #35D6E8}`,
  },
  {
    id: 'sticker', group: 'effect', label: '贴纸描边', hint: '粗白边 + 硬投影，贴纸与手账语气', font: 'round',
    defaults: { color: '#FFD84D', color2: '#1B1B1F', size: 118, letterSpacing: 0.02 },
    css: ({ spec }) => `
.wtk--sticker .wtk-text{-webkit-text-stroke:${clamp(num(spec.strokeWidth, 8), 2, 24)}px var(--wtk-fg2);paint-order:stroke fill;color:var(--wtk-fg);text-shadow:0 .06em 0 var(--wtk-fg2),0 .08em .16em rgba(0,0,0,.35)}`,
  },
  {
    id: 'glitch', group: 'effect', label: '故障风', hint: 'RGB 分离 + 抖动裁切，适合潮酷与科技', font: 'condensed',
    defaults: { color: '#F3F5F8', color2: '#FF2E63', size: 150, letterSpacing: 0.01 },
    css: ({ token }) => `
.wtk--glitch{isolation:isolate}
.wtk--glitch .wtk-text{position:relative;color:var(--wtk-fg);animation:${token}-jitter 3.2s steps(2,end) infinite}
.wtk--glitch::before,.wtk--glitch::after{content:attr(data-wtk-text);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.wtk--glitch::before{color:var(--wtk-fg2);transform:translate(-.02em,-.012em);mix-blend-mode:screen;clip-path:inset(12% 0 58% 0);animation:${token}-clipA 2.6s steps(3,end) infinite}
.wtk--glitch::after{color:#2ED9F0;transform:translate(.02em,.012em);mix-blend-mode:screen;clip-path:inset(62% 0 8% 0);animation:${token}-clipB 2.2s steps(4,end) infinite}
@keyframes ${token}-jitter{0%,96%,100%{transform:none}97%{transform:translateX(.006em)}98%{transform:translateX(-.004em)}}
@keyframes ${token}-clipA{0%,88%,100%{clip-path:inset(12% 0 58% 0)}90%{clip-path:inset(42% 0 22% 0)}94%{clip-path:inset(6% 0 74% 0)}}
@keyframes ${token}-clipB{0%,86%,100%{clip-path:inset(62% 0 8% 0)}88%{clip-path:inset(18% 0 54% 0)}92%{clip-path:inset(70% 0 4% 0)}}`,
  },
  {
    id: 'molten', group: 'effect', label: '熔金流光', hint: '熔融金属横向流动，重点数字与主视觉', font: 'didone',
    defaults: { color: '#FFD08A', color2: '#C2410C', size: 140, letterSpacing: 0.01 },
    css: ({ token }) => `
.wtk--molten .wtk-text{background-image:linear-gradient(100deg,#C2410C,#FFB347,#FFF0C2,#FF8A3D,#C2410C);background-size:240% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:${token}-flow 6s linear infinite;filter:drop-shadow(0 0 .18em rgba(255,138,61,.45))}
@keyframes ${token}-flow{to{background-position:240% 0}}`,
  },
  {
    id: 'holographic', group: 'effect', label: '镭射幻彩', hint: '虹彩渐变，适合潮牌、音乐与活动主题', font: 'condensed',
    defaults: { color: '#F6F7FB', size: 150, letterSpacing: 0.01 },
    css: ({ token }) => `
.wtk--holographic .wtk-text{background-image:linear-gradient(100deg,#FF5EA8,#FFD166,#5EE6B8,#5AC8FA,#B69CFF,#FF5EA8);background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:${token}-iris 9s linear infinite}
@keyframes ${token}-iris{to{background-position:300% 0}}`,
  },

  /* ---------------- 纹理填充 ---------------- */
  {
    id: 'texture-grain', group: 'texture', label: '胶片颗粒', hint: '细颗粒纹理填充，复古胶片与纪实语气', font: 'heiti',
    defaults: { color: '#F2EDE4', color2: '#B9AE9C', size: 128, letterSpacing: 0.02 },
    css: () => `
.wtk--texture-grain .wtk-text{color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)' opacity='.85'/%3E%3C/svg%3E");-webkit-background-clip:text;background-clip:text;-webkit-text-stroke:.02em var(--wtk-fg2);paint-order:stroke fill}`,
  },
  {
    id: 'texture-dots', group: 'texture', label: '波点', hint: '圆点网格填充，波普与轻快主题', font: 'round',
    defaults: { color: '#2B2B33', color2: '#FF7A59', size: 128, letterSpacing: 0.02 },
    css: () => `
.wtk--texture-dots .wtk-text{color:transparent;background-image:radial-gradient(var(--wtk-fg) 42%,transparent 44%);background-size:.18em .18em;-webkit-background-clip:text;background-clip:text;-webkit-text-stroke:.012em var(--wtk-fg2);paint-order:stroke fill}`,
  },
  {
    id: 'texture-stripes', group: 'texture', label: '斜纹', hint: '45° 条纹填充，运动与警示语气', font: 'condensed',
    defaults: { color: '#F5C84B', color2: '#1B1B1F', size: 150, letterSpacing: 0.01 },
    css: () => `
.wtk--texture-stripes .wtk-text{color:transparent;background-image:repeating-linear-gradient(135deg,var(--wtk-fg) 0 .055em,var(--wtk-fg2) .055em .11em);-webkit-background-clip:text;background-clip:text;-webkit-text-stroke:.014em rgba(0,0,0,.35);paint-order:stroke fill}`,
  },
  {
    id: 'texture-halftone', group: 'texture', label: '半调网点', hint: '大小渐变的印刷网点，复古海报质感', font: 'condensed',
    defaults: { color: '#111318', color2: '#E1402B', size: 148, letterSpacing: 0.01 },
    css: () => `
.wtk--texture-halftone .wtk-text{color:transparent;background-image:radial-gradient(circle at 50% 50%,var(--wtk-fg) 30%,transparent 32%),radial-gradient(circle at 50% 50%,var(--wtk-fg2) 30%,transparent 32%);background-size:.16em .16em,.32em .32em;background-position:0 0,.08em .08em;-webkit-background-clip:text;background-clip:text}`,
  },
  {
    id: 'texture-checker', group: 'texture', label: '格纹', hint: '棋盘格填充，街头与波普质感', font: 'condensed',
    defaults: { color: '#1B1B1F', color2: '#F3EFE6', size: 150, letterSpacing: 0.01 },
    css: () => `
.wtk--texture-checker .wtk-text{color:transparent;background-image:conic-gradient(var(--wtk-fg) 0 25%,var(--wtk-fg2) 0 50%,var(--wtk-fg) 0 75%,var(--wtk-fg2) 0);background-size:.14em .14em;-webkit-background-clip:text;background-clip:text}`,
  },
  {
    id: 'texture-metal', group: 'texture', label: '拉丝金属', hint: '细密横向拉丝纹理，工业与器材主题', font: 'heiti',
    defaults: { color: '#D7DEE4', size: 140, letterSpacing: 0.02 },
    css: () => `
.wtk--texture-metal .wtk-text{color:transparent;background-image:repeating-linear-gradient(0deg,#FFFFFF 0 .008em,#B9C4CC .008em .016em),linear-gradient(180deg,#FDFFFF,#8E9BA5);background-blend-mode:overlay;-webkit-background-clip:text;background-clip:text;filter:drop-shadow(0 .02em 0 rgba(0,0,0,.35))}`,
  },
  {
    id: 'texture-duotone', group: 'texture', label: '双色渐变', hint: '两色对角渐变填充，克制而有层次', font: 'sans',
    defaults: { color: '#5B8CFF', color2: '#B06BFF', size: 128, letterSpacing: 0.01 },
    css: () => `
.wtk--texture-duotone .wtk-text{background-image:linear-gradient(115deg,var(--wtk-fg),var(--wtk-fg2));-webkit-background-clip:text;background-clip:text;color:transparent}`,
  },

  /* ---------------- 阴影 ---------------- */
  {
    id: 'shadow-soft', group: 'shadow', label: '柔和投影', hint: '低对比柔和投影，最通用的可读性增强', font: 'sans',
    defaults: { color: '#FFFFFF', size: 112, letterSpacing: 0.01 },
    css: () => `
.wtk--shadow-soft .wtk-text{text-shadow:0 .06em .18em rgba(0,0,0,.35),0 .02em .04em rgba(0,0,0,.28)}`,
  },
  {
    id: 'shadow-hard', group: 'shadow', label: '硬边偏移', hint: '无模糊硬投影，编辑排版与复古印刷', font: 'heiti',
    defaults: { color: '#F5F2EA', color2: '#1B1B1F', size: 128, letterSpacing: 0.01 },
    css: () => `
.wtk--shadow-hard .wtk-text{text-shadow:.04em .04em 0 var(--wtk-fg2)}`,
  },
  {
    id: 'shadow-long', group: 'shadow', label: '长投影', hint: '连续偏移形成长影，适合大字与封面', font: 'condensed',
    defaults: { color: '#F7F4EC', color2: '#7A6DFF', size: 152, letterSpacing: 0.01 },
    css: () => `
.wtk--shadow-long .wtk-text{text-shadow:${SHADOW_CHAIN([2, 3], 'color-mix(in srgb,var(--wtk-fg2) 80%,transparent)')}}`,
  },
  {
    id: 'shadow-glow', group: 'shadow', label: '光晕阴影', hint: '彩色外发光，适合深色背景焦点文字', font: 'heiti',
    defaults: { color: '#FFFFFF', color2: '#5B8CFF', size: 120, letterSpacing: 0.01 },
    css: () => `
.wtk--shadow-glow .wtk-text{text-shadow:0 0 .12em var(--wtk-fg2),0 0 .32em color-mix(in srgb,var(--wtk-fg2) 70%,transparent),0 0 .8em color-mix(in srgb,var(--wtk-fg2) 45%,transparent)}`,
  },

  /* ---------------- 填充动效 / 动画 ---------------- */
  {
    id: 'fill-flow', group: 'motion', label: '渐变流动', hint: '渐变沿文字持续流动，循环播放', font: 'heiti', split: 'none',
    defaults: { color: '#7CE7FF', color2: '#B388FF', size: 130, letterSpacing: 0.02 },
    css: ({ token }) => `
.wtk--fill-flow .wtk-text{background-image:linear-gradient(100deg,var(--wtk-fg),var(--wtk-fg2),var(--wtk-fg));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:${token}-flow 5s linear infinite}
@keyframes ${token}-flow{to{background-position:220% 0}}`,
  },
  {
    id: 'fill-shimmer', group: 'motion', label: '高光扫过', hint: '一条高光周期扫过文字表面', font: 'heiti', split: 'none',
    defaults: { color: '#C9CED8', color2: '#FFFFFF', size: 130, letterSpacing: 0.03 },
    css: ({ token }) => `
.wtk--fill-shimmer .wtk-text{background-image:linear-gradient(100deg,var(--wtk-fg) 0%,var(--wtk-fg) 38%,var(--wtk-fg2) 50%,var(--wtk-fg) 62%,var(--wtk-fg) 100%);background-size:260% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:${token}-sweep 3.4s ease-in-out infinite}
@keyframes ${token}-sweep{0%{background-position:180% 0}55%,100%{background-position:-80% 0}}`,
  },
  {
    id: 'fill-liquid', group: 'motion', label: '液体填充', hint: '从下向上注满，适合标题与进度语气', font: 'heiti', split: 'none',
    defaults: { color: '#8BE9FD', color2: '#2B6CB0', size: 130, letterSpacing: 0.02 },
    css: ({ token }) => `
.wtk--fill-liquid .wtk-text{position:relative;color:transparent;-webkit-text-stroke:.018em color-mix(in srgb,var(--wtk-fg) 55%,transparent)}
.wtk--fill-liquid .wtk-text::after{content:attr(data-wtk-text);position:absolute;inset:0;color:transparent;background-image:linear-gradient(180deg,var(--wtk-fg),var(--wtk-fg2));-webkit-background-clip:text;background-clip:text;-webkit-text-stroke:0;clip-path:inset(100% 0 0 0);animation:${token}-rise 4.2s cubic-bezier(.4,0,.2,1) infinite}
@keyframes ${token}-rise{0%{clip-path:inset(100% 0 0 0)}55%,85%{clip-path:inset(0 0 0 0)}100%{clip-path:inset(100% 0 0 0)}}`,
  },
  {
    id: 'fill-glitter', group: 'motion', label: '闪耀粒子', hint: '文字表面周期性闪烁的星光点', font: 'didone', split: 'none',
    defaults: { color: '#FFE7A3', color2: '#FFFDF6', size: 132, letterSpacing: 0.02 },
    css: ({ token }) => `
.wtk--fill-glitter .wtk-text{color:transparent;background-image:radial-gradient(circle,var(--wtk-fg2) 0 18%,transparent 22%),linear-gradient(115deg,var(--wtk-fg),color-mix(in srgb,var(--wtk-fg) 70%,#8C5B1E));background-size:.22em .22em,100% 100%;background-position:0 0,0 0;-webkit-background-clip:text;background-clip:text;animation:${token}-twinkle 2.8s steps(3,end) infinite}
@keyframes ${token}-twinkle{0%,100%{background-position:0 0,0 0}33%{background-position:.11em .07em,0 0}66%{background-position:-.07em .13em,0 0}}`,
  },
  {
    id: 'motion-breathe', group: 'motion', label: '呼吸辉光', hint: '缓慢明暗变化，适合深色页面的焦点', font: 'heiti', split: 'none',
    defaults: { color: '#FFFFFF', color2: '#6EA8FF', size: 124, letterSpacing: 0.01 },
    css: ({ token }) => `
.wtk--motion-breathe .wtk-text{animation:${token}-breathe 3.6s ease-in-out infinite;text-shadow:0 0 .18em var(--wtk-fg2),0 0 .5em color-mix(in srgb,var(--wtk-fg2) 60%,transparent)}
@keyframes ${token}-breathe{0%,100%{opacity:.82;text-shadow:0 0 .12em var(--wtk-fg2),0 0 .32em color-mix(in srgb,var(--wtk-fg2) 45%,transparent)}50%{opacity:1;text-shadow:0 0 .24em var(--wtk-fg2),0 0 .7em color-mix(in srgb,var(--wtk-fg2) 70%,transparent)}}`,
  },
  {
    id: 'motion-char-pop', group: 'motion', label: '逐字弹入', hint: '每字依次弹性落位，适合短标题', font: 'heiti', split: 'char',
    defaults: { color: '#F5F3EE', size: 128, letterSpacing: 0.02, stagger: 0.075 },
    css: ({ token, spec }) => `
.wtk--motion-char-pop .wtk-c{display:inline-block;opacity:0;transform:translateY(.28em) scale(.72);animation:${token}-pop .78s cubic-bezier(.22,1.4,.4,1) forwards;animation-delay:calc(var(--i) * ${num(spec.stagger, 0.075)}s + .05s)}
@keyframes ${token}-pop{to{opacity:1;transform:none}}`,
  },
  {
    id: 'motion-char-flip', group: 'motion', label: '逐字翻转', hint: '3D 翻转出现，科技与发布会语气', font: 'condensed', split: 'char',
    defaults: { color: '#F8F8FA', color2: '#5B8CFF', size: 140, letterSpacing: 0.01, stagger: 0.06 },
    css: ({ token, spec }) => `
.wtk--motion-char-flip{perspective:1200px}
.wtk--motion-char-flip .wtk-c{display:inline-block;transform-origin:50% 100%;opacity:0;transform:rotateX(-92deg);animation:${token}-flip .72s cubic-bezier(.3,.9,.35,1) forwards;animation-delay:calc(var(--i) * ${num(spec.stagger, 0.06)}s + .05s);text-shadow:0 .04em .12em rgba(0,0,0,.35)}
@keyframes ${token}-flip{to{opacity:1;transform:none}}`,
  },
  {
    id: 'motion-char-wave', group: 'motion', label: '逐字波浪', hint: '循环的上下波动，轻松与活力语气', font: 'round', split: 'char',
    defaults: { color: '#FFE07A', size: 122, letterSpacing: 0.02, stagger: 0.09 },
    css: ({ token, spec }) => `
.wtk--motion-char-wave .wtk-c{display:inline-block;animation:${token}-wave 2.4s ease-in-out infinite;animation-delay:calc(var(--i) * ${num(spec.stagger, 0.09)}s)}
@keyframes ${token}-wave{0%,100%{transform:translateY(0)}50%{transform:translateY(-.16em)}}`,
  },
  {
    id: 'motion-tracking', group: 'motion', label: '字距收拢', hint: '从稀疏到紧密的对焦感，片头常用', font: 'sans', split: 'none',
    defaults: { color: '#F4F5F8', size: 120, letterSpacing: 0.02 },
    css: ({ token }) => `
.wtk--motion-tracking .wtk-text{animation:${token}-track 1.5s cubic-bezier(.2,.9,.2,1) both;white-space:pre}
@keyframes ${token}-track{from{letter-spacing:.6em;opacity:0;filter:blur(6px)}to{letter-spacing:var(--wtk-ls,.02em);opacity:1;filter:blur(0)}}`,
  },
  {
    id: 'motion-typing', group: 'motion', label: '逐字打字', hint: '等宽节奏逐字出现，叙事与纪录片语气', font: 'typewriter', split: 'char',
    defaults: { color: '#23211C', size: 104, letterSpacing: 0.02, stagger: 0.11 },
    css: ({ token, spec }) => `
.wtk--motion-typing .wtk-c{display:inline-block;opacity:0;animation:${token}-type 0s linear forwards;animation-delay:calc(var(--i) * ${num(spec.stagger, 0.11)}s)}
@keyframes ${token}-type{to{opacity:1}}`,
  },

  /* ---------------- 汉字笔画 ---------------- */
  {
    id: 'stroke-draw', group: 'stroke', label: '笔画书写', hint: '按真实笔顺逐笔写出，可循环或只播一次', font: 'heiti', split: 'stroke',
    defaults: { color: '#1E1B16', size: 160, letterSpacing: 0.04, duration: 0.55, strokeWidth: 72 },
    css: ({ token, spec }) => `
.wtk--stroke-draw .wtk-ch path{fill:none;stroke:var(--wtk-fg);stroke-width:${clamp(num(spec.strokeWidth, 72), 12, 160)};stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1}
.wtk--stroke-draw .wtk-ch path{animation:${token}-draw ${num(spec.duration, 0.55)}s cubic-bezier(.45,0,.3,1) forwards;animation-delay:calc(var(--d) * 1s)}
@keyframes ${token}-draw{to{stroke-dashoffset:0}}`,
  },
  {
    id: 'stroke-fill', group: 'stroke', label: '笔顺填充', hint: '先写笔画再填色，讲字理与书法课时使用', font: 'heiti', split: 'stroke',
    defaults: { color: '#161310', color2: '#E1402B', size: 160, letterSpacing: 0.04, duration: 0.5, strokeWidth: 26 },
    css: ({ token, spec }) => `
.wtk--stroke-fill .wtk-ch path{fill:var(--wtk-fg);opacity:0;stroke:var(--wtk-fg);stroke-width:${clamp(num(spec.strokeWidth, 26), 8, 120)};stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:${token}-fill ${num(spec.duration, 0.5)}s ease forwards;animation-delay:calc(var(--d) * 1s)}
@keyframes ${token}-fill{0%{opacity:1;stroke-dashoffset:1}70%{opacity:1;stroke-dashoffset:0}100%{opacity:1;stroke-dashoffset:0}}`,
  },
  {
    id: 'stroke-radical', group: 'stroke', label: '部首高亮', hint: '部首用强调色标出，字形结构讲解', font: 'heiti', split: 'stroke',
    defaults: { color: '#1B1915', color2: '#E1402B', size: 160, letterSpacing: 0.04, strokeWidth: 22 },
    css: ({ spec }) => `
.wtk--stroke-radical .wtk-ch path{fill:var(--wtk-fg);stroke:var(--wtk-fg);stroke-width:${clamp(num(spec.strokeWidth, 22), 6, 120)};stroke-linejoin:round}
.wtk--stroke-radical .wtk-ch path[data-rad="1"]{fill:var(--wtk-fg2);stroke:var(--wtk-fg2)}`,
  },
  {
    id: 'stroke-explode', group: 'stroke', label: '笔画拆解', hint: '每一笔依次错位后归位，讲解笔画构成', font: 'heiti', split: 'stroke',
    defaults: { color: '#1F1D19', color2: '#5B8CFF', size: 160, letterSpacing: 0.04, duration: 0.5, strokeWidth: 34 },
    css: ({ token, spec }) => `
.wtk--stroke-explode .wtk-ch path{fill:none;stroke:var(--wtk-fg);stroke-width:${clamp(num(spec.strokeWidth, 34), 8, 140)};stroke-linecap:round;stroke-linejoin:round;transform-box:fill-box;transform-origin:center;animation:${token}-explode ${Math.max(1.4, num(spec.duration, 0.5) * 3.4)}s cubic-bezier(.4,0,.2,1) both;animation-delay:calc(var(--d) * 1s)}
.wtk--stroke-explode .wtk-ch path:nth-child(2n){--dir:-1}
.wtk--stroke-explode .wtk-ch path:nth-child(3n){--dir:1}
@keyframes ${token}-explode{0%{opacity:0;transform:translate(calc(var(--dir,.6) * .9em),calc(var(--dir,-.7) * .6em)) rotate(18deg) scale(.7)}45%{opacity:1;transform:translate(calc(var(--dir,.6) * .16em),calc(var(--dir,-.7) * .1em)) rotate(3deg) scale(1)}100%{opacity:1;transform:none}}`,
  },
];

export const TYPE_GROUPS = [
  { id: 'latin', label: '花体英文' },
  { id: 'cjk', label: '中文字形' },
  { id: 'effect', label: '字体特效' },
  { id: 'texture', label: '纹理填充' },
  { id: 'shadow', label: '阴影' },
  { id: 'motion', label: '填充动效' },
  { id: 'stroke', label: '笔画拆解' },
];

export function typePreset(id) {
  return TYPE_PRESETS.find((p) => p.id === id) || null;
}

/* ==========================================================================
   规格归一化
   ========================================================================== */
export const TYPE_DEFAULTS = {
  text: '字由心生', preset: 'script-swash', font: '', size: 132, weight: 700,
  color: '#F7F3EC', color2: '#E7C9A0', letterSpacing: 0.02, lineHeight: 1.15,
  align: 'center', italic: false, uppercase: false, stagger: 0.075, duration: 0.55,
  strokeWidth: 4, loop: true, x: 160, y: 160, w: 1200, h: 320,
};

export function normalizeTypeSpec(input = {}) {
  const preset = typePreset(input.preset) || TYPE_PRESETS[0];
  const merged = { ...TYPE_DEFAULTS, ...preset.defaults, ...input, preset: preset.id };
  merged.text = String(merged.text ?? '').slice(0, 2000) || TYPE_DEFAULTS.text;
  merged.font = merged.font || preset.font || 'sans';
  merged.size = clamp(num(merged.size, 132), 8, 400);
  merged.weight = clamp(num(merged.weight, 700), 100, 900);
  merged.letterSpacing = clamp(num(merged.letterSpacing, 0.02), -0.2, 1.2);
  merged.lineHeight = clamp(num(merged.lineHeight, 1.15), 0.7, 3);
  merged.color = safeColor(merged.color, TYPE_DEFAULTS.color);
  merged.color2 = safeColor(merged.color2, TYPE_DEFAULTS.color2);
  merged.strokeWidth = clamp(num(merged.strokeWidth, 4), 0.5, 160);
  merged.stagger = clamp(num(merged.stagger, 0.075), 0, 2);
  merged.duration = clamp(num(merged.duration, 0.55), 0.05, 12);
  merged.align = ['left', 'center', 'right'].includes(merged.align) ? merged.align : 'center';
  merged.loop = merged.loop !== false;
  merged.split = merged.split || preset.split || 'none';
  return merged;
}

/**
 * 相对亮度（0–1）。用于判断配色在给定底色上是否看得见。
 */
export function luminanceOf(color) {
  const rgb = toRgb(color);
  if (!rgb) return null;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function toRgb(color) {
  const v = String(color || '').trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(v);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) return parts.map((n) => clamp(n, 0, 255) / 255);
  }
  const named = ({ white: '#ffffff', black: '#000000' })[v];
  return named ? toRgb(named) : null;
}

/** 对比度（WCAG），用于判断文字在页面上是否可读。 */
export function contrastRatio(a, b) {
  const la = luminanceOf(a), lb = luminanceOf(b);
  if (la == null || lb == null) return 1;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 按页面底色修正深色预设的默认色：深墨字落到深色页上会完全看不见，
 * 这时把主色换成浅色版本，保持预设语气（如"碑刻"仍是石灰色）。
 * 只在调用方没有显式指定颜色时生效。
 */
export function adaptToBackground(spec, background) {
  if (!background || spec.colorLocked) return spec;
  const light = luminanceOf(background);
  if (light == null) return spec;
  const darkPage = light < 0.42;
  const current = contrastRatio(spec.color, background);
  if (!darkPage || current >= 2.4) return spec;
  const lighten = {
    '#1e1b16': '#efe7d8', '#161310': '#f2ebdd', '#2a2118': '#efe7d6', '#1b1915': '#f2ecdf',
    '#1f1d19': '#f1ece2', '#23211c': '#f4efe4', '#22201c': '#f2ece0', '#2b2b33': '#f2f2f6',
    '#1b1b1f': '#f4f3f8', '#101014': '#f7f5ef', '#111318': '#f5f3ec', '#2a2a33': '#f3f3f8',
  };
  const next = lighten[String(spec.color).toLowerCase()];
  return { ...spec, color: next || '#f5f2ea' };
}

function safeColor(value, fallback) {
  const v = String(value ?? '').trim();
  if (!v) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(?:rgb|hsl)a?\([^)]*\)$/i.test(v)) return v;
  if (/^[a-z]{3,24}$/i.test(v)) return v;
  if (/^(?:var|color-mix|light-dark)\([^;{}"']*\)$/i.test(v)) return v;
  return fallback;
}

/* ==========================================================================
   生成
   ========================================================================== */
const tokenFor = () => 'wtk' + Math.random().toString(36).slice(2, 8);

export function splitChars(text) {
  return Array.from(String(text));
}

function charMarkup(spec) {
  const chars = splitChars(spec.text);
  const spans = chars.map((ch, i) => {
    if (ch === ' ') return `<span class="wtk-c" style="--i:${i}">&nbsp;</span>`;
    return `<span class="wtk-c" style="--i:${i}">${esc(ch)}</span>`;
  });
  return `<span class="wtk-text" data-wtk-text="${esc(spec.text)}">${spec.split === 'char' ? spans.join('') : esc(spec.text)}</span>`;
}

/* ---------- 汉字笔画 ---------- */
const STROKE_VIEW = 1024;
const STROKE_TRANSFORM = 'translate(0,900) scale(1,-1)';

/**
 * 导出汉字笔画 SVG。strokes 为 {char: {strokes, medians, radStrokes}}。
 * 缺数据的字符退化为普通文字，保证混合中英文时仍然成立。
 */
export function strokeCharSvg(char, data, { delay = 0, strokeWidth = 26, radicalColor = null } = {}) {
  if (!data || !Array.isArray(data.strokes) || !data.strokes.length) {
    return `<span class="wtk-ch wtk-ch--text" style="--d:${delay.toFixed(3)}">${esc(char)}</span>`;
  }
  const radical = new Set(Array.isArray(data.radStrokes) ? data.radStrokes : []);
  const paths = data.strokes.map((d, i) => {
    const isRadical = radical.has(i);
    const fill = isRadical && radicalColor ? ` data-rad="1"` : '';
    return `<path d="${esc(d)}" pathLength="1"${fill} style="--d:${(delay + i * 0.34).toFixed(3)}"></path>`;
  });
  return `<span class="wtk-ch" style="--d:${delay.toFixed(3)}"><svg viewBox="0 0 1024 1024" role="img" aria-label="${esc(char)}" preserveAspectRatio="xMidYMid meet"><g transform="${STROKE_TRANSFORM}">${paths.join('')}</g></svg></span>`;
}

function strokeMarkup(spec, strokeMap, token) {
  const chars = splitChars(spec.text).filter((c) => c.trim());
  const out = chars.map((ch, i) => strokeCharSvg(ch, strokeMap?.[ch], {
    delay: i * Math.max(0.5, chars.length > 3 ? 0.9 : 1.2),
    strokeWidth: spec.strokeWidth,
    radicalColor: spec.color2,
  }));
  const label = esc(spec.text);
  return `<span class="wtk-text wtk-text--stroke" role="img" aria-label="${label}" data-wtk-text="${label}">${out.join('')}</span>`;
}

export function buildTypeKit(input = {}, opts = {}) {
  const spec = normalizeTypeSpec(input);
  const preset = typePreset(spec.preset);
  const token = opts.token || tokenFor();
  const strokeMap = opts.strokes || {};
  const isStroke = spec.split === 'stroke';
  const inner = isStroke ? strokeMarkup(spec, strokeMap, token) : charMarkup(spec);
  const scoped = preset.css ? preset.css({ token, spec }) : '';
  // 笔画作品必须自己撑起 SVG 的尺寸：SVG 默认宽高 100%，父级 inline 元素会算成 0。
  const strokeBase = isStroke
    ? `\n.wtk--${preset.id} .wtk-text--stroke{display:inline-flex;align-items:center;gap:.04em}
.wtk--${preset.id} .wtk-ch{display:inline-block;width:1em;height:1em;flex:none}
.wtk--${preset.id} .wtk-ch svg{width:100%;height:100%;display:block;overflow:visible}
.wtk--${preset.id} .wtk-ch--text{width:auto;height:auto;font:inherit;line-height:1}`
    : '';
  const loopOff = isStroke && !spec.loop
    ? `\n.wtk--${preset.id} .wtk-ch path{animation-iteration-count:1!important}`
    : '';
  // 动画默认暂停，由 type-runtime 在所在页显示时加 .wtk-play 才开始。
  // 用 .wds-type-js 作为开关：脚本没加载时这条规则不存在，动画照常播放，
  // 不会出现「一直没有内容」的空白页。
  const gate = scoped
    ? `\n.wds-type-js .wtk--${preset.id}:not(.wtk-play) .wtk-text,.wds-type-js .wtk--${preset.id}:not(.wtk-play) .wtk-c,.wds-type-js .wtk--${preset.id}:not(.wtk-play) .wtk-ch path,.wds-type-js .wtk--${preset.id}:not(.wtk-play)::before,.wds-type-js .wtk--${preset.id}:not(.wtk-play)::after,.wds-type-js .wtk--${preset.id}:not(.wtk-play) .wtk-text::before,.wds-type-js .wtk--${preset.id}:not(.wtk-play) .wtk-text::after{animation-play-state:paused}`
    : '';
  const css = strokeBase + scoped + loopOff + gate;
  const varStyle = [
    `--wtk-fg:${spec.color}`,
    `--wtk-fg2:${spec.color2}`,
    `--wtk-ls:${spec.letterSpacing}em`,
    `--wtk-dur:${spec.duration}s`,
    `font-size:${spec.size}px`,
    `font-weight:${spec.weight}`,
    `font-family:${fontStack(spec.font)}`,
    `font-style:${spec.italic || TYPE_FONTS[spec.font]?.italic ? 'italic' : 'normal'}`,
    `letter-spacing:${spec.letterSpacing}em`,
    `line-height:${spec.lineHeight}`,
    `text-align:${spec.align}`,
    `color:${spec.color}`,
    spec.uppercase ? 'text-transform:uppercase' : '',
  ].filter(Boolean).join(';');
  // 字体名在字体栈里用双引号书写；直接拼进 style="…" 会提前闭合属性，
  // 让 font-family 之后声明（斜体、字距、对齐…）全部失效并退回默认字体。
  // 单引号在这里同样合法，且不需要依赖实体转义。
  const styleValue = [
    'position:relative', 'width:100%', 'height:100%', 'display:flex', 'align-items:center',
    `justify-content:${spec.align === 'left' ? 'flex-start' : spec.align === 'right' ? 'flex-end' : 'center'}`,
    'box-sizing:border-box', varStyle, 'white-space:pre',
  ].filter(Boolean).join(';').replace(/"/g, "'");
  const attrs = [
    `class="wtk wtk--${preset.id}"`,
    `data-wds-type="${preset.id}"`,
    `data-wtk-version="1"`,
    `data-wtk-text="${esc(spec.text)}"`,
    `data-wtk-split="${spec.split}"`,
    `role="group"`,
    `aria-label="${esc(spec.text)}"`,
    `style="${styleValue}"`,
  ].join(' ');
  const cssBlock = css.trim() ? `<style data-wds-type-css>${css.trim()}</style>` : '';
  return {
    ok: true,
    html: `<div ${attrs}>${inner}${cssBlock}</div>`,
    css,
    token,
    spec,
    preset: preset.id,
    w: clamp(num(input.w, defaultBoxWidth(spec)), 80, 3840),
    h: clamp(num(input.h, Math.round(spec.size * 1.6)), 40, 2160),
  };
}

function defaultBoxWidth(spec) {
  const chars = splitChars(spec.text).length;
  return Math.round(clamp(chars * spec.size * 1.05 + 80, 320, 1800));
}

/** 估算某段文字需要的笔画数据字符集（去掉标点、拉丁字母与空白）。 */
export function strokeCharsOf(text) {
  const out = new Set();
  for (const ch of splitChars(String(text))) if (/[㐀-鿿豈-﫿]/.test(ch)) out.add(ch);
  return [...out];
}
