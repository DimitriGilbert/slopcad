/**
 * Phase 45 viewport-view session reducers: the overlay's write discipline
 * pinned on the pure record — boot is spec law (shaded, third angle),
 * every reducer writes exactly its field, and reset is a plain camera
 * clear that leaves the display preferences alone.
 */

import { describe, expect, it } from "vitest";
import { parseRenderCamera } from "@slopcad/cad-core";
import type { RenderCamera } from "@slopcad/cad-core";

import {
  createViewportViewSession,
  sessionWithConvention,
  sessionWithDisplayMode,
  sessionWithUserCamera,
} from "./viewport-view";

const FRONT: RenderCamera = {
  fovDeg: 40,
  kind: "perspective",
  position: [0, -80, 20],
  target: [0, 0, 0],
  up: [0, 0, 1],
};

describe("createViewportViewSession", () => {
  it("boots at spec law: no overlay, shaded, third angle, studio, standard", () => {
    expect(createViewportViewSession()).toEqual({
      convention: "third-angle",
      displayMode: "shaded",
      lightRig: "studio",
      renderQuality: "standard",
      userCamera: null,
    });
  });
});

describe("sessionWithUserCamera", () => {
  it("writes the overlay and clears it back to spec law", () => {
    const boot = createViewportViewSession();
    const withCamera = sessionWithUserCamera(boot, FRONT);
    expect(withCamera.userCamera).toEqual(FRONT);
    // Only the camera field moved.
    expect(withCamera.convention).toBe(boot.convention);
    expect(withCamera.displayMode).toBe(boot.displayMode);
    const reset = sessionWithUserCamera(withCamera, null);
    expect(reset.userCamera).toBeNull();
  });

  it("carries structurally valid cameras only (the host's contract)", () => {
    const withCamera = sessionWithUserCamera(
      createViewportViewSession(),
      FRONT,
    );
    if (withCamera.userCamera === null) throw new Error("camera missing");
    expect(parseRenderCamera(withCamera.userCamera).ok).toBe(true);
  });
});

describe("sessionWithDisplayMode", () => {
  it("writes the display mode without touching the camera", () => {
    const withCamera = sessionWithUserCamera(
      createViewportViewSession(),
      FRONT,
    );
    const hidden = sessionWithDisplayMode(withCamera, "hidden-line");
    expect(hidden.displayMode).toBe("hidden-line");
    expect(hidden.userCamera).toEqual(FRONT);
  });
});

describe("sessionWithConvention", () => {
  it("writes the convention without touching the camera", () => {
    const withCamera = sessionWithUserCamera(
      createViewportViewSession(),
      FRONT,
    );
    const first = sessionWithConvention(withCamera, "first-angle");
    expect(first.convention).toBe("first-angle");
    expect(first.userCamera).toEqual(FRONT);
  });
});
