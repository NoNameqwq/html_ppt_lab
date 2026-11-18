# 内置技能索引

服务端递归发现带 `id` frontmatter 的 Markdown 技能。说明、许可文件不注入模型；技能开关仍按原有 ID 保存。

10 个内置技能正文使用英文，与系统设计提示词和三角色指令一致；frontmatter 中保留中文名称和说明供界面展示。目录、视觉风格与动效按内容自主设计，预设仅用于快速起步。视觉检查技能要求支持图片的模型查看实际画面，并在精调后截图复核。

- `content/structured-navigation.md`：整套章节架构、页面预算、原创交互目录，可按需启用。
- `design/frontend-slides-layout.md`：参考开源 Frontend Slides 的讲读密度、固定舞台与视觉检查，可按需启用。
- `design/pptx-visual-composition.md`：参考 Anthropic PPTX 的构图、图文排版与视觉质量检查，可按需启用。
- 根目录保留兼容的版式、动效、配色、叙事、图片和代码技能 ID。
- `code/three-dimension.md`：内置 Three.js 场景、几何建模、并行生成、鼠标 / 触摸操控与离线验证，可按需启用。
- `code/svg-illustration.md`：精细 SVG 图解、分层几何、科学标注、并行绘制与放大验收；SVG 请求和绘图子代理会自动获得详细绘制指导，也可手动启用技能。
- `licenses/`：第三方许可。外部技能的设计原则均经过本项目改写适配；不执行其中的部署或安装指令。

目录组件实现：`app/js/core/deck-navigation.js`；章节进入动画：`editor/deck-runtime.js`；页面公式与 SVG：`app/js/core/rich-content.js`。
