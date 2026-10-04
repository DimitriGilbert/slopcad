/**
 * Public entry of `@slopcad/cad-components`, the reusable parametric CAD
 * components (Phase 32) and the parametric viewer's core (the final
 * registry phase). Every component is independently importable — from
 * this entry or its own subpath (`@slopcad/cad-components/nema17-mount`)
 * — and everything exported here depends only on the public cad-core and
 * cad-kernel surfaces: the serialized component contract for metadata, and
 * the kernel-neutral execution surface for geometry. No React, no DOM, no
 * database, no concrete kernel backend. (The viewer's TSX composition is
 * deliberately NOT re-exported here — it is a registry artifact with React
 * and the public cad-react model API as its surfaces, imported from its
 * own subpath `@slopcad/cad-components/viewer/parametric-cad-viewer` or
 * installed through the shadcn registry.)
 */

// -- The 32.1 contract -----------------------------------------------------

export type {
  CadComponentDefinition,
  ComponentParameterDescriptor,
  ComponentParameterValues,
  ComponentPortDescriptor,
  ComponentPortInstance,
  ComponentPortKind,
  ComponentPreviewMetadata,
  ComponentContractError,
  ComponentContractErrorCode,
  ResolvedComponentParameters,
  SerializedComponentDefinition,
} from "./component-contract";
export {
  COMPONENT_CONTRACT_VERSION,
  COMPONENT_CONTRACT_ERROR_CODES,
  COMPONENT_PORT_KINDS,
  componentParameterCollection,
  componentParametersOfCollection,
  defaultParameterValues,
  isComponentParameterName,
  parameterValueOrDefault,
  parameterValuesOfCollection,
  parseComponentDefinition,
  resolveComponentParameters,
  serializeComponentDefinition,
} from "./component-contract";

// -- The execution surface -------------------------------------------------

export type {
  ComponentKernel,
  ComponentKernelError,
  ComponentKernelResult,
} from "./component-kernel";
export { directComponentKernel } from "./component-kernel";
export type { ContextKernelOptions } from "./context-kernel";
export { createContextKernel } from "./context-kernel";

export type {
  CadComponent,
  ComponentBuild,
  ComponentBuildBody,
  ComponentBuildError,
  ComponentBuildResult,
} from "./cad-component";
export {
  COMPONENT_BUILD_ERROR_CODES,
  contractFailureAsBuildError,
  defineComponent,
  parameterConflict,
  resolveBuildParameters,
} from "./cad-component";

// -- The Phase 32 components ----------------------------------------------

import type { CadComponent } from "./cad-component";

import { arduinoMount } from "./arduino-mount";
import { enclosure } from "./enclosure";
import { nema17Mount } from "./nema17-mount";

export { nema17Mount } from "./nema17-mount";
export type { Nema17MountParameters } from "./nema17-mount";
export {
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  NEMA17_MOUNT_DEFINITION,
} from "./nema17-mount";

export { arduinoMount } from "./arduino-mount";
export type { ArduinoMountParameters } from "./arduino-mount";
export {
  ARDUINO_MOUNT_DEFAULT_PARAMETERS,
  ARDUINO_MOUNT_DEFINITION,
  ARDUINO_UNO_R3_FOOTPRINT,
  boardHoleCentersMm,
} from "./arduino-mount";

export { enclosure } from "./enclosure";
export type { EnclosureDerived, EnclosureParameters } from "./enclosure";
export {
  ENCLOSURE_DEFAULT_PARAMETERS,
  ENCLOSURE_DEFINITION,
  deriveEnclosure,
  lidBossCentersMm,
  roundedRectLoop,
  seatedLidOffsetMm,
  seatedLidZMm,
} from "./enclosure";

/** The Phase 32 components, in registry order. */
export const PHASE32_COMPONENTS: readonly CadComponent[] = [
  nema17Mount,
  arduinoMount,
  enclosure,
];

// -- The parametric viewer core (the final registry phase) ------------------

export type {
  ViewerBody,
  ViewerPersistedState,
  ViewerProjectionBuild,
  ViewerSourceLoad,
  ViewerSourceSummary,
} from "./viewer/parametric-viewer-core";
export {
  frameViewerCamera,
  loadViewerSource,
  projectViewerBodies,
  serializeViewerSession,
  viewerTitleOf,
} from "./viewer/parametric-viewer-core";
