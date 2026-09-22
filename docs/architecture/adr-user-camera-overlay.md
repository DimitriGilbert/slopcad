# ADR — The user camera overlay (Phase 45 interactive visualization)

Status: accepted (Phase 45). Scope: viewport navigation, standard views,
display modes, fit/zoom-window/look-at.

## Context

Every deterministic surface in this repo renders through a
`RenderCamera` spec authored per fixture: the spec is law
(`packages/cad-r3f/src/scene-camera.ts` maps it verbatim, never reframing),
and the render/matrix suites pin its pixels byte for byte. Interactive CAD
needs the opposite: a camera the user moves continuously. The pre-Phase-45
`SceneCameraControls` solved this with ephemeral component state — a seed,
mutated by gestures, discarded whenever the spec content changed — which
kept determinism but made the user camera invisible to everything else
(no standard views, no fit, no projection toggle, nothing could command
or persist it).

Phase 45 (ROADMAP-CAD-PARITY.md) requires navigation, standard views,
display modes, fit/zoom-window/look-at — all of which WRITE a camera from
outside the gesture path — under the law that "user-initiated camera state
must not break baselines".

## Decision

The user camera is an explicit **session-scoped overlay record**, and the
spec stays the default:

1. **Rendering chooses spec-or-overlay at one point.** `CadScene` accepts
   an optional `userCamera: RenderCamera | null`. The camera rig applies
   the **effective camera** — `userCamera ?? projection.camera` — through
   the SAME `applySceneCamera` mapping. `scene-camera.ts` itself is
   unchanged: spec-is-law holds; the overlay is another validated spec,
   not a second mapping.
2. **Writers are user actions only.** Orbit/pan/zoom gestures (committed
   at gesture end, wheel, and keys), standard-view/view-cube clicks, the
   perspective/orthographic toggle, fit-to-bounds, zoom-window, look-at
   selection, and reset. No document edit, regeneration, import, or
   engine action writes, mutates, or discards it: a projection change
   re-renders geometry under the user's camera.
3. **Never serialized.** The overlay lives in workbench session state
   only; documents, baselines, and exports carry no camera from it.
4. **Reset-to-spec is explicit.** Clearing the overlay returns rendering
   to the projection's spec — the only path besides remount.
5. **The settle gate follows the effective camera.** `SettleProbe`
   certifies a frame once its geometry synced AND its camera applied;
   "its camera" is the effective camera, so a settled overlay view is as
   test-certifiable as a settled spec view. With no overlay the gate is
   byte-identical to the pre-Phase-45 behavior.
6. **Gestures stay off the render path.** Pointer moves mutate the three
   camera directly between demand frames (the existing fast path); the
   overlay record is committed per discrete action (gesture end, wheel
   notch, key step), so a drag never re-renders React state and no
   pointer-latency budget is introduced.

## Display modes and convention (the sibling decisions)

- **Display modes** (`shaded` default, `shaded-edges`, `wireframe`,
  `hidden-line`) are renderer pass states on `CadModel`, not document
  data: the surface meshes always mount (picking survives every mode);
  `wireframe` makes them `colorWrite: false, depthWrite: false`
  (invisible, non-occluding), `hidden-line` keeps `depthWrite: true`
  (occluding) under a feature-edge overlay — edges-only-with-occlusion,
  the honest pre-HLR reading of hidden-line (real HLR belongs to
  drawings). Feature edges come from `EdgesGeometry` at a documented
  threshold; tessellation silhouettes are not feature edges.
- **First/third-angle** is a session display preference. Per-view camera
  CONTENT is identical under both conventions (they differ in drawing
  SHEET arrangement, a drawings-phase concern); the setting's visible
  viewport effect today is the standard ISO view's corner (third-angle
  views from front-top-right, first-angle from front-top-left) —
  documented here so the drawings phase inherits the setting, not a
  surprise.

## Consequences

- Every existing suite passes untouched: the overlay defaults off and
  every new prop is additive.
- A commanded camera (view button, fit) re-seeds the gesture state on
  takeover, so orbiting after a command continues from the commanded pose
  with no jump.
- The machine surface grows `data-viewport-camera-source`
  (`spec`/`user`), `data-viewport-display-mode`,
  `data-viewport-convention`, and `data-camera-projection` beside the
  existing `data-camera-*` readouts.
- Session overlay means page reload returns to spec law — accepted; a
  persistent per-document camera would be document display state (the
  roadmap reserves that decision for section planes, Phase 46).
