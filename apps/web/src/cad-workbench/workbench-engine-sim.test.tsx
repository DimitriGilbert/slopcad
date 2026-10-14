/**
 * The workbench engine's sim committed-application threading (Phase 61d,
 * law S6): fake-engine-driven notifications through a REAL hosted channel
 * — `hostSimWorker` over the in-memory transport pair, the client handed
 * to the engine through the same `simClient` seam the 61b sim worker
 * host's booted channel plugs into — advance the `data-sim-*` counter
 * family exactly once per APPLIED notification, synchronously stamped on
 * the settle root. The engine's fixture worker session is stubbed (the
 * `workbench-engine.test.tsx` precedent): the surface under test is the
 * sim bridge, not the render channel. No ambient rAF anywhere in this
 * path — the demand-render law is untouched, and these tests assert
 * counters, never frames.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  createSimInMemoryTransportPair,
  createSimWorkerClient,
  FAKE_SIM_ENGINE_CHUNK_ROUNDS,
  FAKE_SIM_ENGINE_FIELD_CHUNKS,
  FAKE_SIM_ENGINE_STEPS,
  hostSimWorker,
} from "@slopcad/sim-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE,
  SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE,
  SIM_APPLIED_PROGRESS_STEP_ATTRIBUTE,
} from "./sim-application-ledger";
import { useWorkbenchEngine, WorkbenchStoreProvider } from "./workbench-engine";

vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (): {
    dispatch(): void;
    dispatchDocument(): void;
    dispose(): void;
  } => ({
    dispatch: () => {},
    dispatchDocument: () => {},
    dispose: () => {},
  }),
  faceAnchorSurface: (): string => "[]",
}));

afterEach(cleanup);

/** The settle root the engine stamps both attribute families onto. */
const ROOT_ID = "sim-engine-test-root";

/** A serialized flow scenario over an explicit 1000×500×500 mm domain. */
function windTunnelScenario(): Record<string, unknown> {
  return {
    id: "sim_000001",
    name: "Wind tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-500, -250, -250],
      max: [500, 250, 250],
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 10,
        direction: [1, 0, 0],
      },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
    ],
    fluid: "air",
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
  };
}

function SimEngineHarness({
  simClient,
}: {
  readonly simClient?: ReturnType<typeof createSimWorkerClient>;
}): ReactElement {
  const engine = useWorkbenchEngine({
    rootId: ROOT_ID,
    statusId: "sim-engine-test-status",
    volumeId: "sim-engine-test-volume",
    errorId: "sim-engine-test-error",
    simClient,
  });
  return (
    <div id={ROOT_ID}>
      <div
        data-testid="sim-engine-surface"
        data-applied={engine.simApplied.notifications}
        data-chunks={engine.simApplied.fieldChunks}
        data-step={engine.simApplied.progressStep ?? "none"}
      />
    </div>
  );
}

describe("the sim committed-application bridge through a hosted channel", () => {
  it("advances the counter family once per applied fake-engine notification", async () => {
    // The real hosting chain, minus a thread: the fake engine hosted as
    // the `sim.*` responder over the in-memory transport pair, and a sim
    // worker client on the other end — the same client surface the 61b
    // workbench host (`bootSimWorkbenchWorker`) returns on its booted
    // channel.
    const pair = createSimInMemoryTransportPair();
    await hostSimWorker({ transport: pair.server });
    const client = createSimWorkerClient({ transport: pair.client });
    render(
      <WorkbenchStoreProvider>
        <SimEngineHarness simClient={client} />
      </WorkbenchStoreProvider>,
    );

    const root = document.getElementById(ROOT_ID);
    expect(root).not.toBeNull();
    // The boot state: the counter family is NOT stamped — no application
    // has committed, exactly as the settle volume stays unstamped before
    // the first frame.
    expect(root?.getAttribute(SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE)).toBeNull();
    expect(screen.getByTestId("sim-engine-surface").dataset.applied).toBe("0");

    const compiled = await client.request("sim.compile", {
      scenario: windTunnelScenario(),
    });
    const run = await client.request("sim.run", {
      problem: compiled.problem,
    });
    // The fake engine's emission schedule is the applied-set expectation:
    // one progress per step, a chunk round every steps/rounds steps with
    // every published field split into chunks (two fields for a flow run).
    expect(run.steps).toBe(FAKE_SIM_ENGINE_STEPS);
    expect(run.chunks).toBe(
      // rounds × chunks per field × the two fields a flow run publishes.
      FAKE_SIM_ENGINE_CHUNK_ROUNDS * FAKE_SIM_ENGINE_FIELD_CHUNKS * 2,
    );

    // Every emission applied: the totals land on the stamped attribute
    // family — the await an e2e performs instead of a timeout.
    const total = run.steps + run.chunks;
    await waitFor(() => {
      expect(root?.getAttribute(SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE)).toBe(
        String(total),
      );
    });
    expect(root?.getAttribute(SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE)).toBe(
      String(run.chunks),
    );
    expect(root?.getAttribute(SIM_APPLIED_PROGRESS_STEP_ATTRIBUTE)).toBe(
      String(run.steps),
    );
    // The hook surface carries the same committed counters.
    expect(screen.getByTestId("sim-engine-surface").dataset.applied).toBe(
      String(total),
    );
    expect(screen.getByTestId("sim-engine-surface").dataset.chunks).toBe(
      String(run.chunks),
    );
    expect(screen.getByTestId("sim-engine-surface").dataset.step).toBe(
      String(run.steps),
    );
    client.close();
  });

  it("keeps the counters at their boot zeros without a sim channel", async () => {
    render(
      <WorkbenchStoreProvider>
        <SimEngineHarness />
      </WorkbenchStoreProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("sim-engine-surface").dataset.applied).toBe(
        "0",
      );
    });
    const root = document.getElementById(ROOT_ID);
    expect(root?.getAttribute(SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE)).toBeNull();
    expect(root?.getAttribute(SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE)).toBeNull();
    expect(root?.getAttribute(SIM_APPLIED_PROGRESS_STEP_ATTRIBUTE)).toBeNull();
    expect(screen.getByTestId("sim-engine-surface").dataset.step).toBe("none");
  });
});
