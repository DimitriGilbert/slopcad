# Phase 1.6 — Architecture Spike Findings

_Executed 2026-09-15. The spike code is **kept** as a non-production reference island at `apps/web/src/spike/**` plus the `/spike` route (`apps/web/src/routes/spike.tsx`). Every spike file opens with a NON-PRODUCTION banner. Nothing from the spike is imported by `packages/*` production sources; knip excludes the island (`knip.json`). Later phases build on these findings instead of starting from scratch._

## What the spike proves end-to-end

`param → box → subtract (boolean) → Manifold (WASM, Web Worker) → typed postMessage transport → R3F CadModel → deterministic screenshot`

- The real production bundling path works: `pnpm build` (TanStack Start → Vite → nitro node-server) emits the worker chunk and the hashed WASM asset, and the spike e2e runs against **that build**, not the dev server.
- Parameter changes update the rendered pixels **and** worker-side semantic numbers (volume, bounds).
- Two consecutive runs render byte-identical PNGs under SwiftShader software WebGL.

Evidence (reproduce with `pnpm test:spike` from the repo root):

| Artifact                                            | Meaning                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `apps/web/e2e-artifacts/spike/state-a.png`          | hole ⌀8 (defaults) — canvas screenshot bytes used in the assert |
| `apps/web/e2e-artifacts/spike/state-b.png`          | hole ⌀14 — compared byte-wise against state A (must differ)     |
| `apps/web/e2e-artifacts/spike/state-b-fullpage.png` | full-page context shot for human review                         |
| `apps/web/e2e-artifacts/spike/determinism-run1.png` | first full page load                                            |
| `apps/web/e2e-artifacts/spike/determinism-run2.png` | second full page load — byte-identical to run1                  |
| `apps/web/test-results/spike/**/video.webm`         | video artifacts (existence/duration per policy)                 |

Measured on the validating run (2026-09-15, after the kernel-normals fix below): state A vs state B differ in **10,360 pixels** (a pixel counts as differing when any of its R, G, or B channel values differ; diff bounding box [293,225]–[412,365] across the 790×558 canvas-element captures — the hole region of the front face; with exact per-face normals the planar faces are pixel-identical across states, so the diff is the bore alone); `determinism-run1.png` == `determinism-run2.png` byte-exact, SHA-256 `cd0745efb89f11f88caa49a476bded13b2f82d948cb17b2c0f4105db043103e1`; `state-a.png` == `determinism-run1.png` (same parameters, different browser contexts). Semantic assertions: volume within 0.5% of the analytic box-minus-cylinder value for both states, `volume(B) < volume(A)`, bounds exactly `30.000 × 20.000 × 10.000`, triangle count > 0.

---

## Contracts draft

### What a parameter looks like

Draft lives in `apps/web/src/spike/cad-api.ts`. A parameter is a **named entry in a spec record**, resolved into a keyed values record — not a loose variable.

```ts
numberParam({ default: 30, min: 10, max: 60, step: 1 });
// => { kind: "number", unit: "mm", default: 30, min: 10, max: 60, step: 1 }

type ParamValues<T extends ParamSpecRecord> = Readonly<
  Record<keyof T & string, number>
>;
```

- The document type `T` (the parameter spec record) keys the values type, so `parameters.width` inside a feature is a plain `number` under `noUncheckedIndexedAccess` — no optional-index noise at use sites.
- `evaluate()` accepts `Partial<ParamValues<T>>` and merges over defaults at the boundary (the worker never trusts a message to carry every key).
- Units are carried in the spec (`unit: "mm"`), not baked into numbers.

### What a feature graph looks like

Named nodes + lazy memoized name references (`cad-api.ts`, used in `plate-document.ts`):

```ts
feature<PlateParameters>("box",  ({ kernel, parameters }) => kernel.Manifold.cube([parameters.width, parameters.height, parameters.depth], true));
feature<PlateParameters>("hole", ({ kernel, parameters }) => kernel.Manifold.cylinder(parameters.depth * 2, parameters.holeDiameter / 2, undefined, undefined, true));
feature<PlateParameters>("plate", ({ kernel, get }) => kernel.Manifold.difference(get("box"), get("hole")));

export const plateDocument = cad({ parameters: plateParameters, features: [...], output: "plate" });
```

- `FeatureContext` = `{ kernel, parameters, get }`. `get(name)` memoizes per evaluation, so the graph is a DAG evaluated on demand without a separate topo-sort pass.
- Every feature returns a kernel solid (`Manifold` instance). The document's public surface is `parameters`, `defaultValues`, `evaluate(kernel, values)`.
- **Deviation from the plan's literal `cad({ parameters, build })`:** named `features` + `output` instead of a single `build` closure. Reason: node names are the minimum identity the later core phases need (per-feature diagnostics, invalidation, persistence); a single closure erases them. This stays a draft — redesign is expected.

### What the kernel boundary is

`apps/web/src/spike/cad.worker.ts` (worker side) and `cad-client.ts` + `protocol.ts` (main side).

- **Everything Manifold lives in the worker.** The authoring API (`cad-api.ts`) imports only _types_ from `manifold-3d` (`import type`), so the main-thread bundle carries zero kernel code; the kernel handle (`ManifoldToplevel`) is injected into `FeatureContext` at evaluation time.
- The boundary crossing is a strictly typed message pair (`protocol.ts`): request `{ id, kind: "evaluate", parameters }` → response `{ id, ok: true, result } | { id, ok: false, error }`. Geometry crosses as **plain transferable buffers**, never as kernel objects: `{ numProp, positions: Float32Array, indices: Uint32Array }` — `positions` interleaves xyz (channels 0–2) with the kernel's unit normals (channels 3–5 when `numProp` ≥ 6) — plus semantic scalars (`volume`, `boundsMin/Max`, `triangleCount`, `vertexCount`).
- WASM memory hygiene: the worker `getMesh()`s, reads volume/bounds, then `dispose()`s every constructed solid (`Manifold.delete()`) — Manifold/CrossSection instances are not GC'd.
- The client (`CadWorkerClient`) correlates by request id, resolves per-id promises, and terminates the worker on dispose. Stale results are dropped by effect cancellation, so rapid parameter edits are last-write-wins.
- Note: `manifold-3d` ships its own worker (`manifold-3d/lib/worker.bundled.js`) — it is the ManifoldCAD _script evaluator_ (evaluates arbitrary code strings with esbuild-wasm and exports GLTF blobs). Wrong shape for a product kernel service; the spike's thin typed worker is the model to keep.

### What the render projection boundary is

`apps/web/src/spike/CadScene.tsx`: worker mesh payload → Three.js GPU state, nothing else. It must not know about parameters, features, or the document.

- `numProp`-aware buffer construction: the interleaved payload backs one `InterleavedBuffer`; channels 0–2 bind as `position`, and when `numProp` ≥ 6 channels 3–5 bind directly as `normal`. Then `setIndex`. `computeVertexNormals()` survives only as the fallback for payloads without normal channels.
- **Normals are computed by the kernel, not the renderer.** Averaged vertex normals (`computeVertexNormals` over the indexed mesh) blend across the plate's 90° creases: planar faces shaded like an inflated pillow, dark crease streaks, a curved silhouette along flat edges — the boolean was correct and the shading hid the bore. Fix: the worker calls `solid.calculateNormals(0, 30)` before `getMesh()` — Manifold writes unit normals into property channels 3–5 and splits property vertices at edges sharper than 30°, so planar faces keep one exact normal, plate creases stay crisp, and the bore wall (~10° between facets) shades as a smooth cylinder. `minSharpAngle` is explicit because the API default shares *all* normals (same pillow). Deterministic: a pure function of the mesh, crossing the boundary as bytes.
- Bore visibility at the fixed camera: state B (⌀14) shows the cylindrical bore wall **and** the exit opening (background visible through the hole). In state A (⌀8×10 deep) the exit is geometrically occluded, not a shading artifact — sight lines at ~50° off the bore axis travel ~11.9 mm laterally across a 10 mm bore, more than the 8 mm opening admits; the elliptical rim plus visible inner bore wall still read unambiguously as a drilled hole.
- Scene constants are fixed: camera position/fov, two directional lights + ambient with pinned positions/intensities, one `MeshStandardMaterial`.
- Determinism contract of the scene: `frameloop="demand"` (renders only on explicit `invalidate()`), `dpr={1}`, `gl={{ antialias: false, preserveDrawingBuffer: true }}` (buffer must survive compositing for screenshots), no controls, no animation.

---

## Bundler notes — WASM-in-worker under Vite / TanStack Start

Verified with `manifold-3d@3.5.3`, `vite@^8.1.5`, TanStack Start `^1.168.32` (nitro node-server preset). Initialization (from the shipped `manifold.d.ts` + official docs; do not rely on the old `Module({ locateFile })`-returns-exports folklore):

```ts
import Module from "manifold-3d";
import wasmUrl from "manifold-3d/manifold.wasm?url";
import type { ManifoldToplevel } from "manifold-3d";

const mod = await Module({ locateFile: () => wasmUrl }); // Promise<ManifoldToplevel>
mod.setup(); // installs Manifold/CrossSection/Mesh classes
const { Manifold } = mod; // Manifold.cube / cylinder / difference / …
```

- **Always pin the WASM with `?url` + `locateFile`.** manifold.js's default resolution is `new URL("manifold.wasm", import.meta.url)`, which breaks under Vite dep optimization (the URL points into the prebundle dir where the `.wasm` does not exist). The package's `exports` map whitelists `"./manifold-3d/manifold.wasm"`, so the `?url` subpath import is legal; `vite/client` types the `*?url` module.
- The worker is created with `new Worker(new URL("./cad.worker.ts", import.meta.url), { type: "module" })` — first-class Vite syntax, works in dev and in the TanStack Start build. Production output: `apps/web/.output/public/assets/cad.worker-*.js` + `assets/manifold-*.wasm`, referenced by hashed URL. No manual copy/plugin needed.
- `postMessage` from the worker uses the options bag: `self.postMessage(response, { transfer: [positions.buffer, indices.buffer] })` — valid `DedicatedWorkerScope` runtime overload and the only form that typechecks against the DOM lib's `Window.postMessage` signatures.
- Vite prints `Module "node:module" has been externalized for browser compatibility` for manifold.js's Node-detection path: harmless shim warning, build and runtime are fine.
- The npm WASM is single-threaded (no SharedArrayBuffer / COOP-COEP needed) — consistent with the owner decision; it is also what makes identical parameters → identical meshes → identical pixels hold.

## Screenshot determinism under software WebGL

Harness: `apps/web/playwright.spike.config.ts` — same determinism setup as Phase 1.5 (Chromium, `--use-angle=swiftshader --enable-unsafe-swiftshader`, viewport 1280×720, DPR 1) but pointed at a **production build server** (`pnpm build && node .output/server/index.mjs`, port 3002, `reuseExistingServer: false`) so dev-only chrome (devtools) can never leak into pixels, and the tested bytes are the shipped bytes.

The settle protocol (the piece that makes waiting deterministic): `SettleProbe` inside the Canvas stamps `data-cad-rendered-volume="<volume.toFixed(3)>"` on `#spike-root` from `useFrame` on the first rendered frame of a new result; the e2e waits until that attribute equals the displayed `#spike-volume` text. Pixels are only compared once they provably belong to the numbers. Byte comparisons use Playwright `Buffer.equals` on canvas-element screenshots (not perceptual diffs, no baseline files).

Rules that made it pass, to carry forward:

1. demand frameloop + one `invalidate()` per applied result — no rAF drift;
2. `antialias: false` and `dpr: 1` — no MSAA/GPU-dependent resolve;
3. `preserveDrawingBuffer: true` — canvas content survives for capture;
4. fixed camera/lights; geometry is the only variable;
5. deterministic tessellation from the kernel (fixed segment policy per radius, single-threaded WASM);
6. semantic numbers (volume/bounds) asserted alongside every pixel assertion — geometry correctness is proven by the numbers, pixels cover the composed scene (matches the Phase 1 evidence semantics).

## How to run / what is excluded from what

- `pnpm test:spike` (root) → `pnpm --filter web test:spike` → `playwright test -c playwright.spike.config.ts`. Builds first, boots the prod server on 3002, runs `apps/web/e2e-spike/spike.spec.ts`, writes the artifacts above plus video/trace on failure. **Not part of `pnpm verify`.**
- The unit chain is untouched: the spike has no `src/**/*.test.ts` files, so `pnpm verify` (check-types → lint → test → build) never executes spike code as a test; it still typechecks and lints the spike (intentionally — the no-slop bar applies).
- `pnpm test:e2e` (smoke) is unchanged and still runs only `apps/web/e2e/`.

## Dependency versions added (apps/web only; none were in the catalog)

| Package              | Version | Compatibility check                                     |
| -------------------- | ------- | ------------------------------------------------------- |
| `manifold-3d`        | 3.5.3   | latest; single-threaded WASM, typed via shipped `.d.ts` |
| `three`              | 0.186.0 | latest; satisfies R3F peer `>=0.156`                    |
| `@react-three/fiber` | 9.7.0   | peer `react >=19 <19.3` — catalog React `19.2.8` OK     |
| `@types/three`       | 0.186.0 | devDependency, matches `three`                          |

## Open questions handed to the core phases

- Parameter model needs expressions/units beyond a single `number` kind; `ParamSpec` is deliberately a closed union waiting for more kinds.
- `get(name)` string keys want branded feature IDs (Phase 3) to prevent typos reaching the kernel.
- Transport needs cancellation and result-versioning beyond effect-local `cancelled` flags once evaluation is slower.
- The settle stamp (`data-cad-rendered-volume`) is a page-level convention; the cad-r3f package should own an equivalent readiness signal instead of the app reaching into `useFrame`.
