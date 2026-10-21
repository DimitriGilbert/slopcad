/**
 * `cad_skill` — the agent-facing skill doc for the workbench's WebMCP
 * surface. One tool call returns a self-contained authoring guide: the
 * command vocabulary, serialized shapes, ID conventions, a worked batch,
 * and the failure modes that are silent from the outside. Served by the
 * site itself so agents learn the tool from the tool — no external docs.
 */

import { featureVocabularyMarkdown } from "./feature-vocabulary";

/** The skill document the `cad_skill` tool returns verbatim. */
export const CAD_SKILL_MARKDOWN = `# slopcad WebMCP skill — author CAD documents programmatically

You are driving the slopcad workbench through WebMCP. Everything below is
the tool's own documentation; follow it literally — every shape here is
the shape the strict parser enforces.

## The tools

- \`cad_get_document_summary\` — bodies (id, name, kind, visible, and the
  persistent face/edge inventory \`topology\`, computed on demand by this
  call from the visible scene), \`featureKinds\` (the feature kinds IN THE
  TIMELINE), parameters (id, name, value). Call FIRST to see what exists
  and which ids are already taken.
- \`cad_list_commands\` / \`cad_run_command\` — the workbench's nullary
  command-menu vocabulary (what the palette does), plus
  \`featureVocabulary\`: the authorable feature kinds with their canonical
  input layouts. The menu commands are not for authoring — authoring goes
  through \`cad_apply_commands\`.
- \`cad_set_parameter\` — { "id": "param_x", "value": 70 } (number, in the
  parameter's own unit — lengths are mm) or value as a STRING expression
  to install a defining expression. The key is \`id\`, not parameterId.
- \`cad_undo\` / \`cad_redo\` — one history commit each.
- \`cad_apply_commands\` — { "commands": [ ... ] }: strict-parses every
  entry, then applies ONE atomic transaction. Authoring happens here.
- \`cad_measure\` — kernel measurements of the settled scene (volume, area,
  bounds, triangles). See "Measuring" below for its subject rule.
- \`cad_skill\` — this document.

## cad_apply_commands — the command vocabulary

Every command is a JSON object with \`"formatVersion": 1\`, a \`"type"\`,
and an \`"id"\`. The batch is ATOMIC and ORDER-SENSITIVE: entities are
created before they are referenced. If any entry fails, NOTHING applies.

Command types and their required fields:

| type | required fields | notes |
| --- | --- | --- |
| parameter.create | id, name, value | value: { dimension, unit, value }, dimension ∈ length/angle/area/volume/dimensionless |
| parameter.set | id + (value OR expression) | literal write vs defining expression (serialized AST), never both |
| parameter.rename | id, name | |
| parameter.delete | id | |
| body.create | id, name | optional kind |
| body.update | id + at least one of name/visible/isolated/appearance/faceAppearances | use visible:false to hide a body — there is NO body.delete |
| sketch.create | id, name, sketch | sketch = { formatVersion: 2, workplane, entities, constraints } |
| feature.create | id, kind, inputs, outputs | inputs: [{kind:"sketch"|"parameter"|"body"|"feature"|"datum"|"reference", id}...] |
| feature.update | id + fields | wholesale-replaces kind/inputs/outputs |
| feature.delete | id | |
| feature.reorder | id, afterFeatureId | null moves to front |
| reference.create | id, name, reference | reference = a minted persistent payload from the summary's topology inventory (see Selection addressing) |
| datum.create | id, name, datum | |
| curve.create | id, name, curve | |
| configuration.* | id, ... | named document configurations |

## ID conventions — PREFIXES ARE ENFORCED

- parameters: \`param_*\` (e.g. \`param_baseWidth\`)
- bodies: \`body_*\`, features: \`feat_*\`, sketches: \`skd_*\`
- sketch entities: \`skent_*\`
- sketch constraint ids MUST start with \`skcon_\` (e.g. \`skcon_c0\`).
  Any other prefix makes the constraint FAIL PROFILE RESOLUTION
  SILENTLY — the feature reports Valid but its body never renders.

## sketch.create — the sketch payload

\`\`\`json
{
  "formatVersion": 1, "type": "sketch.create", "id": "skd_profile", "name": "profile",
  "sketch": {
    "formatVersion": 2,
    "workplane": {
      "origin": {"x": 0, "y": 0, "z": 0},
      "normal": {"x": 0, "y": -1, "z": 0},
      "xAxis":  {"x": 1, "y": 0, "z": 0}
    },
    "entities": [
      {"id": "skent_l0", "kind": "line", "construction": false, "fixed": false,
       "x1": 0, "y1": 0, "x2": 10, "y2": 0},
      {"id": "skent_c0", "kind": "circle", "construction": false, "fixed": false,
       "cx": 0, "cy": 10, "radius": 3}
    ],
    "constraints": [
      {"id": "skcon_c0", "kind": "coincident",
       "first": {"entity": "skent_l0", "point": "end"},
       "second": {"entity": "skent_l1", "point": "start"}},
      {"id": "skcon_d0", "kind": "distanceX",
       "first": {"entity": "skent_anchor", "point": "start"},
       "second": {"entity": "skent_l1", "point": "end"},
       "value": {"dimension": "length", "unit": "mm", "value": 50},
       "parameterId": "param_height"},
      {"id": "skcon_r0", "kind": "radius", "entity": "skent_c0",
       "value": {"dimension": "length", "unit": "mm", "value": 3},
       "parameterId": "param_tube"}
    ]
  }
}
\`\`\`

- A closed loop of connected lines revolves/extrudes into a SOLID; an open
  profile gives a surface.
- Constraint \`parameterId\` binds that dimension to a parameter — the
  parameter panel then re-solves the sketch live. This is parametric CAD.
- The revolve axis for a revolve is a construction line in the same
  sketch (\`"construction": true, "fixed": true\`).

## feature.create — kinds and inputs

\`inputs\` order matters: sketch first, then parameters the kind needs.

- \`revolve\` — inputs: [sketch, param_angle(rad), param_axis] —
  angle 6.2831853 = full, 4.7123889 = 270°.
- \`extrude\` — inputs: [sketch, param_height (direction encoded by sign)].
- \`union\` / \`subtract\` / \`intersect\` — inputs: [{kind:"feature", id} ...]
  referencing the PRODUCING features; outputs one body. Subtract:
  first input is the target, the rest are tools.
- \`hole\`, \`sweep\`, \`loft\`, \`helix\`, \`mirror\`, \`patternFeature\`,
  \`patternPath\`, \`scale\`, \`split\`, \`thicken\`, \`rib\`, \`sheet\`,
  \`duplicate\`, \`translate\`, \`rotate\` follow the same input rule —
  reference the producing feature ids, never body ids, in inputs.

## Primitives, edge/face ops, and the face pattern

These kinds author through ONE \`feature.create\` each; \`inputs\` follow
the declared order below, \`outputs\` is exactly one NEW body (never the
target's body). The same table is \`featureVocabulary\` in
\`cad_list_commands\` (the summary's \`featureKinds\` is different: the
kinds already in the timeline). Values outside a domain render NOTHING (the reader
refuses before any scene exists); a refused op shows its target instead.

${featureVocabularyMarkdown()}

Ops chain: a fillet's target may be a chamfer's feature, which targets a
box — each op's output body is the next op's target. Edge/face ops need
the OCCT kernel (the workbench default); a kernel without the capability
refuses structurally. \`deleteFace\` is declined by EVERY current kernel
(OCCT included) — the op always renders its target in its place.

## Selection addressing — persistent edge/face references

Fillet/chamfer/shell/moveFace/deleteFace/replaceFace/patternFace address
topology through REFERENCE inputs: \`{"kind": "reference", "id": "ref_…"}\`
naming a document reference record whose payload is a persistent
topology reference ON THE TARGET'S OWN BODY. Never invent the payload —
mint it from the inventory:

1. Build the target (e.g. a box) in one batch and let the scene settle
   (the inventory is queried from the VISIBLE scene when the summary is
   called; right after a batch it may still show the previous pass —
   check \`topology.regeneration\` moved, or call again).
2. \`cad_get_document_summary\` → \`bodies[i].topology.edges\` /
   \`.faces\`: each entry has \`ordinal\`, \`geometry\` (lengthMm / areaMm2,
   centroid — pick the entity by these), \`referenceId\`, and
   \`reference\` (the ready-to-store payload; \`null\` when the kernel's
   snapshot is not persistent). A very long body id gets a bounded
   \`referenceId\` (a prefix of the body id plus a digest); use it
   verbatim. \`referenced: true\` means a record
   under that id already exists — reuse the id instead of creating it
   again (unless that record went stale, below). The inventory stays
   available after an op consumes the target: a fillet's box, a refused
   op's target and every chained op's intermediate body all keep theirs.
   It is \`null\` only for a body the scene computed no solid for (hidden
   and unconsumed, not yet settled, its own scene refused, a sheet) or
   when the kernel reports no topology at all (Manifold: EVERY body is
   \`null\` — do not poll; edge/face selection needs OCCT).
3. Store it: \`{"formatVersion": 1, "type": "reference.create", "id":
   <referenceId>, "name": "edge0", "reference": <reference>}\`.
4. Consume it in the same batch:

\`\`\`json
{"formatVersion": 1, "type": "feature.create", "id": "feat_round",
 "kind": "fillet", "outputs": ["body_round"],
 "inputs": [{"kind": "feature", "id": "feat_box"},
            {"kind": "reference", "id": "ref_body_box_edge_0"},
            {"kind": "parameter", "id": "param_radius"}]}
\`\`\`

### The guarantee (what survives, what does not)

The stored payload is NAME-based (OCCT's \`occt-name/1\` identity, not
an ordinal): it re-resolves by name on every rebuild, so it SURVIVES
rebuilds and dimension edits — change the box's width parameter and the
fillet stays on the same edge. What it does NOT do is guess: a reference
into an entity that was DELETED, SPLIT into an ambiguous set, or produced
by an op that names nothing (an unnamed-op entity) is never silently
re-attached to a neighbour. It stands \`missing\`, then is repaired (a
bounded geometric repair that succeeds only with ONE candidate — it
refuses ambiguous twins or no candidate, never guesses) or refused, and
the state is NAMED: \`valid\`, \`repaired\`, or \`missing\` — a refusal
surfaces as \`reference-unresolved: … stands <state> (<reason>) …\` (plus the repair's own refusal when one was tried)
on the op's timeline status and the error surface, and the TARGET renders
in the op's place. A \`referenced: true\` record keeps its OLD identity
until you replace it. To re-select: re-read
the TARGET's inventory, pick the entity by geometry, store its current
\`reference\` under a fresh unused id (e.g. \`ref_body_box_edge_0_b\`),
then \`feature.update\` the op (its full kind/inputs/outputs) naming the
new id — the same path edits a working op's selection. A reference
minted on body A cannot address body B: mint from the TARGET's own
inventory (for a chained op, the previous op's output body).

A consumer's scene renders only when every consumed feature's computed
solid exists — the document emits producers before consumers, so put
feature.create entries for producers BEFORE the boolean that uses them
in the batch (creation order = dependency order).

## Parameters and expressions

\`parameter.create\` seeds a literal; a follow-up \`parameter.set\` with an
\`expression\` field installs a DERIVED parameter:

\`\`\`json
{"formatVersion": 1, "type": "parameter.set", "id": "param_innerR",
 "expression": {"kind": "binary", "operator": "-",
   "left": {"kind": "identifier", "name": "outerR"},
   "right": {"kind": "identifier", "name": "wallT"}}}
\`\`\`

Derived parameters appear in the viewer's Variables panel and recompute
when their inputs change — this is how the model becomes a parametric
app. Cycles and unknown identifiers are refused.

## Worked batch — a hollow cup (the proven pattern)

The reference implementation is
\`packages/cad-jsx/parametric-cup.commands.json\` in this repo — 72
commands that build a tapered hollow cup with six welded torus handles.
The pattern it proves:

1. \`parameter.create\` every driving dim (baseWidth, topWidth, height,
   wallT, handleMajor, handleTube).
2. \`body.create\` per output body.
3. \`sketch.create\` the outer profile — a CLOSED polygon loop whose
   segment endpoints are distanceX/distanceY constraints bound to params.
   The loop includes the axis edge; revolve gives a solid shell.
4. \`sketch.create\` the cavity profile + \`feature.create\` revolve →
   \`feat_cavity\`.
5. \`sketch.create\` + revolve per handle (angle param 4.7123889 = 270°
   torus arc; place each on a tilted workplane so both arc ends bury
   INTO the wall — any overlap welds in the boolean).
6. \`feature.create\` union over [outer, handles...] → \`feat_cup-union\`.
7. \`feature.create\` subtract [feat_cup-union, feat_cavity] → \`feat_cup\`.

The workbench boots a CLEAN empty document — no starter bodies or
parameters to hide or undo; the batch alone defines the model.

## Gotchas learned the hard way

- \`skcon_\` constraint prefix — silent failure otherwise (see above).
- One batch = one transaction. Undo once removes the whole model.
- Reload may restore a different document — keep the batch; re-applying
  it is safe (it fails cleanly if ids already exist — undo first).
- \`cad_measure\` reports ONLY the scene's measured subject (the primary
  visible body). To measure another body, hide the primary first via
  \`body.update\` {visible:false}; otherwise expect
  \`workbench/measure-subject-mismatch\`.
- Embedding handle/other-end geometry into a wall: kernel-verified weld
  needs only ANY overlap; check interior clearance so nothing breaches
  the cavity (intersect the tool solid with the cavity — target 0 mm³).
- Circular-pattern features require a rotation transform the Manifold
  kernel supports — but a parameter cannot drive pattern COUNT: emit one
  literal feature per copy instead.
`;
