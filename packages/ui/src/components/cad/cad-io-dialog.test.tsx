/**
 * Component tests for the CAD import/export dialogs (Phase 28). The
 * dialogs are plumbing-free shells over host descriptors, so the tests
 * exercise exactly the components' own decisions: the per-format rows with
 * their held entries and download affordances, the pending and disabled
 * disciplines, the file handoff (and the input reset), the outcome and
 * error readouts, the controlled open-state null render, and the derived
 * accept token.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CadExportDialog,
  CadImportDialog,
  type CadExportEntry,
  type CadExportFormatOption,
  type CadImportFormatOption,
} from "./cad-io-dialog";

const EXPORT_FORMATS: readonly CadExportFormatOption[] = [
  {
    id: "stl",
    label: "STL",
    description: "Binary triangle soup of the settled solid.",
  },
  {
    id: "step",
    label: "STEP",
    description: "The kernel's BREP form.",
    disabled: true,
  },
];

const EXPORT_ENTRY: CadExportEntry = {
  formatId: "stl",
  byteCount: 840,
  detail: "84 triangles",
  downloadUrl: "blob:stl",
  downloadName: "model.stl",
};

const IMPORT_FORMATS: readonly CadImportFormatOption[] = [
  {
    id: "stl",
    label: "STL",
    description: "Mesh import in the browser.",
    extensions: [".stl"],
  },
  {
    id: "step",
    label: "STEP",
    description: "BREP solids through the OCCT worker.",
    extensions: [".step", ".stp"],
  },
];

afterEach(cleanup);

describe("CadExportDialog", () => {
  it("renders nothing while closed", () => {
    render(
      <CadExportDialog
        entries={[]}
        formats={EXPORT_FORMATS}
        onExport={() => {}}
        onOpenChange={() => {}}
        open={false}
      />,
    );
    expect(document.querySelector("[data-cad-export-dialog]")).toBeNull();
  });

  it("renders every format row and starts an export through the callback", () => {
    const onExport = vi.fn();
    render(
      <CadExportDialog
        entries={[]}
        formats={EXPORT_FORMATS}
        onExport={onExport}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    fireEvent.click(screen.getByTestId("cad-export-run-stl"));
    expect(onExport).toHaveBeenCalledWith("stl");
    // The disabled format renders but cannot start.
    const stepButton = screen.getByTestId("cad-export-run-step");
    expect(stepButton.getAttribute("disabled")).not.toBeNull();
  });

  it("renders the held entry's byte count, detail, and download link", () => {
    render(
      <CadExportDialog
        entries={[EXPORT_ENTRY]}
        formats={EXPORT_FORMATS}
        onExport={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    const entry = document.querySelector('[data-cad-export-entry="stl"]');
    expect(entry?.textContent).toContain("840 B");
    expect(entry?.textContent).toContain("84 triangles");
    const link = screen.getByTestId("cad-export-download-stl");
    expect(link.getAttribute("href")).toBe("blob:stl");
    expect(link.getAttribute("download")).toBe("model.stl");
  });

  it("shows the pending token and the structured error", () => {
    render(
      <CadExportDialog
        entries={[]}
        error="glb-export/no-objects: nothing to export"
        formats={EXPORT_FORMATS}
        onExport={() => {}}
        onOpenChange={() => {}}
        open={true}
        pendingFormatId="stl"
      />,
    );
    const stlButton = screen.getByTestId("cad-export-run-stl");
    expect(stlButton.textContent).toContain("exporting…");
    expect(stlButton.getAttribute("disabled")).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(
      "glb-export/no-objects: nothing to export",
    );
  });
});

describe("CadImportDialog", () => {
  it("renders nothing while closed and derives the accept token from the formats", () => {
    const { rerender } = render(
      <CadImportDialog
        formats={IMPORT_FORMATS}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={false}
      />,
    );
    expect(document.querySelector("[data-cad-import-dialog]")).toBeNull();
    rerender(
      <CadImportDialog
        formats={IMPORT_FORMATS}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    const input = screen.getByTestId("cad-import-file");
    expect(input.getAttribute("accept")).toBe(".stl,.step,.stp");
  });

  it("hands selected files to the host and resets the input", () => {
    const onImportFiles = vi.fn();
    render(
      <CadImportDialog
        formats={IMPORT_FORMATS}
        onImportFiles={onImportFiles}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    const input = screen.getByTestId<HTMLInputElement>("cad-import-file");
    const file = new File(["bytes"], "part.stl");
    fireEvent.change(input, { target: { files: [file] } });
    expect(onImportFiles).toHaveBeenCalledWith([file]);
    expect(input.value).toBe("");
  });

  it("renders held round-trip entries and runs them through the callback", () => {
    const onImportHeld = vi.fn();
    render(
      <CadImportDialog
        formats={IMPORT_FORMATS}
        held={[
          {
            formatId: "stl",
            byteCount: 840,
            onImport: onImportHeld,
          },
        ]}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    fireEvent.click(screen.getByTestId("cad-import-held-stl"));
    expect(onImportHeld).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cad-import-held-stl").textContent).toContain(
      "840 B",
    );
  });

  it("renders the latest outcome readout and the structured error", () => {
    render(
      <CadImportDialog
        error="stl-import/malformed: truncated triangle"
        formats={IMPORT_FORMATS}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={true}
        outcome={{
          detail: '{"flavor":"binary"}',
          formatId: "stl",
          triangles: 84,
          volume: "1200.000 mm³",
          extents: "30.000 × 20.000 × 4.000 mm",
        }}
        pending={true}
      />,
    );
    const outcome = document.querySelector('[data-cad-import-outcome="stl"]');
    expect(outcome?.textContent).toContain("triangles = 84");
    expect(screen.getByRole("alert").textContent).toBe(
      "stl-import/malformed: truncated triangle",
    );
    // Pending disables the file input.
    const input = screen.getByTestId("cad-import-file");
    expect(input.getAttribute("disabled")).not.toBeNull();
  });
});
