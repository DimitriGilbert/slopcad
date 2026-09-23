/**
 * SketchMode's Phase 56 sketch-exchange import (component level): a DXF or
 * SVG file enters the ACTIVE sketch as one committed transaction, a second
 * import of the same file re-ids instead of colliding, an unsupported file
 * declines with the structured code, and an adapter parse failure carries
 * its stable code. Machine surfaces (data-sketch-import,
 * data-sketch-entities) carry every assertion, exactly like the browser
 * battery.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SketchMode } from "./SketchMode";

afterEach(cleanup);

const SKETCH_DXF =
  "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" +
  "0\nLINE\n5\n2AF\n8\noutline\n10\n0\n20\n0\n11\n30\n21\n40\n" +
  "0\nCIRCLE\n5\n2B0\n8\noutline\n10\n15\n20\n20\n40\n5\n" +
  "0\nENDSEC\n0\nEOF\n";

const SKETCH_SVG =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ' +
  'viewBox="0 0 100 100">\n<line x1="0" y1="0" x2="10" y2="20"/>\n</svg>\n';

function mountSketchMode(): void {
  render(
    <SketchMode importSketchFiles onExtrude={() => {}} onExit={() => {}} />,
  );
}

function root(): Element {
  const element = document.getElementById("sketch-root");
  if (element === null) throw new Error("the sketch root must be mounted");
  return element;
}

function importInput(): HTMLInputElement {
  const input = document.querySelector('[data-testid="sketch-import-file"]');
  if (input === null) throw new Error("the sketch import input must mount");
  return input as HTMLInputElement;
}

/** Uploads one virtual file through the sketch import input. */
function uploadFile(name: string, text: string, type = "text/plain"): void {
  const file = new File([text], name, { type });
  fireEvent.change(importInput(), { target: { files: [file] } });
}

function importOutcome(): Record<string, unknown> {
  const raw = root().getAttribute("data-sketch-import");
  if (raw === null || raw === "") {
    throw new Error("the sketch import outcome must be surfaced");
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function entities(): readonly Record<string, unknown>[] {
  return JSON.parse(
    root().getAttribute("data-sketch-entities") ?? "[]",
  ) as readonly Record<string, unknown>[];
}

describe("SketchMode Phase 56 — sketch exchange import", () => {
  it("imports a DXF into the session as one committed transaction", async () => {
    mountSketchMode();
    expect(entities()).toHaveLength(0);
    uploadFile("outline.dxf", SKETCH_DXF);
    await waitFor(() => {
      expect(importOutcome()["status"]).toBe("imported");
    });
    expect(importOutcome()["source"]).toBe("dxf");
    expect(importOutcome()["imported"]).toBe(2);
    expect(importOutcome()["declined"]).toBe(0);
    expect(importOutcome()["message"]).toContain("outline.dxf: imported 2");
    // The entities are IN the session (line + circle), undoable as one step.
    const imported = entities();
    expect(imported).toHaveLength(2);
    expect(imported.map((entity) => entity.kind)).toEqual(["line", "circle"]);
    expect(root().getAttribute("data-sketch-history")).toContain('"depth":1');
  });

  it("imports an SVG file through the same entry", async () => {
    mountSketchMode();
    uploadFile("profile.svg", SKETCH_SVG, "image/svg+xml");
    await waitFor(() => {
      expect(importOutcome()["status"]).toBe("imported");
    });
    expect(importOutcome()["source"]).toBe("svg");
    expect(entities()).toHaveLength(1);
    expect(entities()[0]?.["kind"]).toBe("line");
  });

  it("re-ids a second import of the same file instead of colliding", async () => {
    mountSketchMode();
    uploadFile("outline.dxf", SKETCH_DXF);
    await waitFor(() => {
      expect(importOutcome()["status"]).toBe("imported");
    });
    uploadFile("outline.dxf", SKETCH_DXF);
    await waitFor(() => {
      expect(entities()).toHaveLength(4);
    });
    expect(importOutcome()["imported"]).toBe(2);
    // The first import's ids are untouched; the second import re-minted.
    const ids = entities().map((entity) => entity["id"]);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toContain("skent_2af");
    expect(ids).toContain("skent_2af-i1");
  });

  it("declines an unsupported file with the structured code", async () => {
    mountSketchMode();
    uploadFile("notes.txt", "not geometry");
    await waitFor(() => {
      expect(importOutcome()["status"]).toBe("declined");
    });
    expect(importOutcome()["code"]).toBe("sketch-import/unsupported-file");
    expect(entities()).toHaveLength(0);
  });

  it("surfaces an adapter parse failure with its stable code", async () => {
    mountSketchMode();
    // A DXF whose entities section carries a non-finite coordinate is an
    // in-subset defect: the whole file rejects with the adapter's code.
    uploadFile(
      "broken.dxf",
      "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" +
        "0\nLINE\n5\n2AF\n10\n0\n20\n0\n11\nNaN\n21\n40\n" +
        "0\nENDSEC\n0\nEOF\n",
    );
    await waitFor(() => {
      expect(importOutcome()["status"]).toBe("failed");
    });
    expect(importOutcome()["source"]).toBe("dxf");
    expect(String(importOutcome()["code"])).toContain("dxf-import/");
    expect(entities()).toHaveLength(0);
  });
});
