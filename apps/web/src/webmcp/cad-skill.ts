/**
 * `cad_skill` — the agent-facing skill doc for the workbench's WebMCP
 * surface. One tool call returns a self-contained authoring guide: the
 * command vocabulary, serialized shapes, ID conventions, a worked batch,
 * and the failure modes that are silent from the outside. Served by the
 * site itself so agents learn the tool from the tool — no external docs.
 */

/** The skill document the `cad_skill` tool returns verbatim. */
export const CAD_SKILL_MARKDOWN = `# slopcad WebMCP skill — author CAD documents programmatically

You are driving the slopcad workbench through WebMCP. Everything below is
the tool's own documentation; follow it literally — every shape here is
the shape the strict parser enforces.

## The tools

- \`cad_get_document_summary\` — bodies (id, name, kind, visible), features
  (kinds in the timeline), parameters (id, name, value). Call FIRST to see
  what exists and which ids are already taken.
- \`cad_list_commands\` / \`cad_run_command\` — the workbench's nullary
  command-menu vocabulary (what the palette does). Not for authoring —
  authoring goes through \`cad_apply_commands\`.
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
| feature.create | id, kind, inputs, outputs | inputs: [{kind:"sketch"|"parameter"|"body"|"feature"|"datum", id}...] |
| feature.update | id + fields | wholesale-replaces kind/inputs/outputs |
| feature.delete | id | |
| feature.reorder | id, afterFeatureId | null moves to front |
| reference.create | id, name, reference | |
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
\`packages/cad-jsx/parametric-cup.commands.json\` in this repo — 73
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
8. \`body.update\` the starter plate \`{"id":"body_plate","visible":false}\`
   if the template document carries one — it pokes through the floor.

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
