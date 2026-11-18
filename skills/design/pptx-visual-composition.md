---
id: pptx-visual-composition
name: PPT 视觉构图与质量检查
desc: 从 Anthropic PPTX 技能改编的布局变化、信息图、对齐与防溢出检查
category: design
default: false
source: https://github.com/anthropics/skills/tree/main/skills/pptx
license: Apache-2.0
---
# Visual composition and quality inspection
Adapted from Anthropic's PPTX Design Ideas and Visual QA: https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md . Apache-2.0 license retained in skills/licenses/anthropic-pptx-Apache-2.0.txt. This English adaptation targets editable HTML and does not use upstream Office conversion scripts.
- Use content-specific visual anchors, coherent type hierarchy and varied compositions. Avoid repeating generic title-plus-bullets pages.
- Group by meaning and align precisely. Comparisons need comparable scale; data needs labels, units and honest axes. Diagrams should explain relationships.
- Preserve useful white space and wrapping room. Fix crowding by changing composition or copy before shrinking all text.
- Let content determine chapter navigation and motion. Original HTML/SVG compositions are valid; fixed directory shapes do not limit the design.
- Inspect actual pages with deck_capture_slide. Use whole-page images for composition and crops for type, formulas and labels. Combine pixels with IDs, bounds and overflow hints.
- Apply targeted corrections, recapture and check nearby content. Test interaction, motion and exported playback when affected; report untested behavior explicitly.
