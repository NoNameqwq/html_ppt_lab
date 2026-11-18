/* Agent 内置工具：OpenAI function schema + 执行器（统一走编辑器 bridge） */

import { clamp, escapeHtml, sleep } from '../core/dom.js';
import { ART_DIRECTIONS, getDirection, directionThemeVars } from './blueprints.js';
import { API_CATALOG, apiURL } from './api-catalog.js';
import { renderFormula, sanitizeSvg, formulaMarkup, preparePageRichContent } from '../core/rich-content.js';
import { buildNavigationHTML, resolveChapters } from '../core/deck-navigation.js';
import { availableFonts, recommendFonts } from '../core/fonts.js';
import { threeMarkup } from '../core/three-content.js';
import { buildTypeKit, adaptToBackground, TYPE_FONTS, TYPE_GROUPS, TYPE_PRESETS, typePreset } from '../core/type-kit.js';
import { fetchStrokes } from '../core/stroke-data.js';
import { favoriteHasCode } from '../core/favorite-data.js';

/* 文本截断（core/dom.js 未提供） */
function truncate(str, max = 120) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/* ---------- 工具元信息（UI 卡片显示用） ---------- */

export const TOOL_META = {
  agent_parallel:{label:'并行子代理',kind:'read',icon:'users'},
  agent_parallel_status:{label:'查看子代理进度',kind:'read',icon:'users'},
  agent_wait:{label:'等待所需子代理',kind:'read',icon:'users'},
  agent_handoff:{label:'子代理交接',kind:'read',icon:'users'},
  deck_insert_3d:{label:'构建交互式 3D',kind:'write',icon:'box'},
  deck_get_3d_state:{label:'检查 3D 渲染状态',kind:'read',icon:'box'},
  deck_set_navigation: { label: '设计章节目录', kind: 'write', icon: 'list' },
  deck_generate_image: { label: '生成并插入配图', kind: 'write', icon: 'image' },
  deck_insert_math: { label: '排版 LaTeX 公式', kind: 'write', icon: 'code' },
  deck_insert_svg: { label: '绘制 SVG 图解', kind: 'write', icon: 'shapes' },
  deck_auto_fonts: { label: '自动选择字体', kind: 'write', icon: 'type' },
  deck_insert_type: { label: '排版艺术字', kind: 'write', icon: 'type' },
  type_presets: { label: '查看艺术字预设', kind: 'read', icon: 'type' },
  fonts_list: { label: '查看可用字体', kind: 'read', icon: 'type' },
  app_list_apis: { label: '发现网页接口', kind: 'read', icon: 'list' },
  app_call_api: { label: '调用网页接口', kind: 'read', icon: 'terminal' },
  tool_result_read: { label: '读取完整工具结果', kind: 'read', icon: 'file-text' },
  file_patch: { label: '局部修改文件', kind: 'file', icon: 'code' },
  deck_get_state: { label: '读取工程状态', kind: 'read', icon: 'cpu' },
  deck_capture_slide: { label:'查看页面画面',kind:'read',icon:'image' },
  deck_read_slide: { label: '读取幻灯片', kind: 'read', icon: 'layout' },
  deck_get_element: { label: '读取元素', kind: 'read', icon: 'search' },
  deck_get_html: { label: '读取 deck HTML', kind: 'read', icon: 'code' },
  file_read: { label: '读取文件', kind: 'read', icon: 'file-text' },
  file_list: { label: '列出工程文件', kind: 'read', icon: 'folder' },
  project_info: { label: '读取工程信息', kind: 'read', icon: 'info' },
  web_search: { label: '联网搜索', kind: 'read', icon: 'search' },
  deck_set_text: { label: '修改文字', kind: 'write', icon: 'type' },
  deck_set_style: { label: '修改样式', kind: 'write', icon: 'palette' },
  deck_set_attrs: { label: '修改属性', kind: 'write', icon: 'tag' },
  deck_move_element: { label: '移动元素', kind: 'write', icon: 'move' },
  deck_resize_element: { label: '调整尺寸', kind: 'write', icon: 'maximize' },
  deck_insert_text: { label: '插入文本框', kind: 'write', icon: 'text' },
  deck_insert_image: { label: '插入图片', kind: 'write', icon: 'image' },
  deck_insert_shape: { label: '插入形状', kind: 'write', icon: 'shapes' },
  deck_insert_html: { label: '插入 HTML', kind: 'write', icon: 'code' },
  deck_delete_element: { label: '删除元素', kind: 'write', icon: 'trash' },
  deck_set_animation: { label: '设置动效', kind: 'write', icon: 'film' },
  deck_add_slide: { label: '新增幻灯片', kind: 'write', icon: 'file-plus' },
  deck_compose: { label: '整套生成', kind: 'write', icon: 'sparkles' },
  deck_set_transition_fx: { label: '叠加转场特效', kind: 'write', icon: 'sparkles' },
  deck_set_element_action: { label: '设置点击行为', kind: 'write', icon: 'mouse' },
  deck_duplicate_slide: { label: '复制幻灯片', kind: 'write', icon: 'copy' },
  deck_delete_slide: { label: '删除幻灯片', kind: 'write', icon: 'trash' },
  deck_move_slide: { label: '移动幻灯片', kind: 'write', icon: 'sort-asc' },
  deck_set_slide_attrs: { label: '修改页属性', kind: 'write', icon: 'sliders' },
  deck_set_deck_css: { label: '修改全局 CSS', kind: 'write', icon: 'code' },
  deck_set_deck_js: { label: '修改全局 JS', kind: 'write', icon: 'terminal' },
  deck_set_custom_transition: { label: '自定义页面转场', kind: 'write', icon: 'film' },
  deck_set_timeline: { label: '动画时间线', kind: 'write', icon: 'film' },
  deck_get_timeline: { label: '读取动画时间线', kind: 'read', icon: 'film' },
  deck_apply_slide_html: { label: '替换整页 HTML', kind: 'write', icon: 'file-code' },
  deck_set_theme: { label: '切换主题', kind: 'write', icon: 'palette' },
  deck_set_deck_flags: { label: '设置全局效果', kind: 'write', icon: 'sliders' },
  deck_undo: { label: '撤销修改', kind: 'write', icon: 'undo' },
  history_list: { label: '查看修改历史', kind: 'read', icon: 'history' },
  file_write: { label: '写入文件', kind: 'file', icon: 'save' },
  app_list_commands: { label: '列出编辑器命令', kind: 'read', icon: 'terminal' },
  app_run_command: { label: '执行编辑器命令', kind: 'write', icon: 'command' },
  update_plan: { label: '更新任务计划', kind: 'read', icon: 'list' },
};

export function getToolMeta(name) {
  return TOOL_META[name] || { label: name, kind: 'write', icon: 'wrench' };
}

// Resolve nested dispatchers too: a generic API tool can be a project write.
export function mutationProject(ctx, name, args = {}) {
  const current = ctx.store.get().project?.id || null;
  if (name === 'app_call_api') {
    const op = API_CATALOG.find((o) => o.id === args.operation);
    return op && op.method !== 'GET' && op.permission !== 'read' && op.path.includes('{projectId}')
      && op.id !== 'versions.create' ? args.projectId || current : null;
  }
  if (name === 'app_run_command') {
    if (['favorites.save','favorites.open'].includes(args.name)) return null;
    if (commandAccess(String(args.name || '')) === 'blocked') return null;
    if (/^(app\.(save|reloadDeck|settings)|file\.(export|download)|view\.|present\.|zoom\.|agent\.)/.test(args.name || '')) return null;
  }
  return TOOL_META[name] && TOOL_META[name].kind !== 'read' ? current : null;
}

/* ---------- 工作权限（Codex 风格 approval mode） ---------- */

export const PERMISSION_LEVELS = [
  { id: 'read', label: '只读', tip: '只能读取工程，不能修改' },
  { id: 'edit', label: '可编辑', tip: '可改幻灯片内容 / 样式 / 动效 / 页面结构' },
  { id: 'full', label: '完全访问', tip: '可改代码、写文件、自定义转场' },
];

const PERMISSION_RANK = { read: 0, edit: 1, full: 2 };

/** 需要「完全访问」的工具（改代码 / 写文件 / 自定义转场 / 整页重写 / 全局效果） */
const FULL_ONLY_TOOLS = new Set([
  'file_patch',
  'file_write',
  'deck_set_deck_js',
  'deck_set_deck_css',
  'deck_set_custom_transition',
  'deck_set_deck_flags',
  'deck_apply_slide_html',
]);

export function normalizePermission(permission) {
  return PERMISSION_RANK[permission] != null ? permission : 'edit';
}

export function getToolAccess(name) {
  if (FULL_ONLY_TOOLS.has(name)) return 'full';
  const meta = TOOL_META[name];
  if (!meta) return 'full';
  return meta.kind === 'read' ? 'read' : 'edit';
}

export function permissionRank(permission) {
  const rank = PERMISSION_RANK[normalizePermission(permission)];
  return rank == null ? 1 : rank;
}

export function permissionLabel(permission) {
  const level = PERMISSION_LEVELS.find((p) => p.id === normalizePermission(permission));
  return level ? level.label : '可编辑';
}

export function canUseTool(permission, name) {
  return permissionRank(permission) >= permissionRank(getToolAccess(name));
}

/** 按当前权限过滤工具定义（只读模式不下发写工具，节省 token 也避免误调用） */
export function getToolDefinitionsForPermission(permission, options = {}) {
  return TOOL_DEFINITIONS.filter((d) => {
    const name = d.function && d.function.name;
    if (name === 'web_search' && !options.webSearch) return false;
    if (name === 'deck_generate_image' && !options.imageGeneration) return false;
    if (name === 'deck_capture_slide' && options.vision === false) return false;
    return canUseTool(permission, name);
  });
}

/* ---------- JSON Schema 定义 ---------- */

const ELEMENT_ID = {
  type: 'string',
  description: '元素 id（data-wpx-el）。省略时使用当前选中元素。',
};

const INDEX_PARAM = {
  type: 'integer',
  description: '页索引，从 0 开始；省略时使用当前页。',
};

const XYWH = {
  x: { type: 'number', description: '左上角 x（画布坐标 1920 宽），默认 160。' },
  y: { type: 'number', description: '左上角 y（画布坐标 1080 高），默认 160。' },
  w: { type: 'number', description: '宽度 px。' },
  h: { type: 'number', description: '高度 px。' },
};

const NAV_SCHEMA = {
  type: 'object', description: 'Chapter navigation occupies one page of the requested total. slideIndex is the zero-based index in the final slides array.',
  properties: { style: { type: 'string', enum: ['custom','petals', 'orbit', 'steps'],description:'Prefer custom: invent the navigation metaphor from the content. Named presets are optional shortcuts.' }, title: { type: 'string' }, subtitle: { type: 'string' },
    html:{type:'string',description:'For custom: original HTML/SVG layout. Each chapter i needs a button with data-wds-target="{{target:i}}" and data-wpx-action="go-id:{{target:i}}". Tokens bind to stable page IDs.'},css:{type:'string',description:'Custom CSS scoped under .wds-nav-custom. May include original keyframes, hover, focus and reduced-motion rules.'},
    chapters: { type: 'array', minItems: 2, maxItems: 24, items: { type: 'object', properties: { title: { type: 'string' }, slideIndex: { type: 'integer' }, description: { type: 'string' }, color: { type: 'string' } }, required: ['title', 'slideIndex'], additionalProperties: false } } }, required: ['chapters'], additionalProperties: false,
};

const ANIM_PARAMS = {
  type: 'object',
  description: '动效参数：delay/duration/easing/trigger/loop/distance/stagger/direction/intensity，均可省略。',
  properties: {
    delay: { type: 'number', description: '延迟 ms，0–10000。' },
    duration: { type: 'number', description: '时长 ms，50–5000。' },
    easing: { type: 'string', enum: ['expo', 'smooth', 'inOut', 'back', 'spring', 'linear', 'steps'] },
    trigger: { type: 'string', enum: ['auto', 'click', 'after'] },
    loop: { type: 'boolean' },
    distance: { type: 'number' },
    stagger: { type: 'number' },
    direction: { type: 'string', enum: ['left', 'right', 'up', 'down'] },
    intensity: { type: 'number' },
  },
  additionalProperties: false,
};

function fn(name, description, properties, required = []) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: properties || {}, required, additionalProperties: false },
    },
  };
}

export const TOOL_DEFINITIONS = [
  fn('deck_insert_3d','Create or update an interactive Three.js structure using the built-in offline engine and OrbitControls. Use agent_parallel first for independent geometry, presentation and validation work. Pass a declarative scene or custom code; custom code requires full permission. Mouse drag rotates, wheel zooms, right-drag pans; one/two-finger gestures work on touch. Supply elementId to replace an existing component, otherwise insert on index/current page. No CDN imports.',{
    scene:{type:'object',description:'Declarative scene: {background,camera:{position:[x,y,z],target:[x,y,z],fov},autoFit,controls:{enableRotate,enableZoom,enablePan,autoRotate},lights:[{type:"ambient"|"directional"|"point"|"hemisphere"|"spot",color,intensity,position}],objects:[{id,type:"mesh"|"group"|"line"|"points"|"arrow"|"axes"|"grid",geometry:{type:"box"|"sphere"|"cylinder"|"cone"|"torus"|"torusKnot"|"plane"|"circle"|"ring"|"icosahedron"|"capsule"|"lathe"|"tube"|"polyline",args:[constructor numbers],points:[[x,y,z]]},material:{type:"standard"|"basic"|"normal"|"phong",color,roughness,metalness,opacity,wireframe},position:[x,y,z],rotation:[radians,radians,radians],scale:number|[x,y,z],children:[]}]}',additionalProperties:true},
    code:{type:'string',description:'Optional synchronous scene factory BODY, executed with built-in THREE, scene, camera, renderer, controls, root and host. Full permission required. Add geometry to root/scene; return {update(timeSeconds,deltaSeconds),dispose()} if needed. Runtime owns renderer/RAF. No import/CDN.'},
    label:{type:'string',description:'Accessible label in the user\'s language.'},elementId:ELEMENT_ID,index:INDEX_PARAM,...XYWH,
  }),
  fn('deck_get_3d_state','Read actual built-in 3D rendering status, camera and interaction state. Check errors and WebGL availability after inserting/changing a structure; combine with deck_capture_slide to inspect rendered pixels.'),
  fn('deck_capture_slide','Render the actual unsaved page to a PNG image for visual inspection. Returns the image plus element IDs, measured bounds, font sizes and overflow indicators. Use after creating or changing layouts; inspect, make targeted pixel adjustments, and capture again. Does not change content or create a version. The runtime sends the image to vision-capable models.',{
    index:INDEX_PARAM,elementId:ELEMENT_ID,scale:{type:'number',minimum:.25,maximum:1.5,description:'Image pixels per slide pixel. Default 0.75; use 1–1.5 for a detail crop.'},
    region:{type:'object',properties:{x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}},required:['x','y','w','h'],additionalProperties:false},
  }),
  fn('deck_set_navigation', 'Design a chapter navigation page without adding pages. Prefer original custom HTML/SVG/CSS chosen for the content; petals/orbit/steps are optional presets. Stable page ID links survive reordering. Inspect the result with deck_capture_slide.', { index: INDEX_PARAM, ...NAV_SCHEMA.properties }, ['chapters']),
  fn('deck_generate_image', '使用用户手动开启的生图服务生成配图并插入页面。根据构图自主选择参数，优先 GPT 图像模型。关闭时不可调用或自行开启。', {
    prompt: { type: 'string', description: '画面、构图、风格、配色和留白要求；文字与公式保留为可编辑元素。' },
    model: { type: 'string', description: '可选；仅可使用用户指定或已发现的生图模型，省略时自动选择。' },
    size: { type: 'string', enum: ['auto','1024x1024','1536x1024','1024x1536'], description: '根据插图区域选择横版、竖版或方形。' },
    quality: { type: 'string', enum: ['auto','low','medium','high'] },
    background: { type: 'string', enum: ['auto','opaque','transparent'], description: 'GPT 图像模型可用，透明背景配合 PNG 或 WebP。' },
    outputFormat: { type: 'string', enum: ['png','jpeg','webp'], description: 'GPT 图像模型可用。' },
    outputCompression: { type: 'integer', minimum: 0, maximum: 100, description: '仅 GPT 图像模型的 JPEG / WebP 可用。' },
    index: INDEX_PARAM, alt: { type: 'string' }, ...XYWH,
  }, ['prompt']),
  fn('deck_insert_math', '用 LaTeX 排版公式，保留源码。elementId 指定时更新已有公式，否则插入当前页。公式必须使用此工具或 KaTeX，不要用普通文字模拟。', {latex:{type:'string'},elementId:ELEMENT_ID,fontSize:{type:'number'},...XYWH}, ['latex']),
  fn('deck_insert_svg', 'Insert or update a complete editable SVG illustration with subject-specific geometry, meaningful internal detail, readable annotations and complete local defs. For a new detailed illustration or substantial redraw, dispatch independent SVG workers with agent_parallel first, supplying shared viewBox/bounds, anchors, palette/fonts and unique ID prefixes. Integrate complete returned source and inspect the sanitized page with deck_capture_slide when vision is available. Supply full SVG with xmlns/viewBox; no truncated paths, placeholder diagrams, scripts, foreignObject, external assets, embedded CSS, filters or SMIL. Use supported presentation attributes, local defs/markers/gradients/patterns; use deck tools for animation and LaTeX. elementId updates the existing asset; otherwise inserts on the current page. Preserve source and layer IDs for later edits.', {svg:{type:'string',description:'Complete well-formed standalone SVG source, including all semantic geometry, labels, required defs and closing root. Maximum 1,000,000 characters. Match viewBox to destination aspect ratio; use unique IDs and readable fonts.'},elementId:ELEMENT_ID,...XYWH}, ['svg']),
  fn('fonts_list', '检测本机可用字体，并按内容推荐标题/正文组合。', {text:{type:'string'},profile:{type:'string',enum:['auto','academic','business','editorial','technical','playful']}}),
  fn('type_presets', 'List the artistic type presets (script Latin faces, CJK calligraphic faces, outline/neon/gold/chrome effects, texture fills, shadows, animated fills, and hanzi stroke animation). Call this before deck_insert_type when you need ids and defaults; returns each preset id, group, label, hint, font and whether it animates or needs hanzi stroke data.',{
    group:{type:'string',enum:TYPE_GROUPS.map(g=>g.id),description:'Optional filter.'},
  }),
  fn('deck_insert_type', 'Insert or update an artistic type composition as one editable element: Latin script/calligraphic faces, CJK calligraphic faces, outline/neon/gold/chrome/emboss/3D/glitch effects, SVG texture fills, layered shadows, animated gradient/shimmer/liquid fills, per-character motion, and real hanzi stroke-order animation built from bundled 1024-grid stroke paths (no font or network needed at export). Animation replays when its page is shown. Pass preset (see type_presets) plus text and styling; elementId replaces an existing composition, otherwise it inserts on the current page. For stroke presets the stroke data is fetched and inlined automatically; unsupported characters fall back to plain text and are reported in missing. Solid gradient/shadow/texture effects are pure CSS on one element — do not build them from SVG paths.',{
    preset:{type:'string',description:'Preset id from type_presets, e.g. script-swash, blackletter, didone, condensed, xingkai, lishu, seal, stele, outline, neon, gold, chrome, extrude3d, glitch, texture-grain, texture-halftone, shadow-long, fill-flow, fill-shimmer, motion-char-pop, stroke-draw, stroke-fill, stroke-radical, stroke-explode.'},
    text:{type:'string',description:'The exact text to typeset, in the deck language.'},
    font:{type:'string',description:'Font key from '+Object.keys(TYPE_FONTS).join(', ')+', or a raw CSS family list.'},
    size:{type:'number',description:'Font size in slide px (1920x1080 canvas). Default from preset.'},
    weight:{type:'number',description:'Font weight 100–900.'},
    color:{type:'string',description:'Primary color (hex or CSS color).'},
    color2:{type:'string',description:'Secondary color: stroke, shadow, gradient or radical highlight depending on preset.'},
    letterSpacing:{type:'number',description:'Letter spacing in em.'},
    align:{type:'string',enum:['left','center','right']},
    italic:{type:'boolean'},uppercase:{type:'boolean'},
    stagger:{type:'number',description:'Per-character animation delay in seconds (motion-char-* presets).'},
    strokeWidth:{type:'number',description:'Stroke width: outline px, sticker border px, or hanzi stroke weight (1–160).'},
    duration:{type:'number',description:'One stroke draw duration in seconds (stroke-* presets).'},
    loop:{type:'boolean',description:'Loop stroke animation; false plays once.'},
    elementId:ELEMENT_ID,index:INDEX_PARAM,...XYWH,
  }, ['preset','text']),
  fn('deck_auto_fonts', '按工程文字和风格自动选择本机字体，应用到各页文本。保留公式数学字体与 SVG 内部字形。', {profile:{type:'string',enum:['auto','academic','business','editorial','technical','playful']}}),
  fn('app_list_apis', '发现网页全部业务 API（工程、导入、文件、素材、时间线、设置、搜索、导出等），返回操作 ID、方法、参数和所需权限。', { filter: { type: 'string' } }),
  fn('app_call_api', '按操作 ID 调用 app_list_apis 中的业务接口。projectId 默认当前工程；query 是 URL 参数，body 是请求体。严格遵守操作要求的权限。导出/预览返回可点击链接。', {
    operation: { type: 'string' }, projectId: { type: 'string' }, query: { type: 'object', additionalProperties: true }, body: { type: 'object', additionalProperties: true },
  }, ['operation']),
  fn('tool_result_read', '分页读取完整工具结果；工具结果较大时根据 resultId 和 nextOffset 继续读取，内容不会被丢弃。', {
    resultId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 100, maximum: 60000 },
  }, ['resultId']),
  fn('file_patch', '精确替换工程文件中的一段文字。search 必须唯一匹配，失败不会写文件。优先用此工具小步修改，避免重写整个文件。', {
    path: { type: 'string' }, search: { type: 'string' }, replacement: { type: 'string' },
  }, ['path', 'search', 'replacement']),
  /* ---------- 读取 ---------- */
  fn('deck_get_state', '读取当前工程状态：工程名/页数/当前页/幻灯片列表/当前选中元素/编辑器能力/历史条数。任何编辑前先调用。'),
  fn('deck_read_slide', '读取某一页的 HTML 结构与自定义 CSS，用于了解页面元素与 id。返回内容可能较长，按需读取。', {
    index: INDEX_PARAM,
    includeCss: { type: 'boolean', description: '是否附带 #wpx-css 自定义 CSS，默认 true。' },
  }),
  fn('deck_get_element', '读取单个元素的详细信息（标签、class、内联样式、文字、动画、位置尺寸）。', {
    elementId: ELEMENT_ID,
    includeHtml: { type: 'boolean', description: '是否同时返回元素 outerHTML，默认 false。' },
  }),
  fn('deck_get_html', '读取整份 deck 的 HTML（已序列化、不含 bridge 注入）。只在确需整体结构时使用。', {
    maxChars: { type: 'integer', description: '最多返回字符数，默认 40000，上限 120000。' },
  }),
  fn('file_read', '读取工程内文本文件（仅 index.html、assets/**、original/**）。', {
    path: { type: 'string', description: '相对工程根目录的路径，如 index.html、original/index.html。' },
    offset: { type: 'integer', description: '从第几个字符开始读取，默认 0。' },
    limit: { type: 'integer', description: '每次最多读取字符数，默认 30000，最大 120000；使用 nextOffset 继续。' },
  }, ['path']),
  fn('file_list', '列出当前工程包含的文件与大小。'),
  fn('project_info', '读取工程元信息（名称、来源、主题、页数、更新时间、文件列表、历史条数）。'),
  fn('web_search', '联网搜索网页（需在输入框下方开启「联网」）。返回标题、URL、摘要与正文片段；引用时请附上 URL。', {
    query: { type: 'string', description: '搜索词，支持 site:/lang:/after:/before: 等语法（取决于搜索服务）。' },
    count: { type: 'integer', description: '返回条数，默认 5，最大 10。' },
  }, ['query']),

  /* ---------- 修改：文字 / 样式 ---------- */
  fn('deck_set_text', '修改元素文字内容。html 与 text 二选一；text 会按纯文本转义并换行。', {
    elementId: ELEMENT_ID,
    html: { type: 'string', description: '新的元素内 HTML（可含 <span> 等行内标签）。' },
    text: { type: 'string', description: '新的纯文本（自动转义，\\n 变 <br>）。' },
  }),
  fn('deck_set_style', '修改元素的内联样式。只传需要改的属性，键用 CSS kebab 命名。', {
    elementId: ELEMENT_ID,
    styles: {
      type: 'object',
      description: '例如 {"color":"var(--wpx-accent)","font-size":"48px","left":"120px"}；值传 null 表示移除该属性。',
      additionalProperties: { type: ['string', 'number', 'null'] },
    },
  }, ['styles']),
  fn('deck_set_attrs', '修改元素的 HTML 属性（如 data-wpx-anim、title、src、object-fit 等）。不能改 data-wpx-el。', {
    elementId: ELEMENT_ID,
    attrs: {
      type: 'object',
      description: '例如 {"data-wpx-anim":"fadeUp","data-wpx-anim-params":"{\\"delay\\":120}"}；值传 null 表示移除属性。',
      additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    },
  }, ['attrs']),
  fn('deck_move_element', '按位移移动元素（累加 translate）。', {
    elementId: ELEMENT_ID,
    dx: { type: 'number', description: '水平位移 px，正数向右。' },
    dy: { type: 'number', description: '垂直位移 px，正数向下。' },
  }, ['dx', 'dy']),
  fn('deck_resize_element', '调整元素尺寸（可选同时改位置）。', {
    elementId: ELEMENT_ID,
    w: { type: 'number', description: '新宽度 px。' },
    h: { type: 'number', description: '新高度 px。' },
    x: { type: 'number', description: '新 x 坐标（可选）。' },
    y: { type: 'number', description: '新 y 坐标（可选）。' },
    absolute:{type:'boolean',description:'true 时整体缩放 HTML 元素及其内部文字/SVG/图形到指定绝对像素大小；false 仅调整布局容器。'},
    keepRatio:{type:'boolean',description:'整体缩放时默认保持比例，以 w 为准；false 可独立设置宽高。'},
  }, ['w', 'h']),

  /* ---------- 修改：插入 / 删除 ---------- */
  fn('deck_insert_text', '在当前页插入文本框。', {
    html: { type: 'string', description: '文本框内容 HTML。' },
    text: { type: 'string', description: '纯文本内容（与 html 二选一，自动转义）。' },
    x: XYWH.x, y: XYWH.y,
    w: { type: 'number', description: '宽度 px，默认 800。' },
    h: { type: 'number', description: '高度 px，默认 200。' },
    styles: { type: 'object', description: '附加内联样式对象（可选）。', additionalProperties: { type: ['string', 'number'] } },
  }),
  fn('deck_insert_image', '在当前页插入图片（src 用 assets/ 相对路径或工程内地址；不要用外链）。', {
    src: { type: 'string', description: '图片地址，例如 assets/hero.jpg。' },
    x: XYWH.x, y: XYWH.y,
    w: { type: 'number', description: '宽度 px，默认 800。' },
    h: { type: 'number', description: '高度 px，默认 500。' },
    objectFit: { type: 'string', enum: ['cover', 'contain', 'fill', 'none', 'scale-down'], description: '默认 cover。' },
    alt: { type: 'string', description: '替代文本（可选）。' },
  }, ['src']),
  fn('deck_insert_shape', '在当前页插入形状（矩形/圆/椭圆/三角/线/箭头/星形）。', {
    shape: { type: 'string', description: 'rect | circle | ellipse | triangle | line | arrow | star。' },
    x: XYWH.x, y: XYWH.y,
    w: { type: 'number', description: '宽度 px，默认 320。' },
    h: { type: 'number', description: '高度 px，默认 240。' },
    fill: { type: 'string', description: '填充色（CSS 颜色或 var(--wpx-accent)）。' },
    stroke: { type: 'string', description: '描边色。' },
    strokeWidth: { type: 'number', description: '描边宽度 px。' },
    radius: { type: 'number', description: '圆角 px。' },
  }, ['shape']),
  fn('deck_insert_html', '在当前页插入自定义 HTML 块（会被包成可编辑元素）。', {
    html: { type: 'string', description: '要插入的 HTML 片段。' },
    x: XYWH.x, y: XYWH.y,
    w: { type: 'number', description: '宽度 px，默认 1200。' },
    h: { type: 'number', description: '高度 px，默认 600。' },
  }, ['html']),
  fn('deck_delete_element', '删除元素（可在历史里撤回）。', { elementId: ELEMENT_ID }),

  /* ---------- 修改：动效 / 页面 / 全局 ---------- */
  fn('deck_set_animation', '为元素设置入场/强调动效，或移除动效（anim=null）。动效名见系统提示词目录。', {
    elementId: ELEMENT_ID,
    anim: { type: ['string', 'null'], description: '动效名，如 fadeUp；传 null 移除该元素动效。' },
    params: ANIM_PARAMS,
  }),
  fn('deck_add_slide', '新增一页（可选提供整页 HTML，结构需符合 deck 格式）。', {
    afterIndex: { type: 'integer', description: '插入到该页之后（从 0 开始）；省略=当前页之后。' },
    html: { type: 'string', description: '整页 section HTML（可选）。' },
  }),
  fn('deck_compose', '一句话成片：按创作蓝图一次写入整套页面（页名 / 切换 / 背景 / 元素 / 动效），自动应用视觉方向的主题变量。生成新演示时优先用它，而不是逐页调用 deck_add_slide。', {
    direction: { type: 'string', enum: ART_DIRECTIONS.map((d) => d.id), description: '视觉方向 id（决定配色与质感）。' },
    slides: {
      type: 'array',
      description: '页面数组（1–24 页，按顺序）。每页给 name / transition / bg，内容用 html（canvas 内部原始 HTML）或 elements（结构化元素）二选一。',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '页名，如「封面」。' },
          navigation: NAV_SCHEMA,
          transition: { type: 'string', description: '切换：fade pushLeft zoom iris blinds wipeUp curtain dissolve glitch shutter mosaic bars 等。' },
          duration: { type: 'integer', description: '切换时长 ms，默认 800。' },
          bg: { type: 'string', description: '页面底色（CSS 颜色或渐变）。' },
          fx: { type: 'string', enum: ['none', 'flash', 'black', 'color', 'fly', 'sweep', 'bars'], description: '转场叠加特效（可选）。' },
          html: { type: 'string', description: 'canvas 内部原始 HTML（推荐：可写渐变、SVG、网格、任意布局，元素自带绝对定位）。与 elements 二选一。' },
          elements: {
            type: 'array',
            description: '结构化元素（与 html 二选一）。',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['text', 'shape', 'image', 'html', 'math', 'svg','three'], description: 'Element type. math/svg/three render directly on the authored page; three uses the built-in offline Three.js engine.' },
                scene:{type:'object',description:'three: declarative scene specification. Same contract as deck_insert_3d.',additionalProperties:true},
                code:{type:'string',description:'three: custom Three.js scene factory body; requires full permission.'},
                label:{type:'string',description:'three: accessible structure label.'},
                latex: { type: 'string', description: 'math 类型的 LaTeX 源码，不含分隔符。' },
                svg: { type: 'string', description: 'svg: complete detailed standalone SVG source with xmlns/viewBox, semantic layers, all local defs, precise geometry and readable annotations. Use independent SVG workers for substantial illustrations, then integrate their full outputs. No placeholders or omitted paths.' },
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                text: { type: 'string', description: 'text 类型：纯文本。' },
                html: { type: 'string', description: 'text/html 类型：富文本或任意 HTML。' },
                src: { type: 'string', description: 'image 类型：图片地址（assets/ 或 http）。' },
                fill: { type: 'string', description: 'shape 类型：填充色。' },
                radius: { type: 'number', description: '圆角 px；shape 传 999 表示胶囊/圆形。' },
                shape: { type: 'string', enum: ['rect', 'ellipse', 'line'], description: 'shape 子类型。' },
                style: { type: 'object', description: '额外 CSS（font-size / color / letter-spacing / mix-blend-mode…）。' },
                anim: {
                  type: 'object',
                  description: '入场动效：{name, delay, duration, easing, trigger}，name 取动效目录。',
                  properties: {
                    name: { type: 'string' }, delay: { type: 'number' }, duration: { type: 'number' },
                    easing: { type: 'string' }, trigger: { type: 'string' },
                  },
                  required: ['name'],
                },
                z: { type: 'number', description: '层级。' },
                opacity: { type: 'number' },
                rotate: { type: 'number', description: '旋转角度。' },
              },
              required: ['type'],
            },
          },
        },
        required: ['name'],
      },
    },
    vars: { type: 'object', description: '覆盖主题变量（可选，如 {"--wpx-accent":"#00E5FF"}）。' },
    flags: { type: 'object', description: '全局效果 {grain, vignette}。' },
    css: { type: 'string', description: '整份 deck CSS（可选，会替换 #wpx-css）。' },
    js: { type: 'string', description: '整份 deck JS（可选，会替换 #wpx-user-js）。' },
  }, ['slides']),
  fn('deck_duplicate_slide', '复制一页（含元素与动效）。', { index: INDEX_PARAM }),
  fn('deck_delete_slide', '删除一页（可在历史里撤回）。', { index: INDEX_PARAM }),
  fn('deck_move_slide', '调整页顺序。', {
    from: { type: 'integer', description: '原索引，从 0 开始。' },
    to: { type: 'integer', description: '目标索引，从 0 开始。' },
  }, ['from', 'to']),
  fn('deck_set_slide_attrs', '修改页面属性：页名、切换动效、背景色、切换时长。', {
    index: INDEX_PARAM,
    name: { type: 'string', description: '新页名（≤40 字）。' },
    transition: { type: 'string', description: '切换名，如 fade/pushLeft/zoom/iris 等。' },
    bg: { type: 'string', description: '页面背景（CSS 颜色或渐变）。' },
    duration: { type: 'number', description: '切换时长 ms，100–5000。' },
  }),
  fn('deck_set_deck_css', '覆写 deck 的自定义全局 CSS（#wpx-css 内容）。传空字符串可清空。', {
    css: { type: 'string', description: '完整 CSS 文本（会整体替换 #wpx-css）。' },
  }, ['css']),
  fn('deck_set_deck_js', '覆写 deck 的自定义 JS（#wpx-user-js 内容）。传空字符串可清空。', {
    js: { type: 'string', description: '完整 JS 文本（会整体替换 #wpx-user-js）。' },
  }, ['js']),
  fn('deck_set_custom_transition', '注册自定义页面转场（用 WAAPI/JS 实现任意网页级转场），并应用到指定页或全部页。预设切换实现不了时使用，不要降级成淡入淡出。', {
    name: { type: 'string', description: '转场名，字母开头（可含 - _），如 irisBlur。' },
    code: { type: 'string', description: '转场函数体：async function(outEl, inEl, ctx){ ... }；outEl/inEl 为 1920×1080 的 section 元素，可用任意 WAAPI。' },
    index: INDEX_PARAM,
    all: { type: 'boolean', description: '是否应用到全部页（默认 false=当前页）。' },
    duration: { type: 'number', description: '切换时长 ms，100–5000（默认 900）。' },
  }, ['name', 'code']),
  fn('deck_get_timeline','读取编辑器当前完整时间线，包括尚未保存的轨道、HTML / SVG、CSS 与关键帧。修改时间线前先调用，以保留其它轨道。'),
  fn('deck_set_timeline', '设置全局动画时间线：独立于分页、可跨页、多轨道、关键帧；可做屏闪/飞入飞出/贯穿全片的元素动效。HTML 自由度优先，不要用 PPT 的思维限制效果。', {
    timeline: {
      type: 'object',
      description: '完整时间线对象：{duration, pageDuration, followPages, pages:[{index,start,duration}], tracks:[{id,name,kind:"overlay",selector:"[data-wpx-tl=\\"unique-id\\"]",html:"<div>任意 HTML / SVG</div>",css:"可选 CSS",keyframes:[{t,props:{opacity,x,y,scale,rotate,transform,filter,clipPath}}]}]}。自定义特效通过 html/css 自动创建图层，编辑、放映和导出均保留。已有元素仅需 selector。先读取当前时间线并保留其它轨道。',
      additionalProperties: true,
    },
  }, ['timeline']),
  fn('deck_apply_slide_html', '整页替换某一页的 canvas 内 HTML（危险操作，仅在用户明确要求重做整页时使用）。', {
    index: INDEX_PARAM,
    html: { type: 'string', description: '新的 canvas 内部 HTML（元素级，不要带 <section> 外壳）。' },
  }, ['html']),
  fn('deck_set_theme', '切换主题（8 套内置主题之一）或直接设置主题变量。', {
    theme: { type: 'string', enum: ['ink', 'paper', 'bloom', 'celadon', 'midnight', 'vermilion', 'mono', 'editorial'], description: '主题 id。' },
    vars: {
      type: 'object',
      description: '主题变量对象，如 {"--wpx-accent":"#C43E1C"}；与 theme 二选一。',
      additionalProperties: { type: 'string' },
    },
  }),
  fn('deck_set_deck_flags', '开关全局效果：颗粒、暗角、点击翻页、放映左键行为。', {
    grain: { type: 'boolean', description: '是否显示颗粒。' },
    vignette: { type: 'boolean', description: '是否显示暗角。' },
    clickAdvance: { type: 'boolean', description: '放映时是否允许点击翻页（可选）。' },
    mouseMode: { type: 'string', enum: ['advance', 'anim', 'off'], description: '放映左键：advance=翻页 anim=只播动画 off=不响应（右键始终是自定义菜单）。' },
  }),
  fn('deck_set_transition_fx', '给页面切换叠加一层特效（屏闪 / 黑闪 / 色闪 / 元素飞入 / 扫光 / 横线）。它叠加在原切换之上，不替代切换；这是 HTML 自由度，不是 PPT。', {
    fx: { type: 'string', enum: ['none', 'flash', 'black', 'color', 'fly', 'sweep', 'bars'], description: '叠加特效。' },
    index: INDEX_PARAM,
    all: { type: 'boolean', description: '是否应用到全部页（默认 false=当前页）。' },
  }, ['fx']),
  fn('deck_set_element_action', '设置元素的点击交互：放映时点击元素执行行为（翻页 / 跳页 / 重播动画 / 播放时间线 / 打开链接），不触发翻页。', {
    elementId: ELEMENT_ID,
    action: {
      type: 'string',
      description: "行为：none（清除）、next、prev、replay、timeline、go:N（跳到第 N 页）、url:https://…",
    },
  }, ['action']),
  fn('deck_undo', '撤销最近一次修改（等价于历史面板的撤销）。'),
  fn('history_list', '查看最近的修改历史（含来源与是否已应用）。', {
    limit: { type: 'integer', description: '返回条数，默认 20，上限 50。' },
  }),

  fn('app_list_commands', '列出编辑器的全部命令接口（名称 / 说明 / 分组）。所有 UI 功能都有命令接口，可配合 app_run_command 调用。', {
    filter: { type: 'string', description: '可选：按名称/分组/说明过滤的关键字。' },
    limit: { type: 'integer', description: '返回条数，默认 120。' },
  }),
  fn('app_run_command', '执行任意编辑器命令（等价于用户点击对应按钮）。先用 app_list_commands 查名字与参数；越权或未知命令会返回错误。', {
    name: { type: 'string', description: '命令名，例如 view.grid、app.toggleTimeline、timeline.addOverlay。' },
    payload: { type: 'object', description: '命令参数对象（可省略）。', additionalProperties: true },
  }, ['name']),
  fn('update_plan', '更新任务计划（3–8 步），界面会显示为可勾选的清单。开始复杂任务时先列计划，完成一步就更新状态。', {
    plan: {
      type: 'array',
      description: '步骤数组，按顺序。',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这一步做什么' },
          status: { type: 'string', enum: ['pending', 'running', 'done'], description: '状态' },
        },
        required: ['title'],
      },
    },
  }, ['plan']),

  /* ---------- 文件 / 代码 ---------- */
  fn('file_write', '写入工程内文本文件（仅 index.html、assets/**、original/**）。写 index.html 后编辑器会自动重载。', {
    path: { type: 'string', description: '相对工程根目录路径。' },
    content: { type: 'string', description: '完整文件内容。' },
  }, ['path', 'content']),
];

/* ---------- 执行器公共工具 ---------- */

const FAIL = (error) => ({ ok: false, error });

const READ_PATHS = [/^index\.html$/, /^assets\/.+/, /^original\/.+/];
const WRITE_PATHS = [/^index\.html$/, /^assets\/.+/, /^original\/.+/];

function normalizePath(raw) {
  return String(raw == null ? '' : raw).replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function pathAllowed(path, list) {
  if (!path || path.includes('..') || path.endsWith('/')) return false;
  return list.some((re) => re.test(path));
}

function getProject(ctx) {
  const snap = ctx && ctx.store ? ctx.store.get() : {};
  return snap.project || null;
}

function getEditor(ctx) {
  try { return ctx.getEditor ? ctx.getEditor() : null; } catch { return null; }
}

function getBridge(ctx) {
  const editor = getEditor(ctx);
  return editor && editor.bridge ? editor.bridge : null;
}

/** 调用 bridge，把 reject / {ok:false} 转成抛错，由统一 catch 转 {ok:false,error} */
async function bridgeCall(ctx, method, params) {
  if (typeof params?.html === 'string' && ['insertElement','setText','setSlideHtml','addSlide'].includes(method)) params = { ...params, html: preparePageRichContent(params.html) };
  const bridge = getBridge(ctx);
  if (!bridge) {
    const err = new Error('编辑器尚未就绪，请等画布加载完成后再试。');
    err.code = 'NO_EDITOR';
    throw err;
  }
  if (typeof bridge.call !== 'function') {
    const err = new Error('当前编辑器版本不支持该操作（bridge.call 不可用）。');
    err.code = 'NO_BRIDGE';
    throw err;
  }
  let raw;
  try {
    raw = await bridge.call(method, params || {});
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (/尚未加载|尚未就绪|not ready|bridge 已销毁/i.test(msg)) {
      throw new Error('编辑器尚未就绪（画布加载中或正在重载），请等 1–2 秒后再试。');
    }
    if (/unknown method|not implemented|未实现|未知方法|不支持/i.test(msg)) {
      const e = new Error('当前编辑器版本不支持该操作（' + method + '）。');
      e.code = 'UNSUPPORTED';
      throw e;
    }
    throw err;
  }
  // 兼容 {ok:true,result} / {ok:false,error} 包装
  if (raw && typeof raw === 'object' && raw.ok === false) {
    const msg = typeof raw.error === 'string'
      ? raw.error
      : (raw.error && (raw.error.message || raw.error.code)) || '编辑器返回失败';
    throw new Error(msg);
  }
  if (raw && typeof raw === 'object' && raw.ok === true && 'result' in raw) return raw.result;
  return raw;
}

async function tryBridge(ctx, method, params) {
  try {
    return { ok: true, value: await bridgeCall(ctx, method, params) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/* ---------- 兼容模式（raw 原稿直编）能力拦截 ---------- */

export const RAW_MODE_ERROR = '这个操作依赖固定的幻灯片结构，而当前工程是网页原稿（页面结构由网页自己的 HTML/JS 决定）。可以改文字 / 样式 / 动效 / 时间线 / 点击交互，或用 file_write / deck_set_deck_js 直接改网页代码。';

/** 工具 → 依赖的 capability（任一为 false 即视为不可用） */
const CAPABILITY_TOOL_MAP = {
  deck_set_animation: ['animations'],
  deck_set_custom_transition: ['animations', 'transitions'],
  deck_add_slide: ['structure'],
  deck_set_navigation: ['structure', 'transitions'],
  deck_duplicate_slide: ['structure'],
  deck_delete_slide: ['structure'],
  deck_move_slide: ['structure'],
  deck_apply_slide_html: ['structure'],
  deck_set_slide_attrs: ['structure', 'transitions'],
  deck_set_theme: ['themes'],
};

export const RAW_MODE_TOOLS = Object.keys(CAPABILITY_TOOL_MAP);

/** capabilities 是否代表兼容模式（raw 原稿直编） */
export function isRawCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return false;
  return capabilities.animations === false
    || capabilities.structure === false
    || capabilities.transitions === false
    || capabilities.themes === false;
}

/** 按 capability 返回被禁用的工具集合 */
export function getBlockedToolsByCapabilities(capabilities) {
  const blocked = new Set();
  if (!capabilities || typeof capabilities !== 'object') return blocked;
  for (const [tool, caps] of Object.entries(CAPABILITY_TOOL_MAP)) {
    if (caps.some((cap) => capabilities[cap] === false)) blocked.add(tool);
  }
  return blocked;
}

/** 可选：按 capability 过滤工具 schema（raw 模式下隐藏不可用工具） */
export function filterToolDefinitionsByCapabilities(definitions, capabilities) {
  const blocked = getBlockedToolsByCapabilities(capabilities);
  if (!blocked.size) return definitions;
  return definitions.filter((d) => !blocked.has(d.function.name));
}

let capabilityCache = { at: 0, value: null };

/**
 * 解析当前 deck 的 capabilities / 是否兼容模式。
 * 优先 store.deck（editor 会写入），退化到 editor 对象或 bridge.getState（3s 缓存）。
 */
export async function resolveDeckCapabilities(ctx) {
  const snap = ctx && ctx.store ? ctx.store.get() : {};
  const deck = snap.deck || {};
  const project = snap.project || {};
  const deckRaw = deck.raw === true || deck.mode === 'raw' || project.kind === 'raw';
  if (deck.capabilities && typeof deck.capabilities === 'object') {
    return { capabilities: deck.capabilities, raw: deckRaw || isRawCapabilities(deck.capabilities) };
  }
  if (deckRaw) return { capabilities: deck.capabilities || null, raw: true };
  if (Date.now() - capabilityCache.at < 3000 && capabilityCache.value) return capabilityCache.value;
  const editor = getEditor(ctx);
  if (!editor) return { capabilities: null, raw: false };
  const candidates = [editor.capabilities, editor.state && editor.state.capabilities];
  for (const caps of candidates) {
    if (caps && typeof caps === 'object') {
      const value = { capabilities: caps, raw: isRawCapabilities(caps) };
      capabilityCache = { at: Date.now(), value };
      return value;
    }
  }
  const bridge = editor.bridge;
  if (!bridge || typeof bridge.call !== 'function') return { capabilities: null, raw: false };
  try {
    const state = await bridge.call('getState', {});
    if (state && typeof state === 'object') {
      const value = {
        capabilities: state.capabilities && typeof state.capabilities === 'object' ? state.capabilities : null,
        raw: state.raw === true || state.mode === 'raw' || isRawCapabilities(state.capabilities),
      };
      capabilityCache = { at: Date.now(), value };
      return value;
    }
  } catch { /* ignore */ }
  return { capabilities: null, raw: false };
}

/**
 * 把 bridge 返回的 op 标记为 Agent 修改并返回 opId。
 * 注意：editor 模块会监听 bridge 的 change 事件并自动 store.pushOp，
 * 因此这里优先「就地标注」已入栈的 op（label/source），只有编辑器未入栈时才补推。
 */
function tagOpInHistory(ctx, opId, label) {
  let tagged = false;
  try {
    ctx.store.update((s) => {
      const h = s.history;
      for (let i = h.ops.length - 1; i >= 0 && i >= h.ops.length - 8; i -= 1) {
        const op = h.ops[i];
        if (op && op.opId === opId) {
          op.label = 'Agent · ' + label;
          op.source = 'agent';
          tagged = true;
          break;
        }
      }
    });
  } catch (err) {
    console.warn('[agent/tools] 标注历史 op 失败', err);
  }
  if (tagged) {
    try {
      ctx.bus.emit('history:change', { ops: ctx.store.get().history.ops, cursor: ctx.store.get().history.cursor });
    } catch { /* ignore */ }
  }
  return tagged;
}

function commitOp(ctx, result, label) {
  const op = result && result.op;
  if (!op || typeof op !== 'object' || !op.type) return null;
  const opId = op.opId || null;
  if (opId && tagOpInHistory(ctx, opId, label)) return opId;
  const payload = { ...op, label: 'Agent · ' + label, source: 'agent' };
  const stored = ctx.store.pushOp(payload);
  return (stored && stored.opId) || opId;
}

/** 把某个时间点之后新增的 op 全部标记为 Agent 来源（用于命令式工具，如主题切换产生多个 op） */
function tagOpsSince(ctx, startIndex, label) {
  let count = 0;
  try {
    ctx.store.update((s) => {
      const h = s.history;
      for (let i = Math.max(0, startIndex); i < h.ops.length; i += 1) {
        const op = h.ops[i];
        if (!op) continue;
        op.label = 'Agent · ' + label;
        op.source = 'agent';
        count += 1;
      }
    });
  } catch (err) {
    console.warn('[agent/tools] 标注历史 op 失败', err);
  }
  if (count) {
    try {
      ctx.bus.emit('history:change', { ops: ctx.store.get().history.ops, cursor: ctx.store.get().history.cursor });
    } catch { /* ignore */ }
  }
  return count;
}

function resolveElementId(ctx, params, required = true) {
  let id = params && (params.elementId != null ? params.elementId : params.id);
  if (id == null || id === '') {
    const sel = ctx.store.get().selection;
    id = sel && sel.elementId;
  }
  if ((id == null || id === '') && required) return null;
  return id == null ? null : String(id);
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v, fallback = null) {
  const n = toNum(v);
  return n === null ? fallback : Math.round(n);
}

/** 安全读取编辑器状态（不可用时返回 null 而不是抛错） */
async function safeState(ctx) {
  const res = await tryBridge(ctx, 'getState', {});
  return res.ok ? res.value : null;
}

function getFxGroups() {
  const win = typeof window !== 'undefined' ? window : null;
  if (win && Array.isArray(win.WPX_FX_CATALOG) && win.WPX_FX_CATALOG.length) {
    return win.WPX_FX_CATALOG.map((cat) => ({
      id: cat.id,
      label: cat.label || cat.id,
      names: (cat.items || []).map((it) => (it && it.name ? it.name : '')).filter(Boolean),
    }));
  }
  if (win && win.WPX_FX && typeof win.WPX_FX === 'object') {
    return [{ id: 'all', label: '全部', names: Object.keys(win.WPX_FX) }];
  }
  return [
    { id: 'text', label: '文字', names: ['fadeIn', 'fadeUp', 'fadeDown', 'slideInLeft', 'slideInRight', 'zoomIn', 'blurIn', 'clipUp', 'clipWipe', 'charDrop', 'charStagger', 'typewriter', 'trackingIn', 'strokeFill', 'lineMask', 'blockReveal'] },
    { id: 'shape', label: '形状', names: ['shapeSpring', 'shapeRotate', 'shapeWipe', 'shapeFlip', 'shapeBounce'] },
    { id: 'loop', label: '循环', names: ['pulse', 'breathe', 'shake', 'swing', 'floatY', 'marqueeX', 'hueFlow', 'glowPulse'] },
    { id: 'emphasis', label: '强调', names: ['underlineGrow', 'sweepLight', 'glitch', 'colorPop'] },
    { id: 'exit', label: '退场', names: ['fadeOut', 'flyOut', 'zoomOut'] },
  ];
}

const VALID_TRANSITIONS = ['fade', 'pushLeft', 'pushUp', 'pushRight', 'pushDown', 'zoom', 'zoomOut', 'flipX', 'flipY', 'iris', 'blinds', 'split', 'wipeUp', 'wipeDown', 'curtain', 'dissolve', 'glitch', 'slide', 'shutter', 'mosaic', 'clock', 'fold', 'push', 'bars', 'flash'];
const VALID_EASING = ['expo', 'smooth', 'inOut', 'back', 'spring', 'linear', 'steps'];
const VALID_TRIGGER = ['auto', 'click', 'after'];

function normalizeAnimParams(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const num = (key, min, max) => {
    const n = toNum(raw[key]);
    if (n !== null) out[key] = clamp(n, min, max);
  };
  num('delay', 0, 10000);
  num('duration', 50, 5000);
  num('distance', -2000, 2000);
  num('stagger', 0, 2000);
  num('intensity', 0, 2);
  if (typeof raw.loop === 'boolean') out.loop = raw.loop;
  if (typeof raw.easing === 'string' && VALID_EASING.includes(raw.easing)) out.easing = raw.easing;
  if (typeof raw.trigger === 'string' && VALID_TRIGGER.includes(raw.trigger)) out.trigger = raw.trigger;
  if (typeof raw.direction === 'string' && ['left', 'right', 'up', 'down'].includes(raw.direction)) out.direction = raw.direction;
  return Object.keys(out).length ? out : null;
}

function normalizeFlag(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['on', 'true', '1', 'yes', '是'].includes(s)) return true;
    if (['off', 'false', '0', 'no', '否'].includes(s)) return false;
  }
  return undefined;
}

function parseElementHtml(html, elementId) {
  if (!html || typeof html !== 'string') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const el = doc.body.firstElementChild;
  if (!el) return null;
  const attrs = {};
  for (const a of [...el.attributes]) attrs[a.name] = a.value;
  const styles = {};
  if (attrs.style) {
    for (const part of attrs.style.split(';')) {
      const i = part.indexOf(':');
      if (i > 0) styles[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  return {
    elementId: attrs['data-wpx-el'] || elementId,
    tag: el.tagName.toLowerCase(),
    className: el.className || '',
    text: truncate(el.textContent || '', 2000),
    attrs,
    styles,
    animation: attrs['data-wpx-anim'] ? { name: attrs['data-wpx-anim'], params: safeJson(attrs['data-wpx-anim-params']) } : null,
  };
}

function safeJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

/* ---------- 执行器 ---------- */

async function execGetState(ctx) {
  const snap = ctx.store.get();
  const project = snap.project;
  const state = await safeState(ctx);
  const deck = state || snap.deck || {};
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const history = snap.history || { ops: [], cursor: 0 };
  const editor = getEditor(ctx);
  return {
    ok: true,
    editorReady: !!(editor && editor.bridge),
    project: project ? {
      id: project.id, name: project.name, kind: project.kind,
      theme: project.theme, slideCount: project.slideCount,
    } : null,
    deck: {
      current: Number.isInteger(deck.current) ? deck.current : snap.deck.current,
      total: deck.total != null ? deck.total : slides.length,
      w: deck.w || 1920,
      h: deck.h || 1080,
      slides,
    },
    selection: snap.selection ? {
      elementId: snap.selection.elementId,
      type: snap.selection.type,
      text: truncate(snap.selection.text || '', 300),
      rect: snap.selection.rect,
      styles: snap.selection.styles,
      animation: snap.selection.animation || null,
    } : null,
    capabilities: (state && state.capabilities) || null,
    history: { total: history.ops.length, cursor: history.cursor, canUndo: history.cursor > 0 },
  };
}

async function execReadSlide(ctx, params) {
  const state = await safeState(ctx);
  const total = state && Array.isArray(state.slides) ? state.slides.length : (ctx.store.get().deck.total || 0);
  let index = toInt(params.index, null);
  if (index === null) index = state ? state.current : (ctx.store.get().deck.current || 0);
  index = clamp(index, 0, Math.max(0, total - 1));
  const res = await bridgeCall(ctx, 'getSlideHtml', { index });
  const html = res && typeof res === 'object' ? res.html : res;
  const pageCss = res && typeof res === 'object' ? res.css || '' : '';
  let deckCss = '';
  // bridge 的 getSlideHtml 已经返回全部 <style>，无需再单独拉取；仅在为空时兜底
  if (params.includeCss !== false && !pageCss) {
    const deckCssRes = await tryBridge(ctx, 'getDeckCss', {});
    deckCss = deckCssRes.ok ? deckCssRes.value.css || '' : '';
  }
  const slide = state && state.slides ? state.slides[index] : null;
  return {
    ok: true,
    index,
    slide: slide ? { id: slide.id, name: slide.name, transition: slide.transition } : null,
    html: String(html || ''),
    css: String(pageCss || deckCss || ''),
    note: 'html 为页面 canvas 结构；修改元素请用 deck_* 工具并确保传入 elementId。',
  };
}

async function execGetElement(ctx, params) {
  const id = resolveElementId(ctx, params, true);
  if (!id) return FAIL('请先选中元素，或传入 elementId。');
  const sel = ctx.store.get().selection;
  let element = null;
  if (sel && sel.elementId === id) {
    element = {
      elementId: sel.elementId,
      type: sel.type,
      tag: sel.tag,
      text: truncate(sel.text || '', 2000),
      rect: sel.rect,
      translate: sel.translate,
      rotate: sel.rotate,
      opacity: sel.opacity,
      zIndex: sel.zIndex,
      styles: sel.styles,
      animation: sel.animation || null,
      canEditText: sel.canEditText,
    };
  }
  const htmlRes = await tryBridge(ctx, 'getElementHtml', { elementId: id });
  const html = htmlRes.ok ? htmlRes.value && (htmlRes.value.html != null ? htmlRes.value.html : htmlRes.value) : '';
  if (!element) {
    const parsed = parseElementHtml(typeof html === 'string' ? html : '', id);
    if (!parsed) {
      return FAIL('找不到元素 ' + id + '，请先用 deck_read_slide 查看当前页元素。');
    }
    element = { ...parsed, type: parsed.className.includes('wpx-image') ? 'image' : parsed.className.includes('wpx-shape') ? 'shape' : 'text' };
  }
  const out = { ok: true, element };
  if (params.includeHtml) out.html = typeof html === 'string' ? html : '';
  return out;
}

async function execGetHtml(ctx, params) {
  const max = clamp(toInt(params.maxChars, 40000) || 40000, 2000, 120000);
  const res = await bridgeCall(ctx, 'serialize', {});
  const html = (res && typeof res === 'object' ? res.html : res) || '';
  const text = String(html);
  return {
    ok: true,
    html: text.slice(0, max),
    length: text.length,
    truncated: text.length > max,
  };
}

async function execFileRead(ctx, params) {
  const project = getProject(ctx);
  if (!project) return FAIL('没有打开工程。');
  const path = normalizePath(params.path);
  if (!path) return FAIL('需要 path 参数。');
  if (!pathAllowed(path, READ_PATHS)) return FAIL('只能读取工程内的 index.html、assets/**、original/**。');
  try {
    const file = await ctx.api.getFile(project.id, path);
    const content = String(file && file.content != null ? file.content : '');
    const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
    const max = Math.min(120000, Math.max(100, Math.floor(Number(params.limit) || 30000)));
    const end = Math.min(content.length, offset + max);
    return {
      ok: true,
      path,
      size: file && file.size != null ? file.size : content.length,
      mtime: file && file.mtime,
      offset, totalChars: content.length, nextOffset: end < content.length ? end : null,
      content: content.slice(offset, end),
    };
  } catch (err) {
    return FAIL('读取失败：' + (err && err.message ? err.message : String(err)));
  }
}

async function execFileList(ctx) {
  const project = getProject(ctx);
  if (!project) return FAIL('没有打开工程。');
  let files = [];
  try {
    const data = await ctx.api.getProject(project.id);
    const raw = data && data.files;
    if (Array.isArray(raw)) files = raw;
    else if (raw && typeof raw === 'object') files = Object.keys(raw).map((k) => ({ path: k }));
  } catch { /* ignore */ }
  const list = files.map((f) => {
    const path = normalizePath(typeof f === 'string' ? f : f.path || f.name || '');
    const size = typeof f === 'object' && f ? f.size : undefined;
    return { path, size, readable: pathAllowed(path, READ_PATHS), writable: pathAllowed(path, WRITE_PATHS) };
  }).filter((f) => f.path);
  if (!list.length) {
    return { ok: true, files: [{ path: 'index.html', readable: true, writable: true }, { path: 'assets/', readable: false, writable: false }, { path: 'original/index.html', readable: true, writable: true }], note: '服务端未返回文件列表，使用默认推断。' };
  }
  return { ok: true, files: list };
}

async function execProjectInfo(ctx) {
  const snap = ctx.store.get();
  const project = snap.project;
  if (!project) return FAIL('没有打开工程。');
  const history = snap.history || { ops: [], cursor: 0 };
  const state = await safeState(ctx);
  let files = [];
  try {
    const data = await ctx.api.getProject(project.id);
    if (Array.isArray(data && data.files)) files = data.files.map((f) => normalizePath(typeof f === 'string' ? f : f.path || '')).filter(Boolean);
  } catch { /* ignore */ }
  return {
    ok: true,
    project: {
      id: project.id,
      name: project.name,
      kind: project.kind,
      theme: project.theme,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      slideCount: project.slideCount,
      hasOriginal: project.hasOriginal,
      origin: project.origin || null,
    },
    deck: {
      current: (state && state.current) ?? snap.deck.current,
      total: (state && state.total) ?? snap.deck.total,
      slides: state && state.slides ? state.slides : snap.deck.slides,
    },
    history: { total: history.ops.length, cursor: history.cursor },
    files,
  };
}

/* ---------- 联网搜索 ---------- */
async function execWebSearch(ctx, params = {}) {
  const query = String(params.query || '').trim();
  if (!query) return FAIL('缺少搜索词 query。');
  const count = Math.min(10, Math.max(1, Number(params.count) || 5));
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, count }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    return FAIL('连接搜索服务失败：' + (err?.message || err));
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) return FAIL((data && data.error && (data.error.message + (data.error.detail ? '：' + data.error.detail : ''))) || ('搜索失败 HTTP ' + res.status));
  const results = Array.isArray(data.results) ? data.results : [];
  const text = results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet || ''}${r.content && r.content !== r.snippet ? '\n' + String(r.content).slice(0, 700) : ''}`).join('\n\n');
  return {
    ok: true,
    provider: data.provider,
    query: data.query || query,
    count: results.length,
    results,
    text: text || '（没有搜索结果）',
  };
}

/* ---------- 修改类 ---------- */

async function execSetText(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要修改的元素，或传入 elementId。');
  let html = params.html;
  if (html == null && params.text != null) {
    html = escapeHtml(String(params.text)).replace(/\r?\n/g, '<br>');
  }
  if (typeof html !== 'string' || !html.trim()) return FAIL('需要提供 html 或 text 参数。');
  const res = await bridgeCall(ctx, 'setText', { elementId: id, html });
  const opId = commitOp(ctx, res, '修改文字');
  return { ok: true, elementId: id, opId, summary: `已修改元素 ${id} 的文字` };
}

async function execSetStyle(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要修改的元素，或传入 elementId。');
  const raw = params.styles && typeof params.styles === 'object' && !Array.isArray(params.styles) ? params.styles : null;
  if (!raw) return FAIL('styles 需要是 {css属性:值} 对象，例如 {"font-size":"48px"}。');
  const styles = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (!key) continue;
    styles[key] = v == null ? null : String(v);
  }
  if (!Object.keys(styles).length) return FAIL('styles 为空。');
  const res = await bridgeCall(ctx, 'setStyles', { elementId: id, styles });
  const opId = commitOp(ctx, res, '修改样式');
  return { ok: true, elementId: id, opId, changed: Object.keys(styles), summary: `已更新 ${id} 的样式（${Object.keys(styles).slice(0, 4).join('、')}${Object.keys(styles).length > 4 ? ' 等' : ''}）` };
}

async function execSetAttrs(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要修改的元素，或传入 elementId。');
  const raw = params.attrs && typeof params.attrs === 'object' && !Array.isArray(params.attrs) ? params.attrs : null;
  if (!raw) return FAIL('attrs 需要是 {属性名:值} 对象。');
  const attrs = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (!key) continue;
    if (key === 'data-wpx-el' || key === 'id') return FAIL('不能修改元素 id（data-wpx-el）。');
    if (v === null || v === false) { attrs[key] = null; continue; }
    attrs[key] = String(v);
  }
  if (!Object.keys(attrs).length) return FAIL('attrs 为空。');
  const res = await bridgeCall(ctx, 'setAttrs', { elementId: id, attrs });
  const opId = commitOp(ctx, res, '修改属性');
  return { ok: true, elementId: id, opId, changed: Object.keys(attrs), summary: `已更新 ${id} 的属性` };
}

async function execMoveElement(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要移动的元素，或传入 elementId。');
  const dx = toNum(params.dx);
  const dy = toNum(params.dy);
  if (dx === null || dy === null) return FAIL('dx / dy 需要是数字（像素）。');
  const res = await bridgeCall(ctx, 'moveElement', { elementId: id, dx: clamp(dx, -4000, 4000), dy: clamp(dy, -4000, 4000) });
  const opId = commitOp(ctx, res, '移动元素');
  return { ok: true, elementId: id, opId, summary: `已移动 ${id}（dx=${Math.round(dx)}, dy=${Math.round(dy)}）` };
}

async function execResizeElement(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要调整的元素，或传入 elementId。');
  const w = toNum(params.w);
  const h = toNum(params.h);
  if (w === null || h === null || w <= 0 || h <= 0) return FAIL('需要正的 w / h（像素）。');
  const payload = { elementId: id, w: clamp(w, 4, 3840), h: clamp(h, 4, 2160) };
  const x = toNum(params.x);
  const y = toNum(params.y);
  if (x !== null) payload.x = clamp(x, -1920, 3840);
  if (y !== null) payload.y = clamp(y, -1080, 2160);
  const res = await bridgeCall(ctx,params.absolute?'setAbsoluteSize':'resizeElement', {...payload,keepRatio:params.keepRatio});
  const opId = commitOp(ctx, res, '调整尺寸');
  return { ok: true, elementId: id, opId, summary: `已调整 ${id} 尺寸为 ${Math.round(payload.w)}×${Math.round(payload.h)}` };
}

async function execInsertText(ctx, params) {
  let html = params.html;
  if (html == null && params.text != null) html = escapeHtml(String(params.text)).replace(/\r?\n/g, '<br>');
  if (typeof html !== 'string' || !html.trim()) return FAIL('需要提供 html 或 text 参数。');
  const payload = {
    type: 'text',
    html,
    x: clamp(toNum(params.x) ?? 160, -1920, 3840),
    y: clamp(toNum(params.y) ?? 160, -1080, 2160),
    w: clamp(toNum(params.w) ?? 800, 4, 3840),
    h: clamp(toNum(params.h) ?? 200, 4, 2160),
  };
  if (params.styles && typeof params.styles === 'object' && !Array.isArray(params.styles)) payload.styles = params.styles;
  const res = await bridgeCall(ctx, 'insertElement', payload);
  const opId = commitOp(ctx, res, '插入文本框');
  return {
    ok: true,
    elementId: res && res.elementId,
    opId,
    summary: `已插入文本框${res && res.elementId ? '（' + res.elementId + '）' : ''}`,
  };
}

async function execInsertImage(ctx, params) {
  const src = typeof params.src === 'string' ? params.src.trim() : '';
  if (!src) return FAIL('需要 src（图片地址，如 assets/hero.jpg）。');
  if (/^javascript:/i.test(src)) return FAIL('不支持的图片地址。');
  const objectFit = ['cover', 'contain', 'fill', 'none', 'scale-down'].includes(params.objectFit) ? params.objectFit : 'cover';
  const payload = {
    type: 'image',
    src,
    x: clamp(toNum(params.x) ?? 160, -1920, 3840),
    y: clamp(toNum(params.y) ?? 180, -1080, 2160),
    w: clamp(toNum(params.w) ?? 800, 4, 3840),
    h: clamp(toNum(params.h) ?? 500, 4, 2160),
    objectFit,
  };
  if (params.alt) payload.alt = String(params.alt).slice(0, 200);
  const res = await bridgeCall(ctx, 'insertElement', payload);
  const opId = commitOp(ctx, res, '插入图片');
  const warn = /^https?:/i.test(src) ? '（外链图片在导出的离线 deck 中可能失效，建议先用 assets/）' : '';
  return { ok: true, elementId: res && res.elementId, opId, summary: `已插入图片${warn}` };
}

const SHAPE_ALIAS = {
  rect: 'rect', rectangle: 'rect', square: 'rect', 矩形: 'rect',
  circle: 'circle', round: 'circle', 圆: 'circle',
  ellipse: 'ellipse', oval: 'ellipse', 椭圆: 'ellipse',
  triangle: 'triangle', 三角: 'triangle', 三角形: 'triangle',
  line: 'line', 线: 'line', 直线: 'line',
  arrow: 'arrow', 箭头: 'arrow',
  star: 'star', 星形: 'star', 星: 'star',
};

async function execInsertShape(ctx, params) {
  const rawShape = String(params.shape || '').trim().toLowerCase();
  const shape = SHAPE_ALIAS[rawShape];
  if (!shape) return FAIL('不支持的形状「' + params.shape + '」，可用：rect / circle / ellipse / triangle / line / arrow / star。');
  const payload = {
    type: 'shape',
    shape,
    x: clamp(toNum(params.x) ?? 160, -1920, 3840),
    y: clamp(toNum(params.y) ?? 160, -1080, 2160),
    w: clamp(toNum(params.w) ?? 320, 4, 3840),
    h: clamp(toNum(params.h) ?? 240, 4, 2160),
  };
  if (params.fill != null) payload.fill = String(params.fill);
  if (params.stroke != null) payload.stroke = String(params.stroke);
  const strokeWidth = toNum(params.strokeWidth);
  if (strokeWidth !== null) payload.strokeWidth = clamp(strokeWidth, 0, 40);
  const radius = toNum(params.radius);
  if (radius !== null) payload.radius = clamp(radius, 0, 400);
  const res = await bridgeCall(ctx, 'insertElement', payload);
  const opId = commitOp(ctx, res, '插入形状');
  return { ok: true, elementId: res && res.elementId, opId, summary: `已插入形状「${shape}」` };
}

async function execInsertHtml(ctx, params) {
  const html = typeof params.html === 'string' ? params.html : '';
  if (!html.trim()) return FAIL('需要 html 参数。');
  if (html.length > 120000) return FAIL('HTML 片段过长（上限 120000 字符）。');
  const payload = {
    type: 'html',
    html,
    x: clamp(toNum(params.x) ?? 160, -1920, 3840),
    y: clamp(toNum(params.y) ?? 160, -1080, 2160),
    w: clamp(toNum(params.w) ?? 1200, 4, 3840),
    h: clamp(toNum(params.h) ?? 600, 4, 2160),
  };
  const res = await bridgeCall(ctx, 'insertElement', payload);
  const opId = commitOp(ctx, res, '插入 HTML');
  return { ok: true, elementId: res && res.elementId, opId, summary: '已插入自定义 HTML 块' };
}

/**
 * 艺术字：把 type-kit 生成的 HTML 落到当前页。
 * 笔画类预设先从 /api/hanzi 取路径再内联，导出文件因此不依赖字体或网络。
 */
/** 读取某页实际渲染的背景色，供配色对比判断用；读不到返回 null。 */
function pageBackground(ctx, index) {
  try {
    const doc = getEditor(ctx)?.iframe?.contentDocument;
    if (!doc) return null;
    const slides = Array.from(doc.querySelectorAll('.wpx-slide, .slide, [data-slide]'));
    const target = slides[index != null ? Number(index) : 0] || slides.find((s) => s.classList.contains('is-active')) || slides[0];
    if (!target) return null;
    const read = (node) => {
      const cs = node.ownerDocument.defaultView.getComputedStyle(node);
      const image = cs.backgroundColor;
      return image && image !== 'rgba(0, 0, 0, 0)' ? image : null;
    };
    return read(target) || (target.parentElement && read(target.parentElement)) || null;
  } catch { return null; }
}

async function execInsertType(ctx, params) {
  const preset = typePreset(params.preset);
  if (!preset) return FAIL(`未知预设 "${params.preset}"，请先调用 type_presets。`);
  const text = String(params.text || '').trim();
  if (!text) return FAIL('需要 text。');
  let strokes = {};
  let missing = [];
  if (preset.split === 'stroke') {
    try {
      strokes = await fetchStrokes(text);
      missing = Array.from(text).filter((c) => c.trim() && !strokes[c]);
    } catch (err) {
      return FAIL('笔画数据不可用：' + err.message + '。可运行 node scripts/pack-hanzi.mjs 生成后重试。');
    }
  }
  let built;
  try {
    // 深墨色预设落在深色页上会看不见：未显式指定颜色时按页面底色自动取浅色版本
    const spec = params.color ? { ...params, colorLocked: true } : adaptToBackground(
      { ...params, preset: preset.id }, pageBackground(ctx, params.index),
    );
    built = buildTypeKit({ ...spec, preset: preset.id }, { strokes });
  } catch (err) {
    return FAIL('生成艺术字失败：' + err.message);
  }
  const w = clamp(Number(params.w) || built.w, 20, 3840);
  const h = clamp(Number(params.h) || built.h, 20, 2160);
  const x = clamp(Number(params.x) || 160, -1920, 3840);
  const y = clamp(Number(params.y) || 160, -1080, 2160);
  const label = '艺术字 · ' + preset.label;
  if (params.elementId) {
    const html = built.html.replace('<div ', `<div data-wtk-spec="${escapeHtml(JSON.stringify(built.spec))}" `, 1);
    const prior = await bridgeCall(ctx, 'getElementHtml', { elementId: params.elementId }).catch(() => null);
    if (prior && !/data-wds-type/.test(prior.html || '')) return FAIL('目标不是艺术字组件；请插入新元素或选择已有艺术字。');
    const result = await bridgeCall(ctx, 'setText', { elementId: params.elementId, html });
    return { ok: true, elementId: params.elementId, preset: preset.id, opId: commitOp(ctx, result, label), summary: '已更新' + label };
  }
  if (params.index !== undefined) {
    const state = await safeState(ctx), index = Number(params.index);
    if (!Number.isInteger(index) || index < 0 || index >= (state?.slides?.length || 0)) return FAIL('艺术字目标页无效。');
    await bridgeCall(ctx, 'go', { index, opts: { instant: true } });
  }
  const html = built.html.replace('<div ', `<div data-wtk-spec="${escapeHtml(JSON.stringify(built.spec))}" `, 1);
  const result = await bridgeCall(ctx, 'insertElement', { type: 'html', html, x, y, w, h });
  return {
    ok: true, elementId: result.elementId, preset: preset.id, opId: commitOp(ctx, result, label),
    animated: Boolean(preset.css), strokeData: preset.split === 'stroke',
    missing,
    summary: '已插入' + label + (missing.length ? '；以下字符没有笔画数据，已作为普通文字显示：' + missing.join(' ') : ''),
  };
}

async function execRich(ctx, params, type) {  const math = type === 'math', source = String(math ? params.latex || '' : params.svg || '');
  const size = clamp(Number(params.fontSize) || 52, 12, 200);
  const html = math
    ? `<link rel="stylesheet" href="/app/vendor/katex/katex.min.css" data-wds-math><div data-wds-latex="${escapeHtml(source)}" style="font-size:${size}px;display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:auto">${renderFormula(source,true)}</div>`
    : `<div data-wds-svg="${escapeHtml(source)}" style="width:100%;height:100%">${sanitizeSvg(source)}</div>`;
  if (params.elementId) {
    const result = await bridgeCall(ctx, 'setText', {elementId:params.elementId,html});
    return {ok:true,elementId:params.elementId,opId:commitOp(ctx,result,math?'更新公式':'更新图解'),summary:math?'已更新 LaTeX 公式':'已更新 SVG 图解'};
  }
  const result = await bridgeCall(ctx,'insertElement',{type:'html',html,x:clamp(Number(params.x) || 160,-1920,3840),y:clamp(Number(params.y) || 160,-1080,2160),w:clamp(Number(params.w) || 1200,20,3840),h:clamp(Number(params.h) || (math?220:600),20,2160)});
  return {ok:true,elementId:result.elementId,opId:commitOp(ctx,result,math?'插入公式':'插入图解'),summary:math?'已插入 LaTeX 公式':'已插入 SVG 图解'};
}
async function execThree(ctx,params,opts={}) {
  if(!params.scene&&!params.code)return FAIL('请提供 scene 场景结构或自定义 Three.js code。');
  if(params.code&&normalizePermission(opts.permission)!=='full')return FAIL('自定义 Three.js 代码需要完全访问权限；可编辑权限可以使用声明式 scene。');
  const html=threeMarkup(params);
  if(params.elementId){
    const prior=await bridgeCall(ctx,'getElementHtml',{elementId:params.elementId});
    if(!/\bdata-wds-three(?:[\s=>])/.test(prior.html||''))return FAIL('目标不是 3D 组件；请插入新组件或选择已有 3D。');
    const result=await bridgeCall(ctx,'setText',{elementId:params.elementId,html});
    return {ok:true,elementId:params.elementId,opId:commitOp(ctx,result,'更新 3D 结构'),summary:'已更新交互式 3D 结构'};
  }
  if(params.index!==undefined){
    const state=await safeState(ctx),index=Number(params.index);
    if(!Number.isInteger(index)||index<0||index>=(state?.slides?.length||0))return FAIL('3D 组件目标页无效。');
    await bridgeCall(ctx,'go',{index,opts:{instant:true}});
  }
  const result=await bridgeCall(ctx,'insertElement',{type:'html',html,x:clamp(toNum(params.x)??160,-1920,3840),y:clamp(toNum(params.y)??160,-1080,2160),w:clamp(toNum(params.w)??1200,80,3840),h:clamp(toNum(params.h)??700,80,2160)});
  return {ok:true,elementId:result.elementId,opId:commitOp(ctx,result,'插入 3D 结构'),summary:'已插入交互式 3D 结构；编辑时点击「操控 3D」，放映时直接拖动'};
}
async function execAutoFonts(ctx,params) {
  const serialized=await bridgeCall(ctx,'serialize',{}), html=typeof serialized==='string'?serialized:serialized.html;
  const doc=new DOMParser().parseFromString(html,'text/html');
  const recommendation=recommendFonts({profile:params.profile||'auto',text:doc.body.textContent||'',fonts:availableFonts()});
  const opIds=[];
  for(const el of doc.querySelectorAll('[data-wpx-el]')) {
    if(el.closest('svg,.katex,[data-wds-latex],[data-wds-svg]')||el.querySelector('svg,.katex,[data-wds-latex]')||!el.textContent.trim())continue;
    const heading=/^H[1-3]$/i.test(el.tagName)||el.classList.contains('wpx-title')||parseFloat(el.style.fontSize)>=64;
    const family=el.matches('pre,code')?recommendation.mono:heading?recommendation.heading:recommendation.body;
    const result=await bridgeCall(ctx,'setStyles',{elementId:el.dataset.wpxEl,styles:{'font-family':recommendation.stack(family)}});
    const id=commitOp(ctx,result,'自动选择字体');if(id)opIds.push(id);
    const nested=[...el.querySelectorAll('[style]')].filter((node)=>node.style.fontFamily&&!node.closest('svg,.katex'));
    if(nested.length){for(const node of nested)node.style.fontFamily=recommendation.stack(family);const updated=await bridgeCall(ctx,'setText',{elementId:el.dataset.wpxEl,html:el.innerHTML});const innerId=commitOp(ctx,updated,'自动选择字体');if(innerId)opIds.push(innerId);}
  }
  return {ok:true,opIds,opId:opIds.at(-1),fonts:{heading:recommendation.heading,body:recommendation.body,mono:recommendation.mono},summary:recommendation.reason};
}

async function execDeleteElement(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要删除的元素，或传入 elementId。');
  const res = await bridgeCall(ctx, 'deleteElement', { elementId: id });
  const opId = commitOp(ctx, res, '删除元素');
  return { ok: true, elementId: id, opId, summary: `已删除元素 ${id}（可在历史中撤回）` };
}

async function execSetAnimation(ctx, params) {
  const id = resolveElementId(ctx, params);
  if (!id) return FAIL('请先选中要设置动效的元素，或传入 elementId。');
  let anim = params.anim;
  let name = null;
  let animParams = params.params || params.animationParams || null;
  if (anim && typeof anim === 'object') {
    name = anim.name || null;
    animParams = anim.params || animParams;
  } else if (typeof anim === 'string') {
    name = anim;
  }
  if (params.remove === true) { name = null; anim = null; }
  if (!name && params.name) name = params.name;
  if (anim === undefined && !params.name && params.remove !== true) {
    return FAIL('需要 anim（动效名，如 fadeUp）来设置动效；传 anim:null 或 remove:true 表示移除。');
  }
  const removing = name === null || name === '';
  let available = getFxGroups();
  const flat = available.flatMap((g) => g.names);
  if (!removing) {
    if (!flat.includes(name)) {
      return FAIL('未知动效「' + name + '」。可用动效：' + available.map((g) => g.label + '：' + g.names.join(' ')).join('；'));
    }
    const payload = { elementId: id, anim: { name, params: normalizeAnimParams(animParams) || {} }, name, params: normalizeAnimParams(animParams) || {} };
    const res = await bridgeCall(ctx, 'setAnimation', payload);
    const opId = commitOp(ctx, res, '设置动画');
    return { ok: true, elementId: id, opId, anim: name, summary: `已给 ${id} 设置动效 ${name}` };
  }
  const res = await bridgeCall(ctx, 'setAnimation', { elementId: id, anim: null });
  const opId = commitOp(ctx, res, '移除动画');
  return { ok: true, elementId: id, opId, summary: `已移除 ${id} 的动效` };
}

/* ---------- 整套生成（deck_compose） ---------- */

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toCssProp(key) {
  return String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function cssTextOf(style) {
  const out = [];
  for (const [k, v] of Object.entries(style || {})) {
    if (v == null || v === '') continue;
    out.push(`${toCssProp(k)}:${v}`);
  }
  return out.join(';');
}

function animAttrsOf(anim) {
  if (!anim) return '';
  if (typeof anim === 'string') return ` data-wpx-anim="${escapeAttr(anim)}"`;
  const name = anim.name || anim.anim;
  if (!name) return '';
  const params = { ...anim };
  delete params.name;
  delete params.anim;
  const json = JSON.stringify(params);
  return ` data-wpx-anim="${escapeAttr(name)}" data-wpx-anim-params='${escapeAttr(json)}'`;
}

function elementHtmlOf(item, seed, index) {
  const e = item && typeof item === 'object' ? item : {};
  const richType = ['math', 'svg','three'].includes(e.type) ? e.type : null;
  const type = richType ? 'html' : ['text', 'shape', 'image', 'html'].includes(e.type) ? e.type : 'text';
  const x = Number(e.x) || 0;
  const y = Number(e.y) || 0;
  const w = Number(e.w) || (type === 'shape' ? 400 : 600);
  const h = Number(e.h) || (richType==='three'?700:type === 'shape' ? 240 : 180);
  const style = {
    left: x + 'px',
    top: y + 'px',
    width: w + 'px',
    height: h + 'px',
    ...(e.style && typeof e.style === 'object' ? e.style : {}),
  };
  if (e.z != null) style.zIndex = e.z;
  if (e.opacity != null) style.opacity = e.opacity;
  if (e.rotate) style.transform = `rotate(${Number(e.rotate)}deg)`;

  const shape = ['rect', 'ellipse', 'line'].includes(e.shape) ? e.shape : 'rect';
  if (type === 'image') {
    if (e.fit && !style.objectFit) style.objectFit = e.fit;
    if (e.radius != null && !style.borderRadius) style.borderRadius = Number(e.radius) + 'px';
  } else if (type === 'shape') {
    if (!style.background) style.background = e.fill || 'var(--wpx-accent)';
    if (shape === 'ellipse' && !style.borderRadius) style.borderRadius = '50%';
    if (shape === 'line') { style.height = '2px'; style.borderRadius = style.borderRadius || '0'; }
    if (e.radius != null && shape !== 'ellipse') style.borderRadius = Number(e.radius) + 'px';
    if (e.stroke) {
      style.border = `${Number(e.strokeWidth) || 1}px solid ${e.stroke}`;
      if (!style.background) style.background = 'transparent';
    }
  } else if (type === 'text') {
    if (!style.fontSize) style.fontSize = '32px';
    if (!style.lineHeight) style.lineHeight = 1.55;
    if (!style.color) style.color = 'var(--wpx-fg)';
  }

  if (richType === 'math' && !style.fontSize) style.fontSize = '52px';
  const id = e.id ? escapeAttr(e.id) : `c${seed}${index}`;
  const cls = `wpx-el wpx-${type}`;
  const common = `class="${cls}" data-wpx-el="${id}" data-wpx-type="${type === 'html' ? 'html' : type}" style="${escapeAttr(cssTextOf(style))}"`;
  if (type === 'image') {
    const src = String(e.src || '').trim();
    if (!src) return '';
    return `<img ${common} src="${escapeAttr(src)}" alt=""${animAttrsOf(e.anim)} />`;
  }
  if (type === 'shape') {
    return `<div ${common}${animAttrsOf(e.anim)}></div>`;
  }
  const inner = richType === 'math' ? formulaMarkup(e.latex, true)
    : richType === 'svg' ? `<div data-wds-svg="${escapeAttr(e.svg)}" style="width:100%;height:100%">${sanitizeSvg(e.svg)}</div>`
    : richType === 'three' ? threeMarkup(e)
    : e.html != null && String(e.html).trim() ? String(e.html) : escapeHtml(e.text || '');
  return `<div ${common}${animAttrsOf(e.anim)}>${inner}</div>`;
}

function sectionHtmlOf(slide, index, dir, ids) {
  const s = slide && typeof slide === 'object' ? slide : {};
  const name = String(s.name || `第 ${index + 1} 页`);
  const transition = String(s.transition || (index === 0 ? 'fade' : 'wipeUp'));
  const bg = String(s.bg || (dir ? dir.palette.bg : '#0B0B0C'));
  const duration = Number(s.duration) || 0;
  const fx = s.fx && s.fx !== 'none' ? ` data-wpx-tr-fx="${escapeAttr(s.fx)}"` : '';
  let inner = '';
  if (typeof s.html === 'string' && s.html.trim()) {
    inner = s.html;
  } else {
    const list = Array.isArray(s.elements) ? s.elements : [];
    inner = list.map((el, i) => elementHtmlOf(el, `${index}_`, i)).filter(Boolean).join('\n');
  }
  return `<section class="wpx-slide" data-id="${ids[index]}" data-name="${escapeAttr(name)}" data-transition="${escapeAttr(transition)}"${duration ? ` data-transition-duration="${duration}"` : ''} data-bg="${escapeAttr(bg)}"${fx}><div class="wpx-canvas">${inner}</div></section>`;
}

async function execCompose(ctx, params, opts={}) {
  const slides = Array.isArray(params && params.slides) ? params.slides : [];
  if (!slides.length) return FAIL('需要 slides 数组（至少 1 页）。');
  if (slides.length > 24) return FAIL('一次最多生成 24 页；请拆成两次。');
  if(normalizePermission(opts.permission)!=='full'&&slides.some(s=>s.elements?.some(e=>e.type==='three'&&e.code)))return FAIL('自定义 Three.js 代码需要完全访问权限。');
  const { raw } = await resolveDeckCapabilities(ctx);
  if (raw) return FAIL('这是导入的网页原稿，页结构由它自己的 HTML/JS 决定，不能整套重建。要生成新演示，请先在文件库「新建」一个空白工程；或在当前工程里只改现有页内容。');

  const dir = getDirection(params.direction);
  const seed = Date.now().toString(36), ids = slides.map((_, i) => `sc${seed}_${i}`);
  // Validate and render all math/navigation before making the first mutation.
  const prepared = slides.map((slide, i) => {
    const spec = slide.navigation ? { ...slide, html: buildNavigationHTML({ ...slide.navigation,
      chapters: resolveChapters(slide.navigation.chapters || [], slides.map((s,j) => ({ ...s, id: ids[j] })), i) }, ids[i] + '-nav') } : slide;
    return preparePageRichContent(sectionHtmlOf(spec, i, dir, ids));
  });
  const vars = { ...(dir ? directionThemeVars(dir.id) : {}), ...(params.vars && typeof params.vars === 'object' ? params.vars : {}) };
  const cleanVars = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!String(k).startsWith('--wpx-') || v == null) continue;
    cleanVars[k] = String(v);
  }
  if (Object.keys(cleanVars).length) {
    await bridgeCall(ctx, 'setThemeVars', { vars: cleanVars }).catch(() => null);
  }
  if (params.flags && typeof params.flags === 'object') {
    await bridgeCall(ctx, 'setDeckFlags', params.flags).catch(() => null);
  }
  if (typeof params.css === 'string' && params.css.trim()) {
    await bridgeCall(ctx, 'setDeckCss', { css: params.css });
  }
  if (typeof params.js === 'string' && params.js.trim()) {
    await bridgeCall(ctx, 'setDeckJs', { js: params.js });
  }

  const state = await safeState(ctx);
  const original = state ? (state.slides || []).length : (ctx.store.get().deck.total || 1);
  const opIds = [];
  for (let i = 0; i < slides.length; i += 1) {
    const html = prepared[i];
    if (i === 0) {
      const res = await bridgeCall(ctx, 'setSlideHtml', { index: 0, html });
      const opId = commitOp(ctx, res, '生成页面');
      if (opId) opIds.push(opId);
    } else {
      await bridgeCall(ctx, 'addSlide', { afterIndex: i - 1 });
      const res = await bridgeCall(ctx, 'setSlideHtml', { index: i, html });
      const opId = commitOp(ctx, res, '生成页面');
      if (opId) opIds.push(opId);
    }
  }
  let total = original + slides.length - 1;
  while (total > slides.length) {
    await bridgeCall(ctx, 'deleteSlide', { index: total - 1 }).catch(() => null);
    total -= 1;
  }
  await sleep(60);
  return {
    ok: true,
    pages: slides.length,
    direction: dir ? dir.id : null,
    opIds,
    summary: `已生成 ${slides.length} 页整套演示${dir ? '（' + dir.name + '）' : ''}`,
  };
}

async function execNavigation(ctx, params) {
  const state = await safeState(ctx);
  if (!state?.slides?.length) return FAIL('请先打开一个原生演示工程');
  const index = params.index ?? state.current;
  if (!Number.isInteger(index) || !state.slides[index]) return FAIL('目录页索引无效');
  const chapters = resolveChapters(params.chapters || [], state.slides, index);
  const html = buildNavigationHTML({ ...params, chapters }, 'nav-' + state.slides[index].id);
  const result = await bridgeCall(ctx, 'setSlideHtml', { index, html });
  return { ok: true, index, chapters: chapters.length, opId: commitOp(ctx, result, '设计章节目录'), summary: `已设计 ${chapters.length} 章动画目录，可点击进入章节` };
}

async function execGenerateImage(ctx, params, opts = {}) {
  const projectId = getProject(ctx)?.id;
  if (!projectId) return FAIL('请先打开一个工程');
  const settings = await ctx.api.getSettings();
  if (!settings.imageGeneration?.enabled) return FAIL('生图未开启，请由用户在「API 设置 → 生图」中手动开启');
  const state = await safeState(ctx), index = params.index ?? state?.current ?? 0;
  if (!state?.slides?.[index]) return FAIL('图片目标页面不存在');
  const targetId = state.slides[index].id;
  const payload = Object.fromEntries(['prompt','model','size','quality','background','outputFormat','outputCompression'].filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/generate-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: opts.signal });
  const data = await response.json();
  if (!response.ok) return FAIL(data.error?.message || '生图失败');
  opts.signal?.throwIfAborted();
  if (getProject(ctx)?.id !== projectId) return FAIL('工程已切换；生成图片已保存到原工程素材，未插入其他工程');
  const latest = await safeState(ctx), targetIndex = latest.slides.findIndex((s) => s.id === targetId);
  if (targetIndex < 0) return FAIL('目标页面已删除；生成图片保留在工程素材中');
  await bridgeCall(ctx, 'go', { index: targetIndex });
  const inserted = await execInsertImage(ctx, { ...params, src: data.url });
  return { ...inserted, url: data.url, model: data.model, summary: inserted.ok ? '已生成配图并插入页面，本地素材可随工程导出' : inserted.summary };
}

async function execAddSlide(ctx, params) {
  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  let afterIndex = toInt(params.afterIndex, null);
  if (afterIndex === null) afterIndex = state ? state.current : ctx.store.get().deck.current || 0;
  afterIndex = clamp(afterIndex, -1, Math.max(-1, total - 1));
  const payload = { afterIndex };
  if (typeof params.html === 'string' && params.html.trim()) payload.html = params.html;
  const res = await bridgeCall(ctx, 'addSlide', payload);
  const opId = commitOp(ctx, res, '新增幻灯片');
  const index = res && typeof res === 'object' ? res.index : null;
  return { ok: true, index, opId, summary: index != null ? `已新增第 ${index + 1} 页` : '已新增一页' };
}

async function execDuplicateSlide(ctx, params) {
  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  if (total <= 0) return FAIL('当前没有幻灯片。');
  let index = toInt(params.index, null);
  if (index === null) index = state ? state.current : ctx.store.get().deck.current || 0;
  index = clamp(index, 0, total - 1);
  const res = await bridgeCall(ctx, 'duplicateSlide', { index });
  const opId = commitOp(ctx, res, '复制幻灯片');
  const newIndex = res && typeof res === 'object' ? res.index : null;
  return { ok: true, index: newIndex, opId, summary: `已复制第 ${index + 1} 页${newIndex != null ? '（新页为第 ' + (newIndex + 1) + ' 页）' : ''}` };
}

async function execDeleteSlide(ctx, params) {
  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  if (total <= 1) return FAIL('至少要保留一页，不能删除。');
  let index = toInt(params.index, null);
  if (index === null) index = state ? state.current : ctx.store.get().deck.current || 0;
  index = clamp(index, 0, total - 1);
  const res = await bridgeCall(ctx, 'deleteSlide', { index });
  const opId = commitOp(ctx, res, '删除幻灯片');
  return { ok: true, index, opId, summary: `已删除第 ${index + 1} 页（可在历史中撤回）` };
}

async function execMoveSlide(ctx, params) {
  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  const from = toInt(params.from, null);
  const to = toInt(params.to, null);
  if (from === null || to === null) return FAIL('需要 from / to 页索引（从 0 开始）。');
  if (from < 0 || from >= total || to < 0 || to >= total) return FAIL(`页索引超出范围（0–${total - 1}）。`);
  if (from === to) return { ok: true, summary: '页顺序未变化。' };
  const res = await bridgeCall(ctx, 'moveSlide', { from, to });
  const opId = commitOp(ctx, res, '移动幻灯片');
  return { ok: true, opId, summary: `已把第 ${from + 1} 页移动到第 ${to + 1} 页` };
}

async function execSetSlideAttrs(ctx, params) {
  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  let index = toInt(params.index, null);
  if (index === null) index = state ? state.current : ctx.store.get().deck.current || 0;
  index = clamp(index, 0, Math.max(0, total - 1));
  const attrs = {};
  if (params.name != null) {
    const name = String(params.name).trim();
    if (!name) return FAIL('页名不能为空。');
    attrs.name = truncate(name, 40);
  }
  if (params.transition != null) {
    const tr = String(params.transition).trim();
    if (!VALID_TRANSITIONS.includes(tr) && !/^custom:[A-Za-z][\w-]{0,59}$/.test(tr)) {
      return FAIL('未知切换「' + tr + '」。可用：' + VALID_TRANSITIONS.join(' ') + ' 或 custom:<name>');
    }
    attrs.transition = tr;
  }
  if (params.bg != null) attrs.bg = String(params.bg).slice(0, 200);
  const duration = toNum(params.duration);
  if (duration !== null) attrs.duration = clamp(duration, 100, 5000);
  if (!Object.keys(attrs).length) return FAIL('至少提供 name / transition / bg / duration 之一。');
  const res = await bridgeCall(ctx, 'setSlideAttrs', { index, attrs });
  const opId = commitOp(ctx, res, '修改页属性');
  return { ok: true, index, opId, summary: `已更新第 ${index + 1} 页属性（${Object.keys(attrs).join('、')}）` };
}

async function execSetDeckCss(ctx, params) {
  const css = typeof params.css === 'string' ? params.css : null;
  if (css === null) return FAIL('需要 css 字符串（传空字符串表示清空）。');
  if (css.length > 200000) return FAIL('CSS 过长（上限 200000 字符）。');
  const res = await bridgeCall(ctx, 'setDeckCss', { css });
  const opId = commitOp(ctx, res, '修改全局 CSS');
  return { ok: true, opId, length: css.length, summary: '已更新全局 CSS（#wpx-css）' };
}

async function execSetDeckJs(ctx, params) {
  const js = typeof params.js === 'string' ? params.js : null;
  if (js === null) return FAIL('需要 js 字符串（传空字符串表示清空）。');
  if (js.length > 200000) return FAIL('JS 过长（上限 200000 字符）。');
  const res = await bridgeCall(ctx, 'setDeckJs', { js });
  const opId = commitOp(ctx, res, '修改全局 JS');
  return { ok: true, opId, length: js.length, summary: '已更新全局 JS（#wpx-user-js）' };
}

async function execSetCustomTransition(ctx, params) {
  const name = String(params.name || '').trim();
  if (!/^[A-Za-z][\w-]{0,59}$/.test(name)) return FAIL('转场名需字母开头（可含 - _），≤60 字符。');
  const code = typeof params.code === 'string' ? params.code.trim() : '';
  if (!code) return FAIL('需要 code（转场函数体，如 async function(outEl,inEl,ctx){...}）。');
  if (code.length > 60000) return FAIL('转场代码过长（上限 60000 字符）。');
  if (/<\/?script/i.test(code)) return FAIL('转场代码里不要包含 <script> 标签。');
  // 读取现有自定义 JS，追加注册代码（不覆盖已有内容）
  let current = '';
  try {
    const r = await bridgeCall(ctx, 'getDeckJs', {});
    current = (r && r.js) || '';
  } catch { current = ''; }
  const snippet = `\n;(function(){try{window.__WPX__.registerTransition(${JSON.stringify(name)}, ${code});}catch(e){console.warn('[custom transition]', e);}})();\n`;
  const js = (current + snippet).slice(0, 200000);
  const jsRes = await bridgeCall(ctx, 'setDeckJs', { js });
  const opIds = [];
  const opIdJs = commitOp(ctx, jsRes, '注册自定义转场');
  if (opIdJs) opIds.push(opIdJs);

  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  const transition = 'custom:' + name;
  const duration = clamp(toNum(params.duration) ?? 900, 100, 5000);
  if (params.all) {
    for (let i = 0; i < total; i++) {
      const r = await bridgeCall(ctx, 'setSlideAttrs', { index: i, attrs: { transition, duration } });
      const id = commitOp(ctx, r, '应用自定义转场');
      if (id) opIds.push(id);
    }
  } else {
    let index = toInt(params.index, null);
    if (index === null) index = state ? state.current : ctx.store.get().deck.current || 0;
    index = clamp(index, 0, Math.max(0, total - 1));
    const r = await bridgeCall(ctx, 'setSlideAttrs', { index, attrs: { transition, duration } });
    const id = commitOp(ctx, r, '应用自定义转场');
    if (id) opIds.push(id);
  }
  return { ok: true, name, transition, opIds, summary: `已注册并应用自定义转场「${name}」` };
}

async function execSetTimeline(ctx, params) {
  const timeline = params && params.timeline;
  if (!timeline || typeof timeline !== 'object' || !Array.isArray(timeline.tracks)) {
    return FAIL('需要 timeline 对象（至少包含 tracks 数组）。');
  }
  const json = JSON.stringify(timeline);
  if (json.length > 300000) return FAIL('时间线数据过大（上限 300KB）。');
  const res = await bridgeCall(ctx, 'setTimeline', { timeline });
  const project = ctx.store.get().project;
  if (project && project.kind === 'raw') {
    const response=await fetch('/api/projects/' + encodeURIComponent(project.id) + '/timeline', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeline }),
      });
    if(!response.ok)throw new Error('时间线保存失败：HTTP '+response.status);
  }
  const opId = commitOp(ctx, res, '设置动画时间线');
  await bridgeCall(ctx, 'timelineRefresh', {}).catch(() => {});
  ctx.bus.emit('timeline:changed');
  return {
    ok: true,
    opId,
    tracks: timeline.tracks.length,
    duration: Number(timeline.duration) || 0,
    summary: `已设置时间线：${timeline.tracks.length} 条轨道 / ${((Number(timeline.duration) || 0) / 1000).toFixed(1)}s`,
  };
}

async function execApplySlideHtml(ctx, params) {
  const html = typeof params.html === 'string' ? params.html : '';
  if (!html.trim()) return FAIL('需要 html 参数（canvas 内部 HTML）。');
  if (html.length > 200000) return FAIL('HTML 过长（上限 200000 字符）。');
  const state = await safeState(ctx);
  const total = state ? (state.slides || []).length : ctx.store.get().deck.total || 0;
  let index = toInt(params.index, null);
  if (index === null) index = state ? state.current : ctx.store.get().deck.current || 0;
  index = clamp(index, 0, Math.max(0, total - 1));
  const res = await bridgeCall(ctx, 'setSlideHtml', { index, html });
  const opId = commitOp(ctx, res, '替换整页 HTML');
  return { ok: true, index, opId, summary: `已替换第 ${index + 1} 页内容（可在历史中撤回）` };
}

async function findLatestThemeOp(ctx) {
  for (let i = 0; i < 3; i += 1) {
    await sleep(45);
    const h = ctx.store.get().history;
    for (let j = h.ops.length - 1; j >= 0; j -= 1) {
      const op = h.ops[j];
      if (op && op.type === 'theme') return op.opId || null;
    }
  }
  return null;
}

async function execSetTheme(ctx, params) {
  const themeId = params.theme || params.themeId || params.id;
  const vars = params.vars || params.variables;
  if (themeId) {
    const id = String(themeId).trim();
    if (!['ink', 'paper', 'bloom', 'celadon', 'midnight', 'vermilion', 'mono', 'editorial'].includes(id)) {
      return FAIL('未知主题「' + id + '」。可用：ink paper bloom celadon midnight vermilion mono editorial。');
    }
    let cmdRes = null;
    const historyStart = ctx.store.get().history.ops.length;
    try {
      cmdRes = await ctx.bus.runCommand('design.theme', { id, themeId: id, silent: true });
    } catch (err) {
      return FAIL('应用主题失败：' + (err && err.message ? err.message : String(err)));
    }
    if (cmdRes && cmdRes.ok === false) return FAIL(cmdRes.error || '应用主题失败。');
    tagOpsSince(ctx, historyStart, '切换主题');
    const created = ctx.store.get().history.ops.slice(historyStart).map((op) => op && op.opId).filter(Boolean);
    let opId = (cmdRes && cmdRes.op && cmdRes.op.opId) || (cmdRes && cmdRes.opId) || null;
    if (!opId) opId = created.length ? created[created.length - 1] : await findLatestThemeOp(ctx);
    return { ok: true, opId, opIds: created.length ? created : undefined, theme: id, summary: `已应用主题「${id}」` };
  }
  if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
    const clean = {};
    for (const [k, v] of Object.entries(vars)) {
      const key = String(k).trim();
      if (!key.startsWith('--wpx-')) return FAIL('主题变量名需以 --wpx- 开头：' + key);
      clean[key] = String(v);
    }
    if (!Object.keys(clean).length) return FAIL('vars 为空。');
    const res = await bridgeCall(ctx, 'setThemeVars', { vars: clean });
    const opId = commitOp(ctx, res, '修改主题变量');
    return { ok: true, opId, changed: Object.keys(clean), summary: '已更新主题变量（' + Object.keys(clean).slice(0, 4).join('、') + '）' };
  }
  return FAIL('需要 theme（内置主题 id）或 vars（--wpx-* 变量对象）。');
}

async function execSetDeckFlags(ctx, params) {
  const payload = {};
  const grain = normalizeFlag(params.grain);
  const vignette = normalizeFlag(params.vignette);
  const clickAdvance = normalizeFlag(params.clickAdvance);
  if (grain !== undefined) payload.grain = grain;
  if (vignette !== undefined) payload.vignette = vignette;
  if (clickAdvance !== undefined) payload.clickAdvance = clickAdvance;
  if (!Object.keys(payload).length) return FAIL('至少提供 grain / vignette / clickAdvance 之一（布尔值）。');
  const res = await bridgeCall(ctx, 'setDeckFlags', payload);
  const opId = commitOp(ctx, res, '设置全局效果');
  const parts = Object.entries(payload).map(([k, v]) => k + '=' + (v ? 'on' : 'off'));
  return { ok: true, opId, flags: payload, summary: '已更新全局效果（' + parts.join('，') + '）' };
}

async function execSetTransitionFx(ctx, params) {
  const fx = String(params.fx || 'none');
  if (!['none', 'flash', 'black', 'color', 'fly', 'sweep', 'bars'].includes(fx)) return FAIL('未知叠加效果：' + fx);
  const { raw } = await resolveDeckCapabilities(ctx);
  if (raw) {
    const proj = ctx.store.get().project || {};
    let cfg = {};
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(proj.id) + '/deck-config');
      if (r.ok) cfg = (await r.json()).config || {};
    } catch { /* ignore */ }
    cfg.transitionFx = cfg.transitionFx || {};
    cfg.transitionFx[String(Math.max(0, Number(params.index) || 0))] = fx;
    await fetch('/api/projects/' + encodeURIComponent(proj.id) + '/deck-config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cfg }),
    }).catch(() => null);
    await bridgeCall(ctx, 'setSlideAttrs', { index: Math.max(0, Number(params.index) || 0), attrs: { transitionFx: fx } }).catch(() => null);
    return { ok: true, fx, raw: true, summary: fx === 'none' ? '已关闭转场叠加' : '已叠加「' + fx + '」（原稿切换保持不动）' };
  }
  const total = Math.max(0, (ctx.store.get().deck.total || 1) - 1);
  const indices = params.all ? Array.from({ length: total + 1 }, (_, i) => i) : [Math.min(Math.max(0, Number(params.index) || 0), total)];
  let opId = null;
  for (const i of indices) {
    const res = await bridgeCall(ctx, 'setSlideAttrs', { index: i, attrs: { transitionFx: fx } });
    if (res && res.op) opId = commitOp(ctx, res, '转场叠加') || opId;
  }
  return { ok: true, opId, fx, count: indices.length, summary: fx === 'none' ? '已关闭转场叠加' : `已叠加「${fx}」到 ${indices.length} 页` };
}

async function execSetElementAction(ctx, params) {
  const bridge = getBridge(ctx);
  if (!bridge) return FAIL('编辑器尚未就绪。');
  let id = params && params.elementId;
  if (!id) {
    const sel = ctx.store.get().selection;
    id = sel && sel.elementId;
  }
  if (!id) return FAIL('需要 elementId，或先在画布上选中一个元素。');
  const action = String(params.action || '').trim();
  if (!action) return FAIL('需要 action。');
  if (action !== 'none' && !['next', 'prev', 'replay', 'timeline'].includes(action) && !/^go:\d+$/.test(action) && !/^url:https?:\/\//.test(action)) {
    return FAIL('行为格式不对：none / next / prev / replay / timeline / go:N / url:https://…');
  }
  const res = await bridgeCall(ctx, 'setAttrs', { elementId: id, attrs: { 'data-wpx-action': action === 'none' ? null : action } });
  const opId = commitOp(ctx, res, '设置点击交互');
  return { ok: true, opId, elementId: id, action, summary: action === 'none' ? '已清除点击交互' : '已设置点击交互：' + action };
}

function commandAccess(name) {
  if(name==='favorites.open')return 'blocked';
  if (/^(agent\.|app\.(toggleAgent|back))/.test(name)) return 'blocked';
  if (/^(file\.|project\.|templates\.|app\.(settings|reloadDeck)|insert\.html|element\.editHtml|design\.(css|js))/.test(name)) return 'full';
  return 'edit';
}

async function execAppListCommands(ctx, params) {
  const all = ctx.bus.listCommands ? ctx.bus.listCommands() : [];
  const kw = String((params && params.filter) || '').trim().toLowerCase();
  const limit = Math.min(300, Math.max(1, Number(params && params.limit) || 120));
  const rows = all
    .filter((c) => !kw || (c.name + ' ' + (c.label || '') + ' ' + (c.group || '')).toLowerCase().includes(kw))
    .slice(0, limit)
    .map((c) => ({ name: c.name, label: c.label || c.name, group: c.group || '', payload: c.payload || c.parameters || {}, permission: commandAccess(c.name), note: commandAccess(c.name) === 'blocked' ? '会话控制请由用户操作；业务功能请用 app_call_api。' : '' }));
  return { ok: true, total: all.length, shown: rows.length, commands: rows, summary: `共 ${all.length} 个命令，返回 ${rows.length} 个` };
}

async function execAppRunCommand(ctx, params, opts = {}) {
  const name = String((params && params.name) || '').trim();
  if (!name) return FAIL('需要命令名 name。先用 app_list_commands 查看。');
  if (!ctx.bus.hasCommand(name)) {
    const list = ctx.bus.listCommands().map((c) => c.name).filter((n) => n.includes(name.split('.')[0]));
    return FAIL('未注册命令：' + name + (list.length ? '；相近命令：' + list.slice(0, 8).join(', ') : ''));
  }
  const access = commandAccess(name);
  if (access === 'blocked') return FAIL('会话控制不能递归调用；业务功能请使用 app_call_api。');
  if (permissionRank(opts.permission) < permissionRank(access)) return FAIL('命令需要「' + permissionLabel(access) + '」权限。');
  if(name==='favorites.save'&&!String(params.payload?.name||'').trim())return FAIL('收藏元素需要 payload.name，请提供收藏名称。');
  if(name==='favorites.insert'&&normalizePermission(opts.permission)!=='full'){
    const {element}=await ctx.api.getFavoriteElement(params.payload?.favoriteId);
    if(favoriteHasCode(element.html))return FAIL('该收藏包含自定义 Three.js 代码，需要完全访问权限；普通元素和声明式 3D 场景可在可编辑模式插入。');
  }
  const res = await ctx.bus.runCommand(name, (params && params.payload) || {});
  const ok = !(res && res.ok === false);
  return { ok, name, result: res, summary: ok ? '已执行命令 ' + name : '命令失败：' + (res && res.error || '未知错误') };
}

async function execUpdatePlan(ctx, params) {
  const plan = Array.isArray(params && params.plan) ? params.plan : [];
  if (!plan.length) return FAIL('plan 不能为空');
  const clean = plan.slice(0, 12).map((p, i) => ({
    title: String(p && p.title || ('步骤 ' + (i + 1))).slice(0, 120),
    status: ['pending', 'running', 'done'].includes(p && p.status) ? p.status : 'pending',
  }));
  try { ctx.bus.emit('agent:plan', { plan: clean }); } catch { /* ignore */ }
  const done = clean.filter((p) => p.status === 'done').length;
  return { ok: true, plan: clean, summary: `计划 ${clean.length} 步，已完成 ${done} 步` };
}

async function execUndo(ctx) {
  let busRes = null;
  try {
    busRes = await ctx.bus.runCommand('app.undo');
  } catch { /* ignore */ }
  if (busRes && busRes.ok !== false) {
    return { ok: true, summary: '已撤销最近一次修改' };
  }
  const h = ctx.store.get().history;
  const op = h.ops[h.cursor - 1];
  if (!op) return FAIL('没有可撤销的修改。');
  const bridge = getBridge(ctx);
  if (!bridge) return FAIL('编辑器尚未就绪，无法撤销。');
  await bridgeCall(ctx, 'applyOp', { op, direction: 'undo' });
  ctx.store.undoOp();
  return { ok: true, opId: op.opId, summary: '已撤销：' + (op.label || op.type) };
}

function opBrief(op) {
  if (!op) return '';
  const meta = getToolMeta(op.type);
  const label = op.label || meta.label || op.type;
  const el = op.elementId ? ' ' + op.elementId : '';
  return label + el;
}

async function execHistoryList(ctx, params) {
  const limit = clamp(toInt(params.limit, 20) || 20, 1, 50);
  const h = ctx.store.get().history;
  const total = h.ops.length;
  const start = Math.max(0, total - limit);
  const ops = h.ops.slice(start).map((op, i) => ({
    index: start + i,
    opId: op.opId,
    type: op.type,
    label: op.label || '',
    source: op.source || 'ui',
    elementId: op.elementId || null,
    slideIndex: Number.isInteger(op.slideIndex) ? op.slideIndex : undefined,
    applied: start + i < h.cursor,
    summary: opBrief(op),
    ts: op.ts,
  }));
  return {
    ok: true,
    total,
    cursor: h.cursor,
    canUndo: h.cursor > 0,
    canRedo: h.cursor < total,
    ops,
  };
}

async function execFileWrite(ctx, params) {
  const project = getProject(ctx);
  if (!project) return FAIL('没有打开工程。');
  const path = normalizePath(params.path);
  if (!path) return FAIL('需要 path 参数。');
  if (!pathAllowed(path, WRITE_PATHS)) return FAIL('只能写入工程内的 index.html、assets/**、original/**（不允许路径穿越）。');
  const content = typeof params.content === 'string' ? params.content : (params.content == null ? null : String(params.content));
  if (content === null) return FAIL('需要 content 字符串。');
  if (content.length > 4 * 1024 * 1024) return FAIL('文件内容过大（上限 4MB）。');

  // 写 index.html 前先让编辑器把自己未保存的修改落盘，避免随后 reload 覆盖本次写入
  const editor = getEditor(ctx);
  if (path === 'index.html' && editor && typeof editor.saveNow === 'function') {
    try {
      const saved = await editor.saveNow({ reason: 'agent-file-write' });
      if (saved && saved.ok === false) {
        return FAIL('编辑器现有修改保存失败，已取消写入以免覆盖；请先手动保存或稍后重试。');
      }
    } catch (err) {
      return FAIL('编辑器现有修改保存失败，已取消写入：' + (err && err.message ? err.message : String(err)));
    }
  }

  try {
    await ctx.api.putFile(project.id, path, content);
  } catch (err) {
    return FAIL('写入失败：' + (err && err.message ? err.message : String(err)));
  }
  let reloaded = false;
  let note = '';
  if (path === 'index.html') {
    try {
      // 优先走编辑器的 reloadDeck 命令（会重建 bridge、刷新缩略图与状态）
      const busRes = await ctx.bus.runCommand('app.reloadDeck');
      if (busRes && busRes.ok !== false) {
        reloaded = true;
      } else if (editor && editor.bridge) {
        await bridgeCall(ctx, 'reload', {});
        reloaded = true;
      } else {
        note = '编辑器未就绪，下次加载时会使用新文件。';
      }
    } catch (err) {
      note = '已写入，但重载编辑器失败：' + (err && err.message ? err.message : String(err));
    }
    // 让编辑器状态刷新（历史/保存状态由 editor 模块处理）
    try { ctx.bus.emit('project:saved', { project }); } catch { /* ignore */ }
  }
  return {
    ok: true,
    path,
    size: content.length,
    reloaded,
    summary: `已写入 ${path}${reloaded ? '，编辑器已重载' : ''}${note ? '（' + note + '）' : ''}`,
  };
}

/* ---------- 执行器注册表 ---------- */

async function execListApis(ctx, params) {
  const filter = String(params.filter || '').toLowerCase();
  return { ok: true, operations: API_CATALOG.filter((op) => !filter || (op.id + op.description).toLowerCase().includes(filter)) };
}
async function execCallApi(ctx, params, opts) {
  const op = API_CATALOG.find((o) => o.id === params.operation);
  if (!op) return FAIL('未知接口，请先用 app_list_apis 查找 operation。');
  if (permissionRank(opts.permission) < permissionRank(op.permission)) return FAIL('接口需要「' + permissionLabel(op.permission) + '」权限。');
  if (op.id === 'search.web' && !opts.webSearch) return FAIL('请先开启联网。');
  const current = ctx.store.get().project?.id;
  const projectId = params.projectId || current;
  const body = params.body || {};
  if(projectId===current&&op.id==='timeline.read')return {ok:true,...await bridgeCall(ctx,'getTimeline',{})};
  if(projectId===current&&op.id==='timeline.write')return execSetTimeline(ctx,body);
  if (op.id === 'settings.write' && Object.hasOwn(body, 'imageGeneration')) return FAIL('生图只能由用户在「API 设置 → 生图」中手动开启或修改。');
  if (op.id === 'files.write' && projectId === current) return execFileWrite(ctx, body);
  if (op.id === 'files.write' || op.id === 'files.read') {
    const filePath = normalizePath(body.path || params.query?.path || 'index.html');
    if (!pathAllowed(filePath, op.id === 'files.write' ? WRITE_PATHS : READ_PATHS)) return FAIL('文件路径不在可访问的工程文件范围内。');
  }
  const url = apiURL(op, projectId, params.query);
  if (['export.html','preview.thumbnail','templates.export','versions.preview','versions.present','versions.export'].includes(op.id)) {
    if (projectId === current) await ctx.getEditor?.()?.saveNow?.({ reason: 'agent-export' });
    return { ok: true, url, summary: op.id.endsWith('export')||op.id==='export.html' ? '导出链接已生成' : op.id.endsWith('present')?'放映链接已生成':'预览链接已生成' };
  }
  const mutatesCurrent = op.method !== 'GET' && projectId && projectId === current;
  if (mutatesCurrent) {
    const saved = await ctx.getEditor?.()?.saveNow?.({ reason: 'agent-api' });
    if (saved?.ok === false) return FAIL('当前工程保存失败，请先保存后重试。');
  }
  const request = async () => {
    const res = await fetch(url, { method: op.method, signal: opts.signal,
      headers: op.method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      ...(op.method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `接口返回 ${res.status}`);
    return data;
  };
  const editor = ctx.getEditor?.();
  const data = op.id === 'versions.restore' && projectId === current && editor?.restoreVersion ? await editor.restoreVersion(request) : await request();
  if (op.id === 'projects.delete' && projectId === current) ctx.agentDeletedProjectId = projectId;
  if (op.id === 'settings.write') ctx.store.update((s) => { s.settings = { ...s.settings, ...data, loaded: true }; });
  if (op.id === 'projects.update' && projectId === current && data.project) {
    ctx.store.update((s) => { s.project = data.project; }); ctx.bus.emit('project:renamed', data.project);
  }
  if (op.id === 'versions.restore' && projectId === current && data.project) ctx.store.update((s) => { s.project = data.project; });
  if (op.id === 'history.write' && projectId === current) {
    ctx.store.setHistory?.(Array.isArray(body.ops) ? body.ops : []);
    ctx.bus.emit('history:change', ctx.store.get().history);
  }
  if (mutatesCurrent && /^(patches|config|timeline)\.write$|^projects\.upgrade$/.test(op.id)) await ctx.bus.runCommand('app.reloadDeck');
  ctx.bus.emit('library:refresh');
  return { ok: true, operation: op.id, ...data,
    ...(data.project?.id ? { url: '#/p/' + encodeURIComponent(data.project.id) } : {}),
  };
}
async function execResultRead(ctx, params) {
  const content = ctx.agentToolResults?.get(params.resultId);
  if (content == null) return FAIL('找不到结果 ID，可重新调用原读取工具。');
  const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
  const limit = Math.min(60000, Math.max(100, Math.floor(Number(params.limit) || 12000)));
  const end = Math.min(content.length, offset + limit);
  return { ok: true, resultId: params.resultId, offset, totalChars: content.length, nextOffset: end < content.length ? end : null, content: content.slice(offset, end) };
}
async function execFilePatch(ctx, params) {
  const project = getProject(ctx), path = normalizePath(params.path);
  if (!project || !pathAllowed(path, WRITE_PATHS)) return FAIL('需要有效的工程内文件路径。');
  if (typeof params.search !== 'string' || !params.search || typeof params.replacement !== 'string') return FAIL('需要非空 search 和字符串 replacement。');
  const saved = await getEditor(ctx)?.saveNow?.({ reason: 'agent-patch' });
  if (saved?.ok === false) return FAIL('保存当前工程失败。');
  const file = await ctx.api.getFile(project.id, path);
  const content = String(file.content || '');
  const index = content.indexOf(params.search);
  if (index < 0 || content.indexOf(params.search, index + 1) >= 0) return FAIL('search 必须唯一匹配；请先读取文件并扩大匹配范围。');
  return execFileWrite(ctx, { path, content: content.slice(0, index) + params.replacement + content.slice(index + params.search.length) });
}

const EXECUTORS = {
  deck_insert_3d:execThree,
  deck_get_3d_state:async(ctx)=>{
    const editor=getEditor(ctx);
    let runtime=editor?.iframe?.contentWindow?.__WDS_THREE__;
    if(!runtime&&editor?.bridge?.ready){await editor.bridge.call('ensureThree',{});runtime=editor.iframe?.contentWindow?.__WDS_THREE__;}
    if(!runtime)return FAIL('3D 运行时尚未就绪，请重新加载画布或重启 BAT 服务。');
    await runtime.refresh?.();return {ok:true,...runtime.getState()};
  },
  deck_capture_slide:async(ctx,params,opts)=>(await import('./visual-inspection.js')).captureSlide(ctx,params,opts),
  deck_set_navigation: execNavigation,
  deck_generate_image: execGenerateImage,
  deck_insert_math: (ctx,p)=>execRich(ctx,p,'math'),
  deck_insert_svg: (ctx,p)=>execRich(ctx,p,'svg'),
  deck_auto_fonts: execAutoFonts,
  deck_insert_type: execInsertType,
  type_presets: async (_ctx, p = {}) => {
    const list = TYPE_PRESETS
      .filter((preset) => !p.group || preset.group === p.group)
      .map((preset) => ({
        id: preset.id, group: preset.group, label: preset.label, hint: preset.hint,
        font: preset.font, fontStack: TYPE_FONTS[preset.font]?.stack,
        split: preset.split || 'none', animates: Boolean(preset.css), defaults: preset.defaults || {},
      }));
    return { ok: true, groups: TYPE_GROUPS, fonts: Object.fromEntries(Object.entries(TYPE_FONTS).map(([k, v]) => [k, v.label])), presets: list };
  },
  fonts_list: async(_ctx,p)=>{const fonts=availableFonts(),r=recommendFonts({...p,fonts});return {ok:true,fonts,recommendation:{heading:r.heading,body:r.body,mono:r.mono,reason:r.reason}};},
  app_list_apis: execListApis,
  app_call_api: execCallApi,
  tool_result_read: execResultRead,
  file_patch: execFilePatch,
  deck_get_state: execGetState,
  deck_read_slide: execReadSlide,
  deck_get_element: execGetElement,
  deck_get_html: execGetHtml,
  file_read: execFileRead,
  file_list: execFileList,
  project_info: execProjectInfo,
  web_search: execWebSearch,
  deck_set_text: execSetText,
  deck_set_style: execSetStyle,
  deck_set_attrs: execSetAttrs,
  deck_move_element: execMoveElement,
  deck_resize_element: execResizeElement,
  deck_insert_text: execInsertText,
  deck_insert_image: execInsertImage,
  deck_insert_shape: execInsertShape,
  deck_insert_html: execInsertHtml,
  deck_delete_element: execDeleteElement,
  deck_set_animation: execSetAnimation,
  deck_add_slide: execAddSlide,
  deck_compose: execCompose,
  deck_duplicate_slide: execDuplicateSlide,
  deck_delete_slide: execDeleteSlide,
  deck_move_slide: execMoveSlide,
  deck_set_slide_attrs: execSetSlideAttrs,
  deck_set_deck_css: execSetDeckCss,
  deck_set_deck_js: execSetDeckJs,
  deck_set_custom_transition: execSetCustomTransition,
  deck_set_timeline: execSetTimeline,
  deck_get_timeline: async(ctx)=>({ok:true,...await bridgeCall(ctx,'getTimeline',{})}),
  deck_apply_slide_html: execApplySlideHtml,
  deck_set_theme: execSetTheme,
  deck_set_deck_flags: execSetDeckFlags,
  deck_set_transition_fx: execSetTransitionFx,
  deck_set_element_action: execSetElementAction,
  app_list_commands: execAppListCommands,
  app_run_command: execAppRunCommand,
  update_plan: execUpdatePlan,
  deck_undo: execUndo,
  history_list: execHistoryList,
  file_write: execFileWrite,
};

/**
 * 创建工具执行器。
 * @param {object} ctx
 * @returns {{execute:(name:string,args:object,opts?:{permission?:string})=>Promise<object>, has:(name:string)=>boolean}}
 */
export function createToolExecutor(ctx) {
  return {
    has: (name) => Object.prototype.hasOwnProperty.call(EXECUTORS, name),
    async execute(name, args, opts = {}) {
      const run = EXECUTORS[name];
      if (!run) return FAIL('未知工具：' + name);
      if (opts && opts.permission && !canUseTool(opts.permission, name)) {
        const need = permissionLabel(getToolAccess(name));
        return FAIL(`当前工作权限为「${permissionLabel(opts.permission)}」，该操作需要「${need}」及以上。请让用户在输入框下方切换工作权限后重试。`);
      }
      // 兼容模式（raw 原稿直编）能力拦截：动画 / 切换 / 页结构 / 主题工具
      const needsCapabilityCheck = RAW_MODE_TOOLS.includes(name) || (opts && opts.raw === true);
      if (needsCapabilityCheck) {
        let raw = !!(opts && opts.raw === true);
        let capabilities = opts && opts.capabilities && typeof opts.capabilities === 'object' ? opts.capabilities : null;
        if (!capabilities && !raw) {
          const resolved = await resolveDeckCapabilities(ctx).catch(() => null);
          if (resolved) {
            raw = !!resolved.raw;
            capabilities = resolved.capabilities || null;
          }
        }
        const blocked = raw ? RAW_MODE_TOOLS.includes(name) : getBlockedToolsByCapabilities(capabilities).has(name);
        if (blocked) return FAIL(RAW_MODE_ERROR);
      }
      if (args && typeof args === 'object' && args.__raw !== undefined) {
        return FAIL('工具参数不是合法 JSON，请重新调用并传入合法的 JSON 对象。');
      }
      const params = args && typeof args === 'object' ? args : {};
      try {
        if (name === 'app_call_api') {
          const operation = API_CATALOG.find((op) => op.id === params.operation);
          if (operation && permissionRank(opts.permission) < permissionRank(operation.permission)) return FAIL('接口需要「' + permissionLabel(operation.permission) + '」权限。');
        }
        if (name === 'app_run_command' && permissionRank(opts.permission) < permissionRank(commandAccess(String(params.name || '')))) return FAIL('命令权限不足');
        if(name==='app_run_command'&&params.name==='insert.three'&&normalizePermission(opts.permission)!=='full'&&params.payload?.code)return FAIL('自定义 Three.js 代码需要完全访问权限。');
        if(normalizePermission(opts.permission)!=='full'&&((name==='deck_insert_3d'&&params.code)||(name==='deck_compose'&&params.slides?.some(s=>s.elements?.some(e=>e.type==='three'&&e.code)))))return FAIL('自定义 Three.js 代码需要完全访问权限；可编辑权限可以使用声明式 scene。');
        const projectId = mutationProject(ctx, name, params);
        if (projectId) await opts.beforeMutation?.(projectId);
        const result = await run(ctx, params, opts);
        if (!result || typeof result !== 'object') return { ok: true, result };
        return result;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (err && (err.code === 'NO_EDITOR' || err.code === 'UNSUPPORTED' || err.code === 'NO_BRIDGE')) {
          return FAIL(msg);
        }
        console.warn('[agent/tools] 工具执行失败', name, err);
        return FAIL(msg);
      }
    },
  };
}

/** 工具名列表（用于调试/测试） */
export const TOOL_NAMES = TOOL_DEFINITIONS.map((d) => d.function.name);
