# 内置技能索引

服务端递归发现带 `id` frontmatter 的 Markdown 技能。说明、许可文件不注入模型；技能开关仍按原有 ID 保存。

- `content/structured-navigation.md`：整套章节架构、页面预算、可交互目录，默认启用。
- `design/frontend-slides-layout.md`：参考开源 Frontend Slides 的讲读密度、固定舞台与视觉检查，默认启用。
- `design/pptx-visual-composition.md`：参考 Anthropic PPTX 的构图、图文排版与视觉质量检查，默认启用。
- 根目录保留兼容的版式、动效、配色、叙事、图片和代码技能 ID。
- `licenses/`：第三方许可。外部技能的设计原则均经过本项目改写适配；不执行其中的部署或安装指令。

目录组件实现：`app/js/core/deck-navigation.js`；章节进入动画：`editor/deck-runtime.js`；页面公式与 SVG：`app/js/core/rich-content.js`。
