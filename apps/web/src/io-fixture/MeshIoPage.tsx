/**
 * The /io fixture (Phase 18 phase-level browser deliverable): ONE page that
 * exercises the mesh import/export workflow against the live plate — export
 * the settled source solid to STL and 3MF, import those bytes back, and
 * render the imported mesh in its own deterministic viewport.
 *
 * ## Placement (why a dedicated page, not the workbench)
 *
 * The imported mesh IS the plate's geometry in the same canonical
 * millimetre coordinates; rendered into the workbench viewport it would
 * sit exactly on top of the parametric plate. A dedicated page keeps the
 * two viewports side by side (source and import are directly comparable —
 * same home-view direction), keeps the Phase 15 workbench's byte-stable
 * baselines untouched, and gives the round-trip a machine-readable surface
 * of its own.
 *
 * ## Honest provenance (the plan's no-fabrication rule, in the UI)
 *
 * The imported body renders through the same `projectTessellation`
 * boundary as any tessellation, under its own body id, and every label
 * says what it is: a mesh body with a triangle count and a volume — never
 * a feature, never parametric history. The 3MF import path is labeled
 * truthfully too: the Phase 18.4 importer is Node-targeted (`node:zlib`),
 * so 3MF bytes are parsed by the app's own server (`/api/io/import-3mf`)
 * while STL import runs fully in the browser.
 *
 * ## Workflow
 *
 * Export buttons take the SETTLED source tessellation (the same soup the
 * source viewport renders) and hold the bytes in page state; the import
 * buttons round-trip exactly those held bytes (the E2E-deterministic
 * programmatic path), and the file input runs the same import functions on
 * disk files for humans. Both imports end in the same `buildImportedMeshState`
 * projection; the imported viewport's settle stamp
 * (`data-cad-imported-volume`) equals its volume readout
 * (`data-import-volume`) exactly when the rendered pixels carry the
 * imported geometry.
 *
 * The Phase 19 GLB path extends the same pattern one step further: Export
 * GLB holds the bytes of the exported RENDER PROJECTION (cad-core's
 * renderer-neutral render data — the exporter's input surface), and Load
 * held GLB parses those bytes with three's GLTFLoader (the plan's
 * reference viewer) and renders the LOADED geometry in the third viewport.
 * Its machine surface: `data-export-glb-bytes` /
 * `data-export-glb-triangles`, `data-glb-status` ("loaded" once the loader
 * parsed the bytes), `data-glb-nodes` (loaded node names + decoded counts,
 * JSON), `data-glb-material` (the parsed pbrMetallicRoughness material,
 * JSON), `data-glb-volume-exact` / `data-glb-extents` of the decoded soup,
 * the loaded scene's settle stamp `data-cad-glb-volume` and its
 * rendered-frame counter `data-glb-frames`. GLB load failures share the
 * page's error surface (`data-import-error` / the error paragraph).
 *
 * The Phase 21.3 STEP path extends the import side instead: a `.step`/
 * `.stp` upload feeds the file's raw bytes to the REAL OpenCascade worker
 * through the worker protocol — `step.import`, then `solid.tessellate` and
 * `solid.dispose` per imported solid (see `./io-step`). The OCCT worker
 * boots lazily on the first STEP import and is terminated with the page.
 * The imported geometry-only solids share the imported-mesh viewport and
 * its whole `data-import-*` surface, with `data-import-source="step"` and
 * `data-import-detail` carrying the provenance JSON
 * (`{"origin":"imported-step","solids":n,"unit":"mm"}`) — imported STEP
 * solids are BREP bodies in canonical millimetres, no names/colors/history
 * (the binding's XCAF layer is unbound), never a parametric feature.
 *
 * The Phase 21.4 STEP export extends the export side with one honest
 * caveat: STEP export is OpenCascade-ONLY, and the source plate is
 * Manifold-built — a Manifold solid cannot cross into the OCCT worker. The
 * Export STEP button therefore REBUILDS the same plate on the OCCT worker
 * through the worker protocol's own operations and exports it with
 * `step.export` (see `./io-step`'s design decision); the held bytes are a
 * real deterministic STEP file offered as a `plate.step` download, and
 * Import held STEP round-trips them through the same import flow as an
 * upload — a full OCCT export→import cycle through the browser. Machine
 * surface: `data-export-step-bytes` / `data-export-step-solids`; failures
 * share the page's error readout.
 *
 * The Phase 21.5 BREP paths keep full parity with their STEP twins over
 * OCCT's native form (see `./io-brep`): Export BREP rebuilds the plate on
 * the same lazily-booted OCCT worker and exports it with `brep.export`
 * (machine surface `data-export-brep-bytes` / `data-export-brep-solids`,
 * held as a `plate.brep` download); a `.brep` upload and Import held BREP
 * run `brep.import` → tessellate → dispose through the same channel, with
 * `data-import-source="brep"` and the `{"origin":"imported-brep",…}`
 * provenance JSON. The Phase 21.5 IGES path is deliberately NOT the worker
 * path: `occt-import-js` (the plan's fallback engine) reads IGES to MESHES,
 * not solids, so the import runs on the main thread like STL (see
 * `./io-iges`) — a lazily-booted ~7.3 MB wasm, mesh-level provenance
 * (`{"origin":"imported-iges","meshes":n,"unit":"mm"}`), never a kernel
 * solid or a parametric feature.
 *
 * ## Machine-readable surface (`#io-root`)
 *
 * The source session's settle attributes (written by the shared fixture
 * session: `data-in-flight`, `data-applied-revision`,
 * `data-current-revision`, `data-volume`, `data-error`, and the source
 * viewport's `data-cad-rendered-volume`), the export
 * surface (`data-export-stl-bytes` / `data-export-3mf-bytes` byte counts plus
 * `data-export-stl-triangles` / `data-export-3mf-triangles`, each export
 * offered to humans as a real `download` anchor), the source soup's
 * machine-precision mesh volume (`data-source-mesh-volume` — the same
 * divergence-theorem measure the import path uses, so the 3MF round trip
 * can assert exact numeric identity), the import
 * surface (`data-import-source`, `data-import-triangles`,
 * `data-import-volume` (3dp readout), `data-import-volume-exact` (full f64
 * precision), `data-import-extents`, `data-import-detail` —
 * flavor for STL, declared unit and title for 3MF — and `data-import-error`),
 * the imported scene's settle stamp `data-cad-imported-volume` and its
 * rendered-frame counter `data-imported-frames` (the settle-surface pair
 * every fixture publishes), and the STEP and BREP export surfaces
 * (`data-export-step-bytes` / `data-export-step-solids` and
 * `data-export-brep-bytes` / `data-export-brep-solids` of the held files).
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
// Deep imports, deliberately: the cad-io index also re-exports the
// Node-targeted 3MF importer (`node:zlib`), and an index import would pull
// that module into the browser bundle. The page uses the browser-safe
// adapters directly; 3MF import goes through the app server instead.
import { exportGlb } from "@slopcad/cad-io/glb-export";
import { exportThreeMf } from "@slopcad/cad-io/three-mf-export";
import type { ImportedThreeMfMesh } from "@slopcad/cad-io/three-mf-import";
import { exportStlBinary } from "@slopcad/cad-io/stl-export";
import { importStl } from "@slopcad/cad-io/stl-import";
import type { ImportedStlMesh } from "@slopcad/cad-io/stl-import";
import { formatBoundsExtents } from "@slopcad/cad-core";
import { bootWorkerChannel, WorkerRequestFailure } from "@slopcad/cad-kernel";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { CadScene } from "@slopcad/cad-r3f";
import { Button } from "@slopcad/ui/components/button";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";
import type { ThreeMfImportResponse } from "./io-protocol";
import type { GlbViewerState } from "./io-glb";

import {
  bootRenderFixtureSession,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import {
  buildImportedMeshState,
  meshSignedVolume,
  type ImportedMeshState,
} from "./io-mesh";
import { loadGlbViewerState } from "./io-glb";
import {
  buildImportedStepState,
  exportPlateStepOverWorker,
  importStepBytesOverWorker,
  type ImportedStepState,
} from "./io-step";
import {
  buildImportedBrepState,
  exportPlateBrepOverWorker,
  importBrepBytesOverWorker,
  type ImportedBrepState,
} from "./io-brep";
import { importIgesBytes, type ImportedIgesState } from "./io-iges";

/** One held export: the exact bytes plus the triangle count they encode. */
interface HeldExport {
  readonly bytes: Uint8Array;
  readonly triangles: number;
  /** Object URL serving exactly `bytes` (the human download affordance). */
  readonly downloadUrl: string;
}

/**
 * One held STEP export: the deterministic file bytes plus the exported
 * solid count (STEP carries BREP, not triangles — the count is the honest
 * readout) and the download affordance.
 */
interface HeldStepExport {
  readonly bytes: Uint8Array;
  readonly solids: number;
  readonly downloadUrl: string;
}

/**
 * One held BREP export: the deterministic file bytes plus the exported
 * solid count — the STEP twin's shape over OCCT's native form.
 */
interface HeldBrepExport {
  readonly bytes: Uint8Array;
  readonly solids: number;
  readonly downloadUrl: string;
}

/** The imported mesh, STEP/BREP solid, or IGES mesh state — the mesh-side readouts. */
type ImportedState =
  ImportedMeshState | ImportedStepState | ImportedBrepState | ImportedIgesState;

/** What the import surface shows once a mesh is in. */
interface ImportView {
  /** Which format the mesh arrived through — the honest provenance. */
  readonly source: "stl" | "3mf" | "step" | "brep" | "iges";
  /** Flavor (STL), declared unit + title (3MF), or provenance + count + unit (STEP/BREP/IGES), as stable JSON. */
  readonly detailJson: string;
  /** The validated, renderable imported mesh. */
  readonly mesh: ImportedState;
}

/** The lazily-booted OCCT worker session behind the STEP and BREP paths. */
interface OcctWorkerSession {
  readonly dispose: () => void;
  readonly client: WorkerClient;
}

/** The 3MF document title the exporter stamps (round-trips the import). */
const EXPORT_TITLE = "slopcad plate";

/** The imported-mesh viewport's fixed box (determinism contract, as on
 * every fixture: the camera fit is pure, the size is constant per page). */
const VIEWPORT_CLASS = "h-[400px] w-[600px]";

export function MeshIoPage(): ReactElement {
  const [applied, setApplied] = useState<PlateRenderState | null>(null);
  const [heldStl, setHeldStl] = useState<HeldExport | null>(null);
  const [held3Mf, setHeld3Mf] = useState<HeldExport | null>(null);
  const [heldGlb, setHeldGlb] = useState<HeldExport | null>(null);
  const [heldStep, setHeldStep] = useState<HeldStepExport | null>(null);
  const [stepExportPending, setStepExportPending] = useState(false);
  const [heldBrep, setHeldBrep] = useState<HeldBrepExport | null>(null);
  const [brepExportPending, setBrepExportPending] = useState(false);
  const [importView, setImportView] = useState<ImportView | null>(null);
  const [importError, setImportError] = useState("");
  const [importPending, setImportPending] = useState(false);
  const [importedFrames, setImportedFrames] = useState(0);
  const [glbView, setGlbView] = useState<GlbViewerState | null>(null);
  const [glbPending, setGlbPending] = useState(false);
  const [glbFrames, setGlbFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);
  const occtWorkerRef = useRef<OcctWorkerSession | null>(null);

  useEffect(() => {
    const session = bootRenderFixtureSession(
      {
        rootId: "io-root",
        statusId: "io-source-status",
        volumeId: "io-source-volume",
        trianglesId: "io-source-triangles",
        errorId: "io-source-error",
      },
      (state) => {
        setApplied(state);
      },
    );
    sessionRef.current = session;
    session.dispatch(PLATE_HOLE_DIAMETER_DEFAULT_MM);
    return () => {
      sessionRef.current = null;
      session.dispose();
      // The lazily-booted OCCT worker dies with the page.
      occtWorkerRef.current?.dispose();
      occtWorkerRef.current = null;
    };
  }, []);

  /**
   * Boots the OCCT worker on the FIRST STEP or BREP exchange — the ~22 MB
   * kernel is not paid by pages that never use it — and reuses it
   * afterwards for both formats. The worker entry buffers requests that
   * race its WASM boot, so no readiness handshake is needed. The
   * crash-settling boot (Phase 35 hardening) settles in-flight requests
   * if the thread ever dies; a crashed channel is forgotten so the next
   * exchange boots a fresh worker, and the failure surfaces through the
   * import error state.
   */
  const bootOcctWorker = (): WorkerClient => {
    const existing = occtWorkerRef.current;
    if (existing !== null) return existing.client;
    const boot = bootWorkerChannel(
      new Worker(
        new URL("../worker-fixture/occt-worker-entry.ts", import.meta.url),
        {
          type: "module",
        },
      ),
      (failure) => {
        if (occtWorkerRef.current === session) occtWorkerRef.current = null;
        setImportError(
          `worker channel failed (${failure.kind}): ${failure.message}`,
        );
      },
    );
    const session: OcctWorkerSession = {
      dispose: () => boot.dispose(),
      client: boot.client,
    };
    occtWorkerRef.current = session;
    return session.client;
  };

  /** Exports the settled source soup; returns null when it cannot. */
  const exportHeld = (format: "stl" | "3mf" | "glb"): HeldExport | null => {
    if (applied === null) return null;
    const tessellation = applied.measurement.tessellation;
    const triangles = tessellation.indices.length / 3;
    const result =
      format === "stl"
        ? exportStlBinary(tessellation)
        : format === "3mf"
          ? exportThreeMf(tessellation, { title: EXPORT_TITLE })
          : // GLB exports the RENDER PROJECTION — the renderer-neutral
            // render data (kernel normals included), the plan's stated
            // Phase 19 input — not the raw soup.
            exportGlb(applied.projection);
    if (!result.ok) {
      setImportError(`${result.error.code}: ${result.error.message}`);
      return null;
    }
    return {
      bytes: result.value,
      triangles,
      downloadUrl: URL.createObjectURL(
        new Blob([new Uint8Array(result.value)]),
      ),
    };
  };

  const exportStl = (): void => {
    const held = exportHeld("stl");
    if (held === null) return;
    if (heldStl !== null) URL.revokeObjectURL(heldStl.downloadUrl);
    setHeldStl(held);
  };

  const export3Mf = (): void => {
    const held = exportHeld("3mf");
    if (held === null) return;
    if (held3Mf !== null) URL.revokeObjectURL(held3Mf.downloadUrl);
    setHeld3Mf(held);
  };

  const exportGlbBytes = (): void => {
    const held = exportHeld("glb");
    if (held === null) return;
    if (heldGlb !== null) URL.revokeObjectURL(heldGlb.downloadUrl);
    setHeldGlb(held);
  };

  /**
   * The Phase 21.4 path: rebuild the source plate's geometry on the OCCT
   * worker (STEP export is OpenCascade-only; the Manifold source cannot
   * cross kernels) and hold the exported deterministic STEP bytes.
   */
  const exportStepBytes = (): void => {
    if (stepExportPending) return;
    setStepExportPending(true);
    exportPlateStepOverWorker(bootOcctWorker())
      .then((bytes) => {
        if (heldStep !== null) URL.revokeObjectURL(heldStep.downloadUrl);
        setHeldStep({
          bytes,
          solids: 1,
          downloadUrl: URL.createObjectURL(new Blob([new Uint8Array(bytes)])),
        });
        setImportError("");
      })
      .catch((error: unknown) => {
        if (error instanceof WorkerRequestFailure) {
          const kernelCode = error.error.data?.kernelCode;
          setImportError(
            kernelCode === undefined
              ? `${error.error.code}: ${error.error.message}`
              : `${error.error.code} [${String(kernelCode)}]: ${error.error.message}`,
          );
        } else {
          setImportError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        setStepExportPending(false);
      });
  };

  /**
   * Loads the held GLB bytes through three's GLTFLoader (the reference
   * viewer) and adopts the loaded scene as the viewer render state.
   */
  const loadGlb = (): void => {
    if (heldGlb === null) return;
    setGlbPending(true);
    loadGlbViewerState(heldGlb.bytes)
      .then((state) => {
        setGlbView(state);
        setImportError("");
      })
      .catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setGlbPending(false);
      });
  };

  /** The one place an imported soup becomes the rendered import view. */
  const adoptMesh = (
    source: ImportView["source"],
    detailJson: string,
    mesh: ImportedState,
  ): void => {
    setImportError("");
    setImportView({ source, detailJson, mesh });
  };

  const importStlBytes = (bytes: Uint8Array): void => {
    const result = importStl(bytes);
    if (!result.ok) {
      setImportError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    const mesh: ImportedStlMesh = result.value;
    adoptMesh(
      "stl",
      JSON.stringify({ flavor: mesh.flavor }),
      buildImportedMeshState(mesh.tessellation),
    );
  };

  const import3MfBytes = async (bytes: Uint8Array): Promise<void> => {
    setImportPending(true);
    try {
      const response = await fetch("/api/io/import-3mf", {
        method: "POST",
        body: new Uint8Array(bytes),
      });
      const payload = (await response.json()) as ThreeMfImportResponse;
      if (!payload.ok) {
        setImportError(`${payload.code}: ${payload.message}`);
        return;
      }
      const mesh: ImportedThreeMfMesh = {
        tessellation: {
          positions: payload.positions,
          indices: payload.indices,
        },
        units: payload.units,
        metadata: payload.metadata,
      };
      adoptMesh(
        "3mf",
        JSON.stringify({ units: mesh.units, title: mesh.metadata.title }),
        buildImportedMeshState(mesh.tessellation),
      );
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportPending(false);
    }
  };

  /**
   * The Phase 21.3 path: STEP bytes import through the real OpenCascade
   * worker (`step.import` → tessellate → dispose each solid), and the
   * imported geometry-only solids render through the same projection as
   * every mesh import. Failures surface the channel's stable codes.
   */
  const importStepBytes = async (bytes: Uint8Array): Promise<void> => {
    setImportPending(true);
    try {
      const flow = await importStepBytesOverWorker(bootOcctWorker(), bytes);
      adoptMesh(
        "step",
        JSON.stringify({
          origin: "imported-step",
          solids: flow.refs.length,
          unit: "mm",
        }),
        buildImportedStepState(flow.soups),
      );
    } catch (error) {
      if (error instanceof WorkerRequestFailure) {
        // The kernel-side cause (e.g. `step-import/malformed`) rides the
        // error's data — surfaced verbatim next to the protocol code, so
        // the readout names the real failure, not just the envelope's.
        const kernelCode = error.error.data?.kernelCode;
        setImportError(
          kernelCode === undefined
            ? `${error.error.code}: ${error.error.message}`
            : `${error.error.code} [${String(kernelCode)}]: ${error.error.message}`,
        );
      } else {
        setImportError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setImportPending(false);
    }
  };

  const importHeld = (format: "stl" | "3mf"): void => {
    const held = format === "stl" ? heldStl : held3Mf;
    if (held === null) return;
    if (format === "stl") {
      importStlBytes(held.bytes);
    } else {
      import3MfBytes(held.bytes).catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : String(error));
      });
    }
  };

  /** Round-trips the held STEP bytes through the import flow (21.4). */
  const importHeldStep = (): void => {
    if (heldStep === null || importPending) return;
    importStepBytes(heldStep.bytes).catch((error: unknown) => {
      setImportError(error instanceof Error ? error.message : String(error));
    });
  };

  /**
   * The Phase 21.5 BREP export: the STEP twin's honest rebuild over OCCT's
   * native form — same plate, same worker session, `brep.export`.
   */
  const exportBrepBytes = (): void => {
    if (brepExportPending) return;
    setBrepExportPending(true);
    exportPlateBrepOverWorker(bootOcctWorker())
      .then((bytes) => {
        if (heldBrep !== null) URL.revokeObjectURL(heldBrep.downloadUrl);
        setHeldBrep({
          bytes,
          solids: 1,
          downloadUrl: URL.createObjectURL(new Blob([new Uint8Array(bytes)])),
        });
        setImportError("");
      })
      .catch((error: unknown) => {
        if (error instanceof WorkerRequestFailure) {
          const kernelCode = error.error.data?.kernelCode;
          setImportError(
            kernelCode === undefined
              ? `${error.error.code}: ${error.error.message}`
              : `${error.error.code} [${String(kernelCode)}]: ${error.error.message}`,
          );
        } else {
          setImportError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        setBrepExportPending(false);
      });
  };

  /**
   * The Phase 21.5 BREP import: bytes through the real OpenCascade worker
   * (`brep.import` → tessellate → dispose each solid), rendered through the
   * same projection as every import — the STEP path's twin.
   */
  const importBrepBytes = async (bytes: Uint8Array): Promise<void> => {
    setImportPending(true);
    try {
      const flow = await importBrepBytesOverWorker(bootOcctWorker(), bytes);
      adoptMesh(
        "brep",
        JSON.stringify({
          origin: "imported-brep",
          solids: flow.refs.length,
          unit: "mm",
        }),
        buildImportedBrepState(flow.soups),
      );
    } catch (error) {
      if (error instanceof WorkerRequestFailure) {
        const kernelCode = error.error.data?.kernelCode;
        setImportError(
          kernelCode === undefined
            ? `${error.error.code}: ${error.error.message}`
            : `${error.error.code} [${String(kernelCode)}]: ${error.error.message}`,
        );
      } else {
        setImportError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setImportPending(false);
    }
  };

  /** Round-trips the held BREP bytes through the import flow (21.5). */
  const importHeldBrep = (): void => {
    if (heldBrep === null || importPending) return;
    importBrepBytes(heldBrep.bytes).catch((error: unknown) => {
      setImportError(error instanceof Error ? error.message : String(error));
    });
  };

  /**
   * The Phase 21.5 IGES import: a MESH body read on the main thread by the
   * plan's fallback engine (`occt-import-js`, lazily booted — see
   * `./io-iges`), with the cad-io mesh-import provenance. Failures surface
   * the importer's structured `iges-import/*` codes verbatim.
   */
  const importIgesFileBytes = async (bytes: Uint8Array): Promise<void> => {
    setImportPending(true);
    try {
      const flow = await importIgesBytes(bytes);
      adoptMesh("iges", JSON.stringify(flow.detail), flow.state);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportPending(false);
    }
  };

  const importFile = (file: File): void => {
    const name = file.name.toLowerCase();
    const isStep = name.endsWith(".step") || name.endsWith(".stp");
    const isBrep = name.endsWith(".brep");
    const isIges = name.endsWith(".igs") || name.endsWith(".iges");
    if (
      !name.endsWith(".stl") &&
      !name.endsWith(".3mf") &&
      !isStep &&
      !isBrep &&
      !isIges
    ) {
      setImportError(`unsupported file type: ${file.name}`);
      return;
    }
    file
      .arrayBuffer()
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (name.endsWith(".stl")) {
          importStlBytes(bytes);
        } else if (isStep) {
          return importStepBytes(bytes);
        } else if (isBrep) {
          return importBrepBytes(bytes);
        } else if (isIges) {
          return importIgesFileBytes(bytes);
        } else {
          return import3MfBytes(bytes);
        }
      })
      .catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <div
      id="io-root"
      className="mx-auto w-full max-w-[1240px] space-y-4 p-4"
      data-export-stl-bytes={
        heldStl === null ? "" : String(heldStl.bytes.length)
      }
      data-export-stl-triangles={
        heldStl === null ? "" : String(heldStl.triangles)
      }
      data-export-3mf-bytes={
        held3Mf === null ? "" : String(held3Mf.bytes.length)
      }
      data-export-3mf-triangles={
        held3Mf === null ? "" : String(held3Mf.triangles)
      }
      data-export-glb-bytes={
        heldGlb === null ? "" : String(heldGlb.bytes.length)
      }
      data-export-glb-triangles={
        heldGlb === null ? "" : String(heldGlb.triangles)
      }
      data-export-step-bytes={
        heldStep === null ? "" : String(heldStep.bytes.length)
      }
      data-export-step-solids={heldStep === null ? "" : String(heldStep.solids)}
      data-export-brep-bytes={
        heldBrep === null ? "" : String(heldBrep.bytes.length)
      }
      data-export-brep-solids={heldBrep === null ? "" : String(heldBrep.solids)}
      data-glb-status={glbView === null ? "" : "loaded"}
      data-glb-nodes={glbView === null ? "" : JSON.stringify(glbView.meshes)}
      data-glb-material={
        glbView === null ? "" : JSON.stringify(glbView.material)
      }
      data-glb-volume-exact={glbView === null ? "" : String(glbView.volume)}
      data-glb-extents={
        glbView === null ? "" : formatBoundsExtents(glbView.bounds)
      }
      data-cad-glb-volume=""
      data-glb-frames={String(glbFrames)}
      data-import-source={importView === null ? "" : importView.source}
      data-import-triangles={
        importView === null ? "" : String(importView.mesh.triangles)
      }
      data-import-volume={
        importView === null ? "" : importView.mesh.volume.toFixed(3)
      }
      data-import-volume-exact={
        importView === null ? "" : String(importView.mesh.volume)
      }
      data-source-mesh-volume={
        applied === null
          ? ""
          : String(meshSignedVolume(applied.measurement.tessellation))
      }
      data-import-extents={
        importView === null ? "" : formatBoundsExtents(importView.mesh.bounds)
      }
      data-import-detail={importView === null ? "" : importView.detailJson}
      data-import-error={importError}
      data-cad-imported-volume=""
      data-cad-rendered-volume=""
      data-imported-frames={String(importedFrames)}
    >
      <div>
        <h1 className="text-lg font-semibold">
          Mesh I/O fixture (deterministic round trip)
        </h1>
        <p className="text-muted-foreground text-sm">
          Export the settled source solid to STL and 3MF, import the bytes back,
          render the imported mesh. STL import runs in the browser; 3MF import
          parses on the app server (the 18.4 importer is Node-targeted) and the
          mesh renders locally. An imported mesh is a mesh body — triangle soup,
          no parametric history. The GLB path (Phase 19) exports the source
          projection and loads the bytes back through three's GLTFLoader — the
          reference viewer — rendering the loaded geometry below. The STEP path
          (Phase 21.3) uploads a STEP file to the real OpenCascade worker — the
          ~22 MB kernel boots on first use — which imports it as geometry-only
          BREP solids in canonical millimetres; the solids tessellate over the
          worker protocol and render below like any mesh body (no names, colors,
          or history survive — the binding carries geometry and units only).
          STEP export (Phase 21.4) is OpenCascade-only, so the button rebuilds
          the source plate on the OCCT worker and exports it there — the held
          plate.step is that rebuild's deterministic file, importable below. The
          Phase 21.5 paths keep parity: Export BREP rebuilds the same plate and
          exports OCCT's native form (`brep.export`), and a `.brep` file imports
          through the same worker as BREP solids. IGES imports too — read to
          mesh bodies on the main thread by the plan's fallback engine
          (`occt-import-js`, lazily booted), the same class of import as STL: a
          triangle soup with a name, no kernel solid, no history.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Export</legend>
          <div className="flex items-center gap-2">
            <Button
              id="io-export-stl"
              type="button"
              variant="outline"
              size="sm"
              disabled={applied === null}
              onClick={exportStl}
            >
              Export STL
            </Button>
            <span className="font-mono text-xs" id="io-export-stl-readout">
              {heldStl === null ? (
                "—"
              ) : (
                <>
                  {`${String(heldStl.bytes.length)} B`}
                  {"\u00A0"}
                  <a
                    id="io-download-stl"
                    href={heldStl.downloadUrl}
                    download="plate.stl"
                    className="text-foreground underline underline-offset-2"
                  >
                    download
                  </a>
                </>
              )}
            </span>
            <Button
              id="io-export-3mf"
              type="button"
              variant="outline"
              size="sm"
              disabled={applied === null}
              onClick={export3Mf}
            >
              Export 3MF
            </Button>
            <span className="font-mono text-xs" id="io-export-3mf-readout">
              {held3Mf === null ? (
                "—"
              ) : (
                <>
                  {`${String(held3Mf.bytes.length)} B`}
                  {"\u00A0"}
                  <a
                    id="io-download-3mf"
                    href={held3Mf.downloadUrl}
                    download="plate.3mf"
                    className="text-foreground underline underline-offset-2"
                  >
                    download
                  </a>
                </>
              )}
            </span>
            <Button
              id="io-export-glb"
              type="button"
              variant="outline"
              size="sm"
              disabled={applied === null}
              onClick={exportGlbBytes}
            >
              Export GLB
            </Button>
            <span className="font-mono text-xs" id="io-export-glb-readout">
              {heldGlb === null ? (
                "—"
              ) : (
                <>
                  {`${String(heldGlb.bytes.length)} B`}
                  {"\u00A0"}
                  <a
                    id="io-download-glb"
                    href={heldGlb.downloadUrl}
                    download="plate.glb"
                    className="text-foreground underline underline-offset-2"
                  >
                    download
                  </a>
                </>
              )}
            </span>
            <Button
              id="io-export-step"
              type="button"
              variant="outline"
              size="sm"
              disabled={stepExportPending}
              onClick={exportStepBytes}
            >
              Export STEP
            </Button>
            <span className="font-mono text-xs" id="io-export-step-readout">
              {heldStep === null ? (
                stepExportPending ? (
                  "exporting…"
                ) : (
                  "—"
                )
              ) : (
                <>
                  {`${String(heldStep.bytes.length)} B`}
                  {"\u00A0"}
                  <a
                    id="io-download-step"
                    href={heldStep.downloadUrl}
                    download="plate.step"
                    className="text-foreground underline underline-offset-2"
                  >
                    download
                  </a>
                </>
              )}
            </span>
            <Button
              id="io-export-brep"
              type="button"
              variant="outline"
              size="sm"
              disabled={brepExportPending}
              onClick={exportBrepBytes}
            >
              Export BREP
            </Button>
            <span className="font-mono text-xs" id="io-export-brep-readout">
              {heldBrep === null ? (
                brepExportPending ? (
                  "exporting…"
                ) : (
                  "—"
                )
              ) : (
                <>
                  {`${String(heldBrep.bytes.length)} B`}
                  {"\u00A0"}
                  <a
                    id="io-download-brep"
                    href={heldBrep.downloadUrl}
                    download="plate.brep"
                    className="text-foreground underline underline-offset-2"
                  >
                    download
                  </a>
                </>
              )}
            </span>
          </div>
        </fieldset>
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">Import</legend>
          <div className="flex items-center gap-2">
            <input
              id="io-import-file"
              aria-label="Import mesh file"
              className="border-input bg-background file:bg-background file:text-foreground w-56 rounded border px-2 py-1 text-xs"
              type="file"
              accept=".stl,.3mf,.step,.stp,.brep,.igs,.iges"
              disabled={importPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) importFile(file);
              }}
            />
            <Button
              id="io-import-stl"
              type="button"
              variant="outline"
              size="sm"
              disabled={heldStl === null || importPending}
              onClick={() => {
                importHeld("stl");
              }}
            >
              Import held STL
            </Button>
            <Button
              id="io-import-3mf"
              type="button"
              variant="outline"
              size="sm"
              disabled={held3Mf === null || importPending}
              onClick={() => {
                importHeld("3mf");
              }}
            >
              Import held 3MF
            </Button>
            <Button
              id="io-load-glb"
              type="button"
              variant="outline"
              size="sm"
              disabled={heldGlb === null || glbPending}
              onClick={loadGlb}
            >
              Load held GLB
            </Button>
            <Button
              id="io-import-step"
              type="button"
              variant="outline"
              size="sm"
              disabled={heldStep === null || importPending}
              onClick={importHeldStep}
            >
              Import held STEP
            </Button>
            <Button
              id="io-import-brep"
              type="button"
              variant="outline"
              size="sm"
              disabled={heldBrep === null || importPending}
              onClick={importHeldBrep}
            >
              Import held BREP
            </Button>
          </div>
        </fieldset>
        <p
          data-testid="io-import-error"
          className="text-destructive min-w-48 font-mono text-xs"
        >
          {importError}
        </p>
      </div>
      <ul className="text-muted-foreground space-y-1 font-mono text-xs">
        <li>
          source = <span id="io-source-status">boot</span>, volume ={" "}
          <span id="io-source-volume">…</span>
          {"\u00A0"}mm³, triangles = <span id="io-source-triangles">…</span>
        </li>
        <li data-testid="io-import-readout">
          {importView === null ? (
            <span className="text-muted-foreground">no mesh imported</span>
          ) : (
            <>
              imported = <span id="io-import-source">{importView.source}</span>,
              triangles ={" "}
              <span id="io-import-triangles">
                {String(importView.mesh.triangles)}
              </span>
              , volume ={" "}
              <span id="io-import-volume">
                {importView.mesh.volume.toFixed(3)}
              </span>
              {"\u00A0"}mm³, extents ={" "}
              <span id="io-import-extents">
                {formatBoundsExtents(importView.mesh.bounds)}
              </span>
              {"\u00A0"}mm,{" "}
              <span id="io-import-detail">{importView.detailJson}</span>
            </>
          )}
        </li>
        <li data-testid="io-glb-readout">
          {glbView === null ? (
            <span className="text-muted-foreground">no GLB loaded</span>
          ) : (
            <>
              GLB ={" "}
              <span id="io-glb-nodes">{JSON.stringify(glbView.meshes)}</span>,
              material ={" "}
              <span id="io-glb-material">
                {JSON.stringify(glbView.material)}
              </span>
              , volume ={" "}
              <span id="io-glb-volume">{glbView.volume.toFixed(3)}</span>
              {"\u00A0"}mm³, extents ={" "}
              <span id="io-glb-extents">
                {formatBoundsExtents(glbView.bounds)}
              </span>
              {"\u00A0"}mm
            </>
          )}
        </li>
      </ul>
      <div className="flex items-start gap-3">
        <figure className="space-y-1">
          <figcaption className="text-muted-foreground text-xs">
            Source — parametric plate (kernel solid)
          </figcaption>
          <div
            id="io-source-viewport"
            className={`overflow-hidden border ${VIEWPORT_CLASS}`}
          >
            {applied === null ? (
              <div className="flex h-full items-center justify-center text-sm">
                evaluating…
              </div>
            ) : (
              <CadScene
                projection={applied.projection}
                onSettled={() => {
                  document
                    .getElementById("io-root")
                    ?.setAttribute(
                      "data-cad-rendered-volume",
                      applied.measurement.volume.toFixed(3),
                    );
                }}
              />
            )}
          </div>
        </figure>
        <figure className="space-y-1">
          <figcaption className="text-muted-foreground text-xs">
            Imported mesh — mesh body, no parametric history
          </figcaption>
          <div
            id="io-import-viewport"
            className={`overflow-hidden border ${VIEWPORT_CLASS}`}
          >
            {importView === null ? (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                no mesh imported
              </div>
            ) : (
              <CadScene
                projection={importView.mesh.projection}
                onSettled={() => {
                  document
                    .getElementById("io-root")
                    ?.setAttribute(
                      "data-cad-imported-volume",
                      importView.mesh.volume.toFixed(3),
                    );
                  setImportedFrames((frames) => frames + 1);
                }}
              />
            )}
          </div>
        </figure>
        <figure className="space-y-1">
          <figcaption className="text-muted-foreground text-xs">
            GLB → reference viewer (three GLTFLoader, loaded geometry)
          </figcaption>
          <div
            id="io-glb-viewport"
            className={`overflow-hidden border ${VIEWPORT_CLASS}`}
          >
            {glbView === null ? (
              <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                {glbPending ? "loading GLB…" : "no GLB loaded"}
              </div>
            ) : (
              <CadScene
                projection={glbView.projection}
                onSettled={() => {
                  document
                    .getElementById("io-root")
                    ?.setAttribute(
                      "data-cad-glb-volume",
                      glbView.volume.toFixed(3),
                    );
                  setGlbFrames((frames) => frames + 1);
                }}
              />
            )}
          </div>
        </figure>
      </div>
    </div>
  );
}
