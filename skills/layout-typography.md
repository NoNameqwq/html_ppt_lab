---
id: layout-typography
name: 版式与字体层级
desc: 网格、字号层级、留白与对齐规范
category: design
default: false
---
# Layout and typography
Build a system for the actual content, then refine it from rendered pixels.
- Start with a 1920 by 1080 logical stage, 64–120 px margins and an 8 px spacing rhythm. Change the grid when the subject warrants it; do not default to equal card grids.
- Body type often works at 28–40 px, notes 22–26 px, titles 72–120 px and hero type 120–220 px. Adjust to viewing distance and actual rendering.
- Choose available fonts with fonts_list / deck_auto_fonts. Keep CJK and Latin fallbacks and the user's content language.
- Give wrapping room; align baselines and optical edges. Allow for descenders, math and diacritics. Fix crowding through composition before shrinking all text.
- Vary page composition while keeping type and spacing tokens consistent.
- Capture the actual page with deck_capture_slide. Combine pixels with returned IDs, bounds, font sizes and overflow hints. Adjust specific coordinates or styles, then capture again.
