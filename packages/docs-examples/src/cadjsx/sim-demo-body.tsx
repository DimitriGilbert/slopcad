/**
 * The simulation workbench's demo body (ROADMAP-SIM Phase 62c): the part
 * the `/workbench-sim` fixture page tessellates and voxelizes — "here is
 * your part as a grid." Authored per the cad-jsx discipline (the hub-mount
 * precedent beside it): one extruded plate parameterized by `thickness`,
 * one through bore parameterized by `bore`, the flat five-parameter hole
 * form the workbench's plain-hole flows use — deliberately
 * Manifold-renderable (the fixture boots the default kernel backend), and
 * deliberately plate-with-a-bore: a mid-plane occupancy slice shows the
 * rectangle minus the circle, the classic voxel-staircase picture the
 * guide's honest-scope section describes.
 *
 * The default export is what the package's `compile` CLI renders:
 * `pnpm --filter @slopcad/cad-jsx compile ../docs-examples/src/cadjsx/sim-demo-body.tsx`.
 */

import {
  CAD_NATIVE_FORMAT_VERSION,
  parseNativeCadDocumentFromString,
  validateNativeCadDocument,
} from "@slopcad/cad-core";
import {
  Body,
  Extrude,
  Hole,
  Parameter,
  Rectangle,
  Sketch,
  compileToNative,
} from "@slopcad/cad-jsx";

/** The document id the example's native emission carries. */
export const SIM_DEMO_BODY_DOCUMENT_ID = "doc_sim_demo_body";

/** The plate's footprint, millimetres (the fixture domain's reference). */
export const SIM_DEMO_BODY_PLATE = {
  xMin: -40,
  xMax: 40,
  yMin: -24,
  yMax: 24,
  /** The `thickness` parameter's value. */
  thickness: 6,
  /** The `bore` parameter's value. */
  bore: 12,
} as const;

/**
 * The demo body: a 80×48×6 plate with a ⌀12 through bore at the origin.
 * `thickness` and `bore` are parameters so the model is a real parametric
 * document — one `parameter.set` re-drives the plate and the bore
 * together.
 */
export function SimDemoBodyModel(): React.JSX.Element {
  return (
    <>
      <Parameter
        id="param_thickness"
        name="thickness"
        value={SIM_DEMO_BODY_PLATE.thickness}
      />
      <Parameter id="param_bore" name="bore" value={SIM_DEMO_BODY_PLATE.bore} />
      <Sketch id="skd_profile" name="demo profile">
        <Rectangle
          id="skent_profile"
          x1={SIM_DEMO_BODY_PLATE.xMin}
          y1={SIM_DEMO_BODY_PLATE.yMin}
          x2={SIM_DEMO_BODY_PLATE.xMax}
          y2={SIM_DEMO_BODY_PLATE.yMax}
        />
      </Sketch>
      <Body id="body_sim-demo" name="sim demo body">
        <Hole
          id="feat_bore"
          diameter="param_bore"
          depth={SIM_DEMO_BODY_PLATE.thickness + 3}
          positionX={0}
          positionY={0}
        >
          <Extrude
            id="feat_plate"
            sketch="skd_profile"
            height="param_thickness"
          />
        </Hole>
      </Body>
    </>
  );
}

/** The CLI renders this file's default export (a component: no props). */
export default SimDemoBodyModel;

/** What the example reports back to the guide and the suite. */
export interface SimDemoBodyExampleSummary {
  /** The compiled transaction's command count. */
  readonly commandCount: number;
  /** The emitted canonical text's length in bytes. */
  readonly textBytes: number;
  /** The format version the reopened document carries. */
  readonly formatVersion: number;
  /** The reopened document's feature kinds, in timeline order. */
  readonly featureKinds: readonly string[];
  /** The reopened document's body ids, in creation order. */
  readonly bodyIds: readonly string[];
  /** The reopened document's parameter count. */
  readonly parameterCount: number;
  /** The structural validator's issue count (zero is the claim). */
  readonly validatorIssues: number;
}

/**
 * Compiles the demo body to native text and reopens it through the
 * format's own parser — the hub-mount example's round trip, proving the
 * model the fixture consumes is a valid parametric document (the fold
 * applies, the validator is clean) before any voxelization rides it.
 */
export function runSimDemoBodyExample(): SimDemoBodyExampleSummary {
  const native = compileToNative(SimDemoBodyModel(), {
    documentId: SIM_DEMO_BODY_DOCUMENT_ID,
  });
  if (!native.ok) {
    const path =
      "path" in native.error ? native.error.path.join(" > ") : "(fold)";
    throw new Error(
      `The sim demo body failed to compile to native text: ${native.error.code}: ${native.error.message} @ ${path}`,
    );
  }
  const reopened = parseNativeCadDocumentFromString(native.value);
  if (!reopened.ok) {
    throw new Error(
      `The emitted native text failed its re-open: ${reopened.error.message}`,
    );
  }
  const validation = validateNativeCadDocument(
    JSON.parse(native.value) as unknown,
  );
  return {
    commandCount:
      reopened.value.history.entries[0]?.transaction.commands.length ?? 0,
    textBytes: native.value.length,
    formatVersion: CAD_NATIVE_FORMAT_VERSION,
    featureKinds: reopened.value.document.features.map(
      (feature) => feature.kind,
    ),
    bodyIds: reopened.value.document.bodies.map((body) => body.id),
    parameterCount: reopened.value.document.parameters.parameters.length,
    validatorIssues: validation.issues.length,
  };
}
