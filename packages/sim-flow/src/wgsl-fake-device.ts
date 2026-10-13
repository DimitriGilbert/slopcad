/**
 * The node-side fake device (Phase 64a, requirement 3): a
 * deterministic in-memory implementation of the {@link WgslDevice}
 * seam the WGSL stepper is written against. It executes NO shader —
 * the WGSL itself runs only where a real device exists (law S5) —
 * but it owns real backing bytes and a real operation TRACE, so the
 * whole orchestration layer is testable headlessly: buffer sizing,
 * write placement, dispatch ordering and counts, bind-group parity,
 * submission framing, and readback round-trips.
 *
 * The trace is plain data (JSON-comparable), built in fixed order,
 * with no clock and no randomness: two orchestrations that agree
 * produce identical traces — the determinism pin. Destructive misuse
 * (dispatch before pipeline, writes past a buffer's end, writes to a
 * buffer without copy-destination usage, use after destroy) throws
 * honestly rather than degrading silently — the fake is an assertion
 * surface, not a stub.
 */

import type {
  WgslBindGroup,
  WgslBindGroupEntry,
  WgslBuffer,
  WgslBufferUsage,
  WgslCommandBuffer,
  WgslCommandEncoder,
  WgslComputePass,
  WgslComputePipeline,
  WgslDevice,
  WgslQueue,
} from "./gpu-device";

/** One recorded dispatch: pass ordinal, pipeline, workgroups, bindings. */
export interface WgslFakeDispatch {
  /** The device-wide pass ordinal (0-based, creation order). */
  readonly pass: number;
  /** The dispatched pipeline's entry point. */
  readonly entryPoint: string;
  /** The dispatched workgroup count. */
  readonly workgroups: number;
  /** The active bind group's buffer ordinal per binding slot, ascending. */
  readonly groupBuffers: readonly (readonly number[])[];
}

/** One recorded queue write. */
export interface WgslFakeWrite {
  /** The written buffer's ordinal. */
  readonly buffer: number;
  readonly offsetBytes: number;
  readonly byteLength: number;
}

/** One recorded buffer (creation order is the buffer's ordinal). */
export interface WgslFakeBufferInfo {
  readonly ordinal: number;
  readonly byteLength: number;
  readonly usage: readonly WgslBufferUsage[];
  readonly label: string;
}

/** One recorded compute pipeline. */
export interface WgslFakePipelineInfo {
  readonly entryPoint: string;
  /** The shader source length — pipeline identity beyond the entry point. */
  readonly wgslLength: number;
  readonly label: string;
}

/** One recorded command-buffer submission. */
export interface WgslFakeSubmission {
  readonly passes: number;
}

/** The fake's full operation trace (plain data, determinism-comparable). */
export interface WgslFakeTrace {
  readonly buffers: readonly WgslFakeBufferInfo[];
  readonly pipelines: readonly WgslFakePipelineInfo[];
  readonly writes: readonly WgslFakeWrite[];
  readonly dispatches: readonly WgslFakeDispatch[];
  readonly submissions: readonly WgslFakeSubmission[];
}

/** The fake device: the seam plus trace access for assertions. */
export interface WgslFakeDevice extends WgslDevice {
  readonly trace: WgslFakeTrace;
  /** The buffer handle by creation ordinal. */
  bufferByOrdinal(ordinal: number): WgslBuffer | undefined;
  /** The buffer handle by its creation label. */
  bufferByLabel(label: string): WgslBuffer | undefined;
}

/** Creates the fake device. */
export function createWgslFakeDevice(): WgslFakeDevice {
  interface Backing {
    readonly ordinal: number;
    readonly label: string;
    readonly usage: readonly WgslBufferUsage[];
    bytes: Uint8Array;
    destroyed: boolean;
  }
  const handles: WgslBuffer[] = [];
  const backings = new Map<WgslBuffer, Backing>();
  const groupEntries = new WeakMap<
    WgslBindGroup,
    readonly { readonly binding: number; readonly bufferOrdinal: number }[]
  >();
  const bufferInfos: WgslFakeBufferInfo[] = [];
  const pipelineInfos: WgslFakePipelineInfo[] = [];
  const writes: WgslFakeWrite[] = [];
  const dispatches: WgslFakeDispatch[] = [];
  const submissions: WgslFakeSubmission[] = [];
  let destroyed = false;
  let passOrdinal = 0;

  const live = (buffer: WgslBuffer, what: string): Backing => {
    const backing = backings.get(buffer);
    if (backing === undefined) {
      throw new Error(
        `${what} referenced a buffer this fake device did not create.`,
      );
    }
    if (destroyed || backing.destroyed) {
      throw new Error(
        `${what} referenced the destroyed buffer "${backing.label}".`,
      );
    }
    return backing;
  };

  return {
    get trace() {
      return {
        buffers: bufferInfos,
        pipelines: pipelineInfos,
        writes,
        dispatches,
        submissions,
      };
    },
    bufferByOrdinal: (ordinal) => handles[ordinal],
    bufferByLabel: (label) => {
      const found = handles.find(
        (handle) => backings.get(handle)?.label === label,
      );
      return found === undefined ? undefined : found;
    },
    createBuffer: (byteLength, usage, label) => {
      if (destroyed) {
        throw new Error("A destroyed device creates no buffers.");
      }
      if (!Number.isInteger(byteLength) || byteLength <= 0) {
        throw new Error(
          `A buffer needs a positive integer byte length, received ${String(byteLength)}.`,
        );
      }
      const ordinal = bufferInfos.length;
      const backing: Backing = {
        ordinal,
        label: label ?? `buffer-${String(ordinal)}`,
        usage: [...usage],
        bytes: new Uint8Array(byteLength),
        destroyed: false,
      };
      bufferInfos.push({
        ordinal,
        byteLength,
        usage: backing.usage,
        label: backing.label,
      });
      const handle: WgslBuffer = {
        byteLength,
        destroy: () => {
          backing.destroyed = true;
        },
      };
      handles.push(handle);
      backings.set(handle, backing);
      return handle;
    },
    createComputePipeline: (wgsl, entryPoint, label) => {
      const resolvedLabel = label ?? entryPoint;
      const pipeline: WgslComputePipeline = {
        entryPoint,
        createBindGroup: (entries: readonly WgslBindGroupEntry[]) => {
          const mapped = entries.map((entry) => ({
            binding: entry.binding,
            bufferOrdinal: live(entry.buffer, "A bind group").ordinal,
          }));
          const group: WgslBindGroup = {
            bindings: entries.map((entry) => entry.binding),
          };
          groupEntries.set(group, mapped);
          return group;
        },
      };
      pipelineInfos.push({
        entryPoint,
        wgslLength: wgsl.length,
        label: resolvedLabel,
      });
      return Promise.resolve(pipeline);
    },
    createCommandEncoder: () => {
      let passCount = 0;
      const encoder: WgslCommandEncoder = {
        beginComputePass: () => {
          let pipeline: WgslComputePipeline | undefined;
          let group: WgslBindGroup | undefined;
          const pass: WgslComputePass = {
            setPipeline: (next) => {
              pipeline = next;
            },
            setBindGroup: (_index, next) => {
              group = next;
            },
            dispatchWorkgroups: (workgroups) => {
              if (pipeline === undefined) {
                throw new Error(
                  "A compute pass dispatched before its setPipeline — the provider records pipeline state first.",
                );
              }
              if (group === undefined) {
                throw new Error(
                  "A compute pass dispatched before its setBindGroup — the provider records bind-group state first.",
                );
              }
              const entries = groupEntries.get(group);
              if (entries === undefined) {
                throw new Error(
                  "A dispatch carried a bind group from a foreign device.",
                );
              }
              const byBinding = new Map<number, number>();
              for (const entry of entries) {
                byBinding.set(entry.binding, entry.bufferOrdinal);
              }
              dispatches.push({
                pass: passOrdinal,
                entryPoint: pipeline.entryPoint,
                workgroups,
                groupBuffers: [...byBinding.keys()]
                  .sort((a, b) => a - b)
                  .map((binding) => [byBinding.get(binding) as number]),
              });
            },
            end: () => {
              passCount += 1;
              passOrdinal += 1;
              pipeline = undefined;
              group = undefined;
            },
          };
          return pass;
        },
        finish: (): WgslCommandBuffer => ({ passCount }),
      };
      return encoder;
    },
    get queue(): WgslQueue {
      return {
        submit: (commands) => {
          if (destroyed) {
            throw new Error("A destroyed device submits nothing.");
          }
          let passes = 0;
          for (const command of commands) {
            passes += command.passCount;
          }
          submissions.push({ passes });
        },
        writeBuffer: (buffer, offsetBytes, data) => {
          const backing = live(buffer, "A queue write");
          // The spec's own validation, mirrored: queue.writeBuffer on a
          // buffer without COPY_DST is a WebGPU validation error on a
          // real device (the write never lands, the provider computes
          // nothing) — the fake rejects it too, so a missing usage
          // flag cannot pass headlessly.
          if (!backing.usage.includes("copy-destination")) {
            throw new Error(
              `A queue write targets the buffer "${backing.label}", which was created without copy-destination usage — the WebGPU validation error this fake mirrors (declare the usage at buffer creation).`,
            );
          }
          if (
            !Number.isInteger(offsetBytes) ||
            offsetBytes < 0 ||
            offsetBytes % 4 !== 0
          ) {
            throw new Error(
              `A queue write needs a non-negative 4-aligned byte offset, received ${String(offsetBytes)}.`,
            );
          }
          if (offsetBytes + data.byteLength > backing.bytes.byteLength) {
            throw new Error(
              `A queue write of ${String(data.byteLength)} bytes at ${String(offsetBytes)} overflows the buffer "${backing.label}" (${String(backing.bytes.byteLength)} bytes).`,
            );
          }
          backing.bytes.set(data, offsetBytes);
          writes.push({
            buffer: backing.ordinal,
            offsetBytes,
            byteLength: data.byteLength,
          });
        },
      };
    },
    readBuffer: (buffer) => {
      const backing = live(buffer, "A readback");
      return Promise.resolve(new Uint8Array(backing.bytes));
    },
    destroy: () => {
      destroyed = true;
    },
  };
}
