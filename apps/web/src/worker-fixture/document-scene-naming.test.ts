/**
 * Name-based references end to end on the OCCT kernel (Phase N3): a
 * persistent edge reference minted from one `computeDocumentScene` pass's
 * box drives a fillet in the NEXT pass (a full rebuild — a fresh box, fresh
 * kernel handles), and keeps driving it after a parameter edit changes the
 * box's width. The reference carries the kernel's history-based
 * `occt-name/1` identity, which reads no dimension, so it re-resolves
 * `valid` against every rebuild — not `repaired`, not guessed.
 *
 * The harness is the in-process OCCT session of the composition suite: the
 * real worker's operation matrix over the real kernel, `solid.topology`
 * answered by the kernel's own snapshot reporter.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  addBody,
  applyCommand,
  applyTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createReferenceId,
  length,
  mintTopologyReference,
  parseCommand,
  parseNativeCadDocumentFromString,
  referenceProvenance,
  resolveTopologyReference,
  type BodyId,
  type CadDocument,
  type TopologyEntityReference,
  type TopologySnapshot,
} from "@slopcad/cad-core";
import {
  createRevisionTag,
  createWorkerSolidId,
  type ComputationContext,
  type KernelSolid,
  type WorkerOperationId,
  type WorkerOperationInput,
  type WorkerOperationResult,
  type WorkerSolidId,
} from "@slopcad/cad-kernel";
import { createOcctKernel, type OcctKernel } from "@slopcad/cad-kernel-occt";

import {
  documentSceneBodies,
  renderableBodyIds,
  type DocumentBodySceneRequest,
} from "../cad-workbench/document-scene";
import { topologyCutCreateCommands } from "../cad-workbench/topology-pick";
import FIXTURE_COMMANDS_TEXT from "../../../../packages/cad-jsx/fillet-box.commands.json?raw";
import FIXTURE_TEXT from "../../../../packages/cad-jsx/fillet-box.native.json?raw";
import { computeDocumentScene } from "./document-scene";

const BOX_BODY = "body_box";
const FILLET_BODY = "body_fillet";
const DEPTH_MM = 20;
const HEIGHT_MM = 30;
const RADIUS_MM = 2;
const NAME_SCHEMA = "occt-name/1";

let kernel: OcctKernel;

beforeAll(async () => {
  kernel = await createOcctKernel();
});

/**
 * One pass's in-process OCCT session at `regeneration`. `created` collects
 * every box solid the pass built, so the test can ask the session for the
 * rendered box's topology the way the pick path does.
 */
function passContext(
  regeneration: number,
  created: WorkerSolidId[],
): ComputationContext {
  const solids = new Map<WorkerSolidId, KernelSolid>();
  let minted = 0;
  const mint = (handle: KernelSolid): WorkerSolidId => {
    minted += 1;
    const id = createWorkerSolidId(
      `wsol_name_${String(regeneration)}_${String(minted)}`,
    );
    solids.set(id, handle);
    return id;
  };
  const owned = (id: WorkerSolidId): KernelSolid => {
    const handle = solids.get(id);
    if (handle === undefined) throw new Error(`unknown solid ${id}`);
    return handle;
  };
  type SceneRequest = {
    [O in WorkerOperationId]: readonly [
      operation: O,
      input: WorkerOperationInput<O>,
    ];
  }[WorkerOperationId];
  const answer = (
    request: SceneRequest,
  ): WorkerOperationResult<SceneRequest[0]> => {
    const [operation, input] = request;
    switch (operation) {
      case "solid.createBox": {
        const box = kernel.createBox(input);
        if (!box.ok) throw new Error(box.error.message);
        const id = mint(box.value);
        created.push(id);
        return { solid: id };
      }
      case "solid.fillet": {
        const cut = kernel.fillet({ ...input, target: owned(input.target) });
        if (!cut.ok) throw new Error(cut.error.message);
        return { solid: mint(cut.value) };
      }
      case "solid.topology": {
        const reported = kernel.topologySnapshot(owned(input.solid), {
          bodyId: input.bodyId,
          regeneration: input.regeneration,
        });
        if (!reported.ok) throw new Error(reported.error.message);
        return { snapshot: reported.value };
      }
      case "solid.volume": {
        const measured = kernel.volume(owned(input.solid));
        if (!measured.ok) throw new Error(measured.error.message);
        return { volume: measured.value };
      }
      case "solid.area": {
        const measured = kernel.area(owned(input.solid));
        if (!measured.ok) throw new Error(measured.error.message);
        return { area: measured.value };
      }
      case "solid.bounds": {
        const measured = kernel.bounds(owned(input.solid));
        if (!measured.ok) throw new Error(measured.error.message);
        return { bounds: measured.value };
      }
      case "solid.tessellate": {
        const tessellated = kernel.tessellate(owned(input.solid));
        if (!tessellated.ok) throw new Error(tessellated.error.message);
        return { tessellation: tessellated.value };
      }
      default:
        throw new Error(`the naming harness lacks ${operation}`);
    }
  };
  return {
    revision: createRevisionTag(regeneration),
    request: <O extends WorkerOperationId>(
      operation: O,
      input: WorkerOperationInput<O>,
    ): Promise<WorkerOperationResult<O>> =>
      Promise.resolve(
        answer([operation, input] as SceneRequest) as WorkerOperationResult<O>,
      ),
  };
}

/** The box primitive at `widthMm`, compute-only unless `rendered`. */
function boxOf(widthMm: number, rendered = false): DocumentBodySceneRequest {
  return {
    bodyId: BOX_BODY,
    ...(rendered ? {} : { consumedOnly: true }),
    scene: {
      kind: "primitive",
      request: {
        shape: {
          kind: "box",
          widthMm,
          depthMm: DEPTH_MM,
          heightMm: HEIGHT_MM,
        },
        bodyId: BOX_BODY,
      },
    },
  };
}

/** The fillet over the box, selecting `reference`. */
function filletOf(
  reference: TopologyEntityReference,
): DocumentBodySceneRequest {
  return {
    bodyId: FILLET_BODY,
    scene: {
      kind: "topologyCut",
      request: {
        kind: "fillet",
        target: { kind: "computed", bodyId: BOX_BODY },
        targetBodyId: BOX_BODY,
        sizeMm: RADIUS_MM,
        selection: { kind: "references", references: [reference] },
        bodyId: FILLET_BODY,
      },
    },
  };
}

/** The topology the session reports for the pass's (only) box. */
async function boxSnapshot(
  context: ComputationContext,
  created: readonly WorkerSolidId[],
  regeneration: number,
): Promise<TopologySnapshot> {
  const solid = created[0];
  if (solid === undefined) throw new Error("the pass built no box");
  const { snapshot } = await context.request("solid.topology", {
    solid,
    bodyId: createBodyId(BOX_BODY),
    regeneration,
  });
  return snapshot;
}

/** Mints a reference on the first height-long (vertical) edge. */
function mintVerticalEdge(snapshot: TopologySnapshot): TopologyEntityReference {
  const body: BodyId = createBodyId(BOX_BODY);
  const added = addBody(createDocument(createDocumentId("doc_naming")), {
    id: body,
    name: "box",
  });
  if (!added.ok) throw new Error(added.error.message);
  const provenance = referenceProvenance(added.value.document, body);
  if (!provenance.ok) throw new Error(provenance.error.message);
  const edge = snapshot.entities.find(
    (entity) =>
      entity.kind === "edge" &&
      Math.abs((entity.geometry.lengthMm ?? 0) - HEIGHT_MM) < 1e-6,
  );
  if (edge === undefined) throw new Error("the box reports no vertical edge");
  const minted = mintTopologyReference(
    snapshot,
    edge.ordinal,
    provenance.value,
    { id: createReferenceId("ref_name_edge"), kind: "edge" },
  );
  if (!minted.ok) throw new Error(minted.error.message);
  return minted.value;
}

/** The analytic volume of a box with one vertical edge filleted. */
function filletedVolume(widthMm: number): number {
  return (
    widthMm * DEPTH_MM * HEIGHT_MM -
    (1 - Math.PI / 4) * RADIUS_MM * RADIUS_MM * HEIGHT_MM
  );
}

describe("name-based references across computeDocumentScene passes (Phase N3)", () => {
  it("a reference minted in one pass drives the fillet in the next, and survives a width edit", async () => {
    // Pass 0: the box renders; the pick path mints from its topology.
    const firstCreated: WorkerSolidId[] = [];
    const first = passContext(0, firstCreated);
    const pass0 = await computeDocumentScene(
      first,
      [boxOf(10, true)],
      new Set([BOX_BODY]),
    );
    expect(pass0.failures).toEqual([]);
    const reference = mintVerticalEdge(
      await boxSnapshot(first, firstCreated, 0),
    );
    expect(reference.identity.schema).toBe(NAME_SCHEMA);

    // Pass 1: a full rebuild — the fillet resolves the minted reference.
    const secondCreated: WorkerSolidId[] = [];
    const second = passContext(1, secondCreated);
    const pass1 = await computeDocumentScene(
      second,
      [boxOf(10), filletOf(reference)],
      new Set([FILLET_BODY]),
    );
    expect(pass1.failures).toEqual([]);
    expect(pass1.bodies.map((body) => body.bodyId)).toEqual([FILLET_BODY]);
    expect(pass1.volume).toBeCloseTo(filletedVolume(10), 4);

    // Pass 2: the width edit — the name reads no dimension, so it stays
    // `valid` (not repaired) and the fillet still renders.
    const thirdCreated: WorkerSolidId[] = [];
    const third = passContext(2, thirdCreated);
    const pass2 = await computeDocumentScene(
      third,
      [boxOf(14), filletOf(reference)],
      new Set([FILLET_BODY]),
    );
    expect(pass2.failures).toEqual([]);
    expect(pass2.bodies.map((body) => body.bodyId)).toEqual([FILLET_BODY]);
    expect(pass2.volume).toBeCloseTo(filletedVolume(14), 4);
    const edited = resolveTopologyReference(
      reference,
      await boxSnapshot(third, thirdCreated, 2),
    );
    if (!edited.ok) throw new Error(edited.error.message);
    expect(edited.value.validity.state).toBe("valid");
  });
});

/**
 * The cad-jsx primitive + fillet fixture: `packages/cad-jsx/fillet-box.native.json`
 * and its command batch `fillet-box.commands.json` are the compile CLI's
 * `--out`/`--commands` output for
 * `packages/docs-examples/src/cadjsx/fillet-box.tsx` (a box whose width is
 * the `filletBoxWidth` parameter). A static tree cannot mint the fillet's
 * edge reference, so the fillet is added the way the workbench adds it:
 * the box renders, its topology is read, and the fillet verb's authoring
 * plan mints the reference and commits the feature.
 */
const FIXTURE_WIDTH = createParameterId("param_filletBoxWidth");

/** One document-scene pass over `document`, its pass context returned too. */
async function documentPass(
  document: CadDocument,
  regeneration: number,
): Promise<{
  readonly context: ComputationContext;
  readonly created: readonly WorkerSolidId[];
  readonly scene: Awaited<ReturnType<typeof computeDocumentScene>>;
}> {
  const created: WorkerSolidId[] = [];
  const context = passContext(regeneration, created);
  const scene = await computeDocumentScene(
    context,
    documentSceneBodies(document, new Set(), null),
    renderableBodyIds(document),
  );
  return { context, created, scene };
}

describe("the cad-jsx primitive + fillet fixture through the document scene", () => {
  it("renders the compiled box, fillets a minted edge, and re-renders it after a width edit", async () => {
    const parsed = parseNativeCadDocumentFromString(FIXTURE_TEXT);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const compiled = parsed.value.document;
    expect(compiled.features.map((feature) => feature.kind)).toEqual(["box"]);

    // The command batch replays over a fresh document to the same document.
    const batch: unknown = JSON.parse(FIXTURE_COMMANDS_TEXT);
    if (!Array.isArray(batch)) throw new Error("the batch is not an array");
    const entries: readonly unknown[] = batch;
    const commands = entries.map((entry) => {
      const command = parseCommand(entry);
      if (!command.ok) throw new Error(command.error.message);
      return command.value;
    });
    const replayed = applyTransaction(createDocument(compiled.id), {
      commands,
    });
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value).toEqual(compiled);

    // Pass 0: the compiled box renders at 20 × 20 × 30.
    const boxed = await documentPass(compiled, 0);
    expect(boxed.scene.failures).toEqual([]);
    expect(boxed.scene.bodies.map((body) => body.bodyId)).toEqual([BOX_BODY]);
    expect(boxed.scene.volume).toBeCloseTo(20 * DEPTH_MM * HEIGHT_MM, 4);

    // The fillet verb's plan mints the picked vertical edge's reference
    // on the rendered box's snapshot and commits the feature.
    const snapshot = await boxSnapshot(boxed.context, boxed.created, 0);
    const edge = snapshot.entities.find(
      (entity) =>
        entity.kind === "edge" &&
        Math.abs((entity.geometry.lengthMm ?? 0) - HEIGHT_MM) < 1e-6,
    );
    if (edge === undefined) throw new Error("the box reports no vertical edge");
    const plan = topologyCutCreateCommands(compiled, {
      kind: "fillet",
      snapshot,
      ordinals: [edge.ordinal],
      sizeMm: RADIUS_MM,
    });
    if (!plan.ok) throw new Error(plan.message);
    const applied = applyTransaction(compiled, { commands: plan.commands });
    if (!applied.ok) throw new Error(applied.error.message);
    const filleted = applied.value;

    // Pass 1: a full rebuild — the fillet renders in place of the box.
    const first = await documentPass(filleted, 1);
    expect(first.scene.failures).toEqual([]);
    expect(first.scene.bodies.map((body) => body.bodyId)).toEqual([
      plan.bodyId,
    ]);
    expect(first.scene.volume).toBeCloseTo(filletedVolume(20), 4);

    // Pass 2: the compiled width parameter edit — the fillet still renders.
    const widened = applyCommand(filleted, {
      type: "parameter.set",
      id: FIXTURE_WIDTH,
      value: length(26),
    });
    if (!widened.ok) throw new Error(widened.error.message);
    const second = await documentPass(widened.value, 2);
    expect(second.scene.failures).toEqual([]);
    expect(second.scene.bodies.map((body) => body.bodyId)).toEqual([
      plan.bodyId,
    ]);
    expect(second.scene.volume).toBeCloseTo(filletedVolume(26), 4);
  });
});
