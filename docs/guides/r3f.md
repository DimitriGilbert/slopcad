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
  `pickCategory?`.
- `CadModel` — geometry mapping and the update diff; `useRenderGeometry`
  and `createRenderGeometryController` are the underlying machinery
  (`RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM` documents the dedupe epsilon).
- `CadViewport` (`@slopcad/ui`) — the one-mount composition: scene plus
  picking and overlay plumbing, prop-driven, `onSettled` firing on the
  first settled demand frame after a projection change.

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

## Selection highlight

`isBodySelected`, `selectedFaceIndices`, and
`buildFaceHighlightGeometry` drive the highlight passes; picking is
`resolvePickReference` over a `CadPick` (see [selection.md](selection.md)).

## The runnable example

`packages/docs-examples/src/core/projection.ts` builds the projection
end to end (12-triangle plate, camera, selection machine over it); the
`/docs` page feeds that exact projection to `CadViewport` and gates the
settled frame in Playwright.
