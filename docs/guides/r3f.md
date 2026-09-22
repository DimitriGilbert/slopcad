# R3F

`@slopcad/cad-r3f` renders the cad-core projection through React Three
Fiber. The boundary rule: the renderer consumes the projection as pure
data — geometry kernels and worker modules are never imported here.

## The pipeline

```text
kernel.tessellate(solid)                     → Tessellation (flat soup, canonical mm)
projectTessellation(bodyId, tessellation)    → RenderObject (validated, id-keyed)
createRenderProjection([object], camera)     → RenderProjection  ← the renderer's whole input
```

A `RenderCamera` is data too — `{ kind: "perspective", position, target,
up, fovDeg }` — parsed through the same boundary as untrusted input
(`parseRenderCamera`).

## The components

- `CadScene` — the deterministic scene: camera mapping, the fixed light
  rig, ground furniture (grid, axes, origin marker — `showGround` to
  hide). Props: `projection`, `selection`, `regeneration`, `onSettled?`,
  `pickCategory?`, and the Phase 45 additive surfaces: `userCamera?`
  (the session overlay — see below), `onUserCamera?` (gesture-commit
  records), `displayMode?`.
- `CadModel` — geometry mapping and the update diff; `useRenderGeometry`
  and `createRenderGeometryController` are the underlying machinery
  (`RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM` documents the dedupe epsilon).
  The Phase 45 `displayMode?` prop cycles the renderer pass states
  (`display-mode.ts`).
- `CadViewport` (`@slopcad/ui`) — the one-mount composition: scene plus
  picking and overlay plumbing, prop-driven, `onSettled` firing on the
  first settled demand frame after a projection change. Passes the
  Phase 45 camera/display props through to the scene.

```tsx
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

<CadViewport
  projection={projection}
  className="h-[320px]"
  onSettled={() => {}}
/>;
```

## Determinism, on purpose

The scene is engineered byte-stable: fixed camera/light constants
(`CAD_SCENE_*`, `CAD_SCENE_CAMERA_NEAR_MM`/`FAR_MM`), a documented
material, and settle semantics that make "the frame the test asserts" a
well-defined thing. The render suite (`pnpm test:render`) pins 87
byte-identical screenshots under SwiftShader software WebGL at a fixed
viewport/DPR — the `/docs` page's viewport card settles under the same
discipline (`pnpm test:docs`).

## The user camera overlay and display modes (Phase 45)

Interactive visualization is a session-scoped overlay, never a second
camera law: `userCamera` (a plain `RenderCamera`) replaces the
projection's spec for RENDERING only while present — applied through the
same `applySceneCamera` mapping, never serialized, never written by a
non-user action, cleared only by the explicit reset (`null`). The settle
gate follows the EFFECTIVE camera (`userCamera ?? spec`), and with no
overlay every byte is the pre-Phase-45 behavior. Gesture commits (drag
end, wheel notch, key step) report records through `onUserCamera` —
never per pointer move, so the pointer path stays render-free. Full
decision record: `docs/architecture/adr-user-camera-overlay.md`.

The pure command math lives in `standard-views.ts` (standard views
under the first/third-angle convention, fit-to-bounds, projection
toggle, zoom-window, look-at — every output a `parseRenderCamera`-valid
spec) and `view-cube.ts` (the nav cube's deterministic projection).
Display modes (`shaded` default, `shaded-edges`, `wireframe`,
`hidden-line`) are pass states from `display-mode.ts`: the surface
meshes stay mounted in every mode (picking survives), and hidden-line is
depth-occluded feature edges — the honest pre-HLR reading; real hidden
line removal belongs to the drawings phase.

## Selection highlight

`isBodySelected`, `selectedFaceIndices`, and
`buildFaceHighlightGeometry` drive the highlight passes; picking is
`resolvePickReference` over a `CadPick` (see [selection.md](selection.md)).

## The runnable example

`packages/docs-examples/src/core/projection.ts` builds the projection
end to end (12-triangle plate, camera, selection machine over it); the
`/docs` page feeds that exact projection to `CadViewport` and gates the
settled frame in Playwright.
