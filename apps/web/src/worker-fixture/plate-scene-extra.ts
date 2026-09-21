/**
 * The scene request/measurement re-exports the fixture sessions consume,
 * collected so the render assembly and the session share one import point
 * (the extrude, revolve, and hole requests live beside the plate
 * measurement they measure like).
 */
export type { ExtrudeSceneRequest } from "./extrude-scene";
export type { RevolveSceneRequest } from "./revolve-scene";
export type { SweepSceneRequest } from "./sweep-scene";
export type { LoftSceneRequest } from "./loft-scene";
export type { HoleSceneRequest, HoleCutInput } from "./hole-scene";
export type { PadSceneRequest } from "./pad-scene";
export type { HelixSceneRequest } from "./helix-scene";
export type { ThreadSceneRequest } from "./thread-scene";
export type { PlateMeasurement } from "./plate-scene";
export { computeExtrudeScene } from "./extrude-scene";
export { computeRevolveScene } from "./revolve-scene";
export { computeSweepScene } from "./sweep-scene";
export { computeLoftScene } from "./loft-scene";
export { computeHoleScene } from "./hole-scene";
export { computePadScene } from "./pad-scene";
export { computeHelixScene } from "./helix-scene";
export { computeThreadScene } from "./thread-scene";
