/**
 * Public entry of `@slopcad/cad-r3f`, the React Three Fiber renderer
 * layer: the Phase 11.2 model renderer (geometry mapping, update diff,
 * `CadModel` component), the Phase 11.3 deterministic scene (camera
 * mapping, fixed light rig, ground furniture, `CadScene` composition), and
 * the Phase 12 selection layer (picking bridge, highlight passes) over the
 * renderer-neutral projection contract. React, Three.js, and R3F are
 * peer dependencies; geometry kernels and worker modules are never
 * imported here — the renderer consumes the projection as data.
 *
 * Phase 14 boundary decision: this package stays PROP-DRIVEN. `CadScene`
 * (and `CadModel`) take the projection, selection, regeneration identity,
 * and pick callbacks as explicit props and know nothing of the Phase 14
 * `CadProvider`/hooks in `@slopcad/cad-react`; a host mirrors domain state
 * through those hooks and feeds this renderer as props (see the app's
 * workbench fixture). Adding provider-awareness here would duplicate the
 * mirroring the hooks already own and couple the deterministic scene to a
 * specific integration layer.
 */
export { CAD_DOCUMENT_FORMAT_VERSION } from "@slopcad/cad-react";
export {
  CAD_SCENE_BACKGROUND,
  CadScene,
  type CadSceneProps,
} from "./cad-scene";
export {
  CadModel,
  type CadModelMaterialProps,
  type CadModelProps,
} from "./cad-model";
export {
  buildRenderObjectGeometry,
  createRenderGeometryController,
  RENDER_GEOMETRY_FLOAT32_TOLERANCE_MM,
  type RenderGeometryController,
  type RenderGeometrySnapshot,
} from "./geometry";
export {
  CAD_PICK_CATEGORIES,
  PICK_ERROR_CODES,
  renderCameraScreenPoint,
  resolvePickReference,
  type CadPick,
  type CadPickCategory,
  type PickError,
  type PickErrorCode,
  type ResolvePickInput,
} from "./picking";
export {
  serializeToolInputEvent,
  toolKeyEvent,
  toolModifiersFromNative,
  toolPointerEvent,
} from "./tool-input";
export {
  buildFaceHighlightGeometry,
  CAD_BODY_SELECTION_EMISSIVE_INTENSITY,
  CAD_FACE_HIGHLIGHT_POLYGON_OFFSET,
  CAD_SELECTION_HIGHLIGHT_COLOR,
  isBodySelected,
  selectedFaceIndices,
} from "./selection-highlight";
export {
  applySceneCamera,
  CAD_SCENE_CAMERA_FAR_MM,
  CAD_SCENE_CAMERA_NEAR_MM,
  createSceneCamera,
  type SceneCamera,
} from "./scene-camera";
export {
  CAD_SCENE_AMBIENT_INTENSITY,
  CAD_SCENE_FILL_LIGHT_INTENSITY,
  CAD_SCENE_FILL_LIGHT_POSITION,
  CAD_SCENE_KEY_LIGHT_INTENSITY,
  CAD_SCENE_KEY_LIGHT_POSITION,
  CadSceneLights,
} from "./scene-lights";
export {
  CAD_SCENE_AXIS_CLEARANCE_MM,
  CAD_SCENE_AXIS_LENGTH_MM,
  CAD_SCENE_AXIS_X_COLOR,
  CAD_SCENE_AXIS_Y_COLOR,
  CAD_SCENE_AXIS_Z_COLOR,
  CAD_SCENE_GRID_CENTER_COLOR,
  CAD_SCENE_GRID_COLOR,
  CAD_SCENE_GRID_DROP_MM,
  CAD_SCENE_GRID_DIVISIONS,
  CAD_SCENE_GRID_SIZE_MM,
  CAD_SCENE_ORIGIN_MARKER_COLOR,
  CAD_SCENE_ORIGIN_MARKER_RADIUS_MM,
  CadSceneGround,
  createAxesGeometry,
} from "./scene-ground";
export { useRenderGeometry } from "./use-render-geometry";
