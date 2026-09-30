/**
 * The COMPLETE workbench page (Phase 28 phase-level deliverable): the
 * route example that mounts {@link CompleteCadWorkbench} — all eight plan
 * surfaces (toolbar, command menu, viewport, model tree, property panel,
 * parameter panel, history timeline, status bar) plus the import/export
 * dialogs — over the SAME workbench engine, session, and document the
 * Phase 15 composed page runs on.
 *
 * ## What this page adds: the IO adapter
 *
 * The composition is plumbing-free by design; this page wires the real
 * adapters behind it, exactly the /io fixture's honest paths:
 *
 * - **Export** of the settled document scene: STL and 3MF from the
 *   settled tessellation, GLB from the settled render projection (the
 *   exporters' documented input surfaces). Held bytes become download
 *   affordances and round-trip sources. STEP/BREP export is deliberately
 *   NOT offered here: it is OpenCascade-only and the plate rebuild path
 *   is the /io fixture's — the workbench exports the formats its scene
 *   can honestly produce (the dialog says what each format is).
 * - **Import** of all five supported formats: STL in the browser, 3MF via
 *   the app's own server route (the 18.4 importer is Node-targeted),
 *   STEP and BREP through the lazily-booted real OpenCascade worker, IGES
 *   on the main thread through the fallback engine. Every success adopts
 *   the imported projection as a PREVIEW — the viewport's truth-telling
 *   chip says "geometry only, not in the document" — and every failure
 *   surfaces the adapter's structured code verbatim.
 *
 * Every interaction routes through public surfaces: the document changes
 * through the engine's transaction actions, the mesh exchange through the
 * cad-io adapters and their documented channels. No second write path.
 *
 * The OCCT worker boots on the first STEP or BREP exchange and terminates
 * with the page.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
// Deep imports, deliberately: the cad-io index also re-exports the
// Node-targeted 3MF importer (`node:zlib`), and an index import would pull
// that module into the browser bundle (the /io fixture's documented rule).
import { exportGlb } from "@slopcad/cad-io/glb-export";
import { exportThreeMf } from "@slopcad/cad-io/three-mf-export";
import { exportStlBinary } from "@slopcad/cad-io/stl-export";
import { importObj } from "@slopcad/cad-io/obj-import";
import type { ImportedObjMesh } from "@slopcad/cad-io/obj-import";
import { importStl } from "@slopcad/cad-io/stl-import";
import type { ImportedStlMesh } from "@slopcad/cad-io/stl-import";
import type { ImportedThreeMfMesh } from "@slopcad/cad-io/three-mf-import";
// The TSX model surface: the pure, browser-safe document → TSX generator
// (cad-core records and string building only — verified no node APIs).
import { generateTsx } from "@slopcad/cad-jsx";
import { formatBoundsExtents } from "@slopcad/cad-core";
import { bootWorkerChannel, WorkerRequestFailure } from "@slopcad/cad-kernel";
import type { WorkerClient } from "@slopcad/cad-kernel";
import type {
  CadExportEntry,
  CadExportFormatOption,
  CadImportFormatOption,
  CadImportOutcome,
} from "@slopcad/ui/components/cad/cad-io-dialog";
import type { FixtureRenderState } from "../render-fixture/fixture-session";
import type { ThreeMfImportResponse } from "../io-fixture/io-protocol";
import type { ImportTsxResponse } from "../io-fixture/import-tsx-endpoint";
import type { FixtureSessionBackendId } from "../render-fixture/session-backend";
import type { CadImportPreview, CadWorkbenchIo } from "./complete-workbench";
import type { WorkbenchEngine } from "./workbench-engine";

import { parseNativeTextToSession } from "../cad-projects/native-document-bridge";
import { documentSceneTessellation } from "./document-scene";
import {
  buildImportedMeshState,
  type ImportedMeshState,
} from "../io-fixture/io-mesh";
import {
  buildImportedStepState,
  importStepBytesOverWorker,
  type ImportedStepState,
} from "../io-fixture/io-step";
import {
  buildImportedBrepState,
  importBrepBytesOverWorker,
  type ImportedBrepState,
} from "../io-fixture/io-brep";
import { importIgesBytes, type ImportedIgesState } from "../io-fixture/io-iges";
import { CompleteCadWorkbench } from "./complete-workbench";
import { WorkbenchStoreProvider } from "./workbench-engine";

/** The export title the 3MF exporter stamps (round-trips the import). */
const EXPORT_TITLE = "slopcad workbench model";

/** The exportable formats: what the settled workbench scene can produce. */
const EXPORT_FORMATS: readonly CadExportFormatOption[] = [
  {
    id: "stl",
    label: "STL",
    description: "Binary triangle soup of the settled solid.",
    meta: "mesh / binary",
  },
  {
    id: "3mf",
    label: "3MF",
    description: "XML mesh package; import parses on the app server.",
    meta: "mesh / zip+xml",
  },
  {
    id: "glb",
    label: "GLB",
    description: "The render projection as a glTF scene, one node per body.",
    meta: "scene / binary",
  },
  {
    id: "tsx",
    label: "TSX",
    description:
      "The document as a @slopcad/cad-jsx model (parameters, sketches, feature DAG); generated in the browser.",
    meta: "model / source",
  },
];

/** The importable formats, with the honest channel each one uses. */
const IMPORT_FORMATS: readonly CadImportFormatOption[] = [
  {
    id: "stl",
    label: "STL",
    description: "Mesh import fully in the browser.",
    extensions: [".stl"],
    meta: "mesh / browser",
  },
  {
    id: "3mf",
    label: "3MF",
    description: "Parsed by the app server (the importer is Node-targeted).",
    extensions: [".3mf"],
    meta: "mesh / server",
  },
  {
    id: "tsx",
    label: "TSX",
    description:
      "A @slopcad/cad-jsx model, compiled on the app server into the document.",
    extensions: [".tsx"],
    meta: "model / server",
  },
  {
    id: "obj",
    label: "OBJ",
    description: "Mesh import fully in the browser.",
    extensions: [".obj"],
    meta: "mesh / browser",
  },
  {
    id: "step",
    label: "STEP",
    description: "BREP solids through the OpenCascade worker (boots on use).",
    extensions: [".step", ".stp"],
    meta: "brep / worker",
  },
  {
    id: "brep",
    label: "BREP",
    description: "OCCT's native form through the same worker.",
    extensions: [".brep"],
    meta: "brep / worker",
  },
  {
    id: "iges",
    label: "IGES",
    description: "Mesh bodies on the main thread (fallback engine).",
    extensions: [".igs", ".iges"],
    meta: "mesh / main thread",
  },
];

/** One held export: the exact bytes plus the triangle count they encode. */
interface HeldExport {
  readonly bytes: Uint8Array;
  readonly triangles: number;
  readonly downloadUrl: string;
  /** The honest detail line, when the format's readout is not triangles. */
  readonly detail?: string;
}

/** The union of every adapter's successful-import state. */
type ImportedState =
  ImportedMeshState | ImportedStepState | ImportedBrepState | ImportedIgesState;

/** The lazily-booted OCCT worker session behind STEP and BREP imports. */
interface OcctWorkerSession {
  readonly dispose: () => void;
  readonly client: WorkerClient;
}

export function CompleteWorkbenchPage({
  backend,
  rootId = "workbench-complete-root",
}: {
  /**
   * The worker backend the workbench boots (see
   * {@link CompleteCadWorkbenchProps.backend}); the default `"manifold"` is
   * the boot state the established baselines pin, and `"occt"` serves the
   * sweep-capable route (Phase 38).
   */
  readonly backend?: FixtureSessionBackendId;
  /** The root element id (the machine surface's anchor; per route). */
  readonly rootId?: string;
}): ReactElement {
  return (
    <WorkbenchStoreProvider>
      <CompleteWorkbenchBody backend={backend} rootId={rootId} />
    </WorkbenchStoreProvider>
  );
}

function CompleteWorkbenchBody({
  backend,
  rootId,
}: {
  readonly backend?: FixtureSessionBackendId;
  readonly rootId?: string;
}): ReactElement {
  // Held exports (one slot per exportable format), the import side's
  // outcome/preview state, and the shared error surface. The workbench's
  // export formats (STL/3MF/GLB) all produce their bytes synchronously, so
  // no export-pending state exists — the dialog's pending slot stays null.
  const [held, setHeld] = useState<ReadonlyMap<string, HeldExport>>(
    () => new Map(),
  );
  const [exportError, setExportError] = useState("");
  const [importPending, setImportPending] = useState(false);
  const [importError, setImportError] = useState("");
  const [importOutcome, setImportOutcome] = useState<CadImportOutcome | null>(
    null,
  );
  const [preview, setPreview] = useState<CadImportPreview | null>(null);
  const occtWorkerRef = useRef<OcctWorkerSession | null>(null);
  const objectUrlsRef = useRef<readonly string[]>([]);

  // Every created object URL dies with the page: held exports are page
  // state, their blob URLs are not.
  useEffect(() => {
    const urls = objectUrlsRef;
    return () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    return () => {
      // The lazily-booted OCCT worker dies with the page.
      occtWorkerRef.current?.dispose();
      occtWorkerRef.current = null;
    };
  }, []);

  /**
   * Boots the OCCT worker on the FIRST STEP or BREP exchange — the ~22 MB
   * kernel is not paid by pages that never use it — and reuses it after.
   * The worker entry buffers requests that race its WASM boot, so no
   * readiness handshake is needed. The crash-settling boot (Phase 35
   * hardening) settles in-flight requests if the thread ever dies; a
   * crashed channel is forgotten so the next exchange boots a fresh
   * worker, and the failure surfaces through the import error state.
   */
  const bootOcctWorker = useCallback((): WorkerClient => {
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
  }, []);

  const adoptPreview = useCallback(
    (source: string, detailJson: string, state: ImportedState): void => {
      setImportError("");
      setImportOutcome({
        detail: detailJson,
        extents: formatBoundsExtents(state.bounds),
        formatId: source,
        triangles: state.triangles,
        volume: `${state.volume.toFixed(3)} mm³`,
      });
      setPreview({
        detailJson,
        projection: state.projection,
        source,
        triangles: state.triangles,
        volumeText: state.volume.toFixed(3),
      });
    },
    [],
  );

  const importStlBytes = useCallback(
    (bytes: Uint8Array): void => {
      const result = importStl(bytes);
      if (!result.ok) {
        setImportError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      const mesh: ImportedStlMesh = result.value;
      adoptPreview(
        "stl",
        JSON.stringify({ flavor: mesh.flavor }),
        buildImportedMeshState(mesh.tessellation),
      );
    },
    [adoptPreview],
  );

  const import3MfBytes = useCallback(
    async (bytes: Uint8Array): Promise<void> => {
      setImportPending(true);
      try {
        const response = await fetch("/api/io/import-3mf", {
          body: new Uint8Array(bytes),
          method: "POST",
        });
        const payload = (await response.json()) as ThreeMfImportResponse;
        if (!payload.ok) {
          setImportError(`${payload.code}: ${payload.message}`);
          return;
        }
        const mesh: ImportedThreeMfMesh = {
          metadata: payload.metadata,
          tessellation: {
            indices: payload.indices,
            positions: payload.positions,
          },
          units: payload.units,
        };
        adoptPreview(
          "3mf",
          JSON.stringify({ units: mesh.units, title: mesh.metadata.title }),
          buildImportedMeshState(mesh.tessellation),
        );
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      } finally {
        setImportPending(false);
      }
    },
    [adoptPreview],
  );

  /** OBJ imports in the browser (the Phase 56 browser-safe adapter). */
  const importObjBytes = useCallback(
    (bytes: Uint8Array): void => {
      const result = importObj(bytes);
      if (!result.ok) {
        setImportError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      const mesh: ImportedObjMesh = result.value;
      adoptPreview(
        "obj",
        JSON.stringify({
          declined: mesh.declined.length,
          name: mesh.name,
          units: mesh.units,
        }),
        buildImportedMeshState(mesh.tessellation),
      );
    },
    [adoptPreview],
  );

  /** The worker channel's error text: protocol code + kernel cause. */
  const workerErrorText = (error: unknown): string => {
    if (error instanceof WorkerRequestFailure) {
      const kernelCode = error.error.data?.kernelCode;
      return kernelCode === undefined
        ? `${error.error.code}: ${error.error.message}`
        : `${error.error.code} [${String(kernelCode)}]: ${error.error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
  };

  const importStepBytes = useCallback(
    async (bytes: Uint8Array): Promise<void> => {
      setImportPending(true);
      try {
        const flow = await importStepBytesOverWorker(bootOcctWorker(), bytes);
        adoptPreview(
          "step",
          JSON.stringify({
            origin: "imported-step",
            solids: flow.refs.length,
            unit: "mm",
          }),
          buildImportedStepState(flow.soups),
        );
      } catch (error) {
        setImportError(workerErrorText(error));
      } finally {
        setImportPending(false);
      }
    },
    [adoptPreview, bootOcctWorker],
  );

  const importBrepBytes = useCallback(
    async (bytes: Uint8Array): Promise<void> => {
      setImportPending(true);
      try {
        const flow = await importBrepBytesOverWorker(bootOcctWorker(), bytes);
        adoptPreview(
          "brep",
          JSON.stringify({
            origin: "imported-brep",
            solids: flow.refs.length,
            unit: "mm",
          }),
          buildImportedBrepState(flow.soups),
        );
      } catch (error) {
        setImportError(workerErrorText(error));
      } finally {
        setImportPending(false);
      }
    },
    [adoptPreview, bootOcctWorker],
  );

  const importIgesFileBytes = useCallback(
    async (bytes: Uint8Array): Promise<void> => {
      setImportPending(true);
      try {
        const flow = await importIgesBytes(bytes);
        adoptPreview("iges", JSON.stringify(flow.detail), flow.state);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      } finally {
        setImportPending(false);
      }
    },
    [adoptPreview],
  );

  /**
   * Imports one TSX model source: the app server's canonical loader
   * compiles it to the native document text, which then enters the
   * session through the SAME apply path an opened document takes (the
   * persistence bridge's parse → `replaceSession`) — no parallel write
   * path, and no mesh preview (the document itself IS the result).
   */
  const importTsxSource = useCallback(
    async (engine: WorkbenchEngine, source: string): Promise<void> => {
      setImportPending(true);
      try {
        const response = await fetch("/api/io/import-tsx", {
          body: source,
          method: "POST",
        });
        const payload = (await response.json()) as ImportTsxResponse;
        if (!payload.ok) {
          setImportError(`${payload.code}: ${payload.message}`);
          return;
        }
        const parsed = parseNativeTextToSession(payload.native);
        if (!parsed.ok) {
          setImportError(`tsx-import/native-parse: ${parsed.error}`);
          return;
        }
        engine.store.replaceSession(parsed.session);
        engine.setActiveScene(parsed.scene);
        engine.setRollback(parsed.rollback ?? null);
        setImportError("");
        setImportOutcome({
          detail: `document applied: ${String(parsed.document.features.length)} features, ${String(parsed.document.bodies.length)} bodies`,
          extents: "see model tree",
          formatId: "tsx",
          triangles: 0,
          volume: "n/a (document import)",
        });
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      } finally {
        setImportPending(false);
      }
    },
    [],
  );

  const importTsxFile = useCallback(
    async (engine: WorkbenchEngine, file: File): Promise<void> => {
      try {
        const text = await file.text();
        await importTsxSource(engine, text);
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      }
    },
    [importTsxSource],
  );

  /** Routes one imported file by its extension (the /io fixture's rule). */
  const importFiles = useCallback(
    (files: readonly File[], engine: WorkbenchEngine): void => {
      const file = files[0];
      if (file === undefined) return;
      const name = file.name.toLowerCase();
      const isStep = name.endsWith(".step") || name.endsWith(".stp");
      const isBrep = name.endsWith(".brep");
      const isIges = name.endsWith(".igs") || name.endsWith(".iges");
      const isTsx = name.endsWith(".tsx");
      // DXF/SVG are SKETCH exchange: they import into the ACTIVE sketch's
      // session (the sketch workspace's own import control), never into the
      // mesh pipeline. From this model-mode dialog there is no active
      // sketch — the structured decline says so instead of guessing.
      const isSketchExchange = name.endsWith(".dxf") || name.endsWith(".svg");
      if (
        !name.endsWith(".stl") &&
        !name.endsWith(".3mf") &&
        !name.endsWith(".obj") &&
        !isStep &&
        !isBrep &&
        !isIges &&
        !isTsx &&
        !isSketchExchange
      ) {
        setImportError(`unsupported file type: ${file.name}`);
        return;
      }
      if (isSketchExchange) {
        setImportError(
          "sketch-import/no-active-sketch: DXF and SVG import into the active sketch — enter sketch mode and use the sketch workspace's import control.",
        );
        return;
      }
      if (isTsx) {
        void importTsxFile(engine, file);
        return;
      }
      file
        .arrayBuffer()
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          if (name.endsWith(".stl")) {
            importStlBytes(bytes);
            return undefined;
          }
          if (name.endsWith(".obj")) {
            importObjBytes(bytes);
            return undefined;
          }
          if (isStep) return importStepBytes(bytes);
          if (isBrep) return importBrepBytes(bytes);
          if (isIges) return importIgesFileBytes(bytes);
          return import3MfBytes(bytes);
        })
        .catch((error: unknown) => {
          setImportError(
            error instanceof Error ? error.message : String(error),
          );
        });
    },
    [
      import3MfBytes,
      importBrepBytes,
      importIgesFileBytes,
      importObjBytes,
      importStlBytes,
      importStepBytes,
      importTsxFile,
    ],
  );

  /**
   * The IO adapter builder: the composition calls it with its engine, so
   * the export path reads the SETTLED document scene through the public
   * engine surface and nothing reaches into internals.
   */
  const buildIo = useCallback(
    (engine: WorkbenchEngine): CadWorkbenchIo => {
      const exportEntries: CadExportEntry[] = [];
      for (const format of EXPORT_FORMATS) {
        const heldExport = held.get(format.id);
        if (heldExport === undefined) continue;
        exportEntries.push({
          byteCount: heldExport.bytes.length,
          detail:
            heldExport.detail ?? `${String(heldExport.triangles)} triangles`,
          downloadName: `model.${format.id}`,
          downloadUrl: heldExport.downloadUrl,
          formatId: format.id,
        });
      }
      const heldImports = [...held.entries()]
        .filter(
          ([formatId]) =>
            formatId === "stl" || formatId === "3mf" || formatId === "tsx",
        )
        .map(([formatId, heldExport]) => ({
          byteCount: heldExport.bytes.length,
          formatId,
          onImport: () => {
            if (formatId === "stl") {
              importStlBytes(heldExport.bytes);
              return;
            }
            if (formatId === "tsx") {
              // The held TSX round-trips through the same server compile
              // as a picked file — the export's own proof it recompiles.
              void importTsxSource(
                engine,
                new TextDecoder().decode(heldExport.bytes),
              );
              return;
            }
            import3MfBytes(heldExport.bytes).catch((error: unknown) => {
              setImportError(
                error instanceof Error ? error.message : String(error),
              );
            });
          },
        }));
      return {
        exportEntries,
        exportError,
        exportFormats: EXPORT_FORMATS,
        exportPendingFormatId: null,
        importError,
        importFormats: IMPORT_FORMATS,
        importHeld: heldImports,
        importOutcome,
        importPending,
        onClearPreview: () => {
          setPreview(null);
          setImportOutcome(null);
        },
        onExport: (formatId: string) => {
          if (formatId === "tsx") {
            // TSX exports the DOCUMENT as a @slopcad/cad-jsx model — a
            // pure client-side generation (the generator is browser-safe:
            // cad-core records and string building, no server round-trip).
            const document = engine.documentApi.document;
            const generated = generateTsx(document, {
              documentId: document.id,
            });
            if (!generated.ok) {
              setExportError(
                `${generated.error.code}: ${generated.error.message}`,
              );
              return;
            }
            const bytes = new TextEncoder().encode(generated.value.source);
            const url = URL.createObjectURL(new Blob([bytes]));
            objectUrlsRef.current = [...objectUrlsRef.current, url];
            setHeld((current) => {
              const next = new Map(current);
              const previous = next.get("tsx");
              if (previous !== undefined)
                URL.revokeObjectURL(previous.downloadUrl);
              next.set("tsx", {
                bytes,
                detail:
                  generated.value.declines.length > 0
                    ? `${String(generated.value.declines.length)} declined records`
                    : "full document round-trip",
                downloadUrl: url,
                triangles: 0,
              });
              return next;
            });
            setExportError("");
            return;
          }
          const applied: FixtureRenderState | null =
            engine.applied?.state ?? null;
          if (applied === null) return;
          if (formatId !== "stl" && formatId !== "3mf" && formatId !== "glb") {
            return;
          }
          // The document scene carries per-body soups: the mesh exporters
          // consume ONE indexed soup, so the rendered bodies merge in
          // document order (the projection itself feeds GLB either way).
          const soup =
            "tessellation" in applied.measurement
              ? applied.measurement.tessellation
              : documentSceneTessellation(applied.measurement.bodies);
          const result =
            formatId === "stl"
              ? exportStlBinary(soup)
              : formatId === "3mf"
                ? exportThreeMf(soup, {
                    title: EXPORT_TITLE,
                  })
                : // GLB exports the RENDER PROJECTION — the renderer-neutral
                  // render data (kernel normals included), the exporter's
                  // documented input surface.
                  exportGlb(applied.projection);
          if (!result.ok) {
            setExportError(`${result.error.code}: ${result.error.message}`);
            return;
          }
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(result.value)]),
          );
          objectUrlsRef.current = [...objectUrlsRef.current, url];
          setHeld((current) => {
            const next = new Map(current);
            const previous = next.get(formatId);
            if (previous !== undefined)
              URL.revokeObjectURL(previous.downloadUrl);
            next.set(formatId, {
              bytes: result.value,
              downloadUrl: url,
              triangles: applied.measurement.triangles,
            });
            return next;
          });
          setExportError("");
        },
        onImportFiles: (files: readonly File[]) => {
          importFiles(files, engine);
        },
        preview,
      };
    },
    [
      exportError,
      held,
      import3MfBytes,
      importFiles,
      importError,
      importOutcome,
      importPending,
      importStlBytes,
      importTsxSource,
      preview,
    ],
  );

  // GLB load (the reference viewer path) is deliberately NOT wired here:
  // the workbench's import preview covers the imported-geometry story, and
  // the /io fixture remains the GLTFLoader reference surface.

  return (
    <CompleteCadWorkbench backend={backend} io={buildIo} rootId={rootId} />
  );
}
