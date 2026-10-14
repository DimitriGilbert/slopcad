/**
 * The server SimResultStore backend (Phase 61c, law S7): put/list/get over
 * the simulations router's own surface, reached through the INJECTED
 * {@link SimResultServerClient} seam — a tRPC client slice or a
 * `createCallerFactory` caller adapted once by the app layer (NOT_FOUND on
 * `get` mapped to null). sim-core never imports a tRPC runtime; the client
 * is a structural parameter, so this module stays dependency-free and the
 * app's adapter is type-checked against the interface, not the other way
 * around.
 *
 * Every response is re-parsed against the run model on the way out
 * (`./sim-result-store`'s parsers) and every client throw is translated to
 * a structured `sim/store-unavailable` decline carrying the failure's
 * message — a store never fabricates a run to paper over a transport
 * refusal.
 */

import type { SimError } from "./errors";
import type { SimParseResult } from "./result";
import type {
  SimResultRunRecord,
  SimResultServerClient,
  SimResultStore,
  SimStoredResult,
} from "./sim-result-store";

import { simError, SIM_ERROR_CODES } from "./errors";
import {
  decodeSimResultRunWire,
  encodeSimResultPutWireInput,
  parseSimResultRunRecord,
} from "./sim-result-store";

/** What the server backend needs: the injected router-client seam. */
export interface ServerSimResultStoreOptions {
  readonly client: SimResultServerClient;
}

/** Wraps a client call's throw as the structured store-unavailable decline. */
async function callClient<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<SimParseResult<T, SimError>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      error: simError(
        SIM_ERROR_CODES.storeUnavailable,
        `The simulations backend refused ${operation}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      ),
    };
  }
}

/** Builds the server-backed store over the injected router client. */
export function createServerSimResultStore(
  options: ServerSimResultStoreOptions,
): SimResultStore {
  const { client } = options;
  return {
    async put(documentVersionId, result) {
      const wire = encodeSimResultPutWireInput(documentVersionId, result);
      if (!wire.ok) return wire;
      const response = await callClient("a run put", () =>
        client.put(wire.value),
      );
      if (!response.ok) return response;
      return parseSimResultRunRecord(response.value);
    },
    async list(documentVersionId) {
      const response = await callClient("a run list", () =>
        client.list({ documentVersionId }),
      );
      if (!response.ok) return response;
      const records: SimResultRunRecord[] = [];
      for (const entry of response.value) {
        const parsed = parseSimResultRunRecord(entry);
        if (!parsed.ok) return parsed;
        records.push(parsed.value);
      }
      return { ok: true, value: Object.freeze(records) };
    },
    async get(
      runId,
    ): Promise<SimParseResult<SimStoredResult | null, SimError>> {
      const response = await callClient("a run get", () =>
        client.get({ runId }),
      );
      if (!response.ok) return response;
      if (response.value === null) {
        return { ok: true, value: null };
      }
      return decodeSimResultRunWire(response.value);
    },
  };
}
