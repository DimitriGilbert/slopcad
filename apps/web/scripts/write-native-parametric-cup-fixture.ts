/**
 * The parametric-cup native fixture generator: rebuilds the committed
 * `packages/cad-jsx/parametric-cup.native.json` from its source of truth,
 * the hand-authored raw-CadCommand batch
 * `packages/cad-jsx/parametric-cup.commands.json` — the same strict
 * `parseCommand`-then-one-atomic-transaction path the workbench's
 * `cad_apply_commands` tool runs — over a CLEAN empty base document.
 *
 * The first capture of this artifact was taken over the demo-era workbench
 * boot document, so it inherited the demo plate (hidden), the plate
 * translate/rotate features, the demo parameters (`holeDiameter`,
 * `translate_*`, `rotate_z`, `volumeHint`, `boreRadius`), and the disabled
 * mid-height section record. This generator re-derives the document from
 * the batch alone: cup content only, no template leftovers, exactly what
 * an agent applying the batch to a fresh workbench gets.
 *
 * Self-checking: the generator refuses to write unless the batch parses
 * strictly, the produced document validates, round-trips to byte-identical
 * text, carries the cup's feature and parameter vocabulary, and carries
 * NONE of the demo-era records. Run from the repo root:
 *
 *   pnpm --filter web write-native-parametric-cup-fixture
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  applySessionTransaction,
  createDocument,
  createDocumentId,
  createNativeCadDocument,
  createSession,
  parseCommand,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
  type CadCommand,
} from "@slopcad/cad-core";

const DOC = createDocumentId("doc_parametric-cup");
const BATCH = "../../../packages/cad-jsx/parametric-cup.commands.json";
const TARGET = "../../../packages/cad-jsx/parametric-cup.native.json";

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The fixture generator failed at ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** The demo-era records the clean artifact must NOT carry. */
const FORBIDDEN_IDS = new Set([
  "body_plate",
  "feat_translate_plate",
  "feat_rotate_plate",
  "param_hole_diameter",
  "param_translate_x",
  "param_translate_y",
  "param_translate_z",
  "param_rotate_z",
  "param_volume_hint",
  "param_bore_radius",
  "sec_mid_height",
]);

const batchUrl = new URL(BATCH, import.meta.url);
const rawBatch: unknown = JSON.parse(await readFile(batchUrl, "utf8"));
if (!Array.isArray(rawBatch) || rawBatch.length !== 72) {
  const count = Array.isArray(rawBatch) ? rawBatch.length : 0;
  throw new Error(
    `The batch must be the 72-command cup batch (got ${String(count)} entries).`,
  );
}
const commands: CadCommand[] = [];
for (const [index, raw] of rawBatch.entries()) {
  commands.push(
    requireOk(
      parseCommand(raw),
      `batch entry ${String(index)} (the same strict parse cad_apply_commands runs)`,
    ),
  );
}

// One atomic transaction over the CLEAN empty base — no demo template.
const session = requireOk(
  applySessionTransaction(createSession(createDocument(DOC)), {
    commands,
  }),
  "the cup batch transaction",
);

const native = requireOk(
  createNativeCadDocument(session.document, {
    generator: "parametric-cup.commands.json",
  }),
  "the native document",
);
const text = stringifyNativeCadDocument(
  serializeNativeCadDocument({
    ...native,
    history: session.history,
  }),
);

// Self-checks before writing anything.
const validation = validateNativeCadDocument(JSON.parse(text));
if (!validation.valid) {
  throw new Error(
    `The generated document failed validation: ${JSON.stringify(validation.issues)}`,
  );
}
const reparsed = requireOk(
  parseNativeCadDocumentFromString(text),
  "the generated document's own re-parse",
);
if (stringifyNativeCadDocument(serializeNativeCadDocument(reparsed)) !== text) {
  throw new Error(
    "The generated document is not byte-stable across a round trip.",
  );
}
const kinds = reparsed.document.features.map((feature) => String(feature.kind));
if (kinds.filter((kind) => kind === "revolve").length !== 8) {
  throw new Error(
    `The cup must carry 8 revolve features (shell, 6 handles, cavity): ${JSON.stringify(kinds)}`,
  );
}
if (!kinds.includes("union") || !kinds.includes("subtract")) {
  throw new Error(`The cup composition drifted: ${JSON.stringify(kinds)}`);
}
const carriedIds: string[] = [
  ...reparsed.document.bodies.map((body) => String(body.id)),
  ...reparsed.document.features.map((feature) => String(feature.id)),
  ...reparsed.document.parameters.parameters.map((entry) => String(entry.id)),
  ...reparsed.document.sections.map((section) => String(section.id)),
];
const leftovers = carriedIds.filter((id) => FORBIDDEN_IDS.has(id));
if (leftovers.length > 0) {
  throw new Error(
    `Demo-era records leaked into the artifact: ${JSON.stringify(leftovers)}`,
  );
}
if (reparsed.history.cursor !== 1) {
  throw new Error(
    `The persisted log must be the one batch transaction: cursor ${String(reparsed.history.cursor)}, expected 1.`,
  );
}
if (reparsed.document.bodies.length !== 10) {
  throw new Error(
    `The cup must carry 10 bodies (shell, 6 handles, cup, cavity, union): ${String(reparsed.document.bodies.length)}`,
  );
}

const target = new URL(TARGET, import.meta.url);
await mkdir(fileURLToPath(new URL(".", target)), { recursive: true });
await writeFile(fileURLToPath(target), text, "utf8");
console.log(`wrote ${fileURLToPath(target)} (${String(text.length)} bytes)`);
