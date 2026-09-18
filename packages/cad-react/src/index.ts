/**
 * Public entry of `@slopcad/cad-react`, the React integration layer over
 * the kernel-neutral CAD core. Re-exports the core public API so React
 * consumers depend on this package alone, and adds the Phase 14
 * integration surface: the {@link CadStore} runtime composition, the
 * {@link CadProvider} context, the document/parameters/selection/tools/
 * history hooks, and the composable model API. React is a peer dependency;
 * this layer never touches geometry kernels, and the domain it mirrors
 * runs headless without any of this module.
 */
export * from "@slopcad/cad-core";
export {
  CadProvider,
  CadProviderError,
  CAD_PROVIDER_ERROR_CODE,
  useCadStore,
} from "./provider";
export type { CadProviderProps } from "./provider";
export { CAD_STORE_CONCERNS, CadStore, createCadStore } from "./store";
export type {
  CadHistoryView,
  CadStoreConcern,
  CadStoreOptions,
  CadToolSurface,
} from "./store";
export { useCadDocument } from "./use-cad-document";
export type { CadDocumentApi } from "./use-cad-document";
export { useCadHistory } from "./use-cad-history";
export type { CadHistoryApi } from "./use-cad-history";
export { useCadModel } from "./use-cad-model";
export type { CadModelApi } from "./use-cad-model";
export { useCadParameters } from "./use-cad-parameters";
export type {
  CadParametersApi,
  ExpressionSetError,
  ExpressionUpdateError,
} from "./use-cad-parameters";
export { useCadSelection } from "./use-cad-selection";
export type { CadSelectionApi } from "./use-cad-selection";
export { useCadTools } from "./use-cad-tools";
export type { CadToolsApi } from "./use-cad-tools";
export {
  cadTransaction,
  createFeatureCommand,
  createPrimitiveTransaction,
  deleteFeatureCommand,
  removeFeatureTransaction,
  setParameterCommand,
  updateFeatureCommand,
  updatePrimitiveTransaction,
} from "./model";
export type {
  FeatureAuthoring,
  IdentifiedFeatureAuthoring,
  ParameterAssignment,
  PrimitiveAuthoring,
} from "./model";
