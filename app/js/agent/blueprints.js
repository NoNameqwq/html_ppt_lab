/* ==========================================================================
   内置创作提示词（Creative Blueprints）
   - 用户只说「做什么主题」，这里负责把一句话扩成一份可执行的美术指导 + 分页脚本
   - 三个层次：视觉方向（ART_DIRECTIONS）/ 场景骨架（SCENES）/ 页型配方（PAGE_KINDS）
   - 同时给 Agent 系统提示词提供目录，给「一句话开演」弹窗提供选项
   ========================================================================== */

/** 视觉方向：配色、字体、质感、动效签名、版式习惯、禁忌 */
export const ART_DIRECTIONS = [
  {
    id: 'aurora',
    name: '极光渐变',
    tagline: '深空底色 + 大面光斑 + 玻璃卡片',
    palette: { bg: '#06070F', fg: '#F2F4FF', muted: '#8E93B8', accent: '#7C5CFF', accent2: '#35E0D0', line: '#242748' },
    type: { title: 'Sans 800 / 144–176px / 字距 -0.03em', body: 'Sans 400 / 30–34px / 行高 1.6', latin: 'Inter, Helvetica Neue' },
    texture: ['两到三团径向渐变光斑（紫 #7C5CFF / 青 #35E0D0，blur 120px 以上）', '1px 细网格，透明度 4–6%', '整体噪点 5%，暗角 18%'],
    motion: '光斑 14s 缓慢漂移；文字 900–1200ms expo 上浮 40px；玻璃卡 80ms 递进',
    layout: '左对齐巨标题 + 右侧玻璃数据卡；背景光斑压住 40% 画面；留白 ≥ 120px',
    avoid: '纯白底、居中三行小标题、硬边黑色投影、廉价霓虹描边',
    copy: '短句 + 一个具体数字（如「3.2 秒」）',
    textureCss: 'radial-gradient(60% 50% at 20% 15%, rgba(124,92,255,.55), transparent 70%), radial-gradient(50% 45% at 82% 70%, rgba(53,224,208,.32), transparent 72%)',
  },
  {
    id: 'swiss',
    name: '瑞士网格',
    tagline: '纸白、纯黑、一个信号红，严格对齐',
    palette: { bg: '#F4F2ED', fg: '#0B0B0C', muted: '#6E6C66', accent: '#E23A1F', accent2: '#0B0B0C', line: '#D8D4CB' },
    type: { title: 'Sans 900 / 128–168px / 紧字距 / 全部左对齐', body: 'Sans 400 / 28–32px / 行高 1.5', latin: 'Helvetica Neue, Arial' },
    texture: ['无渐变、无阴影', '3–4 条 1px 网格基线（上/左/右/底）', '大色块只用一个信号红'],
    motion: '遮罩上移 520ms inOut；数字翻牌；网格线 1px 逐条绘出',
    layout: '12 栏网格，标题占 7–9 栏；页码/章节号固定在角；大量负空间',
    avoid: '居中排版、圆角卡片、彩色渐变、超过两种字体',
    copy: '名词短句，不加形容词；数字用等宽字',
    textureCss: 'linear-gradient(to right, rgba(0,0,0,.06) 1px, transparent 1px) 0 0/120px 100%, linear-gradient(to bottom, rgba(0,0,0,.06) 1px, transparent 1px) 0 0/100% 120px',
  },
  {
    id: 'editorial',
    name: '杂志编辑',
    tagline: '米白纸感、超大衬线标题、细线与页码',
    palette: { bg: '#F7F4EE', fg: '#17140F', muted: '#7A736A', accent: '#9A2B2B', accent2: '#1F4A43', line: '#DCD5C8' },
    type: { title: 'Serif 600 / 120–200px / 行高 0.98', body: 'Serif 400 或 Sans 400 / 30px / 行高 1.7', latin: 'Playfair Display, Georgia' },
    texture: ['纸张噪点 4%', '1px 细线分区', '图片满版或半版出血，边缘不做圆角'],
    motion: '标题逐行 mask 上移 700ms；图片 scale 1.06 → 1 慢推；引文逐字 30ms',
    layout: '杂志封面式：刊头 / 主标题 / 副题 / 三条导读；正文两栏，栏距 56px',
    avoid: '卡通圆角、荧光色、居中大按钮、图标堆叠',
    copy: '标题像封面故事：主标题 6–10 字，副题一句长句',
    textureCss: 'none',
  },
  {
    id: 'noir',
    name: '暗夜电影',
    tagline: '近黑、暖金、宽字距与胶片颗粒',
    palette: { bg: '#0B0A09', fg: '#F3ECE1', muted: '#9C9387', accent: '#D8A657', accent2: '#7A5C3E', line: '#2A2620' },
    type: { title: 'Serif 500 / 120–160px / 字距 0.02em', body: 'Sans 300 / 30px / 行高 1.8', latin: 'Cormorant Garamond, Georgia' },
    texture: ['胶片颗粒 8%', '边缘暗角 30%', '暖金色细线，宽度 1px'],
    motion: '慢速推近（scale 1 → 1.04 / 8s）；文字 1400ms 淡入 + 8px 上移；金线从左展开',
    layout: '大留白，文字占 45%，其余交给暗部；标题与正文之间留 64px',
    avoid: '纯黑 #000、彩色渐变、快节奏弹跳、亮蓝',
    copy: '克制、留白、像旁白；每页只讲一句',
    textureCss: 'radial-gradient(120% 90% at 50% 0%, rgba(216,166,87,.10), transparent 60%), radial-gradient(100% 100% at 50% 100%, rgba(0,0,0,.55), transparent 60%)',
  },
  {
    id: 'celadon',
    name: '东方青瓷',
    tagline: '灰绿、留白、宋体与一枚印章红',
    palette: { bg: '#EDEFE9', fg: '#1F2A26', muted: '#6F7C74', accent: '#2F6E5E', accent2: '#B4462F', line: '#D2D8D0' },
    type: { title: 'Serif 500 / 110–150px / 字距 0.08em', body: 'Serif 400 / 30px / 行高 1.9', latin: 'Georgia, Times' },
    texture: ['宣纸纹理 3%', '竖向细线 1–2 条', '印章式小色块（#B4462F）只出现一次'],
    motion: '水墨扩散（clip-path 12 边形，900ms）；竖线从上落下；文字 40ms 逐字',
    layout: '竖排元素点缀 / 大面积留白 / 标题偏左上；一页一景',
    avoid: '高饱和色、粗黑边框、西式无衬线大标题、密集信息',
    copy: '四到八字短题，正文一句；可用「一 / 二 / 三」编号',
    textureCss: 'linear-gradient(90deg, rgba(47,110,94,.05) 1px, transparent 1px) 0 0/33.33% 100%',
  },
  {
    id: 'risograph',
    name: '印刷撞色',
    tagline: '荧光粉蓝、错版位移、贴纸与颗粒',
    palette: { bg: '#F6F1E4', fg: '#101010', muted: '#6B6558', accent: '#FF4D6D', accent2: '#2F5BFF', line: '#111111' },
    type: { title: 'Sans 900 / 132–180px / 厚描边或色块底', body: 'Sans 500 / 30px / 行高 1.55', latin: 'Archivo Black, Arial Black' },
    texture: ['两层错版色块（粉 + 蓝）偏移 6–10px', '颗粒 10%', '粗黑 2px 描边 + 无圆角'],
    motion: '贴纸弹入（back 600ms，旋转 -3° → 0）；色块错位抖动 2 帧；文字遮罩',
    layout: '海报式拼贴：大色块打底、手写标注、箭头与圈选',
    avoid: '高级灰、细衬线、渐变、均分网格',
    copy: '口语、有态度；可用「！」但一页最多一个',
    textureCss: 'repeating-linear-gradient(45deg, rgba(255,77,109,.12) 0 2px, transparent 2px 6px)',
  },
  {
    id: 'terminal',
    name: '技术终端',
    tagline: '纯黑、荧光绿、等宽字与扫描线',
    palette: { bg: '#05070A', fg: '#C8FFD4', muted: '#5F7F6B', accent: '#35FF9E', accent2: '#35B8FF', line: '#14301F' },
    type: { title: 'Mono 700 / 96–140px / 全大写或代码块', body: 'Mono 400 / 26–30px / 行高 1.7', latin: 'JetBrains Mono, Consolas' },
    texture: ['扫描线 2px', '终端窗口边框 1px', '光标闪烁 / 进度条'],
    motion: '逐字打字 28ms；行扫描 2s 循环；数字滚动；窗口从 0.96 弹出',
    layout: '左对齐代码块 + 右侧指标面板；一切像 CLI 输出',
    avoid: '圆角卡片、暖色、装饰插画、居中标题',
    copy: '命令式、可含 $ / > 前缀；术语准确',
    textureCss: 'repeating-linear-gradient(to bottom, rgba(53,255,158,.05) 0 1px, transparent 1px 3px)',
  },
  {
    id: 'clay',
    name: '黏土 3D',
    tagline: '奶油底、陶土色块、大圆角与柔和阴影',
    palette: { bg: '#F3E9DE', fg: '#2A211C', muted: '#8B7767', accent: '#E2703A', accent2: '#3E8E7E', line: '#E0D2C3' },
    type: { title: 'Sans 800 / 120–160px / 圆润字重', body: 'Sans 400 / 30px / 行高 1.65', latin: 'Nunito, Quicksand' },
    texture: ['多层柔和阴影（0 30px 60px rgba(...,.18)）', '大圆角 32–48px', '背景两枚模糊色球'],
    motion: '弹簧入场（spring，scale .92 → 1）；卡片依次浮起 60ms；轻微上下浮动 4s',
    layout: '卡片式分区，2–3 栏；每个卡片一个圆角色块 icon',
    avoid: '锐角、纯黑、荧光色、密集小字',
    copy: '亲切、具体；标题可带一个 emoji 不用超过 1 个',
    textureCss: 'radial-gradient(50% 40% at 15% 20%, rgba(226,112,58,.16), transparent 70%), radial-gradient(45% 35% at 85% 75%, rgba(62,142,126,.14), transparent 70%)',
  },
  {
    id: 'blueprint',
    name: '蓝图工程',
    tagline: '深蓝底、白色细线、网格与技术标注',
    palette: { bg: '#0A1B2E', fg: '#E8F1FF', muted: '#7E9BBE', accent: '#4EA8FF', accent2: '#FFC24E', line: '#1D3A5C' },
    type: { title: 'Sans 700 / 110–150px / 字距 0.01em', body: 'Sans 400 30px + Mono 标注 20px', latin: 'Inter, Roboto Mono' },
    texture: ['20px 细网格 + 100px 粗网格', '四角标注线 / 尺寸箭头', '半透明线框矩形'],
    motion: '线条自绘（stroke-dashoffset）；元素从中心 scale .96 展开；标注逐个出现',
    layout: '中心构图 + 四角标注；像工程图而不是幻灯片',
    avoid: '米色、圆角、彩色插画、居中大段正文',
    copy: '精确、带参数；用 A/B、v1.2、±0.1 这类记号',
    textureCss: 'linear-gradient(to right, rgba(78,168,255,.10) 1px, transparent 1px) 0 0/40px 100%, linear-gradient(to bottom, rgba(78,168,255,.10) 1px, transparent 1px) 0 0/100% 40px',
  },
  {
    id: 'vapor',
    name: '蒸汽波',
    tagline: '紫粉青霓虹、透视网格与铬字',
    palette: { bg: '#12002E', fg: '#FFE9FF', muted: '#A98BC8', accent: '#FF2FB5', accent2: '#35F2FF', line: '#3A1A63' },
    type: { title: 'Sans 900 / 130–170px / 渐变字 + 描边', body: 'Sans 400 / 30px', latin: 'TT Norms, Arial' },
    texture: ['透视网格地平线', '粉色光晕 + 青色描边', '扫描线 3%'],
    motion: '网格向前滚动 6s；标题轻微色差抖动；光晕呼吸 3s',
    layout: '中轴对称、地平线在 65%；大标题压在网格上',
    avoid: '商务蓝、细衬线、留白过多、写实照片',
    copy: '短、带一点复古未来感；可用「/」分隔',
    textureCss: 'linear-gradient(to bottom, transparent 55%, rgba(255,47,181,.18) 55.2%, transparent 55.4%), radial-gradient(60% 40% at 50% 62%, rgba(53,242,255,.18), transparent 70%)',
  },
];

/** 场景骨架：决定叙事节奏与默认方向 */
export const SCENES = [
  {
    id: 'product',
    name: '产品发布',
    direction: 'aurora',
    pages: 8,
    beats: [
      ['封面', '产品名 + 一句话主张'],
      ['问题', '三个反常识数字，说明旧办法失效'],
      ['转折', '一句核心洞察，占满一屏'],
      ['产品', '三项核心能力（图标 + 20 字说明）'],
      ['细节', '材质 / 工艺 / 参数特写'],
      ['场景', '谁在什么时刻用它'],
      ['价格', '版本与价格三档'],
      ['收尾', '口号 + 行动指令'],
    ],
  },
  {
    id: 'brand',
    name: '品牌提案',
    direction: 'editorial',
    pages: 8,
    beats: [
      ['封面', '品牌名 + 主张'],
      ['洞察', '目标人群的一句真实处境'],
      ['定位', '一句话定位（8–12 字）'],
      ['语言', '语气与用词示例'],
      ['视觉', '色彩 / 字体 / 图形系统'],
      ['应用', '海报 / 包装 / 屏幕三件套'],
      ['节奏', '一年三个传播节点'],
      ['收尾', '下一步与联系'],
    ],
  },
  {
    id: 'pitch',
    name: '融资路演',
    direction: 'swiss',
    pages: 10,
    beats: [
      ['封面', '项目名 + 一句话价值'],
      ['问题', '行业痛点与规模'],
      ['方案', '我们做什么（三步）'],
      ['产品', '核心界面 / 流程'],
      ['验证', '三个关键数据'],
      ['市场', 'TAM / SAM / SOM'],
      ['竞争', '二维定位图'],
      ['模型', '怎么赚钱'],
      ['团队', '三个人与三句背书'],
      ['收尾', '融资金额与用途'],
    ],
  },
  {
    id: 'annual',
    name: '年度总结',
    direction: 'blueprint',
    pages: 8,
    beats: [
      ['封面', '年份 + 一句主题'],
      ['回顾', '三个关键节点时间线'],
      ['数据', '四个核心指标'],
      ['突破', '一件做对的事'],
      ['复盘', '一件做错的事与修正'],
      ['团队', '人 / 组织变化'],
      ['明年', '三个目标'],
      ['收尾', '一句结束语'],
    ],
  },
  {
    id: 'research',
    name: '研究报告',
    direction: 'editorial',
    pages: 8,
    beats: [
      ['封面', '报告标题 + 副题'],
      ['结论', '先给结论（三条）'],
      ['方法', '数据来源与口径'],
      ['发现一', '图表 + 一句解读'],
      ['发现二', '图表 + 一句解读'],
      ['发现三', '反直觉发现'],
      ['建议', '三条可执行建议'],
      ['收尾', '附录与联系方式'],
    ],
  },
  {
    id: 'course',
    name: '课程分享',
    direction: 'clay',
    pages: 8,
    beats: [
      ['封面', '课程名 + 你会学到什么'],
      ['地图', '本次内容的四块拼图'],
      ['概念', '一个核心概念的定义'],
      ['例子', '一个具体案例拆解'],
      ['练习', '跟着做三步'],
      ['坑', '三个常见错误'],
      ['总结', '一页速查表'],
      ['收尾', '作业与延伸阅读'],
    ],
  },
  {
    id: 'portfolio',
    name: '个人作品集',
    direction: 'noir',
    pages: 8,
    beats: [
      ['封面', '名字 + 身份 + 一句自述'],
      ['方法', '我的工作方式（三步）'],
      ['项目一', '大图 + 一句结果'],
      ['项目二', '大图 + 一句结果'],
      ['项目三', '大图 + 一句结果'],
      ['能力', '技能矩阵'],
      ['经历', '时间线'],
      ['收尾', '邮箱 / 作品链接'],
    ],
  },
  {
    id: 'opening',
    name: '活动开场',
    direction: 'vapor',
    pages: 6,
    beats: [
      ['封面', '活动名 + 日期地点'],
      ['开场', '一句点燃气氛的话'],
      ['议程', '今天的三件事'],
      ['嘉宾', '讲者介绍'],
      ['规则', '互动与抽奖说明'],
      ['收尾', '倒计时 / 开始'],
    ],
  },
  {
    id: 'data',
    name: '数据故事',
    direction: 'terminal',
    pages: 8,
    beats: [
      ['封面', '一个反直觉的问题'],
      ['全景', '一张总览图'],
      ['拆解', '三个分层数字'],
      ['对比', '两条曲线的分叉'],
      ['归因', '三个原因'],
      ['预测', '未来两个季度'],
      ['行动', '三条建议'],
      ['收尾', '一句话结论'],
    ],
  },
  {
    id: 'tech',
    name: '技术架构',
    direction: 'blueprint',
    pages: 8,
    beats: [
      ['封面', '系统名 + 一句话定位'],
      ['约束', '三个硬指标（QPS / 延迟 / 成本）'],
      ['全景', '架构图（分层块）'],
      ['链路', '一次请求的路径'],
      ['取舍', '三个关键决策'],
      ['数据', '存储与一致性'],
      ['演进', '三个阶段的路线'],
      ['收尾', 'Q&A'],
    ],
  },
  {
    id: 'recruit',
    name: '招聘宣讲',
    direction: 'risograph',
    pages: 8,
    beats: [
      ['封面', '公司在做什么（一句话）'],
      ['为什么', '行业机会与三个数字'],
      ['做什么', '产品与用户'],
      ['怎么做', '团队工作方式'],
      ['在招', '四个岗位'],
      ['待遇', '薪酬与成长'],
      ['流程', '四步面试'],
      ['收尾', '投递方式 + 二维码位'],
    ],
  },
  {
    id: 'retro',
    name: '项目复盘',
    direction: 'swiss',
    pages: 8,
    beats: [
      ['封面', '项目名 + 结果一句话'],
      ['目标', '当初立的三个目标'],
      ['结果', '达成 / 未达成'],
      ['过程', '关键决策时间线'],
      ['做对', '三条可复用经验'],
      ['做错', '三条教训'],
      ['改进', '下个周期的三个动作'],
      ['收尾', '一句话总结'],
    ],
  },
];

/** 页型配方：坐标直接用，不用模型自己算 */
export const PAGE_KINDS = [
  { id: 'cover', name: '封面', goal: '主标题 + 副题 + 一条细线 / 页码', coords: '标题 x=120 y=300 w=1200 h=260；副题 x=124 y=600 w=760 h=100；细线 x=120 y=250 w=240 h=2；角标 x=1520 y=980' },
  { id: 'statement', name: '金句 / 转折', goal: '一句话占满整屏，最多加一行署名', coords: '正文 x=200 y=380 w=1520 h=320，64–88px 衬线，行高 1.3；署名 x=204 y=740' },
  { id: 'data', name: '数据页', goal: '一个主角数字 + 两个辅助指标', coords: '主数字 x=120 y=240 w=1000 h=320（200–260px）；说明 x=124 y=600 w=800；辅标 x=120/820/1520 y=780 w=280' },
  { id: 'split', name: '左文右图', goal: '文字区 + 满版图', coords: '文字 x=120 y=220 w=760；图 x=960 y=0 w=960 h=1080；标题 96px，正文 32px' },
  { id: 'grid', name: '卡片网格', goal: '2×2 或 3×1 的能力 / 项目卡', coords: '起点 x=120 y=260；卡 w=800 h=360（2×2，间距 40）或 w=520 h=420（3×1，间距 40）' },
  { id: 'list', name: '条目清单', goal: '3–4 条并列信息，带编号', coords: 'x=120 起，每条 y=240 + i*180，w=1400，h=140；序号 56px accent，正文 34px' },
  { id: 'quote', name: '引文 / 证言', goal: '一段引文 + 出处', coords: '引号 x=120 y=160 w=160 h=160（240px，opacity .18）；引文 x=200 y=320 w=1400；出处 x=204 y=760' },
  { id: 'section', name: '章节过渡', goal: '巨型编号 + 章节名', coords: '编号 x=120 y=140 w=700 h=700（420px，opacity .1）；章节名 x=120 y=640；短线 x=124 y=600 w=120 h=3' },
  { id: 'closing', name: '收尾', goal: '一句口号 + 行动指令 / 联系方式', coords: '口号 x=120 y=360 w=1400 h=240（112px）；行动 x=124 y=680 w=760；联系 x=124 y=860' },
];

/** 方向 → 主题变量（写进 deck 的 --wpx-*） */
export function directionThemeVars(id) {
  const dir = getDirection(id);
  if (!dir) return null;
  const p = dir.palette;
  return {
    '--wpx-bg': p.bg,
    '--wpx-fg': p.fg,
    '--wpx-fg-2': p.fg,
    '--wpx-muted': p.muted,
    '--wpx-accent': p.accent,
    '--wpx-accent-2': p.accent2,
    '--wpx-line': p.line,
  };
}

export function getDirection(id) {
  const key = String(id || '').trim();
  return ART_DIRECTIONS.find((d) => d.id === key) || null;
}

export function getScene(id) {
  const key = String(id || '').trim();
  return SCENES.find((s) => s.id === key) || null;
}

/** 按主题猜一个方向：用户没选时给出默认值 */
export function guessDirection(topic) {
  const t = String(topic || '');
  if (/数据|指标|增长|报表|风控|算法|架构|技术|系统/.test(t)) return 'blueprint';
  if (/品牌|杂志|文化|出版|设计|展览|艺术/.test(t)) return 'editorial';
  if (/发布|新品|科技|AI|智能|未来|元宇宙/.test(t)) return 'aurora';
  if (/年度|总结|复盘|汇报|战略/.test(t)) return 'swiss';
  if (/课程|教学|培训|工作坊|分享/.test(t)) return 'clay';
  if (/招聘|活动|派对|音乐|潮流/.test(t)) return 'risograph';
  if (/东方|茶|香|园林|非遗|山水/.test(t)) return 'celadon';
  if (/电影|影像|摄影|夜|酒/.test(t)) return 'noir';
  return 'editorial';
}

/** 生成分页脚本：页数可以覆盖场景默认值 */
export function planPages(count, scene) {
  const n = Math.max(3, Math.min(20, Number(count) || (scene ? scene.pages : 8)));
  const beats = scene && Array.isArray(scene.beats) && scene.beats.length
    ? scene.beats.map(([title, goal]) => ({ title, goal }))
    : null;
  const out = [];
  if (!beats) {
    const kinds = ['cover', 'statement', 'grid', 'data', 'quote', 'section', 'split', 'closing'];
    for (let i = 0; i < n; i += 1) {
      const kind = i === 0 ? 'cover' : i === n - 1 ? 'closing' : kinds[1 + ((i - 1) % (kinds.length - 1))];
      out.push({ kind, title: PAGE_KINDS.find((k) => k.id === kind)?.name || '内容', goal: '' });
    }
    return out;
  }
  if (n <= beats.length) {
    // 压缩：保留封面 + 收尾，中间均匀取
    const keep = [beats[0], beats[beats.length - 1]];
    const middle = beats.slice(1, -1);
    const slots = n - 2;
    for (let i = 0; i < slots; i += 1) {
      const idx = Math.round((i * (middle.length - 1)) / Math.max(1, slots - 1));
      keep.splice(1 + i, 0, middle[idx]);
    }
    return keep.slice(0, n).map((b, i) => ({ ...b, kind: pickKind(b.title, i, n) }));
  }
  // 扩展：中间补细节页
  for (let i = 0; i < n; i += 1) {
    const beat = beats[Math.min(beats.length - 1, Math.round((i * (beats.length - 1)) / (n - 1)))];
    out.push({ ...beat, kind: pickKind(beat.title, i, n) });
  }
  return out;
}

function pickKind(title, index, total) {
  if (index === 0) return 'cover';
  if (index === total - 1) return 'closing';
  const t = String(title || '');
  if (/数据|指标|结果|市场|规模/.test(t)) return 'data';
  if (/引文|证言|洞察|转折|金句/.test(t)) return 'quote';
  if (/章节|部分|第[一二三四五六七八九十]/.test(t)) return 'section';
  if (/能力|项目|应用|岗位|团队|网格/.test(t)) return 'grid';
  if (/列出|清单|三条|四条|原因|建议/.test(t)) return 'list';
  if (/图|界面|案例|细节|特写/.test(t)) return 'split';
  return 'list';
}

function directionBlock(dir) {
  const p = dir.palette;
  return [
    `视觉方向：${dir.name}（${dir.id}）——${dir.tagline}`,
    `- 主题变量：--wpx-bg:${p.bg} / --wpx-fg:${p.fg} / --wpx-muted:${p.muted} / --wpx-accent:${p.accent} / --wpx-accent-2:${p.accent2} / --wpx-line:${p.line}`,
    `- 字体：标题 ${dir.type.title}；正文 ${dir.type.body}`,
    `- 质感：${dir.texture.join('；')}`,
    `- 动效签名：${dir.motion}`,
    `- 版式习惯：${dir.layout}`,
    `- 文案语气：${dir.copy}`,
    `- 禁止：${dir.avoid}`,
  ].join('\n');
}

/**
 * 把「一句话主题」扩成一份完整的创作 brief。
 * @returns {{display:string, brief:string, direction:object, scene:object|null, pages:number}}
 */
export function buildCreationBrief(opts = {}) {
  const topic = String(opts.topic || '').trim() || '未命名主题';
  const pages = Math.max(3, Math.min(20, Number(opts.pages) || 8));
  const scene = getScene(opts.sceneId) || null;
  const dir = getDirection(opts.directionId) || getDirection(scene && scene.direction) || getDirection(guessDirection(topic));
  const plan = planPages(pages, scene);
  const kinds = plan.map((p, i) => {
    const kind = PAGE_KINDS.find((k) => k.id === p.kind) || PAGE_KINDS[0];
    return `${i + 1}. ${p.title || kind.name}｜页型 ${kind.name}（${kind.id}）：${p.goal || kind.goal}；坐标：${kind.coords}`;
  }).join('\n');

  const display = `做一套《${topic}》的演示 · ${dir.name} · ${pages} 页`;

  const brief = `【创作任务：只给主题，直接出成品】

主题：${topic}
交付：${pages} 页，1920×1080，独立的 HTML 演示（不是办公 PPT）；每页都要有视觉锚点和动效。
${scene ? `场景：${scene.name}（叙事骨架已给）` : '场景：自定，按「钩子 → 冲突 → 解法 → 证据 → 行动」组织'}

${directionBlock(dir)}

分页脚本（可微调页名，但不要改变叙事顺序）：
${kinds}

硬性要求
1. 一次成型：第一步就调用 deck_compose 写完整套（slides 数组，每页用 html 或 elements）；不要先问风格、不要逐页询问。
2. 视觉锚点：每页至少一个「大」元素——巨型数字 / 满版图 / 大色块 / 巨型引言 / 全屏图表；不允许出现「居中标题 + 三行要点」的模板页。
3. 文字克制：每页正文不超过 2 段、每段不超过 40 字；标题 6–14 字；数据给出具体数值与单位。
4. 动效预算：每页入场 2–4 个（delay 0/80/160ms 三档）；每页最多 1 个循环强调；至少 2 页使用非 fade 的切换（zoom / wipeUp / iris / shutter / curtains 等）；全片至少 1 条贯穿层（屏闪 / 光带 / 飞入），用时间线或 deck_set_transition_fx 实现。
5. 背景不是纯色：用 ${dir.texture[0]}；可以用 deck_compose 的 slide.html 直接写渐变、网格、SVG。
6. 结束后自检：deck_get_state 确认页数与切换；再补 2–3 处细节（转场叠加 / 时间线 / 全局 CSS），不要追加新页。
7. 不要使用「PPT」「幻灯片」「模板」这些词；不要 emoji（${dir.id === 'clay' ? '最多 1 个' : '一个都不要'}）；不要外链字体与图片。
8. 如果主题本身信息不足：用合理的行业常识补全，并在最后一行说明假设；不要停下来反问。

执行顺序（照做）
① deck_compose { direction:"${dir.id}", slides:[…${pages} 页…] }
② deck_set_transition_fx（2–3 页叠加：${dir.id === 'terminal' ? 'flash / sweep' : 'flash / fly / sweep'}）
③ deck_set_timeline 或 deck_add_slide 之外的细节修饰（贯穿光带 / 屏闪关键帧）
④ deck_get_state 复核 → 一句话汇报。`;

  return { display, brief, direction: dir, scene, pages };
}

/** 注入系统提示词的创作指南（含方向目录） */
export const CREATION_GUIDE = `## 创作模式（用户只给主题时）
判断：用户只说「做一套关于 X 的」「帮我做个 X 的演示 / 介绍 / 提案」，就是在创作模式下单，直接产出成品，不要反问风格。

流程（最多 4 步）：
1. 定方向：从下面的方向目录选一个最贴合主题的（用户指定则服从）；用户没指定页数时默认 8 页（3–20 页可调）。
2. 定脚本：按「钩子 → 冲突 → 解法 → 证据 → 行动」排页；封面 / 金句 / 数据 / 左右分栏 / 网格 / 引言 / 章节 / 收尾 交替使用。
3. 一次成型：调用 deck_compose 写入整套页面（direction + slides），元素坐标参考页型配方；每页必须有 1 个视觉锚点。
4. 加效果 + 自检：deck_set_transition_fx 叠加 2–3 处屏闪/飞入/扫光；需要贯穿效果时 deck_set_timeline；最后 deck_get_state 复核页数与切换。

质量红线：
- 禁止「居中大标题 + 三行要点」的模板页；禁止每页都用同一种淡入。
- 一页只讲一个论点；正文不超过 2 段 × 40 字；标题 6–14 字。
- 每页入场 2–4 个、循环强调 ≤1 个；至少 2 页使用非 fade 切换；全片至少 1 条贯穿效果。
- 背景要有质感（光斑 / 网格 / 噪点 / 渐层），不要纯色平铺。
- 不要 emoji，不要外链字体与图片；不要出现「PPT / 幻灯片 / 模板」字样。

视觉方向目录（deck_compose 的 direction 取值）：
${ART_DIRECTIONS.map((d) => `- ${d.id}｜${d.name}：${d.tagline}；主色 ${d.palette.accent}，底 ${d.palette.bg}；动效 ${d.motion.split('；')[0]}`).join('\n')}

页型配方（1920×1080，坐标可直接用）：
${PAGE_KINDS.map((k) => `- ${k.id}｜${k.name}：${k.goal}；${k.coords}`).join('\n')}`;
