/**
 * Phase 1.6 architecture spike — NON-PRODUCTION reference code.
 * Main-thread client for the kernel worker: request/response correlation over
 * postMessage with transferable mesh buffers. This file is the transport
 * boundary. See docs/architecture/spike-findings.md.
 */

import type { CadEvalResult, CadRequest, CadResponse } from "./protocol";

type Pending = {
  readonly resolve: (result: CadEvalResult) => void;
  readonly reject: (error: Error) => void;
};

export class CadWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor() {
    this.worker = new Worker(new URL("./cad.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener(
      "message",
      (event: MessageEvent<CadResponse>) => {
        const response = event.data;
        const entry = this.pending.get(response.id);
        if (!entry) {
          return;
        }
        this.pending.delete(response.id);
        if (response.ok) {
          entry.resolve(response.result);
        } else {
          entry.reject(new Error(response.error));
        }
      },
    );
  }

  evaluate(
    parameters: Readonly<Record<string, number>>,
  ): Promise<CadEvalResult> {
    const request: CadRequest = {
      id: this.nextId++,
      kind: "evaluate",
      parameters,
    };
    return new Promise<CadEvalResult>((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request);
    });
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error("cad worker disposed"));
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
