---
id: three-dimension
name: 三维结构与交互
desc: Three.js 场景构建、并行生成、鼠标手势与离线交付
category: code
default: false
---
# Interactive three-dimensional explanations

Use the built-in Three.js engine when the user requests a 3D structure. Keep meaningful geometry, scale, labels and controls; do not replace the requested model with a flat illustration. Titles, annotations and formulas should remain editable HTML, SVG or LaTeX alongside the canvas.

## Parallel work

Call agent_parallel before writing a requested 3D project. Assign 2–4 independent tasks with concrete interfaces: geometry construction, visual composition/controls, or independent mathematical validation. Ordinary effort uses the active conversation model for every worker. Extreme effort routes each task to its configured design, implementation or review model. Workers return complete code/data without modifying the shared project; the coordinator integrates using normal tools and version checkpoints. Inspect the integrated scene afterward. A review performed before integration cannot approve subsequent changes.

Dispatch is non-blocking: continue independent layout, narrative, shared interfaces and code while workers run in the background. Use agent_parallel_status to inspect progress without waiting. At a dependency boundary, call agent_wait with batchId and optionally taskIds for just the required artifacts. Integrate only complete outputs; collect every worker and inspect the final scene before review or delivery. A wait timeout is normal and allows more independent work. Revalidate worker assumptions against the current project because the coordinator may have changed unrelated content meanwhile.

## Built-in component

Use deck_insert_3d to insert or update a structure; elementId updates an existing component and index selects an insertion page. deck_compose accepts elements with type:"three", scene, code, label and normal x/y/w/h geometry. The engine and OrbitControls are embedded automatically in offline exports. Do not add CDN imports, import maps, another renderer or an independent animation loop.

The scene object supports background (CSS color or null), camera:{position:[x,y,z],target:[x,y,z],fov,near,far}, autoFit, exposure, shadows, controls and objects. Camera position disables automatic fitting. Angles in object rotation are radians. Use stable object IDs and groups.

Objects support type mesh, group, line, points, arrow, axes or grid; geometry:{type,args,points}; material; position; rotation; scale; children. Geometry types include box, sphere, cylinder, cone, torus, torusKnot, plane, circle, ring, icosahedron, octahedron, tetrahedron, dodecahedron, capsule, lathe, tube and polyline. args are numeric Three.js constructor parameters; points are [x,y,z] arrays. For lathe, x/y define the profile. Grid supports size/divisions/color/color2; axes supports size; arrow supports direction/length/color/headLength/headWidth.

Materials support standard, basic, normal and phong plus color, roughness, metalness, opacity, transparent, wireframe, emissive and side (front/back/double). Lights support ambient, directional, point, hemisphere and spot with color/intensity/position. Default lighting is supplied when lights is omitted. controls accepts enableRotate/enableZoom/enablePan/autoRotate, distance/angle constraints and speeds.

For advanced procedural geometry, code is a synchronous factory BODY receiving THREE, scene, camera, renderer, controls, host and root. Add objects to root or scene. It may return {update(timeSeconds,deltaSeconds),dispose()}; the runtime owns rendering, resizing and resource disposal. Custom code requires full access. Declarative scene data works with edit permission. Never claim returned worker code is already applied.

## Subject-specific modeling detail

Build a component inventory before geometry: primary volumes, functional subassemblies, real attachment points, meaningful internals, reference geometry, annotations and operations. Establish units, origin/up axis, overall bounds, group ownership, camera target and shared worker anchors. The actual subject must be recognizable from its silhouette and connections before adding materials. A generic rotating primitive or arbitrary cluster is not a substitute for a detailed mechanism or scientific structure.

Use subject-appropriate construction: profiles/lathe for turned parts, tubes for curves, computed vertices for mathematical surfaces, oriented/instanced primitives for repeated real components, and sections or exploded views for essential hidden parts. Derive trajectories/fields from equations or data and label domains, units and any schematic proportions. Avoid self-intersections, floating joints, disconnected axes, duplicate coplanar surfaces and arbitrary decorative geometry. Use stable semantic IDs/groups for precise later changes.

Refine silhouette and proportions first, then interfaces and characteristic secondary detail, then labels and finish. Spend subdivisions on visible curvature rather than invisible mesh density. Reuse geometries/materials and bound sampling. Match roughness/metalness/opacity to actual material and available lighting; metal without an environment can look black, and transparent surfaces may sort incorrectly. Use section/exploded views when clarity is better than layered transparency. Choose deliberate key/fill/rim or other suitable lights and inspect contact shadows/highlights on the real page background.

Frame the model and its entire motion envelope with a clear focal target. Respect an authored camera, near/far/fov and controls limits. Use editable HTML/SVG annotations and LaTeX outside the canvas; attached 3D labels require explicit projection, resize/occlusion logic and cleanup. Do not assume text geometry fonts or unbundled helper packages exist. Do not add another renderer, frame loop or remote dependency. Motion must explain a real operation with correct pivots/time units, not simply spin the whole scene. Preserve a readable static/reduced-motion pose.

Give implementation workers artifact:"three" and complete coordinate/material/camera contracts in sharedContext; use artifact:"analysis" for specifications and independent validation. Require full scene JSON or factory body and integration instructions. A ready renderer only proves that something rendered: compare the final component inventory, inspect real pixels from several useful angles, repair geometry/material/camera defects and verify controls/motion separately.

## Interaction and verification

Preserve built-in rotate, zoom, pan, reset and editing controls. Mouse left drag rotates, wheel zooms and right drag pans. Touch supports one-finger rotation and two-finger zoom/pan. Editing mode has an explicit interaction toggle so scene manipulation cannot accidentally move the entire page element.

Check deck_get_3d_state for actual rendering errors, then use deck_capture_slide to inspect real pixels, framing, lighting, readable labels and surrounding layout. Make targeted scene/camera/element corrections and capture again. Test gestures separately from still images; verify exports without a network connection. If WebGL is unavailable, disclose the visible fallback and do not claim successful rendering.
