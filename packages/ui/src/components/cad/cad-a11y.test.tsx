/**
 * Accessibility contract tests for the CAD surfaces (Phase 30). These are
 * the DOM-level guarantees the browser a11y workflows build on: the status
 * bar's live regions (the session writer's out-of-React writes must reach
 * assistive technology), the io dialogs' busy state, alert regions,
 * labeled file input, and trigger-accurate focus restoration, the command
 * menu's accessible dialog wiring, and the visible-focus contracts of the
 * raw (non-`Button`) interactive elements — every keyboard-reachable
 * control carries the workbench's documented focus-visible ring.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import type { ReactElement, RefObject } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CadCommandMenu } from "./cad-command-menu";
import {
  CadExportDialog,
  CadImportDialog,
  type CadExportFormatOption,
  type CadImportFormatOption,
} from "./cad-io-dialog";
import { CadSketchInspector } from "./cad-sketch-inspector";
import { CadStatusBar } from "./cad-status-bar";

afterEach(cleanup);

/**
 * cmdk observes the list's size with a ResizeObserver, which jsdom does
 * not implement; the no-op stub keeps the component's real code path
 * (the same discipline as cad-command-menu.test.tsx).
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = (): void => {};

const EXPORT_FORMATS: readonly CadExportFormatOption[] = [
  {
    id: "stl",
    label: "STL",
    description: "Binary triangle soup of the settled solid.",
  },
];

const IMPORT_FORMATS: readonly CadImportFormatOption[] = [
  {
    id: "stl",
    label: "STL",
    description: "Mesh import in the browser.",
    extensions: [".stl"],
  },
];

describe("CadStatusBar live regions", () => {
  it("marks the host status span as a polite live region", () => {
    render(
      <CadStatusBar surfaceIds={{ statusId: "a11y-status" }} toolId="select" />,
    );
    const status = document.getElementById("a11y-status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
  });

  it("marks the host error span as an assertive alert region", () => {
    render(
      <CadStatusBar surfaceIds={{ errorId: "a11y-error" }} toolId="select" />,
    );
    const errorRegion = screen.getByTestId("cad-status-bar-error");
    expect(errorRegion.getAttribute("role")).toBe("alert");
    expect(errorRegion.getAttribute("aria-live")).toBe("assertive");
    expect(document.getElementById("a11y-error")).not.toBeNull();
  });

  it("keeps the volume span a quiet labeled value (no live region)", () => {
    render(
      <CadStatusBar surfaceIds={{ volumeId: "a11y-volume" }} toolId="select" />,
    );
    const volume = document.getElementById("a11y-volume");
    expect(volume?.getAttribute("aria-live")).toBeNull();
  });
});

describe("CadExportDialog accessibility", () => {
  it("reports aria-busy only while a format export is pending", () => {
    const { rerender } = render(
      <CadExportDialog
        formats={EXPORT_FORMATS}
        onExport={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    expect(
      document
        .querySelector("[data-cad-export-dialog]")
        ?.getAttribute("aria-busy"),
    ).toBeNull();

    rerender(
      <CadExportDialog
        formats={EXPORT_FORMATS}
        onExport={() => {}}
        onOpenChange={() => {}}
        open={true}
        pendingFormatId="stl"
      />,
    );
    expect(
      document
        .querySelector("[data-cad-export-dialog]")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("renders the structured error in an alert region", () => {
    render(
      <CadExportDialog
        error="glb-export/no-objects: nothing to export"
        formats={EXPORT_FORMATS}
        onExport={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    const alert = document.querySelector(
      '[data-cad-export-error][role="alert"]',
    );
    expect(alert?.textContent).toContain("glb-export/no-objects");
  });
});

describe("CadImportDialog accessibility", () => {
  it("reports aria-busy while an import is pending", () => {
    render(
      <CadImportDialog
        formats={IMPORT_FORMATS}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={true}
        pending={true}
      />,
    );
    expect(
      document
        .querySelector("[data-cad-import-dialog]")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("labels the file input accessibly", () => {
    render(
      <CadImportDialog
        formats={IMPORT_FORMATS}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    const input = screen.getByTestId("cad-import-file");
    expect(input.getAttribute("aria-label")).toBe("Import mesh or model file");
  });

  it("renders the structured error in an alert region", () => {
    render(
      <CadImportDialog
        error="stl-import/short-header: not an STL file"
        formats={IMPORT_FORMATS}
        onImportFiles={() => {}}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    const alert = document.querySelector(
      '[data-cad-import-error][role="alert"]',
    );
    expect(alert?.textContent).toContain("stl-import/short-header");
  });

  it("hands focus to the finalFocus element when the dialog closes", async () => {
    // The ref lives OUTSIDE the harness so the assertion can check element
    // identity: closing must land on the exact trigger node the host passed,
    // which the primitives' body fallback can never satisfy.
    const triggerRef: RefObject<HTMLButtonElement | null> = { current: null };
    function Harness(): ReactElement {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={triggerRef} type="button">
            Import trigger
          </button>
          <CadImportDialog
            finalFocus={triggerRef}
            formats={IMPORT_FORMATS}
            onImportFiles={() => {}}
            onOpenChange={setOpen}
            open={open}
          />
        </>
      );
    }
    render(<Harness />);
    expect(document.querySelector("[data-cad-import-dialog]")).not.toBeNull();
    fireEvent.click(screen.getByText("Close"));
    expect(document.querySelector("[data-cad-import-dialog]")).toBeNull();
    // Close hands focus back to the opener through the finalFocus ref; the
    // primitives apply it in a microtask after the unmount commit, so the
    // flush precedes the read. Identity (not text): activeElement must BE
    // the trigger, not a body whose textContent merely contains its label.
    await act(async () => {});
    expect(document.activeElement).toBe(triggerRef.current);
  });
});

describe("CadCommandMenu accessibility", () => {
  it("wires the dialog title and description into the palette", () => {
    render(
      <CadCommandMenu
        commands={[
          {
            group: "Tools",
            id: "tool-select",
            label: "Select",
            run: () => {},
          },
        ]}
        onOpenChange={() => {}}
        open={true}
      />,
    );
    // The sr-only header gives the dialog its accessible name and
    // description (the primitives' title/description contract).
    expect(screen.getByText("Command menu")).not.toBeNull();
    expect(screen.getByText("Search the workbench commands.")).not.toBeNull();
    expect(screen.getByPlaceholderText("Type a command…")).not.toBeNull();
  });

  it("renders nothing while closed (no portal work while closed)", () => {
    render(
      <CadCommandMenu commands={[]} onOpenChange={() => {}} open={false} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("CadSketchInspector focus visibility", () => {
  it("carries the workbench focus-visible ring on constraint buttons", () => {
    render(
      <CadSketchInspector
        constraints={[
          {
            entityIds: ["e1", "e2"],
            id: "c1",
            kind: "distance",
            label: "distance 60 mm",
            status: "ok",
          },
        ]}
        diagnostics={[]}
        dimension={null}
        dof={0}
        onSelectConstraint={() => {}}
        selectedConstraintId={null}
        solveStatus="solved"
      />,
    );
    const button = document.querySelector('[data-sketch-constraint-id="c1"]');
    expect(button?.className).toContain("focus-visible:ring-1");
  });
});
