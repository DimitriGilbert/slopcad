/**
 * Model-catalog tests (agent chat, Phase 1.1): the picker filter against
 * the trimmed models.dev fixture, the refresh state machine
 * (TTL / ETag / force / stale-on-error), and the tRPC router against the
 * ephemeral migrated database (`createInMemoryDb`). Zero network: the
 * transport is injected per test, and the global fetch stays on its
 * throwing test stub.
 *
 * The filter's clock is pinned to the fixture's capture date (recorded
 * inside the fixture), so the expected id lists below are the same
 * deterministic truth every run. They were computed by running the filter
 * over the fixture at implementation time.
 */

import { readFile } from "node:fs/promises";
import { createInMemoryDb } from "@slopcad/db";
import { modelCatalogMeta } from "@slopcad/db/schema/model-catalog";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { router, t } from "../index";
import {
  extractProviderModels,
  filterProviderModels,
  sixMonthsCutoffISO,
} from "./model-catalog-filter";
import { createModelCatalogRouter } from "./model-catalog";

const CATALOG_URL = "https://catalog.test/api.json";
const SESSION_USER_ID = "user-catalog";

const fixtureText = await readFile(
  new URL("./model-catalog.fixture.json", import.meta.url),
  "utf8",
);
const fixture: unknown = JSON.parse(fixtureText);

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringProp(value: unknown, key: string): string {
  if (!isRecordObject(value)) {
    throw new Error("The catalog fixture root must be an object.");
  }
  const prop: unknown = value[key];
  if (typeof prop !== "string" || prop.length === 0) {
    throw new Error(`The catalog fixture is missing its "${key}" string.`);
  }
  return prop;
}

/** The pinned clock: the fixture's own capture date, midnight UTC. */
const PINNED_NOW = new Date(
  `${requireStringProp(fixture, "$captureDate")}T00:00:00.000Z`,
);

/** A model id 25h later — beyond the 24h TTL. */
function beyondTtl(base: Date): Date {
  return new Date(base.getTime() + 25 * 60 * 60 * 1000);
}

/** A model id 23h later — still inside the 24h TTL. */
function withinTtl(base: Date): Date {
  return new Date(base.getTime() + 23 * 60 * 60 * 1000);
}

// Pinned at the capture date (cutoff 2026-04-04), computed from a fixture
// run; ordered release_date desc then model_id asc exactly as served.
const PINNED_OPENAI = [
  "gpt-6-astra",
  "gpt-daybreak-red-latest",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-cutoff-exact-day",
] as const;
const PINNED_ANTHROPIC = [
  "claude-sonnet-5-5",
  "claude-opus-5",
  "claude-opus-4-7",
] as const;
const PINNED_GOOGLE = [
  "gemini-3.8-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash",
] as const;
const PINNED_OPENROUTER = [
  "unbiased/pareto-26.10-preview",
  "meta/muse-spark-1.1",
] as const;

function fixtureIdsFor(provider: string, now: Date = PINNED_NOW): string[] {
  return filterProviderModels(
    provider,
    extractProviderModels(fixture, provider),
    now,
  ).map((entry) => entry.modelId);
}

/** A well-formed models.dev-shaped model entry with overridable fields. */
function syntheticModel(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Synthetic Vision Model",
    release_date: "2026-08-01",
    modalities: { input: ["text", "image"], output: ["text"] },
    ...overrides,
  };
}

function filterSynthetic(
  models: Record<string, unknown>,
  now: Date = PINNED_NOW,
) {
  return filterProviderModels("synthetic", models, now);
}

describe("model catalog filter (fixture)", () => {
  it("computes the six-month cutoff in UTC, rolling over calendar years", () => {
    expect(sixMonthsCutoffISO(PINNED_NOW)).toBe("2026-04-04");
    expect(sixMonthsCutoffISO(new Date("2026-03-15T18:45:00.000Z"))).toBe(
      "2025-09-15",
    );
  });

  it("returns exactly the pinned per-provider id sets at the capture date", () => {
    expect(fixtureIdsFor("openai")).toEqual([...PINNED_OPENAI]);
    expect(fixtureIdsFor("anthropic")).toEqual([...PINNED_ANTHROPIC]);
    expect(fixtureIdsFor("google")).toEqual([...PINNED_GOOGLE]);
    expect(fixtureIdsFor("openrouter")).toEqual([...PINNED_OPENROUTER]);
  });

  it("carries the stored fields through for the surviving rows", () => {
    const entries = filterProviderModels(
      "openai",
      extractProviderModels(fixture, "openai"),
      PINNED_NOW,
    );
    const byId = new Map(entries.map((entry) => [entry.modelId, entry]));

    expect(byId.get("gpt-5.6-terra")).toMatchObject({
      provider: "openai",
      name: "GPT-5.6 Terra",
      releaseDate: "2026-07-09",
      vision: true,
      contextLimit: 400000,
      deprecated: false,
      reasoningOptions: [
        { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
      ],
    });
    // Empty and absent reasoning_options both collapse to null.
    expect(byId.get("gpt-daybreak-red-latest")?.reasoningOptions).toBeNull();
    expect(byId.get("gpt-cutoff-exact-day")?.contextLimit).toBeNull();
    expect(byId.get("gpt-cutoff-exact-day")?.reasoningOptions).toBeNull();
  });

  it("excludes every crafted gotcha: ~ alias, embedding, deprecated, stale, text-only, malformed", () => {
    const allIds = [
      ...fixtureIdsFor("openai"),
      ...fixtureIdsFor("anthropic"),
      ...fixtureIdsFor("google"),
      ...fixtureIdsFor("openrouter"),
    ];
    // The OpenRouter ~-alias never leaks through.
    expect(allIds.some((id) => id.startsWith("~"))).toBe(false);
    // The embedding false-positive (image input, but an embedding family).
    expect(allIds).not.toContain("gemini-embedding-2");
    expect(allIds.some((id) => id.toLowerCase().includes("embedding"))).toBe(
      false,
    );
    // The deprecated-but-recent entry.
    expect(allIds).not.toContain("claude-fable-5-2-preview");
    // Too old by months and too old by a single day.
    expect(allIds).not.toContain("gpt-5.4");
    expect(allIds).not.toContain("gpt-cutoff-early-day");
    // Recent but text+audio only.
    expect(allIds).not.toContain("gpt-daybreak-mini-preview");
    // Malformed (no modalities object).
    expect(allIds).not.toContain("labs/echo-preview");
  });

  it("pins the >= boundary: released exactly on the cutoff stays in", () => {
    // The cutoff at the capture date is 2026-04-04 and that exact day
    // survives while the day before does not.
    expect(sixMonthsCutoffISO(PINNED_NOW)).toBe("2026-04-04");
    expect(fixtureIdsFor("openai")).toContain("gpt-cutoff-exact-day");
    expect(fixtureIdsFor("openai")).not.toContain("gpt-cutoff-early-day");
  });

  it("moves with the clock: three months later the windows have shrunk", () => {
    const later = new Date("2027-01-04T00:00:00.000Z");
    expect(sixMonthsCutoffISO(later)).toBe("2026-07-04");
    expect(fixtureIdsFor("openai", later)).toEqual([
      "gpt-6-astra",
      "gpt-daybreak-red-latest",
      "gpt-5.6-terra",
    ]);
    expect(fixtureIdsFor("anthropic", later)).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5",
    ]);
    expect(fixtureIdsFor("google", later)).toEqual([
      "gemini-3.8-flash",
      "gemini-flash-latest",
    ]);
    expect(fixtureIdsFor("openrouter", later)).toEqual([
      "unbiased/pareto-26.10-preview",
    ]);
  });

  it("treats an unknown provider or unparseable payload as an empty catalog", () => {
    expect(filterProviderModels("openai", undefined, PINNED_NOW)).toEqual([]);
    expect(filterProviderModels("openai", null, PINNED_NOW)).toEqual([]);
    expect(extractProviderModels(fixture, "not-a-provider")).toBeUndefined();
    expect(extractProviderModels("not-json", "openai")).toBeUndefined();
  });
});

describe("model catalog filter (rules in isolation)", () => {
  it("requires image in modalities.input", () => {
    const models = {
      "syn/vision": syntheticModel(),
      "syn/text-only": syntheticModel({
        modalities: { input: ["text"], output: ["text"] },
      }),
      "syn/no-modalities": syntheticModel({ modalities: undefined }),
      "syn/empty-input": syntheticModel({
        modalities: { input: [], output: ["text"] },
      }),
    };
    expect(filterSynthetic(models).map((entry) => entry.modelId)).toEqual([
      "syn/vision",
    ]);
  });

  it("skips malformed entries instead of throwing", () => {
    const models = {
      "syn/not-an-object": "just a string",
      "syn/no-name": syntheticModel({ name: undefined }),
      "syn/bad-date": syntheticModel({ release_date: "Sept 2026" }),
      "syn/loose-date": syntheticModel({ release_date: "2026-8-1" }),
      "syn/fine": syntheticModel(),
    };
    expect(filterSynthetic(models).map((entry) => entry.modelId)).toEqual([
      "syn/fine",
    ]);
  });

  it("excludes embedding models by id, name, or family", () => {
    const models = {
      "syn/by-id-embedding": syntheticModel(),
      "syn/by-name": syntheticModel({ name: "Text Embedding (large)" }),
      "syn/by-family": syntheticModel({ family: "text-embedding-3" }),
      "syn/fine": syntheticModel(),
    };
    expect(filterSynthetic(models).map((entry) => entry.modelId)).toEqual([
      "syn/fine",
    ]);
  });

  it("excludes deprecated status but keeps beta", () => {
    const models = {
      "syn/deprecated": syntheticModel({ status: "deprecated" }),
      "syn/beta": syntheticModel({ status: "beta" }),
    };
    expect(filterSynthetic(models).map((entry) => entry.modelId)).toEqual([
      "syn/beta",
    ]);
  });

  it("strips OpenRouter ~ alias ids", () => {
    const models = {
      "~syn/alias": syntheticModel(),
      "syn/canonical": syntheticModel(),
    };
    expect(filterSynthetic(models).map((entry) => entry.modelId)).toEqual([
      "syn/canonical",
    ]);
  });

  it("keeps only well-formed reasoning options", () => {
    const models = {
      "syn/mixed": syntheticModel({
        reasoning_options: [
          { type: "effort", values: ["low", "high"] },
          { type: "unknown-type" },
          "not an object",
          { type: "budget_tokens", min: 1024 },
          { type: "toggle" },
        ],
      }),
      "syn/dirty-values": syntheticModel({
        reasoning_options: [{ type: "effort", values: ["low", 42, null] }],
      }),
      "syn/all-bad": syntheticModel({
        reasoning_options: [{ type: "nope" }, 7],
      }),
    };
    const byId = new Map(
      filterSynthetic(models).map((entry) => [entry.modelId, entry]),
    );
    expect(byId.get("syn/mixed")?.reasoningOptions).toEqual([
      { type: "effort", values: ["low", "high"] },
      { type: "budget_tokens", min: 1024 },
      { type: "toggle" },
    ]);
    expect(byId.get("syn/dirty-values")?.reasoningOptions).toEqual([
      { type: "effort", values: ["low"] },
    ]);
    expect(byId.get("syn/all-bad")?.reasoningOptions).toBeNull();
  });

  it("stores only a positive integer context limit", () => {
    const models = {
      "syn/float": syntheticModel({
        limit: { context: 131.5, output: 4096 },
      }),
      "syn/zero": syntheticModel({ limit: { context: 0 } }),
      "syn/no-limit": syntheticModel(),
      "syn/int": syntheticModel({ limit: { context: 128000 } }),
    };
    const byId = new Map(
      filterSynthetic(models).map((entry) => [entry.modelId, entry]),
    );
    expect(byId.get("syn/float")?.contextLimit).toBeNull();
    expect(byId.get("syn/zero")?.contextLimit).toBeNull();
    expect(byId.get("syn/no-limit")?.contextLimit).toBeNull();
    expect(byId.get("syn/int")?.contextLimit).toBe(128000);
  });

  it("orders by release_date desc then model_id asc", () => {
    const models = {
      "syn/b-same-day": syntheticModel({ release_date: "2026-08-01" }),
      "syn/a-same-day": syntheticModel({ release_date: "2026-08-01" }),
      "syn/newer": syntheticModel({ release_date: "2026-09-01" }),
      "syn/older": syntheticModel({ release_date: "2026-07-01" }),
    };
    expect(filterSynthetic(models).map((entry) => entry.modelId)).toEqual([
      "syn/newer",
      "syn/a-same-day",
      "syn/b-same-day",
      "syn/older",
    ]);
  });
});

/** The session half of the caller context for the fixture user. */
function testSession(userId: string) {
  return {
    session: {
      id: `session-${userId}`,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      token: `token-${userId}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ipAddress: null,
      userAgent: null,
      userId,
    },
    user: {
      id: userId,
      name: userId,
      email: `${userId}@slopcad.test`,
      emailVerified: false,
      image: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

function okResponse(body: string, etag: string): Response {
  return new Response(body, { status: 200, headers: { etag } });
}

function notModifiedResponse(etag: string): Response {
  return new Response(null, { status: 304, headers: { etag } });
}

/** The fixture with one openai model removed — a changed upstream. */
function fixtureWithoutOpenaiModel(modelId: string): string {
  const payload: unknown = JSON.parse(fixtureText);
  if (!isRecordObject(payload)) {
    throw new Error("The catalog fixture root must be an object.");
  }
  const openai = payload.openai;
  if (!isRecordObject(openai)) {
    throw new Error("The catalog fixture has no openai provider.");
  }
  const models = openai.models;
  if (!isRecordObject(models)) {
    throw new Error("The catalog fixture's openai provider has no models.");
  }
  delete models[modelId];
  return JSON.stringify(payload);
}

/**
 * One fresh migrated database plus a catalog router wired to an injected
 * mock transport, the pinned (advanceable) clock, and a fixed catalog URL.
 */
async function createCatalogHarness() {
  const db = await createInMemoryDb();
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  let currentTime = PINNED_NOW;
  const appRouter = router({
    modelCatalog: createModelCatalogRouter({
      db,
      now: () => currentTime,
      fetch: fetchMock,
      catalogUrl: CATALOG_URL,
    }),
  });
  const createCaller = t.createCallerFactory(appRouter);
  return {
    db,
    fetchMock,
    authenticated: createCaller({
      auth: null,
      session: testSession(SESSION_USER_ID),
    }),
    anonymous: createCaller({ auth: null, session: null }),
    /** Moves the injected clock (the router's TTL and filter `now`). */
    advanceTo: (next: Date) => {
      currentTime = next;
    },
  };
}

describe("modelCatalog router", () => {
  it("lists an empty array (never an error) for every provider before any refresh", async () => {
    const { authenticated } = await createCatalogHarness();
    for (const provider of [
      "openrouter",
      "openai",
      "anthropic",
      "google",
      "openai-compatible",
    ] as const) {
      expect(await authenticated.modelCatalog.list({ provider })).toEqual([]);
    }
    expect(await authenticated.modelCatalog.providers()).toEqual([]);
  });

  it("rejects anonymous callers on every procedure", async () => {
    const { anonymous } = await createCatalogHarness();
    await expect(
      anonymous.modelCatalog.list({ provider: "openai" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      anonymous.modelCatalog.refresh({ provider: "openai" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.modelCatalog.providers()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses to refresh openai-compatible — its models come from the endpoint itself (D14)", async () => {
    const { authenticated } = await createCatalogHarness();
    await expect(
      authenticated.modelCatalog.refresh({ provider: "openai-compatible" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refreshes, stores the filtered rows, and lists them provider-scoped only", async () => {
    const { authenticated, fetchMock } = await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-openai-1"'));

    const result = await authenticated.modelCatalog.refresh({
      provider: "openai",
    });
    expect(result.outcome).toBe("refetched");
    expect(result.entries.map((entry) => entry.modelId)).toEqual([
      ...PINNED_OPENAI,
    ]);
    expect(result.entries[0]?.fetchedAt).toBe(PINNED_NOW.toISOString());

    // The first fetch carries no If-None-Match (nothing cached yet).
    expect(fetchMock).toHaveBeenCalledWith(CATALOG_URL, { headers: {} });

    // D14: the openai rows are visible to openai's list alone.
    expect(
      (await authenticated.modelCatalog.list({ provider: "openai" })).map(
        (entry) => entry.modelId,
      ),
    ).toEqual([...PINNED_OPENAI]);
    expect(
      await authenticated.modelCatalog.list({ provider: "anthropic" }),
    ).toEqual([]);
    expect(
      await authenticated.modelCatalog.list({ provider: "openai-compatible" }),
    ).toEqual([]);

    // providers() reports exactly the cached provider, in supported order.
    expect(await authenticated.modelCatalog.providers()).toEqual(["openai"]);

    const stored = await authenticated.modelCatalog.list({
      provider: "openai",
    });
    const byId = new Map(stored.map((entry) => [entry.modelId, entry]));
    expect(byId.get("gpt-5.5")?.provider).toBe("openai");
    expect(byId.get("gpt-5.5")?.contextLimit).toBe(400000);
    expect(byId.get("gpt-daybreak-red-latest")?.reasoningOptions).toBeNull();
  });

  it("serves every named provider from the same payload", async () => {
    const { authenticated, fetchMock } = await createCatalogHarness();
    const cases = [
      ["openai", PINNED_OPENAI.length],
      ["anthropic", PINNED_ANTHROPIC.length],
      ["google", PINNED_GOOGLE.length],
      ["openrouter", PINNED_OPENROUTER.length],
    ] as const;
    for (const [provider] of cases) {
      fetchMock.mockResolvedValueOnce(
        okResponse(fixtureText, `"etag-${provider}-1"`),
      );
      const result = await authenticated.modelCatalog.refresh({ provider });
      expect(result.outcome).toBe("refetched");
    }
    for (const [provider, count] of cases) {
      expect(await authenticated.modelCatalog.list({ provider })).toHaveLength(
        count,
      );
    }
    expect(await authenticated.modelCatalog.providers()).toEqual([
      "openai",
      "anthropic",
      "google",
      "openrouter",
    ]);
  });

  it("serves from cache without any upstream call inside the 24h TTL", async () => {
    const { authenticated, fetchMock, advanceTo } =
      await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-ttl-1"'));
    await authenticated.modelCatalog.refresh({ provider: "openai" });

    fetchMock.mockClear();
    advanceTo(withinTtl(PINNED_NOW));
    const result = await authenticated.modelCatalog.refresh({
      provider: "openai",
    });
    expect(result.outcome).toBe("fresh-cache");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(PINNED_OPENAI.length);
  });

  it("revalidates with If-None-Match past the TTL and keeps the rows on 304", async () => {
    const { authenticated, fetchMock, advanceTo, db } =
      await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-304-1"'));
    await authenticated.modelCatalog.refresh({ provider: "openai" });

    const later = beyondTtl(PINNED_NOW);
    advanceTo(later);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(notModifiedResponse('"etag-304-1"'));
    const result = await authenticated.modelCatalog.refresh({
      provider: "openai",
    });
    expect(result.outcome).toBe("not-modified");
    expect(fetchMock).toHaveBeenCalledWith(CATALOG_URL, {
      headers: { "If-None-Match": '"etag-304-1"' },
    });
    expect(result.entries.map((entry) => entry.modelId)).toEqual([
      ...PINNED_OPENAI,
    ]);

    // fetchedAt was bumped (the TTL clock restarted), not the rows.
    const metaRows = await db
      .select()
      .from(modelCatalogMeta)
      .where(eq(modelCatalogMeta.provider, "openai"));
    expect(metaRows[0]?.fetchedAt.getTime()).toBe(later.getTime());
    expect(metaRows[0]?.etag).toBe('"etag-304-1"');

    fetchMock.mockClear();
    const immediate = await authenticated.modelCatalog.refresh({
      provider: "openai",
    });
    expect(immediate.outcome).toBe("fresh-cache");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bypasses the TTL when forced and replaces the rows from a changed upstream", async () => {
    const { authenticated, fetchMock, advanceTo } =
      await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-force-1"'));
    await authenticated.modelCatalog.refresh({ provider: "openai" });

    // Still inside the TTL, but force revalidates unconditionally.
    advanceTo(withinTtl(PINNED_NOW));
    fetchMock.mockClear();
    const changedBody = fixtureWithoutOpenaiModel("gpt-5.5");
    fetchMock.mockResolvedValueOnce(okResponse(changedBody, '"etag-force-2"'));
    const result = await authenticated.modelCatalog.refresh({
      provider: "openai",
      force: true,
    });
    expect(result.outcome).toBe("refetched");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const listed = await authenticated.modelCatalog.list({
      provider: "openai",
    });
    expect(listed.map((entry) => entry.modelId)).not.toContain("gpt-5.5");
    expect(listed).toHaveLength(PINNED_OPENAI.length - 1);
  });

  it("serves the last good rows when the upstream fails past the TTL (stale-on-error)", async () => {
    const { authenticated, fetchMock, advanceTo } =
      await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-stale-1"'));
    await authenticated.modelCatalog.refresh({ provider: "google" });

    advanceTo(beyondTtl(PINNED_NOW));
    fetchMock.mockClear();

    // A network rejection, an HTTP 503, and an unparseable body all keep
    // the cached rows and report the stale service.
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const rejected = await authenticated.modelCatalog.refresh({
      provider: "google",
    });
    expect(rejected.outcome).toBe("stale-served");
    expect(rejected.entries.map((entry) => entry.modelId)).toEqual([
      ...PINNED_GOOGLE,
    ]);

    fetchMock.mockResolvedValueOnce(
      new Response("upstream exploded", {
        status: 503,
      }),
    );
    const unavailable = await authenticated.modelCatalog.refresh({
      provider: "google",
    });
    expect(unavailable.outcome).toBe("stale-served");

    fetchMock.mockResolvedValueOnce(okResponse("not json at all", '"etag-x"'));
    const garbage = await authenticated.modelCatalog.refresh({
      provider: "google",
    });
    expect(garbage.outcome).toBe("stale-served");
    expect(garbage.entries).toHaveLength(PINNED_GOOGLE.length);
  });

  it("keeps the last good rows, ETag, and TTL clock when a 200 body is not a provider map", async () => {
    const { authenticated, fetchMock, advanceTo, db } =
      await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-shape-1"'));
    await authenticated.modelCatalog.refresh({ provider: "google" });

    advanceTo(beyondTtl(PINNED_NOW));
    fetchMock.mockClear();

    // Parseable 200s that are not a models.dev provider map — an error
    // object, a bare array, and null — are upstream failures: each keeps
    // the cached rows and never touches the stored ETag or fetchedAt.
    const wrongShapeBodies = [
      {
        etag: '"etag-garbage-1"',
        body: JSON.stringify({ error: "rate limited" }),
      },
      { etag: '"etag-garbage-2"', body: "[]" },
      { etag: '"etag-garbage-3"', body: "null" },
    ];
    for (const { etag, body } of wrongShapeBodies) {
      fetchMock.mockResolvedValueOnce(okResponse(body, etag));
      const result = await authenticated.modelCatalog.refresh({
        provider: "google",
      });
      expect(result.outcome).toBe("stale-served");
      expect(result.entries.map((entry) => entry.modelId)).toEqual([
        ...PINNED_GOOGLE,
      ]);

      const metaRows = await db
        .select()
        .from(modelCatalogMeta)
        .where(eq(modelCatalogMeta.provider, "google"));
      expect(metaRows[0]?.etag).toBe('"etag-shape-1"');
      expect(metaRows[0]?.fetchedAt.getTime()).toBe(PINNED_NOW.getTime());
    }

    // The rows survive every wrong-shape 200.
    expect(
      (await authenticated.modelCatalog.list({ provider: "google" })).map(
        (entry) => entry.modelId,
      ),
    ).toEqual([...PINNED_GOOGLE]);
  });

  it("keeps prior rows and their TTL clock when a valid provider list filters to empty", async () => {
    const { authenticated, fetchMock, advanceTo, db } =
      await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(okResponse(fixtureText, '"etag-empty-1"'));
    await authenticated.modelCatalog.refresh({ provider: "openai" });

    advanceTo(beyondTtl(PINNED_NOW));
    fetchMock.mockClear();

    // Both empty-but-valid shapes per the filter's semantics: an empty
    // models map and an empty models array under the provider's entry.
    fetchMock.mockResolvedValueOnce(
      okResponse('{"openai":{"models":{}}}', '"etag-empty-2"'),
    );
    const emptiedMap = await authenticated.modelCatalog.refresh({
      provider: "openai",
    });
    expect(emptiedMap.outcome).toBe("stale-served");
    expect(emptiedMap.entries.map((entry) => entry.modelId)).toEqual([
      ...PINNED_OPENAI,
    ]);

    fetchMock.mockResolvedValueOnce(
      okResponse('{"openai":{"models":[]}}', '"etag-empty-3"'),
    );
    const emptiedArray = await authenticated.modelCatalog.refresh({
      provider: "openai",
    });
    expect(emptiedArray.outcome).toBe("stale-served");

    // No wipe, no re-clock: the rows and the original ETag/fetchedAt
    // survive, and both post-TTL refreshes still hit upstream because the
    // cache window was not extended.
    const metaRows = await db
      .select()
      .from(modelCatalogMeta)
      .where(eq(modelCatalogMeta.provider, "openai"));
    expect(metaRows[0]?.etag).toBe('"etag-empty-1"');
    expect(metaRows[0]?.fetchedAt.getTime()).toBe(PINNED_NOW.getTime());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(
      (await authenticated.modelCatalog.list({ provider: "openai" })).map(
        (entry) => entry.modelId,
      ),
    ).toEqual([...PINNED_OPENAI]);
  });

  it("records a legitimately empty catalog (meta only) when nothing is cached yet", async () => {
    const { authenticated, fetchMock, db } = await createCatalogHarness();
    fetchMock.mockResolvedValueOnce(
      okResponse('{"anthropic":{"models":{}}}', '"etag-blank-1"'),
    );
    const result = await authenticated.modelCatalog.refresh({
      provider: "anthropic",
    });
    expect(result.outcome).toBe("refetched");
    expect(result.entries).toEqual([]);

    const metaRows = await db
      .select()
      .from(modelCatalogMeta)
      .where(eq(modelCatalogMeta.provider, "anthropic"));
    expect(metaRows[0]?.etag).toBe('"etag-blank-1"');
    expect(metaRows[0]?.fetchedAt.getTime()).toBe(PINNED_NOW.getTime());
    expect(await authenticated.modelCatalog.providers()).toEqual(["anthropic"]);

    // The recorded emptiness is cached like any fetch: inside the TTL no
    // upstream call happens again.
    fetchMock.mockClear();
    const cached = await authenticated.modelCatalog.refresh({
      provider: "anthropic",
    });
    expect(cached.outcome).toBe("fresh-cache");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a typed BAD_GATEWAY only when there are no rows to serve", async () => {
    const { authenticated, fetchMock } = await createCatalogHarness();

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      authenticated.modelCatalog.refresh({ provider: "anthropic" }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(
      authenticated.modelCatalog.refresh({ provider: "anthropic" }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    fetchMock.mockResolvedValueOnce(okResponse("<html>504</html>", '"etag-y"'));
    await expect(
      authenticated.modelCatalog.refresh({ provider: "anthropic" }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    // A parseable 200 that is not a provider map is a failure too.
    fetchMock.mockResolvedValueOnce(okResponse("[]", '"etag-z"'));
    await expect(
      authenticated.modelCatalog.refresh({ provider: "anthropic" }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    // Nothing was cached by any of the failures above.
    expect(
      await authenticated.modelCatalog.list({ provider: "anthropic" }),
    ).toEqual([]);
  });
});
