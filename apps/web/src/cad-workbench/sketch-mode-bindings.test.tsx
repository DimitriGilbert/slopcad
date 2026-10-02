/**
 * SketchMode's parameter-bound dimension surfaces (component level): the
 * inspector's `$`-token dimension field committing the BOUND
 * `sketch.dimension.set` form, the unknown-name refusal (nothing commits),
 * the negated-token refusal (Phase 30: the binding seam follows the domain —
 * a binding reads the parameter's value verbatim, so the sign cannot ride
 * it), a literal submit unbinding, and the live re-drive — re-rendering with
 * an edited parameter collection re-solves the bound dimension so the solved
 * geometry follows without any sketch command. Machine surfaces carry the
 * assertions (data-sketch-commands, data-sketch-dimensions,
 * data-sketch-solved), exactly like the browser battery.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  addParameter,
  createParameterId,
  EMPTY_PARAMETER_COLLECTION,
  length,
  type ParameterCollection,
} from "@slopcad/cad-core";

import { SketchMode } from "./SketchMode";

afterEach(cleanup);

const BOARD_L = createParameterId("param_boardL");

function parametersWith(boardLMm: number): ParameterCollection {
  const added = addParameter(EMPTY_PARAMETER_COLLECTION, {
    id: BOARD_L,
    name: "boardL",
    value: length(boardLMm),
  });
  if (!added.ok) throw new Error(added.error.message);
  return added.value;
}

/** The canvas click point for a workplane mm coordinate (6 px/mm). */
function fireCanvasPick(x: number, y: number): void {
  const surface = document.querySelector("[data-sketch-surface]");
  if (surface === null) throw new Error("the sketch canvas must be mounted");
  surface.getBoundingClientRect = () => new DOMRect(0, 0, 800, 520);
  fireEvent(
    surface,
    new MouseEvent("pointerdown", {
      bubbles: true,
      clientX: 120 + x * 6,
      clientY: 400 - y * 6,
    }),
  );
}

function mount(boardLMm: number) {
  const view = render(
    <SketchMode
      onExtrude={() => {}}
      onExit={() => {}}
      parameters={parametersWith(boardLMm)}
    />,
  );
  const root = (): Element => {
    const element = document.getElementById("sketch-root");
    if (element === null) throw new Error("the sketch root must be mounted");
    return element;
  };
  const toolButton = (toolId: string): Element => {
    const button = document.querySelector(`[data-sketch-tool-id="${toolId}"]`);
    if (button === null) throw new Error(`tool button ${toolId} missing`);
    return button;
  };
  return { root, toolButton, view };
}

describe("SketchMode parameter-bound dimensions", () => {
  it("commits the bound form from a $name submit and re-drives on a parameter edit", async () => {
    const { root, toolButton, view } = mount(20);
    // Draw one horizontal line (two picks).
    fireEvent.click(toolButton("line"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(
        JSON.parse(root().getAttribute("data-sketch-entities") ?? "[]"),
      ).toHaveLength(1);
    });
    // Dimension it: distanceX between the two endpoints (auto-selects the
    // new constraint, so the inspector's dimension field appears).
    fireEvent.click(toolButton("distanceX"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(root().getAttribute("data-sketch-selection")).toContain(
        "skcon_distance",
      );
    });
    // The literal default reads 20; the field is the expression field.
    const field = document.querySelector(
      '[data-slot="cad-sketch-inspector"] input[type="text"]',
    );
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the expression dimension field must be mounted");
    }
    expect(field.value).toBe("20");
    // Submit the $name token: the machine log carries the BOUND form.
    fireEvent.change(field, { target: { value: "$boardL" } });
    fireEvent.click(
      document
        .querySelector('[data-slot="cad-sketch-inspector"]')
        ?.querySelector('button[type="submit"]') ?? document.body,
    );
    await waitFor(() => {
      const log = JSON.parse(
        root().getAttribute("data-sketch-commands") ?? "[]",
      ) as readonly { readonly type: string; readonly parameterId?: string }[];
      expect(log.at(-1)?.type).toBe("sketch.dimension.set");
      expect(log.at(-1)?.parameterId).toBe(BOARD_L);
    });
    // The inspector row names the binding.
    await waitFor(() => {
      expect(
        root().querySelector('[data-slot="cad-sketch-inspector"]')?.textContent,
      ).toContain("distanceX $boardL");
    });
    // THE RE-DRIVE: re-render with an edited parameter collection (the
    // host's document changed) — no sketch command, but the solved geometry
    // follows the parameter: the line stretches to 40 and the dimension
    // readout re-derives.
    const commandsBefore = root().getAttribute("data-sketch-commands");
    view.rerender(
      <SketchMode
        onExtrude={() => {}}
        onExit={() => {}}
        parameters={parametersWith(40)}
      />,
    );
    await waitFor(() => {
      const solved = JSON.parse(
        root().getAttribute("data-sketch-solved") ?? "[]",
      ) as readonly {
        readonly kind: string;
        readonly x1?: number;
        readonly x2?: number;
      }[];
      const line = solved.find((entity) => entity.kind === "line");
      expect(Math.abs((line?.x2 ?? 0) - (line?.x1 ?? 0))).toBeCloseTo(40, 3);
    });
    expect(root().getAttribute("data-sketch-commands")).toBe(commandsBefore);
  });

  it("refuses an unknown name on the apply surface without committing", async () => {
    const { root, toolButton } = mount(20);
    fireEvent.click(toolButton("line"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(
        JSON.parse(root().getAttribute("data-sketch-entities") ?? "[]"),
      ).toHaveLength(1);
    });
    fireEvent.click(toolButton("distanceX"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(root().getAttribute("data-sketch-selection")).toContain(
        "skcon_distance",
      );
    });
    const field = document.querySelector(
      '[data-slot="cad-sketch-inspector"] input[type="text"]',
    );
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the expression dimension field must be mounted");
    }
    // The FIELD gate refuses unknown names before any submit (the same
    // expressionNumberProblem the feature dialogs run): the form does not
    // submit, the field error names the parameter, and the log does not
    // grow.
    const commandsBefore = root().getAttribute("data-sketch-commands");
    fireEvent.change(field, { target: { value: "$nope" } });
    const inspector = root().querySelector(
      '[data-slot="cad-sketch-inspector"]',
    );
    if (inspector === null) throw new Error("inspector missing");
    fireEvent.submit(inspector.querySelector("form") ?? document.body);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Unknown parameter "nope".');
    });
    expect(root().getAttribute("data-sketch-commands")).toBe(commandsBefore);
  });

  it("a literal submit on a bound dimension unbinds it", async () => {
    const { root, toolButton } = mount(20);
    fireEvent.click(toolButton("line"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(
        JSON.parse(root().getAttribute("data-sketch-entities") ?? "[]"),
      ).toHaveLength(1);
    });
    fireEvent.click(toolButton("distanceX"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(root().getAttribute("data-sketch-selection")).toContain(
        "skcon_distance",
      );
    });
    const field = document.querySelector(
      '[data-slot="cad-sketch-inspector"] input[type="text"]',
    );
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the expression dimension field must be mounted");
    }
    fireEvent.change(field, { target: { value: "$boardL" } });
    fireEvent.submit(
      document.querySelector('[data-slot="cad-sketch-inspector"] form') ??
        document.body,
    );
    await waitFor(() => {
      const log = JSON.parse(
        root().getAttribute("data-sketch-commands") ?? "[]",
      ) as readonly { readonly parameterId?: string }[];
      expect(log.at(-1)?.parameterId).toBe(BOARD_L);
    });
    // A literal re-submit unbinds: the follow-up command carries a value
    // and no parameterId.
    fireEvent.change(field, { target: { value: "25" } });
    fireEvent.submit(
      document.querySelector('[data-slot="cad-sketch-inspector"] form') ??
        document.body,
    );
    await waitFor(() => {
      const log = JSON.parse(
        root().getAttribute("data-sketch-commands") ?? "[]",
      ) as readonly {
        readonly parameterId?: string;
        readonly value?: unknown;
      }[];
      expect(log.at(-1)?.parameterId).toBeUndefined();
      expect(log.at(-1)?.value).toMatchObject({ value: 25 });
    });
  });

  it("refuses a negated token at the binding seam: the sign cannot ride a verbatim read", async () => {
    const { root, toolButton } = mount(20);
    fireEvent.click(toolButton("line"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(
        JSON.parse(root().getAttribute("data-sketch-entities") ?? "[]"),
      ).toHaveLength(1);
    });
    // distanceX: the domain genuinely supports signed separations, so this
    // is the branch whose refusal is the MECHANISM, not a range rule — the
    // binding reads the parameter's value verbatim and the sign would
    // silently drop.
    fireEvent.click(toolButton("distanceX"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    await waitFor(() => {
      expect(root().getAttribute("data-sketch-selection")).toContain(
        "skcon_distance",
      );
    });
    const field = document.querySelector(
      '[data-slot="cad-sketch-inspector"] input[type="text"]',
    );
    if (!(field instanceof HTMLInputElement)) {
      throw new Error("the expression dimension field must be mounted");
    }
    // The token passes the field's grammar gate (known name), the form
    // submits, and the apply surface refuses with the existing
    // invalid-dimension code — nothing commits.
    const commandsBefore = root().getAttribute("data-sketch-commands");
    fireEvent.change(field, { target: { value: "-$boardL" } });
    const inspector = root().querySelector(
      '[data-slot="cad-sketch-inspector"]',
    );
    if (inspector === null) throw new Error("inspector missing");
    fireEvent.submit(inspector.querySelector("form") ?? document.body);
    await waitFor(() => {
      expect(document.body.textContent).toContain('"-$boardL" cannot bind');
    });
    expect(document.body.textContent).toContain("sign would silently drop");
    expect(root().getAttribute("data-sketch-commands")).toBe(commandsBefore);
  });
});
