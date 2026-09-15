/**
 * Opaque kernel-solid handles.
 *
 * A {@link KernelSolid} is the contract's only currency for geometry: every
 * kernel operation returns one and accepts only ones it produced. Consumers
 * can hold, compare by identity, and pass handles back to kernel operations —
 * nothing else. Opacity is enforced twice:
 *
 * - Statically, the interface's only property is keyed by a module-private
 *   `unique symbol` that is never exported, so consumers of geometry cannot
 *   name the brand, construct a value of the type, or read anything
 *   off it (there is nothing to read) — the only sanctioned constructor is
 *   {@link createSolidTag}, the documented mint for kernel adapters in
 *   separate packages (non-implementers get no construction path at all).
 * - At runtime, the geometry payload never touches the handle object: it
 *   lives in a per-tag {@link WeakMap} keyed by handle identity. Forging a
 *   look-alike object yields a handle whose payload lookup fails, which
 *   kernels report as `kernel/solid-not-owned`; introspection is impossible
 *   because the frozen handle object carries no enumerable state at all.
 *
 * Ownership is per kernel *instance*: each kernel instance creates its own
 * {@link SolidTag} (see {@link createSolidTag}), so a handle from one
 * instance is rejected by another, and handles from different kernels (the
 * fake kernel and the Phase 9 Manifold adapter) can never be mixed. Kernels
 * with garbage-collected payloads (like the fake) need no disposal of the
 * payload; WASM-backed kernels free theirs in `dispose`.
 *
 * {@link createSolidTag} is implementer infrastructure — it exists for
 * kernel adapters (this package's fake kernel and later adapter packages),
 * not for consumers of geometry. Import it from `@slopcad/cad-kernel/opaque`.
 */

const SOLID_BRAND = Symbol("slopcad.cad-kernel/KernelSolid");

/**
 * An opaque handle to a solid owned by the kernel instance that created it.
 * The brand property is unreadable data whose type is `unknown` and whose
 * key never leaves this module.
 */
export interface KernelSolid {
  readonly [SOLID_BRAND]: unknown;
}

/**
 * The ownership-scoped payload accessors of one kernel instance. `wrap`
 * mints handles, `owns` tests ownership, and `unwrap` returns the payload
 * only for handles this tag created (`undefined` otherwise, including for
 * handles of other kernels or forged objects).
 */
export interface SolidTag<Payload> {
  wrap(payload: Payload): KernelSolid;
  owns(solid: KernelSolid): boolean;
  unwrap(solid: KernelSolid): Payload | undefined;
}

/** Creates a private payload store for one kernel instance's solid handles. */
export function createSolidTag<Payload>(): SolidTag<Payload> {
  const payloads = new WeakMap<KernelSolid, Payload>();
  return {
    wrap(payload: Payload): KernelSolid {
      const solid: KernelSolid = { [SOLID_BRAND]: null };
      Object.freeze(solid);
      payloads.set(solid, payload);
      return solid;
    },
    owns(solid: KernelSolid): boolean {
      return payloads.has(solid);
    },
    unwrap(solid: KernelSolid): Payload | undefined {
      return payloads.get(solid);
    },
  };
}
