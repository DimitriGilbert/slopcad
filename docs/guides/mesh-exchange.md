# STL / 3MF / GLB

`@slopcad/cad-io` is the mesh import/export package. All three exporters
are deterministic — same input in, same bytes out, every call — and all
of it is geometry-only: **none of these formats carries parametric
history** (only the native format does; see [native-files.md](native-files.md)).

## The shared substrate

Geometry travels as the kernel contract's `Tessellation` — flat xyz
positions in canonical millimetres, flat triangle indices, optional
paired normals. One file per solid (STL has no part structure; 3MF/GLB
may revisit multi-part later). Rejections are structured
`ParseResult` failures with stable `<format>/<cause>` codes.

## STL (binary)

```ts
import { exportStlBinary, importStl } from "@slopcad/cad-io";

const exported = exportStlBinary(tessellation); // 80-byte header + count + 50 B/triangle
if (exported.ok) somewhere(exported.value); // Uint8Array — deterministic bytes
const imported = importStl(exported.value); // binary OR ASCII, detected structurally
```

Layout: the fixed 80-byte header, the little-endian uint32 triangle
count, then `50 × count` triangle records. A 12-triangle soup exports to
exactly 684 bytes (the suite pins it). Import is total — any byte input
imports or fails structured. Browser-safe, pure JS.

## 3MF

```ts
import { exportThreeMf, importThreeMf } from "@slopcad/cad-io";

const exported = exportThreeMf(tessellation, { title: "…" }); // OPC ZIP package
const imported = importThreeMf(exported.value);
imported.value.units; // the declared ST_Unit (spec default "millimeter")
imported.value.metadata; // preserved well-known Title/Designer/Description
```

3MF is the preferred mesh interchange (richer semantics than STL). One
constraint: **the importer is Node-targeted** — it inflates deflate
entries through `node:zlib`. A browser app imports 3MF through its
server (the `/io` fixture's `/api/io/import-3mf` route is the pattern);
export is browser-safe.

Import is bounded by named resource ceilings (the constants live in
`packages/cad-io/src/three-mf-import.ts`): a per-part inflated byte cap
of 512 MiB, enforced before inflation so a decompression bomb never
gets to allocate; and three parse-stage ceilings, each enforced by
arithmetic before the memory it guards — 1,000,000 XML elements per
part, 4,000,000 vertices, 8,000,000 triangles. A legal-but-huge
document past any of them is refused
`three-mf-import/unsupported-structure`: legal 3MF the importer
declines by policy (exactly like its other out-of-scope constructs),
never an out-of-memory crash.

The viewer's share links are bounded the same way
(`apps/web/src/viewer/share-codec.ts`): the URL fragment payload caps
at 8 MiB of base64 and one decode inflates to at most 64 MiB of native
text, so a crafted deflate bomb is refused by arithmetic and lands in
the viewer's structured error state — never an out-of-memory tab.

## GLB

```ts
import { exportGlb } from "@slopcad/cad-io";
const glb = exportGlb(projection); // ← the RENDER PROJECTION, not the soup
```

glTF is render-oriented, so the exporter takes the cad-core
`RenderProjection`: one named node per render object, float32
POSITION/NORMAL accessors (POSITION with its spec-required min/max),
uint16/uint32 indices by vertex count (`GLB_UINT16_VERTEX_LIMIT`), and
the documented CadScene pbrMetallicRoughness material.

## OBJ (Phase 56)

```ts
import { exportObj, importObj } from "@slopcad/cad-io";

const exported = exportObj(tessellation); // deterministic ASCII, 6-decimal text
const imported = importObj(exported.value);
imported.value.name; // the first o/g name, null when the file names none
imported.value.declined; // every out-of-subset keyword, recorded
```

Wavefront OBJ rides the same family discipline as STL: one tessellation
per file, byte-deterministic fixed-format text, unitless coordinates in
canonical millimetres (the importer reads them 1:1 — the documented
convention, not a detection). Faces with 3+ vertices fan-triangulate;
negative indices resolve per the spec. Everything the pinned subset does
not consume (`vn`, `vt`, materials, line elements, second objects) is
recorded in `declined` — never silently dropped.

## DXF and SVG sketches (Phase 56)

```ts
import { importDxf, importSvg } from "@slopcad/cad-io";

const dxf = importDxf(bytes, { layers: ["outline"] }); // cad-sketch entities, mm
const svg = importSvg(bytes); // same vocabulary, y mirrored to the sketch plane
dxf.value.declined; // scope boundaries: out-of-subset kinds/splines, with handles
```

Both are sketch importers, not mesh ones: they parse ASCII DXF
(R12-class LINE/CIRCLE/ARC/LWPOLYLINE/POLYLINE/SPLINE subset, `$INSUNITS`
scaling) and ASCII SVG (`line`/`circle`/`rect`/`ellipse` elements and a
`path` subset — M/L/H/V/C/Q/A/Z, exact quadratic elevation and SVG spec
F.6.5 arc centers: offset ±√((r²−d)/d) from the chord midpoint, sweep=1
mirrored to a decreasing sketch angle) into the exact cad-sketch
vocabulary, feeding the sketch editor. Scope boundaries decline per
element — an out-of-subset path command declines its whole path element,
not just that segment — with reasons;
in-subset defects reject the whole file (`dxf-import/*`, `svg-import/*`
codes). SVG's y-down axis mirrors to the sketch plane; a viewBox
contributes its origin only. **DWG stays a documented decline**: the
closed binary AutoCAD format has no in-repo parser (and no sanctioned
spec to write one from) — DXF is the interchange answer, and that is the
whole of the DWG surface.

## The runnable example

`packages/docs-examples/src/io/mesh.ts` round-trips all three over one
plate soup — 684-byte STL, deterministic re-export (byte-equal), 3MF
re-import with unit + 12 triangles restored, GLB bytes — and the
`/docs` page offers the actual STL file as a download.
