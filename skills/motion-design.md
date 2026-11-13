---
id: motion-design
name: 动效设计
desc: 缓动、时长、节奏与多元素编排原则
category: design
default: true
---
# 动效设计（WebDeck）

## 时长
- 入场：标题 700–900ms，正文/图片 500–700ms，装饰线 300–450ms。
- 强调/循环：pulse 1200–1800ms；微交互 150–250ms。
- 同屏相邻元素时长差不超过 200ms，避免忽快忽慢。

## 缓动
- 入场默认 expo（cubic-bezier(.16,1,.3,1)）或 smooth；位移用 expo，透明度用 smooth。
- 弹簧感（spring/back）只给关键主体（标题、数字），一页最多 1 处。
- 退场用 inOut，收得干脆；不要给退场加回弹。

## 编排
- 三层结构：背景/装饰先到位（delay 0–120ms）→ 标题（120–240ms）→ 正文/图片（240–420ms）。
- 列表逐项用 delay + stagger 60–90ms；总数 > 6 项时 stagger 降到 40ms，避免拖沓。
- 同屏动画最多 2 种类型（如 fadeUp + clipWipe），不要缩放、旋转、位移同时出现。
- trigger：首屏关键信息用 auto；互动步骤用 click；补充信息用 after 串在上一动画后。

## 克制原则
- 一页主次动画合计 ≤ 4 个；纯装饰循环动画 ≤ 1 个且 intensity ≤ 1。
- 字符级动效（charDrop/typewriter/trackingIn）只用于封面大标题，正文不要用。
- 设计本身已足够时不要加动画；动效用于强调结构关系（先后、层级、因果）。

## 三套常用配方
1. 杂志封面：背景 fadeIn 0/900 → 大标题 clipUp 120/900 expo → 副标题 fadeUp 260/700 → 细线 shapeWipe 320/600。
2. 数据页：大数字 pulse 0/1200 → 图表块 fadeUp 180/700 stagger 80 → 注释 fadeIn 420/500。
3. 过渡页：整块 blockReveal 0/800 expo + 标题 trackingIn 200/900。

## 检查
应用后调 bridge.getSlideAnimations 复核 delay/duration/trigger；同页重复应用同一动画要覆盖而非叠加。
