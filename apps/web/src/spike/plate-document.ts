/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * The spike's parametric document: parameters → box → subtract(cylinder).
 * Imports only types from manifold-3d, so this module is safe to load on the
 * main thread (parameter specs) while evaluation happens in the worker.
 * See docs/architecture/spike-findings.md.
 */

import { cad, feature, numberParam } from "./cad-api";

const plateParameters = {
  width: numberParam({ default: 30, min: 10, max: 60, step: 1 }),
  height: numberParam({ default: 20, min: 10, max: 40, step: 1 }),
  depth: numberParam({ default: 10, min: 2, max: 20, step: 1 }),
  holeDiameter: numberParam({ default: 8, min: 0, max: 16, step: 1 }),
};

type PlateParameters = typeof plateParameters;

export const plateDocument = cad({
  parameters: plateParameters,
  features: [
    feature<PlateParameters>("box", ({ kernel, parameters }) =>
      kernel.Manifold.cube(
        [parameters.width, parameters.height, parameters.depth],
        true,
      ),
    ),
    feature<PlateParameters>("hole", ({ kernel, parameters }) =>
      kernel.Manifold.cylinder(
        parameters.depth * 2,
        parameters.holeDiameter / 2,
        undefined,
        undefined,
        true,
      ),
    ),
    feature<PlateParameters>("plate", ({ kernel, get }) =>
      kernel.Manifold.difference(get("box"), get("hole")),
    ),
  ],
  output: "plate",
});
