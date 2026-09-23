/**
 * The docs-examples proof suite, part 1 (node): runs every headless
 * example and asserts the outcomes the guides state. When a guide says
 * "the reopened document is serialization-identical", the assertion
 * below is the machine check of that sentence.
 */

import { threadId } from "node:worker_threads";
import { beforeAll, describe, expect, it } from "vitest";
import { CAD_NATIVE_FORMAT_VERSION } from "@slopcad/cad-core";
import { createFakeKernel } from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";

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
