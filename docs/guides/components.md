# Reusable components

`@slopcad/cad-components` (Phase 32) is the reusable parametric
component system: self-describing definitions, kernel-neutral execution,
and three shipped components. Every piece is also a registry item
(`nema17-mount`, `arduino-mount`, `enclosure` — see
[registry.md](registry.md)).

## The contract

A `CadComponentDefinition` (`component-contract.ts`,
`COMPONENT_CONTRACT_VERSION`) declares id, name, description, semver,
parameter descriptors (`name`, `dimension`, `defaultValue`, optional
`min`/`max`/`step`), ports (named `hole`/`boss`/`interface` attachment
points), and preview metadata (body ids + authored viewport). Values are
a plain record of numbers:

```ts
import {
  resolveComponentParameters,
  componentParameterCollection,
} from "@slopcad/cad-components";

const resolved = resolveComponentParameters(NEMA17_MOUNT_DEFINITION, values);
if (resolved.ok) resolved.value.get("plateSizeMm"); // validated magnitude
componentParameterCollection(definition, values); // → a cad-core parameter
//   collection (the panel's form)
```

## The execution surfaces

- `directComponentKernel(kernel)` — runs a component against an
  in-process `GeometryKernel`; sync results ride `Promise.resolve`. The
  consumer fixture and the `/docs` page build real geometry this way.
- `createContextKernel(...)` — the worker-session adapter.
- Every build validates values against the definition FIRST
  (`resolveBuildParameters`), then runs geometry; every failure —
  contract, component-semantic, kernel — is a structured
  `ComponentBuildError`, never a throw.

```ts
import {
  nema17Mount,
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  directComponentKernel,
} from "@slopcad/cad-components";

const build = await nema17Mount.build(
  directComponentKernel(kernel),
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
);
if (build.ok) {
  build.value.bodies[0]?.solid; // { name, bodyId, solid }
  kernel.volume(build.value.bodies[0]!.solid);
}
nema17Mount.ports(values); // positions in component-local mm — no kernel
```

## The shipped three

| Component             | Registry id     | Parameters (defaults)                                                     |
| --------------------- | --------------- | ------------------------------------------------------------------------- |
| NEMA 17 stepper mount | `nema17-mount`  | bore 22.5 · boss Ø24×3.5 · hole spacing 31 · plate 46 × 6 · screw Ø3.4 mm |
| Arduino UNO R3 mount  | `arduino-mount` | the UNO R3 footprint (`boardHoleCentersMm`)                               |
| Electronics enclosure | `enclosure`     | shell + lid with bosses (`deriveEnclosure`, `lidBossCentersMm`)           |

`PHASE32_COMPONENTS` lists them in registry order. The Registry id
column is what `shadcn add @slopcad/<id>` consumes; two of the three
definitions carry different ids of their own — `arduino-uno-mount` and
`electronics-enclosure` are definition ids, not registry names.
`defineComponent` validates YOUR definition through the public contract
at construction (see the runnable example's washer).

## The runnable example

`packages/docs-examples/src/components/components.ts` builds the NEMA 17
mount over the real Manifold kernel, edits `plateSizeMm` 46 → 52 (volume
grows), resolves ports, and defines + builds a custom washer —
`π(10² − 4²)×2` mm³ within the mesh discretization band.
