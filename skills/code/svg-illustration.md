---
id: svg-illustration
name: SVG 精细图解
desc: 精确构图、部件细节、科学标注、并行绘制与放大验收
category: code
default: false
---
# Detailed SVG illustration and explanation

Use this skill for a substantial original SVG illustration, technical/scientific diagram or full redraw. The application automatically supplies its detailed drawing guide for SVG/diagram requests and drawing workers; this skill adds a deliberate production checklist. A local color, label or position repair should preserve the rest of the illustration. The user's chosen level of abstraction and style governs the composition.

## Define what the illustration must teach

Name the central explanation in one sentence. Map the user's content to visible entities, required internal parts, relationships, flow/direction, quantitative scales and explanatory annotations. Mark uncertain facts or schematic dimensions explicitly rather than inventing precise-looking geometry. A complete illustration can be visually restrained, but must implement every essential component; do not replace a mechanism with an unrelated icon or a few generic cards.

Choose a view that reveals the explanation: cross-section for hidden structure, exploded view for assembly, projected/isometric view for spatial relationships, plot for quantitative change, or a composed overview and detail inset when one scale is insufficient. Keep the main visual hierarchy understandable at presentation distance and reserve detail magnification for content that needs it. Do not impose one repeated diagram layout on unrelated topics.

## Set the drawing contract before splitting work

Inspect the destination page and available x/y/w/h, source SVG if present, surrounding typography and real background. Establish these concrete inputs:

- ViewBox/aspect ratio, safe drawing margins, main subject bounds, origin, units, projected viewpoint and direction conventions.
- Component inventory, stable semantic group names, attachment points, input/output anchors and layer stacking order.
- Space for annotation lanes, callouts, inset/legend and formulas outside SVG when needed.
- Semantic palette, stroke hierarchy, font family/fallbacks and font sizes converted from actual display size to viewBox units.
- ID prefixes and worker ownership of defs, markers, gradients, clips, masks, symbols and their references.
- Reference facts/data/equations, known constraints and acceptance criteria for both content and rendered appearance.

Dispatch 2-4 independent tasks with agent_parallel. Use artifact:"svg" for a complete drawing asset or layer envelope and artifact:"analysis" for content verification, annotations/specifications or prospective review. Pass the shared contract in sharedContext and state the exact deliverable in each task. A worker rendering a cutaway and a worker rendering the body must receive a shared cut plane and connection anchors; dependent work cannot independently guess coordinates. Prefer independent bounded assets over several overlapping full-image replacements.

The coordinator continues independent page layout and explanatory writing while workers generate. Ordinary effort uses the current chat model; extreme effort uses each task's configured role model. Workers are read-only and return full source; only the coordinator applies project changes. Use agent_wait for the required task IDs at a dependency boundary, collect remaining tasks before delivery, resolve any conflicting assumptions and inspect the integrated result. A design review made before integration does not approve later edits.

## Construct the complete drawing

Work from silhouette and major masses to meaningful internal structure, component connections, characteristic secondary detail and annotations. Use named g layers so revisions remain local. For mechanisms, represent joints, shafts, supports, interfaces, section faces and actual motion paths when relevant. For organisms/molecules, preserve topology, compartment boundaries and transport/bond relationships. For an illustrated scene, use coherent perspective, overlapping planes, material cues and identifying features. Add detail that explains function or identity, not decorative complexity.

Compute alignment, symmetry and geometric continuity. Use purposeful Bezier handles, matched tangents and clean joins; do not approximate every curved object with a rough polygon. For graphs or fields, derive paths from actual functions/data with an explicit domain, scale, sampling policy and handling for discontinuities. Annotate axes, units, origin, meaningful values and extrema. Label schematic dimensions as schematic.

Route connectors through reserved space and attach them to the right component. Use consistent arrowhead geometry, orient/refX/refY and line conventions for physical connection versus causal/transport relationships. Avoid unintended junctions at crossings. Clip only when intentional; ensure markers and thick outlines fit within the viewport. Use symbols/use for repeated real components and keep unique semantic groups around instances.

Apply a clear contour/detail/reference stroke hierarchy at the actual final size. Keep color semantic and accessible with shape/line/number cues beyond color alone. Use local gradients, surface highlights, hatching or contact shadows only when they clarify material, volume or section. Keep lighting consistent. Retain negative space so detail can be read; use an enlarged inset instead of hiding essential information in tiny text.

## Typography and explanation

Use real text/tspan, available fonts with CJK/Latin fallbacks, consistent baselines and manual line breaks. Check sizes after viewBox-to-page scaling: a readable label on a large viewBox can become tiny in a small destination rectangle. Aim for the same readable hierarchy as surrounding slide text. Use leader lines/numbered callouts to map labels to exact parts. Reserve padding around labels and keep them away from connectors and silhouettes. Carry component names and color mappings into detail views and legends.

Place long prose and complex formulas in editable HTML/LaTeX next to the illustration. SVG text will not render raw LaTeX. Include a meaningful title/desc and aria-label describing the relationship or operation shown. Retain correct terminology, units and symbol definitions.

## Supported source and deliverable

Return one complete SVG in an svg code fence for each drawing task, including xmlns, viewBox, all defs, semantic groups, geometry, annotations and its closing root. State intended bounds, z-order or extraction transforms, component inventory, factual assumptions and checks separately. Omitted paths, TODOs, a prose plan and 'same as above' are incomplete deliverables. Continue after output limits rather than replacing remaining detail with a summary. The runtime checks complete XML/viewBox/namespace; this check does not judge visual quality.

The safe SVG insertion path supports svg/g/defs, geometric paths/shapes, text/tspan/textPath, title/desc, marker, gradients/stops, clipPath/mask, pattern and symbol/use. Use presentation attributes with explicit visual values and local references. Do not rely on embedded style elements, scripts, event handlers, foreignObject, external images/fonts, filters or SMIL. Animate stable named layers with the deck's CSS/WAAPI/timeline tools and keep a meaningful static/reduced-motion view. Each source must stay below 1,000,000 characters; use reusable symbols or separately bounded editable assets for larger work.

Use deck_insert_svg or deck_compose type:"svg" to apply complete source. Update an existing asset with its elementId and preserve unrelated layers. Namespace all local references before merging worker groups. Inspect the sanitized rendering; raw source alone can contain effects the safe insertion path removes.

## Final acceptance

Compare the implemented named groups with the component inventory and check proportions, topology, connections, units, label ownership and factual assumptions. Capture the whole modified page and the drawing/critical regions at scale 1-1.5 with a vision-capable model. Examine silhouette, contrast, contour joins, arrow direction, references, clipping, label overlap, annotation legibility, detail inset consistency and surrounding composition. Make targeted fixes and capture again. Check motion/interaction separately when used and confirm offline export retains required geometry/defs.

Without vision, inspect source/DOM geometry and references and disclose the missing pixel inspection. A large source, many paths or successful insertion is not evidence of precision or visual finish. Preserve complete worker artifacts and source for future edits and conversation-based rollback. Deliver only after source integration and actual checks; describe remaining limitations honestly.
