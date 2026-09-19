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

## The runnable example

`packages/docs-examples/src/io/mesh.ts` round-trips all three over one
plate soup — 684-byte STL, deterministic re-export (byte-equal), 3MF
re-import with unit + 12 triangles restored, GLB bytes — and the
`/docs` page offers the actual STL file as a download.
