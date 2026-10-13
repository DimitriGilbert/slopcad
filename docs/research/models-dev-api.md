# models.dev model-catalog API — research notes

Researched live on 2026-10-04 for the slopcad model picker (vision-capable models, last 6 months,
24h server-side cache + force refresh). Every claim below was verified against the live endpoint
on that date; commands included inline.

## 1. API endpoints

|             |                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| URL         | `https://models.dev/api.json` (single blob; optional `?type=<model-type>` filter, e.g. `?type=decision` returned a 7.4 KB subset) |
| Auth        | None                                                                                                                              |
| CORS        | `access-control-allow-origin: *` (browser-fetchable, but we cache server-side anyway)                                             |
| Served by   | Cloudflare (`cf-cache-status: HIT`), `cache-control: public, max-age=0, must-revalidate`, `etag` present                          |
| Source repo | `github.com/sst/models.dev` (redirects to `anomalyco/models.dev`, default branch `dev`)                                           |

README quote: _"You can access this data through an API."_ via `curl https://models.dev/api.json`.

**Top-level structure:** a JSON object keyed by **provider id** (226 providers), not an array:

```jsonc
{
  "openrouter": { "id": "openrouter", "name": "OpenRouter", "env": ["OPENROUTER_API_KEY"],
                  "npm": "@openrouter/ai-sdk-provider", "api": "https://openrouter.ai/api/v1",
                  "doc": "https://openrouter.ai/models",
                  "models": { "<model-id>": { ...model... } } },
  "openai": { ... }, "anthropic": { ... }, "google": { ... }   // 226 total
}
```

Provider keys: `id`, `name`, `env[]`, `npm`, `models` always; `api`, `doc` optional.

## 2. Schema reference

The model schema is uniform: all 8,392 models carry `id, name, description, attachment, reasoning,
tool_call, modalities, open_weights, release_date, last_updated, limit`. Field presence counts:
`cost` 7,957; `temperature` 7,847; `family` 7,691; `reasoning_options` 6,189; `structured_output`
5,869; `canonical_model_id` 5,320; `knowledge` 4,349; `interleaved` 1,228; `provider` 344;
`status` 332 (`"beta"` 72, `"deprecated"` 260); `experimental` 85.

**The fields the picker needs:**

- **Vision capability:** `modalities.input` — array over vocabulary `["text","image","pdf","audio","video"]`
  (union across the whole catalog). Vision test = `"image" in modalities.input`.
- **Release date:** `release_date` — string `YYYY-MM-DD`, present on 8,392/8,392 models. Companion fields `last_updated` (same format) and optional `knowledge` (cutoff).
- **Context window:** `limit.context` (+ `limit.output`, sometimes `limit.input`).
- **Pricing:** `cost` in USD per million tokens: `input`, `output`, optional `cache_read`, `cache_write`, `tiers[]` (context-size tiers), `context_over_200k`.
- **Supported parameters:** `reasoning: bool` plus `reasoning_options: [{type: "budget_tokens"|"effort"|"toggle", min?/values?}]` — catalog-wide: `effort` 3,864 (with `values` like `["none","low","medium","high","xhigh"]`), `toggle` 1,396, `budget_tokens` 599. Plus booleans `tool_call`, `structured_output`, `temperature`, `attachment`.

### openai — `gpt-5.4` (verbatim)

```json
{
  "id": "gpt-5.4",
  "name": "GPT-5.4",
  "description": "Agent-ready GPT for coding and computer-use workflows at a lower cost",
  "family": "gpt",
  "attachment": true,
  "reasoning": true,
  "reasoning_options": [
    { "type": "effort", "values": ["none", "low", "medium", "high", "xhigh"] }
  ],
  "tool_call": true,
  "structured_output": true,
  "temperature": true,
  "knowledge": "2025-08-31",
  "release_date": "2026-03-05",
  "last_updated": "2026-03-05",
  "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
  "open_weights": false,
  "limit": { "context": 1050000, "input": 922000, "output": 128000 },
  "experimental": {
    "modes": {
      "fast": {
        "cost": { "input": 5, "output": 30, "cache_read": 0.5 },
        "provider": { "body": { "service_tier": "priority" } }
      }
    }
  },
  "cost": {
    "input": 2.5,
    "output": 15,
    "cache_read": 0.25,
    "tiers": [
      {
        "input": 5,
        "output": 22.5,
        "cache_read": 0.5,
        "tier": { "type": "context", "size": 272000 }
      }
    ],
    "context_over_200k": { "input": 5, "output": 22.5, "cache_read": 0.5 }
  }
}
```

### anthropic — `claude-haiku-4-5` (verbatim)

```json
{
  "id": "claude-haiku-4-5",
  "name": "Claude Haiku 4.5 (latest)",
  "description": "Fast Claude lane for lightweight agents, office tasks, and responsive chat",
  "family": "claude-haiku",
  "attachment": true,
  "reasoning": true,
  "reasoning_options": [{ "type": "budget_tokens", "min": 1024 }],
  "tool_call": true,
  "structured_output": true,
  "temperature": true,
  "knowledge": "2025-02-28",
  "release_date": "2025-10-15",
  "last_updated": "2025-10-15",
  "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
  "open_weights": false,
  "limit": { "context": 200000, "output": 64000 },
  "cost": { "input": 1, "output": 5, "cache_read": 0.1, "cache_write": 1.25 },
  "canonical_model_id": "anthropic/claude-haiku-4-5"
}
```

### google — `gemini-2.5-flash-image` (verbatim)

```json
{
  "id": "gemini-2.5-flash-image",
  "name": "Nano Banana",
  "description": "Nano Banana image model for fast generation, edits, and character-consistent assets",
  "family": "gemini-flash",
  "attachment": true,
  "reasoning": true,
  "reasoning_options": [],
  "tool_call": false,
  "temperature": true,
  "knowledge": "2024-06",
  "release_date": "2025-08-26",
  "last_updated": "2025-08-26",
  "modalities": { "input": ["text", "image"], "output": ["text", "image"] },
  "open_weights": false,
  "limit": { "context": 32768, "output": 32768 },
  "cost": { "input": 0.3, "output": 30, "cache_read": 0.075 },
  "canonical_model_id": "google/gemini-2.5-flash-image"
}
```

### openrouter — `anthropic/claude-sonnet-4.5` (verbatim)

```json
{
  "id": "anthropic/claude-sonnet-4.5",
  "name": "Claude Sonnet 4.5 (latest)",
  "description": "Balanced Claude model for coding, analysis, agent workflows, and cost control",
  "family": "claude-sonnet",
  "attachment": true,
  "reasoning": true,
  "reasoning_options": [{ "type": "toggle" }],
  "tool_call": true,
  "structured_output": true,
  "temperature": true,
  "knowledge": "2025-07-31",
  "release_date": "2025-09-29",
  "last_updated": "2025-09-29",
  "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] },
  "open_weights": false,
  "limit": { "context": 1000000, "output": 64000 },
  "cost": {
    "input": 3,
    "output": 15,
    "cache_read": 0.3,
    "cache_write": 3.75,
    "tiers": [
      {
        "input": 6,
        "output": 22.5,
        "cache_read": 0.6,
        "cache_write": 7.5,
        "tier": { "type": "context", "size": 200000 }
      }
    ],
    "context_over_200k": {
      "input": 6,
      "output": 22.5,
      "cache_read": 0.6,
      "cache_write": 7.5
    }
  },
  "canonical_model_id": "anthropic/claude-sonnet-4-5"
}
```

## 3. Provider coverage check

All four targets present. `jq '.openai.models|length'` etc. (fetched 2026-10-04):

| provider     | models | spot-check (famous recent)    | `release_date` |
| ------------ | ------ | ----------------------------- | -------------- |
| `openrouter` | 390    | `anthropic/claude-sonnet-4.5` | 2025-09-29     |
| `openai`     | 53     | `gpt-5.5`                     | 2026-04-23     |
| `anthropic`  | 16     | `claude-opus-5`               | 2026-07-24     |
| `google`     | 39     | `gemini-3.5-flash`            | 2026-05-19     |

Dates look maintained: the newest openai/anthropic/google entries are 2026-09/10 (within days of
today), and the upstream repo `pushed_at` is **2026-10-04T04:35Z** — refreshed today. Cadence:
`.github/workflows/sync-models.yml` runs `cron: "17 * * * *"` (**hourly**) plus community PRs
("We need your help keeping the data up to date."). OpenRouter entries include `~`-prefixed alias
ids (e.g. `~anthropic/claude-sonnet-latest`) — keep or strip them in the picker deliberately.

## 4. The filter recipe (vision AND released within last 6 months)

Today = 2026-10-04, so cutoff = `2026-04-04`. Command (run for each provider `$p`):

```bash
curl -sL https://models.dev/api.json -o /tmp/models-dev-api.json
jq -r --arg p openrouter --arg cutoff 2026-04-04 \
  '(.[$p].models // {}) | to_entries[]
   | select(.value.release_date >= $cutoff)
   | select(.value.modalities.input | index("image"))
   | select(.value.status != "deprecated")
   | "\(.value.release_date)  \(.key)"' /tmp/models-dev-api.json | sort -r
```

TypeScript equivalent (after one-time parse of the cached JSON):

```ts
const vision = (m: Model) => m.modalities.input.includes("image");
const recent = (m: Model, now: Date) =>
  m.release_date >= isoSixMonthsAgo(now) && m.status !== "deprecated"; // string compare works: YYYY-MM-DD
```

**Actual output of the run (2026-10-04) — counts: openrouter 111, openai 14, anthropic 8, google 15.**

- **openai (14):** gpt-6.1-sol (09-29), gpt-6-sol (09-22), gpt-6-luna (09-22), gpt-6-astra (09-04),
  gpt-daybreak-red-latest (08-07), gpt-daybreak-blue-latest (08-07), gpt-5.6-terra / -sol / -luna /
  gpt-5.6 (07-09), gpt-realtime-2.1 (07-06), gpt-5.5-pro / gpt-5.5 (04-23), gpt-image-2 (04-21)
- **anthropic (8):** claude-sonnet-5-5 (09-28), claude-opus-5-5 (09-22), claude-fable-5-1 (09-01),
  claude-opus-5 (07-24), claude-sonnet-5 (06-29), claude-fable-5 (06-07), claude-opus-4-8 (05-28),
  claude-opus-4-7 (04-14)
- **google (15):** gemini-3.8-flash (09-02), gemini-flash-latest (08-13), gemini-3.7-flash (08-13),
  gemini-flash-lite-latest (07-21), gemini-3.6-flash (07-21), gemini-3.5-flash-lite (07-21),
  gemini-omni-flash-preview (06-30), gemini-3.1-flash-lite-image (06-30), gemini-3-pro-image (05-28),
  gemini-3.1-flash-image (05-28), gemini-3.5-flash (05-19), gemini-3.1-flash-lite (05-07),
  gemini-embedding-2 (04-22, false positive — see §7), deep-research-preview-04-2026 (04-21),
  deep-research-max-preview-04-2026 (04-21)
- **openrouter (111):** list too long to inline; same filter produced 111 ids, newest
  `unbiased/pareto-26.10-preview` (2026-10-01) down to `meta/muse-spark-1.1` (2026-04-08).
  Zero openrouter models were excluded by the `status != "deprecated"` clause in this window.

Full openrouter list is reproducible with the command above.

## 5. Caching & refresh

Live headers (`curl -sI https://models.dev/api.json`, 2026-10-04):

```
cache-control: public, max-age=0, must-revalidate
etag: "950ff02b60986f3b203806ea6cd85b14"
access-control-allow-origin: *
```

- **ETag: yes.** `curl -sI -H 'If-None-Match: "950ff02b…"' https://models.dev/api.json` returned
  **HTTP 304** with no body. Conditional revalidation is the intended refresh path.
- `max-age=0, must-revalidate` means the CDN advertises no freshness window — our own TTL decides
  when to revalidate; ETag makes revalidation free when data is unchanged.
- **Payload size: 5,316,648 bytes (~5.3 MB)**, 226 providers, 8,392 models. Never fetch per user
  request; fetch per cache-generation.
- **Rate limits:** none documented on the site; Cloudflare-fronted. With a 24h TTL + ETag the load
  is ~1 request/day (+1 cheap 304 per force-refresh) — trivially safe.

Recommended SQLite design (Drizzle, one row):

```ts
// table model_catalog: id=1, etag text, body text (api.json verbatim), fetched_at integer (epoch ms)
async function getCatalog(force: boolean) {
  const row = await db.select().from(modelCatalog).get();
  const fresh = row && Date.now() - row.fetchedAt < 24 * 3600_000;
  if (row && fresh && !force) return parse(row.body);
  const res = await fetch(API_URL, {
    headers: row && !force ? { "If-None-Match": row.etag } : {},
  });
  if (res.status === 304 && row) {
    await db.update(modelCatalog).set({ fetchedAt: Date.now() });
    return parse(row.body);
  }
  if (res.ok) {
    const body = await res.text();
    const etag = res.headers.get("etag") ?? "";
    await db
      .insert(modelCatalog)
      .values({ id: 1, etag, body, fetchedAt: Date.now() })
      .onConflictDoUpdate({
        target: modelCatalog.id,
        set: { etag, body, fetchedAt: Date.now() },
      });
    return parse(body);
  }
  if (row) return parse(row.body); // network failed: serve stale
  throw new Error("catalog unavailable"); // first fetch failed and cache empty
}
```

Force-refresh button = call `getCatalog(true)` (unconditional GET, replaces body + etag). The
filtered per-provider view can be computed on the fly from the cached body at request time — no
need to persist per-provider subsets.

## 6. Licensing & terms

- Repo license: **MIT** (`anomalyco/models.dev`, verified via GitHub API `license: "MIT"`; site
  header self-describes as _"An open-source database of AI models"_).
- The site itself has no terms-of-use page; the MIT repo license covers the data files that build
  `api.json`. MIT permits use, copying, modification, and **redistribution** (including filtered
  subsets served to app users) provided the copyright + permission notice is included.
- Verdict for slopcad: **caching server-side and shipping filtered model lists to users is
  permitted**; keep the MIT notice in the repo (e.g. in the research docs / about screen) and
  ideally note the data source ("data from models.dev") in the picker.

## 7. Gaps & fallbacks

What models.dev does **not** give us:

1. **Arbitrary OpenAI-compatible endpoints** — only the 226 known providers; a user's LM Studio /
   vLLM / corporate gateway base URL cannot be enumerated. Fallback: this is exactly why the picker
   always allows a raw model string (option c) — no catalog needed for typed models.
2. **Embedding models leak through the vision filter** — `gemini-embedding-2` has
   `modalities.input: ["text","image","pdf"]` because embeddings accept image input. Add a heuristic
   exclusion (`family`/name contains "embedding", or `output` is a vector-ish type) if unwanted.
   Agent-only models (`deep-research-*`) also slip through; consider a name blocklist or letting
   cost/`tool_call` signals rank them.
3. **No per-endpoint "supports parameter X" for custom providers** — `reasoning_options` covers
   cataloged models only; for typed models on custom endpoints we must assume standard OpenAI
   params and degrade gracefully.
4. **Single 5.3 MB blob** — no per-provider endpoint; fine with our cache, wasteful otherwise.

**Plan B: OpenRouter's own catalog** — `GET https://openrouter.ai/api/v1/models`, no auth,
763 KB, 466 models, `cache-control: public, max-age=120, stale-while-revalidate=3600`,
**no ETag observed**. Shape (verified 2026-10-04):

```jsonc
{
  "data": [
    {
      "id": "inclusionai/ling-3.1-flash",
      "canonical_slug": "inclusionai/ling-3.1-flash-20261002",
      "name": "inclusionAI: Ling 3.1 Flash",
      "created": 1790950024, // unix seconds, not a release date
      "description": "...",
      "context_length": 262144,
      "architecture": {
        "modality": "text->text",
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "tokenizer": "Other",
      },
      "pricing": { "prompt": "0", "completion": "0" }, // strings, USD per token
      "top_provider": {
        "context_length": 262144,
        "max_completion_tokens": 32768,
      },
      "supported_parameters": [
        "frequency_penalty",
        "reasoning",
        "tools",
        "temperature",
        "...",
      ],
      "reasoning": { "mandatory": false, "default_enabled": true },
    },
  ],
}
```

Vision test there = `"image" in architecture.input_modalities`; recency must use `created`
(a listing timestamp, looser than models.dev's curated `release_date`). Use it only if models.dev
is unreachable or a fresher OpenRouter-native list is needed; models.dev remains primary because
of curated `release_date` + uniform schema + ETag revalidation.

---

### Commands used (2026-10-04)

```bash
curl -sL https://models.dev/api.json -o /tmp/models-dev-api.json      # 5,316,648 bytes
curl -sI https://models.dev/api.json                                   # etag, cache-control, CORS
curl -sI -H 'If-None-Match: "950ff02b60986f3b203806ea6cd85b14"' https://models.dev/api.json  # 304
jq 'type, (keys|length)' /tmp/models-dev-api.json                      # object, 226 providers
jq '[.[]|.models // {} | length] | add' /tmp/models-dev-api.json       # 8392 models
jq -r --arg p openrouter --arg cutoff 2026-04-04 '...'                 # filter in §4
curl -sL https://openrouter.ai/api/v1/models -o /tmp/openrouter-models.json  # 763 KB, 466 models
curl -sL https://raw.githubusercontent.com/anomalyco/models.dev/dev/.github/workflows/sync-models.yml
```
