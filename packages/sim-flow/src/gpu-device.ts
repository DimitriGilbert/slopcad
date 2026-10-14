/**
 * The provider's device abstraction (Phase 64a, requirement 3): a NARROW
 * WebGPU surface — adapter/device/queue/buffer/pass — that the WGSL
 * stepper is written against, so the provider is testable headlessly
 * (node, no GPU): a fake device implementing this interface (`./wgsl-fake-device`)
 * validates the whole orchestration (buffer sizing, dispatch ordering,
 * readback framing) while the WGSL shader itself runs only where a real
 * device exists (law S5: the CPU oracle stays the test truth). This
 * module owns the interface and the REAL browser adapter. The wrapper
 * keeps its browser-object plumbing in closure-scoped WeakMaps, so the
 * interface itself carries only the surface a consumer meaningfully
 * sees.
 *
 * `navigator.gpu` is reached ONLY through this seam: the default device
 * source ({@link requestWebGpuDevice}) reads the global guardedly and
 * structurally narrows the browser's WebGPU objects to the minimal
 * subset used here — no DOM types (the package's lib is ESNext only), no
 * `any`, no node APIs, so the module loads anywhere (law S2's package
 * posture). Every byte crossing the seam is an explicit little-endian
 * `Uint8Array` — the deterministic wire form the layout tests pin.
 *
 * The honest capability check (Phase 64a, requirement 2): an absent
 * `navigator.gpu`, a null adapter, or a device request that fails all
 * resolve `undefined` — never a fabricated device. Adapter limits are
 * checked against the WebGPU GUARANTEED minimums (256 compute
 * invocations per workgroup, 65535 workgroups per dimension, 128 MiB
 * storage-buffer bindings — this provider asks for 64/65535/a fraction
 * of the storage size): a compliant adapter that meets the spec's
 * defaults can host every grid this provider accepts (its largest
 * buffer is 9·nx·ny·4 bytes; the 128 MiB default admits ≈ 3.7 M nodes),
 * so the adapter-time check is complete without knowing the scenario's
 * grid, and a sub-default adapter is declined loudly rather than
 * discovered mid-run.
 */

/** The buffer usage classes the provider's buffers need. */
export type WgslBufferUsage =
  "storage" | "uniform" | "copy-source" | "copy-destination";

/** A device buffer handle: sized at creation, opaque thereafter. */
export interface WgslBuffer {
  /** The buffer's byte length (fixed at creation). */
  readonly byteLength: number;
  /** Frees the device memory behind the handle (idempotent on the fake). */
  destroy(): void;
}

/** One storage/uniform binding into a bind group. */
export interface WgslBindGroupEntry {
  /** The WGSL `@group(0) @binding(n)` slot this buffer fills. */
  readonly binding: number;
  readonly buffer: WgslBuffer;
}

/** A materialized bind group (one per buffer-parity variant). */
export interface WgslBindGroup {
  /** The binding slots the group carries, ascending. */
  readonly bindings: readonly number[];
}

/**
 * A compiled compute pipeline for one WGSL entry point. Compilation is
 * async on a real device; the fake resolves immediately. Bind groups
 * are created FROM a pipeline because every pipeline of this provider's
 * single shader derives the same auto layout — the real adapter's
 * `getBindGroupLayout(0)` equivalent, scoped to the entry point's own
 * declared bindings.
 */
export interface WgslComputePipeline {
  /** The pipeline's WGSL entry point name (its trace identity). */
  readonly entryPoint: string;
  /**
   * Creates a bind group over this pipeline's group-0 layout. Entries
   * must cover every binding the entry point's shader path declares.
   */
  createBindGroup(
    entries: readonly WgslBindGroupEntry[],
    label?: string,
  ): WgslBindGroup;
}

/** One recorded compute pass: pipeline/bind-group state plus ordered dispatches. */
export interface WgslComputePass {
  setPipeline(pipeline: WgslComputePipeline): void;
  setBindGroup(index: number, group: WgslBindGroup): void;
  /** Dispatches `workgroups` workgroups of the fixed 64-invocation size. */
  dispatchWorkgroups(workgroups: number): void;
  end(): void;
}

/** A finished, not-yet-submitted command buffer. */
export interface WgslCommandBuffer {
  /** The compute passes recorded into the buffer, in order. */
  readonly passCount: number;
}

/** The command recorder: one compute pass at a time, finished into a buffer. */
export interface WgslCommandEncoder {
  beginComputePass(label?: string): WgslComputePass;
  finish(): WgslCommandBuffer;
}

/** The device's submission queue: ordered writes and submits. */
export interface WgslQueue {
  submit(commands: readonly WgslCommandBuffer[]): void;
  /**
   * Queues a little-endian byte-range write into `buffer` at
   * `offsetBytes`. The buffer must have been created with the
   * copy-destination usage (the spec's validation error otherwise —
   * the fake device enforces the same rule). Writes are ordered with
   * submits on the same queue (the WebGPU guarantee the per-step
   * uniform update relies on).
   */
  writeBuffer(buffer: WgslBuffer, offsetBytes: number, data: Uint8Array): void;
}

/**
 * The narrow device: enough of WebGPU to run the D2Q9 provider and
 * nothing more. `readBuffer` stages-and-maps a FULL buffer copy — the
 * readback framing the orchestration tests pin.
 */
export interface WgslDevice {
  createBuffer(
    byteLength: number,
    usage: readonly WgslBufferUsage[],
    label?: string,
  ): WgslBuffer;
  createComputePipeline(
    wgsl: string,
    entryPoint: string,
    label?: string,
  ): Promise<WgslComputePipeline>;
  createCommandEncoder(label?: string): WgslCommandEncoder;
  readonly queue: WgslQueue;
  /**
   * Reads the whole buffer back as little-endian bytes (copy → staging
   * → map on a real device; a backing-store copy on the fake).
   */
  readBuffer(buffer: WgslBuffer): Promise<Uint8Array>;
  destroy(): void;
}

/**
 * A device source: the feature-detection seam. The default
 * ({@link requestWebGpuDevice}) is the real browser path; hosts and
 * tests inject their own (the fake device, an explicit absence).
 */
export type WgslDeviceSource = () => Promise<WgslDevice | undefined>;

// --- The browser-facing minimal subset (structural, unknown-narrowed) --------

/** The adapter limits the capability check reads. */
interface BrowserGpuAdapterLimits {
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxComputeWorkgroupsPerDimension: number;
  readonly maxStorageBufferBindingSize: number;
}

interface BrowserGpuBuffer {
  readonly size: number;
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}

interface BrowserGpuQueue {
  submit(commands: readonly unknown[]): void;
  writeBuffer(buffer: BrowserGpuBuffer, offset: number, data: Uint8Array): void;
}

/** The opaque layout token a browser pipeline hands back for bind groups. */
interface BrowserGpuBindGroupLayout {
  readonly kind: "bind-group-layout";
}

interface BrowserGpuComputePipeline {
  getBindGroupLayout(index: number): BrowserGpuBindGroupLayout;
}

interface BrowserGpuComputePass {
  setPipeline(pipeline: BrowserGpuComputePipeline): void;
  setBindGroup(index: number, group: unknown): void;
  dispatchWorkgroups(count: number): void;
  end(): void;
}

interface BrowserGpuCommandEncoder {
  beginComputePass(descriptor?: { label?: string }): BrowserGpuComputePass;
  copyBufferToBuffer(
    source: BrowserGpuBuffer,
    sourceOffset: number,
    destination: BrowserGpuBuffer,
    destinationOffset: number,
    size: number,
  ): void;
  finish(): unknown;
}

interface BrowserGpuDevice {
  createBuffer(descriptor: {
    size: number;
    usage: number;
    label?: string;
  }): BrowserGpuBuffer;
  createShaderModule(descriptor: { code: string; label?: string }): unknown;
  createComputePipelineAsync(descriptor: {
    compute: { module: unknown; entryPoint: string };
    /** The spec's required member — `"auto"` derives from the entry point's bindings. */
    layout: "auto";
    label?: string;
  }): Promise<BrowserGpuComputePipeline>;
  createBindGroup(descriptor: {
    layout: BrowserGpuBindGroupLayout;
    entries: readonly {
      binding: number;
      resource: { buffer: BrowserGpuBuffer };
    }[];
    label?: string;
  }): unknown;
  createCommandEncoder(descriptor?: {
    label?: string;
  }): BrowserGpuCommandEncoder;
  readonly queue: BrowserGpuQueue;
  destroy(): void;
}

interface BrowserGpuAdapter {
  readonly limits: BrowserGpuAdapterLimits;
  requestDevice(): Promise<BrowserGpuDevice | null>;
}

interface BrowserGpu {
  requestAdapter(): Promise<BrowserGpuAdapter | null>;
}

/** Reads `navigator.gpu` guardedly — `undefined` wherever it does not exist. */
function readNavigatorGpu(): unknown {
  const navigatorMaybe = (globalThis as { readonly navigator?: unknown })
    .navigator;
  if (
    typeof navigatorMaybe !== "object" ||
    navigatorMaybe === null ||
    !("gpu" in navigatorMaybe)
  ) {
    return undefined;
  }
  return (navigatorMaybe as { readonly gpu?: unknown }).gpu;
}

/** Structural narrowing of the global to the WebGPU subset used here. */
function isBrowserGpu(value: unknown): value is BrowserGpu {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { requestAdapter?: unknown };
  return typeof candidate.requestAdapter === "function";
}

/** Structural narrowing of an adapter (limits present and numeric). */
function isBrowserGpuAdapter(value: unknown): value is BrowserGpuAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { limits?: unknown; requestDevice?: unknown };
  if (typeof candidate.requestDevice !== "function") return false;
  const limits = candidate.limits;
  if (typeof limits !== "object" || limits === null) return false;
  const values = limits as Record<string, unknown>;
  return (
    typeof values.maxComputeInvocationsPerWorkgroup === "number" &&
    typeof values.maxComputeWorkgroupsPerDimension === "number" &&
    typeof values.maxStorageBufferBindingSize === "number"
  );
}

/** GPUBufferUsage bits (the WebGPU spec's fixed values). */
const GPU_BUFFER_USAGE = {
  mapRead: 0x0001,
  copySource: 0x0004,
  copyDestination: 0x0008,
  uniform: 0x0040,
  storage: 0x0080,
} as const;

/** GPUMapMode.READ. */
const GPU_MAP_MODE_READ = 0x0001;

/** The minimum adapter limits this provider demands (all spec defaults). */
const REQUIRED_LIMITS = {
  maxComputeInvocationsPerWorkgroup: 64,
  maxComputeWorkgroupsPerDimension: 65535,
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
} as const;

function usageFlags(usage: readonly WgslBufferUsage[]): number {
  let flags = 0;
  for (const entry of usage) {
    if (entry === "storage") flags |= GPU_BUFFER_USAGE.storage;
    else if (entry === "uniform") flags |= GPU_BUFFER_USAGE.uniform;
    else if (entry === "copy-source") flags |= GPU_BUFFER_USAGE.copySource;
    else flags |= GPU_BUFFER_USAGE.copyDestination;
  }
  return flags;
}

/** Wraps one browser device as the narrow {@link WgslDevice}. */
function wrapBrowserDevice(device: BrowserGpuDevice): WgslDevice {
  // Wrapper-internal side tables: every public handle resolves back to
  // its browser object through these, so the narrow interface stays
  // free of browser plumbing.
  const buffers = new WeakMap<WgslBuffer, BrowserGpuBuffer>();
  const pipelines = new WeakMap<
    WgslComputePipeline,
    BrowserGpuComputePipeline
  >();
  const groups = new WeakMap<WgslBindGroup, unknown>();
  const commands = new WeakMap<WgslCommandBuffer, unknown>();
  const live = (buffer: WgslBuffer): BrowserGpuBuffer => {
    const backing = buffers.get(buffer);
    if (backing === undefined) {
      throw new Error(
        "The WGSL provider received a buffer from a foreign device wrapper.",
      );
    }
    return backing;
  };
  return {
    createBuffer: (byteLength, usage, label) => {
      const backing = device.createBuffer({
        size: byteLength,
        usage: usageFlags(usage),
        ...(label === undefined ? {} : { label }),
      });
      const handle: WgslBuffer = {
        byteLength,
        destroy: () => void backing.destroy(),
      };
      buffers.set(handle, backing);
      return handle;
    },
    createComputePipeline: async (wgsl, entryPoint, label) => {
      const module = device.createShaderModule({
        code: wgsl,
        ...(label === undefined ? {} : { label }),
      });
      // `layout: "auto"` is REQUIRED pipeline-descriptor state in current
      // WebGPU (the Phase 64b spike's first finding: without it a real
      // device throws "Failed to read the 'layout' property … Required
      // member is undefined" — the fake device cannot catch IDL-level
      // refusals). The auto layout is exactly what the wrapper reflects
      // through getBindGroupLayout(0) below.
      const backingPipeline = await device.createComputePipelineAsync({
        compute: { module, entryPoint },
        layout: "auto",
        ...(label === undefined ? {} : { label }),
      });
      const layout = backingPipeline.getBindGroupLayout(0);
      const pipeline: WgslComputePipeline = {
        entryPoint,
        createBindGroup: (entries, groupLabel) => {
          const group = device.createBindGroup({
            layout,
            entries: entries.map((entry) => ({
              binding: entry.binding,
              resource: { buffer: live(entry.buffer) },
            })),
            ...(groupLabel === undefined ? {} : { label: groupLabel }),
          });
          const handle: WgslBindGroup = {
            bindings: entries.map((entry) => entry.binding),
          };
          groups.set(handle, group);
          return handle;
        },
      };
      pipelines.set(pipeline, backingPipeline);
      return pipeline;
    },
    createCommandEncoder: (label) => {
      const encoder = device.createCommandEncoder(
        label === undefined ? undefined : { label },
      );
      let passCount = 0;
      return {
        beginComputePass: (passLabel) => {
          const pass = encoder.beginComputePass(
            passLabel === undefined ? undefined : { label: passLabel },
          );
          let pipeline: BrowserGpuComputePipeline | undefined;
          passCount += 1;
          return {
            setPipeline: (next) => {
              const backing = pipelines.get(next);
              if (backing === undefined) {
                throw new Error(
                  "The WGSL provider received a pipeline from a foreign device wrapper.",
                );
              }
              pipeline = backing;
              pass.setPipeline(backing);
            },
            setBindGroup: (index, group) => {
              pass.setBindGroup(index, groups.get(group));
            },
            dispatchWorkgroups: (count) => {
              if (pipeline === undefined) {
                throw new Error(
                  "A compute pass dispatched before its setPipeline — the provider records pipeline state first.",
                );
              }
              pass.dispatchWorkgroups(count);
            },
            end: () => void pass.end(),
          };
        },
        finish: () => {
          const backingCommand = encoder.finish();
          const handle: WgslCommandBuffer = { passCount };
          commands.set(handle, backingCommand);
          return handle;
        },
      };
    },
    get queue(): WgslQueue {
      return {
        submit: (submitted) =>
          device.queue.submit(
            submitted.map((command) => commands.get(command)),
          ),
        writeBuffer: (buffer, offsetBytes, data) =>
          device.queue.writeBuffer(live(buffer), offsetBytes, data),
      };
    },
    readBuffer: async (buffer) => {
      const source = live(buffer);
      const staging = device.createBuffer({
        size: source.size,
        usage: GPU_BUFFER_USAGE.mapRead | GPU_BUFFER_USAGE.copyDestination,
        label: "readback-staging",
      });
      const encoder = device.createCommandEncoder({ label: "readback-copy" });
      encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPU_MAP_MODE_READ);
      const mapped = staging.getMappedRange();
      const bytes = new Uint8Array(mapped.slice(0, mapped.byteLength));
      staging.unmap();
      staging.destroy();
      return bytes;
    },
    destroy: () => void device.destroy(),
  };
}

/**
 * The real device source (feature detection): `navigator.gpu` → adapter
 * (null → absent) → the guaranteed-minimum limits check → device
 * (null/throw → absent). Every absent path resolves `undefined` — the
 * honest decline the engine router turns into the documented CPU
 * fallback.
 */
export async function requestWebGpuDevice(): Promise<WgslDevice | undefined> {
  const gpu = readNavigatorGpu();
  if (!isBrowserGpu(gpu)) return undefined;
  const adapter = await gpu.requestAdapter();
  if (adapter === null || !isBrowserGpuAdapter(adapter)) return undefined;
  const { limits } = adapter;
  if (
    limits.maxComputeInvocationsPerWorkgroup <
      REQUIRED_LIMITS.maxComputeInvocationsPerWorkgroup ||
    limits.maxComputeWorkgroupsPerDimension <
      REQUIRED_LIMITS.maxComputeWorkgroupsPerDimension ||
    limits.maxStorageBufferBindingSize <
      REQUIRED_LIMITS.maxStorageBufferBindingSize
  ) {
    return undefined;
  }
  let device: BrowserGpuDevice | null;
  try {
    device = await adapter.requestDevice();
  } catch {
    return undefined;
  }
  if (device === null) return undefined;
  return wrapBrowserDevice(device);
}
