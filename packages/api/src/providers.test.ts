/**
 * The provider-id single source (PLAN-AGENT-CHAT D6): pins the canonical
 * five — content and order — and proves the derivations stay derived. The
 * model-catalog router's accepted-provider list must equal the shared
 * list, so an independent literal set reintroduced anywhere downstream of
 * `../providers` fails here rather than drifting silently.
 */

import { describe, expect, it } from "vitest";

import {
  NAMED_PROVIDER_IDS,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  PROVIDER_IDS,
} from "./providers";
import { CATALOG_PROVIDERS } from "./routers/model-catalog";

describe("provider-id single source", () => {
  it("is exactly the five canonical ids in the fixed order", () => {
    expect([...PROVIDER_IDS]).toEqual([
      "openai",
      "anthropic",
      "google",
      "openrouter",
      "openai-compatible",
    ]);
  });

  it("splits the named catalog providers from the BYO-endpoint one", () => {
    expect([...NAMED_PROVIDER_IDS]).toEqual([
      "openai",
      "anthropic",
      "google",
      "openrouter",
    ]);
    expect(PROVIDER_IDS.at(-1)).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
  });

  it("derives the model-catalog's accepted providers with no literals of its own", () => {
    expect([...CATALOG_PROVIDERS]).toEqual([...PROVIDER_IDS]);
  });
});
