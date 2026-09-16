/**
 * `useCadModel` (Phase 14): the React-facing authoring surface over the
 * composable model API. Returns the transaction builders' apply paths bound
 * to the store's session commit, so a component can author primitives
 * (parameter assignments + feature records) and have them land as exactly
 * one atomic, replayable Phase 7 transaction each.
 *
 * The hook subscribes to NOTHING: it is a pure authoring/mutation surface
 * (stable function identities), so authoring components re-render only
 * through their own state or the other hooks they choose to pair with. The
 * built transactions are plain {@link CadTransaction} data — inspect,
 * serialize, and replay them like any other command log.
 */

import type { CadSession, FeatureId, ParseResult, TransactionError } from "@slopcad/cad-core";
import type { CadStore } from "./store";

import {
  createPrimitiveTransaction,
  removeFeatureTransaction,
  updatePrimitiveTransaction,
  type PrimitiveAuthoring,
} from "./model";
import { useCadStore } from "./provider";

/** What {@link useCadModel} exposes. */
export interface CadModelApi {
  /**
   * Applies any transaction (typically one built by the model factories)
   * through the session commit. On failure the document is untouched.
   */
  readonly apply: CadStore["applyTransaction"];
  /**
   * Authors a primitive: commits its parameter assignments and its
   * `feature.create` as one atomic transaction.
   */
  readonly createPrimitive: (
    primitive: PrimitiveAuthoring,
  ) => ParseResult<CadSession, TransactionError>;
  /**
   * Authors a primitive update: commits its parameter assignments and its
   * `feature.update` as one atomic transaction.
   */
  readonly updatePrimitive: (
    primitive: PrimitiveAuthoring,
  ) => ParseResult<CadSession, TransactionError>;
  /** Removes a feature (and only the feature — outputs are domain data). */
  readonly removeFeature: (
    id: FeatureId,
  ) => ParseResult<CadSession, TransactionError>;
}

/** The authoring/mutation surface bound to the store's session commit. */
export function useCadModel(): CadModelApi {
  const store = useCadStore("useCadModel");
  return {
    apply: store.applyTransaction,
    createPrimitive: (primitive) =>
      store.applyTransaction(createPrimitiveTransaction(primitive)),
    updatePrimitive: (primitive) =>
      store.applyTransaction(updatePrimitiveTransaction(primitive)),
    removeFeature: (id) => store.applyTransaction(removeFeatureTransaction(id)),
  };
}
