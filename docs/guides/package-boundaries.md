# Package boundaries

The allowed-import map, from `docs/architecture/dependency-map.md` (the
authoritative record) and the manifests on this branch. The rule that
matters: **each layer knows only the layer below it.**

```text
apps/web ── everything below (the composition root)
  ├── @slopcad/api ── @slopcad/auth ── @slopcad/db ── @slopcad/env
  ├── @slopcad/ui ── public renderer surfaces only (cad-r3f, cad-react,
  │                  cad-kernel, cad-kernel-manifold) — never kernel internals
  ├── @slopcad/cad-r3f ── cad-react + cad-core + three/R3F (peer)
  ├── @slopcad/cad-react ── cad-core only (+ react peer)
  ├── @slopcad/cad-components ── cad-core + cad-kernel (no kernel backend!)
  ├── @slopcad/cad-io ── cad-core + cad-kernel
  ├── @slopcad/cad-sketch ── cad-core only
  ├── @slopcad/cad-jscad ── cad-kernel + @jscad/modeling
  ├── @slopcad/cad-kernel-occt ── cad-kernel + replicad-opencascadejs + occt-import-js
  ├── @slopcad/cad-kernel-manifold ── cad-kernel + manifold-3d
  └── @slopcad/cad-kernel ── cad-core only
@slopcad/cad-core ── nothing (no React, no three, no DOM, no kernel, no db)
```

The rules, verbatim from the dependency map:

- `cad-core` → no React, no Three.js/R3F, no DOM, no kernel, no database.
- `cad-kernel` → may depend on cad-core; never React/UI.
- `cad-kernel-*` → the kernel abstraction and the kernel runtime only.
- `cad-react` → cad-core only.
- `cad-r3f` → cad-react + cad-core + Three/R3F.
- `packages/ui` → public React/R3F APIs only; never kernel internals.
- No CAD package → `@slopcad/db`, `@slopcad/auth`, `@slopcad/api`, or the app.

Two later-phase additions sit on top of this map:

**The renderer stays prop-driven (Phase 14).** `cad-r3f`'s `CadScene` and
`CadModel` take the projection, selection, and pick callbacks as explicit
props and know nothing of `CadProvider`/hooks. A host mirrors domain
state through `@slopcad/cad-react` and feeds the renderer as data — the
workbench and every fixture do exactly this.

**The registry inverts the dependency (Phase 33).** For an external
consumer there are no workspace imports at all: three source registries
(`packages/ui/registry.json`, `packages/cad-components/registry.json`,
`apps/web/registry.json`) author items whose sources import only
**public** package surfaces; `shadcn build` emits byte-reproducible
artifacts; the consumer's CLI installs the files. Item sources carry no
monorepo-internal dependencies, and the `registry:validate` gate enforces
it. The not-on-npm stand-in: the consumer links the CAD packages as
`file:` dependencies and pins/dedupes the peer packages, because the
kernel's opaque handle types are nominal (one module identity per
package, or the branded types stop being assignable).

Nothing in the graph enforces these rules mechanically today — the
dependency map is the review contract (a violation needs architectural
review, per its header). The registry artifacts are the only place with
an automatic check.
