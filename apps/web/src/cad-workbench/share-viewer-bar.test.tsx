/**
 * The share bar's component tests: the split button copies the default
 * lean link (compact presentation, collapsed history) from its main
 * action, the arrow's picker offers the other emission variants, and the
 * clipboard really receives a decodable `/viewer` link of the chosen
 * variant — the lean link's native text is compact, the legacy picker's
 * is the pretty file form.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CadProvider, createCadStore } from "@slopcad/cad-react";
import {
  createDocument,
  createDocumentId,
  createSession,
} from "@slopcad/cad-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchEngine } from "./workbench-engine";

import { decodeNativeFromShare } from "../viewer/share-codec";
import { WorkbenchShareBar } from "./share-viewer-bar";

const writeTextMock = vi.fn<(text: string) => Promise<void>>();

/** The minimal engine face the bar reads (its prop is the narrowed Pick). */
const ENGINE: Pick<
  WorkbenchEngine,
  "regenerationStates" | "rollback" | "suppressed"
> = {
  regenerationStates: new Map(),
  rollback: null,
  suppressed: new Set(),
};

function renderBar(): void {
  const store = createCadStore({
    session: createSession(createDocument(createDocumentId("doc_share_bar"))),
  });
  render(
    <CadProvider store={store}>
      <WorkbenchShareBar engine={ENGINE} />
    </CadProvider>,
  );
}

/** The last clipboard URL's fragment, decoded back to native text. */
async function lastCopiedNativeText(): Promise<string> {
  const url = writeTextMock.mock.calls.at(-1)?.[0];
  if (url === undefined) throw new Error("nothing was copied");
  const decoded = await decodeNativeFromShare(url.slice(url.indexOf("#")));
  if (!decoded.ok)
    throw new Error(`the copied link does not decode: ${decoded.error}`);
  return decoded.text;
}

beforeEach(() => {
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
  });
});

afterEach(cleanup);

describe("WorkbenchShareBar", () => {
  it("copies the default lean link from the main action", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("workbench-share-viewer"));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-share-state").textContent).toContain(
        "viewer link copied — compact, no history",
      );
    });
    const url = writeTextMock.mock.calls.at(-1)?.[0];
    expect(url).toMatch(/\/viewer#1d\./);
    // The default link's native text is the compact presentation.
    expect(await lastCopiedNativeText()).not.toContain("\n");
  });

  it("the picker offers the other variants and copies the chosen one", async () => {
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose viewer link format" }),
    );
    const legacy = await screen.findByTestId("workbench-share-variant-legacy");
    expect(screen.getByTestId("workbench-share-variant-lean")).toBeTruthy();
    expect(screen.getByTestId("workbench-share-variant-compact")).toBeTruthy();
    fireEvent.click(legacy);
    await waitFor(() => {
      expect(screen.getByTestId("workbench-share-state").textContent).toContain(
        "viewer link copied — legacy, with history",
      );
    });
    // The legacy picker's native text is the pretty file form.
    expect(await lastCopiedNativeText()).toContain("\n  ");
  });

  it("surfaces a clipboard failure as the error line", async () => {
    writeTextMock.mockRejectedValue(new Error("clipboard refused"));
    renderBar();
    fireEvent.click(screen.getByTestId("workbench-share-viewer"));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-share-state").textContent).toContain(
        "share failed: clipboard refused",
      );
    });
  });
});
