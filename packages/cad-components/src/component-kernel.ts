/**
 * The component execution surface (Phase 32): the async kernel contract
 * components build through, plus the direct adapter that runs a component
 * against a plain {@link GeometryKernel}.
 *
 * Components never touch a concrete kernel backend. They build through
 * {@link ComponentKernel} — an async mirror of the kernel-neutral geometry
 * contract (`@slopcad/cad-kernel`'s public `GeometryKernel`) — so the SAME
 * component code runs:
 *
 * - directly against any conforming kernel in tests and Node
 *   (`directComponentKernel`, below), and
 * - over the worker protocol in a browser (`createContextKernel` in
 *   `./context-kernel`, which routes every call onto the versioned
 *   `solid.*` operation vocabulary a real kernel worker hosts).
 *
 * Errors stay structured end to end: kernel contract failures keep their
 * `kernel/*` codes verbatim; the worker-context adapter additionally
 * reports protocol-level failures (transport, cancellation) under their
 * `worker/*` codes rather than throwing, so a component build can always
 * answer with one structured failure shape.
 */

import type {
  BoxInput,
  ChamferInput,
  ConeInput,
  CylinderInput,
  FilletInput,
  GeometryKernel,
  KernelBounds,
  KernelCapabilities,
  KernelSolid,
  MirrorInput,
  MirrorPlaneAxis,
  ProfileExtrudeInput,
  ProfileLoftInput,
  ProfileRevolveInput,
  ProfileSweepInput,
  SectionInput,
  SectionResult,
  ShellInput,
  SphereInput,
  Tessellation,
  TransformInput,
} from "@slopcad/cad-kernel";
import type { ParseFailure, ParseResult } from "@slopcad/cad-core";

/** Structured failure of one component-kernel call. */
export interface ComponentKernelError extends ParseFailure {
  /**
   * The failure code: the underlying kernel contract's `kernel/*` code
   * where the kernel refused, or the protocol's `worker/*` code where the
   * channel itself failed.
   */
  readonly code: string;
}

/** The result shape of one component-kernel call. */
export type ComponentKernelResult<T> = ParseResult<T, ComponentKernelError>;

/**
 * The async geometry surface components build through: the kernel-neutral
 * contract's operation set, promise-carried so a component can run either
 * against an in-process kernel or across a worker channel. Semantics are
 * EXACTLY the `GeometryKernel` contract's (placement conventions, solid
 * semantics, structured failure codes) — this surface adds no rules, it
 * only carries the calls.
 */
export interface ComponentKernel {
  /** The executing kernel's declared capabilities, verbatim. */
  readonly capabilities: KernelCapabilities;

  createBox(input: BoxInput): Promise<ComponentKernelResult<KernelSolid>>;
  createSphere(input: SphereInput): Promise<ComponentKernelResult<KernelSolid>>;
  createCylinder(
    input: CylinderInput,
  ): Promise<ComponentKernelResult<KernelSolid>>;
  createCone(input: ConeInput): Promise<ComponentKernelResult<KernelSolid>>;
  extrude(
    input: ProfileExtrudeInput,
  ): Promise<ComponentKernelResult<KernelSolid>>;
  revolve(
    input: ProfileRevolveInput,
  ): Promise<ComponentKernelResult<KernelSolid>>;
  sweep(input: ProfileSweepInput): Promise<ComponentKernelResult<KernelSolid>>;
  loft(input: ProfileLoftInput): Promise<ComponentKernelResult<KernelSolid>>;
  fillet(input: FilletInput): Promise<ComponentKernelResult<KernelSolid>>;
  chamfer(input: ChamferInput): Promise<ComponentKernelResult<KernelSolid>>;
  shell(input: ShellInput): Promise<ComponentKernelResult<KernelSolid>>;
  mirror(
    solid: KernelSolid,
    input: MirrorInput,
  ): Promise<ComponentKernelResult<KernelSolid>>;
  union(
    operands: readonly KernelSolid[],
  ): Promise<ComponentKernelResult<KernelSolid>>;
  subtract(
    target: KernelSolid,
    tools: readonly KernelSolid[],
  ): Promise<ComponentKernelResult<KernelSolid>>;
  intersect(
    operands: readonly KernelSolid[],
  ): Promise<ComponentKernelResult<KernelSolid>>;
  transform(
    solid: KernelSolid,
    input: TransformInput,
  ): Promise<ComponentKernelResult<KernelSolid>>;
  bounds(solid: KernelSolid): Promise<ComponentKernelResult<KernelBounds>>;
  volume(solid: KernelSolid): Promise<ComponentKernelResult<number>>;
  area(solid: KernelSolid): Promise<ComponentKernelResult<number>>;
  /**
   * The Phase 46 plane cut: the cut solid plus the cross-section face's
   * measurements, the contract op's compound result verbatim.
   */
  section(input: SectionInput): Promise<ComponentKernelResult<SectionResult>>;
  tessellate(solid: KernelSolid): Promise<ComponentKernelResult<Tessellation>>;
  dispose(solid: KernelSolid): Promise<void>;
}

export type {
  BoxInput,
  ChamferInput,
  ConeInput,
  CylinderInput,
  FilletInput,
  MirrorInput,
  MirrorPlaneAxis,
  ProfileExtrudeInput,
  ProfileRevolveInput,
  SectionInput,
  SectionResult,
  ShellInput,
  SphereInput,
  TransformInput,
};

/**
 * Runs a component against an in-process {@link GeometryKernel}: every
 * component-kernel call delegates to the kernel's contract method and
 * keeps its structured result verbatim (the kernel's `KernelError` is a
 * `ComponentKernelError`). The sync contract results ride `Promise.resolve`
 * onto the async surface — the same bytes a browser session computes,
 * without the worker.
 */
export function directComponentKernel(kernel: GeometryKernel): ComponentKernel {
  return {
    capabilities: kernel.capabilities,

    createBox: (input) => Promise.resolve(kernel.createBox(input)),
    createSphere: (input) => Promise.resolve(kernel.createSphere(input)),
    createCylinder: (input) => Promise.resolve(kernel.createCylinder(input)),
    createCone: (input) => Promise.resolve(kernel.createCone(input)),
    extrude: (input) => Promise.resolve(kernel.extrude(input)),
    revolve: (input) => Promise.resolve(kernel.revolve(input)),
    sweep: (input) => Promise.resolve(kernel.sweep(input)),
    loft: (input) => Promise.resolve(kernel.loft(input)),
    fillet: (input) => Promise.resolve(kernel.fillet(input)),
    chamfer: (input) => Promise.resolve(kernel.chamfer(input)),
    shell: (input) => Promise.resolve(kernel.shell(input)),
    mirror: (solid, input) => Promise.resolve(kernel.mirror(solid, input)),
    union: (operands) => Promise.resolve(kernel.union(operands)),
    subtract: (target, tools) =>
      Promise.resolve(kernel.subtract(target, tools)),
    intersect: (operands) => Promise.resolve(kernel.intersect(operands)),
    transform: (solid, input) =>
      Promise.resolve(kernel.transform(solid, input)),
    bounds: (solid) => Promise.resolve(kernel.bounds(solid)),
    volume: (solid) => Promise.resolve(kernel.volume(solid)),
    area: (solid) => Promise.resolve(kernel.area(solid)),
    section: (input) => Promise.resolve(kernel.section(input)),
    tessellate: (solid) => Promise.resolve(kernel.tessellate(solid)),
    dispose: (solid) => {
      kernel.dispose(solid);
      return Promise.resolve();
    },
  };
}
