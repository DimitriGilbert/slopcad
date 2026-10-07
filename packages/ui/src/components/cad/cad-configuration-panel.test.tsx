/**
 * Component tests for `CadConfigurationPanel`'s CSV import path (the
 * read-failure contract): a chosen file's text reaches `onImportCsv`, a
 * FAILED read reaches `onImportError` with the error's own message instead
 * of dying as an unhandled rejection, and with no error surface mounted the
 * failure stays caught (the input's fire-and-forget promise never rejects).
 * The notice region remains the host's, rendered verbatim.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CadConfigurationPanel,
  type CadConfigurationPanelProps,
} from "./cad-configuration-panel";

afterEach(cleanup);

const IMPORT_INPUT_SELECTOR = '[data-testid="cad-configuration-csv-input"]';

/** A real CSV File whose read rejects with `error` (own `text` override). */
function unreadableFile(error: Error): File {
  const file = new File(["name,expression"], "parameters.csv", {
    type: "text/csv",
  });
  Object.defineProperty(file, "text", { value: () => Promise.reject(error) });
  return file;
}

function readableFile(text: string): File {
  return new File([text], "parameters.csv", { type: "text/csv" });
}

function renderPanel(props: Partial<CadConfigurationPanelProps> = {}): void {
  render(
    <CadConfigurationPanel
      configurations={[]}
      activeConfigurationId={null}
      {...props}
    />,
  );
}

/** Chooses `file` through the panel's file input (jsdom: no real picker). */
function chooseFile(file: File): void {
  const input = document.querySelector<HTMLInputElement>(IMPORT_INPUT_SELECTOR);
  if (input === null) throw new Error("the csv input must mount");
  fireEvent.change(input, { target: { files: [file] } });
}

describe("CadConfigurationPanel CSV import", () => {
  it("hands a readable file's text to onImportCsv", async () => {
    const onImportCsv = vi.fn();
    renderPanel({ onImportCsv });
    chooseFile(readableFile("width,50\n"));
    await act(async () => {});
    expect(onImportCsv).toHaveBeenCalledTimes(1);
    expect(onImportCsv).toHaveBeenCalledWith("width,50\n");
  });

  it("reports a failed read through onImportError, verbatim, with no import", async () => {
    const onImportCsv = vi.fn();
    const onImportError = vi.fn();
    renderPanel({ onImportCsv, onImportError });
    chooseFile(unreadableFile(new Error("the file could not be read")));
    // Settle the caught rejection inside the test: an unhandled rejection
    // would fail the run here, not after it.
    await act(async () => {});
    expect(onImportError).toHaveBeenCalledTimes(1);
    expect(onImportError).toHaveBeenCalledWith("the file could not be read");
    expect(onImportCsv).not.toHaveBeenCalled();
  });

  it("surfaces a DOMException read failure's own text", async () => {
    // The platform's file.text() rejects with `unknown` (a DOMException in
    // the field). Whatever the reason's shape — an Error whose message
    // surfaces, or a non-Error that stringifies — the surface receives the
    // reason's own text, never invented prose.
    const onImportCsv = vi.fn();
    const onImportError = vi.fn();
    renderPanel({ onImportCsv, onImportError });
    chooseFile(
      unreadableFile(new DOMException("not readable", "NotReadableError")),
    );
    await act(async () => {});
    expect(onImportError).toHaveBeenCalledTimes(1);
    expect(onImportError).toHaveBeenCalledWith(
      expect.stringContaining("not readable"),
    );
    expect(onImportCsv).not.toHaveBeenCalled();
  });

  it("catches a failed read with no error surface: no throw, no import", async () => {
    const onImportCsv = vi.fn();
    renderPanel({ onImportCsv });
    chooseFile(unreadableFile(new Error("the file could not be read")));
    await act(async () => {});
    expect(onImportCsv).not.toHaveBeenCalled();
  });

  it("renders the host notice verbatim in the alert region", () => {
    renderPanel({ notice: "document/in-use: the parameter is referenced." });
    expect(screen.getByTestId("cad-configuration-notice").textContent).toBe(
      "document/in-use: the parameter is referenced.",
    );
  });
});
