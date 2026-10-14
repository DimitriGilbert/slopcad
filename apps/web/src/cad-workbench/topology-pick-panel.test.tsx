/**
 * The non-modal topology pick panel's component tests: the honest query
 * states, the viewport-driven picks (no pick field in the panel), and the
 * verb's form mounting once a target is picked.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { createBodyId } from "@slopcad/cad-core";
import type { TopologySnapshot } from "@slopcad/cad-core";
import type { FaceOpSubmission } from "./face-op-pick";
import type { TopologyCutSubmission } from "./topology-pick";

import { CadTopologyPickPanel } from "./topology-pick-panel";

afterEach(() => {
  cleanup();
});

/** A named persistent snapshot of `bodyId`: edges 0–1 and faces 0–1. */
function snapshotOf(bodyId: string): TopologySnapshot {
  const entity = (kind: "edge" | "face", ordinal: number) => ({
    kind,
    ordinal,
    identity: {
      kernelId: "fixture-kernel",
      schema: "fixture-snapshot-v1",
      data: { hash: ordinal },
    },
    geometry:
      kind === "edge"
        ? { lengthMm: 10, centroidAbsoluteMm: [ordinal, 0, 0] as const }
        : { areaMm2: 100, centroidAbsoluteMm: [0, 0, ordinal] as const },
  });
  return {
    kernelId: "fixture-kernel",
    persistentTopology: true,
    identitySchemas: ["fixture-snapshot-v1"],
    bodyId: createBodyId(bodyId),
    regeneration: 0,
    entities: [
      entity("edge", 0),
      entity("edge", 1),
      entity("face", 0),
      entity("face", 1),
    ],
  };
}

const target = {
  bodyId: "body_box",
  name: "box",
  snapshot: snapshotOf("body_box"),
};

function renderPanel(
  overrides: Partial<Parameters<typeof CadTopologyPickPanel>[0]> = {},
): {
  readonly onTopologyCut: Mock<(submission: TopologyCutSubmission) => void>;
  readonly onCancel: Mock<() => void>;
} {
  const onTopologyCut = vi.fn<(submission: TopologyCutSubmission) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <CadTopologyPickPanel
      datumPlanes={[]}
      error={null}
      onCancel={onCancel}
      onFaceOp={vi.fn<(submission: FaceOpSubmission) => void>()}
      onTopologyCut={onTopologyCut}
      queryError={null}
      selection={null}
      targets={[target]}
      verb="fillet"
      {...overrides}
    />,
  );
  return { onTopologyCut, onCancel };
}

describe("CadTopologyPickPanel: viewport picks, never a pick field", () => {
  it("shows the honest loading, failed and unavailable states", () => {
    renderPanel({ targets: null });
    expect(screen.getByTestId("workbench-topology-pick-loading")).toBeTruthy();
    cleanup();
    renderPanel({ queryError: "worker died" });
    expect(
      screen.getByTestId("workbench-topology-pick-failed").textContent,
    ).toContain("worker died");
    cleanup();
    renderPanel({ targets: [] });
    expect(
      screen.getByTestId("workbench-topology-pick-unavailable"),
    ).toBeTruthy();
  });

  it("asks for a viewport click and mounts no form before a pick", () => {
    const { onCancel } = renderPanel();
    expect(screen.getByText(/Click a marker in the viewport/)).toBeTruthy();
    expect(screen.getByText("Nothing picked yet.")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("lists the viewport picks and submits them through the verb's form", async () => {
    const { onTopologyCut } = renderPanel({
      selection: { target, ordinals: [1] },
    });
    expect(
      screen.getByTestId("workbench-topology-picks").textContent,
    ).toContain("Edge 1 · 10 mm at (1, 0, 0)");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onTopologyCut).toHaveBeenCalledTimes(1));
    expect(onTopologyCut.mock.calls[0]?.[0]).toEqual({
      kind: "fillet",
      snapshot: target.snapshot,
      ordinals: [1],
      sizeMm: 2,
    });
  });

  it("surfaces the last submission's structured refusal", () => {
    renderPanel({ error: "kernel/refused: no edge" });
    expect(screen.getByRole("alert").textContent).toBe(
      "kernel/refused: no edge",
    );
  });
});
