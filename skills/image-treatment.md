---
id: image-treatment
name: 图片处理
desc: 裁切、蒙版、构图与图片排版技巧
category: design
default: false
---
# 图片处理与构图

## 放置
- 大图满幅：x:0 y:0 w:1920 h:1080，`object-fit:cover`；作背景时压暗（linear-gradient 遮罩 opacity .35–.55）保证文字对比。
- 图文并列：图高 ≈ 6–8 行正文高；图片左边线与文字左边线对齐；图文间距 48–64px。
- 图片墙：2×2 用 24–32px 槽，尺寸严格一致；不要出现 3 张图两种比例。
- 不要拉伸变形：已知比例按比例算 width/height，或用 `object-fit:contain` + 同色背景。

## 裁切与构图
- 人物：视线方向留白，头部上方留 8–12% 空间；人脸放三分线，不要正居中心。
- 产品/截图：居中或贴右，四周留 64px 以上；截图加 1px 描边 + 8–12px 圆角更精致。
- 细节图：放大裁切并用 `object-position` 指定焦点，突出材质/表情。
- 装饰图：降低不透明度（.15–.3）或模糊（filter:blur(6px)）作背景层；单页 ≤2 张模糊图，注意性能。

## 蒙版与质感
- 圆角统一：`border-radius:var(--wpx-radius)` 或 8–16px。
- 渐变遮罩：顶部压字用 `linear-gradient(180deg,rgba(0,0,0,.55),transparent 40%)`，底部压字反向。
- 同页图片统一色调（可叠 color-mix 半透明图层），避免一张冷一张暖。
- 颗粒/暗角是全局开关（`data-wpx-grain` / `data-wpx-vignette`），不要给单张图重复加。

## 资源
- 图片放 `assets/`，命名语义化（hero.jpg/team-01.jpg），用相对路径引用。
- 优先用已有素材；用户附件图片先上传 assets 再引用。不要用外链图片。
- 提供 alt 文本（描述性短语），便于导出与无障碍。
