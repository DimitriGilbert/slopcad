/**
 * The scenario-snapshot hash (the §7.11 completeness ruling): every run
 * records a stable content hash of the scenario record AT RUN TIME — the
 * honest provenance the Phase 63 run-comparison surface keys on. Two runs
 * of the identical scenario carry the identical hash; any authored change
 * to the record changes it.
 *
 * The hash reuses the repo's content-hash precedent — the djb2
 * change-detector over serialized bytes from
 * `packages/cad-core/src/interference-report-export.ts`
 * (`interferenceSnapshotDigest`): a machine-facing stability stamp
 * (identical scenarios → identical digests), explicitly NOT a
 * cryptographic hash, stated the same way here. Stability, not
 * collision-resistance, is the contract.
 *
 * Determinism discipline: the hash runs over a CANONICAL JSON rendering
 * (recursively sorted object keys), so the same scenario content hashes
 * identically regardless of key insertion order at the boundary.
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimParseResult, simFail, simOk } from "./result";

/**
 * Canonicalizes JSON-safe content to a deterministic string: object keys
 * recursively sorted, arrays preserved in order, numbers rendered by
 * JSON's own number formatting. Non-finite numbers refuse structurally
 * (they cannot canonically serialize) as do undefined-within-array and
 * function/symbol leaves.
 */
export function canonicalSimJson(
  input: unknown,
): SimParseResult<string, SimError> {
  switch (typeof input) {
    case "string":
      return simOk(JSON.stringify(input));
    case "boolean":
      return simOk(input ? "true" : "false");
    case "number":
      if (!Number.isFinite(input)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.snapshotInvalid,
            "A snapshot's content must be JSON-safe; non-finite numbers cannot be canonicalized.",
            input,
          ),
        );
      }
      return simOk(JSON.stringify(input));
    case "object": {
      if (input === null) return simOk("null");
      if (Array.isArray(input)) {
        const parts: string[] = [];
        for (const entry of input) {
          if (entry === undefined) {
            return simFail(
              simError(
                SIM_ERROR_CODES.snapshotInvalid,
                "A snapshot's arrays must not carry undefined entries.",
                input,
              ),
            );
          }
          const canonical = canonicalSimJson(entry);
          if (!canonical.ok) return canonical;
          parts.push(canonical.value);
        }
        return simOk(`[${parts.join(",")}]`);
      }
      const record = input as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const value = record[key];
        if (value === undefined) continue;
        const canonical = canonicalSimJson(value);
        if (!canonical.ok) return canonical;
        parts.push(`${JSON.stringify(key)}:${canonical.value}`);
      }
      return simOk(`{${parts.join(",")}}`);
    }
    default:
      return simFail(
        simError(
          SIM_ERROR_CODES.snapshotInvalid,
          "A snapshot's content must be JSON-safe data, never a function or symbol.",
          input,
        ),
      );
  }
}

/**
 * The djb2 change-detector over the canonical serialization — the
 * interference-report-export precedent, verbatim in spirit and algorithm:
 * identical content → identical 8-hex-digit digest, explicitly not
 * cryptographic.
 */
export function simScenarioSnapshotHash(
  serializedScenario: unknown,
): SimParseResult<string, SimError> {
  const canonical = canonicalSimJson(serializedScenario);
  if (!canonical.ok) return canonical;
  let hash = 5381;
  for (let index = 0; index < canonical.value.length; index += 1) {
    hash = ((hash * 33) ^ canonical.value.charCodeAt(index)) >>> 0;
  }
  return simOk(hash.toString(16).padStart(8, "0"));
}
