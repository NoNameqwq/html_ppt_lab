# 页面知识表达、结构导航与生图

公式与 SVG 的目标是演示页面本身。`deck_compose` 支持 `math` 和 `svg` 元素；HTML / 文本中的 `$…$`、`$$…$$`、`\(…\)`、`\[…\]` 也会在写入画布前排版。KaTeX 结果与原始 LaTeX 一同保存；SVG 保留源码。保存、版本、放映和离线 HTML 导出沿用同一内容，不依赖在线数学渲染服务。动态脚本生成的内容应由脚本自己调用渲染或改用这些原生工具。

## 结构与目录

内置技能分为内容与设计目录，支持递归发现，原有 ID 保持兼容。新会话默认启用新增技能；旧会话保留自己的技能开关，可在「设计技能」里启用或恢复默认。

- [Frontend Slides](https://github.com/zarazhangrui/frontend-slides)：固定舞台、演讲 / 阅读密度、视觉母题。MIT，已中文改写适配。
- [Anthropic PPTX](https://github.com/anthropics/skills/tree/main/skills/pptx)：图文构图、布局变化、对齐和视觉检查。Apache-2.0，已中文改写适配。
- `structured-navigation`：本项目的章节组织、页面预算和动画目录规则。

6 页以上且章节清楚时通常安排一页目录，计入用户指定总页数；短篇优先内容。目录可在 `deck_compose.slides[i].navigation` 声明，或通过 `deck_set_navigation` /「插入 → 动画目录」替换一页。支持花瓣、轨道、阶梯，2–6 个章节，按内容选择。下一级目录同样支持，需有足够内容与页数预算。

章节以页面 ID 绑定，移动页面后链接不变；删除目标后需要更新目录。放映进入目录时依次展开，选择的图形放大进入章节；遵循减少动态效果设置。编辑模式展示完整静态结构。内置「知识花园」8 页模板可直接新建体验，源码可通过 `node scripts/build-knowledge-template.mjs` 重建。

## 生图（默认关闭）

Agent「+ → 生图设置」填写独立的服务地址、模型 ID、API Key，手动勾选允许并保存。取消不会启用。关闭后保留已有图片，但禁止新的生成。模型不能通过通用设置 API 开启此开关。

兼容 OpenAI Images 的 `POST /images/generations`，服务地址可填 Base URL 或完整端点。必要参数为 `model`、`prompt`、`n:1`，默认省略可选的尺寸、质量与返回格式；支持 `data[0].b64_json` 和直接下载的 `data[0].url`。GPT Image 服务使用默认返回格式；其他兼容服务可按需指定 Base64 / URL。每个服务商支持的尺寸与质量可能不同。

官方接口参数参考：[OpenAI SDK 中由 OpenAPI 生成的定义](https://github.com/openai/openai-python/blob/main/src/openai/types/image_generate_params.py)。本次官方文档网页访问返回 403，因此依据这一官方源文件核对必要字段；没有使用第三方博客推断参数。

`deck_generate_image` 生成图片并自动插入指定页面；`images.generate` API 仅生成工程素材。图片保存为 `assets/generated-*.png|jpg|webp|gif`，进入工程版本并随 HTML 导出。密钥仅保存在服务端，不进入公开设置或对话提示。支持停止请求、3 分钟超时、大小限制、格式检查与失败提示；失败不伪造素材或完成状态。

## 右键重做

元素与整页的 AI 重做都先打开要求窗口，可补充风格、内容、布局与动效要求，默认保留内容与含义。取消不会发送；确认后才发送给 Agent。对话生成中遵循既有排队机制。工程或页序改变时要求重新选择目标。

## 验证

`npm run test:authoring` 覆盖页面排版、导航预算、生图开关与失败路径；`npm run qa:authoring` 使用隔离数据与本地模型验证页内公式、SVG、目录、右键要求、手动配置生图、自动入页、版本与放映。生图集成使用本地模拟服务验证，不消耗真实模型额度。
