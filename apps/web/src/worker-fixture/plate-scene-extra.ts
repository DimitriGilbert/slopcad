/**
 * The scene request/measurement re-exports the fixture sessions consume,
 * collected so the render assembly and the session share one import point
 * (the extrude, revolve, and hole requests live beside the plate
 * measurement they measure like).
 */
export type { ExtrudeSceneRequest } from "./extrude-scene";
export type { RevolveSceneRequest } from "./revolve-scene";
export type { HoleSceneRequest, HoleCutInput } from "./hole-scene";
export type { PlateMeasurement } from "./plate-scene";
export { computeExtrudeScene } from "./extrude-scene";
export { computeRevolveScene } from "./revolve-scene";
export { computeHoleScene } from "./hole-scene";
