/**
 * The chat view's document summary seam (R1F3): `useDocumentSummary` —
 * the exact getter the panel hands each run's system prompt — re-derives
 * the outline through the real `cad_get_document` registry tool. The spec
 * pins the corrected scope: the outline's selection and mode do NOT ride
 * the document object's identity (selection is the store's own concern;
 * mode is page-level state), so a selection or mode change must re-derive
 * the summary with the document object untouched.
 */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createSelectionState,
  type CadDocument,
  type SelectionState,
} from "@slopcad/cad-core";

import { createCadWorkbenchSession } from "../../cad-workbench/session";
import {
  defineWebMcpTool,
  registerWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
} from "../../webmcp/registry";
import { useDocumentSummary } from "./workbench-chat-view";

/**
 * The live outline the fake `cad_get_document` answers from — the same
 * live-read contract as the real tool (store concerns + page mode), here
 * reduced to the two fields whose revision signals are under test.
 */
const liveOutline = {
  mode: "model",
  selected: [] as readonly string[],
};

const fakeGetDocument = defineWebMcpTool({
  description: "The outline probe: answers from the mutable liveOutline.",
  inputSchema: z.object({}),
  name: "cad_get_document",
  execute: () => ({
    mode: liveOutline.mode,
    ok: true,
    selection: {
      hover: null,
      selected: liveOutline.selected,
    },
  }),
});

/** The hook's props, as the view itself passes them. */
interface SummaryProps {
  readonly document: CadDocument;
  readonly selection: SelectionState;
  readonly mode: string;
}

afterEach(() => {
  cleanup();
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
  liveOutline.mode = "model";
  liveOutline.selected = [];
});

describe("useDocumentSummary", () => {
  it("re-derives on a selection change with the document identity untouched", async () => {
    const registration = registerWebMcpTool(fakeGetDocument);
    // ONE document object for the whole test: every re-derivation below
    // happens without a document identity change.
    const document: CadDocument = createCadWorkbenchSession().document;
    const { result, rerender } = renderHook(
      (props: SummaryProps) =>
        useDocumentSummary(props.document, props.selection, props.mode),
      {
        initialProps: {
          document,
          selection: createSelectionState(0),
          mode: "model",
        },
      },
    );
    await waitFor(() => {
      expect(result.current()).toContain('"mode":"model"');
    });
    expect(result.current()).not.toContain("face:1");

    // The selection moves (a pick) — new selection identity, same
    // document object, same mode: the getter must serve the new outline.
    liveOutline.selected = ["face:1"];
    rerender({
      document,
      selection: createSelectionState(1),
      mode: "model",
    });
    await waitFor(() => {
      expect(result.current()).toContain("face:1");
    });
    registration.unregister();
  });

  it("re-derives on a mode change with document and selection untouched", async () => {
    const registration = registerWebMcpTool(fakeGetDocument);
    const document: CadDocument = createCadWorkbenchSession().document;
    const { result, rerender } = renderHook(
      (props: SummaryProps) =>
        useDocumentSummary(props.document, props.selection, props.mode),
      {
        initialProps: {
          document,
          selection: createSelectionState(0),
          mode: "model",
        },
      },
    );
    await waitFor(() => {
      expect(result.current()).toContain('"mode":"model"');
    });

    // The page enters sketch mode — page-level state, no document or
    // selection change: the getter must serve the new outline.
    liveOutline.mode = "sketch";
    rerender({
      document,
      selection: createSelectionState(0),
      mode: "sketch",
    });
    await waitFor(() => {
      expect(result.current()).toContain('"mode":"sketch"');
    });
    registration.unregister();
  });
});
