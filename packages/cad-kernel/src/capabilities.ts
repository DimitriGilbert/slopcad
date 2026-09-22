/**
 * Declared kernel capabilities (Phase 8): what a kernel implementation can
 * actually promise, so callers and later phases can adapt instead of
 * discovering limits through failures.
 *
 * Every flag exists because a later phase branches on it:
 *
 * - `booleans`: whether union/subtract/intersect produce meaningful solids.
 *   A tessellation-only kernel would declare `false` and stay render-only.
 * - `transform*`: which transform kinds the kernel accepts through the
 *   contract's `transform` operation. Translation is part of the contract
 *   since Phase 8; rotation input (axis + angle, applied about the world
 *   origin before the translation) arrived with the Phase 21.1 OpenCascade
 *   adapter — the first kernel to declare `transformRotation: true`. Scale
 *   input (the uniform `scale` field, about the world origin before the
 *   translation) arrived with Phase 41; the flag existed since Phase 8 so
 *   a kernel could declare readiness ahead of the input type.
 * - `exactPrimitiveVolumes`: primitive volumes are analytic (box, sphere,
 *   cylinder, cone), not mesh-discretized. Fake and Manifold both hold this;
 *   a tessellation-only kernel would not.
 * - `exactBooleanVolumes`: boolean volumes are exact (BREP integration),
 *   not estimated. The fake kernel computes boolean volumes by deterministic
 *   voxel quadrature and declares `false`; Manifold computes exact mesh
 *   volumes and declares `true`. Semantic test utilities therefore compare
 *   boolean volumes with documented relative tolerances, never exactly.
 * - `tightBooleanBounds`: bounds of boolean results are the tight
 *   axis-aligned bounding boxes of the true result. The fake kernel returns
 *   conservative containers for subtract/intersect (the target's box, the
 *   operand boxes' intersection) and declares `false`; assertions on boolean
 *   bounds use containment plus tightness only where this flag is set.
 * - `persistentTopology`: faces/edges/vertices keep stable identities across
 *   operations — required for persistent selection and feature references
 *   (`ref_*` ids in cad-core). Declared by the OpenCascade backend (Phase
 *   21), whose BREP topology carries `TopoDS` identities; the reference
 *   model that consumes them is Phase 22's work, which is why the flag
 *   arrives ahead of any consumer.
 * - `sweep`: the contract's profile-along-path sweep (Phase 26.3) is
 *   implemented honestly. The FIRST operation the contract carries that not
 *   every engine can do: Manifold has no sweep or loft primitive (probed),
 *   so its adapter declares `false` and every `sweep` call answers with the
 *   structured `kernel/unsupported-operation` — the flag exists exactly so
 *   callers and suites branch upfront instead of discovering the limit
 *   through failures.
 * - `loft`: the contract's multi-section loft (Phase 26.4) is implemented
 *   honestly — the same discipline `sweep` established: Manifold's engine
 *   has no loft primitive either (probed), so its adapter declares `false`
 *   and every `loft` call answers `kernel/unsupported-operation`, while
 *   OCCT (exact ThruSections), the fake kernel (Simpson-exact morph), and
 *   JSCAD (slice loft) declare `true`.
 * - `fillet`: the contract's edge fillet (Phase 26.5) is implemented
 *   honestly — the sweep/loft discipline again: Manifold and JSCAD have no
 *   fillet primitive (probed; Manifold's "smooth out" is shading tangent
 *   interpolation, not geometry), so both declare `false` and every `fillet`
 *   call answers `kernel/unsupported-operation`, while OCCT (exact
 *   `BRepFilletAPI_MakeFillet`) and the fake kernel (the analytic
 *   corner-fillet model over its documented box-edge subset) declare `true`.
 *   The flag gates the contract suite's fillet fixtures exactly like the
 *   sweep and loft flags gate theirs.
 * - `chamfer`: the contract's edge chamfer (Phase 26.6) is implemented
 *   honestly — the fillet discipline verbatim: Manifold and JSCAD have no
 *   chamfer primitive either (probed; the same engine verdicts as their
 *   fillet), so both declare `false` and every `chamfer` call answers
 *   `kernel/unsupported-operation`, while OCCT (exact
 *   `BRepFilletAPI_MakeChamfer`, the symmetric-distance `Add`) and the fake
 *   kernel (the analytic corner-prism model over the fillet subset's
 *   box-edge domain) declare `true`. The flag gates the contract suite's
 *   chamfer fixtures exactly like the fillet flag gates its own.
 * - `shell`: the contract's face-removal hollowing (Phase 26.7) is
 *   implemented honestly — the sweep/loft/fillet/chamfer discipline on the
 *   FACE-addressed operation: Manifold's 3D surface has no offset or
 *   hollow at all and JSCAD's `expandShell` is the outward expansion's
 *   helper, not wall building (both probed), so both declare `false` and
 *   every `shell` call answers `kernel/unsupported-operation`, while OCCT
 *   (exact `BRepOffsetAPI_MakeThickSolid`, the inward-offset
 *   `MakeThickSolidByJoin`) and the fake kernel (the analytic open-box
 *   model over its single-face subset) declare `true`. The flag gates the
 *   contract suite's shell fixtures exactly like its siblings gate theirs.
 * - `mirror`: the contract's world-axis-plane reflection (Phase 26.9) is
 *   implemented honestly — the flag exists for the same discipline as its
 *   siblings (a kernel without an honest reflection answers the structured
 *   `kernel/unsupported-operation`), though it is the first Phase 26
 *   operation NO kernel needs to decline: every engine can reflect
 *   (probed — OCCT's `gp_Trsf.SetMirror`, Manifold's negative-determinant
 *   `transform`, JSCAD's `mat4.isMirroring` vertex reversal, and the fake
 *   kernel's pointwise model), so all four adapters declare `true` and the
 *   flag gates the suite's mirror fixtures uniformly anyway.
 * - `helix`: the contract's analytic-spine helical sweep (Phase 40) is
 *   implemented honestly. The pin's discipline again, with a per-kernel
 *   subset twist: OCCT rules the exact meridian stations and lofts between
 *   them (the documented ruled band — its pipe builder carries
 *   section-perpendicular profiles, provably not the meridian solid), the
 *   fake kernel models the screw solid exactly (closed-form volume,
 *   inverse-screw membership) and declines OVERLAPPING turns with the
 *   structured `kernel/helix-turn-overlap` rather than overcounting, and
 *   Manifold/JSCAD have no helical primitive at all (the plan's ruling) —
 *   both answer every `helixSweep` call with `kernel/unsupported-operation`.
 *   The flag gates the contract suite's helix fixtures like its siblings.
 * - `surfaceArea`: the contract's whole-solid surface-area measurement
 *   (Phase 27.4) is implemented honestly — the first MEASUREMENT flag (its
 *   siblings gate producers; `area` measures). Every engine provides its
 *   own area measure (probed — OCCT's `BRepGProp.SurfaceProperties` exact
 *   BREP surface integration, delta 0 from the analytic plate-with-bore
 *   value; Manifold's `Manifold.surfaceArea()` and JSCAD's
 *   `measureArea`, both exact over each kernel's own boundary
 *   representation; the fake kernel's analytic primitive subset), so all
 *   four declare `true`. A kernel whose engine exposed no area measure
 *   would declare `false` and answer every call with the structured
 *   `kernel/unsupported-operation` — never a silently wrong number. The
 *   flag's DECLARATION does not promise universal coverage: a kernel may
 *   still decline shapes outside its own measured model per shape (the
 *   fake kernel's boolean nodes do exactly that), the same per-shape
 *   honesty its `fillet`/`chamfer`/`shell` domains already practise.
 * - `extrudeTaper`: the contract's DRAFT taper on `extrude` (Phase 41 —
 *   the optional `taper` field of `ProfileExtrudeInput`) is implemented
 *   honestly. OCCT drafts through `BRepOffsetAPI_DraftAngle` (probed
 *   prismatoid-exact on box, cylinder, and concave fixtures; its
 *   planar/cylindrical/conical face domain leaves ellipse/spline loops
 *   declined per shape), the fake kernel models the two-station inset
 *   loft (Simpson-exact, every loop kind), and JSCAD lofts the chord
 *   polygon into its far inset — all three declare `true`. Manifold
 *   declares `false`: its extrude's top-scale is a uniform scale (a
 *   provably different solid from the wall-angle draft), so every tapered
 *   call answers the structured `kernel/unsupported-operation` rather
 *   than that wrong approximation.
 * - `thicken`: the contract's CLOSED hollow (Phase 41 — the `thicken`
 *   operation, the complement of `shell`'s open hollow) is implemented
 *   honestly. OCCT composes the probed exact cavity
 *   (`MakeThickSolidByJoin(S, [], −t)`) with one exact cut; the fake
 *   kernel models the closed hollow over its pristine box/sphere subset,
 *   declining everything else structurally (the shell precedent). Both
 *   declare `true`; Manifold and JSCAD have no 3D offset at all (the
 *   shell's probed verdict verbatim) and answer every call with the
 *   structured `kernel/unsupported-operation`.
 * - `localFaceOps`: the contract's LOCAL FACE operations (Phase 44 —
 *   `moveFace`, `replaceFace`, `deleteFace`, the direct-manipulation
 *   family real CAD pair with persistent face selection) are implemented
 *   honestly. Only OCCT declares `true`, and only for the two of three it
 *   can build exactly: `moveFace` composes the probed face-sweep route
 *   (`BRepPrimAPI_MakePrism` of the selected face along the displacement,
 *   one `BRepAlgoAPI` fuse outward or cut inward — measured exact on
 *   axial and oblique fixtures), and `replaceFace` re-closes the solid at
 *   a datum plane station through the same machinery (parallel) or a
 *   covering-box cut in the plane's frame (oblique, shrink-only).
 *   `deleteFace` — both the raw open shell and the healed close — is
 *   PROBED out on this binding (the sewn-minus-one shell is an invalid
 *   solid, and `ShapeFix_Solid`'s close is invalid too), so OCCT declines
 *   it per-op with the structured unsupported code naming the probe, the
 *   fake kernel's documented subset discipline carried to a whole
 *   operation. The fake, Manifold, and JSCAD kernels declare `false`:
 *   their engines carry no face-addressed geometry at all, so every call
 *   of every local face op answers `kernel/unsupported-operation`.
 * - `section`: the contract's plane cut (Phase 46 — the `section`
 *   operation: target × plane → the cut solid plus the cross-section
 *   face's area/centroid) is implemented honestly. OCCT cuts with one
 *   exact `BRepAlgoAPI_Cut` by a covering box and measures the cap faces
 *   by exact BREP surface integration; the fake kernel models the
 *   cross-section polygon analytically over its pristine-box subset and
 *   composes the cut solid from its own `extrude` + `subtract` (the
 *   split's covering-box discipline); the mesh kernels (Manifold, JSCAD)
 *   compose the cut from their own exact box booleans — the roadmap's
 *   ruling that a mesh kernel CAN cut with a box tool — and measure the
 *   cap faces over the cut solid's own boundary mesh (the documented
 *   mesh-tessellated-honest band). All four declare `true`; a kernel
 *   without an honest cut or honest cap measurement would declare
 *   `false` and answer every call with the structured
 *   `kernel/unsupported-operation`.
 */
export interface KernelCapabilities {
  readonly booleans: boolean;
  readonly transformTranslation: boolean;
  readonly transformRotation: boolean;
  readonly transformScale: boolean;
  readonly exactPrimitiveVolumes: boolean;
  readonly exactBooleanVolumes: boolean;
  readonly tightBooleanBounds: boolean;
  readonly persistentTopology: boolean;
  readonly sweep: boolean;
  readonly loft: boolean;
  readonly helix: boolean;
  readonly fillet: boolean;
  readonly chamfer: boolean;
  readonly shell: boolean;
  readonly thicken: boolean;
  readonly section: boolean;
  readonly extrudeTaper: boolean;
  readonly mirror: boolean;
  readonly surfaceArea: boolean;
  readonly localFaceOps: boolean;
}
