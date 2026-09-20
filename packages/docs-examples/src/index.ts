/**
 * Public entry of `@slopcad/docs-examples` (Phase 34): the runnable
 * documentation examples. Every guide in `docs/guides/` references an
 * example that lives here, and every example is machine-verified —
 * `pnpm verify` typechecks and builds this package through the turbo
 * graph, and the vitest suite (`src/docs-examples.test.ts` and its
 * siblings) RUNS each example and asserts the documented outcomes.
 *
 * The web app's `/docs` documentation application imports the
 * browser-safe examples from this entry, so the page proves the same
 * code the gates prove. The Node-only examples (the worker channel and
 * the OCCT exchange chain) stay off the page — they need
 * `node:worker_threads` or Node-only wasm loading — and are covered by
 * the suite instead.
 */

// -- Headless core (browser-safe) -------------------------------------------

export {
  runDocumentExample,
  unwrap,
  type DocumentExampleSummary,
} from "./core/document";
export { runUnitsExample, type UnitsExampleSummary } from "./core/units";
export { runHistoryExample, type HistoryExampleSummary } from "./core/history";
export {
  runNativeFormatExample,
  type NativeFormatExampleSummary,
} from "./core/native";
export {
  GUIDE_CAMERA,
  PROJECTION_BODY,
  runProjectionExample,
  type ProjectionExampleSummary,
} from "./core/projection";
export {
  runCustomToolExample,
  stampTool,
  type CustomToolExampleSummary,
} from "./core/custom-tool";

// -- Kernels ------------------------------------------------------------------

export {
  UNSUPPORTED_OPERATION_CODE,
  runKernelExample,
  unwrapKernel,
  type KernelExampleSummary,
} from "./kernel/primitives";
export {
  CAPABILITY_FLAG_NAMES,
  KERNEL_CAPABILITY_ROWS,
  type KernelCapabilityRow,
} from "./kernel/capabilities";
export {
  createLoggedFakeKernel,
  runCustomAdapterExample,
  withOperationLog,
  type CustomAdapterExampleSummary,
  type LoggedKernel,
} from "./kernel/custom-adapter";
export {
  BOX,
  BOX_VOLUME_MM3,
  buildHoleDocument,
  HOLE_DEPTH_MM,
  HOLE_DIAMETER_MM,
  runFeaturesExample,
  type FeaturesExampleSummary,
} from "./kernel/features";

// -- IO -----------------------------------------------------------------------

export {
  EXAMPLE_TESSELLATION,
  runMeshExchangeExample,
  type MeshExchangeExampleSummary,
} from "./io/mesh";

// -- Sketch -------------------------------------------------------------------

export { runSketchExample, type SketchExampleSummary } from "./sketch/sketch";
export {
  runSketchVocabularyExample,
  type SketchVocabularySummary,
} from "./sketch/vocabulary";

// -- Components ---------------------------------------------------------------

export {
  runComponentsExample,
  type ComponentsExampleSummary,
} from "./components/components";

// -- React (jsdom; the /docs page does not import this module) ---------------

export {
  createGuideStore,
  GuideParameterPanel,
  GuideReactExample,
} from "./react/store";
