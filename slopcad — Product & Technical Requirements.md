# slopcad

## A composable parametric CAD platform for TypeScript and React

**Working name:** slopcad  
**Repository:** existing Better-T-Stack monorepo  
**Frontend:** existing TanStack Start application  
**UI package:** `packages/ui`  
**Modeling stack:** TypeScript + pluggable geometry kernels  
**Primary renderer:** Three.js / React Three Fiber  
**Testing:** TDD + Vitest + Playwright + screenshots + videos  
**Distribution:** npm packages + shadcn registry — nothing is published until the owner explicitly decides; pre-release consumer testing uses locally generated registry artifacts
**License:** MIT
**CI policy:** none, ever — quality gates are local commands (fleet test-alignment policy)
**Backend:** present in repository for future profiles/projects/persistence; explicitly out of CAD-core scope — the server never computes or renders CAD geometry

---

# 1. Executive summary

slopcad is a developer-first parametric CAD framework for the web.

Its purpose is to let a developer build something CAD-like using technologies and mental models they already understand:

```text
TypeScript
React
React Three Fiber
shadcn
npm packages
```

The central idea is not to make React "draw CAD".

The central idea is to provide a proper parametric CAD domain model that can be consumed by React.

The resulting stack is:

```text
                    ┌──────────────────────────┐
                    │     Consumer Application │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ React integration         │
                    │ components + hooks        │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Parametric CAD domain     │
                    │                          │
                    │ document                 │
                    │ parameters              │
                    │ expressions              │
                    │ feature graph            │
                    │ selection                │
                    │ tools                    │
                    │ history                  │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │ Kernel abstraction        │
                    └───────┬────────┬─────────┘
                            │        │
                       Manifold    OCCT
                       JSCAD      future...
                            │        │
                            └───┬────┘
                                │
                         tessellation /
                         topology DTOs
                                │
                    ┌───────────▼─────────────┐
                    │ Three.js / R3F          │
                    └─────────────────────────┘
```

The UI is then another layer:

```text
headless state + tools
          ↓
shadcn components
          ↓
registry
```

This makes the project useful both as:

1. a library for developers embedding CAD functionality, and
2. a foundation for building a complete browser CAD application.

---

# 2. Why this should exist

The current ecosystem has most of the individual ingredients, but they are fragmented.

## JSCAD

JSCAD provides a mature procedural JavaScript CAD model and a strong CSG vocabulary.

Its React integration already exists through `jscad-fiber`, which demonstrates declarative React components backed by JSCAD primitives, booleans and transforms.

The missing layer is a richer parametric document/feature abstraction.

---

## Replicad

Replicad demonstrates that OpenCascade can be wrapped into a browser-friendly TypeScript library and then used to build viewers, editors and configurators. Its documentation explicitly describes Replicad as a library intended to be built upon, and recommends worker execution for model computation.

Its current source also provides direct STEP and STL import/export capabilities.

The lesson is:

> The CAD kernel can be hidden successfully behind a developer-facing API.

---

## build123d / CadQuery

These projects are particularly useful as API references.

CadQuery's workplane model, selectors, construction geometry and fluent operations provide excellent examples of how procedural modeling can remain expressive while enabling geometry-relative feature placement.

build123d goes further with both algebra and builder APIs and explicitly treats compositional Python as the modeling language.

This suggests slopcad should support both:

```ts
const result = subtract(box(...), cylinder(...))
```

and eventually:

```ts
const part = buildPart(() => {
  ...
})
```

without forcing either style on users.

---

## OneCAD

OneCAD is an especially useful architecture reference.

It explicitly separates frontend React/Three.js from a domain/regeneration layer and an OCCT worker, and defines a normative protocol with projection DTOs and cross-layer tests. It also has first-class Playwright E2E tests.

This validates several design decisions for slopcad:

```text
domain != renderer
kernel != frontend
protocols/contracts matter
E2E is part of correctness
```

We should borrow those ideas without inheriting OneCAD's desktop/Tauri/Rust architecture.

---

## Tau

Tau is the strongest strategic warning and inspiration.

It currently combines:

- React
- React Three Fiber
- shadcn
- Manifold
- JSCAD
- OpenCascade.js
- OpenSCAD WASM
- glTF-Transform
- Assimp
- parametric editing
- multiple kernels
- embeddability

and explicitly positions itself as kernel agnostic.

Therefore slopcad should **not** compete by trying to build a bigger CAD application.

The opportunity is lower-level:

> **Be the framework people use to build their own Tau-like applications.**

---

# 3. Product thesis

The fundamental unit is not a mesh.

It is not a Three.js object.

It is not a kernel object.

It is:

> **a parametric feature in a persistent document graph.**

Everything else is derived from that.

Example:

```ts
const width = param("width", mm(100));

const body = feature("body", () =>
  box({
    width,
    height: mm(50),
    depth: mm(20),
  }),
);

const hole = feature("hole", ({ refs }) =>
  subtract(
    refs.body,
    cylinder({
      radius: mm(4),
      height: mm(30),
    }),
  ),
);
```

This should produce a document graph approximately like:

```text
width
  │
  ▼
body
  │
  ▼
hole
  │
  ├── geometry
  ├── topology
  └── render projection
```

Changing `width` invalidates downstream features.

---

# 4. Core principles

## 4.1 Core is framework independent

`@slopcad/core` must not import:

- React
- Three.js
- R3F
- DOM APIs
- browser-only APIs
- a specific kernel

It should be possible to run all core tests in Node.

---

## 4.2 Renderer independence

R3F is the primary renderer.

It must not be the only possible renderer.

The CAD core produces geometry/projection information that can theoretically be consumed by:

```text
Three.js
R3F
Canvas 2D
SVG
headless renderer
native renderer
```

---

## 4.3 Kernel independence

Public APIs must never expose:

```text
Manifold
TopoDS_Shape
JSCAD geometry objects
OpenCascade handles
```

The kernel is an implementation detail.

---

## 4.4 UI independence

CAD functionality should work without our UI.

A developer can build:

```tsx
<MyCustomToolbar />
<MyCustomParameterEditor />
<CadViewport />
```

instead of using the provided shadcn components.

---

## 4.5 Copyable UI

Our UI should follow shadcn's source-distribution model.

The consumer installs CAD components and owns the resulting source.

Modern shadcn registries can distribute not only UI components but hooks, utilities, pages, configuration and other source artifacts.

This is a major part of the product.

---

# 5. Repository structure

The Better-T-Stack application is already scaffolded and is explicitly out of scope.

The CAD architecture should be layered onto the existing monorepo.

Recommended target structure:

```text
apps/
  <existing-web-app>/
  <existing-server-app>/

packages/
  ui/

  cad-core/
  cad-document/
  cad-expression/
  cad-units/
  cad-kernel/
  cad-kernel-manifold/
  cad-kernel-jscad/
  cad-kernel-occt/

  cad-react/
  cad-r3f/
  cad-tools/
  cad-sketch/
  cad-constraints/

  cad-io/
  cad-io-stl/
  cad-io-3mf/
  cad-io-step/
  cad-io-iges/
  cad-io-gltf/
```

Some of these should start empty/nonexistent and be introduced only when needed.

---

# 6. `packages/ui`

This is the canonical UI package.

It contains two related things.

## 6.1 Runtime UI

Existing shadcn components remain available:

```text
button
dialog
dropdown-menu
input
popover
select
slider
tabs
tooltip
...
```

These remain generic.

(The existing setup is shadcn on Base UI primitives (`@base-ui/react`, style `base-lyra`) — component specs should reference these actual primitives, not Radix.)

---

## 6.2 slopcad components

CAD-specific components are added alongside them.

Initial candidates:

```text
cad-viewport
cad-toolbar
cad-tool-button
cad-model-tree
cad-feature-tree
cad-property-panel
cad-parameter-panel
cad-parameter-input
cad-expression-input
cad-unit-input
cad-selection-indicator
cad-status-bar
cad-command-menu
cad-workbench
```

Later:

```text
cad-sketch-toolbar
cad-constraint-toolbar
cad-measurement-panel
cad-history-timeline
cad-section-controls
cad-view-cube
cad-navigation-toolbar
cad-feature-dialog
cad-export-dialog
cad-import-dialog
```

---

# 7. Registry architecture

`packages/ui` remains the source of the actual component implementation.

The registry should be a separate distribution concern.

Example concept:

```text
packages/ui/
  src/
    components/
      button.tsx
      ...
      cad/
        cad-viewport.tsx
        cad-model-tree.tsx
        cad-parameter-panel.tsx

    registry/
      registry.json
      ...
```

Whether the generated registry artifacts live in the package or a build directory should be decided during the registry spike.

The important rule is:

> **There is one authoritative implementation, and registry packaging is generated from it rather than maintaining an unrelated duplicate implementation.**

Current shadcn supports a source registry, modular `include` files, generated registries, namespaces, and GitHub registries.

Registry items should declare their dependencies explicitly.

For example:

```json
{
  "name": "cad-parameter-panel",
  "type": "registry:ui",
  "registryDependencies": ["label", "input", "separator"],
  "dependencies": ["lucide-react"]
}
```

The local registry gate (no CI — owner policy) should run:

```bash
shadcn registry validate ...
```

and an actual consumer install test. Note: `registry build` is no longer a subcommand — generation is the top-level `shadcn build`. Nothing is published anywhere until the owner explicitly decides; consumer testing uses locally generated registry artifacts.

The shadcn CLI now also supports direct public GitHub registries, so we can offer both:

```bash
pnpm dlx shadcn@latest add slopcad/slopcad/cad-viewport
```

and a namespaced hosted registry:

```bash
pnpm dlx shadcn@latest add @slopcad/cad-viewport
```

once infrastructure is ready.

---

# 8. The domain model

The domain model is the real heart of the project.

Initial concepts:

```text
Document
Parameter
Expression
Feature
Body
Geometry
Reference
Selection
Operation
Diagnostic
History
```

---

# 9. Parameters

Parameters are typed domain objects.

Example:

```ts
const width = param({
  name: "width",
  value: 100,
  unit: "mm",
});
```

Properties:

```text
id
name
type
value
unit
expression
visibility
metadata
```

Parameter values can be referenced by other features.

---

# 10. Expressions

Expression support is required early.

Examples:

```text
width / 2
width + 10mm
height * 0.5
sqrt(width^2 + depth^2)
```

V1 grammar (settled):

```text
identifiers    width, holeSpacing
numbers        42, 2.5
unit literals  10mm, 45deg, 2.5in
operators      + - * / % ^
parentheses    ( )
functions      sqrt, min, max, ... (Phase 5 set)
```

No unicode operator sugar — `width^2`, not `width²`. The AST serializes to JSON.

The evaluator must be:

- deterministic
- sandboxed
- serializable
- dependency-aware

Prefer an explicit expression AST over evaluating arbitrary JavaScript.

This is important for:

- persistence
- dependency analysis
- validation
- undo/redo
- collaborative editing later
- server-side execution
- security

---

# 11. Units

All dimensional values must be unit-aware.

Examples:

```ts
mm(10);
cm(5);
m(1);
inch(2);
deg(90);
rad(Math.PI);
```

A canonical internal representation should be chosen.

The public API should permit convenient unit conversion.

No implicit mixing of incompatible dimensions.

Examples:

```text
length + length        valid
length / length        dimensionless
angle + angle          valid
length + angle         invalid
```

---

# 12. Feature graph

Every modeling operation becomes a node.

For example:

```text
Box
Cylinder
Subtract
Fillet
```

Each feature contains:

```ts
interface Feature {
  id: FeatureId;
  name: string;
  type: string;
  inputs: FeatureInput[];
  parameters: ParameterReference[];
  output: FeatureOutput;
  status: FeatureStatus;
  diagnostics: Diagnostic[];
}
```

A feature should never directly embed transient kernel state.

---

# 13. References

References are extremely important.

The system eventually needs references such as:

```text
feature
body
solid
face
edge
vertex
sketch entity
datum plane
```

This is what makes operations like:

```text
extrude selected face
fillet selected edges
create workplane from face
```

possible.

Reference identity must therefore be separated from raw kernel topology.

This is one of the hardest areas of serious parametric CAD and should be treated as a first-class architectural concern rather than postponed indefinitely.

Mesh-era strategy (settled):

```text
Manifold era: transient geometric references only
  - triangles grouped by normal/curvature into synthetic faces
  - valid for the current regeneration, never persisted
OCCT era:     persistent references over real BREP faces/edges
capabilities: persistentTopology: false advertised by Manifold
```

---

# 14. Regeneration

The initial regeneration algorithm can be simple.

```text
change parameter
       ↓
find affected features
       ↓
recompute in topological order
       ↓
validate outputs
       ↓
generate render projection
       ↓
publish update
```

At first:

```text
recompute all downstream features
```

Later:

```text
incremental invalidation
memoization
parallel feature evaluation
```

Correctness has priority over optimization.

---

# 15. Transactions

Document mutations should happen through commands/transactions.

Example:

```ts
document.transact((tx) => {
  tx.setParameter(width, mm(120));
});
```

Benefits:

- undo
- redo
- change history
- batching
- persistence
- future collaboration
- E2E determinism

---

# 16. Commands

Commands should be serializable whenever practical.

Example:

```ts
{
  type: "parameter.set",
  parameterId: "...",
  value: 120
}
```

Eventually:

```text
document command
       ↓
state transition
       ↓
regeneration
       ↓
projection update
```

This architecture is useful later for:

- client-side remote-tool/AI execution through the client command bus (the server never executes documents)
- collaboration
- replay
- telemetry
- AI commands
- deterministic testing

OneCAD's emphasis on a normative protocol and replayable cross-layer fixtures reinforces the value of this boundary.

---

# 17. Geometry kernel abstraction

The first interface should be intentionally small.

```ts
interface CadKernel {
  createBox(...)
  createSphere(...)
  createCylinder(...)
  createCone(...)

  union(...)
  subtract(...)
  intersect(...)

  transform(...)

  getBounds(...)
  getVolume(...)

  tessellate(...)
}
```

Additional capabilities must be discoverable:

```ts
kernel.capabilities;
```

Example:

```ts
{
  booleans: true,
  fillet: false,
  shell: false,
  brep: false,
  step: false,
  nurbs: false,
}
```

This allows the application to adapt its tools.

---

# 18. First kernel: Manifold

Manifold should be the first production kernel.

Reasons:

- JS/TS/WASM distribution
- robust manifold boolean operations
- browser suitability
- Apache-2.0 license
- direct npm package
- active development
- existing 3MF/glTF-oriented ecosystem

The current package is `manifold-3d`; its WASM package also contains a `manifold-cad` CLI/runtime and worker bundle.

Important caveat:

> Manifold is fundamentally a triangle-mesh solid geometry system, not an OCCT-style analytic BREP kernel.

Therefore:

```text
Manifold = excellent early engine
OCCT = advanced engineering backend
```

Do not force Manifold to become OCCT.

---

# 19. JSCAD kernel adapter

Provide a JSCAD adapter later.

This is useful for:

- compatibility
- procedural modeling
- comparison testing
- migration
- familiarity for OpenSCAD/JSCAD users

`jscad-fiber` demonstrates the existing JSCAD + React Three Fiber integration pattern.

---

# 20. OpenCascade adapter

OpenCascade is the strategic advanced backend.

Use it for:

```text
STEP
IGES
BREP
NURBS
advanced topology
fillet
chamfer
shell
sweep
loft
```

OCCT is LGPL 2.1 with an additional exception, and its official documentation explicitly calls out the obligations of linking applications.

That makes the clean package boundary particularly important.

The OCCT adapter should be optional so that:

```bash
pnpm add @slopcad/kernel-occt
```

is a conscious dependency.

Do not make an OCCT dependency leak into every application.

---

# 21. Worker architecture

Kernel execution should be asynchronous.

Target:

```text
main thread
    │
    │ commands
    ▼
cad worker
    │
    ├── parameter evaluation
    ├── feature regeneration
    ├── kernel
    └── tessellation
    │
    ▼
projection DTO
    │
    ▼
R3F
```

Initially a standard Web Worker abstraction is sufficient.

Later, kernels that need shared-memory parallelism can opt into more specialized worker behavior.

Emscripten currently provides both pthreads and a Wasm Workers API; the latter is specifically designed around browser Worker semantics and shared WebAssembly memory.

Don't architect the entire product around `SharedArrayBuffer` on day one.

Make the transport abstract.

Settled decisions for this architecture:

```text
domain          document, parameters, expressions, feature graph and
                regeneration all execute client-side in the worker;
                the main thread is a command/projection client
server          never computes or renders geometry
AI              future integration acts through the client command bus
                (like a tool in a coding harness), never server-side
transport       in-memory first; flipping to a real worker changes no
                public API
isolation       no SharedArrayBuffer / COOP-COEP requirement now;
                documented future opt-in
```

---

# 22. Render projection

A kernel result should never be rendered directly.

Instead:

```ts
interface RenderProjection {
  objectId: string;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  groups: RenderGroup[];
  bounds: BoundingBox;
}
```

Add optional metadata:

```text
face IDs
edge IDs
body IDs
material IDs
feature IDs
```

This enables robust picking.

---

# 23. React layer

`@slopcad/react` should provide:

```text
CadProvider
useCadDocument
useCadSelection
useCadParameter
useCadTool
useCadHistory
```

and declarative model definitions where useful.

Example:

```tsx
<CadDocumentProvider document={document}>
  <MyApplication />
</CadDocumentProvider>
```

---

# 24. R3F layer

`@slopcad/r3f` contains Three.js/R3F rendering.

Core components:

```tsx
<CadModel model={model} />
<CadSelection />
<CadGrid />
<CadAxes />
<CadOrigin />
<CadGizmo />
```

Viewport itself should be independently composable.

Example:

```tsx
<Canvas>
  <CadScene model={model} />
</Canvas>
```

rather than requiring an entire application shell.

---

# 25. Selection architecture

Selection is not UI state.

It is a domain interaction service.

Types:

```text
FeatureSelection
BodySelection
SolidSelection
FaceSelection
EdgeSelection
VertexSelection
SketchSelection
```

The renderer maps selection targets to Three.js objects.

The application owns selection state.

This keeps tools independent from Three.js.

In the Manifold-only era, face/edge/vertex selection is geometric (region-grouped) and transient — valid for the current regeneration, never persisted as identity.

---

# 26. Tool system

Tools should be headless.

```ts
interface CadTool {
  id: string;
  activate(ctx: ToolContext): void;
  deactivate(ctx: ToolContext): void;
  pointerDown(event): void;
  pointerMove(event): void;
  pointerUp(event): void;
  keyDown(event): void;
}
```

Initial tools:

```text
select
pan
orbit
zoom
measure
move
rotate
scale
```

Later:

```text
extrude
fillet
chamfer
sketch
constraint
pattern
mirror
section
```

---

# 27. Command system

Tools should issue commands rather than mutate documents directly.

Example:

```text
user drags width
      ↓
parameter tool
      ↓
set-parameter command
      ↓
document transaction
      ↓
regeneration
      ↓
projection
      ↓
viewport
```

This creates a clean test seam.

---

# 28. Initial primitive API

Phase 1:

```text
box
sphere
cylinder
cone
```

Phase 2:

```text
torus
capsule
wedge
extrude
revolve
```

Phase 3:

```text
sweep
loft
shell
fillet
chamfer
```

---

# 29. Boolean API

Initial:

```text
union
subtract
intersect
```

Later:

```text
split
slice
offset
hull
```

Each boolean operation receives strongly typed solids.

---

# 30. Transform API

```text
translate
rotate
scale
mirror
matrix
```

Prefer immutable operations in the functional API.

Example:

```ts
const transformed = translate(body, [10, 20, 30]);
```

---

# 31. Parametric composition

Named parameters must be reusable.

Example:

```ts
function enclosure({
  width = mm(100),
  depth = mm(50),
  height = mm(30),
}) {
  return ...
}
```

More advanced:

```ts
const enclosure = part("enclosure", ({
  width,
  depth,
  height,
}) => ...)
```

This should become the equivalent of React component composition.

---

# 32. The "CAD component" model

Eventually users should be able to publish reusable parametric components:

```tsx
<Nema17Mount motorSize={17} plateThickness={3} holeSpacing={31} units="mm" />
```

or:

```ts
const mount = Nema17Mount({
  motorSize: 17,
});
```

This is strategically important.

It creates an ecosystem around CAD components rather than just an editor.

---

# 33. Native document format

The native source of truth must be a versioned document representation.

Example:

```json
{
  "format": "slopcad",
  "version": 1,
  "units": "mm",
  "parameters": [],
  "features": [],
  "bodies": [],
  "metadata": {}
}
```

It should be:

- deterministic
- JSON-compatible
- schema validated
- diffable
- Git friendly
- migratable

---

# 34. Source-vs-result distinction

A document contains source intent:

```text
parameter
feature
expression
history
reference
```

The kernel output is derived:

```text
BREP
mesh
tessellation
bounds
mass properties
```

Never store derived kernel state as the canonical document unless an explicit cache layer is introduced.

---

# 35. Exchange formats

Use different semantics for native persistence and interoperability.

## Mesh

Initial:

```text
STL
3MF
GLB/glTF
OBJ
```

Manifold explicitly recommends 3MF over STL because STL loses topology and can fail to preserve manifoldness after round-tripping. It also recommends glTF for richer mesh/vertex-property workflows.

Therefore:

> STL is compatibility output, not the preferred native mesh interchange.

---

## Engineering CAD

Later:

```text
STEP
IGES
BREP
```

STEP is the strategic interoperability format.

OpenCascade is the likely implementation backend.

Browser-side STEP/IGES/BREP import is already demonstrated by `occt-import-js` (dormant — fallback only; the maintained path is `replicad-opencascadejs`).

---

# 36. Import semantics

Importers must declare what is preserved.

Example:

```text
STEP
✓ geometric topology
✓ bodies
✓ faces
✓ colors
✓ names where available
✗ original feature history
✗ original constraints
✗ original expressions
```

And:

```text
STL
✓ triangles
✓ geometry
✗ BREP topology
✗ parametric structure
```

This should be part of the import result.

---

# 37. File abstraction

Define:

```ts
interface CadImporter<T = unknown> {
  format: FileFormat;
  capabilities: ImportCapabilities;
  import(input: Blob | ArrayBuffer): Promise<ImportResult<T>>;
}
```

and:

```ts
interface CadExporter<T = unknown> {
  format: FileFormat;
  capabilities: ExportCapabilities;
  export(model: T): Promise<Blob>;
}
```

The core should not know about file formats.

---

# 38. Sketch system

Not Phase 1.

But the architecture must allow it.

Eventually:

```text
Sketch
Workplane
SketchEntity
Constraint
Dimension
ConstructionGeometry
```

Reference geometry:

```text
point
line
arc
circle
ellipse
rectangle
slot
```

Constraints:

```text
coincident
horizontal
vertical
parallel
perpendicular
tangent
equal
distance
angle
radius
diameter
midpoint
symmetry
point-on-object
```

---

# 39. Constraint solver

The solver must be its own implementation.

The public API should not expose a third-party solver's internal data structures.

Potential implementation/reference systems:

```text
SolveSpace
custom solver
WASM constraint solver
```

three.cad demonstrates browser-side parametric sketches with constraints and arbitrary sketch planes.

---

# 40. UI components — initial set

The first useful registry should contain:

### `cad-viewport`

A composable R3F viewport shell.

### `cad-toolbar`

Generic toolbar capable of hosting arbitrary tools.

### `cad-model-tree`

Feature/body hierarchy.

### `cad-parameter-panel`

Parameter editor.

### `cad-property-panel`

Selected-object property inspector.

### `cad-command-menu`

Keyboard/search-driven command launcher.

### `cad-status-bar`

Selection, units, diagnostics and cursor information.

### `cad-workbench`

A composed example application rather than the foundational primitive.

This distinction is important:

```text
primitive components
        ↓
composed components
        ↓
complete workbench
```

---

# 41. UI design requirements

CAD UIs are information-dense.

The system should favor:

```text
small controls
strong keyboard support
compact popovers
contextual panels
clear selection
fast visual feedback
```

Do not blindly copy generic dashboard UI patterns.

The shadcn visual vocabulary should remain intact, but CAD interaction should dictate layout.

All user-facing strings in CAD components must be externalized (props or a labels token object) from the first implementation. The registry's source-distribution model means consumers own copied source — retrofitting i18n later would break every installed component. i18n is a roadmap commitment, not a non-goal.

---

# 42. Registry UX

The documentation should make this possible:

```bash
pnpm dlx shadcn@latest add @slopcad/cad-viewport
```

Then:

```tsx
<CadViewport model={model} />
```

And separately:

```bash
pnpm dlx shadcn@latest add @slopcad/cad-parameter-panel
```

The consumer owns the source.

This is particularly useful because the CAD UI will frequently need application-specific modifications.

---

# 43. Auth/backend

The existing backend/auth/database should remain.

But they are explicitly **not part of the CAD engine**.

Future capabilities:

```text
user
profile
project
saved document
document versions
public/private project
component library
```

Possible future model:

```text
User
 └── Project
      ├── Document
      ├── Versions
      ├── Assets
      └── Permissions
```

This should eventually reference native slopcad documents.

Do not make `cad-core` depend on a database.

---

# 44. Testing philosophy

TDD is a product requirement.

Every capability starts with tests.

The test stack should be:

```text
Vitest
Playwright
browser screenshots
browser recordings
fixture files
semantic geometry assertions
```

---

# 45. Unit test layers

## Domain

Test:

```text
parameters
expressions
units
dependency graph
transactions
serialization
migration
```

---

## Kernel

Test:

```text
primitive creation
boolean operations
transforms
bounds
volume
tessellation
invalid geometry
```

---

## Adapter

Test:

```text
core model
→ adapter
→ kernel
→ canonical result
```

---

# 46. Semantic geometry tests

Do not rely on exact triangle output.

Compare:

```text
bounding box
volume
surface area
manifold validity
solid count
topology counts
```

where supported.

For cross-kernel testing:

```text
same document
      ↓
Manifold
OCCT
JSCAD
      ↓
semantic comparison
```

---

# 47. Browser E2E

Every significant workflow gets a Playwright test.

Browser matrix (settled): evergreen trio — Chromium runs every phase's suite; Firefox and WebKit are exercised at the hardening phases. No SharedArrayBuffer/crossOriginIsolated requirement (COOP/COEP is a documented future opt-in). Node >= 22 LTS is pinned via `.nvmrc`.

Example:

```text
create box
set width
set depth
subtract cylinder
select face
export model
```

The tests should interact through user-facing behavior rather than internal implementation details.

---

# 48. Screenshots

Screenshots should validate:

```text
viewport
selection
toolbars
parameter panels
model tree
sketch mode
error states
dark/light modes
```

Geometry screenshots must use deterministic:

```text
camera
lighting
viewport size
pixel ratio
model
```

Evidence strategy (settled):

```text
geometry correctness → semantic numeric assertions:
                      projection buffers + camera serialized and
                      compared with tolerance (GPU-independent)
pixel screenshots   → UI chrome and composed scenes only, under
                      forced software WebGL (SwiftShader), fixed
                      viewport/DPR, canvas masking where needed
```

---

# 49. Videos

Use recorded workflows for interaction-heavy flows:

```text
create-model.webm
parameter-edit.webm
selection.webm
sketch.webm
export-import.webm
```

The videos are mainly for:

- regression debugging
- development confidence
- documentation
- future release QA

OneCAD is a useful reference here because it already treats Playwright E2E and cross-layer correctness as serious project infrastructure.

Semantics (settled): validators verify artifact existence and duration; video content review is human and optional.

---

# 50. Test fixture philosophy

Maintain reusable fixtures such as:

```text
cube
box-with-hole
nested-booleans
parameterized-enclosure
mounting-bracket
sketch-rectangle
sketch-constrained
step-import
stl-import
```

Fixtures should be version controlled.

---

# 51. Step 0 — Repository audit

Before modifying architecture:

1. inspect the existing Better-T-Stack workspace
2. inspect `packages/ui`
3. inspect current TypeScript path aliases
4. inspect Vitest configuration
5. inspect Playwright configuration
6. inspect TanStack Start app boundaries
7. inspect current shadcn configuration
8. confirm there is no CI and that none will be created (owner policy — local verify gates only)

Do not redesign existing infrastructure unnecessarily.

Deliverables:

```text
docs/architecture/current-state.md
docs/architecture/decisions/
```

Acceptance:

A clean dependency diagram exists showing where CAD packages may and may not import.

---

# 52. Step 1 — Architecture spike

Build only:

```text
parameter
box
cylinder
subtract
Manifold
R3F
```

Desired API:

```ts
const width = param("width", mm(100));

const model = box({
  width,
  height: mm(50),
  depth: mm(20),
});
```

Then:

```tsx
<CadModel model={model} />
```

Acceptance:

Changing `width` visibly changes the model.

Tests:

```text
core test
kernel test
React integration test
Playwright test
screenshot
video
```

This is the first architectural gate.

Spike code is kept, not deleted: it lives under a clearly-marked non-production path and is referenced from `docs/architecture/spike-findings.md` so later implementers build on its findings instead of starting from scratch. The spike also drafts the authoring API (`cad({ parameters, build })`, `feature()`).

---

# 53. Step 2 — Core domain

Implement:

```text
IDs
parameters
expressions
units
dependency graph
document
serialization
transactions
diagnostics
```

No kernel dependency in tests except through interfaces.

Acceptance:

A serialized document can be loaded and modified in a Node test without React or Three.js.

---

# 54. Step 3 — Kernel interface

Introduce:

```text
CadKernel
CadSolid
CadMesh
CadKernelCapabilities
```

Implement:

```text
FakeKernel
ManifoldKernel
```

The fake kernel is important for fast deterministic domain tests.

---

# 55. Step 4 — Manifold worker

Move the actual geometry work off-thread.

Define:

```text
WorkerRequest
WorkerResponse
```

with versioned message types.

Start with:

```text
create primitive
boolean
transform
tessellate
measure
```

---

# 56. Step 5 — Render projection

Implement:

```text
geometry → projection DTO → R3F
```

Add stable object/face IDs.

Acceptance:

The renderer never requires a Manifold object directly.

---

# 57. Step 6 — Interaction model

Implement:

```text
hover
selection
multi-selection
face selection
edge selection
vertex selection
```

Test:

```text
tree → viewport
viewport → tree
```

both directions.

---

# 58. Step 7 — Headless tool system

Implement:

```text
select
measure
move
rotate
```

as independent tools.

Test them without the final shadcn UI.

---

# 59. Step 8 — First shadcn components

Implement in `packages/ui`:

```text
cad-viewport
cad-toolbar
cad-tool-button
cad-model-tree
cad-parameter-panel
cad-property-panel
```

Build them using existing generic primitives.

Acceptance:

The components can be dropped into the existing application without introducing CAD-core dependencies into `packages/ui` that are not necessary.

---

# 60. Step 9 — Registry

Build:

```text
registry.json
item manifests
registry validation
registry generation (top-level `shadcn build`)
consumer fixture
```

A local consumer gate (no CI — owner policy) should create a tiny external-style fixture and install:

```text
cad-viewport
cad-parameter-panel
cad-model-tree
```

Then typecheck/build it.

The shadcn registry supports `validate`, `build`, namespaced registries and dependency resolution, so this should be treated as a normal automated build artifact, not a hand-maintained catalog.

---

# 61. Step 10 — Native document format

Finalize:

```text
slopcad document v1
```

Add:

```text
JSON schema
validation
migration
golden fixtures
```

Acceptance:

Every format change requires migration tests.

---

# 62. Step 11 — STL / 3MF

Implement:

```text
STL export
STL import
3MF export
3MF import
```

Prefer 3MF as the rich solid-mesh workflow.

STL remains an unavoidable compatibility output.

Manifold's own documentation strongly favors 3MF for manifold solids and glTF for richer mesh representation.

---

# 63. Step 12 — GLB

Add:

```text
GLB export
```

Use:

```text
glTF
EXT_mesh_manifold
```

where appropriate.

This should make slopcad useful outside CAD:

```text
web configurators
games
AR
product visualization
```

Manifold's current ecosystem explicitly includes glTF-oriented tooling.

---

# 64. Step 13 — Feature history

Introduce:

```text
Feature
FeatureGraph
Timeline
rollback
suppression
```

Acceptance:

Editing an earlier parameter recomputes downstream features.

---

# 65. Step 14 — Refs and topology identity

Start solving the hardest CAD problem.

Need:

```text
persistent references
face identities
edge identities
reference validation
reference repair strategies
```

Do not fake this with raw triangle indices.

This deserves its own design document and probably its own substantial research pass.

Sequencing (settled): persistent references land **after** the OpenCascade backend, where real BREP faces/edges exist. In the Manifold era, references are transient geometric selections only.

---

# 66. Step 15 — OpenCascade

Implement:

```text
@slopcad/kernel-occt
```

Then:

```text
STEP import
STEP export
IGES import
BREP import/export
```

The OCCT JS binding is `replicad-opencascadejs` — the maintained fork Replicad runs on. `opencascade.js` upstream is unmaintained since 2023 and is excluded; `occt-import-js` (dormant since 2024) is an import-only fallback at most. The phase opens with a short binding pre-spike before adapter code is written. Replicad also demonstrates browser-side OCCT plus STEP export/import and the need for Worker execution.

Acceptance:

STEP becomes a first-class interoperability path.

---

# 67. Step 16 — Sketches

Implement:

```text
workplane
sketch
line
circle
arc
rectangle
```

Then:

```text
coincident
horizontal
vertical
distance
angle
tangent
equal
```

Keep solver and sketch domain separate.

---

# 68. Step 17 — Advanced tools

Add:

```text
extrude
revolve
sweep
loft
fillet
chamfer
shell
pattern
mirror
hole
```

Each is its own TDD/e2e gate.

---

# 69. Step 18 — Complete workbench

Compose:

```text
CadWorkbench
├── toolbar
├── command menu
├── viewport
├── tree
├── parameter panel
├── property panel
├── history
└── status bar
```

This is a showcase, not a mandatory architecture.

Every component still works independently.

---

# 70. Step 19 — Performance

Only after correctness is established. Budgets are defined from measured baselines in this step and recorded in the docs — no speculative targets.

Measure:

```text
kernel startup
WASM load
worker startup
model recompute
tessellation
transfer
React render
selection latency
memory
```

Then introduce:

```text
memoization
incremental graph evaluation
geometry cache
tessellation cache
worker batching
```

---

# 71. Step 20 — Account/project infrastructure

Only after local documents work properly.

Introduce:

```text
project
document
version
asset
user ownership
permissions
```

The existing Better-T-Stack backend/auth/database infrastructure can then be used.

The CAD packages remain database-agnostic.

Potential flow:

```text
local document
     ↓
native serialization
     ↓
upload
     ↓
project/document/version
```

---

# 72. Step 21 — Component ecosystem

Once the core is stable:

```text
NEMA motor mounts
Arduino mounts
bearings
fasteners
enclosures
brackets
gears
plates
```

A reusable parametric component can expose:

```text
parameters
ports/references
documentation
preview
metadata
```

This is where the ecosystem could become genuinely interesting.

---

# 73. Step 22 — Registry ecosystem

Registry items eventually include more than UI.

Potential categories:

```text
@slopcad/ui/*
@slopcad/cad/*
@slopcad/tools/*
@slopcad/examples/*
@slopcad/components/*
```

shadcn's registry architecture explicitly allows items beyond React UI components, including utilities, hooks, config and other source files.

This opens the door to installable CAD building blocks such as:

```bash
pnpm dlx shadcn@latest add @slopcad/nema17-mount
```

---

# 74. Future AI integration

Do not build AI into the core.

But design the architecture so commands are machine-addressable.

Eventually:

```text
"make the hole 6mm"
       ↓
parse intent
       ↓
set parameter command
       ↓
regenerate
```

or:

```text
"add four mounting holes"
       ↓
tool/feature command
```

A command-based document architecture makes this possible without contaminating the CAD model with AI concepts.

---

# 75. Future collaboration

Do not implement now.

But transactions and commands should make it possible later to consider:

```text
event log
CRDT
operational transforms
version history
comments
presence
```

---

# 76. API quality gates

Before 1.0:

```text
[ ] no React dependency in core
[ ] no kernel-specific types leak
[ ] document format versioned
[ ] deterministic serialization
[ ] public IDs stable
[ ] units typed
[ ] expression AST serializable
[ ] commands replayable
[ ] kernel capabilities discoverable
[ ] async execution supported
```

---

# 77. Dependency policy

Avoid giant dependency aggregation.

A user who wants:

```text
core + Manifold + R3F
```

should not get:

```text
OCCT
OpenSCAD
STEP parser
sketch solver
whole UI
```

The expected installation model is:

```bash
pnpm add \
  @slopcad/core \
  @slopcad/kernel-manifold \
  @slopcad/r3f
```

Then optionally:

```bash
pnpm add @slopcad/kernel-occt
```

and then UI through the registry.

---

# 78. Package dependency direction

The allowed dependency graph should roughly be:

```text
cad-core
  ↑
cad-document
cad-expression
cad-units
  ↑
cad-kernel
  ↑
cad-kernel-manifold
cad-kernel-jscad
cad-kernel-occt
  ↑
cad-react
  ↑
cad-r3f
  ↑
cad-tools
  ↑
packages/ui
```

But `packages/ui` must not become the owner of CAD state.

It consumes public React APIs.

---

# 79. Circular dependency prohibition

Explicitly forbid:

```text
core → React
core → UI
kernel → React
UI → kernel internals
renderer → document implementation details
```

Any violation requires architectural review.

---

# 80. Definition of done

Every feature requires:

```text
[ ] API design
[ ] failing unit test
[ ] implementation
[ ] semantic geometry tests
[ ] integration tests
[ ] error-state tests
[ ] Playwright E2E
[ ] screenshot
[ ] video when interaction-heavy
[ ] documentation example
[ ] package boundary check
[ ] typecheck
[ ] build
```

A feature without browser coverage is incomplete when it is user-facing.

---

# 81. First milestone / north-star demo

The first demo should be deliberately tiny:

```tsx
const width = param("width", mm(100));

const model = subtract(
  box({
    width,
    height: mm(50),
    depth: mm(20),
  }),
  cylinder({
    radius: mm(4),
    height: mm(30),
  }),
);
```

Rendered with:

```tsx
<CadViewport model={model} />
<CadParameterPanel model={model} />
```

The user changes:

```text
width: 100 → 150
```

and sees:

```text
parameter updates
     ↓
dependency graph invalidates
     ↓
worker recomputes
     ↓
projection updates
     ↓
R3F updates
     ↓
screenshot matches
```

That tiny interaction is the proof of the entire architecture.

---

# 82. First public milestone

A first meaningful release can be:

## slopcad 0.1

```text
✓ parametric document
✓ units
✓ expressions
✓ primitives
✓ booleans
✓ transforms
✓ Manifold
✓ worker execution
✓ R3F
✓ selection
✓ parameter panel
✓ model tree
✓ native JSON
✓ STL
✓ 3MF
✓ registry
✓ Playwright
✓ screenshot regression
```

Not yet:

```text
✗ full sketches
✗ constraints
✗ STEP
✗ advanced BREP
✗ collaboration
✗ cloud projects
✗ AI
```

Roadmap commitments (wanted, later — not non-goals):

```text
assemblies / mates   after the reference system matures
i18n                 labels externalized from day one; translations later
2D drawings          post-1.0
```

Permanent non-goal:

```text
CAM / toolpaths      never inside slopcad — export STEP/3MF into dedicated
                     slicers and CAM tools instead
```

---

# 83. Strategic position

slopcad should be described as:

> **A composable parametric CAD SDK for the web.**

Not:

> a browser clone of SolidWorks

and not:

> OpenSCAD with React syntax.

The key combination is:

```text
TypeScript
+
parametric document graph
+
reactive recomputation
+
pluggable kernels
+
React
+
R3F
+
headless tools
+
shadcn
+
copyable registry components
+
real CAD file interoperability
```

That is the product.

---

# 84. Research-derived architectural lessons

## Lesson 1 — Don't make the kernel your public API

Replicad makes OCCT usable, but the complexity of WebAssembly setup is exactly why its documentation recommends explicit initialization and workers.

Hide that complexity.

---

## Lesson 2 — Don't rebuild Manifold

Manifold is already a serious JS/WASM geometry layer and now ships `manifold-cad` tooling.

Use it.

---

## Lesson 3 — Don't invent a bad procedural language

CadQuery/build123d/JSCAD have already explored excellent code-CAD APIs.

Borrow proven ergonomics while making the model graph more explicit.

---

## Lesson 4 — Treat protocols and projections seriously

OneCAD demonstrates that separating model/kernel protocols from frontend rendering can make an ambitious CAD system tractable.

slopcad should do the same, but with TypeScript instead of a Rust/C++ stack initially.

---

## Lesson 5 — UI distribution can be a real differentiator

Modern shadcn registries are explicitly designed for source distribution, namespacing, dependencies and modular installation.

A CAD developer should be able to install exactly:

```text
viewport
tree
parameter editor
toolbar
```

without taking the entire application.

---

## Lesson 6 — Tau validates the direction, not the need to copy Tau

Tau now combines the same general ingredients — R3F, shadcn, multiple kernels and parametric modeling.

That means the "React + CAD + multiple kernels" idea is validated.

The opportunity is to make the **underlying composable SDK** cleaner and more reusable.

---

# 85. Major technical risks

## Topology identity

The hardest serious-CAD problem.

Changing a feature can completely alter topology.

The system needs a strategy for references surviving regeneration.

This deserves dedicated architecture work.

---

## Kernel divergence

Two kernels may produce geometrically equivalent but structurally different results.

Cross-kernel tests therefore need semantic comparison.

---

## WASM bundle size

OCCT can become expensive to ship.

Optional adapters are mandatory.

---

## Main-thread responsiveness

Kernel work and heavy tessellation must not freeze the UI.

Worker architecture is required.

---

## Parametric failure handling

A parameter update may make downstream features impossible.

The document must represent:

```text
valid
warning
failed
suppressed
stale
```

without destroying the previous valid model unnecessarily.

---

## UI coupling

It will be tempting to put document state inside Zustand/React because it is convenient.

Don't.

React may mirror domain state, but it should not own the CAD source of truth.

---

# 86. Recommended immediate work

The correct next development artifact is not another huge feature list.

It is:

```text
Step 0:
architecture audit

Step 1:
domain/kernel prototype

Step 2:
first R3F viewport

Step 3:
first shadcn CAD components

Step 4:
registry + consumer test
```

And the first architectural spike should answer exactly four questions:

```text
1. What does a parameter look like?
2. What does a feature graph look like?
3. What is the kernel boundary?
4. What is the render projection boundary?
```

Once those four are correct, most of the rest of slopcad becomes incremental rather than existentially risky.

# 87. Proposed first package set

Do not create twenty packages immediately.

Start with:

```text
packages/
  ui/
  cad-core/
  cad-kernel/
  cad-kernel-manifold/
  cad-react/
  cad-r3f/
```

Then split when a boundary becomes real:

```text
cad-expression
cad-units
cad-document
cad-tools
cad-io
cad-sketch
cad-constraints
cad-kernel-occt
```

This keeps the early monorepo manageable while preserving the intended architecture.

# 88. Immediate first API

The first API should be tiny enough to redesign — its implementation is kept as a non-production reference, not burned.

Something close to:

```ts
const model = cad({
  parameters: {
    width: mm(100),
  },

  build: ({ parameter }) =>
    box({
      width: parameter("width"),
      height: mm(50),
      depth: mm(20),
    }),
});
```

Then:

```tsx
<CadViewport model={model} />
```

The exact API is expected to change during Step 1.

The important invariant is:

> **The document graph, not React, is the source of truth.**
