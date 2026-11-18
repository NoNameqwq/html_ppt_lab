---
id: html-deck-craft
name: Deck 代码规范
desc: 本 deck 格式的 HTML/CSS/JS 编辑规范与禁忌
category: code
default: true
---
# Editable HTML craft
Inspect the actual DOM and capabilities before editing. Native decks and imported/raw pages have different contracts.

## Native structure
Use section.wpx-slide[data-id][data-name][data-transition] > div.wpx-canvas on a 1920 by 1080 stage. Editable elements carry data-wpx-el and wpx-el plus a type class. Geometry is in logical px.
Preserve stable IDs, imported classes/styles, #wpx-data, #wpx-runtime, #wpx-runtime-css and #wpx-fx.

## Scoped edits
Read before replacing #wpx-css or #wpx-user-js; keep unrelated code. Use theme tokens, scoped selectors and reversible tools. Avoid scrolling content or fixed elements escaping the stage.
Register transitions with __WPX__.registerTransition and lifecycle handlers with __WPX__.on('slidechange', ...); clean up listeners. Store assets locally for offline playback.

## Original navigation
Use style:custom, original html/css and stable {{target:i}} tokens in data-wds-target and data-wpx-action="go-id:{{target:i}}". Design from content, not a fixed menu of motifs. Preserve keyboard focus, touch targets, reduced-motion and working links.

## Visual inspection
Use deck_capture_slide for whole-page renders and detail crops. Use returned IDs and logical coordinates for precise local edits, then capture again. Use absolute:true resizing when the entire HTML/SVG composition must scale together. Check history, playback and export when affected. Never claim visual inspection using a text-only model.
