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
 * ## Machine-readable surface (`#io-root`)
 *
 * The source session's settle attributes (written by the shared fixture
 * session: `data-in-flight`, `data-applied-revision`,
 * `data-current-revision`, `data-volume`, `data-error`, and the source
 * viewport's `data-cad-rendered-volume`), the export surface
 * (`data-export-stl-bytes` / `data-export-3mf-bytes` byte counts plus
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
 * every fixture publishes).
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
// Deep imports, deliberately: the cad-io index also re-exports the
// Node-targeted 3MF importer (`node:zlib`), and an index import would pull
// that module into the browser bundle. The page uses the browser-safe
// adapters directly; 3MF import goes through the app server instead.
import { exportThreeMf } from "@slopcad/cad-io/three-mf-export";
import type { ImportedThreeMfMesh } from "@slopcad/cad-io/three-mf-import";
import { exportStlBinary } from "@slopcad/cad-io/stl-export";
import { importStl } from "@slopcad/cad-io/stl-import";
import type { ImportedStlMesh } from "@slopcad/cad-io/stl-import";
import { CadScene } from "@slopcad/cad-r3f";
import { Button } from "@slopcad/ui/components/button";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";
import type { ThreeMfImportResponse } from "./io-protocol";

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

/** One held export: the exact bytes plus the triangle count they encode. */
interface HeldExport {
  readonly bytes: Uint8Array;
  readonly triangles: number;
  /** Object URL serving exactly `bytes` (the human download affordance). */
  readonly downloadUrl: string;
}

/** What the import surface shows once a mesh is in. */
interface ImportView {
  /** Which format the mesh arrived through — the honest provenance. */
  readonly source: "stl" | "3mf";
  /** Flavor (STL) or declared unit + title (3MF), as stable JSON. */
  readonly detailJson: string;
  /** The validated, renderable imported mesh. */
  readonly mesh: ImportedMeshState;
}

/** The 3MF document title the exporter stamps (round-trips the import). */
const EXPORT_TITLE = "slopcad plate";

/** The imported-mesh viewport's fixed box (determinism contract, as on
 * every fixture: the camera fit is pure, the size is constant per page). */
const VIEWPORT_CLASS = "h-[400px] w-[600px]";

/** Formats bounds as the fixtures' extents form `30.000 × 20.000 × 10.000`. */
function extentsText(bounds: ImportedMeshState["bounds"]): string {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ]
    .map((extent) => extent.toFixed(3))
    .join(" × ");
}

export function MeshIoPage(): ReactElement {
  const [applied, setApplied] = useState<PlateRenderState | null>(null);
  const [heldStl, setHeldStl] = useState<HeldExport | null>(null);
  const [held3Mf, setHeld3Mf] = useState<HeldExport | null>(null);
  const [importView, setImportView] = useState<ImportView | null>(null);
  const [importError, setImportError] = useState("");
  const [importPending, setImportPending] = useState(false);
  const [importedFrames, setImportedFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

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
    };
  }, []);

  /** Exports the settled source soup; returns null when it cannot. */
  const exportHeld = (format: "stl" | "3mf"): HeldExport | null => {
    if (applied === null) return null;
    const tessellation = applied.measurement.tessellation;
    const triangles = tessellation.indices.length / 3;
    const result =
      format === "stl"
        ? exportStlBinary(tessellation)
        : exportThreeMf(tessellation, { title: EXPORT_TITLE });
    if (!result.ok) {
      setImportError(`${result.error.code}: ${result.error.message}`);
      return null;
    }
    return {
      bytes: result.value,
      triangles,
      downloadUrl: URL.createObjectURL(new Blob([new Uint8Array(result.value)])),
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

  /** The one place an imported soup becomes the rendered import view. */
  const adoptMesh = (
    source: ImportView["source"],
    detailJson: string,
    mesh: ImportedMeshState,
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
    adoptMesh("stl", JSON.stringify({ flavor: mesh.flavor }), buildImportedMeshState(mesh.tessellation));
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
        tessellation: { positions: payload.positions, indices: payload.indices },
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

  const importFile = (file: File): void => {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".stl") && !name.endsWith(".3mf")) {
      setImportError(`unsupported file type: ${file.name}`);
      return;
    }
    file
      .arrayBuffer()
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (name.endsWith(".stl")) {
          importStlBytes(bytes);
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
      data-export-stl-bytes={heldStl === null ? "" : String(heldStl.bytes.length)}
      data-export-stl-triangles={heldStl === null ? "" : String(heldStl.triangles)}
      data-export-3mf-bytes={held3Mf === null ? "" : String(held3Mf.bytes.length)}
      data-export-3mf-triangles={held3Mf === null ? "" : String(held3Mf.triangles)}
      data-import-source={importView === null ? "" : importView.source}
      data-import-triangles={importView === null ? "" : String(importView.mesh.triangles)}
      data-import-volume={importView === null ? "" : importView.mesh.volume.toFixed(3)}
      data-import-volume-exact={importView === null ? "" : String(importView.mesh.volume)}
      data-source-mesh-volume={applied === null ? "" : String(meshSignedVolume(applied.measurement.tessellation))}
      data-import-extents={importView === null ? "" : extentsText(importView.mesh.bounds)}
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
          Export the settled source solid to STL and 3MF, import the bytes
          back, render the imported mesh. STL import runs in the browser; 3MF
          import parses on the app server (the 18.4 importer is
          Node-targeted) and the mesh renders locally. An imported mesh is a
          mesh body — triangle soup, no parametric history.
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
              accept=".stl,.3mf"
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
          {"\u00A0"}mm³, triangles ={" "}
          <span id="io-source-triangles">…</span>
        </li>
        <li data-testid="io-import-readout">
          {importView === null ? (
            <span className="text-muted-foreground">no mesh imported</span>
          ) : (
            <>
              imported = <span id="io-import-source">{importView.source}</span>
              , triangles ={" "}
              <span id="io-import-triangles">{String(importView.mesh.triangles)}</span>
              , volume ={" "}
              <span id="io-import-volume">{importView.mesh.volume.toFixed(3)}</span>
              {"\u00A0"}mm³, extents ={" "}
              <span id="io-import-extents">{extentsText(importView.mesh.bounds)}</span>
              {"\u00A0"}mm,{" "}
              <span id="io-import-detail">{importView.detailJson}</span>
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
      </div>
    </div>
  );
}
