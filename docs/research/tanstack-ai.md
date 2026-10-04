# TanStack AI — Research (Oct 2026)

Research date: 2026-10-04. Confidence tags: **[V]** verified from official docs or repo source, **[I]** inferred (from source types/absence in docs), **[U]** uncertain (single secondary source).

Lineage: no predecessor name found. Repo `TanStack/ai` created 2025-10-08, first npm publish 2025-12-04; launched publicly as "TanStack AI" (Front-End Fire ep. 124, Dec 2025). Internal renames exist (e.g. `providerOptions`→`modelOptions`, `openai()`→`openaiText()`), documented in docs/migration. [V] — https://github.com/TanStack/ai, https://registry.npmjs.org/@tanstack/ai, https://tanstack.com/ai/latest/docs/migration/migration

## Executive summary

- TanStack AI is TanStack's official TypeScript AI/agent framework: MIT, v0 "RC" as of Oct 2026, 94 npm releases of `@tanstack/ai` since Dec 2025 (heavy churn: 15–17 releases/month mid-2026). [V]
- Architecture: server core `chat()` + headless `@tanstack/ai-client` + framework hooks (`@tanstack/ai-react` `useChat`) + per-activity tree-shakeable adapter packages. AG-UI wire protocol, not Vercel's data-stream. [V]
- Adapters cover everything slopcad needs: OpenAI (Responses + Chat Completions), Anthropic, Gemini (`@tanstack/ai-gemini`, not "google"), OpenRouter, Ollama, Groq, Bedrock, plus custom OpenAI-compatible endpoints via `baseURL`. [V]
- **Browser-direct BYOK is feasible**: adapter configs pass straight into official SDK clients (`OpenAIClientConfig extends Omit<ClientOptions,'apiKey'>`), so `dangerouslyAllowBrowser`, custom `fetch`, and Anthropic's `anthropic-dangerous-direct-browser-access` header all work; `useChat` accepts a `stream()` connection adapter that can wrap a browser-side `chat()` call with no server. [V/I]
- The shipped BYOK system (`@tanstack/ai-react/byok`) is a _relay_ pattern (keys in `x-byok-*` headers to your server, passkey-PRF or in-memory storage); pure client-direct BYOK is DIY but unblocked. [V]
- Tool calling: isomorphic `toolDefinition()` with zod `inputSchema`/`outputSchema`, `.server()` / `.client()` implementations, approvals, `emitCustomEvent` progress; agent loop default `maxIterations(5)`, extendable via `untilFinishReason`/`combineStrategies`/custom strategies. [V]
- Tool results support images: `ToolResultPart.content: string | Array<ContentPart>`. [V]
- Reasoning: per-provider shapes in `modelOptions` (OpenAI `reasoning.effort`, Anthropic `thinking` + `output_config.effort`, Gemini `thinkingConfig.thinkingLevel`, OpenRouter `reasoning.effort` + `provider` routing). No normalized cross-provider effort enum — typing is per-model. [V]
- TanStack Start integration is first-class: `createServerFn` + `toServerSentEventsResponse` via the `fetcher` option; `rpcStream()` exists for tRPC coexistence. [V]
- Persistence: `withPersistence` server middleware (bring-your-own adapter) or client-side `localStoragePersistence`/`indexedDBPersistence`; `reconstructChat` rehydrates. UIMessage is JSON-serializable (dates optional). [V]
- TanStack DB (`@tanstack/db` 0.11.3) has an official browser WASM-SQLite persisted-collection adapter (`@tanstack/browser-db-sqlite-persistence` + `@journeyapps/wa-sqlite` over OPFS) — a viable durable local store for chat rows. [V]
- Biggest risks: pre-1.0 API churn (documented breaking changes already), and the May 2026 npm supply-chain incident in the TanStack ecosystem (pin exact versions). [V/U]

## 1. Packages, names, versions, license

npm versions verified 2026-10-04 via registry.npmjs.org. All MIT. [V]

| Package                                                              | Latest                           | Purpose                                                                  |
| -------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `@tanstack/ai`                                                       | 0.64.0                           | Core: `chat()`, tools, middleware, BYOK server helpers, agent loop       |
| `@tanstack/ai-client`                                                | 0.36.1                           | Framework-agnostic headless chat client, connection adapters             |
| `@tanstack/ai-react`                                                 | 0.29.4                           | `useChat`, generation hooks, BYOK store, `createChatHook` UI factory     |
| `@tanstack/ai-openai`                                                | 0.26.0                           | OpenAI (Responses + Chat Completions, images, realtime, SIWC BYOK)       |
| `@tanstack/ai-anthropic`                                             | 0.19.4                           | Claude (+ `/vertex` subpath)                                             |
| `@tanstack/ai-gemini`                                                | 0.34.2                           | Google Gemini (this is the "Google" adapter; `ai-google` does not exist) |
| `@tanstack/ai-openrouter`                                            | 0.20.2                           | OpenRouter (+ `/byok`, `/pkce`, `/tools` subpaths)                       |
| `@tanstack/ai-persistence`                                           | 0.7.2                            | `withPersistence`, `reconstructChat`, adapters                           |
| `@tanstack/ai-mcp`                                                   | 0.7.0                            | MCP client as tools                                                      |
| `@tanstack/ai-devtools` (npm: `ai-devtools-core` 0.5.23)             | —                                | Devtools panel (isomorphic)                                              |
| `@tanstack/ai-code-mode`, `ai-sandbox`, `ai-memory`, `ai-compaction` | 0.4.19 / 0.5.18 / 0.2.9 / 0.1.12 | Optional agent harnesses (not needed initially)                          |

Also: `ai-solid`/`-vue`/`-svelte`/`-preact`/`-angular`/`-remix`/`-octane`, adapters for `ollama`, `groq`, `bedrock`, `vertex`, `mistral`, `cohere`, `perplexity`, `grok`, `elevenlabs`, `fal`, `llmgateway`, `vercel-gateway`, `cloudflare`, `lovable`, `byteplus`, `worldlabs`. [V] (https://github.com/TanStack/ai → packages/)

Stability: landing page labels v0 as "RC — close to stable, not formally stable" [V] (https://tanstack.com/ai). Peers of core are 0.x across the board. React binding peer-depends on exact `@tanstack/ai` minor (`^0.64.0`), so upgrade packages in lockstep. [V] (registry metadata)

## 2. Provider adapters

Every adapter follows one shape: short factory reads env key; `create*` factory takes explicit key + config. [V] (https://tanstack.com/ai/latest/docs/adapters/openai, /adapters/anthropic, /adapters/gemini, /adapters/openrouter)

```ts
import { openaiText, createOpenaiChat } from "@tanstack/ai-openai"; // Responses API
import { openaiChatCompletions } from "@tanstack/ai-openai"; // /chat/completions
import { anthropicText, createAnthropicChat } from "@tanstack/ai-anthropic";
import { geminiText, createGeminiChat } from "@tanstack/ai-gemini";
import { openRouterText, createOpenRouterText } from "@tanstack/ai-openrouter";

const adapter = createOpenaiChat("gpt-5.2", apiKey, {
  baseURL: "https://openrouter.ai/api/v1", // any OpenAI-compatible endpoint
  defaultHeaders: { Authorization: "Bearer ..." },
});
```

- **OpenAI-compatible / arbitrary baseURL**: `OpenAITextConfig` extends the official `openai` SDK `ClientOptions` (minus apiKey) — `baseURL`, `defaultHeaders`, `fetch`, `timeout` all pass through to `new OpenAI(config)`. [V] (source: `packages/ai-openai/src/utils/client.ts`, `packages/ai-openai/src/adapters/text.ts` — https://github.com/TanStack/ai/blob/main/packages/ai-openai/src/utils/client.ts). The same `openai-base` package powers Grok and Bedrock "OpenAI-compatible" adapters, confirming the compat path. [V]
- **Provider-specific params** go in `modelOptions` (renamed from `providerOptions`), typed per-model via generated `model-meta.ts`. OpenAI Responses uses `max_output_tokens`, Chat Completions uses `max_tokens`. [V] (https://tanstack.com/ai/latest/docs/advanced/typed-options, https://tanstack.com/ai/latest/docs/migration/migration)
- **Anthropic**: `createAnthropicChat(model, key, { baseURL })`; also `createAnthropicChatWithClient(model, client)` for any client exposing `beta.messages.create` (only server-documented). [V] (https://tanstack.com/ai/latest/docs/adapters/anthropic)
- **Gemini**: `GeminiTextConfig extends GoogleGenAIOptions` + `baseURL`→`httpOptions.baseUrl`, `defaultHeaders`→`httpOptions.headers`. [V] (source `packages/ai-gemini/src/utils/client.ts`; https://tanstack.com/ai/latest/docs/adapters/gemini)
- **OpenRouter**: `serverURL`, `httpReferer`, `appTitle`; `modelOptions.provider` (order/sort/quantizations/zdr…), `modelOptions.models` fallbacks, `retryCodes`. [V] (https://tanstack.com/ai/latest/docs/adapters/openrouter)

## 3. Browser / client-side execution (critical for slopcad)

**Verdict: fully supported, but the paved road is the relay.**

- `chat()` is isomorphic by construction: `useChat`'s `stream()` connection adapter takes a factory returning an `AsyncIterable<StreamChunk>` _synchronously_, explicitly documented for "a direct in-process `chat()` call". Run `chat({ adapter: createOpenaiChat(key…), messages })` inside the browser and feed it to `useChat`. [V] (https://tanstack.com/ai/latest/docs/chat/connection-adapters#server-functions-and-direct-async-iterables)
- Adapter configs extend official SDK client options, so browser mode works per each provider's own rules: OpenAI `dangerouslyAllowBrowser: true`; Anthropic `defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' }` (header name per Anthropic docs — TanStack docs never mention CORS at all); Gemini JS SDK is browser-safe. This part is **[I]** — verified at the type level, not in TanStack docs; CORS remains the provider's policy and is your responsibility. [I]
- **Fetch override points**: (a) adapter-level — pass `fetch` in the SDK config for direct calls; (b) transport-level — `fetchServerSentEvents(url, { fetchClient })` wraps the relay fetch (auth refresh/retries/BYOK header injection); (c) full custom `connect()` adapter receives `runContext.headers`. [V] (https://tanstack.com/ai/latest/docs/chat/connection-adapters#custom-fetch-client)
- **Shipped BYOK** (`@tanstack/ai-react/byok` + `@tanstack/ai-client/byok`): `defineByok({ storage, providers })`, `useByok(byok)`, `byok.update(providerId, key)`; storage backends: `defaultByokStorage()` (passkey PRF-encrypted, falls back to tab memory) and `memoryStorage()`. Keys travel to the server on `x-byok-*` headers, read server-side via `getByokKey(request, openaiByok)` from `@tanstack/ai/byok/server` (header wins, then env fallback, then 401 `byokMissing`). Provider stores: `openaiByok`, `openrouterByok` (+ OAuth PKCE login via `@tanstack/ai-openrouter/pkce`). localStorage is _not_ a documented backend. [V] (https://tanstack.com/ai/latest/docs/advanced/byok, https://tanstack.com/ai/latest/docs/tutorials/basic-chat)
- For slopcad's "key never leaves the client" requirement: skip the BYOK relay, keep keys in your own storage, pass them into `create*Chat` factories, and run `chat()` browser-side via `stream()`. The catch: `.client()` tools run in-browser, but `.server()` tools can't exist without a server — an all-browser loop only executes client tools. [I]

## 4. Server-side execution (TanStack Start, tRPC)

- Canonical Start pattern: `createServerFn({ method: 'POST' }).inputValidator(...).handler(({ data }) => toServerSentEventsResponse(chat({ adapter, messages: data.messages })))` on the server; client-side `useChat({ fetcher: ({ messages }, { signal }) => chatFn({ data: { messages }, signal }) })`. The `fetcher` option exists precisely because Start server functions return Promises (sync iterables need `stream()`). AbortSignal from `stop()` flows through. [V] (https://tanstack.com/ai/latest/docs/chat/connection-adapters#server-functions-via-fetcher)
- Plain route alternative: `POST` handler + `chatParamsFromRequest(request)` + `toServerSentEventsResponse(stream)` — works with "TanStack Start, Next.js, SvelteKit, Hono, and any host that returns a Web Response". [V] (https://tanstack.com/ai/latest/docs/getting-started/quick-start)
- **tRPC coexistence**: `rpcStream((messages, data) => api.chat.stream({ messages, ...data }))` is built for "Cap'n Web, gRPC-Web, tRPC subscriptions, or any RPC framework that already returns an async iterable". Both can live in the same app; you can also just call the Start server fn and ignore tRPC for this route. [V] (https://tanstack.com/ai/latest/docs/chat/connection-adapters#rpc-streams)
- Mixed server+client execution: `mergeAgentTools(serverTools, clientTools)`; the server streams, the browser executes `.client()` tools and auto-resumes the run. [V] (https://tanstack.com/ai/latest/docs/api/ai, https://tanstack.com/ai/latest/docs/tools/client-tools)

## 5. Tool calling & agent loop

- `toolDefinition({ name, description, inputSchema, outputSchema })` — zod (typed + validated) or raw JSON Schema (types become `unknown`). Implement `.server(fn)` and/or `.client(fn)`; pass the definition (or impls) into `chat({ tools })`. [V] (https://tanstack.com/ai/latest/docs/tools/tools)
- Loop mechanics: model emits tool calls → TanStack executes (server or client) → result goes back to the model as a tool result → repeat while finish reason is `tool_calls` **and** the loop strategy allows. Default bound `maxIterations(5)` (model turns, not tool calls). Strategies: `untilFinishReason([...])`, `combineStrategies([...])`, or custom `({ iterationCount, finishReason, messages, toolCallCount, lastTurnToolCallCount }) => boolean`. [V] (https://tanstack.com/ai/latest/docs/chat/agentic-cycle)
- No built-in `maxToolCalls`; the docs provide a middleware recipe (`onBeforeToolCall` per-turn cap returning `{ type: 'skip', result: { error } }`, `onShouldContinue` cumulative budget). [V] (same page)
- Context + progress: `.server(fn)` handlers get `ToolExecutionContext { context, toolCallId, emitCustomEvent }`; `emitCustomEvent('progress', {…})` streams to the UI. Tool UI states: `awaiting-input`, `input-streaming`, `input-complete`, `approval-requested`, `approval-responded`, plus `error` results. `needsApproval: true` gates execution behind an approval interrupt. [V] (https://tanstack.com/ai/latest/docs/tools/tools, /tools/client-tools)
- `toolExecution: 'sequential'` opt-in on `chat()`; parallel by default. `lazy: true` tools defer discovery across providers. [V] (https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk)

## 6. Streaming UI hooks (React)

- Low level: `useChat({ connection | fetcher, tools, byok, forwardedProps, threadId, persistence, outputSchema, … })` returns `{ messages, sendMessage, append, reload, stop, isLoading, error, status, setMessages, clear, addToolResult, addToolApprovalResponse, queue, cancelQueued, runId, interrupts, resolveInterrupts, retryInterrupts, partial, final, subagents, hasOlderMessages, loadOlderMessages, connectionStatus, … }`. `reload()` re-runs the last send (chat-level forwardedProps only). `sendMessage(content, { body })` merges per-call data into AG-UI `forwardedProps`. [V] (source `packages/ai-react/src/use-chat.ts`; https://tanstack.com/ai/latest/docs/chat/connection-adapters)
- Message/parts model: `UIMessage { id, role: 'system'|'user'|'assistant', parts: MessagePart[], createdAt?, metadata? }`; `MessagePart = TextPart | ImagePart | AudioPart | VideoPart | DocumentPart | ToolCallPart | ToolResultPart | ThinkingPart | StructuredOutputPart | UIResourcePart | SubagentPart`. Render by filtering `message.parts` on `part.type`. [V] (source `packages/ai/src/types.ts`)
- Typed headless UI kit: `createChatHook({ options, components, partsComponents, toolsComponents, interruptsComponents })` from `@tanstack/ai-react/ui` gives `useAppChat`/`useChatContext` with typed per-part and per-tool renderers (`ToolProps<typeof chatOptions, 'toolName'>`, `PartProps<…, 'text'>`). No default markup. (The standalone `@tanstack/ai-react-ui` package is deprecated — it re-exports this subpath.) [V] (https://tanstack.com/ai/latest/docs/ui/react, https://tanstack.com/ai/latest/docs/migration/create-ui)
- Optimistic/queued: user sends enter a queue when a run is active (`<Queue />`, `cancelQueued()`); `setMessages` for manual edits. Streaming text accumulates via SSE with resumable `Last-Event-ID` when a durability adapter is set. [V] (https://tanstack.com/ai/latest/docs/ui/react, /chat/connection-adapters)

## 7. Reasoning effort / thinking controls

No normalized cross-provider effort abstraction; you set each provider's native shape in `modelOptions`, type-narrowed per model. [V/I] (per-adapter docs; absence of a normalized enum in https://tanstack.com/ai/latest/docs/api/ai)

- **OpenAI**: `modelOptions.reasoning.effort: 'none'|'minimal'|'low'|'medium'|'high'`, optional `summary: 'auto'|'detailed'` (surfaces reasoning as ThinkingParts). [V] (https://tanstack.com/ai/latest/docs/chat/thinking-content)
- **Anthropic**: `modelOptions.thinking: { type: 'enabled', budget_tokens }` (must be < `max_tokens`) or `{ type: 'adaptive', display }` + `output_config.effort: 'low'|'medium'|'high'|'xhigh'|'max'` on newer models. Signed thinking round-trips via `signature`; redacted thinking preserved. [V] (https://tanstack.com/ai/latest/docs/adapters/anthropic, /chat/thinking-content)
- **Gemini**: `modelOptions.thinkingConfig.thinkingLevel: 'LOW'|'MEDIUM'|'HIGH'` (Gemini 3.8 Flash; `minimal` rejected) or generic `thinking: { includeThoughts: true }`. [V] (https://tanstack.com/ai/latest/docs/adapters/gemini)
- **OpenRouter**: `modelOptions.reasoning: { effort: 'none'…'max', enabled: false }` (normalized by OpenRouter itself) + `modelOptions.provider` routing. [V] (https://tanstack.com/ai/latest/docs/adapters/openrouter)

## 8. Message format & persistence

- Wire/UI format: `UIMessage` above — JSON-serializable (dates optional ISO). `chat()` accepts mixed `UIMessage | ModelMessage` arrays and converts internally (collapses `developer`→`system`). `ModelMessage` carries `thinking[]`, `toolCalls`, `structuredOutput`. [V] (https://tanstack.com/ai/latest/docs/api/ai)
- Server-authoritative: `withPersistence(persistence)` middleware writes transcript/runs/approvals to your store (build an adapter in ~40 lines, or `memoryPersistence()` for dev); client passes `persistence: true` and hydrates via a `GET` returning `reconstructChat(persistence, request, { authorize })`. [V] (https://tanstack.com/ai/latest/docs/persistence/overview)
- Browser-authoritative: `persistence: localStoragePersistence() | sessionStoragePersistence() | indexedDBPersistence()` — no server store. Paged history via `history: { pageSize }`. Restored pending client tools are rehydrated but not auto-rerun. [V] (same page, /persistence/client-persistence)
- Resumable streams (separate layer): `memoryStream`/`durableStream` durability adapters emit SSE ids; client auto-reconnects with `Last-Event-ID`; `joinRun(runId)` replays in-flight runs (needs a `GET` handler / `resumeServerSentEventsResponse`). [V] (https://tanstack.com/ai/latest/docs/chat/connection-adapters#resumable-sse)

## 9. Vision / multimodal & images in tool results

- Message content: string or `ContentPart[]` — `{ type: 'image', source: { type: 'data', value: base64, mimeType } | { type: 'url', value } }`, plus `audio`, `video`, `document` (PDF base64; OpenAI needs `metadata.filename`). Provider capability typed per model (`supports.input` in each adapter's `model-meta.ts`). [V] (https://tanstack.com/ai/latest/docs/advanced/multimodal-content)
- Tool results can carry images: `ToolResultPart.content: string | Array<ContentPart>` — return base64/URL image parts from a tool and they flow back to the model. [V] (source `packages/ai/src/types.ts`)

## 10. Vercel AI SDK v7 → TanStack AI mapping

Official comparisons target v5/v6 APIs; v7 names noted where they diverge. [V] (https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk, https://tanstack.com/ai/latest/docs/migration/migration-from-vercel-ai)

| Vercel AI SDK v7 concept                | TanStack AI equivalent                                                                                                 | Notes                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `useChat` (`@ai-sdk/react`)             | `useChat` (`@tanstack/ai-react`)                                                                                       | Same name; TanStack adds queue/interrupts/subagents |
| `streamText` / `generateText`           | `chat()` (AsyncIterable of `StreamChunk`; `stream: false` → string)                                                    | No separate generate helper for text                |
| `generateObject` / `streamObject`       | `chat({ outputSchema })` → `StructuredOutputPart` in history, `partial`/`final` from hook                              | Schema-narrowed types                               |
| `tool()` + `onToolCall`/`addToolOutput` | `toolDefinition().server() / .client()`                                                                                | Isomorphic; `addToolResult` exists on hook          |
| Agent / `stopWhen`                      | `agentLoopStrategy` (`maxIterations`, `untilFinishReason`, `combineStrategies`)                                        | No dedicated `Agent` class for plain loops          |
| UI Message Stream protocol              | AG-UI events (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`)                                                          | TanStack native; Vercel needs a translation layer   |
| `ChatTransport`                         | Connection adapters: `fetchServerSentEvents`, `fetchHttpStream`, `xhr*`, `stream`, `fetcher`, `rpcStream`, `webSocket` |                                                     |
| `wrapLanguageModel` middleware          | `ChatMiddleware` (`onBeforeToolCall`, `onShouldContinue`, …)                                                           |                                                     |
| `customProvider`/registry               | `extendAdapter()` + `createModel()` (literal-type narrowing)                                                           |                                                     |
| Redis resumable streams                 | `memoryStream`/`durableStream` + self-reconnecting client                                                              |                                                     |
| `useCompletion`, `useObject`            | `useSummarize`, `useGeneration`, `useGenerateImage/Audio/Speech/Video`, `useTranscription`                             | Activity-split hooks                                |
| Embeddings (`embed`)                    | `embed()` activity (removed then reintroduced historically)                                                            |                                                     |
| RSC (`@ai-sdk/rsc`)                     | none                                                                                                                   | Vercel-only                                         |

## 11. Maturity & risks (Oct 2026)

- Cadence: 94 releases of core since 2025-12-04; peak 17/month (Jun 2026); ~1,592 PRs merged on GitHub. Docs already carry a breaking-change migration guide (adapter splits, `providerOptions`→`modelOptions`, `toResponseStream`→`toServerSentEventsStream`, embeddings removed/reintroduced). Expect churn until 1.0. [V] (registry, https://tanstack.com/ai/latest/docs/migration/migration)
- Community: 3.1k stars / 352 forks / 70 open issues (Oct 2026); won "AI Project of the Year" at the 2026 Open Source Awards while in alpha. [V/U] (https://github.com/TanStack/ai; award per secondary sources)
- Known limitations: no dedicated `Agent` class for simple loops (strategies instead), fewer first-party providers than Vercel (~38 pkgs), no `splitMCPAppTools` equivalent — all acknowledged on TanStack's own comparison page. [V] (https://tanstack.com/ai/latest/docs/comparison/vercel-ai-sdk)
- Security: a May 2026 npm supply-chain incident affected the TanStack ecosystem (maintainer discussed it; remediation documented) — pin exact versions and review diffs on upgrade. [U] (secondary sources: RedMonk interview coverage)
- Docs push an optional "agent skills" installer (`npx @tanstack/intent@latest install`) so coding assistants can wire integrations from shipped skill files; not required. [V] (https://tanstack.com/ai/latest/docs/persistence/overview)

## 12. TanStack DB for client-side chat persistence

(a) **Packages/API**: `@tanstack/db` 0.11.3 (MIT, reactive client store; `createCollection`, `useLiveQuery` from `@tanstack/react-db` 0.5.3); collections are typed by standard schema (zod); `@tanstack/query-db-collection` 1.3.4 bridges TanStack Query. [V] (https://www.npmjs.com/package/@tanstack/db, https://github.com/TanStack/db/tree/main/docs — https://tanstack.com/db)

(b) **WASM SQLite persistence (official)**: `docs/guides/sqlite-persistence.md` — runtime packages supply a driver over `@tanstack/db-sqlite-persistence-core` (0.4.3). Browser: `@tanstack/browser-db-sqlite-persistence` 0.2.28 + `@journeyapps/wa-sqlite` 2.0.6 over **OPFS** (secure context required):

```ts
const database = await openBrowserWASQLiteOPFSDatabase({
  databaseName: "app.sqlite",
});
const persistence = createBrowserWASQLitePersistence({ database });
const chat = createCollection(
  persistedCollectionOptions<StoredMessage, string>({
    id: "chat-messages",
    getKey: (m) => m.id,
    persistence,
    schemaVersion: 1,
  }),
);
await chat.preload();
```

Multi-tab requires the documented multi-tab setup; bump `schemaVersion` on row-format changes; other runtimes: node, RN/Expo, Capacitor, Tauri, Electron, Cloudflare DO. No `wa-sqlite`/`sql.js` package under `@tanstack/db-*` other than these. [V] (https://raw.githubusercontent.com/TanStack/db/main/docs/guides/sqlite-persistence.md)

(c) **AI messages → collections**: no official TanStack doc maps `UIMessage` into TanStack DB; the official AI example `examples/ts-react-search` uses `createCollection(queryCollectionOptions(...))` + `useLiveQuery` as the reactive data layer the chat talks about (server tools), not as a message store. Pattern for slopcad: serialize `UIMessage` (JSON-safe: strip `Date` fields or accept ISO strings) into a persisted collection keyed by message id, thread id as a column; hydrate with `useChat({ setMessages })` on mount. Treat this wiring as your own glue — [I]. (https://github.com/TanStack/ai/tree/main/examples/ts-react-search)

(d) **Sync/offline**: `localStorageCollectionOptions` (in core `@tanstack/db`; small state, cross-tab via storage events) for lightweight cases; durable outbox via `@tanstack/offline-transactions` 1.0.61 (`startOfflineExecutor`, idempotency-keyed mutation retry, `createOfflineAction`) to push local rows to a server when back online; SQLite persistence can additionally store sync metadata for supported sync adapters (ElectricSQL, PowerSync, TrailBase, RxDB collections exist). [V] (https://raw.githubusercontent.com/TanStack/db/main/docs/guides/offline-transactions.md, docs/collections/local-storage-collection.md)

Note: TanStack AI's own `indexedDBPersistence()` may already cover slopcad's chat-transcript needs without TanStack DB; adopt DB only if CAD documents/projects should live in the same local store.

## Recommendations for slopcad

1. **Adopt**: `@tanstack/ai`, `@tanstack/ai-react`, and the four adapters `ai-openai` (covers OpenAI + any OpenAI-compatible baseURL, incl. OpenRouter-through-Chat-Completions if you want one code path), `ai-anthropic`, `ai-gemini`, `ai-openrouter`. Pin exact versions; upgrade in lockstep (peer deps are `^0.64.0`-coupled).
2. **Browser-direct BYOK**: read keys from your own storage, call `createOpenaiChat`/`createAnthropicChat`/`createGeminiChat`/`createOpenRouterText` with explicit keys, run `chat()` in the browser, and feed it to `useChat` via `stream(...)`. Add Anthropic's `anthropic-dangerous-direct-browser-access` header via `defaultHeaders` and OpenAI's `dangerouslyAllowBrowser: true`. Keep a Start server fn (`fetcher`) path for server-side models / `.server()` CAD tools — the same toolDefinition can carry both impls.
3. **Server tools for CAD**: implement CAD command tools as `toolDefinition().server(...)` with `context` carrying the tRPC/db request context; use `emitCustomEvent('progress', …)` for compile progress; surface per-tool state from `part.state` in `toolsComponents`. Cap the loop with `combineStrategies([maxIterations(N), customBudget])` + the middleware recipe for per-turn caps.
4. **Streaming UI**: use raw `useChat` + your own part renderers first (slopcad already has a design system); reach for `createChatHook` only if you want typed dispatch wiring. Handle `thinking`, `tool-call`, `tool-result`, and `error` part states; `stop()`/`reload()` come free.
5. **Persistence**: start with `persistence: indexedDBPersistence()` (client-owned, zero server code) for transcripts; if CAD artifacts and chats should share one durable local DB, adopt TanStack DB + `browser-db-sqlite-persistence` and write your own UIMessage↔row mapping; revisit `withPersistence` + `reconstructChat` when chats become multi-device.
6. **Watch out for**: pre-1.0 breaking changes (re-check `migration` docs each upgrade), no normalized reasoning-effort enum (build a small per-provider `modelOptions` builder), browser-direct mode cannot execute `.server()` tools, and npm supply-chain hygiene (pin versions).
