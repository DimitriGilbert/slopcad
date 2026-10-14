/**
 * The share bar's component tests: the split button copies the default
 * lean link (compact presentation, collapsed history) from its main
 * action, the arrow's picker offers the other emission variants plus the
 * server link, and the clipboard really receives a decodable `/viewer`
 * link of the chosen variant — the lean link's native text is compact,
 * the legacy picker's is the pretty file form, and the server link is a
 * short `/viewer?p=<id>` URL after the shares mutation resolves through
 * a mocked tRPC transport.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@slopcad/api/routers/index";
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

import { TRPCProvider } from "@/utils/trpc";

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

/** The id the mocked shares transport hands back for a server link. */
const UPLOADED_SHARE_ID = "abcdefghij";

function renderBar(): void {
  const store = createCadStore({
    session: createSession(createDocument(createDocumentId("doc_share_bar"))),
  });
  const queryClient = new QueryClient();
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: "/api/trpc" })],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TRPCProvider queryClient={queryClient} trpcClient={trpcClient}>
        <CadProvider store={store}>
          <WorkbenchShareBar engine={ENGINE} />
        </CadProvider>
      </TRPCProvider>
    </QueryClientProvider>,
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("uploads a server link and copies the short /viewer?p= URL", async () => {
    // The shares mutation's transport: one batch POST answered with the
    // allocated id, exactly the envelope httpBatchLink unwraps (the
    // router runs no output transformer, so data rides bare).
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify([{ result: { data: { id: UPLOADED_SHARE_ID } } }]),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose viewer link format" }),
    );
    fireEvent.click(await screen.findByTestId("workbench-share-server"));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-share-state").textContent).toContain(
        `viewer link copied — server link, short id`,
      );
    });
    const url = writeTextMock.mock.calls.at(-1)?.[0];
    expect(url).toBe(`${window.location.origin}/viewer?p=${UPLOADED_SHARE_ID}`);
  });

  it("surfaces a missing clipboard API as the error line (the sync-throw funnel)", async () => {
    // Insecure contexts have no navigator.clipboard at all: the property
    // access throws SYNCHRONOUSLY. After a successful upload, the funnel
    // must turn that throw into the error line — not an unhandled
    // rejection that wedges the busy state forever.
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify([{ result: { data: { id: UPLOADED_SHARE_ID } } }]),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    );
    renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose viewer link format" }),
    );
    fireEvent.click(await screen.findByTestId("workbench-share-server"));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-share-state").textContent).toMatch(
        /^share failed: /,
      );
    });
    // Nothing was copied (there is no clipboard to copy to).
    expect(writeTextMock).not.toHaveBeenCalled();
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
