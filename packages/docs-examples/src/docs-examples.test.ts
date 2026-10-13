/**
 * The docs-examples proof suite, part 1 (node): runs every headless
 * example and asserts the outcomes the guides state. When a guide says
 * "the reopened document is serialization-identical", the assertion
 * below is the machine check of that sentence.
 */

import { threadId } from "node:worker_threads";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CAD_NATIVE_FORMAT_VERSION,
  parseNativeCadDocumentFromString,
} from "@slopcad/cad-core";
import { compileToNative } from "@slopcad/cad-jsx";
import { createFakeKernel } from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";

import {
  HUB_MOUNT_DOCUMENT_ID,
  HubMountModel,
  runCadJsxExample,
} from "./cadjsx/hub-mount";
import { runComponentsExample } from "./components/components";
import { runCustomAdapterExample } from "./kernel/custom-adapter";
import { KERNEL_CAPABILITY_ROWS } from "./kernel/capabilities";
import { runFeaturesExample } from "./kernel/features";
import { runHelixThreadExample } from "./kernel/helix-thread";
import { runStepExample } from "./kernel/occt";
import { runWorkersExample } from "./kernel/workers";
import { runCustomToolExample } from "./core/custom-tool";
import { runDocumentExample } from "./core/document";
import { runHistoryExample } from "./core/history";
import { runNativeFormatExample } from "./core/native";
import { runProjectionExample } from "./core/projection";
import { runUnitsExample } from "./core/units";
import { runMeshExchangeExample } from "./io/mesh";
import {
  roshkoStrouhal,
  runCylinderSheddingExample,
  runNacaAirfoilExample,
  runShockTubeDeclineExample,
  SOD_SHOCK_MACH,
} from "./sim/gallery";
import { runSimSpineExample } from "./sim/spine";
import { runSimThermalExample } from "./sim/thermal";
import { runSimFanExample } from "./sim/fan";
import { runSimStructuralExample } from "./sim/structural";
import { runSimStudyBracketExample, runSimStudyFanExample } from "./sim/study";
import { runSimCombustionExample } from "./sim/combustion";
import { runSimVoxelExample } from "./sim/voxel";
import { runSimDemoBodyExample } from "./cadjsx/sim-demo-body";
import { runSketchExample } from "./sketch/sketch";
import { runSketchVocabularyExample } from "./sketch/vocabulary";
import { runKernelExample, unwrapKernel } from "./kernel/primitives";

let runtime: ManifoldRuntime;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
});

describe("guide example: cad-core document, parameters, expressions", () => {
  it("builds the guide document and its expression follows the edit", () => {
    const summary = runDocumentExample();
    expect(summary.parameterCount).toBe(4);
    expect(summary.holeDiameterMm).toBe(10);
    expect(summary.volumeHintMm).toBe(20);
    expect(summary.featureCount).toBe(1);
    expect(summary.timelineKinds).toEqual(["translate"]);
    expect(summary.editedHoleDiameterMm).toBe(12.5);
    expect(summary.editedVolumeHintMm).toBe(25);
  });
});

describe("guide example: units", () => {
  it("converts, parses, and keeps arithmetic dimensioned", () => {
    const summary = runUnitsExample();
    expect(summary.inchInMm).toBeCloseTo(25.4, 12);
    expect(summary.degreeInRadian).toBeCloseTo(Math.PI / 180, 12);
    expect(summary.parsedMm).toBe(12.5);
    expect(summary.parsedInchCanonicalMm).toBeCloseTo(12.7, 12);
    expect(summary.parsedAngleCanonicalRad).toBeCloseTo(Math.PI / 6, 12);
    expect(summary.expressionLiteralMm).toBeCloseTo(12.7, 12);
    expect(summary.serializedRoundTrip).toBe("12.5 mm");
    expect(summary.boxVolumeMm3).toBeCloseTo(50.8 * 40 * 5, 9);
    expect(summary.boxVolumeInIn3).toBeCloseTo((50.8 * 40 * 5) / 25.4 ** 3, 9);
    expect(summary.lengthOverLength).toBe(8);
  });
});

describe("guide example: history (transactions, undo, redo)", () => {
  it("commits atomically, undoes, and redoes the same state", () => {
    const summary = runHistoryExample();
    expect(summary.commandCount).toBe(3);
    expect(summary.undoRemovedParameters).toBe(1);
    expect(summary.redoRestoredParameters).toBe(1);
    expect(summary.canUndoAfterBothMoves).toBe(true);
    expect(summary.serializedCommandTypes).toEqual([
      "sketch.create",
      "parameter.create",
      "body.create",
    ]);
  });
});

describe("guide example: native format", () => {
  it("saves, reopens through the replaying parser, and resaves identically", () => {
    const summary = runNativeFormatExample();
    expect(summary.formatVersion).toBe(CAD_NATIVE_FORMAT_VERSION);
    expect(summary.reopenedHoleMm).toBe(12);
    expect(summary.reopenedTransactionCount).toBe(3);
    expect(summary.validatorIssues).toBe(0);
    expect(summary.resaveIdentical).toBe(true);
    expect(summary.byteEncodedBytes).toBe(summary.textBytes);
  });
});

describe("guide example: projection and selection", () => {
  it("projects the soup and drives the selection machine", () => {
    const { summary } = runProjectionExample();
    expect(summary.objectId).toBe("rend_guide_plate");
    expect(summary.vertexCount).toBe(8);
    expect(summary.triangleCount).toBe(12);
    expect(summary.projectionObjectCount).toBe(1);
    expect(summary.firstPickCount).toBe(1);
    expect(summary.selectedKeys).toEqual(["body|body_guide_plate"]);
    expect(summary.hoveredKey).toBe("body|body_guide_plate");
    expect(summary.serializedBytes).toBeGreaterThan(0);
  });
});

describe("guide example: custom tools", () => {
  it("drives the two-click stamp tool to completion", () => {
    const summary = runCustomToolExample();
    expect(summary.toolId).toBe("guide.stamp");
    expect(summary.phases).toEqual(["active", "active", "completed"]);
    expect(summary.finalPhase).toBe("completed");
    expect(summary.bodyCount).toBe(1);
    expect(summary.parameterCount).toBe(1);
    expect(summary.completionSummary).toBe(
      "Stamped one body with a depth parameter.",
    );
  });
});

describe("guide example: primitives and booleans (Manifold)", () => {
  it("measures primitives and boolean results with real geometry", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
    const summary = runKernelExample(kernel);
    expect(summary.backendId).toBe("manifold");
    expect(summary.boxVolumeMm3).toBeCloseTo(30 * 20 * 10, 9);
    expect(summary.boxSurfaceAreaMm2).toBeCloseTo(
      2 * (30 * 20 + 30 * 10 + 20 * 10),
      9,
    );
    // Manifold's sphere is its documented inscribed-chord discretization:
    // within the contract suite's 5% curved-volume band of the analytic
    // value, never above it.
    const analyticSphere = (4 / 3) * Math.PI * 125;
    expect(summary.sphereVolumeMm3).toBeGreaterThan(0.95 * analyticSphere);
    expect(summary.sphereVolumeMm3).toBeLessThan(analyticSphere);
    // Curved primitives sit in the documented inscribed-chord band.
    const analyticCylinder = Math.PI * 16 * 10;
    expect(summary.cylinderVolumeMm3).toBeGreaterThan(0.95 * analyticCylinder);
    expect(summary.cylinderVolumeMm3).toBeLessThan(analyticCylinder);
    const analyticCone = (1 / 3) * Math.PI * 16 * 10;
    expect(summary.coneVolumeMm3).toBeGreaterThan(0.95 * analyticCone);
    expect(summary.coneVolumeMm3).toBeLessThan(analyticCone);
    // Two boxes overlapping by half: union 9000, intersect 3000.
    expect(summary.unionVolumeMm3).toBeCloseTo(9000, 6);
    expect(summary.intersectVolumeMm3).toBeCloseTo(3000, 6);
    // The subtract cutter stands at the box's min corner, so exactly a
    // quarter of the r=4, h=10 cylinder is inside — 6000 minus that
    // quarter (discretization puts it a hair under the analytic value).
    expect(summary.subtractVolumeMm3).toBeGreaterThan(
      6000 - (Math.PI * 4 * 4 * 10) / 4,
    );
    expect(summary.subtractVolumeMm3).toBeLessThan(6000);
    expect(summary.boxTriangleCount).toBe(12);
    expect(summary.negativeRadiusCode).toBe("kernel/invalid-length");
  });
});

describe("guide example: feature regeneration through the bridge", () => {
  it("executes the box → hole document and re-executes on the edit", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
    const volumeOf = (solid: Parameters<typeof kernel.volume>[0]) =>
      unwrapKernel(kernel.volume(solid), "volume");
    const summary = runFeaturesExample(kernel, volumeOf);
    expect(summary.featureKinds).toEqual(["box", "hole"]);
    expect(summary.firstRunStates).toEqual(["valid", "valid"]);
    // The blind hole removes the r=4, depth-4 cylinder; Manifold's
    // cylinder is its documented inscribed discretization, so the removed
    // volume sits a hair under the analytic value.
    const removed = Math.PI * 4 * 4 * 4;
    expect(summary.volumeAfterHoleMm3).toBeLessThan(6000 - 0.995 * removed);
    expect(summary.volumeAfterHoleMm3).toBeGreaterThan(6000 - removed / 0.95);
    const removedEdited = Math.PI * 5 * 5 * 4;
    expect(summary.volumeAfterEditMm3).toBeLessThan(
      6000 - 0.995 * removedEdited,
    );
    expect(summary.volumeAfterEditMm3).toBeGreaterThan(
      6000 - removedEdited / 0.95,
    );
    // The edit touched the hole's parameter: the box stayed current, the
    // hole re-executed.
    expect(summary.editedStates).toEqual(["valid", "valid"]);
    expect(summary.executedFeatureIds.length).toBeGreaterThan(0);
  });
});

describe("guide example: the kernel capability matrix", () => {
  it("declares the four backends with their honest flags", () => {
    expect(KERNEL_CAPABILITY_ROWS.map((row) => row.backendId)).toEqual([
      "manifold",
      "opencascade",
      "jscad",
      "fake",
    ]);
    const byId = new Map(
      KERNEL_CAPABILITY_ROWS.map((row) => [row.backendId, row.capabilities]),
    );
    expect(byId.get("manifold")?.sweep).toBe(false);
    expect(byId.get("manifold")?.persistentTopology).toBe(false);
    expect(byId.get("opencascade")?.fillet).toBe(true);
    expect(byId.get("opencascade")?.persistentTopology).toBe(true);
    expect(byId.get("jscad")?.loft).toBe(true);
    expect(byId.get("jscad")?.exactBooleanVolumes).toBe(false);
    expect(byId.get("fake")?.shell).toBe(true);
    expect(byId.get("fake")?.tightBooleanBounds).toBe(false);
  });
});

describe("guide example: custom kernel adapter", () => {
  it("delegates every operation and records the log", () => {
    const summary = runCustomAdapterExample();
    expect(summary.backendId).toBe("fake");
    expect(summary.boxVolumeMm3).toBe(1000);
    expect(summary.operations).toEqual(["createBox", "volume"]);
  });
});

describe("guide example: worker protocol (Manifold node channel)", () => {
  it("computes on another thread and settles pending requests at close", async () => {
    const summary = await runWorkersExample(threadId);
    expect(summary.workerThreadId).not.toBe(threadId);
    expect(summary.boxOnWorkerThread).toBe(true);
    expect(summary.boxVolumeMm3).toBeCloseTo(6000, 9);
    expect(summary.unionVolumeMm3).toBeGreaterThan(6000);
    expect(summary.closeSettledPendingRequests).toBe(1);
  }, 30_000);
});

describe("guide example: STEP/IGES exchange (OCCT)", () => {
  it("fillets, exports deterministic STEP, re-imports, and reads IGES meshes", async () => {
    const summary = await runStepExample();
    expect(summary.boxVolumeMm3).toBeCloseTo(6000, 9);
    expect(summary.filletedVolumeMm3).toBeLessThan(6000);
    expect(summary.stepBytes).toBeGreaterThan(1000);
    expect(summary.importedOrigin).toBe("imported-step");
    expect(summary.importAgreementRelative).toBeLessThan(1e-9);
    expect(summary.igesMeshCount).toBeGreaterThanOrEqual(1);
    expect(summary.igesFirstMeshExtentsMm[0]).toBeCloseTo(10, 6);
  }, 120_000);
});

describe("guide example: STL/3MF/GLB", () => {
  it("round-trips every adapter deterministically", () => {
    const summary = runMeshExchangeExample();
    // 84-byte header + 12 triangles × 50 bytes.
    expect(summary.stlBytes).toBe(684);
    expect(summary.stlTriangles).toBe(12);
    expect(summary.stlReimportedTriangles).toBe(12);
    expect(summary.stlReimportFlavor).toBe("binary");
    expect(summary.stlDeterministic).toBe(true);
    expect(summary.threeMfBytes).toBeGreaterThan(0);
    expect(summary.threeMfUnit).toBe("millimeter");
    expect(summary.threeMfReimportedTriangles).toBe(12);
    expect(summary.glbBytes).toBeGreaterThan(0);
    expect(summary.glbNodeCount).toBe(1);
  });
});

describe("guide example: sketches and constraints", () => {
  it("solves to zero dof and resolves the extrude profile", () => {
    const summary = runSketchExample();
    expect(summary.underConstrainedDof).toBeGreaterThan(0);
    expect(summary.solvedDof).toBe(0);
    expect(summary.solvedAbLengthMm).toBeCloseTo(50, 9);
    expect(summary.serializedRoundTripExact).toBe(true);
    expect(summary.profileLoopSegments).toBe(3);
    // Heron's area of the 50/30/40 triangle: 600 mm².
    expect(summary.profileSignedAreaMm2).toBeCloseTo(600, 6);
  });

  it("tours the Phase 36 vocabulary: ellipse dof, pinned spline, exact slot area", () => {
    const summary = runSketchVocabularyExample();
    expect(summary.ellipseDof).toBe(5);
    expect(summary.ellipseConstrainedDof).toBe(0);
    expect(summary.solvedRadiusXMm).toBeCloseTo(8, 9);
    expect(summary.solvedRadiusYMm).toBeCloseTo(5, 9);
    expect(summary.splineInteriorDof).toBe(4);
    expect(summary.slotLoopSegments).toBe(4);
    // The exact stadium area πr² + 2rL with r = 2, L = 10.
    expect(summary.slotLoopAreaMm2).toBeCloseTo(Math.PI * 4 + 40, 9);
    expect(summary.serializedRoundTripExact).toBe(true);
  });
});

describe("guide example: reusable components", () => {
  it("builds the NEMA 17 mount, edits it, and builds a custom washer", async () => {
    const summary = await runComponentsExample(runtime);
    expect(summary.nema17Bodies).toBeGreaterThanOrEqual(1);
    expect(summary.nema17VolumeMm3).toBeGreaterThan(0);
    expect(summary.nema17EditedVolumeMm3).toBeGreaterThan(
      summary.nema17VolumeMm3,
    );
    expect(summary.nema17PortCount).toBeGreaterThan(0);
    expect(summary.washerInnerDiameterMm).toBe(8);
    expect(summary.washerOuterDiameterMm).toBe(20);
    // Manifold's cylinders are inscribed polygons, so the washer sits in
    // the same curved-volume band just under the analytic value.
    const analyticWasher = Math.PI * (10 * 10 - 4 * 4) * 2;
    expect(summary.washerVolumeMm3).toBeGreaterThan(0.95 * analyticWasher);
    expect(summary.washerVolumeMm3).toBeLessThan(analyticWasher);
    expect(summary.phase32ComponentIds).toEqual([
      "nema17-mount",
      "arduino-uno-mount",
      "electronics-enclosure",
    ]);
  }, 30_000);
});

describe("guide example: the fake kernel still runs the same tour", () => {
  it("answers the primitive tour dependency-free", () => {
    const summary = runKernelExample(createFakeKernel());
    expect(summary.backendId).toBe("fake");
    expect(summary.boxVolumeMm3).toBe(6000);
    expect(summary.boxSurfaceAreaMm2).toBe(2200);
    expect(summary.negativeRadiusCode).toBe("kernel/invalid-length");
  });
});

describe("guide example: helix and thread through the bridge (Phase 40)", () => {
  it("executes the helix at the exact screw volume and the thread inside its band", () => {
    const kernel = createFakeKernel();
    const volumeOf = (solid: Parameters<typeof kernel.volume>[0]) =>
      unwrapKernel(kernel.volume(solid), "volume");
    const summary = runHelixThreadExample(kernel, volumeOf);
    // The helix: the fake kernel's analytic screw solid is EXACT —
    // 2π·turns·A·d̄ = 198π.
    expect(summary.helixVolumeMm3).toBeCloseTo(summary.helixExactVolumeMm3, 6);
    // The thread: the cut removes at most the full tool volume and at
    // least the tool minus the end slivers (the derived containment
    // band; the fake kernel's voxel boolean widens it a hair further).
    expect(summary.threadVolumeMm3).toBeLessThan(summary.threadRodVolumeMm3);
    expect(summary.threadVolumeMm3).toBeGreaterThan(
      summary.threadRodVolumeMm3 - summary.threadToolVolumeMm3 * 1.2,
    );
    expect(summary.threadVolumeMm3).toBeLessThan(
      summary.threadRodVolumeMm3 - summary.threadToolVolumeMm3 * 0.5,
    );
  });
});

describe("guide example: JSX-authored models (cad-jsx)", () => {
  it("compiles the hub mount to native text that reopens with the authored graph", () => {
    // The direct emission: compile the model component here and reopen
    // the string through cad-core's native parser — the same parse the
    // documents save path applies to `nativeContent` payloads.
    const native = compileToNative(HubMountModel(), {
      documentId: HUB_MOUNT_DOCUMENT_ID,
    });
    expect(native.ok).toBe(true);
    if (!native.ok) throw new Error(native.error.message);
    const reopened = parseNativeCadDocumentFromString(native.value);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.value.document.id).toBe(HUB_MOUNT_DOCUMENT_ID);
    expect(
      reopened.value.document.features.map((feature) => feature.kind),
    ).toEqual(["extrude", "revolve", "loft", "subtract", "union"]);
    expect(reopened.value.document.bodies.map((body) => body.id)).toEqual([
      "body_plate",
      "body_ring",
      "body_boss",
      "body_cleared",
      "body_mount",
    ]);
    // One compile = one committed transaction in the persisted log.
    expect(reopened.value.history.entries).toHaveLength(1);
  });

  it("reports the guide's numbers: validator clean, resave byte-identical", () => {
    const summary = runCadJsxExample();
    expect(summary.documentId).toBe(HUB_MOUNT_DOCUMENT_ID);
    expect(summary.formatVersion).toBe(CAD_NATIVE_FORMAT_VERSION);
    expect(summary.featureKinds).toEqual([
      "extrude",
      "revolve",
      "loft",
      "subtract",
      "union",
    ]);
    expect(summary.bodyIds).toEqual([
      "body_plate",
      "body_ring",
      "body_boss",
      "body_cleared",
      "body_mount",
    ]);
    // The plate's height parameter plus the revolve's angle and axis and
    // the loft's two stations: five document parameters in all.
    expect(summary.parameterCount).toBe(5);
    expect(summary.reopenedTransactionCount).toBe(1);
    expect(summary.validatorIssues).toBe(0);
    expect(summary.resaveIdentical).toBe(true);
    expect(summary.textBytes).toBeGreaterThan(0);
    expect(summary.commandCount).toBeGreaterThan(0);
  });
});

describe("guide example: simulation spine (Phase 61)", () => {
  it("hashes, compiles, declines, round-trips, and exports the spine", () => {
    const summary = runSimSpineExample();
    // Provenance: the scenario-snapshot hash is 8 hex digits over the
    // canonical JSON — key order cannot move it, any edit does.
    expect(summary.snapshotHash).toMatch(/^[0-9a-f]{8}$/);
    expect(summary.reorderedSnapshotHash).toBe(summary.snapshotHash);
    expect(summary.editedSnapshotHash).not.toBe(summary.snapshotHash);
    expect(summary.compiledSnapshotHash).toBe(summary.snapshotHash);
    // S4: the document's millimetres crossed into solver SI.
    expect(summary.domainMinM).toEqual([-0.5, -0.25, -0.25]);
    expect(summary.cellSizeM).toBeCloseTo(0.002, 12);
    // No materials cover the bodies, so the characteristic length is the
    // domain box's smallest extent: 500 mm.
    expect(summary.characteristicLengthM).toBeCloseTo(0.5, 12);
    // S9, hand-computed from the air record's own fits at its 300 K
    // reference: Re = ρ·V·L/μ, Ma = V/c, Pr = μ·cp/k.
    expect(summary.reynolds).toBeCloseTo(
      (1.176472549 * 10 * 0.5) / 1.845921383e-5,
      6,
    );
    expect(summary.mach).toBeCloseTo(10 / 347.2, 12);
    expect(summary.prandtl).toBeCloseTo((1.845921383e-5 * 1006) / 0.0263, 6);
    // Re ≈ 3.19e5 crosses the 4000 turbulence threshold; Ma ≈ 0.029
    // stays under the 0.3 compressibility line — one honest flag.
    expect(summary.qualitative).toEqual(["turbulence-dominated"]);
    // Phase 69 flipped the carve live: the structural kind compiles like
    // every other, its law-S9 claim the empty regime report.
    expect(summary.structuralRegimeEmpty).toBe(true);
    // S7: the SMR1 payload decodes back to the authored block, and both
    // deterministic exports carry their bytes.
    expect(summary.payloadBytes).toBeGreaterThan(0);
    expect(summary.decodedRoundTrip).toBe(true);
    expect(summary.vtiBytes).toBeGreaterThan(0);
    expect(summary.vtiIsImageData).toBe(true);
    expect(summary.csvRows).toBe(6);
    expect(summary.csvHeader).toBe("drag (N)");
  });
});

describe("guide example: the stove (Phase 65 — conduction and conjugate heat transfer)", () => {
  it(
    "settles the sealed equilibrium with a closing balance and runs the coupled plume",
    { timeout: 30_000 },
    async () => {
      const summary = await runSimThermalExample();
      // The kind-lock: a thermal record without its stance declines at
      // the document boundary.
      expect(summary.stanceDeclined).toBe(true);
      // The sealed stove settles above its 293.15 K ambient, inside a
      // physical band (an 8 W/m source against steel conduction and the
      // §7.12 equilibrium boundary).
      expect(summary.settledMaxK).toBeGreaterThan(293.15);
      expect(summary.settledMaxK).toBeLessThan(400);
      // The MEASURED energy balance closes: |imbalance|/source ≤ 2%.
      expect(summary.balanceRelative).toBeLessThan(0.02);
      // The one field block is the temperature overlay's.
      expect(summary.fieldId).toBe("temperature");
      // The coupled plume: the air warmed above its initial field, and
      // the march's ledger closes within 5% of its term scale.
      expect(summary.plumeFluidMaxK).toBeGreaterThan(293.15);
      expect(summary.plumeClosureRelative).toBeLessThan(0.05);
      // Both engines are deterministic end to end.
      expect(summary.deterministic).toBe(true);
    },
  );
});

describe("guide example: the voxelizer (Phase 62, law S3)", () => {
  it("voxelizes the analytic box exactly, signs it, and round-trips the block", () => {
    const summary = runSimVoxelExample();
    // The explicit [0, 16]³ domain at 2 mm: 9 nodes per axis.
    expect(summary.shape).toEqual([9, 9, 9]);
    expect(summary.totalNodes).toBe(729);
    // The box spans [4, 12]³: nodes 4..12 step 2 — 5 per axis, exact.
    expect(summary.occupiedNodes).toBe(125);
    // The closed-set convention: the node exactly ON the corner is inside.
    expect(summary.boundaryNodesInside).toBe(true);
    // The z = 8 slice: one node on the plane, the same 5×5 in-plane set.
    expect(summary.sliceShape).toEqual([9, 9, 1]);
    expect(summary.sliceOccupiedNodes).toBe(25);
    // The signed distances at the probed nodes are exact millimetres in
    // metres: +2 mm outside the −x face, −4 mm at the centre.
    expect(summary.distanceOutsideM).toBeCloseTo(0.002, 15);
    expect(summary.distanceCenterM).toBeCloseTo(-0.004, 15);
    // The block carries occupancy's dimensionless unit label, and the
    // grid → block → payload → decode → grid door is exact.
    expect(summary.occupancyUnit).toBe("1");
    expect(summary.roundTripIdentical).toBe(true);
  });
});

describe("guide example: the sim demo body (Phase 62c fixture model)", () => {
  it("compiles the plate-with-bore model to a valid parametric document", () => {
    const summary = runSimDemoBodyExample();
    expect(summary.formatVersion).toBe(CAD_NATIVE_FORMAT_VERSION);
    // The plate extrusion and the bore hole: the two features the
    // /workbench-sim fixture renders and voxelizes; the hole's output is
    // the <Body> record it was authored inside.
    expect(summary.featureKinds).toEqual(["extrude", "hole"]);
    expect(summary.bodyIds).toEqual(["body_sim-demo", "body_plate"]);
    // thickness and bore, plus the hole's flat-form parameters.
    expect(summary.parameterCount).toBeGreaterThan(2);
    expect(summary.validatorIssues).toBe(0);
    expect(summary.commandCount).toBeGreaterThan(0);
    expect(summary.textBytes).toBeGreaterThan(0);
  });
});

describe("guide example: the known-cases gallery — cylinder shedding (Phase 63d)", () => {
  it("sheds at a Strouhal inside the stated band against Roshko's correlation", () => {
    const summary = runCylinderSheddingExample();
    // The scenario's own regime numbers: Re = 100 exactly (the lattice
    // was designed for it), Ma ≈ 3.8e-4 — no S9 flags at this Re.
    expect(summary.reynolds).toBeCloseTo(100, 6);
    expect(summary.mach).toBeLessThan(0.001);
    expect(summary.latticeMach).toBeLessThan(0.3);
    expect(summary.qualitative).toEqual([]);
    expect(summary.completed).toBe(true);
    // The published answer: Roshko's unconfined correlation
    // St = 0.212(1 − 21.2/Re) (NACA TN 3169, public domain) at Re=100.
    expect(summary.roshkoStrouhal).toBeCloseTo(roshkoStrouhal(100), 9);
    expect(summary.roshkoStrouhal).toBeCloseTo(0.167, 3);
    // The measured answer (deterministic — measured at authoring time
    // as St = 0.2309): enough cycles for a trustworthy period estimate,
    // and inside the STATED band [0.9, 1.8]× the unconfined value —
    // confinement at 25% blockage with slip walls inflates St; the
    // band is the honest qualitative window per law S9, never a
    // false-precision pin.
    expect(summary.cycles).toBeGreaterThanOrEqual(20);
    expect(summary.strouhal).toBeCloseTo(0.231, 2);
    expect(summary.withinBand).toBe(true);
  }, 300_000);
});

describe("guide example: the known-cases gallery — NACA 0012 (Phase 63d)", () => {
  it("lifts with the public-domain slope inside the stated band, blockage stated", () => {
    const summary = runNacaAirfoilExample();
    expect(summary.reynolds).toBeCloseTo(200, 6);
    expect(summary.mach).toBeLessThan(0.001);
    expect(summary.completed).toBe(true);
    // α = 0: the mask is exactly mirror-symmetric, so the lift is
    // bitwise zero (the kernel's sign-exact mirror symmetry — the same
    // fact the symmetry fixture pins at the kernel level).
    expect(summary.clAtZeroAlpha).toBe(0);
    // The measured answer at α = 8° (deterministic — 0.8005 at
    // authoring time), against the public-domain reference: thin-
    // airfoil theory's 2π/rad slope (textbook inviscid), with the
    // NACA Report 824 experimental slope (≈ 0.11/deg at high Re) as
    // the flight-Re reference our low-Re band brackets from below.
    expect(summary.clAtEightDeg).toBeCloseTo(0.801, 2);
    expect(summary.thinAirfoilSlopePerRad).toBeCloseTo(2 * Math.PI, 12);
    expect(summary.slopeRatio).toBeCloseTo(0.913, 2);
    expect(summary.withinBand).toBe(true);
    // Pressure drag grows with incidence, and the confined tunnel's
    // blockage (≈ 19% at α = 8°) is stated beside the coefficients —
    // the roadmap's blockage-honesty sentence, machine-checked.
    expect(summary.cdAtEightDeg).toBeGreaterThan(summary.cdAtZeroAlpha);
    expect(summary.blockage).toBeCloseTo(0.194, 2);
    // The honest Cd statement: at Re = 200 with staircase boundaries
    // the drag sits far above the high-Re published skin-friction
    // levels — comparative, not absolute (law S3's posture).
    expect(summary.cdAtEightDeg).toBeGreaterThan(0.1);
  }, 300_000);
});

describe("guide example: the known-cases gallery — the shock tube declines loudly (Phase 63d)", () => {
  it("refuses the canonical Sod fixture on three independent, machine-verified walls", () => {
    const summary = runShockTubeDeclineExample();
    // The canonical state: shock Ma ≈ 1.75 (Sod 1978).
    expect(summary.shockMach).toBe(SOD_SHOCK_MACH);
    // Wall 1 — the S9 regime report flags the compressibility the
    // weakly-compressible D2Q9 lattice cannot represent (and the huge
    // Re raises the turbulence flag beside it).
    expect(summary.flaggedCompressible).toBe(true);
    expect(summary.qualitative).toContain("compressibility-affected");
    expect(summary.qualitative).toContain("turbulence-dominated");
    // Walls 2 and 3 — the kernel's own mechanical refusals: the
    // Ma-1.75 inlet collapses onto the τ⁺ stability floor, and the
    // 10:1 atmospheric ratio drives the lattice density non-positive.
    expect(summary.inletAccepted).toBe(false);
    expect(summary.pressureRatioAccepted).toBe(false);
    // The decline is stated loudly — the guide prints this verbatim.
    expect(summary.declineReason).toContain("Sod shock tube");
    expect(summary.declineReason).toContain("declines the case loudly");
  });
});

describe("guide example: the motor-driven fan (Phase 66)", () => {
  it("finds the operating point and reports the fan family, deterministically", async () => {
    const summary = await runSimFanExample();
    // The cut-cell reserve declines loudly (the 66c decision).
    expect(summary.cutCellDeclined).toBe(true);
    // FOUND, not assumed: the point sits strictly inside the ladder.
    expect(summary.operatingOmegaRadPerS).toBeGreaterThan(
      0.25 * summary.noLoadRadPerS,
    );
    expect(summary.operatingOmegaRadPerS).toBeLessThan(summary.noLoadRadPerS);
    // BPF = blades × rpm / 60 at the found point (4 blades).
    const rpm = (summary.operatingOmegaRadPerS * 60) / (2 * Math.PI);
    expect(summary.bladePassFrequencyHz).toBeCloseTo((4 * rpm) / 60, 9);
    // The performance is extracted AT the found point (finite reads).
    expect(Number.isFinite(summary.airflowM3PerS)).toBe(true);
    expect(Number.isFinite(summary.pressureRisePa)).toBe(true);
    // The S9 fan Re guidance line flags the low-Re demo regime.
    expect(summary.fanReynoldsTip).toBeGreaterThan(0);
    expect(summary.fanReynoldsTip).toBeLessThan(1e4);
    expect(summary.flags).toContain("low-reynolds-fan");
    // The published chart's history pair (four ladder rungs).
    expect(summary.loadCurveSamples).toBe(4);
    // Determinism (law S2).
    expect(summary.deterministic).toBe(true);
  }, 300_000);
});

describe("guide example: the premixed Otto engine (Phase 68)", () => {
  it("runs the base case and one sweep with the families side by side, deterministically", async () => {
    const summary = await runSimCombustionExample();
    // The kind-lock at the record boundary (the sentence the guide
    // states).
    expect(summary.stanceDeclined).toBe(true);
    // Spray is declined at every level — never approximated.
    expect(summary.sprayDeclineCode).toBe("sim/combustion-mode-unsupported");
    // The gas-path truth in the SI band at CR 10, WOT stoichiometric.
    expect(summary.imepPa).toBeGreaterThan(8e5);
    expect(summary.imepPa).toBeLessThan(2.5e6);
    // The brake family sits below the indicated by the friction
    // overlay (Chen–Flynn + pumping).
    expect(summary.bmepPa).toBeGreaterThan(5e5);
    expect(summary.bmepPa).toBeLessThan(summary.imepPa);
    // The loss family closes the balance: fuel = brake + friction +
    // exhaust enthalpy + wall heat, residual at the float floor.
    expect(summary.auditRelative).toBeLessThan(1e-6);
    // The knock report's comparative integral is aboard.
    expect(summary.knockIntegralMax).toBeGreaterThan(1);
    // The P-vs-crank trace: the closed cycle's grid (720° at 0.5°).
    expect(summary.traceSamples).toBe(721);
    // The spark sweep: 7 rows (10° to 50° over 6 intervals) with the
    // knock boundary marked inside the span.
    expect(summary.sweepRows).toBe(7);
    expect(summary.knockBoundaryDeg).toBeDefined();
    if (summary.knockBoundaryDeg !== undefined) {
      expect(summary.knockBoundaryDeg).toBeGreaterThanOrEqual(10);
      expect(summary.knockBoundaryDeg).toBeLessThanOrEqual(50);
    }
    // Determinism (law S2).
    expect(summary.deterministic).toBe(true);
  }, 300_000);
});

describe("guide example: the bracket (Phase 69 — coarse voxel FEM)", () => {
  it(
    "holds the load, reports the FoS family, and chains hot and spun variants",
    { timeout: 120_000 },
    async () => {
      const summary = await runSimStructuralExample();
      // The kind-lock: a structural record without its stance declines
      // at the document boundary.
      expect(summary.stanceDeclined).toBe(true);
      // The machine-readable scalar family Phase 70 optimizes against.
      // Measured (2026-10-13, the demo fixture): 0.0353 mm tip
      // deflection at 8.09 MPa — the coarse element-center recovery's
      // comparative band, stated.
      expect(summary.deflectionMm).toBeGreaterThan(0.01);
      expect(summary.deflectionMm).toBeLessThan(0.1);
      expect(summary.vonMisesPa).toBeGreaterThan(4e6);
      expect(summary.vonMisesPa).toBeLessThan(2e7);
      expect(summary.factorOfSafety).toBeGreaterThan(10);
      // The FoS arithmetic: yield / max von Mises.
      expect(summary.fosArithmeticHolds).toBe(true);
      // Both overlay blocks persist — displacement first in the
      // result's own field array (the preview stream publishes von
      // Mises first and displacement last, the live-overlay order).
      expect(summary.fieldIds).toEqual(["displacement", "von-mises"]);
      // The hot bracket (ΔT = +100 K uniform): the CHT→structural
      // seam's thermal load dominates the dry tip load.
      expect(summary.hotVonMisesPa).toBeGreaterThan(10 * summary.vonMisesPa);
      // The spun bracket (3000 rpm): the centrifugal body force bends
      // the wall past the dry run's stress.
      expect(summary.spunVonMisesPa).toBeGreaterThan(2 * summary.vonMisesPa);
      // Determinism (law S2).
      expect(summary.deterministic).toBe(true);
    },
  );
});

describe("guide example: the optimization studies (Phase 70, the finale)", () => {
  it(
    "evolves the lightest bracket that survives the load",
    { timeout: 240_000 },
    async () => {
      const summary = await runSimStudyBracketExample();
      // The front exists and spans the trade-off: mass and FoS rise
      // together along it (the dominated-front structure).
      expect(summary.frontSize).toBeGreaterThan(1);
      expect(summary.frontMonotone).toBe(true);
      expect(summary.massMaxKg).toBeGreaterThan(summary.massMinKg);
      expect(summary.factorOfSafetyMax).toBeGreaterThan(
        summary.factorOfSafetyMin,
      );
      // The slenderness constraint declines the thin-tall corner (a
      // structured decline counted as dominated, never a crash).
      expect(summary.constraintDeclineSeen).toBe(true);
      expect(summary.declined).toBeGreaterThan(0);
      expect(summary.evaluations).toBeGreaterThan(0);
      // Determinism (law S2/S5): the same seed re-runs to the same
      // front, and the champion replays to its exact vector.
      expect(summary.deterministic).toBe(true);
      expect(summary.replayIdentical).toBe(true);
      // The Pareto CSV: the header names the objective columns in the
      // runs' own units, one row per front candidate.
      expect(summary.csvHeader).toBe(
        "candidate,mass (kg),factor-of-safety (1),param_thickness,param_wall-height",
      );
      expect(summary.csvRows).toBe(summary.frontSize);
    },
  );

  it(
    "co-optimizes the most efficient fan — the motor record a gene",
    { timeout: 600_000 },
    async () => {
      const summary = await runSimStudyFanExample();
      // Every scored candidate found an operating point and projected
      // the air-per-watt system objective at it.
      expect(summary.objectiveProjected).toBe(true);
      expect(summary.championAirPerWatt).toBeGreaterThan(0);
      expect(summary.championOperatingRpm).toBeGreaterThan(0);
      expect(["mot_speedy", "mot_torquey"]).toContain(summary.championMotorId);
      expect(summary.evaluations).toBeGreaterThan(0);
      // Determinism (law S2/S5) and the exact replay.
      expect(summary.deterministic).toBe(true);
      expect(summary.replayIdentical).toBe(true);
    },
  );
});
