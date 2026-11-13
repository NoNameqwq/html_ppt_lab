---
id: html-deck-craft
name: Deck 代码规范
desc: 本 deck 格式的 HTML/CSS/JS 编辑规范与禁忌
category: code
default: true
---
# 本 deck 格式的 HTML/CSS 代码规范

## 结构（不得破坏）
- 页面：`section.wpx-slide[data-id][data-name][data-transition] > div.wpx-canvas > 元素`；画布固定 1920×1080。
- 元素：顶层子节点带 `data-wpx-el="e..."`；位置/尺寸只能写 inline style 的 left/top/width/height（px）。
- 动画：`data-wpx-anim="fadeUp"` + `data-wpx-anim-params='{"delay":120,"duration":900}'`（JSON 用单引号包裹）。
- 不要改写 `#wpx-data`、`#wpx-runtime`、`#wpx-runtime-css`、`#wpx-fx` 与 `body.wpx-body` 结构。
- 导入页 canvas 上的原有 class 与 `#wpx-imported` 样式必须保留，否则原稿动效失效。

## 样式
- 原生元素样式写 inline；成体系的样式放 `#wpx-css`，选择器以 `.wpx-slide` 或元素 `data-wpx-el` 为根，避免污染其它页。
- 用主题变量 `var(--wpx-*)`；不要 `position:fixed`（会脱离画布），不要依赖页面滚动。
- `body`/`html` 背景不要改；页面背景用 section 的 `data-bg`。
- 动画优先用 deck 预设（data-wpx-anim）；自定义 CSS animation 只放 `#wpx-css` 并限定在 `.wpx-slide.is-active` 作用域。
- 层级：0–10 背景、10–50 内容、50–90 前景；不要与选择框/HUD 抢层级。

## JS
- 自定义脚本只写进 `#wpx-user-js`；用 `__WPX__.on('slidechange', …)` 绑定，页面切换后重新初始化。
- 不引入外链脚本/字体/图片；资源放 `assets/`，用相对路径。
- 不要覆盖 `window.__WPX__`，不要用 `querySelector('.slide')` 抓页，改在 `#wpx-stage` 内查询。
- 事件监听在页面切换时清理，避免重复绑定。

## 改代码前
先 `file_read index.html` 或 `deck_get_html` 看清结构；小步提交；写 `index.html` 后编辑器会自动 reload；只改 `#wpx-css`/`#wpx-user-js` 时优先用 `deck_set_deck_css`/`deck_set_deck_js`。
