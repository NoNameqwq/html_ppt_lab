# 交付说明 · WebDeck Studio（页演）

日期：2026-11-11　位置：`D:\DSHPj\pptweb`　服务：`http://127.0.0.1:4321`（`node server.mjs`）

---

## 1. 需求对照

| 用户需求 | 实现情况 |
|---|---|
| 网页形式的 PPT 编辑工具（可编辑 motion-100 / bloom-live 这类 HTML PPT） | ✅ 原生 deck 格式 + iframe 可视化编辑；导入任意 HTML 网页 PPT 自动转换（保留原 CSS、捕获 JS 动画快照、原稿可放映） |
| 文字编辑 | ✅ 双击内联编辑；字体/字号/颜色/高亮/粗斜下划线/对齐/行距/字距；属性面板 |
| 插入图片 | ✅ 上传/URL/拖放/粘贴，自动存入工程 `assets/`；支持裁剪适配、圆角 |
| 使用内置动画 | ✅ 40 个动效预设（文字/形状/循环/强调/退场）+ 24 种页面切换；悬停预览、开始方式/时长/延迟/缓动/循环、动画窗格 |
| 原稿动效/转场保留 | ✅ 导入转换会捕获原稿每页切换动画（`data-wpx-tr-in/out`）并按原效果重放；捕获不到的页按原稿 HUD 文案回退到对应内置切换（motion-100 实测 176 条转场快照 + 11 页 shutter 回退）；原稿 CSS/JS 动画快照同样保留 |
| 预设不够时用 AI 实现效果 | ✅ 运行时支持 `__WPX__.registerTransition` 自定义转场；Agent 新增 `deck_set_custom_transition` 工具（注册 + 应用到页/全部页），系统提示词明确“不要降级成普通 PPT 效果，直接写 CSS/JS/WAAPI” |
| 入场抽搐修复 | ✅ 运行时在目标页显示前预置动画首帧（pause），显示后同帧释放；CSS `.live` 在切换开始时添加；实测 100ms 时元素仍在首帧（opacity 0 / translateY 56px），不再先闪终态 |
| 界面仿 PowerPoint | ✅ 标题栏 + 8 标签 Ribbon + 幻灯片缩略图栏 + 画布 + 属性面板 + 状态栏；放映/导出/打印 |
| 界面流畅动画、有质感的纯色简约设计 | ✅ 暖骨白/墨黑/朱砂纯色 + 微颗粒；spring/ease-out 动效 token；深浅色主题；1280×800 适配 |
| 内置 Agent 助手，可调内置工具、可直接改代码 | ✅ Codex 风格右侧栏；31 个工具；`file_read/file_write`、`deck_set_deck_css/js`、`deck_apply_slide_html` 直接改代码；系统提示词完整 |
| 设计 system 提示词 | ✅ `app/js/agent/prompt.js`：角色/工程上下文/deck 格式/工具规范/动效目录/设计规范/代码规则/工作流/输出风格/安全边界 + 技能正文（4.2k–6.7k tokens） |
| 默认 DeepSeek API + OpenCode Go API，一键获取模型、自动识别能力 | ✅ 双预设（`https://api.deepseek.com/v1`、`https://opencode.ai/zen/go/v1`）+ 自定义 Provider；一键 `/models` + models.dev 元数据 + 启发式能力识别（工具/视觉/推理/上下文） |
| 文件管理系统，能进入不同 htmlppt 再编辑 | ✅ 文件库（卡片/缩略图/搜索/排序/新建/导入/重命名/复制/导出/删除）；每个工程独立编辑 |
| Agent 记录每次修改、能撤回 | ✅ 所有 UI 与 Agent 修改生成可逆 op 入历史；单条撤回、回到任意时刻；工具卡片上「撤回」 |
| 一个文件一个独立对话，右侧栏可开关，仿 Codex | ✅ 每个工程独立会话持久化；右侧栏 Ctrl+Shift+E 开关；消息流/工具卡/思考折叠/流式/停止/技能 pills/用量 |
| Skill 功能：内置前端 skill，可自行决定开启 | ✅ 6 个内置技能（动效设计/版式字体/配色/演示叙事/Deck 代码规范/图片处理），composer pills 随时开关，随会话持久化 |

---

## 2. 交付内容

```
server.mjs                  零依赖 Node 服务（静态 + 工程 API + 导入 + 缩略图 + AI 代理）
editor/                     deck 运行时、40 动效预设、编辑桥、缩略图 CSS
app/                        原生 ESM 前端（外壳/文件库/编辑器/Agent/样式）
templates/                  4 套新建模板（空白/墨韵/繁花/素白）
skills/                     6 个内置技能
samples/                    内置示例原稿（motion-100 / bloom-live）
projects/                   5 个展示工程（开箱即用）
docs/SPEC.md                架构与接口契约
docs/DELIVERY.md            本文件
docs/shots/                 最终截图 + QA 报告
scripts/qa.mjs              无头 Chrome E2E（--convert / --agent）
scripts/shots.mjs           视觉截图
scripts/mock-ai.mjs         Agent E2E 用 Mock 模型
README.md                   使用说明
```

## 3. 验证结果

- **E2E 20/20 通过，0 console error / 0 warning**（`node scripts/qa.mjs --convert --agent`）：
  文件库 → 新建 → 编辑器 → 选中/改字 → 撤销 → 插入+动画 → 保存 → 增删复制页 → 切换/主题 →
  Agent 面板 → AI 设置 → 缩略图 → 命令覆盖（108 命令 0 缺失）→ 导入转换（motion-100 100 页/813 快照/
  **176 条原稿转场**；bloom-live 8 页/纯 CSS/**14 条原稿转场**）→ Agent 工具调用（Mock 模型真实走 SSE/工具/历史/撤回）→ 清理。
- **转场/时序专项验证**：转换后 motion-100 第 2 页转场中途 2 个 section 动画在跑（原稿 clipPath 擦除）；
  第 7 页无 WAAPI 转场时回退到内置 `shutter`（红条快门）；自定义转场 `qaSpinBlur` 注册成功并在切换中生效；
  墨韵第 2 页入场 100ms 时元素仍处于首帧（fadeUp opacity 0.53→0、clipUp opacity 0、translateY 56px），无终态闪烁。
  证据：`docs/shots/final-18-transition-captured.png`、`final-19-transition-shutter.png`、
  `final-20-anim-firstframe.png`、`final-21-custom-transition.png`。
- **旧工程自动升级**：打开旧工程时编辑器调用 `POST /api/projects/:id/upgrade-runtime`，只替换内联 runtime
  （保留 DOM/历史/自定义 CSS/JS），静默获得新转场与入场时序。
- **放映验证**：转换后的 motion-100 第 3 页正确显示「整行从遮罩升起」且 6 个动画在跑；
  墨韵模板第 2 页版式与动效正常。
- **视觉验证**：`docs/shots/final-*.png`（文件库浅/深色、新建模板、导入、编辑器、设计/切换/动画标签、
  历史面板、命令面板、Agent、BLOOM 编辑器、1280×800、放映）。
- 全部 JS `node --check` 通过；工程数据 6 个工程开箱可用（2 个转换示例 + 3 套模板 + 1 个用户新建）。
- 旧工程打开时自动升级内联运行时（只替换 runtime，不动 DOM/历史/自定义 CSS/JS）。

## 4. 已知限制

- 导入转换会把 JS 驱动的「元素级」动效冻结为「静态终态 + WAAPI 快照重放」；页面切换额外捕获 slide 根节点上的
  WAAPI 转场（原稿用纯 DOM/样式切换、无 WAAPI 时按 HUD 文案回退到内置切换）；原稿仍可「放映原稿」保留 100% 动效。
- 多选/组合/图表/视频未实现；旋转元素缩放为近似（松手自动校正）。
- 文字编辑中自动保存延后到编辑结束；极端关闭浏览器可能丢最后一次未落盘修改。
- Agent 上下文压缩为截断摘要；OpenCode Go 未获取模型时需手填模型 id。
- 仅本地单机使用（127.0.0.1，无鉴权）。

## 6. 第二轮 UI/UX 重做（2026-11-11 晚）

按用户反馈完成：

1. **顶部两行合并**：标题栏 + Ribbon 标签条合并为 52px 单行顶栏（左品牌/文件、中 8 标签、右搜索/保存/撤销重做/**Agent 主按钮**/放映/更多）；
   Ribbon 内容区独立一行 104px，可双击折叠；右侧加「当前状态」卡消除空白。
2. **字号/密度**：全局 14px、Ribbon 13px/分组 11.5px、卡片标题 16px、菜单 13px、控件 32px；文件库/编辑器/属性面板/Agent 全部收紧留白、放大字号。
3. **Agent 面板 Codex 化**：全高右侧栏（含顶栏区域）；header 仅 4 个按钮；composer 底部一行 = 模型选择 + 思考强度（自动/低/中/高）+ 工作权限（只读/可编辑/完全访问）+ 附件 + 发送；
   删除所有提示小字；技能 pills 移除、技能管理进「高级设置」；欢迎提示改为 4 个动效向 chips。
   权限与强度进入请求参数与提示词；工具按权限过滤（只读 8 / 可编辑 26 / 完全 32）并执行拦截。
4. **AI 设置重做**：Provider 分页标签（DeepSeek / OpenCode Go / 自定义），内置只显示 API Key + 获取模型/测试连接；
   Base URL/模型 id 收进「高级」；底部「高级设置」折叠含温度（默认 0.7）、上下文上限（默认 100M tokens）、最大输出（8192）、流式、技能管理。
5. **修复点击幻灯片缩略图不切换**：`bridge.go` 双层包裹参数 bug；同时修复新增/复制/删除页、插入后选中失败等同族问题。
6. **删除提示小字**：画布底部操作提示、属性面板提示、状态栏提示、Agent 的 Enter/上下文/先读后改提示全部移除。

验证：`node scripts/ui-check.mjs` **24/24 通过**（顶栏 52px/标签在顶栏/Agent 全高 802=视口/无提示小字/三控件/动效 chips/设置分页+高级 0.7·100M·技能/缩略图点击切页），
`node scripts/qa.mjs --convert --agent` **20/20 通过 0 error**。截图：`docs/shots/final-*.png`、`ui2-*.png`。

## 7. 第三轮美工重做（2026-11-11 深夜）

按用户反馈：

1. **零渐变**：界面内所有装饰渐变/噪点/暖色底全部移除（新增 `app/styles/design-v3.css` 最后加载，统一覆盖各模块）；
   依赖渐变的块改为纯色兜底；保留的仅是 deck iframe 内的原稿内容。
2. **纯白 / 纯黑**：浅色主题 `#FFFFFF` 纯白 + 中性灰（不再透暖橙），深色主题 `#0A0A0A` 纯黑 + 中性灰；去掉颗粒噪点与暖色阴影。
3. **坚实图标**：全部图标为内联 SVG，统一 2px 方头/斜接描边、圆角压到 1px；Agent 标识从机器人/星星改为**方形终端图标**（`>_`），不再使用机器人/星星。
4. **大按钮/紧凑**：按钮 36–42px、主操作实心（Agent 红色主按钮、新建/导入大按钮、发送按钮 40px）、圆角统一 2–4px；
   字号 14px、字重 600/700、去掉字间距，减少稀疏感。
5. **空白模板修复**：`templates/blank` 改为 **1 页纯白空画布（0 个元素）**，新建空白工程即为真正空白；模板封面也改为纯白。
6. 修复缩略图点击切页（上一轮已修，本轮回归通过）。

验证：`scripts/ui-check.mjs` **24/24**、`scripts/qa.mjs --convert --agent` **20/20**、0 console error；
浅色/深色/1280 截图见 `docs/shots/light-*.png`、`ui2-*.png`、`final-*.png`；空白工程实测 `total:1, elements:0`。

## 8. 兼容模式（raw 原稿直编）——按 Forma 思路新增（2026-11-11）

用户反馈转换后仍丢失大量原稿动画（Forma.html 参考：**直接编辑原稿 HTML + 补丁层**，而不是把运行时生成的 DOM 重新序列化）。本项目实现：

1. **导入默认 raw**：`index.html` = 原稿副本（原 JS/CSS/运行时不动），`original/index.html` 留 pristine；文件库卡片显示「兼容」徽章/RAW 角标，菜单提供「转换为可编辑工程」。
2. **编辑器 raw 分支**（`editor/bridge.js`）：检测不到 `__WPX__` 时进入 raw；识别原稿 `.slide`/`[data-slide]`，切页走原稿 hash/键盘导航（编辑态加速计时器），
   注入 pointer-events 让点击/选中/双击文字可用；支持文字/样式/图片/位置/插入/删除；禁用预设动画/切换/页结构/主题（capabilities 全 false），并返回「兼容模式不支持…」。
3. **补丁层**：保存不写原稿，`bridge.buildPatches(history ops)` 生成补丁（html/style/attr/insert/delete/bg/css/js/slide-html）→
   `.raw-edits.json`（`GET/PUT /api/projects/:id/patches`）；放映/导出时 server 注入 `wpx-raw-patches` + `/editor/raw-patches.js`，
   原稿初始化后按序应用（幂等、切页补当前页）→ **原稿动画/切换 100% 保留**。
4. **Agent**：按 capabilities 拦截 9 个动画/切换/结构/主题工具并返回友好提示；prompt 注入「工程模式：兼容模式（原稿直编）」；header 显示「兼容」徽章。
5. **示例工程**：新增 `100 MOTION STUDIES · 原动效`（100 页）与 `BLOOM · 绽放 · 原动效`（8 页）两个 raw 示例。

6. **收尾补强**：raw 模式给嵌套文本元素（h1/h2/p/span…）分配 id，双击精确编辑标题/段落（不再整块 wrapper）；
   保存时合并已加载补丁 + 本次会话补丁并按目标去重，保存后清空会话历史（补丁为唯一真相源，避免跨会话旧 ops 重复生成）；
   raw 导出/打印改走 server `/export`（原稿 + 内联补丁应用器）；顶栏来源徽章显示「兼容」；`api.getRawPatches/putRawPatches` 补齐。

验证：
- raw motion-100 编辑页：`raw:true`、100 页、缩略图 100、点击缩略图切页、选中文字修改 → 保存补丁 → 重新打开补丁在 → 放映页 `slides:100`、`animations:8/9`、`const FX = {}` 原样、补丁文本在、**index.html 字节数未变**。
- raw bloom-live：8 页、`#stage` 8 子节点、**28 个动画运行中**、0 console error（file-library 实测）；
  嵌套文本双击 → 两次保存 patches=2、重开两处都在、放映 49 个动画、导出 200 且内联补丁应用器（无外链）。
- Agent raw：`deck_set_animation/theme/addSlide` 返回统一友好错误、`file_read` 正常；正常工程回归通过。
- 回归：`node scripts/ui-check.mjs` **24/24**、`node scripts/qa.mjs --convert --agent` **20/20**、0 console error。
- 截图：`docs/shots/rawui-01-library.png`、`rawui-02-editor.png`、`rawui-05-present.png`、`d3-raw-*.png`、`task10-raw-*.png`。

## 10. 交互细节补充（2026-11-11 深夜）

- **Ribbon 间距**：`.ribbon-panel` 由 `space-between` 改为左对齐紧凑排列，右侧「当前状态」卡用 `margin-left:auto` 固定到最右；
  分组不再被拉开，视图/切换等组少的标签页也不会出现巨大间隔。
- **所有文字可编辑**：bridge 给嵌套文本元素（h1–h6/p/span/strong/em/a/li…）分配 `data-wpx-el` + `data-wpx-nested`，
  `hitTest` 返回 `textElementId`；双击任意文字（native 与 raw）精确进入该文本的 contenteditable，而不是整块 wrapper。
  实测 native bloom 标题内 `<span>` 双击后可编辑、输入生效、op 正常记录；无嵌套文本的工程仍按顶层元素编辑。
- **编辑态不自动翻页**：raw 模式在 bridge 注入捕获阶段守卫，拦截原稿的点击/滚轮/方向键翻页（放行编辑器自身与 contenteditable）；
  实测 raw motion-100 点击画面 current 前后均为 0，缩略图点击仍正常切页（current 2）。native 运行时本来只在 present 模式绑定翻页输入。
- 回归：`ui-check 24/24`、`qa --convert --agent 20/20`、0 console error。

## 11. AI 400 修复（OpenCode Go 会话头 / 参数兼容）

- **根因**：OpenCode Go 返回 `400 {"type":"error","error":{"type":"MissingSessionID",...}}`——它要求客户端发送
  `User-Agent`（标识自身）和每个会话稳定的 `x-opencode-session` 头，否则拒绝请求。之前代理没有带这两个头。
- **修复**：server 对所有 `opencode.ai` 请求统一加 `User-Agent: WebDeck-Studio/1.0` + `x-opencode-session`；
  Agent loop 在 `/api/ai/chat` payload 带 `sessionId = <projectId>:agent`（同一工程/会话稳定，便于路由与缓存）；
  模型列表请求也带会话头。
- **参数兼容重试**：部分模型（如 OpenCode 上的 Claude Haiku 5.5）会拒绝 `temperature`（deprecated）；
  proxy 现在遇到 `temperature` / `reasoning_effort` / `stream_options` 相关 400 时自动去掉对应参数重试一次。
- **验证**（真实 key，2026-11-11）：
  - OpenCode `deepseek-v4.1-flash`：200，流式 reasoning + tools 正常；
  - OpenCode `claude-haiku-5-5`：200（temperature 自动去掉）；
  - DeepSeek `deepseek-flash`：200；
  - `/api/ai/models`（DeepSeek / OpenCode）：200；
  - Mock Agent E2E：`qa --agent 18/18` 通过，0 console error。

## 12. 切换完整预览 + 每个 Ribbon 标签的 AI 设计弹窗

- **切换完整预览**：新增 `__WPX__.previewTransition(name, duration)`（运行时克隆当前页/下一页，在画布内用真实时长播放完整切换，
  不改当前页）；bridge 新增 `previewTransition`（raw 模式用原稿真实速度切到下一页再切回）；切换标签新增「完整预览」按钮，
  点击切换卡片会**先应用再完整预览**，不再只能看小卡片。
- **每个顶栏的 AI 设计弹窗**：所有 Ribbon 标签（开始/插入/设计/切换/动画/放映/视图/Agent）右侧统一加「AI 设计」按钮；
  弹窗自动带上下文（工程名、页码、选中元素、兼容模式），每个标签有对应的动效向快捷提示（如切换标签：
  「设计一个有电影感的切换」「把整册切换统一成柔和推移」「给这一页做一个旋转模糊转场」），发送后自动打开右侧 Agent 并发出请求。
- 实测：native `previewTransition` 存在、点击切换卡片后 iframe 出现 `.wpx-tr-preview` 且 2 个动画运行；raw 预览切换后回到原页；
  切换/开始标签的 AI 按钮与弹窗内容正确，0 console error。

- **全部效果弹窗**：切换标签新增「全部效果」按钮，打开大网格弹窗，22 个切换按 基础/推进/缩放/翻折/遮罩/特效 分组**一屏看全**
  （1440×900 下 22 张卡片无需滚动）；点击任意效果 = 应用到当前页并完整预览，Esc/点遮罩关闭。预设栏本身仍可横向滚动。
- 实测：22 张卡片、6 个分组、`scrollHeight == clientHeight`（一屏完整），0 console error。

## 13. 鼠标逻辑与元素右键菜单

- **左键不再翻页**：兼容模式在 iframe 内新增编辑态命中层 `#wpx-raw-hit`（覆盖舞台，捕获 click/dblclick/pointer 事件并阻止冒泡到原稿的
  `#app` 点击翻页监听）；bridge 的 pointerdown 通过坐标反查元素继续支持选中/拖动；双击直接进入嵌套文字编辑。
  实测 raw 工程点击画面 `current` 保持 0，选中正常，缩略图切页正常。
- **右键自定义菜单**：bridge 在 iframe 内拦截 `contextmenu`（阻止网页默认菜单）并把坐标/命中元素发给父窗口；
  `app/js/editor/context-menu.js` 在 native/raw 通用显示元素菜单：**编辑文字 / 复制元素 / 删除元素 / 用 AI 修改 / 属性面板**。
  右键通常落在父窗口的 `sel-hit` 覆盖层而非 iframe，因此 editor 现在把 `stage` 同步到 store，右键坐标换算不再失败；
  实测父覆盖层与 iframe 两条路径都能弹出菜单，native 点「复制元素」历史 op +1。
- 相关文件：`editor/bridge.js`、`app/js/editor/context-menu.js`、`app/js/editor/bridge-client.js`、`app/js/main.js`、`app/js/editor/editor.js`、`design-v3.css`。

## 14. 联网搜索工具 + 独立配置界面

- **工具**：新增 `web_search`（read 级，任何权限可用），Agent 开启联网后自动下发；执行器请求 `/api/search`，
  返回标题 / URL / 摘要 / 正文片段，提示词要求引用 URL、不编造。
- **服务商**：`DeepSeek Search`（`POST /v1/tools/search`，复用 AI 设置里的 DeepSeek Key 或单独 Key）与
  `Tavily`（`POST /search`）；设置里选一个即可。服务端 `POST /api/search` 统一代理，25s 超时，错误带上游 detail。
- **独立配置界面**：输入框底部「联网」开关旁的齿轮打开「联网搜索设置」弹窗（服务商 / API Key / Base URL / 结果条数 / 测试连接），
  与 AI 模型设置完全分开；设置保存到 `data/settings.json` 的 `search` 字段（Key 只写服务端）。
- **底栏防溢出**：Agent composer 工具条改为 `flex-wrap`，模型名省略、发送按钮固定右下，420px 面板不再裁切发送键。
- **验证**（真实 key）：
  - `/api/search` DeepSeek 搜索 200，返回 3 条结果；
  - Agent 开启联网 → 真实调用 `web_search` → 工具卡「完成」→ 模型输出带标题/链接的搜索结果；
  - 联网设置弹窗字段齐全，「测试连接」返回「连接成功：返回 3 条结果」；
  - `qa --agent 18/18` 通过；截图 `docs/shots/final-27-search-settings.png`、`final-28-web-search-tool.png`。

## 15. 输出截断修复 + 工具调用一键收起

- **原因**：DeepSeek 文档当前模型上下文 1M、**最大输出 384K**；此前 Agent 设置把 `maxTokens` 上限硬编码为 65536，
  且 loop 在 `finish_reason=length` 时直接结束，所以长回答会在中途停住。
- **修复**：
  1. 输出预算默认 131072（UI 上限 384000，可按模型调整）；服务端遇到 max_tokens 被拒时自动减半重试；
  2. loop 在 `finish_reason=length/max_tokens` 或流意外结束（有部分内容）时自动续写（长度截断最多 4 次、意外结束最多 2 次），
     续写提示要求从中断处继续、不重复开头；合成消息标记 `synthetic`，历史/UI 不显示；
  3. DeepSeek 官方文档：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`（1M 上下文 / 384K 输出）。
- **工具调用一键收起**：Agent header 新增「收起所有工具调用 / 思考过程」按钮，一次折叠全部 `.agent-tool` 与 `.agent-reasoning`，
  再点展开；实测折叠/展开状态与 tooltip 正确。
- 验证：`/api/ai/chat` max_tokens=131072 返回 200；`qa --agent 18/18`；一键收起 UI 实测通过。

## 16. 动画时间线（HTML 自由度）

- **定位**：时间线是 deck 级全局轨道，独立于分页；可跨页、多轨道、任意关键帧。不再用 PPT 的「每页一个动画」思路限制。
- **运行时**：native `__WPX__` 新增 `getTimeline/setTimeline/timelinePlay/timelinePause/timelineSeek/timelineGetState`；
  按 selector 找目标元素，用 WAAPI 建轨道动画并随播放头 seek；`followPages=false` 时切页不重置。
- **兼容模式（raw）**：新增独立 `/editor/timeline-player.js`，server 把 `.raw-timeline.json` 与 player 注入 raw 放映/编辑页；
  不改原稿 HTML，时间线可跨页驱动原稿元素，也可自动创建 `[data-wpx-tl="flash"/"fly"]` 贯穿层。
- **编辑器面板**：画布工具条「时间线」→ 底部面板：播放/暂停/回到起点、播放头、分页标记、多轨、关键帧菱形、
  添加轨道/关键帧/分页关键帧、屏闪层、飞入元素；双击关键帧编辑时间/透明度/transform/filter。
- **Agent**：新增 `deck_set_timeline` 工具；prompt 新增「HTML 自由度」「动画时间线」章节，明确可以用屏闪、飞入飞出、跨页轨道，不要守 PPT 限制。
- **新增切换 `flash`（闪白）**：白屏闪光后切入，已加入 22→23 个预设。
- 验证：native 时间线面板/屏闪轨道/播放 200 级 API；raw 工程时间线面板、屏闪层、播放、重开仍在（`.raw-timeline.json`）；
  截图 `docs/shots/final-29-timeline.png`、`final-30-raw-timeline.png`。

## 17. 64K 默认输出 + OpenCode ByteString 修复

- 输出预算默认改为 **65536（64K）**（AI 设置 → 高级设置可继续调高，DeepSeek 文档上限 384K）；自动续写保留。
- **ByteString 错误**：`连接 AI 服务失败: Cannot convert argument to a ByteString...` 的原因是 OpenCode Go 的
  `x-opencode-session` 头里带了中文工程 id；Node fetch 的 HTTP 头只允许 ByteString。现在 `asciiHeaderValue()` 会把非 ASCII
  字符转义为 `_<hex>_`，会话 id 仍稳定；模型列表/对话共用。
- 验证：`sessionId='bloom-绽放-原动效-634ed1:agent'` 请求 OpenCode `deepseek-v4.1-flash` → **200**；
  `/api/settings` agent.maxTokens=65536；`qa --agent 18/18`。

## 18. 使用入口

```bash
cd D:\DSHPj\pptweb
node server.mjs        # http://127.0.0.1:4321
```

首次使用建议：文件库「导入示例」→ 选 `100 MOTION STUDIES` 或 `BLOOM · 绽放`，体验完整转换；
或「新建」选模板直接编辑；右上角「AI 设置」填 Key 后 Ctrl+Shift+E 唤起 Agent。

## 19. HTML 自由度：鼠标逻辑 / 右键菜单 / 时间线 2.0 / 转场叠加（2026-11-12）

用户反馈：不要守着 PPT；左键无论如何都会翻页、右键还是浏览器菜单；时间线要能跨页、每页设置图层位置、分页自动关键帧、多轨。

1. **鼠标逻辑（编辑）**
   - 画布左键只选中/拖动，**任何情况下都不翻页**（native 与 raw 一致；raw 命中层继续拦截原稿的 click/wheel 导航）。
   - 右键总是自定义菜单，`contextmenu` 在父窗口与 iframe 内都被 `preventDefault`，浏览器菜单不再出现。
2. **右键菜单**
   - 元素菜单（`app/js/editor/context-menu.js`）：右键即选中该元素，再弹菜单：编辑文字 / 编辑 HTML 源码 / AI 重做 /
     置于顶层·上移·下移·置于底层 / 复制·粘贴·原位复制·删除 / **点击行为（二级菜单）** / 加入时间线轨道 / 复制到所有页 / 属性面板。
   - 画布空白菜单：插入文本·图片·形状·HTML / 粘贴 / 全选 / 时间线 / 网格 / 适应窗口 / 上一页·下一页 / 让 AI 重做这一页。
   - 元素「点击行为」写入 `data-wpx-action`：`next / prev / replay / timeline / go:N / url:…`，放映时点击元素执行动作而不翻页。
3. **放映鼠标逻辑**
   - 运行时与兼容模式外壳都提供自己的右键菜单：上一页 / 下一页 / 页码网格 / 全屏 / 重播 / 时间线 / 左键模式 / 退出。
   - 左键三档：`advance` 翻页（默认）/ `anim` 只播动画 / `off` 不响应；位置：切换标签「左键」下拉、放映标签「放映交互」、右键菜单。
   - deck 级存 `body[data-wpx-mouse]`（随工程保存）；raw 工程存 localStorage，按页面路径记忆。
   - 兼容模式新增 `editor/present-shell.js`（由 server 注入 raw 放映页/导出文件，编辑页不注入）。
4. **时间线 2.0（跨页 / 分页状态 / 多轨）**
   - 面板重写（`app/js/editor/timeline.js`）：可拖高度、轨道列 + 时间标尺 + 检查器；打开时画布让位，不再压在画布上。
   - 轨道关键帧：拖动改时间、双击空白加帧、选中后用检查器改 时间/不透明度/X/Y/缩放/旋转/模糊/缓动；轨道可隐藏、重命名、删除。
   - **分页状态弹窗**：为选中轨道逐页编辑 X/Y/缩放/不透明度，写入该页起点的关键帧；可「抓取画布当前值」。
   - 新建元素轨道时自动在**每个分页切换点**生成关键帧；页面增删时自动补齐/重算。
   - 贯穿层生成器：屏闪 / 飞入 / 光带 / 快门 / 黑场，一次生成贯穿全片、每次切页触发的图层与轨道；重复添加会复用已有轨道。
   - 关键帧属性改用 `translate / rotate / scale` 独立 CSS 属性（与元素自身 transform 叠加，不再覆盖位置）；修掉「轨道缓动扭曲整条时间轴」的问题（缓动下沉到每个关键帧段）。
   - 放映自动播放：`timeline.autoplay !== false` 时放映自动跑；切页按 `followPages` 对齐到该页起点，屏闪/飞入因此每次切页都触发。
5. **转场叠加**
   - slide 上新增 `data-wpx-tr-fx`；运行时有 `applyTransitionFx`：白闪 / 黑闪 / 色闪 / 飞入条 / 扫光 / 横线，叠加在原切换之上。
   - 切换标签新增「转场」下拉（叠加：无/白闪/黑闪/色闪/飞入/扫光/横线），应用当前页；`deck_set_transition_fx` 可批量。
6. **Agent**
   - 新工具 `deck_set_transition_fx`、`deck_set_element_action`；`deck_set_deck_flags` 增加 `mouseMode`；`deck_set_timeline` 提示词升级为 v2（x/y/scale/rotate/blur、分页状态、autoplay）。
   - 工具总数 36。

**验证**：`node scripts/qa.mjs --agent` **18/18 通过**；命令覆盖 117 条 0 缺失；专项脚本
`scripts/audit3/4/5/6.mjs` 验证：画布左键不翻页、右键菜单（元素 23 项 / 画布 / 二级 8 项）、放映右键菜单 15 项、
点击行为 `go:4` 生效、时间线屏闪在 P2+70ms 透明度 0.79、飞入 translate 生效、转场叠加 `.wpx-tr-fx` 出现、raw 放映左键 off 不翻页。

## 20. 统一网页模型 + Agent 2.0 + 界面遮挡修复（2026-11-12 晚）

用户反馈：不要「兼容 / 原生」两套模式；实例网页要能直接编辑；Agent 按 Codex 标准重写、所有功能有接口；界面有遮挡。

### 20.1 只有一种工程：网页
- 导入不再询问模式，一律「保留原稿」；移除卡片菜单「转换为可编辑工程」、导入弹窗的模式选择、全部「兼容模式」徽章/提示。
  对外统一叫「网页工程」；原稿 `index.html` 永不改写，编辑以 `.raw-edits.json` 补丁保存。
- **原稿页面也能用预设动画**：`setAnimation` 在网页工程里写 `data-wpx-anim`，保存为 attr 补丁；
  新增 `editor/web-runtime.js` 在进入页面时用 `fx-presets.js` 播放；编辑页不自动播放，只支持预览。
- **原稿页面也能叠转场特效**：`data-wpx-tr-fx` + `web-runtime.applyFx`（白闪/黑闪/色闪/飞入/扫光/横线）；
  每页配置存 `.raw-deck.json`（`GET/PUT /api/projects/:id/deck-config`），放映时注入 `#wpx-deck-config`。
- **稳定元素 id**：网页元素 id 改为「页序号 + DOM 路径」（如 `r0p0-4`），重开工程 / 重导补丁后时间线轨道仍能命中。
- **精确命中**：点击优先选语义元素（h1–h6 / p / img / a / button…），不再整页 1920×1080 wrapper；块级文本兜底。
- 页面结构（增删页 / 主题）仍由网页自身决定；提示语改成事实描述，不再建议“转换”。

### 20.2 Agent 2.0（Codex 标准）
- 视觉重做：48px header（终端图标 + Agent + 操作）、上下文条（工程 · 页码 · 选中元素）、
  空状态改为「左对齐标题 + 4 条可执行动作 + 能力标签」、输入框细边（去掉警示红 2px 描边）。
- 工具卡：细左边线 + 等宽字体 + 状态色（运行/完成/失败），结果默认折叠，失败展开；支持撤回。
- 新工具：`app_list_commands`（117 条命令清单）、`app_run_command`（执行任意 UI 命令）、`update_plan`（计划清单）；
  工具总数 39。`app_run_command` 在「可编辑」权限可用，内置拦截 agent/file/project 等危险命令。
- 计划卡片：`agent:plan` 事件渲染「计划 n/m」+ 勾选步骤。
- 斜杠命令：输入 `/` 弹出命令面板（过滤低价值命令，最多 8 条，↑↓ 选择、Enter 执行、Esc 关闭）。
- 提示词：删除兼容模式分支，统一为「网页工程（直接编辑网页 DOM）」；新增命令目录注入、工程/页面/选中/能力上下文；
  `deck_set_timeline` 升级 v2（x/y/scale/rotate/blur、分页状态、autoplay）。

### 20.3 界面遮挡与直觉修复
- Ribbon 内容区 104 → 118px，切换/动效卡片不再被画布裁切；时间线按钮改为带文字按钮，不再竖排。
- 时间线头部重排：跟随分页 / 自动播放改图标开关；屏闪/飞入/光带/快门收进「特效」菜单；关闭按钮始终可见；
  Agent 打开时时间线自动让出 420px，不再被面板盖住。
- Agent 输入框红色 2px 描边改为细边；空状态左对齐；`html:` 传 DOM 导致 `[object HTMLSpanElement]` 的图标 bug 修复。
- 文件库徽章去重（`网页` + `原稿保留`，角标 `WEB`）；导入弹窗去掉模式卡；设置里 Provider 高级摘要改名，避免与「高级设置」混淆。
- 产品文案去 PPT 化：窗口标题、导入、帮助、Agent 文案统一为「网页演播 / 网页」，不再自称 PPT。

**验证**：`qa --agent` 18/18；`qa-interaction` 12/12；`ui-check` 23/24（唯一失败是用户设置里上下文 1M，属数据）；
网页工程实测：H1 精确选中 544×320、预设动画保存为补丁并自动播放、第 2 页 flash 叠加出现、元素时间线重开仍命中。
