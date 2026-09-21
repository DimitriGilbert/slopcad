# Spline constraint mathematics — closing the Phase 36 declines

Status: design (mathematical specification for implementation). Branch `design-final`.
Scope: the residual rows, analytic gradients, degeneracy guards, and solve strategy for
the constraint kinds that Phase 36 pinned out of the spline solving subset
(`constraints.ts`'s `SPLINE_SCOPE_UNSUPPORTED`: tangent, parallel, perpendicular, angle,
radius, diameter, equal, collinear on spline operands), `pointOnEntity` on the composite
entities (polygon, slot), and the certified replacement for the spline×axis
crossing check in the kernel.

Grounding sources (this document derives from these files and must be read against them):

- `packages/cad-sketch/src/entities.ts` — entity parameterizations
- `packages/cad-sketch/src/spline-math.ts` — the Bézier chain model, point gradients, tessellation, projection
- `packages/cad-sketch/src/residuals.ts` — `ParameterLayout`, `LinExpr`, every existing row and its gradient conventions
- `packages/cad-sketch/src/constraints.ts` — constraint vocabulary, validation, the pinned spline subset
- `packages/cad-sketch/src/reference-solver.ts` and `solver-math.ts` — the Gauss–Newton loop, tolerances, rank/DoF machinery
- `packages/cad-kernel/src/profile-geometry.ts` and `profile-splines.ts` — the tessellated spline extremes and the axis-crossing rule

Everything below is in workplane coordinates: lengths mm, angles rad, curve parameters
dimensionless per Bézier segment.

---

## 0. Grounding: conventions every derivation below reuses

### 0.1 Parameter layout and gradient conventions

The parameter vector packs entities in array order; a spline contributes `2N` unknowns
(`X_i = 2i`, `Y_i = 2i+1` local slots for stored point `i`, in point order). Every
residual row returns

```ts
interface ResidualEvaluation {
  readonly value: number; // residual in the row's documented unit
  readonly grad: ReadonlyMap<number, number>; // slot -> d r / d slot
}
```

and the existing rows' scale conventions are part of the contract: signed distances in
mm (`pointOnLineRow`), quadratic direction rows in mm² (`parallelRow`'s cross,
`perpendicularRow`'s dot), the angle row dimensionless. New rows keep these scales so
the solver's convergence tolerance (`REFERENCE_SOLVER_CONVERGENCE_TOLERANCE = 1e-9`,
judged as an RMS over mixed mm / mm² / dimensionless rows, "the quadratic rows are
effectively stricter at model scale") means the same thing it means today.

The gradient-building helpers used below, all already in `residuals.ts`:
`combineExpr`, `subtractExpr`, `chain(a, du, b, dv)`, `addInto(target, source, scale)`.

### 0.2 The curve model and the exact point gradient

Both flavors evaluate through the same cubic Bézier chain (`bezierChainOfSpline`):

- `control`: segment `k` spans stored points `3k … 3k+3` (point counts 4, 7, 10, …).
- `interpolated`: the stored points are Catmull-Rom fit points converted per span —
  `b0 = P_i`, `b1 = P_i + (P_{i+1} − P_{i−1})/6`, `b2 = P_{i+1} − (P_{i+2} − P_i)/6`,
  `b3 = P_{i+1}` with clamped end neighbors — a fixed sparse linear map from fit
  points to Bézier controls.

Write `B(t) = (u³, 3u²t, 3ut², t³)`, `u = 1 − t`, for the cubic Bernstein weights.
The chain point at `(segment s, t)` is `C(t) = Σ_j B_j(t) · b_j(s)` and the existing
`splinePointGradient(chain, s, t)` returns the exact per-point weight map

```
G_i(t) = Σ_j B_j(t) · M[j][i]
```

where `M[j][i]` is the flavor's control map (identity for `control`; the at-most-3-term
Catmull-Rom stencil for `interpolated` — `splineFitDeriv`). The same scalar weight
applies to the point's x and y slots.

Two flavor facts used repeatedly:

- The **interpolated chain is C¹ at interior junctions**: `C'(1)` of span `i` is
  `(P_{i+2} − P_i)/2` and `C'(0)` of span `i+1` is the same expression. The
  `control` chain is only C⁰ at junctions in general (tangent handles are free).
- The **end tangents have closed forms**:
  `control`: `T_start = 3(P_1 − P_0)`, `T_end = 3(P_{N−1} − P_{N−2})`;
  `interpolated`: `T_start = (P_1 − P_0)/2`, `T_end = (P_{N−1} − P_{N−2})/2`.
  Same directions, magnitudes in ratio 6 : 1. (Check: `B'(t) = (−3u², 3(u²−2ut),
3(2ut−t²), 3t²)`, so `C'(0) = 3(b_1 − b_0)` and `C'(1) = 3(b_3 − b_2)`; substitute
  the conversion.)

### 0.3 The tangent expression (the one new spline-math primitive)

Define the tangent and its exact point-gradient map:

```
C'(t)  = Σ_j B'_j(t) · b_j                 (B' as above; note Σ_j B'_j(t) = 0)
H_i(t) = Σ_j B'_j(t) · M[j][i]             (per-point weight; same scalar on x and y)
```

```ts
// spline-math.ts — mirror of splinePointGradient for the derivative:
export function splineTangent(chain, segment, t): { vx: number; vy: number };
export function splineTangentGradient(
  chain,
  segment,
  t,
): ReadonlyMap<number, number>;
```

Signs matter: `B'_0(t) = −3u² ≤ 0` — the first control's weight is negative. At
`t = 1/2` the weights are `(−3/4, −3/4, 3/4, 3/4)`, so `C'(1/2) = (3/4)((b_2+b_3) −
(b_0+b_1))`. Sparsity: an interior anchor of an interpolated span touches 4 fit points
(`s−1 … s+2`); a control-flavor anchor touches 2 points; a control-flavor end tangent
touches exactly 2 (`P_1, P_0` or `P_{N−1}, P_{N−2}`) with weights `(+3, −3)`; an
interpolated end tangent touches the same 2 points with weights `(+1/2, −1/2)`.

### 0.4 The frozen-anchor lemma (why frozen gradients count DoF correctly)

Several rows below depend on a curve parameter `τ(x)` chosen per evaluation (the
projection anchor — the exact pattern `pointOnSplineRow` already ships). The lemma
that keeps the solver's rank/DoF accounting honest:

**Lemma (frozen-anchor gradient exactness).** Let `r(x) = f(x, τ(x))` where the
anchor is either (a) a named constant parameter, or (b) an interior stationary point
of `f` in `t`, i.e. `∂f/∂t (x, τ(x)) = 0`. Then
`∇_x r = ∂f/∂x |_{t = τ}` — the frozen gradient. Case (a) is trivial; case (b) is
Danskin's theorem: `∇_x r = ∂f/∂x + (∂f/∂t) · ∇_x τ = ∂f/∂x`.

**Corollary (rank exactness at solutions).** For a constraint manifold written as
`{x : ∃t, f(x,t) = 0 and ∂f/∂t(x,t) = 0}`, at any solution both `f` and `∂f/∂t`
vanish, so the tangent conditions reduce to `∂f/∂x · v = 0` — exactly the frozen row's
gradient. The Gauss–Newton Jacobian of the frozen rows therefore spans the true
constrained directions at every solution, and `rankOf` / DoF counting is exact there.
Between solutions the frozen gradient is a Seidel iterate (each step exact for the
current anchor); the anchor re-resolves per evaluation, and the iteration converges
linearly in the anchor whenever the anchor map is contractive — the honesty the
`pointOnSplineRow` doc comment already states ("exact for the current parameter,
converges linearly in it").

The lemma has a negative twin used in §1.2: a row whose anchor does NOT make
`∂f/∂t = 0` (e.g. a plain closest-point anchor feeding a second, derivative row) has
a frozen gradient that is NOT the reduced residual's gradient; its rank contribution
can overcount constraints. The formulations below are chosen so this never happens.

### 0.5 Degrees of freedom: the circle precedent

The repo's own `tangentRows` for line↔circle is **one** row (`signed distance from
center to line − radius`) — tangency with a freely sliding contact removes exactly
**1** degree of freedom, because the contact parameter is eliminated, not constrained.
Every tangency form below is dimension-counted against this precedent:

| Constraint                                                      | Rows | Free anchors                                | Net codimension                   |
| --------------------------------------------------------------- | ---- | ------------------------------------------- | --------------------------------- |
| tangent(line, circle) — existing                                | 1    | 0 (analytic)                                | 1                                 |
| tangent(line, spline), anywhere                                 | 1    | 1 (eliminated stationary anchor)            | 1                                 |
| end tangency: pointOnEntity(spline.end, line) + parallel-at-end | 2    | 0 (named ends)                              | 2 (a stronger, pinned constraint) |
| G1 joint: coincident(A.end, B.start) + tangent-direction        | 3    | 0 (named ends)                              | 3                                 |
| tangent(spline, spline), anywhere                               | 3    | 2 (needs auxiliary unknowns — §1.6, staged) | 1                                 |

---

## 1. Tangency: line↔spline and spline↔spline

### 1.1 What tangency means here

The line `ℓ` (start `p_1`, direction `d = (dx, dy)`, length `L`) is tangent to the
spline when the curve touches it with matching direction:

```
∃ t*:  s(t*) = 0   and   s'(t*) = 0,
where  s(t)  = (dx·(C_y(t) − p_1y) − dy·(C_x(t) − p_1x)) / L    (signed distance, mm)
       s'(t) = d s / d t = (dx·C'_y(t) − dy·C'_x(t)) / L        (a double root of s)
```

A transversal crossing has `s = 0` with `s' ≠ 0`; tangency is exactly a double root.
Both flavors reach this through the same chain — `interpolated` converts to control
spans per the existing convention, and nothing below branches on flavor except the
gradient stencil (§0.3).

### 1.2 Auxiliary unknown vs projection elimination — the decision

**Option A (auxiliary unknown).** Add the contact parameter as a solver unknown and
write the two rows `s(t) = 0`, `s'(t) = 0` with exact gradients including `∂/∂t`. This
is the SolveSpace approach; local convergence is quadratic, and DoF accounting is
correct by construction (2 rows, +1 unknown, net codim 1). Cost: `ParameterLayout`,
`packInitialParameters`, and the fixed-slot machinery are entity-keyed today; a
constraint-owned parameter section is a real solver-surface change (sketched in §1.6
for the case that genuinely needs it).

**Option B (naive frozen pair — REJECTED, and the rejection is the derivation).**
Freeze an anchor once at compile time and keep both rows `s(t_0)`, `s'(t_0)`. Gradients
are exact, but the zero set is "tangency at the frozen parameter" — codimension 2, an
over-constraint (it pins the contact to a curve location). The rank machinery would
report 2 independent rows and under-count DoF by 1.

**Option B' (per-evaluation stationary anchor with a second row — REJECTED).**
Re-find the stationary point each evaluation and keep two rows. The trap: if the
anchor is stationary by construction, the row `s'(t_c)` is identically zero — vacuous.
If instead the anchor is the plain closest point, the pair's zero set is right, but
the frozen gradient of the second row drops the `s''·∇t_c` term (the anchor is not
stationary for it), so its rank contribution overcounts — same DoF corruption as B,
now hidden inside a pure-looking row.

**Option C (chosen for line↔spline): the eliminated stationary-anchor row.** One row:

```
r(x) = s(x, τ(x)),   τ(x) = argmin over candidates of |s|,   candidates =
       { per-segment stationary points of s } ∪ { chain start, chain end }
```

- **Zero set is exactly tangency**: `r = 0` iff some candidate has `s = 0`; interior
  stationary candidates have `s' = 0` built in, and the chain ends are the legitimate
  endpoint-tangency contacts (an endpoint touching the line with any tangent angle is
  a valid CAD tangency). A transversal crossing is not stationary and (generically)
  not at an end, so it does not zero the row.
- **One row, codimension 1** — matches the line↔circle precedent exactly.
- **Gradient is Danskin-exact in both anchor classes** (§0.4): stationary anchors
  satisfy `∂s/∂t = 0`; end anchors are named constants.
- **No solver-surface change**: the anchor search is a pure per-evaluation function of
  the current parameters, exactly like `projectOntoSpline` inside `pointOnSplineRow`.

So: the shipped point-class freeze **generalizes** to this family, but only after
eliminating the contact parameter down to a single stationary-anchored row. A
per-iteration reprojection scheme is what makes it work (the anchor must re-resolve
inside `evaluate`); a compile-time-frozen anchor does not (it over-constrains).

### 1.3 The anywhere tangency row (line↔spline)

**Anchor candidates.** `s` restricted to one Bézier segment is a scalar cubic with
control values `g_j = s(b_j)` — affine composition keeps Bézier form exactly, no
approximation. Its stationary points are the roots in `(0, 1)` of the quadratic with
Bernstein controls `q_j = 3(g_{j+1} − g_j)` (`j = 0, 1, 2`). A Bernstein quadratic
`(q_0, q_1, q_2)` has the power form `q(t) = A·t² + B_q·t + C_q` with
`A = q_0 − 2q_1 + q_2`, `B_q = 2(q_1 − q_0)`, `C_q = q_0` — solve by the quadratic
formula (deterministic; the certified clipping of §8 is the uniform alternative):

```ts
// discriminant D = B_q² − 4AC_q; D ≤ 0 -> no stationary point in the segment;
// else t = (−B_q ± √D) / (2A), kept when strictly inside (0, 1)
// (A = 0 degenerates to the linear case: root at −C_q / B_q when |B_q| > 0).
```

Candidates = those roots (one per root, at most 2 per segment) plus `(segment 0, t=0)`
and `(last segment, t=1)`. Evaluate `s` **exactly on the true curve** at each
candidate (`evaluateSplinePoint`), take the `|s|`-minimizer; ties break to the
earlier candidate in enumeration order (deterministic, matching `projectOntoSpline`'s
strict `<`). Junction parameters are deliberately NOT candidates: the control flavor's
junction tangent is undefined (C⁰), and the interpolated flavor's junctions are
covered from either side by the per-segment stationary roots.

**Residual.** Identical in shape to `pointOnLineRow` with the point expression
replaced by the true curve point at the anchor. The implementable construction is
`pointOnLineRow`'s body verbatim with `px/py` swapped for the curve-point
expressions:

```ts
function tangentLineSplineRow(
  label: string,
  origin: ResidualOrigin,
  lineId: SketchEntityId,
  splineId: SketchEntityId,
  context: CompiledContext,
): ResidualRow {
  return {
    label,
    origin,
    evaluate: (parameters) => {
      const line = lineGeom(parameters, lineSlotsOf(lineId, context));
      const [x1Slot, y1Slot] = lineSlotsOf(lineId, context).offsets; // p1 = line start
      const x1 = parameters[x1Slot]!;
      const y1 = parameters[y1Slot]!;
      const chain = splineChainFrom(parameters, splineId, context); // stored points from slots
      const anchor = tangencyAnchor(chain, line); // candidates + argmin |s| (pure)
      const px = curvePointExpr(chain, anchor.segment, anchor.t, "x"); // LinExpr via splinePointGradient
      const py = curvePointExpr(chain, anchor.segment, anchor.t, "y");
      const wx = px.value - x1;
      const wy = py.value - y1;
      const cross = line.dx * wy - line.dy * wx; // mm²
      const distance = cross / line.length; // mm
      const dCross = new Map<number, number>();
      addInto(dCross, line.ddx, wy); // d/d dx
      addInto(dCross, line.ddy, -wx); // d/d dy
      addInto(dCross, px.grad, -line.dy); // d/d C_x
      addInto(dCross, py.grad, line.dx); // d/d C_y
      // w = C(t) − p1: the line's own start slots flow through w as well —
      // see the convention note below; these two terms are REQUIRED for a
      // correct gradient (verified against finite differences).
      dCross.set(x1Slot, (dCross.get(x1Slot) ?? 0) + line.dy);
      dCross.set(y1Slot, (dCross.get(y1Slot) ?? 0) - line.dx);
      const grad = chain(
        1 / line.length,
        dCross,
        -cross / (line.length * line.length),
        line.dLength,
      );
      return { value: distance, grad };
    },
  };
}
```

**Convention note — a latent gradient gap in the existing `pointOnLineRow`.**
While deriving this row, the existing `pointOnLineRow` construction was checked
against finite differences: its `dCross` accumulation omits exactly the two `p1`
terms below (`w = P − p1` contributes `∂wx/∂x1 = −1` and `∂wy/∂y1 = −1` through
`cross = dx·wy − dy·wx`). Minimal repro: point `P = (0, 1)`, line `(0,0) → (1,0)`;
the row value is 1 and the true `∂r/∂y1 = −1`, but the shipped construction returns
0 on the `y1` slot (the tangent line↔circle row carries the same omission on its
line operand — it has the analogous `±(dx, dy)` terms for the circle center slots
but not for the line's start slots). Convergence is unaffected whenever a correct
column elsewhere spans the step, which is why it has gone unnoticed. The new rows
must carry the correct columns; the implementation stage that adds them should also
fix `pointOnLineRow` (and the line↔circle tangent row) with a finite-difference
regression test — as a deliberate, tested change, not drift.

**Gradient, every touched unknown** (mm; `G_i = G_i(t_anchor)` from
`splinePointGradient`, whose entries are the weights on `X_i` and `Y_i` alike):

```
r = cross / L,   cross = dx·wy − dy·wx,   w = C(t) − p_1,   L = ‖d‖

line slots:
  ∂r/∂x2 =  wy/L − cross·(dx/L)/L²
  ∂r/∂x1 = −wy/L + dy/L + cross·(dx/L)/L²
  ∂r/∂y2 = −wx/L − cross·(dy/L)/L²
  ∂r/∂y1 =  wx/L − dx/L + cross·(dy/L)/L²
spline slots:
  ∂r/∂X_i = (−dy/L)·G_i                   ∂r/∂Y_i = (dx/L)·G_i
```

The line-slot columns come from four channels: `∂dx/∂x2 = +1, ∂dx/∂x1 = −1` and
`∂dy/∂y2 = +1, ∂dy/∂y1 = −1` (through `cross` and through `L`), the `−p_1` inside
`w` (through `cross` only: `+dy` on `x1`, `−dx` on `y1`), and the direction
normalization `−cross·∂L/L²`. The spline columns flow through `∂w = ∂C(t)` only.
All five channels accumulate in the `addInto`/`chain` construction above.

**Guards.**

- `L = 0` (zero-length line): inherits the existing rows' behavior (NaN residual →
  the solver's finite-parameters check classifies the failure). No new guard.
- No candidates at all (every segment's derivative quadratic has no interior root —
  a monotone `s`): the candidate set still contains the two chain ends, so the
  anchor always exists. A monotone `s` that never crosses means the row has no zero —
  correct infeasibility, reported by the standard classification.
- Stationary root at `‖C'(t)‖ = 0` (a cusp): `s' = (dx·C'_y − dy·C'_x)/L = 0`
  automatically — the cusp is a spurious stationary candidate. Guard: skip
  candidates where `‖C'(t)‖ < 1e-9` (they are not tangency contacts; the tangent is
  undefined there). This is the one place the guard is semantic, not numerical.
- Anchor kink when the `|s|`-argmin switches candidates: the residual value is
  continuous (min of continuous functions), the gradient jumps — handled by the
  backtracking line search (§9).

### 1.4 Endpoint ("pinned") tangency — the composition that ships first

Tangency with the contact pinned to the spline's end is not a new kind; it is the
composition of rows that mostly exist:

```
pointOnEntity({spline, "end"} -> line)      1 row  (pointOnLineRow over the end point target)
cross(d, T_end) = 0                         1 row  (parallelRow's body with g2 = tangentExpr)
```

Codimension 2 — a strictly stronger constraint than anywhere-tangency (the contact
cannot slide), which is the correct semantics when the modeler has named the end. The
second row is §3's parallel row at a fixed parameter; its gradient is exact with no
anchor machinery at all (`t = 1` of the last segment).

### 1.5 G1 joint (spline↔spline, named ends) — ships first

For two splines meeting at coincident ends, G1 continuity is:

```
row 1..2: coincident({A,"end"}, {B,"start"})          (existing rows)
row 3:    cross(T_A_end, T_B_start) = 0               (mm² quadratic row)
```

`T_A_end` from `splineTangent(chainA, lastSegment, 1)`, `T_B_start` from
`splineTangent(chainB, 0, 0)`. Gradient:

```
row3  = T_Ax·T_By − T_Ay·T_Bx
∂row3/∂X_i^A = H_i^A · T_By        ∂row3/∂Y_i^A = −H_i^A · T_Bx
∂row3/∂X_i^B = −H_i^B · T_Ay       ∂row3/∂Y_i^B = H_i^B · T_Ax
```

Codimension 3, no anchors, exact gradients, zero solver changes. This is the
highest-value spline↔spline form (matching blend directions at a junction) and needs
none of §1.6's machinery.

### 1.6 Anywhere spline↔spline tangency — staged (needs auxiliary unknowns)

The anywhere form needs 3 equations (2 contact + 1 direction) with 2 free contact
parameters: codimension 1. There is no single-row elimination like §1.3's (the
line's sliding was what reduced `s(t)` to one variable; curve-curve contact does not
reduce). The frozen-anchor 3-row version reprojects both anchors per evaluation and
would report rank 3 — over-counting the constraint by 2. The principled fix is
Option A:

- `ParameterLayout` grows a constraint-owned auxiliary section: each
  `tangent(spline, spline)` constraint contributes 2 slots `(τ_A, τ_B)`, initialized
  at compile time from the deterministic mutual closest points of the two chord forms
  (vertex-projection of A's tessellation onto B and vice versa, best pair wins —
  deterministic).
- Rows: `C_A,x(τ_A) − D_B,x(τ_B)`, `C_A,y(τ_A) − D_B,y(τ_B)` (mm; gradients `G^A_i`
  on A's slots `+`, `G^B_i` on B's slots `−`), and `cross(T_A, T_B)` (mm⁴ quadratic —
  stiff; acceptable at model scale by the same note as the mm² rows, or normalize if
  fixtures demand) with the gradients of §1.5 plus the `τ` columns
  `∂/∂τ_A = C_A'(τ_A)` etc.
- `unpackSolvedParameters` ignores trailing auxiliary slots (it maps per entity);
  the leave-one-out classifier keeps dropped constraints' `τ` slots as zero-step
  free directions — harmless.

This is a designed, bounded solver-surface change; it is deliberately **staged behind**
everything else in §10.

### 1.7 Degeneracy guards (summary for §1)

1. Skip stationary candidates with `‖C'‖ < 1e-9` (cusp guard, §1.3).
2. Zero-length line: inherit existing classification behavior.
3. Control-flavor junction anchors are excluded by construction (§1.3); the
   interpolated flavor is C¹ so its junctions are covered consistently from either side.
4. Chord-form honesty: only the anchor location is chord-form-derived (within the
   0.01 mm deflection discipline); the residual value and gradient are evaluated on
   the true curve at that parameter — so a converged solution is a true tangency,
   not a chord-form one. (This is deliberately tighter than the shipped
   `pointOnSplineRow`, whose value is the chord-form distance; do not retrofit — its
   behavior is pinned by tests.)

### 1.8 Worked example (first unit test) and solve-strategy note

Spline `S` (control flavor): points `(0,0), (1,2), (3,2), (4,0)` — "the arch".
Line `ℓ` from `(0, 1.5)` to `(4, 1.5)`: `d = (4, 0)`, `L = 4`.

- `y(t)` has control values `(0, 2, 2, 0)`; the stationary quadratic has controls
  `3(2, 0, −2) = (6, 0, −6)`, power form `−6 + 6t +…`: roots at `t = 1/2` only.
- Candidate `s` values: `s(1/2) = 1.5 − 1.5 = 0`; ends `s(0) = s(1) = −1.5`.
- Anchor `= (segment 0, t = 1/2)`; **`r = 0` exactly** (the curve's apex
  `C(1/2) = (2, 1.5)` sits on the line with tangent `C'(1/2) = (4.5, 0)` — horizontal).
- Gradient spot entries: `G_{P1}(1/2) = B_1(1/2) = 3/8`, so
  `∂r/∂P_{1y} = (dx/L)·(3/8) = 3/8 = 0.375` and `∂r/∂P_{2y} = 0.375`. On the
  line's side, the corrected table gives the start-slot partial
  `∂r/∂y_1 = (wx − dx)/L = (2 − 4)/4 = −0.5` (moving only the start tilts the
  line through the apex by half the offset); translating the whole line (both y
  slots together) moves `r` by −1 per mm, as expected for an offset. Raising the
  line to `y = 2` gives `r = −0.5`; Gauss–Newton restores tangency — the SOLVE
  ENDPOINT is the touch: the solved curve meets the line at a stationary
  contact of the signed distance (the Seidel iteration settles it wherever the
  columns take it; a one-step solve moving only `P_{1y}/P_{2y}` would take
  `Δ = 2/3` each at `3/8 + 3/8 = 3/4` per mm, but the full least-squares step
  distributes the correction over all four y-columns by their Bernstein
  weights) — the fixture assertion is the touch, found via the derivative
  roots, not a specific Δ.

**Solve strategy.** The row is mm-scaled like `pointOnLineRow`, so tolerance
semantics are unchanged. Expect roughly twice the iterations of a smooth row (linear
Seidel rate in the anchor); the 128-iteration cap is ample for deflection-scale
anchor drift. The per-evaluate cost is one anchor search (O(V) over chord vertices
for nothing — actually O(S) quadratic roots over S segments plus 2 end evaluations;
cheaper than `projectOntoSpline`'s O(V) scan).

---

## 2. Perpendicular line↔spline

The repo's line↔line `perpendicular` is **direction-only** (`dot(d_1, d_2) = 0`, no
contact required). The spline cousin keeps that convention — the line's direction is
perpendicular to the spline's tangent at a **named** end (an "anywhere" direction-only
constraint is vacuous: a spline's tangent sweeps all directions):

```
r = dot(d, T_at) = dx·T_x + dy·T_y        (mm² — perpendicularRow's scale)
```

with `T_at = splineTangent(chain, endSegment, endT)` (or `…, 0, 0` for `"start"`).
Gradients (exact, no anchors):

```
∂r/∂dx = T_x   -> x2: +T_x, x1: −T_x
∂r/∂dy = T_y   -> y2: +T_y, y1: −T_y
∂r/∂X_i = H_i·dx,      ∂r/∂Y_i = H_i·dy          (H_i = H_i(end parameter))
```

This is literally `perpendicularRow` with the second `lineGeom` replaced by
`tangentExpr`. Full "meets at 90°" semantics = this row + a contact row
(`pointOnEntity` at the same end, or tangency's composition §1.4) — the same layering
the line↔line kind already implies.

**Guards.** `‖T_at‖ = 0` (a control spline may legally have `P_1 = P_0` up to the
per-segment endpoint rule): the row reads 0 vacuously. Return the value with the
gradient as computed (linear in `T` — no division) and document the vacuity; the
burden sits with the fixture. Optional follow-up (out of scope here): a post-solve
end-tangent-norm check in `solvedParametersAreFinite` when such constraints exist.

**Worked example.** Arch `S`; line from `(2, 0)` to `(2, 3)` (`d = (0, 3)`). At the
apex: contact `r₁ = (dx·wy − dy·wx)/L = (0·1.5 − 3·0)/3 = 0`; perpendicularity
`r₂ = dot(d, C'(1/2)) = 0·4.5 + 3·0 = 0`. For the end-tangent row form:
line `(0,0) → (−2, 1)`: `dot((−2,1), T_start = (3,6)) = −6 + 6 = 0`.
Gradient spot check: at a start anchor `H_{P0}(0) = B'_0(0) = −3`, so
`∂r/∂P_{0x} = H·dx = (−3)(−2) = 6`. Verify by finite difference: move `P_0` to
`(ε, 0)`; then `T_start = 3((1,2) − (ε,0)) = (3 − 3ε, 6)` and
`r = −2(3 − 3ε) + 1·6 = 6ε`, so `dr/dε = 6` ✓.

---

## 3. Parallel / anti-parallel line↔spline tangent direction

Same convention as §2, with `parallelRow`'s cross product:

```
r = cross(d, T_at) = dx·T_y − dy·T_x       (mm²)
∂r/∂dx = T_y (x2: +T_y, x1: −T_y);  ∂r/∂dy = −T_x (y2: −T_x, y1: +T_x)
∂r/∂X_i = −H_i·dy,      ∂r/∂Y_i = H_i·dx
```

The cross form is sign-blind (parallel and anti-parallel both zero) — the existing
`parallelRow` convention ("either sense"). A signed anti-parallel-only variant has no
row here: `dot + cross` pairs reintroduce the supplementary false zeros the angle
row's comment rejects; if a directed form is ever needed it belongs to a new kind,
not an overload.

End tangents are the meaningful anchor (§2's vacuity argument). The closed forms of
§0.2 make the zero set flavor-independent: `T ∝ (P_1 − P_0)` both flavors, so
`cross(d, T) = 0 ⟺ cross(d, P_1 − P_0) = 0` — only the row's scale differs
(3 vs 1/2 — a 6:1 row-weight ratio between flavors; harmless under RMS scaling, and
worth one assertion in tests).

**Worked example.** Line `(0,0) → (1,2)`, arch start tangent `T_start = (3,6)`:
`cross((1,2),(3,6)) = 1·6 − 2·3 = 0`. Interpolated flavor: fit points
`(0,0), (3,0), (3,3), (0,3)`; `T_start = (P_1 − P_0)/2 = (1.5, 0)`; line `(0,0)→(1,0)`:
`cross((1,0),(1.5,0)) = 0` ✓.

---

## 4. Angle between line and spline tangent

`angleRow`'s convention, verbatim, with the second line replaced by the end tangent:

```
r = dot(d, T)/(L·‖T‖) − cos θ        (dimensionless)
```

The existing row is deliberately **unsigned** (φ the angle in `[0, π]`, zero set
`φ = θ`, "the supplementary angle is never a false zero the way sin(θ − φ)'s is").
"Matching the existing convention" means adopting exactly this: the spline's tangent
direction is well-defined (increasing parameter) and the line's by start→end, so the
unsigned angle between them is as well-defined as between two lines. A signed
(atan2/cross) variant is rejected for the same reason the existing row's comment
rejects it.

Gradient — the `angleRow` quotient with `L₂ → ‖T‖` and its own gradient map:

```
∂dot   = T_x ∂dx + T_y ∂dy + dx·∂T_x + dy·∂T_y        (line slots as in §2/§3;
                                                        spline: ∂T_x on X_i is H_i·dx etc.)
∂(L‖T‖)= ‖T‖·(dx/L)·∂dx + ‖T‖·(dy/L)·∂dy + L·(T_x/‖T‖)·∂T_x + L·(T_y/‖T‖)·∂T_y
∂r     = (∂dot·L‖T‖ − dot·∂(L‖T‖)) / (L‖T‖)²          (per slot, as angleRow accumulates)
```

Per spline slot: `∂r/∂X_i = H_i·[dx − (dot/‖T‖)(T_x/‖T‖)] / (L·‖T‖)` and the y
counterpart. **Guard**: `‖T‖ = 0` → return `{ value: −cosθ, grad: empty }` (the
`distanceRow` zero-distance delegation pattern).

**Worked example.** Spline `P_0 = (0,0), P_1 = (3,4), …` (so `T_start = (9,12)`);
line `(0,0) → (4,3)` (`L = 5`): `dot = 72`, `‖T‖ = 15`,
`r = 72/75 − cosθ = 24/25 − 24/25 = 0` at `θ = acos(24/25)`. Exact rationals
throughout — usable as an exact-to-bit test via `acos(24/25)` on both sides.

---

## 5. Equal / radius / diameter on splines — honest scoping

**Radius/diameter: decline stays.** A spline has no radius parameter; nothing in the
entity or the row vocabulary gives "the radius of a spline" a meaning. (Local
curvature `κ(t)` exists but is neither stored nor authored; dimensioning it is a
different feature.)

**"Equal" has two meaningful forms.**

**(a) Equal endpoint chord (recommended, exact).** The distance between the spline's
first and last stored points — the same notion `equal` uses for lines (their
endpoint distance), and it is expressible today via `distance` on point targets. As
an `equal(spline, spline)` row it is `equalRow`'s line branch with point targets
resolved to spline ends:

```
r = ‖P^A_end − P^A_start‖ − ‖P^B_end − P^B_start‖        (mm)
∂r/∂(end.x of A)   = (P_end.x − P_start.x)/chordA         (and symmetric for every slot)
```

Gradient: the `distanceRow` chain (`chain(dxExpr.value/dist, dxExpr.grad, …)`) minus
its counterpart — literally `equalRow`'s `g1.dLength − g2.dLength` shape fed by
endpoint expressions. **Guard**: zero chord (`P_0 = P_{N−1}` is constructible on
control splines with ≥ 7 points) → delegate with a zero subgradient, as `distanceRow`
does. Mixed pair `equal(line, spline)` = line length vs spline endpoint distance —
same row, one side from `lineGeom`.

**(b) Equal arc length (staged, quadrature-banded).** True arc length
`Λ = Σ_seg ∫₀¹ ‖C'(t)‖ dt` has no elementary closed form (elliptic). Fix a
deterministic quadrature — 4-node Gauss–Legendre per segment, nodes
`t = 1/2 ± 1/2·√(3/7 ± (2/7)√(6/5))`, weights `(18 ± √30)/36` — and define the row
on the quadrature sum:

```
r = Λ_gl(A) − Λ_gl(B)
Λ_gl  = Σ_seg Σ_nodes w_j·‖C'(t_j)‖
∂Λ_gl/∂X_i = Σ_nodes w_j·(C'_x(t_j)/‖C'(t_j)‖)·H_i(t_j)      (same for Y)
```

The zero set is "equal quadrature lengths"; since both sides use the identical fixed
rule, the difference of rule errors bounds the distance to true equal-length — the
band honesty the profile domain already uses elsewhere. **Guard**: a node with
`‖C'(t_j)‖ = 0` contributes 0 with zero gradient (limit of `C'/‖C'‖` is undefined;
the subgradient delegates). Because arc length's first variation only sees tangential
displacement, interior control points of a straight spline have zero partials —
a sharp gradient test (below).

**Worked examples.**
(a): the arch (chord `‖(4,0)‖ = 4`) vs its mirror `[(0,0),(1,−2),(3,−2),(4,0)]`
(chord 4): `r = 0`; `∂r/∂P^A_{3x} = (4−0)/4 = 1`.
(b): collinear control splines `(0,0),(1,0),(2,0),(3,0)` and `(0,0),(0,1),(0,2),(0,3)`
— `C'` constant, any quadrature exact, both lengths 3, `r = 0` exactly. Gradient
partials: `∂Λ/∂P_{0x} = −1`, `∂Λ/∂P_{3x} = +1`, all four interior partials `0`
(verify: `∫B'_j = B_j(1) − B_j(0) = 0` for `j = 1, 2`).

---

## 6. Collinear point-with-spline-tangent / spline-through-point

Three candidate meanings; one exists, one is derived here, one is derived and
rejected:

**(a) Spline-through-point — exists.** `pointOnEntity(point, spline)` is the shipped
frozen-parameter projection row. Nothing new.

**(b) Point on the spline's END-tangent line (derived; ships).** The point target
`P` lies on the line through the spline's end `E` along its end tangent `T`:

```
r = cross(T, w) / ‖T‖        (mm — signed distance to the tangent line)
    w = P − E,   cross = T_x·w_y − T_y·w_x

∂r/∂P_x = −T_y/‖T‖                ∂r/∂P_y = T_x/‖T‖
∂r/∂E_x = +T_y/‖T‖                ∂r/∂E_y = −T_x/‖T‖        (the end point's two slots)
∂r/∂T_x = w_y/‖T‖ − cross·T_x/‖T‖³
∂r/∂T_y = −w_x/‖T‖ − cross·T_y/‖T‖³
```

and `T`'s slots are the stored points through the tangent weights: for a
control-flavor start anchor, `T = 3(P_1 − P_0)` gives `∂T/∂X_1 = +3`,
`∂T/∂X_0 = −3` (both axes); for an interpolated start anchor the weights are
`(+1/2, −1/2)`; for interior anchors use `H_i(t)` per §0.3. Accumulate with the
`pointOnLineRow` pattern where the "line" is `(p_1, d) = (E, T)`, all channels
explicit (this row's `E` terms are direct slot gradients through a point
expression — no `lineGeom` start, so the §1.3 omission cannot recur):
`dCross` receives `addInto(P_x-grad, −T_y)`, `addInto(P_y-grad, +T_x)`,
`addInto(E_x-grad, +T_y)`, `addInto(E_y-grad, −T_x)`, `addInto(T_x-grad, w_y)`,
`addInto(T_y-grad, −w_x)`, then `grad = chain(1/‖T‖, dCross, −cross/‖T‖³ … )`
with the `‖T‖` normalization accumulated per slot as
`−cross·(T_x·∂T_x + T_y·∂T_y)/‖T‖³`. For the control flavor this is literally
"collinear with `P_0, P_1`" (`T_start ∥ P_1 − P_0`).

**Guard**: `‖T_at‖ = 0` → zero subgradient delegation.

**Worked example.** Arch start: `P_end = (0,0)`, `T_start = (3,6)`.
`P = (1,2)`: `cross((3,6),(1,2)) = 3·2 − 6·1 = 0` → `r = 0`.
`P = (1,3)`: `cross = 3`, `r = 3/√45 = 1/√5 ≈ 0.4472136` (the distance from
`(1,3)` to the line `y = 2x`).

**(c) Point on the tangent at the closest curve point — derived and REJECTED.**
Anchor `τ` = the closest point of the curve to `P` (what `projectOntoSpline`
returns); the row `cross(C'(τ), P − C(τ))/‖C'(τ)‖`. The closest-point property is
`(P − C(τ)) ⟂ C'(τ)` — the row then asks a perpendicular segment to be parallel,
which happens only when `P = C(τ)`. The zero set collapses onto `pointOnEntity`
with worse conditioning: the anchored form is not an independent constraint and must
not ship. (An anchored tangent-line row IS meaningful with a _named_ parameter —
which is (b) — or with the §1.6 auxiliary unknowns.)

---

## 7. `pointOnEntity` on composites (polygon, slot)

### 7.1 Semantics: which constituent, and how the discrete choice resolves

`pointOnEntity(P, composite)` means **P lies on the composite's boundary** — a
disjunction over constituents. The repo's solver has no branch machinery, and
`ResidualRow.evaluate` must stay a pure function of the parameters (the backtracking
line search evaluates out-of-order candidates; any stateful row would make results
depend on evaluation order and break the pinned determinism). Therefore:

- **Not** N simultaneous rows (that intersects the constituents — vertices only).
- **Not** stateful hysteresis across evaluations (purity/determinism, above).
- **Chosen: stateless per-evaluation argmin (the Danskin min-row).**
  `r(x) = min_k d_k(x)` where `d_k` is the exact distance from P to constituent `k`
  as a set; the row's gradient is the active constituent's gradient at the argmin.
  The value is continuous (min of continuous functions); the gradient has a kink on
  the constituents' bisector. Tie-break: strict `<` with lowest constituent index
  winning — the `projectOntoSpline` convention. The line search rejects any step
  whose post-switch evaluation raises the RMS, which is the hysteresis this
  architecture can honestly offer; pathological switching stalls and is classified
  by the existing failure machinery.
- Rank: 1 row of rank 1 → removes 1 degree of freedom, matching `pointOnEntity` on
  every other kind.

### 7.2 Polygon (n line segments)

Vertices (exact, with gradients — the `pointExpr` polygon machinery generalized from
vertices 0/1 to any `k`):

```
θ_k   = ρ + 2πk/n,   R_eff = r·σ,   σ = 1 (inscribed) or 1/cos(π/n) (circumscribed)
V_k   = (cx + R_eff·cos θ_k,  cy + R_eff·sin θ_k)
∂V_k/∂cx = (1,0)   ∂V_k/∂cy = (0,1)
∂V_k/∂r  = σ·(cos θ_k, sin θ_k)
∂V_k/∂ρ  = R_eff·(−sin θ_k, cos θ_k)
```

(`sides` and `fit` are discrete parameters, not unknowns — the existing layout rule.)

Constituent `k` is the **segment** `V_k → V_{k+1 mod n}` (the boundary, not the
infinite lines — a closed boundary's "on the entity" means on the perimeter). The
segment distance with its frozen-foot gradient:

```
d_k   = ‖w − u_k·d_k^{vec}‖,   w = P − V_k,   d_k^{vec} = V_{k+1} − V_k
u_k   = clamp(dot(w, d_k^{vec}) / ‖d_k^{vec}‖², 0, 1)          (frozen)
∂d_k/∂(·) = +ûᵀ·(∂w − u_k·∂d_k^{vec}),   û = (w − u_k·d_k^{vec}) / d_k    (d_k > 0)
        (û points from the frozen foot to P, so moving P along û grows d_k;
        the worked example below — ∂r/∂cy = −0.7071 — confirms this sign)
```

Freezing `u_k` is envelope-exact for interior feet (`∂/∂u = 0` at the projection)
and a valid subgradient at clamped feet (endpoint contact) — the same clamped-u
structure `projectOntoSpline` uses on chords. `d_k = 0` (P exactly on the segment):
return 0 with the line-distance gradient of the containing segment (delegation).

**Guards.** A regular polygon's edges have equal positive length (`r > 0`, `n ≥ 3`
invariants), so `‖d_k^{vec}‖ > 0` always. Solutions exactly on a bisector: the
tie-break picks index `k = 0`-first; the DoF count is unaffected (rank 1 either way).

**Worked example.** Polygon `n = 4`, `ρ = 0`, `r = 5`, `inscribed`, center `(0,0)` —
the diamond with vertices `(5,0), (0,5), (−5,0), (0,−5)`. Edge 0 is
`(5,0) → (0,5)`.
`P = (2.5, 2.5)`: `w = (−2.5, 2.5)`, `u_0 = 0.5` (interior foot) → `d_0 = 0`;
all other `d_k > 0` → **`r = 0`**.
`P = (2.5, 3)`: `u_0 = 0.55 ∈ (0,1)`, `d_0 = |cross|/L = |(−5)(3) − (5)(−2.5)| / (5√2)
= 2.5/(5√2) = 1/(2√2) ≈ 0.3535534` — and edge 0 is the argmin (edge 1 is farther).
Gradient spot check via the polygon slots: moving `cy` by `ε` slides `V_0, V_1` up —
`∂d_0/∂cy = −û_y` with `û = (w − u·d)/‖·‖ = ((−2.5,3) − 0.55·(−5,5))/d =
(0.25, 0.25)/0.35355 → û = (0.7071, 0.7071)` → `∂r/∂cy = −0.7071` (plus the `cx/ρ/r`
columns through the `∂V_k` table).

### 7.3 Slot, straight variant (2 arcs + 2 lines)

Unknowns `(x1, y1, x2, y2, r)`; `c_1 = (x1,y1)`, `c_2 = (x2,y2)`, `d = c_2 − c_1`,
`L = ‖d‖`, `â = d/L`, `n̂ = (−dy, dx)/L`. The boundary constituents:

```
top edge    : segment  c_1 + r·n̂  →  c_2 + r·n̂
bottom edge: segment  c_1 − r·n̂  →  c_2 − r·n̂
right cap  : semicircle  {c_2 + r·(cos φ, sin φ) : φ ∈ [−π/2, π/2]}   (gate: dot(P − c_2, â) ≥ 0)
left cap   : semicircle  mirrored about c_1                              (gate: dot(P − c_1, â) ≤ 0)
```

Rows (min over 4 gated constituents; each is exact on its gate):

- **Edges**: §7.2's segment distance with endpoint expressions
  `E = c_i ± r·n̂`, whose gradients need `∂n̂/∂` (from `n̂ = (−dy, dx)/L`):

```
∂n̂_x/∂x1 = −dx·dy/L³      ∂n̂_x/∂x2 = +dx·dy/L³
∂n̂_x/∂y1 = dx²/L³         ∂n̂_x/∂y2 = −dx²/L³
∂n̂_y/∂x1 = −dy²/L³        ∂n̂_y/∂x2 = +dy²/L³
∂n̂_y/∂y1 = dx·dy/L³       ∂n̂_y/∂y2 = −dx·dy/L³
∂E/∂r = ±n̂                 (∂E/∂(slots of c_i) = I ± r·∂n̂/∂)
```

- **Caps**: inside the gate, `d_cap = ‖P − c_i‖ − r` — **exactly the existing
  `pointOnCircularRow` body** with `center = c_i`'s slots and the `r` slot; the gate
  is precisely the condition that the nearest point of the full circle lies on the
  semicircle, so the gated value is the true distance to the arc. Outside the gate
  the cap is not a candidate (its nearest points belong to the edges, which are in
  the min).

The min over the four gated constituents equals the true distance to the slot
boundary (each constituent exact on its active domain), so the row is continuous
with the active constituent's gradient — rank 1, Danskin as in §7.1.

**Guards.** `L > 0` and `r > 0` are entity invariants; a point exactly on the gate
boundary (`dot(P − c_2, â) = 0`) is equidistantly covered by the cap apex and the
edge endpoints (both give the same value) — the tie-break picks the lower
constituent index deterministically. `P = c_i` (cap center): `‖P − c_i‖ = 0` —
degenerate delegation as in `pointOnCircularRow`.

**Worked example.** Slot `c_1 = (0,0)`, `c_2 = (6,0)`, `r = 2` (`d = (6,0)`,
`L = 6`, `n̂ = (0,1)`; top edge `(0,2) → (6,2)`):

- `P = (3, 2)`: top edge, `u = 0.5` interior → **`r = 0`**. `∂r/∂r_slot = −1`
  (raising the cap radius moves the edge up by `n̂_y = 1`; check: `r → 2 + ε`
  gives `r_row = −ε`).
- `P = (8, 0)`: right cap (gate `dot((2,0),(1,0)) = 2 ≥ 0`), `‖(2,0)‖ − 2 = 0` →
  **`r = 0`** with the circular row's gradient: `u = (P − c_2)/‖·‖ = (1, 0)`,
  so `∂r/∂x2 = −u_x = −1` (moving the cap center toward the point pushes the
  boundary past it — the signed row reads negative) and `∂r/∂radius = −1`.
- `P = (7, 0)`: gate passes, `|1 − 2| = 1` → **`r = 1`**; edges are farther
  (`d ≥ 2`), so the cap is the argmin.

**arc3 scoping (honest).** The arc3 slot's boundary arcs are offsets of the
centerline circumcircle, whose center/radius are rational functions of the three
centerline points — the rows exist by the same pattern with the circumcircle's
gradient chained in (6 partials per point; derivable from `circumcircleOf`'s closed
form), but the algebra is heavy and the physicality coupling (`R_centerline > r`) is
already solver-enforced. Recommendation: ship `straight` now, decline `arc3` with the
existing `sketch/constraint-unsupported` phrasing until the straight-slot row has
fixture coverage.

---

## 8. Exact spline×axis crossing: certified Bézier clipping

### 8.1 What is being replaced and why

`segmentSignedExtremes`'s spline branch (in `packages/cad-kernel/src/profile-geometry.ts`)
samples the tessellation vertices — the module admits the gap: "can miss only a
crossing confined strictly between adjacent stations within the deflection". That gap
is real and constructible: spline with `x`-controls `(0, 1, 3, 4)` and `y`-controls
`(0, δ, −δ, 0)` for `δ = 0.001 < SPLINE_TESSELLATION_DEFLECTION_MM = 0.01` crosses
the x-axis transversally at `t = 1/2` with amplitude `3δ·max_t[ut(u−t)] = δ·√3/6 ≈
0.000289 mm` (extremes at `t = (3 ± √3)/6`), but the flatness criterion passes
at depth 0 (`δ ≤ 0.01`), the
tessellation emits only the endpoints, the sampled extremes are `(0, 0)`, and
`revolveCrossesAxis` reports **no crossing** — the silent far-side clip the check
exists to prevent. The fix: compute **certified** extremes of the signed distance by
convex-hull subdivision instead of sampling.

### 8.2 The reduction: signed distance is an exact scalar cubic

The signed distance to the axis frame is affine in the point:
`s(q) = u_frame·(q_y − o_y) − u_frame… ` (the `axisSignedDistance` linear form).
Affine composition preserves Bézier form **exactly**: on a Bézier segment,

```
s(C(t)) = Σ_j B_j(t)·g_j,     g_j = s(b_j)      (no approximation — the g_j are exact)
```

so the problem reduces to: certified `min`/`max` of a scalar cubic in Bézier form on
`[0, 1]`, judged against the touch tolerance `τ = REVOLVE_AXIS_TOUCH_TOLERANCE_MM
= 1e-9` and the crossing rule `crossing ⟺ min < −τ ∧ max > τ`.

### 8.3 The algorithm (fat-line / Lane–Riesenfeld subdivision with exact leaves)

The 1-D fat line: the curve `g(t)` lies in the band `[min_j g_j, max_j g_j]` (the
Bernstein basis is nonnegative and sums to 1 — the convex hull property). Two leaf
certifications, then recursion:

```ts
// certifiedExtremes(g0..g3, depth) -> { lo, hi, exact }   with [lo, hi] ⊇ [trueMin, trueMax]
// 1. MONOTONE TEST (exact): the derivative's Bernstein controls are
//        q = (3(g1 − g0), 3(g2 − g1), 3(g3 − g2))          (a quadratic)
//    if min(q)·max(q) > 0 (hull one-signed): g is monotone on [0,1];
//    return { min(g0, g3), max(g0, g3), exact: true }      — no approximation.
// 2. HULL TEST (cheap): if max(q)_hull and min(q)_hull straddle 0 AND the leaf's
//    s-hull width max(g) − min(g) ≤ ε: return { min g_j, max g_j, exact: false } (ε-certified).
// 3. SUBDIVIDE: de Casteljau midpoint split (Lane–Riesenfeld); recurse on both
//    halves with depth + 1; the split point g0123 = g(1/2) is an exact on-curve value.
// 4. DEPTH CAP D: return the leaf hull (conservative — over-approximates the spread,
//    so a crossing decision made with it errs toward rejection, the safe side).
```

The achieved extremes are certified from both sides: every visited interval endpoint
is an on-curve value (controls `g_0`, `g_3` of any leaf are `g` at dyadic
parameters), so `max_sample ≤ trueMax ≤ max_hull` and `min_hull ≤ trueMin ≤
min_sample`. Crossing is therefore certified **exhibitorily** (a sampled value above
`+τ` and one below `−τ`), and non-crossing is certified **universally** (a hull with
`min_hull ≥ −τ`, or `max_hull ≤ τ`) — the asymmetry that makes the algorithm correct:
only the non-crossing direction needs the hull, and the hull is exactly what
tightens under subdivision.

### 8.4 Termination bound and worst-case cost

- **Hull contraction.** For a smooth `g` restricted to an interval of length `h`,
  the hull width is `≤ M_1·h + (M_2/4)·h²` (`M_1 = max|g'|`, `M_2 = max|g''|`); the
  derivative hull (a quadratic) contracts in its `h²` term only:
  `width_q(h) ≤ C·|g'''|·h²` (`q'' = g'''` constant for a cubic). At a simple
  critical point (`g'' ≠ 0`) the derivative hull one-sign certifies once
  `C·|g'''|h² < |g''|·h/2`, i.e. at `h = O(|g''|/|g'''|)` — **finite depth,
  quadratic convergence**, `D ≈ ½·log₂(M/ε)` in the generic case.
- **Live-interval count.** Only intervals whose derivative hull straddles 0 (or
  whose s-hull straddles the ±τ band edges) subdivide. A cubic has ≤ 2 critical
  points and crosses any level ≤ 3 times, so live intervals per level are bounded
  (≈ 10 worst case with band-edge straddles), giving **O(10·D) nodes, each O(1)**
  (12 adds / 6 multiplies for the scalar de Casteljau + hull min/max) per Bézier
  segment — comparable to or cheaper than the current O(V) vertex scan
  (`V` up to `2^10` per segment).
- **Degenerate critical points.** A double root of `g'` (an inflection-seat
  critical point, e.g. `g' ∝ (t − t_0)²`) never one-sign-certifies through the hull
  (the middle control of a nonnegative quadratic can be negative, e.g.
  `(t − ¼)²` on `[0, ½]` has controls `(1/16, −1/16, 1/16)`). Two outs, both in the
  spec: (i) the closed-form quadratic-formula leaf test resolves it exactly
  (`A = q0 − 2q1 + q2`, `Bq = 2(q1 − q0)`, discriminant, roots in `(0,1)`) —
  recommended as leaf test 1b; (ii) failing that, the depth cap degrades gracefully
  to a hull bound of width `≤ M_1·2^{−D}` — with `D = 24` and `M_1` at model scale
  (100 mm) that is ≈ 6e−6 mm: wider than `τ`, and the conservative decision rule
  (§8.3 step 4) reports crossing — the safe direction for a revolve that would
  otherwise silently clip. **Recommended cap: `D = 24`** (for scale 100 mm and
  `τ = 1e-9`, `½·log₂(M₂/τ) ≈ 18` generic levels, plus degenerate headroom).

### 8.5 Reduction to the existing exact checks (the analytic kinds)

- **Line**: `s` along a line is degree 1 — the derivative hull is a point
  (`q = (Δ, Δ, Δ)`), always one-signed → certified exact at depth 0 with extremes at
  the endpoints: precisely the existing `segmentSignedExtremes` line branch.
- **Degenerate Bézier (collinear controls)**: the same monotone test fires
  immediately (or the hull equals the endpoint spread) — the clipping inherits the
  line behavior.
- **Arc / circle / ellipse family**: the existing analytic branches (sin extrema at
  `φ ± π/2`; the `K + R_m sin(t + ψ)` form) are already exact — strictly better than
  any polynomial approximation. The clipping is only needed by the `spline` kind;
  the unified surface is `certifiedExtremes(segment) → {lo, hi}` with each kind
  contributing its exact or certified implementation.
- **Shared primitive.** §1.3's stationary-anchor roots and this section's leaf tests
  are the same scalar-cubic machinery; implement once per side of the deliberate
  sketch/kernel mirror (`spline-math.ts` ↔ `profile-splines.ts`, which the contract
  tests pin to identical behavior).

### 8.6 Worked examples (first unit tests)

1. **Non-crossing certified at depth 0.** The arch's `y`-controls `(0, 2, 2, 0)`
   against the x-axis: hull `[0, 2]` is one-sided (`min_hull = 0 ≥ −τ`) → no
   crossing; the endpoints touch (legal touching). Zero subdivisions.
2. **Crossing certified with samples + subdivision trace.** `y`-controls
   `(0, 3, −3, 0)`: hull `[−3, 3]` straddles; one de Casteljau split gives halves
   with controls `(0, 1.5, 0.75, 0)` (hull `[0, 1.5]`, non-negative side certified)
   and `(0, −0.75, −1.5, 0)` (hull `[−1.5, 0]`). On-curve samples `y(¼) = +0.84375`
   and `y(¾) = −0.84375` exceed `±τ` → **crossing certified**. Exact extremes for
   assertions: critical points at `t = (3 ± √3)/6`, `max = √3/2 ≈ 0.8660254`,
   `min = −√3/2` (the monotone leaf or quadratic-formula leaf finds them exactly).
3. **The miss case (§8.1)**: `y`-controls `(0, 0.001, −0.001, 0)` — the tessellated
   check reports no crossing; the clipping certifies crossing via
   `y(¼) = +0.00028125`, `y(¾) = −0.00028125`.

---

## 9. Consolidated solve-strategy notes for the Gauss–Newton loop

1. **Row scales** follow the existing families (mm for contact/distance rows, mm²
   for cross/dot direction rows, dimensionless for angle, mm² for G1 cross, mm⁴ only
   in staged §1.6) — the "quadratic rows are effectively stricter" interpretation is
   unchanged.
2. **Anchors are pure and per-evaluation** (§1.3, §7.1): determinism is preserved
   because nothing closes over mutable state; the backtracking line search is the
   switch-hysteresis.
3. **Convergence character**: frozen-anchor rows converge linearly in the anchor
   (Seidel), quadratically in the entity parameters per anchor; budget ≈ 2× the
   iterations of a smooth row — far under the 128 cap for deflection-scale drift.
4. **Rank/DoF** is exact at solutions by the §0.4 lemma for every shipped row (each
   is either anchor-free or stationary/named-anchored); the two rejected
   formulations of §1.2 are the ones to not "simplify" into.
5. **Kinks** (constituent switches, candidate switches, clamped feet) are C⁰ in
   value with bounded gradient jumps — the line search rejects harmful steps;
   genuine thrash stalls and flows into the existing conflict/unsatisfiable
   classification, which is the honest report.
6. **Failure surfaces**: degenerate lines inherit existing behavior; zero tangents
   and zero chords delegate with zero subgradients (the `distanceRow` pattern);
   cusps are excluded from anchor candidates semantically (§1.7).

---

## 10. Implementation order

Files: R = `packages/cad-sketch/src/residuals.ts`, S = `packages/cad-sketch/src/spline-math.ts`,
C = `packages/cad-sketch/src/constraints.ts` (+ its tests), K = `packages/cad-kernel/src/profile-geometry.ts`
/ `profile-splines.ts`. Each stage leaves `pnpm run verify` green and shrinks
`SPLINE_SCOPE_UNSUPPORTED` / `pointOnEntityKindProblem` by exactly the kinds it implements.

| #   | Item                                                                                                               | File(s)      | Rows / primitives                                                        | First tests (numbers from this doc)                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `splineTangent` + `splineTangentGradient`                                                                          | S            | `C'` value + `H_i` map (§0.3)                                            | `Σ B'_j = 0`; arch `C'(½) = (4.5, 0)`, `C'(0) = (3,6)`, `C'(1) = (3,−6)`; interpolated `T_start = (1.5, 0)`, junction equality `(P_{i+2}−P_i)/2` both sides                    |
| 2   | `curvePointExpr` (LinExpr of `C(s,t)`)                                                                             | R            | value + grad via `splinePointGradient`                                   | apex weights `3/8` on `P_1/P_2` both axes                                                                                                                                      |
| 3   | fix `pointOnLineRow` + line↔circle tangent row `p1` columns (§1.3 convention note)                                 | R            | add `+dy` on `x1`, `−dx` on `y1` into `dCross`                           | finite-difference regression: `P = (0,1)`, line `(0,0)→(1,0)`: `∂r/∂y1 = −1`; sweep 3 randomized-then-pinned fixtures                                                          |
| 4   | `tangent(line, spline)` anywhere                                                                                   | R, C         | §1.3 row (remove `tangent` from the spline decline set)                  | arch + `y = 1.5`: `r = 0`, `∂r/∂P1y = 0.375`; line at `y = 2`: `r = −0.5` → GN converges with `ΔP1y = ΔP2y = ⅔`; cusp-candidate skip                                           |
| 5   | `parallel` / `perpendicular` / `angle` end-tangent rows (with the `at: "start" \| "end"` operand, default `"end"`) | R, C         | §2–§4 rows                                                               | `cross((1,2),(3,6)) = 0`; `dot((−2,1),(3,6)) = 0` (+ `∂r/∂P0x = 6` spot check); angle `24/75 − 24/25 = 0` at `acos(24/25)`; interpolated-flavor parallel `(1,0) × (1.5,0) = 0` |
| 6   | G1 joint rows (`coincident` + tangent cross at named ends)                                                         | R, C         | §1.5 (3 rows)                                                            | arch + mirror continuation `[(4,0),(5,−2),(7,−2),(8,0)]`: all rows 0; a kinked B variant converges to G1                                                                       |
| 7   | `equal` endpoint-chord on splines                                                                                  | R, C         | §5(a) row                                                                | arch vs mirror: `r = 0`, `∂r/∂P3x = 1`; mixed `equal(line, spline)`                                                                                                            |
| 8   | point-on-end-tangent-line                                                                                          | R, C         | §6(b) row                                                                | `(1,2)` on arch start tangent: `r = 0`; `(1,3)`: `r = 1/√5`                                                                                                                    |
| 9   | `pointOnEntity` on polygon                                                                                         | R, C         | §7.2 min-over-segments row                                               | diamond: `(2.5,2.5) → 0`; `(2.5,3) → 1/(2√2)`, edge-0 active, `∂r/∂cy = −√2/2`                                                                                                 |
| 10  | `pointOnEntity` on straight slot                                                                                   | R, C         | §7.3 row (cap = existing circular row body)                              | `(3,2) → 0` (`∂r/∂r = −1`), `(8,0) → 0` (cap), `(7,0) → 1`; arc3 stays declined                                                                                                |
| 11  | certified scalar-cubic extremes + spline axis-crossing                                                             | S, K         | §8.3 (shared primitive; replace `segmentSignedExtremes`'s spline branch) | hull `[0,2]` non-crossing at depth 0; `(0,3,−3,0)` crossing, exact `±√3/2`; the `δ = 0.001` miss case flips to crossing                                                        |
| 12  | (staged) anywhere `tangent(spline, spline)`                                                                        | R, S, solver | §1.6 aux-unknown design (3 rows + 2 slots)                               | two arches apex-to-apex; DoF counts 1 per tangency                                                                                                                             |
| 13  | (staged) equal arc length                                                                                          | R, C         | §5(b) GL4 row                                                            | collinear splines both length 3: `r = 0`; partials `±1` at ends, `0` interior                                                                                                  |

Order rationale: stages 1–3 are the shared primitives plus the regression fix they
expose; 4–6 close the headline declines with zero solver-surface change; 7–10 are
independent one-row additions; 11 fixes the kernel honesty gap and lands the
primitive 12 reuses; 12–13 are the bounded surface changes, deliberately last.
