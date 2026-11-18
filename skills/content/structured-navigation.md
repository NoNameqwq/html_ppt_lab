---
id: structured-navigation
name: 章节结构与动画目录
desc: 页数预算、内容驱动的原创目录、层级交互与视觉连续
category: content
default: false
---
# Content-driven navigation architecture
Decide whether and how navigation supports this story. Petals, orbit and steps are optional shortcuts, not a fixed design menu.

## Budget and structure
Identify the main claim and real chapters. A short linear story may only need section labels. A larger or branching story may benefit from an overview or nested directory. Count every directory within the requested total. Do not deliver empty chapters.

## Invent the composition
Derive spatial organization and transitions from the content's relationships, audience and visual language. Create an original metaphor when useful, or a restrained typographic index when clearer. Examples are inspiration, never an exhaustive taxonomy. Continue chapter identity into destination pages.

## Implement
Use deck_compose navigation or deck_set_navigation with style:custom, chapters, html and css. For chapter i create a real button with data-wds-target="{{target:i}}" and data-wpx-action="go-id:{{target:i}}". Tokens resolve to stable page IDs so links survive reordering. slideIndex is zero-based in the final array and cannot point to the directory itself.
Scope CSS under .wds-nav-custom; provide meaningful labels, focus, touch targets and prefers-reduced-motion. Custom navigation uses destination page transitions; use allowed CSS/WAAPI/JS tools for original motion.

## Inspect and refine
Use deck_capture_slide on the overview and key destinations. Check readability, clipping, hierarchy and exact geometry; correct and recapture. Test navigation, return paths and reordered IDs separately. A still image does not prove interaction or animation.
