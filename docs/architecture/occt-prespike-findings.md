# Phase 21 Pre-Spike — OpenCascade Binding Findings

_Executed 2026-09-15, on branch `phase-20-feature-history`, before any OCCT adapter code was written (the plan's binding pre-spike mandate). All hands-on results were produced in a scratch project outside the repo (`/tmp/occt-probe`, deleted after); the repo tree was not modified and no dependency was added. Every claim below is marked **[probed]** (I ran it — script and environment described) or **[cited]** (link). Claims I could not verify are listed under "Unknowns handed to 21.1–21.5"._

**Probe environment**: Node v24.21.0, Linux x64 (fc44), `replicad-opencascadejs@1.1.0` installed from npm into a standalone project; Manifold comparison run against the repo's own `manifold-3d@3.5.3` (imported read-only from the repo's `node_modules`, nothing in the repo touched).

---

## 1. Package health — `replicad-opencascadejs`

**Verdict: actively maintained, satisfies the plan's mandate; adopt `1.1.0`.**

- Current version `1.1.0`, published 2026-09-04 — 11 days before this spike [cited: [npm](https://www.npmjs.com/package/replicad-opencascadejs), `npm view` output probed]. Release cadence: `0.20.2` 2025-09-19, `0.21.0` 2026-03-06, `0.22.0` 2026-03-24, `0.23.0` 2026-04-03, `1.0.0` 2026-08-14, `1.1.0` 2026-09-04.
- Author Steve Genoud (`sgenoud`), the author of replicad itself. The package has no `repository` field, but the source is public inside the replicad monorepo at `sgenoud/replicad/packages/replicad-opencascadejs` (commit `e4b05f6` "v1.1.0" matches the npm tarball's `gitHead` exactly) [probed: cloned `sgenoud/replicad@main` and diffed `package.json` metadata against the npm tarball]. The old standalone GitHub path 404s because the project moved into the monorepo.
- Relation to the excluded upstream: it does **not** depend on the dormant npm `opencascade.js` (donalffons) package at all. The build runs `ghcr.io/taucad/opencascade.js:canary-ebd263f1-single-threaded` — the TauCAD fork of donalffons/opencascade.js, which tracks **OCCT 8.0.1** with an active v3-line release [cited: [taucad/opencascade.js](https://github.com/taucad/opencascade.js); build script probed in the cloned build source]. The wasm binary itself contains `Open CASCADE 8.0` / `Open CASCADE STEP translator 8.0` version strings [probed: `strings` on `dist/replicad_single.wasm`]. So: binding = replicad-opencascadejs (maintained) → build toolchain = TauCAD opencascade.js fork (maintained) → kernel = OCCT 8.0.x. The plan's exclusion of upstream `opencascade.js` is respected at every layer.
- Package shape: `"type": "module"`, ESM default-export factory + CJS shim; zero runtime dependencies; exports map exposes `.` (single-thread build), `./wasm` (the single-thread `.wasm`), `./multi`, `./multi/wasm`, `./package.json` [probed: tarball `package.json`].
- License `LGPL-2.1-only` (see §7 for implications).
- Fallback per plan: `occt-import-js` latest `0.0.23`, last published 2024-12-03 — dormant, import-only [cited: [npm](https://www.npmjs.com/package/occt-import-js)]. Relevant only as an IGES-import fallback for 21.5 (see §5).

## 2. Node loading, round trip, size, timing, memory — all probed

**WASM init pattern.** Exactly the modern emscripten MODULARIZE shape the Manifold spike documented, so the established runtime pattern carries over:

```ts
import init from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url"; // browser only

const oc = await init({ locateFile: () => wasmUrl }); // Promise<OpenCascadeInstance>
```

- `init` is an async factory (`async function Module(moduleArg = {})`) that returns a promise of a fully populated instance [probed: ran it; signature in shipped `replicad_single.d.ts` line ~33882].
- WASM resolution: `locateFile("replicad_single.wasm", scriptDirectory)` if provided, else `new URL("replicad_single.wasm", import.meta.url)` — same fallback that breaks under Vite dep optimization, so the `?url` + `locateFile` pin is required in the browser (identical discipline to `manifold-worker.web.ts`) [probed: source inspection + Node run with default resolution works, no `locateFile` needed under Node].
- The instance exposes `oc.FS` (emscripten virtual filesystem — the sanctioned way to pass file paths to STEP readers/writers) and `oc.wasmMemory` (live `WebAssembly.Memory`; the shipped types explicitly warn to take fresh `HEAP*` views after any allocation, because growth detaches cached views) [probed + d.ts doc text].

**Box → subtract → volume/bounds/tessellation round trip** (30×20×10 box, ⌀8 through-cylinder at (15,10) — the spike's plate-with-hole):

- `BRepPrimAPI_MakeBox(30,20,10).Shape()`, `BRepPrimAPI_MakeCylinder(4,20)` (rests on z=0, +z axis — matches the contract's footing), translated via `gp_Trsf.SetTranslation` + `BRepBuilderAPI_Transform(shape, trsf, copy, copyMesh)`, `BRepAlgoAPI_Cut(a,b).Shape()`.
- Volume via `BRepGProp.VolumeProperties(shape, props, true, false, false)` → `props.Mass()` = **5497.345175 mm³ vs analytic 5497.345175 — relative error 0.00e+0** (exact BREP integration, not mesh quadrature). Manifold on the same workload reports 5501.553108 (+0.076%) [probed].
- Bounds via `BRepBndLib.AddOptimal(shape, box, false, false)` → exactly `[0,0,0]–[30,20,10]` [probed].
- Topology: `TopExp_Explorer` finds 7 faces / 30 edges / 60 vertices; `TopoDS_Shape.IsSame` works; 7/7 distinct face hashes (§4) [probed].
- Tessellation: `ReplicadMeshExtractor.extract(shape, 0.1, 0.5, false)` → 130 verts / 120 tris / 130 normals / 7 face groups in 10.6 ms; independent `BRepMesh_IncrementalMesh(shape, 0.1, false, 0.5, false)` + per-face `BRep_Tool.Triangulation` works (needs `TopoDS.Face(shape)` downcast — passing a raw `TopoDS_Shape` throws a `BindingError`, which is catchable) [probed].

**Size and speed vs Manifold** (same machine, same workload; Manifold numbers from the repo's `manifold-3d@3.5.3`):

| Metric                          | Manifold 3.5.3              | replicad-opencascadejs 1.1.0 (single) | Ratio |
| ------------------------------- | --------------------------- | ------------------------------------- | ----- |
| WASM size                       | 541,470 B (~529 KiB)        | 22,980,267 B (~21.9 MiB)              | ~42×  |
| JS glue                         | 74,762 B                    | 60,124 B (+ 1.6 MB `.d.ts`)           | —     |
| Init (Node, cold)               | 11.6 ms                     | 176–181 ms                             | ~16×  |
| Heap after init                 | small (growable)            | 100 MB (preallocated linear memory)    | —     |
| box+cyl+move+cut+volume+mesh    | 1.01 ms/op                  | 5.23 ms/op                             | ~5×   |
| Boolean volume vs analytic      | +0.076% (mesh divergence)   | exact (0 rel err)                      | —     |

The 100 MB initial heap is the most consequential number for the browser worker: the memory is *preallocated at init* (heap stayed exactly 100.0 MB through the whole probe including a 200-boolean pressure loop, in both dispose and no-dispose variants — it did not grow, but it also never shrinks below its starting point) [probed]. `wasmMemory.maximum` is unset (unbounded growth potential) [probed].

**Determinism** [probed]: two independent build+mesh runs in one process produced byte-identical position/index buffers and identical volumes. Cross-process hash stability was not measured (see Unknowns).

**Degenerate/empty semantics** [probed] — materially different from Manifold, the adapter must own these:

- Negative box dims: OCCT does **not** throw and does **not** return an empty solid — `MakeBox(-1,2,3)` silently builds the 1×2×3 box (volume 6). The adapter's `invalidLength` validation is load-bearing, not defensive polish.
- `NaN` dims: no throw either (same silent treatment).
- Disjoint `BRepAlgoAPI_Common`: not null, volume 0, mesh 0 verts/0 tris — maps cleanly onto the contract's empty-solid semantics (`volume` → 0, `tessellate` → empty soup; `bounds` must map to `kernel/bounds-empty` via a void/empty `Bnd_Box` check).
- Null handle into an algorithm: throws a **catchable** JS `BindingError`-family exception ("null is not a valid TopoDS_Shape"). No process abort was observed in any test; the no-throw operation boundary pattern from `manifold-kernel.ts` transfers directly.
- `BRepTools.Read` (file-based native BREP import) is **not callable** from JS in this build: its `BRep_Builder&` parameter is unbound (emitted as `unknown`), and the binding's own overload-error path crashes with an opaque `TypeError` [probed exhaustively with several argument shapes]. The string-based `BRepToolsWrapper.Read/Write` is the working alternative (§5).

## 3. Browser / worker viability

**Verdict: statically sound; Vite bundling proven end-to-end; runtime execution in a real browser is the one thing left for 21.2.**

- The shipped `replicad_single.js` is an emscripten ES-module build with explicit environment branches: Node (`createRequire`/`fs`), browser main thread (`fetch`), worker scope (`XMLHttpRequest` synchronous) [probed: source inspection]. The **single-thread build contains zero `SharedArrayBuffer`/`pthread`/`Atomics` references** — no COOP/COEP, consistent with the single-threaded determinism stance; the `./multi` export is the pthreads build (7 references, spawns `em-pthread` workers) and is not needed [probed: grep of both builds].
- Vite proof [probed: `vite build` 7.3.6, `build.target: esnext`, entry + module worker both importing the package]: emits the hashed wasm as a static asset (`dist/assets/replicad_single-B_1cTsn_.wasm`, exactly 22,980,267 B, emitted once, shared by both chunks), a main chunk and a worker chunk, both referencing the asset through the `?url` import handed to `locateFile`. The only warning is `Module "node:module" has been externalized for browser compatibility` — the same harmless warning the Manifold spike already characterized. The exports map's `./wasm` subpath makes the `?url` import legal (mirroring `manifold-3d/manifold.wasm?url`).
- What 21.2 must still verify (honestly: not verified here): actual instantiation inside a real browser worker (the wasm is 23 MB — worker boot cost on slow networks, `WebAssembly.compile` behavior under SwiftShader-adjacent environments), and the emscripten worker-scope sync-XHR fallback path never engaging (it should not, since `locateFile` returns the hashed URL). The existing `hostManifoldWorker` composition (transport + runtime + `createWorkerServer`) is kernel-agnostic and an OCCT twin slots in without protocol changes — the buffering-until-subscribed pattern in `manifold-worker.web.ts` exists precisely because WASM boot is async, and OCCT's slower boot (~180 ms Node; unknown but certainly slower in-browser) makes that buffering more, not less, relevant. `init()` was called twice in one Node process without conflict [probed], so a per-worker instance is fine.

## 4. API surface mapped to the kernel contract

All [probed] against the shipped `replicad_single.d.ts` (441 top-level exports; statics present — e.g. `BRepGProp.VolumeProperties`, `BRepBndLib.Add/AddOptimal`) unless noted.

| Contract operation | OCCT binding | Notes |
| --- | --- | --- |
| `createBox` | `BRepPrimAPI_MakeBox(dx,dy,dz).Shape()` | min-corner-at-origin footing matches the contract natively. |
| `createSphere` | `BRepPrimAPI_MakeSphere(R).Shape()` | centred at origin, as contracted. |
| `createCylinder` | `BRepPrimAPI_MakeCylinder(R,H).Shape()` | rests on z=0, +z axis — exact contract footing, no re-placement. |
| `createCone` | **no `BRepPrimAPI_MakeCone` in this build** | Only `gp_Cone`/`GeomAbs_Cone` types exist. Cone/frustum must be composed (e.g. revolve a line profile with `BRepPrimAPI_MakeRevol`, or a lofted/thru-section route); `BRepPrimAPI_MakeRevol` and `BRepPrimAPI_MakePrism` are bound. This is adapter work with an exactness question to settle (see Unknowns). |
| `union` / `subtract` / `intersect` | `BRepAlgoAPI_Fuse/Cut/Common(S1,S2).Shape()` | Pairwise constructors; n-ary composition is adapter-side (OCCT also has `BRepAlgoAPIBuilder`-style general fuse via unbound internals — not in this build [probed: absent from d.ts]). |
| `transform` (translation) | `gp_Trsf.SetTranslation` + `BRepBuilderAPI_Transform(shape, trsf, copy, copyMesh)` | proven. |
| **rotation** (new capability) | `gp_Trsf.SetRotation(gp_Ax1, angle)` + `BRepBuilderAPI_Transform` | proven: rotating the plate 45° about z gives exact analytic rotated bounds (±√2-scaled corners), 0.4–0.6 ms. **Contract gap:** `transform`'s input type carries translation only — extending `TranslationInput` is part of 21.1 (the `transformRotation` capability flag exists for exactly this). |
| scale | `gp_Trsf.SetScale`; `BRepBuilderAPI_GTransform` is **not bound** (the w1ne fork exists specifically to add it [cited: [w1ne/replicad-opencascadejs](https://github.com/w1ne/replicad-opencascadejs)]) | uniform scale OK via `gp_Trsf`; non-uniform would need the fork or an upstream request — out of contract scope today. |
| `bounds` | `BRepBndLib.AddOptimal(shape, box, useTriangulation=false, useShapeTolerance=false)` + `Bnd_Box.GetXMin()…/CornerMin()` | exact-geometry path; the `Add` variant inflates by tolerances. `tightBooleanBounds: true` is defensible. |
| `volume` | `BRepGProp.VolumeProperties(shape, props, onlyClosed, skipShared, useTriangulation)` → `GProp_GProps.Mass()` | exact (§2); supports an epsilon-bounded adaptive variant `VolumePropertiesGK` if ever needed. |
| `tessellate` (+normals) | `BRepMesh_IncrementalMesh` + per-face `BRep_Tool.Triangulation`, **or** `ReplicadMeshExtractor.extract` | Both proven. The extractor returns packed `vertices`/`normals`/`triangles`/**`faceGroups`** arrays read directly off `oc.wasmMemory` by ptr+size (copy before any further allocation — the d.ts warns views detach on growth). |
| `dispose` | `.delete()` / `[Symbol.dispose]()` on every bound class | same explicit-free discipline as Manifold; see §7. |

**The BREP layer (Phase 22's `persistentTopology: true`)** [probed]:

- Full `TopoDS_Shape` topology surface: `TopExp_Explorer` (face/edge/vertex/wire/shell/solid/compound enumeration), `TopoDS.Face/Edge/Vertex/Wire/Shell/Solid` downcast helpers, `TopoDS_Shape.IsSame/IsEqual/IsPartner/NbChildren/TShape/Location/Orientation`.
- **Identity/hashing:** `ReplicadShapeHasher.HashCode(shape, upperBound)` — a custom wrapper (source read in the replicad monorepo) implementing `TopTools_ShapeMapHasher{}(shape) % upper + 1`: hash of *TShape + location*, orientation ignored, bounded to `[1, upperBound]`. This is the same identity `IsSame` uses (TShape+location+orientation). The mesh extractors tag every face/edge group with this hash — `faceGroups` triples are `{indexStart, indexCount, faceHash}` and `edgeGroups` `{lineStart, lineVertexCount, edgeHash}` (wrapper source read [cited: `build-config/wrappers/*.cpp` in `sgenoud/replicad`]). So per-face mesh structure *with topology labels* ships out of the box.
- **Modification history:** boolean/transform builders inherit `Generated(S)`/`Modified(S)`/`IsDeleted(S)` from `BRepBuilderAPI_MakeShape` — the raw material for Phase 22's provenance-through-the-feature-graph work (OCCT's classic persistent-naming weakness is that these histories are operation-local, not stable across re-execution; that investigation belongs to Phase 22, not the binding).
- `BRepCheck_Analyzer` (validity), `ShapeUpgrade_UnifySameDomain`, `BRepFilletAPI_MakeFillet`, `BRepOffsetAPI_MakeThickSolid`, `BRepPrimAPI_MakeTorus` are also bound — future capability headroom [probed: d.ts].

## 5. STEP / IGES / BREP surface

- **STEP write** [probed]: `STEPControl_Writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs, true, progress)` + `Write("/path.step")` — path is the emscripten `oc.FS` (memfs); read bytes out with `oc.FS.readFile`. 41 ms / 19,027 B / 434 entities for the plate; header self-identifies as `Open CASCADE STEP processor 8.0`. **Note:** the writer prints a transfer-statistics block to the console by default (OCCT message printer) — worker code will want to mute or capture it.
- **STEP read** [probed]: `STEPControl_Reader.ReadFile(path)` → `NbRootsForTransfer()` → `TransferRoots()` → `OneShape()`. Round trip preserves volume to 3.14e-15 relative and face count exactly (7→7); 62 ms. Unit surface exists (`SetSystemLengthUnit`, `SystemLengthUnit`, `FileUnits`) — mm is the working default here, but unit/name/color metadata preservation (21.3's "preserve supported metadata") needs `STEPCAFControl`/XCAF, and `STEPCAFControl_Writer.cxx` strings exist in the wasm while `STEPCAFControl_*` **classes are not bound** [probed: d.ts]. Names/colors via XCAF are therefore **not reachable** in this build — 21.3 must scope to geometry+units or request upstream bindings.
- **BREP (native OCCT format)** [probed]: `BRepToolsWrapper.Write(shape): string` / `.Read(string): TopoDS_Shape` — string-based, exact round trip (volume identical, faces 7→7). This is the natural 21.5 BREP adapter and a candidate for worker<->main solid serialization (it exists in the build precisely because replicad serialises shapes across its worker). File-based `BRepTools.Write` works but file-based `Read` does not (§2).
- **IGES** [probed]: **no IGES bindings at all** — `IGESControl_Reader/Writer` appear only inside a doc comment; no exported class references IGES (the C++ strings exist in the wasm because STEP toolkit code references them, but nothing is callable). 21.5's IGES import must use the plan's fallback (`occt-import-js`, dormant since 2024-12, import-only, LGPL-2.1 [cited]) or an upstream binding request to replicad-opencascadejs. Plan for IGES accordingly: optional, fallback-scoped.
- **STL** [probed: d.ts]: `StlAPI.Write/Read`, `StlAPI_Reader`, `StlAPI_Writer` are bound — redundant for slopcad (cad-io already owns mesh-format STL) but harmless.

## 6. Integration risks

1. **Memory discipline is stricter than Manifold's.** Every bound class is an emscripten-embind wrapper needing explicit `.delete()`; the heap starts at 100 MB, never shrinks, and can grow unbounded (`maximum` unset). Cached `ArrayBuffer` views detach on growth (the shipped types call this out) — extract-then-copy-immediately is mandatory, exactly like the Manifold adapter's `tessellate` copying out of the WASM heap. The pressure loop (200 booleans) showed no growth either way, but that is a small workload; the 100 MB floor per worker is the real browser cost [probed].
2. **Silent degenerate acceptance.** Negative/NaN dimensions do not fail — they build mirrored/odd geometry (§2). The adapter's input validation is the only line of defence; unlike Manifold, the engine will not rescue it.
3. **Overload binding errors throw catchable JS exceptions** — good — but one path (`BRepTools.Read`) crashes *inside* the binding while formatting its own error. Defensive adapter discipline: only call verified signatures; keep the operation-level no-throw boundary [probed].
4. **Threading:** single-thread build is genuinely pthread-free (determinism-friendly); the multi build needs SAB/COOP-COEP and spawns pthread workers — stay on the default single build [probed].
5. **Determinism:** byte-identical tessellation across independent evaluations in-process [probed]; cross-process/cross-version stability unmeasured (Unknowns). OCCT booleans are not contractually deterministic across OCCT *versions* — pin the package version and treat upgrades as regeneration events.
6. **LGPL-2.1-only.** The repo is MIT. Facts: nothing is published/distributed today (owner stance), so no obligation is currently triggered. When distribution happens: the wasm is a separate dynamically-loaded artifact (its own file, own license), which is the arrangement LGPL is designed for — MIT code + unmodified LGPL wasm fetched/shipped alongside. Keeping the wasm **unmerged/unminified** as a distinct asset (which Vite already does) preserves the user's right to replace it. The OCCT upstream itself adds an LGPL exception text; this package declares plain `LGPL-2.1-only` [probed: LICENSE in tarball]. Note it in the eventual distribution decision; no code impact now.
7. **Console noise:** STEP transfer statistics print by default (§5) — mute in worker hosting.
8. **Worker protocol fit:** no OCCT-specific hazards found. The Phase 10.x stack (transports, server, cancellation ledger, solid-id mapping) is generic over `GeometryKernel`; the OCCT adapter is just another `GeometryKernel` plus a `hostOcctWorker` twin of `hostManifoldWorker`. OCCT's async boot is slower (176–181 ms Node init), which the existing buffer-until-subscribed worker entry already handles.

## 7. Cross-kernel notes (Phase 23 comparison suite)

- OCCT justifies `exactPrimitiveVolumes: true`, `exactBooleanVolumes: true` (measured 0.0 relative error on the plate), `tightBooleanBounds: true` (exact analytic bounds incl. rotated bounds), `booleans: true`, `transformTranslation: true` and — once the contract input type grows — `transformRotation: true`; `persistentTopology: true` arrives with Phase 22 on top of the §4 BREP layer.
- The contract suite's `EXACT_VOLUME_TOLERANCE` paths (1e-9) will apply to OCCT boolean volumes — stricter than Manifold's mesh-divergence numbers (+0.076% on the same shape). The comparison suite should expect *kernel-documented differences* exactly here: same shape, different volume bands, by declared capability.
- Meshes differ structurally (OCCT 120 tris vs Manifold 128 tris on the plate at comparable settings) — the contract already forbids buffer equality, so only semantic comparison applies. OCCT normals come per-face-group with crease-exact planar normals (first face normal `[-1, 0, 0]`, exactly axial) — the crease-splitting behaviour Manifold's `calculateNormals(0, 30)` approximates.
- Cones: until the composition route is settled (§4), cone fixtures for the comparison suite should be treated as potentially kernel-divergent in tessellation but not volume.

## Recommended package layout

Follow the Manifold package's shape exactly — `packages/cad-kernel-occt` mirroring `packages/cad-kernel-manifold`:

```
packages/cad-kernel-occt/
  package.json            # deps: @slopcad/cad-core, @slopcad/cad-kernel, replicad-opencascadejs@1.1.0
  src/
    occt-backend.ts       # OCCT_BACKEND_ID (backend-ids.ts grows one entry)
    occt-runtime.ts       # init() memoized per JS context; opaque branded OpenCascadeInstance handle
    occt-kernel.ts        # GeometryKernel over TopoDS_Shape payloads in a createSolidTag store
    occt-fixtures.ts      # same fixtures as manifold-fixtures for cross-kernel runs
    occt-worker.ts        # hostOcctWorker (twin of manifold-worker.ts)
    occt-worker.web.ts    # ?url + locateFile pin; buffer-until-subscribed (copy the pattern verbatim)
    occt-worker.node.ts / node-occt-worker.ts
    occt-wasm-url.d.ts    # vite/client ?url module declaration for "replicad-opencascadejs/wasm?url"
    index.ts              # no OCCT type crosses this surface
```

Key adaptations vs Manifold (from these findings): the runtime options take `locateFile` the same way; the kernel's per-handle payload is a `TopoDS_Shape` (dispose = `.delete()`); empty-solid detection is volume-0/void-box based (`IsNull()` is *not* the empty-solid test — disjoint booleans return non-null empty shapes); length validation is load-bearing before any constructor call; `tessellate` uses `ReplicadMeshExtractor` and copies out of `oc.wasmMemory.buffer` immediately. STEP/IGES/BREP import-export code (21.3–21.5) lives in this package too, behind kernel-neutral types, with file bytes ferried through `oc.FS` — the existing cad-io package stays the home of mesh formats and can host STEP once the OCCT-side codec is kernel-neutral.

## Dispatch-shaping recommendations

- **21.1** can be dispatched as written; add to its scope: (a) the contract's `transform` input extension for rotation (the capability flag already exists), (b) cone composition strategy (profile revolve vs loft) with an exactness note, (c) empty-solid detection via measurement (not `IsNull`). Validation-first adapter discipline (§6.2) should be called out in the phase brief.
- **21.2** scope note: bundling is de-risked by this pre-spike (Vite emits hashed wasm, `./wasm` export path legal); the phase's real work is browser-worker runtime verification, boot-time acceptance (~23 MB fetch + ~180 ms class init; consider lazy/optional loading since OCCT is optional), and muting OCCT console printers. No protocol changes are expected.
- **21.3** scope note: geometry+units import is fully supported; XCAF names/colors are *not bound* — the "preserve supported … name/color metadata" requirement must be scoped to what the binding exposes (units, body/topology counts) or the phase must first land an upstream binding request (replicad-opencascadejs is actively maintained; the wrappers show such requests are how the surface grows). Distinguish-imported-vs-parametric is application-layer, unaffected.
- **21.4**: STEP export via `STEPControl_Writer` proven; "most appropriate STEP AP" = `STEPControl_AsIs` (AP203/AP214 selection surface: `Interface_Static` is bound for schema parameters — verify per-setting during the phase).
- **21.5**: BREP via `BRepToolsWrapper` string round-trip is proven and cheap. IGES has **no binding** — dispatch as the plan's fallback decision (occt-import-js import-only, or defer pending upstream), not as a from-scratch certainty.
- **Phase 23 comparison suite**: plan for capability-branched volume assertions now (exactness paths apply to OCCT) and per-kernel tessellation divergence as documented-difference, not failure.

## Unknowns handed to 21.1–21.5

- Cross-process and cross-version determinism of OCCT meshes/hashes (measured in-process only). Relevant to screenshot determinism once OCCT feeds the renderer.
- Whether OCCT's face hashes are stable across *equivalent rebuilds with different operand order/history* (persistent-naming question — Phase 22's core investigation, not decidable in a pre-spike).
- Exact browser init cost on throttled networks/low-end hardware; whether `WebAssembly.compile` streaming or plain instantiate applies in the TanStack Start deployment (21.2).
- Cone composition route (MakeRevol profile vs alternative) and whether its volume/bounds exactness matches primitive-grade expectations (21.1).
- `Interface_Static` STEP schema/unit parameter surface behavior in this build (21.3/21.4 detail; methods are bound, values untested).
- Whether an upstream request can bind `STEPCAFControl_*` (names/colors) and `IGESControl_*` (IGES) — and its latency (21.3/21.5).
- Multi-instance `init()` in one JS context was observed to work [probed], but whether instances share underlying state (besides each allocating 100 MB) was not investigated.
- SIMD usage of the wasm was not determined (no feature-section string found; irrelevant to correctness, possibly relevant to browser performance comparisons).

---

# Addendum — 21.5 execution probes (BREP adapter + the IGES fallback decision)

_Executed 2026-09-15 during Phase 21.5's implementation, same probe discipline as above: all hands-on results produced in a scratch project outside the repo (`/tmp/occt-215-probe`, deleted after); claims marked **[probed]** were run against the repo's own pinned `replicad-opencascadejs@1.1.0` and a fresh npm install of `occt-import-js@0.0.23`._

## BREP (the `BRepToolsWrapper` string path, probed for the adapter)

- **String form contents** [probed]: pure ASCII (zero non-ASCII chars across every probe), opening with a leading blank line and `CASCADE Topology V3, (c) Open Cascade`, then the location/curve/surface/TShape tables. 3,703 bytes for the plate-with-hole — pure BREP, no triangulation payload.
- **Determinism — NO neutralizer exists** [probed]: the same shape written twice in one process (with unrelated exports interleaved) is byte-identical, and two independent Node processes produce byte-identical files (`cmp`-verified). No timestamp, no counter, no date-shaped text anywhere in the output. The 21.5 exporter therefore does no post-processing; cross-process byte-identity is pinned by tests against the committed fixture (`packages/cad-kernel-occt/fixtures/plate-with-hole.brep`, written by a fixture script in another process).
- **Multi-shape** [probed]: `Write` takes ONE shape (the format's canonical single-shape form). A `TopoDS_Compound` built with `TopoDS_Builder.MakeCompound`/`Add` (both bound in this build) round-trips with solid order and per-solid volumes preserved; `Read` hands back a top-level COMPOUND even for a written SOLID, so solid-extraction by `TopAbs_SOLID` exploration handles single and compound files symmetrically.
- **Round-trip fidelity** [probed]: volume relative error 3.3e-16 (ASCII decimal doubles re-parse at last-ulp rounding), `AddOptimal` bounds exactly equal, topology counts identical (7/30/60) — well inside the contract suite's 1e-9 exact band.
- **Malformed inputs** [probed]: `Read` NEVER throws — empty string, garbage text, header-only, truncated valid text, and binary junk all return a NULL shape (`IsNull() === true`), printing reader diagnostics to stdout (the documented binding-stdout stance). The adapter's taxonomy: `empty` / `malformed` (no CASCADE Topology header) / `truncated` (header text → null shape) / `no-solids`.
- **No filesystem involvement** [probed, by construction]: the string API bypasses `oc.FS` entirely — the STEP codec's unlink discipline has no work here, and no malformed input can leak filesystem state.

## IGES fallback probe (`occt-import-js`) and the decision

**Decision: the plan's dormant fallback is VIABLE for import; adopted as an import-only, mesh-level module (`packages/cad-kernel-occt/src/occt-iges-import.ts`), kept optional beside the primary binding.**

Facts behind the decision [probed, unless cited]:

- Package: `occt-import-js@0.0.23`, last published 2024-12-03 (dormant — exactly as the plan designated it), LGPL-2.1, ZERO runtime dependencies, CJS main + 7.3 MB emscripten wasm; no TypeScript declarations shipped (the adapter's `src/occt-import-js.d.ts` declares the consumed surface).
- Node init: the MODULARIZED factory resolves in ~37 ms cold with default asset resolution (no `locateFile` needed under Node); the standard `locateFile` hook exists for the browser pin [probed in the d.ts-free glue: one `locateFile` reference].
- Real IGES read: `ReadIgesFile(bytes, null)` on its own test fixture (a 10 mm Inventor cube) returns `success: true` with one named mesh ("Solid1", 6 `brep_faces`, 24 vertices / 12 triangles, normals included) and a product-hierarchy root — in ~73 ms.
- Determinism: two reads of the same bytes produce deep-equal JSON results [probed].
- Malformed inputs: empty, garbage, and truncated IGES all answer `success: false` with NO throw [probed] — a total reader at the boundary.
- The honest scope boundary: the engine yields MESHES, never OCCT shapes — its wasm does not expose the shape layer. The adapter's payload therefore mirrors cad-io's mesh-import provenance (`origin: "imported-iges"`, a soup with a name), NOT the OCCT-solids discipline of STEP/BREP import; nothing behind it mints a kernel solid or answers a `GeometryKernel` operation, and the /io wiring runs it on the MAIN THREAD like the STL importer rather than through the worker protocol (whose import operations exist to mint session solids).
- Fixture: the committed `fixtures/cube-10mm.igs` is adopted verbatim from the package's own LGPL-2.1 test suite (`test/testfiles/cube-10x10mm/Cube 10x10.igs`, header self-describes Autodesk Inventor 2019 and `2HMM` units) — no IGES writer exists in either binding, so a real third-party file is the honest fixture; its extents read back exactly 10 mm in the library's default (and this repo's canonical) millimetre unit.
- New dependency disclosure: `occt-import-js@0.0.23` added to `packages/cad-kernel-occt` only, knip-disclosed in `knip.json`'s `ignoreDependencies` beside `replicad-opencascadejs`.
