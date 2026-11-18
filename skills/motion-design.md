---
id: motion-design
name: 动效设计
desc: 缓动、时长、节奏与多元素编排原则
category: design
default: true
---
# Motion as explanation
Derive a motion grammar from the subject, relationships and audience. Named presets are optional shortcuts, never an exhaustive vocabulary.
- Establish reading order and a stable focal point. Use sequence and continuity to explain relationships rather than decorating every object.
- Start around 450–900 ms for entrances and 60–120 ms between related items, then adapt to complexity. These are starting ranges, not quotas.
- Prefer transform and opacity for continuous movement. Use SVG paths, masks, clip-path, WAAPI or original timeline overlays when useful.
- Do not loop distracting elements behind dense text. Avoid one signature transition repeated throughout the deck.
- Read existing CSS/JS and timelines; preserve unrelated tracks, clean up listeners and support prefers-reduced-motion.
- Use deck_capture_slide for composition and end-state readability. Check timing and interaction separately: a still image cannot prove an animation works.
