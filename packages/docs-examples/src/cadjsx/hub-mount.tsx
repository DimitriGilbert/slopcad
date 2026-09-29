/**
 * The JSX-authored models guide's runnable example: a hub mount authored
 * as a React element tree with `@slopcad/cad-jsx` — a parameterized
 * extruded plate, a revolved ring meridian, a lofted boss (sketches,
 * producers, and booleans through `<Use>` shared references) — compiled
 * straight to the native `slopcad` document format's canonical text by
 * `compileToNative`, reopened through the format's own parser (which
 * replays the transaction log over the base and refuses any
 * state/log disagreement), and structurally validated. The default export
 * is what the package's `compile` CLI renders:
 * `pnpm --filter @slopcad/cad-jsx compile packages/docs-examples/src/cadjsx/hub-mount.tsx`.
 */

import {
  CAD_NATIVE_FORMAT_VERSION,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
} from "@slopcad/cad-core";
import {
  Body,
  Circle,
  Extrude,
  Loft,
  Parameter,
  Rectangle,
  Revolve,
  Sketch,
  Subtract,
  Union,
  Use,
  compileToNative,
} from "@slopcad/cad-jsx";

/** The document id the example's native emission carries. */
export const HUB_MOUNT_DOCUMENT_ID = "doc_guide_cadjsx";

/**
 * The example model: a hub mount. The plate is an extruded rectangle
 * sketch driven by the `plateHeight` parameter; the ring is a revolved
 * circle meridian subtracted from the plate; the boss is a two-section
 * loft unioned onto the result — the `<Use>` elements consume earlier
 * features by reference the way the cad-jsx guide teaches sharing.
 */
export function HubMountModel(): React.JSX.Element {
  return (
    <>
      <Parameter id="param_plateHeight" name="plateHeight" value={6} />
      <Sketch id="skd_plate" name="plate profile">
        <Rectangle id="skent_plate" x1={-30} y1={-20} x2={30} y2={20} />
      </Sketch>
      <Extrude id="feat_plate" sketch="skd_plate" height="param_plateHeight" />
      <Sketch id="skd_ring" name="ring meridian">
        <Circle id="skent_ring" cx={12} cy={0} radius={2} />
      </Sketch>
      <Revolve
        id="feat_ring"
        sketch="skd_ring"
        angle={Math.PI * 2}
        axis={Math.PI / 2}
      />
      <Sketch id="skd_boss-base" name="boss base">
        <Circle id="skent_boss-base" cx={0} cy={0} radius={8} />
      </Sketch>
      <Sketch id="skd_boss-top" name="boss top">
        <Circle id="skent_boss-top" cx={0} cy={0} radius={5} />
      </Sketch>
      <Loft
        id="feat_boss"
        sections={[
          { sketch: "skd_boss-base", z: 6 },
          { sketch: "skd_boss-top", z: 12 },
        ]}
      />
      <Subtract id="feat_cleared">
        <Use feature="feat_plate" />
        <Use feature="feat_ring" />
      </Subtract>
      <Body id="body_mount" name="mount">
        <Union id="feat_mount">
          <Use feature="feat_cleared" />
          <Use feature="feat_boss" />
        </Union>
      </Body>
    </>
  );
}

/** The CLI renders this file's default export (a component: no props). */
export default HubMountModel;

/** What the example reports back to the guide and the suite. */
export interface CadJsxExampleSummary {
  /** The compiled transaction's command count. */
  readonly commandCount: number;
  /** The emitted canonical text's length in bytes. */
  readonly textBytes: number;
  /** The format version the reopened document carries. */
  readonly formatVersion: number;
  /** The document id the emission carried (the reopened document's id). */
  readonly documentId: string;
  /** The reopened history's transaction count (one compile = one commit). */
  readonly reopenedTransactionCount: number;
  /** The reopened document's feature kinds, in timeline order. */
  readonly featureKinds: readonly string[];
  /** The reopened document's body ids, in creation order. */
  readonly bodyIds: readonly string[];
  /** The reopened document's parameter count. */
  readonly parameterCount: number;
  /** The structural validator's issue count (zero is the claim). */
  readonly validatorIssues: number;
  /** Whether serializing the reopened document reproduces the exact text. */
  readonly resaveIdentical: boolean;
}

/**
 * Compiles the hub mount to native text, reopens it through the format's
 * own parser, and reports the outcomes the guide states: the compile
 * succeeds, the reopened document carries the authored feature graph, the
 * structural validator is clean, and a resave is byte-identical.
 */
export function runCadJsxExample(): CadJsxExampleSummary {
  const native = compileToNative(HubMountModel(), {
    documentId: HUB_MOUNT_DOCUMENT_ID,
  });
  if (!native.ok) {
    const path =
      "path" in native.error ? native.error.path.join(" > ") : "(fold)";
    throw new Error(
      `The hub mount failed to compile to native text: ${native.error.code}: ${native.error.message} @ ${path}`,
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
  const resave = stringifyNativeCadDocument(
    serializeNativeCadDocument(reopened.value),
  );
  return {
    commandCount:
      reopened.value.history.entries[0]?.transaction.commands.length ?? 0,
    textBytes: native.value.length,
    formatVersion: CAD_NATIVE_FORMAT_VERSION,
    documentId: reopened.value.document.id,
    reopenedTransactionCount: reopened.value.history.entries.length,
    featureKinds: reopened.value.document.features.map(
      (feature) => feature.kind,
    ),
    bodyIds: reopened.value.document.bodies.map((body) => body.id),
    parameterCount: reopened.value.document.parameters.parameters.length,
    validatorIssues: validation.issues.length,
    resaveIdentical: resave === native.value,
  };
}
