# WebDeck Studio · 架构与协作契约

> 网页 PPT 工作台：仿 Microsoft PowerPoint 的界面，用于创建 / 导入 / 可视化编辑固定 1920×1080、
> 多页、带动效的 HTML 网页 PPT（参考 `samples/motion-100`、`samples/bloom-live`）。
> 附带 Codex 风格 Agent 侧边栏、文件管理、逐次修改记录与撤回、技能系统。
>
> 本文件是所有模块的唯一接口契约。字段名 / 协议 / 命令名不得各自发明；变更先改本文件。

---

## 0. 运行方式 / 技术栈

- 运行时：Node.js ≥ 20（本机 v24），**零第三方依赖**，`node server.mjs` 启动。
- 前端：原生 ES Module（无打包、无框架），现代 CSS。禁止 React/Vue/Tailwind/构建步骤。
- 浏览器目标：Chrome / Edge 最新版（本机有无头 Chrome，用于截图验收）。
- 服务地址：`http://127.0.0.1:4321`（`PORT` 环境变量可覆盖；4310 被本机 QQ 占用，勿用）。
- 数据目录：`projects/`（用户工程）、`data/`（设置、缓存）、`samples/`（内置示例原稿）。
- 图标：全部内联 SVG（`app/js/ui/icons.js`）。字体：只用系统字体栈。禁止联网字体/图标库。

```
D:\DSHPj\pptweb\
  server.mjs                  # HTTP 服务：静态 + REST + AI 代理 + 导入
  docs/SPEC.md                # 本文件
  editor/
    deck-runtime.js           # 原生 deck 运行时（内联进每个 deck）
    deck-runtime.css          # 运行时 CSS（内联进每个 deck）
    fx-presets.js             # 动效预设（window.WPX_FX / WPX_FX_CATALOG / WPX_EASES / WPX_FX_UTIL）
    bridge.js                 # 注入 deck iframe 的编辑桥
    thumb.css                 # 缩略图「动画终态」CSS
  templates/<id>/             # 新建工程模板（index.html + template.json）
  skills/*.md                 # 内置前端技能
  samples/<id>/               # 内置示例原稿（index.html + sample.json）
  app/
    index.html                # 应用外壳（唯一 HTML）
    styles/{base,chrome,library,editor,animations,agent}.css
    js/
      main.js                 # 启动 + 路由 + 全局快捷键
      core/{bus,store,api,dom,toast,dialog}.js
      ui/{titlebar,ribbon,statusbar,overlays,palette,icons}.js
      library/{library,create,import,convert}.js
      editor/{editor,bridge-client,selection,text,insert,inspector,slides,
              animations,transitions,themes,present,export}.js
      agent/{agent,loop,tools,prompt,skills,settings,markdown}.js
  projects/<id>/              # 运行时生成：project.json / index.html / original/ / assets/
                              #   .history.json / .chat.json / .versions/
  data/settings.json          # 全局设置（API key 服务端保存，不回传明文）
  scripts/qa.mjs              # 无头 Chrome E2E / 截图
```

---

## 1. 产品形态（验收标准）

### 1.1 文件库（路由 `#/`）
- 顶栏：品牌、搜索、新建、导入、设置（AI / 外观）、深浅色切换。
- 工程卡片网格：缩略图（`/api/projects/:id/thumb?slide=0` 实时渲染）、名称、页数、更新时间、来源徽章；
  操作：打开 / 重命名 / 复制 / 导出 HTML / 删除（二次确认）。
- 新建：模板画廊（空白 / 墨韵 / 繁花 / 素白）→ 命名 → 创建进入编辑器。
- 导入：上传 HTML / 本机路径浏览 / 内置示例 → 复制原稿到 `original/index.html`（含相对资源）
  → 自动转换为原生工程（捕获每页 HTML / 原 CSS / WAAPI 动画快照，进度 + 报告）；原稿可单独放映。

### 1.2 编辑器（路由 `#/p/<id>`）
- 布局：**52px 单行顶栏**（品牌/文件 + 8 个 Ribbon 标签 + 搜索/保存/撤销重做/Agent 主按钮/放映/更多）→
  Ribbon 内容区（104px，可折叠）→ 左侧幻灯片缩略图（220px）→ 中间画布 → 右侧属性面板 → 右侧 Agent 栏（全高，可收起）→ 状态栏（30px）。
  UI 基础字号 14px；控件 32px。
- 画布：点击选中、拖拽移动、8 向缩放、旋转手柄、双击编辑文字、方向键微调、Delete 删除、
  Ctrl+D 复制、Ctrl+Z/Y 撤销重做、拖入/粘贴图片。
- 文字：contenteditable 内联编辑；字体/字号/颜色/粗斜下划线/对齐/行距/字距。
- 插入：文本框、图片（上传/URL/拖放）、形状（矩形/圆/椭圆/线/三角/箭头/星形）、图标、HTML 代码块。
- 动画：分类动效库（悬停预览、点击应用）、开始方式/时长/延迟/缓动/循环、当前页动画窗格、预览。
- 切换：18 种切换画廊（悬停预览）、时长、应用到全部。
- 设计：8 套主题、字体组合、背景、颗粒/暗角。
- 放映：新窗口放映（从头/当前页）、导出 HTML、打印/PDF。
- 每次修改产生一条历史记录（历史面板可查看/单条撤回/回到某点），自动保存（防抖 800ms）。

### 1.4 兼容模式（raw，原稿直编）
- 导入 HTML 默认 `mode:'raw'`：`index.html` 即原稿副本（含原 script/style/运行时），`original/index.html` 保留 pristine 版。
- 编辑器 bridge 检测不到 `__WPX__` 时进入 raw 分支：识别原稿 `.slide`/`[data-slide]`，切页走原稿 hash/键盘导航（编辑态加速计时器），
  直接编辑 DOM；不支持预设动画/切换/页结构/主题变量（capabilities 全 false），保存不写 `index.html`。
- 编辑结果以**补丁数组**存 `.raw-edits.json`（由 `bridge.buildPatches(ops)` 生成：html/style/attr/insert/delete/bg/css/js/slide-html）；
  `GET/PUT /api/projects/:id/patches`。
- 放映/导出：server 在 raw `index.html` 注入 `<script id="wpx-raw-patches">` + `/editor/raw-patches.js`（导出时内联应用器），
  原稿初始化后按序应用补丁（幂等，切页补当前页）→ 原稿动画/切换完整保留。
- 转换：raw 工程可在文件库菜单「转换为可编辑工程」，读取 `original/index.html` 走标准转换，`kind` 变 native。
- bridge raw 契约：ready `{mode:'raw'}`；`getState()` 返回 `raw:true` + `capabilities:{slides:true,animations:false,transitions:false,structure:false,text:true,insert:true,themes:false}`；
  拒绝 setAnimation/addSlide/duplicateSlide/deleteSlide/moveSlide/previewAnimation/setThemeVars（错误信息「兼容模式不支持…」）；新增 `buildPatches`/`getRawPatches`。

### 1.5 Agent（右侧栏，Codex 风格，全高）
- 面板占满窗口右侧全高（含顶栏区域）；打开时左侧 titlebar/ribbon/main/statusbar 通过 `margin-right:var(--agent-w)` 让出宽度。
- header：Agent 标题 + 新会话 / 历史 / 设置 / 收起；**不显示提示性小字**。
- composer：输入框在上；底部一行工具条 = **模型选择器**（能力徽章）+ **思考强度**（自动/低/中/高 → `reasoning_effort`）+
  **工作权限**（只读 / 可编辑 / 完全访问；tools.js 按权限过滤：read 永远允许、改幻灯片需 edit、写文件/改 JS/CSS 需 full）+
  附件 + 发送/停止。技能 pills 不放 composer，技能管理在 AI 设置「高级设置」。
- 消息区：markdown、代码块、工具调用卡片（状态/结果/撤回）、思考过程折叠、流式光标；无 Enter/上下文等提示小字。
- 每个工程一个独立会话（`.chat.json`）。修改自动写入历史（source=agent）。
- 设置：Provider **分页标签**（DeepSeek / OpenCode Go / 自定义），内置页只填 API Key；Base URL/模型 id 在「高级」；
  「高级设置」折叠含温度（默认 0.7）、上下文上限（默认 100000000 tokens）、最大输出（默认 8192）、流式、技能管理。
  一键获取模型 + 能力识别；Key 只存服务端。

---

## 2. Deck 文件格式（原生格式，唯一可编辑格式）

自包含 `index.html`，打开即可放映。结构固定：

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>工程标题</title>
<style id="wpx-imported">/* 可选：导入原稿 CSS */</style>
<style id="wpx-theme">:root{ --wpx-bg:#0A0A0B; --wpx-fg:#F2EAE0; ... }</style>
<style id="wpx-css">/* 可选：自定义 CSS */</style>
<style id="wpx-runtime-css">/* 运行时 CSS（server 内联） */</style>
</head>
<body class="wpx-body" data-wpx-grain="off" data-wpx-vignette="off">
<div id="wpx-app" data-w="1920" data-h="1080">
  <div id="wpx-stage">
    <section class="wpx-slide" data-id="s1" data-name="封面" data-transition="fade" data-bg="#0A0A0B">
      <div class="wpx-canvas">
        <div class="wpx-el wpx-text" data-wpx-el="e1"
             data-wpx-anim="fadeUp" data-wpx-anim-params='{"delay":120,"duration":900}'
             style="left:120px;top:180px;width:900px;font:400 96px/1.2 var(--wpx-serif);color:var(--wpx-fg)">标题</div>
        <img class="wpx-el wpx-image" data-wpx-el="e2" src="assets/xx.png"
             style="left:1100px;top:180px;width:600px;height:420px;object-fit:cover;border-radius:8px" alt="" />
      </div>
    </section>
  </div>
  <div class="wpx-hud" aria-hidden="true"></div>
</div>
<script type="application/json" id="wpx-data">
{"title":"工程标题","w":1920,"h":1080,"theme":"ink","slides":[{"id":"s1","name":"封面","transition":"fade"}]}
</script>
<script id="wpx-runtime">/* deck-runtime.js + fx-presets.js 内联 */</script>
<script id="wpx-user-js">/* 可选 */</script>
</body></html>
```

约定：
- 画布 1920×1080，`#wpx-stage` 由运行时等比缩放（`--wpx-scale`）。
- 每页 = `section.wpx-slide > div.wpx-canvas > 元素`。
- **原生页**：canvas 无额外 class；元素带 `wpx-el`，几何/样式写 inline style（left/top/width/height px）。
- **导入页**：canvas 保留原稿 slide 的 class（如 `slide s1`），`#wpx-imported` CSS 生效；元素为原稿顶层子节点。
  运行时给 canvas 加 `.live`、给 section 加 `.is-active`，原稿 `.slide.live .xxx{animation:…}` 因此重播。
- 导入页的 JS 动画快照：section 上 `data-wpx-waapi='[{sel,keyframes,timing}]'`（iterations=-1 表示无限），运行时激活时重放。
- **导入页的原稿转场**：转换时会捕获原稿切换期间创建在 slide 根节点上的 WAAPI 动画，写入
  `data-wpx-tr-in='[...]'`（进入本页时应用）、`data-wpx-tr-out='[...]'`（离开本页时应用）、`data-wpx-tr-duration`（ms）。
  运行时优先用它们做转场，完整保留原稿的转场效果；未捕获到的页回退到 `data-transition`（转换时按原稿 HUD 文案猜测，
  如 SHUTTER→shutter），再回退 fade。
- 元素 id：`data-wpx-el`（稳定，保存进文件，历史跨刷新可用）。
- 元素动画：`data-wpx-anim="预设名"` + `data-wpx-anim-params='{delay,duration,easing,trigger,loop,distance,stagger,direction,intensity}'`；
  trigger: `auto` | `click` | `after`。
- 幻灯片：`data-transition`、`data-transition-duration`、`data-bg`、`data-name`、`data-id`。
- `#wpx-data` 保存页名/切换/标题；bridge 修改结构时同步更新。

### 2.2 主题变量
`--wpx-bg --wpx-fg --wpx-fg-2 --wpx-muted --wpx-accent --wpx-accent-2 --wpx-line --wpx-serif --wpx-sans --wpx-latin --wpx-radius --wpx-grain-opacity --wpx-vignette-opacity`
内置主题：`ink paper bloom celadon midnight vermilion mono editorial`（数据在 `app/js/editor/themes.js`）。

---

## 3. 设计系统

- 字体：`--ui-font`（Segoe UI Variable/PingFang）、`--ui-serif`（Songti/Source Han Serif）、`--ui-mono`。
- 浅色：bg `#EFEDE8`、surface `#FBFAF7`、ink `#1B1A17`、muted `#8A8478`、line `#E1DCD2`、accent `#C43E1C`。
  深色：bg `#131312`、surface `#1B1B1A`、ink `#F2EAE0`、accent `#E1402B`。tokens 见 `app/styles/base.css`。
- 纯色 + 微颗粒噪点；圆角 6/10/14px；阴影克制；动效 token `--ease-out/--ease-spring`、`--dur-1/2/3`。
- Ribbon：标签 36px + 内容 96px；按钮 28px；下拉 8px 圆角；tooltip 180ms 延迟。

---

## 4. 动效预设（`editor/fx-presets.js`）

- `window.WPX_FX[name] = {cat,label,desc,chars?,play(el,params,ctx)}`，`play` 返回 `{cancel,finished}` 或 null。
  `ctx={instant,editing,stage,mode}`；`instant` 跳终态，`editing` 不播放。
- `window.WPX_FX_CATALOG = [{id,label,hint,items:[{name,label,desc,defaults}]}]`
- `window.WPX_EASES`、`window.WPX_FX_UTIL = {merge,ease,run,splitChars,restoreChars,restoreAll,springEase}`

分类与预设名（不得改名）：
- `text`：`fadeIn fadeUp fadeDown slideInLeft slideInRight zoomIn zoomOutIn blurIn springPop rotateIn flipInX clipUp clipWipe charDrop charStagger typewriter trackingIn strokeFill lineMask blockReveal`
- `shape`：`shapeSpring shapeRotate shapeWipe shapeFlip shapeBounce`
- `loop`：`pulse breathe shake swing floatY marqueeX hueFlow glowPulse`
- `emphasis`：`underlineGrow sweepLight glitch colorPop`
- `exit`：`fadeOut flyOut zoomOut`

切换（`data-transition`）：`fade pushLeft pushUp pushRight pushDown zoom zoomOut flipX flipY iris blinds split wipeUp wipeDown curtain dissolve glitch slide shutter mosaic clock fold push bars`（24 种）。
另支持自定义转场：`data-transition="custom:<name>"`，运行时查 `window.WPX_TRANSITIONS[name]`（见 §5）。

---

## 5. 运行时 API（`window.__WPX__`）

```js
__WPX__ = {
  version, mode: 'present'|'edit'|'thumb', ready: Promise,
  getState(),        // {mode,current,total,w,h,editing,slides:[{index,id,name,transition,duration}],stage:{left,top,width,height,scale},model}
  go(index,{instant}), next(), prev(), replay(), setEditing(bool),
  playAnimations(slideIndex?), stopAnimations(),
  on(evt,fn), off(evt,fn),        // 'ready' 'slidechange' 'animstart' 'animend' 'editing'
  getSlideEl(i), getCanvasEl(i), applyWaapi(slideEl, instant), refresh(),
  setTransition(i,name), setDeckFlags({grain,vignette,clickAdvance}), serializeState(),
  registerTransition(name, fn), listTransitions(),
}
```
- 入场时序：运行时在目标页显示**之前**预置元素动画首帧（paused），显示后同一帧释放播放；
  导入页的 CSS 动画在切换开始时即加 `.live`。这样原本就在页面上的元素不会先显示终态再跳回首帧（消除“抽搐”）。
- 自定义转场：`__WPX__.registerTransition('name', async (outEl, inEl, ctx) => {...})`，
  `outEl/inEl` 是 1920×1080 的 section 元素，可任意 WAAPI；页面设 `data-transition="custom:name"`。
  自定义 JS 放在 `#wpx-user-js`，Agent 可用 `deck_set_custom_transition` 工具注册并应用。
- URL：`?wpx=edit` 编辑模式（禁翻页输入、HUD 隐藏、动画瞬移终态、body.wpx-editing 强制 CSS 动画到终态）；
  `?wpx=thumb&slide=N` 单页缩略图；默认放映（键盘/点击/滚轮/触摸/HUD/`#n` 深链）。
- 放映模式：`body.wpx-mode-present`；编辑：`body.wpx-mode-edit`；缩略图：`body.wpx-mode-thumb`。
- 打印：`@media print` 每页一张 1920×1080。

---

## 6. Bridge 协议（父窗口 ↔ deck iframe）

注入：`GET /p/:id/index.html?wpx=edit` 在 `</body>` 前注入 `<script id="wpx-bridge" src="/editor/bridge.js">`。

消息：
```js
// 父 → iframe
{type:'wpx:req', id, method, params}
// iframe → 父
{type:'wpx:res', id, ok:true, result} | {ok:false, error:{code,message}}
{type:'wpx:event', event, data}   // ready/slidechange/selectionchange/change/textedit/shortcut/deckchange/error
```
- `change`：`{op}`；父窗口入历史、标 dirty、自动保存。
- `applyOp` **不**发 change。修改方法各产生一个 op 并发 change。
- `shortcut`：`{key,code,ctrlKey,shiftKey,altKey,metaKey}`，父窗口映射为命令。

方法表：
```
getState go select selectAt deselect getSelection hitTest
beginTextEdit endTextEdit execTextCommand setText setElementHtml getElementHtml
setStyles setAttrs moveElement resizeElement rotateElement
beginTransform updateTransform commitTransform cancelTransform
insertElement deleteElement duplicateElement
setAnimation getSlideAnimations previewAnimation
addSlide duplicateSlide deleteSlide moveSlide setSlideAttrs getSlideHtml setSlideHtml
setDeckCss getDeckCss setDeckJs getDeckJs setThemeVars setDeckFlags getDeckFlags
applyOp serialize save getThumb setEditing reload
```
- `getState` 增加 `stage` 与 `capabilities`。
- `beginTransform({elementId})→{ok,before}`；`updateTransform({elementId,rect:{x,y,w,h,rotate}} 或 {mode,dx,dy,w,h,deg})→{ok,rect}`（不产生 op）；
  `commitTransform({elementId?})→{op}`；`cancelTransform()`。
- `insertElement` 参数：
  `text {type:'text',x,y,w,h,html,styles?}`；`image {type:'image',x,y,w,h,src,objectFit?,alt?}`；
  `shape {type:'shape',x,y,w,h,shape:'rect|circle|ellipse|line|triangle|arrow|star|diamond|hexagon',fill?,stroke?,strokeWidth?,radius?}`；
  `html {type:'html',x,y,w,h,html}`。返回 `{elementId,op}`（兼容别名 content→html、kind→shape）。
- `setAnimation` 支持 `{elementId,anim:{name,params}}`、`{elementId,anim:null}`、`{elementId,name,params}`。
- `getThumb({index})→{html,css,w,h}`：html 为该页 `<section class="wpx-slide is-active">…</section>`（canvas 带 live），
  css 为文档内所有 style 文本拼接。父窗口 srcdoc 包裹 `#wpx-app > #wpx-stage` 并引入 `/editor/thumb.css`。
- `serialize()→{html}`：清理桥、编辑态、选中态、HUD、body 模式类，输出 `<!doctype html>`。
- `reload()`：重载 iframe 文档。

### 6.4 修改记录 op
```js
{opId, ts, label, source:'ui'|'agent'|'import', type, slideIndex, elementId, before, after}
type: 'style'|'text'|'html'|'attr'|'move'|'insert'|'delete'|'anim'
    |'slide-add'|'slide-delete'|'slide-move'|'slide-attrs'|'slide-html'
    |'deck-css'|'deck-js'|'theme'|'deck-flags'
```
- `style` before/after `{cssText}`；`text/html` `{html}`；`insert` before null / after `{index,html,slideId}`；
  `delete` before `{index,html,slideId}` / after null；`anim` `{name,params}|null`；`slide-add` after `{index,html,id}`；
  `slide-delete` before `{index,html,id}`；`slide-move` `{from,to}`；`slide-attrs` `{name?,transition?,duration?,bg?}`；
  `slide-html` `{html}`；`deck-css` `{css}`；`deck-js` `{js}`；`theme` `{cssText}`；`deck-flags` `{grain,vignette,clickAdvance}`。
- 父窗口维护历史栈；撤销/重做调用 `applyOp({op,direction})`。

---

## 7. 服务端 API（`server.mjs`）

```
GET  /api/health
GET  /api/projects                         -> {projects:[ProjectMeta]}
POST /api/projects        {name,templateId}          -> {project}
POST /api/projects/import {fileName,content|sourcePath|sampleId,name?} -> {project}
GET  /api/projects/:id                    -> {project,files}
PATCH /api/projects/:id   {name?,kind?,slideCount?,theme?,cover?,coverFg?,coverAccent?,origin?} -> {project}
DELETE /api/projects/:id
POST /api/projects/:id/duplicate
GET  /api/projects/:id/file?path=index.html -> {path,content,size,mtime}
PUT  /api/projects/:id/file {path,content}  -> {ok,savedAt,size}
POST /api/projects/:id/assets?name=x.png  (body=二进制) / (JSON {name,dataUrl}) -> {url,size}
GET  /api/projects/:id/history   PUT /api/projects/:id/history {ops}
GET  /api/projects/:id/chat      PUT /api/projects/:id/chat {messages,skills}
GET  /api/projects/:id/thumb?slide=N   -> 单页缩略图 HTML
GET  /api/projects/:id/export          -> text/html 附件
POST /api/projects/:id/upgrade-runtime -> 把工程内联的 runtime-css/fx/runtime 升级为最新版（保留 DOM/历史）
GET  /api/settings  PUT /api/settings
POST /api/ai/models  {providerId,baseUrl?,apiKey?} -> {models:[ModelInfo],source,baseUrl}
POST /api/ai/chat    {providerId,model,messages,tools?,temperature?,maxTokens?,stream?} -> SSE / JSON
GET  /api/skills /api/templates /api/samples
GET  /api/fs/list?path=   GET /api/fs/read?path=
GET  /p/:id/*             （index.html 支持 ?wpx=edit / ?wpx=capture / ?wpx=thumb）
GET  /templates/:id/*     /app/*  /editor/*  /samples/*
```
- ProjectMeta：`{id,name,kind:'native'|'imported',createdAt,updatedAt,slideCount,theme,cover,coverFg,coverAccent,size,origin,hasOriginal}`
- ModelInfo：`{id,name,family,contextLength,tools,vision,reasoning,badges,recommended}`
- 设置文件 `data/settings.json`：
  `{providers:[{id,name,baseUrl,keyEnv,apiKey,model,models,wire:'openai'|'auto'}], ui:{theme}, agent:{temperature,maxTokens,streaming}}`
  GET 不回传明文 key，返回 `keySet,keySource,masked`；PUT 支持 `apiKey`、`clearKey`、`removeProviders`。
- key 优先级：设置 > 环境变量（`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY`）。
- OpenCode Go：base `https://opencode.ai/zen/go/v1`；模型含 claude/anthropic → `/messages`（Anthropic wire），其余 `/chat/completions`。
- SSE 事件：`delta / reasoning / tool_calls（完整数组，在 done 前）/ usage / done / error`。

---

## 8. 前端核心

### 8.1 模块契约
每个模块导出 `export async function init(ctx)`，自行向 `ctx.bus` 注册命令/监听。
模块间只通过 `ctx`、命令、事件通信。`ctx`：
```js
{api, store, bus, icons, icon, toast, dialog, route, navigate(hash), setEditor(obj), getEditor(),
 refreshRoute(force), qa, version}
```
`app/js/main.js`：初始化 core → init 模块（ui → library → animations/transitions/themes → editor → agent）→ 路由分发 →
全局快捷键（Ctrl+S 保存、Ctrl+Z/Y、Ctrl+Shift+E Agent、Ctrl+K 命令面板、F5/Shift+F5 放映）。

### 8.2 命令总线（`core/bus.js`）
`bus.registerCommand(name, handler, meta{label,group,icon,shortcut,keywords})` / `bus.runCommand(name,payload)` /
`bus.on/off/emit`。事件：`project:open project:close project:saved project:dirty deck:ready selection:change
slide:change history:change agent:toggle toast ui:theme ui:tab command:error library:open library:search`。
命令全表（不得改名）：
```
app.back app.save app.export app.present app.presentCurrent app.undo app.redo
app.toggleAgent app.toggleInspector app.toggleSlidePanel app.zoomIn app.zoomOut
app.zoomReset app.zoomFit app.commandPalette app.settings app.toggleTheme app.reloadDeck
file.new file.import file.rename file.delete file.duplicate
slide.add slide.duplicate slide.delete slide.move slide.select slide.setTransition
slide.applyTransitionAll slide.setBackground slide.setName slide.previewAnimation
edit.cut edit.copy edit.paste edit.delete edit.selectAll edit.duplicate
text.bold text.italic text.underline text.strike text.fontFamily text.fontSize
text.color text.highlight text.align text.lineHeight text.letterSpacing text.style
insert.text insert.image insert.shape insert.line insert.icon insert.html
arrange.front arrange.back arrange.forward arrange.backward
arrange.alignLeft arrange.alignCenter arrange.alignRight arrange.alignTop
arrange.alignMiddle arrange.alignBottom arrange.distributeH arrange.distributeV
element.rotate element.opacity element.animation element.animationRemove
element.animationPreview element.lock element.unlock
design.theme design.fontPair design.background design.grain design.vignette
view.zoom view.grid view.rulers view.dark view.fullscreen view.slidePanel
agent.newChat agent.stop agent.send agent.toggleSkill agent.openSettings agent.toggle
history.open history.revertTo history.undo history.redo
```
命令 payload 约定：`text.fontFamily{family} text.fontSize{size} text.color{color} text.highlight{color}
text.align{align} text.lineHeight{value} text.letterSpacing{value} insert.shape{shape} insert.icon{name}
view.zoom{zoom} slide.setTransition{name,index?} design.theme{id|vars}`。

### 8.3 Store（`core/store.js`）
```
state = {route, library, project, deck:{ready,current,total,w,h,slides}, selection, ui:{theme,agentOpen,
inspectorOpen,slidePanelOpen,zoom,grid,rulers,activeTab,saving,savedAt}, history:{ops,cursor},
agent:{open,streaming,messages,skills,providerId,model,usage,status,error}, settings:{providers,ui,skillsCatalog}}
store.get/set/update/subscribe; pushOp/setHistory/canUndo/canRedo/undoOp/redoOp/truncateHistory
```

---

## 9. 编辑器模块（`app/js/editor/*`）

- `editor.js`：打开工程、iframe 加载、bridge ready、deck 状态、历史恢复、自动保存（800ms serialize→PUT）、
  历史持久化（600ms）、命令注册、`ctx.editor={project,bridge,iframe,reload,saveNow,goSlide,...}`。
- `bridge-client.js`：RPC 封装（8s 超时）、事件订阅、shortcut 映射命令、getState/getThumb/applyOp/serialize。
- `selection.js`：覆盖层（8 手柄 + 旋转手柄 + 尺寸气泡），拖拽/缩放/旋转走 begin/update/commit；方向键微调。
- `text.js`：双击 → beginTextEdit；Esc/失焦提交；Ribbon 文字命令（编辑中 execTextCommand，否则 setStyles）。
- `insert.js`：文本框/图片上传/形状/图标/HTML/拖放/粘贴。
- `inspector.js`：右侧属性面板（布局/文字/填充/描边/阴影/图片/动画摘要），双向绑定。
- `slides.js`：左侧缩略图（bridge.getThumb + srcdoc，虚拟化，拖拽排序，右键菜单）。
- `animations.js` / `transitions.js` / `themes.js`：动效库、切换画廊、设计主题（motion-design 负责）。
- `present.js` / `export.js`：新窗口放映、导出 HTML、打印。

## 10. Agent 模块（`app/js/agent/*`）

### 10.1 循环（`loop.js`）
system(prompt.js) → 历史 → 用户输入 → `POST /api/ai/chat` SSE → delta/reasoning/tool_calls/usage/done →
tool_calls 时按序执行 tools.js → tool 结果回填 → 继续（最多 20 轮）→ 持久化 `.chat.json`。
支持 AbortController 停止；错误卡片可重试；上下文过长保留 system + 最近 12 条 + 摘要。
工具修改产生的 op 由编辑器统一入历史；Agent 标注 `label='Agent · X', source='agent'`。

### 10.2 工具（`tools.js`，OpenAI function schema）
读：`deck_get_state deck_read_slide deck_get_element deck_get_html file_read file_list project_info`
改：`deck_set_text deck_set_style deck_set_attrs deck_move_element deck_resize_element
deck_insert_text deck_insert_image deck_insert_shape deck_insert_html deck_delete_element
deck_set_animation deck_add_slide deck_duplicate_slide deck_delete_slide deck_move_slide
deck_set_slide_attrs deck_set_custom_transition deck_set_deck_css deck_set_deck_js
deck_apply_slide_html deck_set_theme deck_set_deck_flags deck_undo history_list`
文件：`file_write`（仅 index.html / assets/** / original/**；写 index.html 后 reload）。
工具返回 `{ok, ...}` / `{ok:false,error}`；修改类返回 `{ok,opId,summary}`。

### 10.3 模型能力识别
`POST /api/ai/models`：`GET {base}/models` + models.dev 缓存（`data/models-dev.json`，24h）+ 启发式兜底；
返回 `badges` 与 `recommended`。

### 10.4 系统提示词（`prompt.js`）
角色 / 当前工程与选中元素 / deck 格式 / 工具规范 / 动效目录（WPX_FX_CATALOG）/ 设计规范 /
代码编辑规则 / 工作流（先读后改、最小改动、一次一个意图）/ 输出风格 / 安全边界 / 启用技能正文。

### 10.5 技能（`skills/*.md`）
frontmatter：`id name desc category default`，正文 ≤1200 字。内置 6 个：
`motion-design layout-typography color-system deck-narrative html-deck-craft image-treatment`。

---

## 11. 导入与转换（`app/js/library/convert.js`）

1. 原稿复制到 `projects/<id>/original/index.html`（相对资源一并复制到 `original/` 与工程根）。
2. 隐藏 iframe 加载 `/p/<id>/original/index.html?wpx=capture`（server 注入计时器加速器：200–3000ms→60ms，
   暴露 `window.__wpxNativeTimeout`）；失败回退 `api.getFile` + srcdoc + base href + 自注入加速器。
3. 收集所有 `<style>` / `document.styleSheets` 规则为 importedCss。
4. 找页：`#stage > .slide, .slide, section[data-slide], #app section`。
5. 逐页激活：优先模拟 ArrowRight（等待 80–120ms、检测 live 页变化）；失败则直接类切换。
6. `doc.getAnimations().forEach(a=>a.finish())` 后等待 30ms。
7. 捕获每页 HTML（保留原 class，去掉 live/active/under/current/show）+ 遍历元素收集 WAAPI 动画：
   `{sel:':scope [data-wpx-anim-id="aN"]', keyframes, timing:{duration,delay,endDelay,iterations(-1=∞),direction,easing,fill,playbackRate}}`，
   写到 section 的 `data-wpx-waapi`（HTML 属性安全转义）。
8. 组装原生 deck（§2）：`#wpx-imported`=原 CSS、`#wpx-theme`=按原稿取色、每页 section + canvas（保留原 class）+
   内联 runtime（fetch `/editor/deck-runtime.css`、`/editor/fx-presets.js`、`/editor/deck-runtime.js`）。
9. `PUT file index.html` + `PATCH project {kind:'native',slideCount,theme,cover,coverFg,coverAccent,origin}`。

验收：motion-100 转换后每页文字正确、动效区可见（静态终态 + 捕获动画可重放）；
bloom-live 转换后版式正确、CSS 入场动效放映时重播。

---

## 12. QA / 验收

- `node scripts/qa.mjs`：无头 Chrome + CDP（Node 内置 WebSocket）启动服务 → 打开应用 → 截图文件库 →
  新建工程 → 编辑器截图 → 双击改字 → 插入图片 → 应用动画 → 撤销 → 保存 → Agent 面板（无 key 降级）→
  截图到 `docs/shots/`。同时收集 console error / pageerror。
- 截图前 `document.fonts.ready` + 400ms 稳定；应用外壳 `?qa=1` 禁用 UI 动画（不影响 deck iframe）。

### 14.6 原稿转场保留 / 入场时序 / 运行时升级（2026-11-11 追加）
- 转换器在逐页激活时用 `Element.prototype.animate` 记录器捕获原稿切换动画（目标为 slide 根节点），
  以 `data-wpx-tr-in/out/duration` 写入 section；转换报告的 `transitions` 字段为捕获条数。
- 未捕获到 WAAPI 转场的页：转换时读取原稿 HUD 文案（如 `SHUTTER · 快门`）映射为内置切换名写进 `data-transition`。
- 运行时 `go()` 在显示目标页前预置元素动画首帧（`pause()`），显示后 `releasePrimed()` 播放；CSS `.live` 在切换开始时添加。
- 旧工程打开时编辑器调用 `POST /api/projects/:id/upgrade-runtime` 静默升级内联运行时（只替换
  `#wpx-runtime-css` / `#wpx-fx` / `#wpx-runtime`，不动 DOM/历史/用户 CSS/JS）。
  注意：用 `String.replace` 注入运行时代码必须用函数形式替换，避免源码里的 `$$` 被当成转义。

## 13. 协作规范

- 每个 teammate 只改自己任务卡的 write_scopes；共享文件（`app/index.html`、`app/js/main.js`、`core/*`、
  `server.mjs`、`editor/*`、`styles/base.css`）由 Lead 维护。需要新增挂载点/命令/字段先消息 Lead。
- 不引入 npm 依赖；不写 TypeScript；不提交构建产物。
- 2 空格缩进、单引号、中文注释；DOM 用 `core/dom.js` 的 `h()`。
- 修改含中文的 UTF-8 文件时**不要**用 PowerShell Get-Content/Set-Content（会按 GBK 解码损坏文件），
  用编辑工具或 Node fs（utf8）。
