/**
 * The agent chat runtime hook (PLAN-AGENT-CHAT Phase 3.3): `useAgentChat`, a
 * thin wrapper over `@tanstack/ai-react`'s `useChat` that binds the slopcad
 * agent's transport, system prompt, native model options, and loop bound.
 * The React hook is deliberately the THIN part; everything under it is plain,
 * node-testable factory code:
 *
 * - {@link assembleAgentSystemPrompt} — prompt assembly (D8).
 * - {@link resolveAgentModelOptions} — the Phase 1.3 native-options merge (D8).
 * - {@link createAgentChatTransport} — transport selection by mode (D1/D2).
 *
 * ## Transport selection (the useChat `connection` XOR `fetcher` currencies)
 *
 * - **client** (D1): a `ConnectConnectionAdapter` whose `connect()` runs the
 *   TanStack AI `chat()` loop IN THE BROWSER — the Phase 1.2 provider adapter,
 *   built from the user's browser-stored key over the injected `fetch` — and
 *   yields its chunks. The bridged Phase 2.3 client tools are handed to
 *   `chat()` as-is: the loop runs where the tools run, so the model's tool
 *   calls execute inside the same browser run (the engine invokes a tool's
 *   `execute` whenever it carries one) and the `maxIterations` strategy
 *   bounds that in-run loop, per turn count, exactly as the plan requires.
 * - **server** (D2): a `ChatFetcher` POSTing exactly
 *   `{ provider, modelId, modelOptions, maxIterations, messages }` to
 *   `/api/agent-relay` (Phase 1.5's validated contract — provably no key
 *   field, D1/D2) and returning the SSE `Response` for the chat client to
 *   parse. The server owns the loop there, so the config's own loop bound
 *   rides the contract (an integer 1..25) and the relay binds it onto the
 *   server-side run's `agentLoopStrategy` — the same config value that
 *   bounds the client-direct loop below.
 *
 * ## System prompt assembly (D8)
 *
 * The system prompt is the user's editable prompt from the config store plus
 * an auto-appended, delimiter-marked context block: the page's
 * `cad_get_document` summary and the tool catalogue derived from the bound
 * tool set (name + description per tool — one source of truth, no second
 * list to drift). The base instruction text lives here as
 * {@link AGENT_BASE_INSTRUCTION} — the DEFAULT value of the user's editable
 * prompt until they change it, and fully replaceable via config: a stored
 * prompt replaces it wholesale, and an explicitly EMPTY stored prompt strips
 * the instruction entirely, leaving the context block alone ("empty user
 * prompt ⇒ context block only"). It names no model ids (D5) and tells the
 * agent it MAY capture several angles in one call after geometry changes
 * (D10's optionality).
 *
 * ## Page-agnosticism
 *
 * The page supplies everything dynamic as inputs: the document summary
 * string, the bridged tools (the page-mounted webMCP binding through the
 * Phase 2.3 bridge), and the selected model's catalog reasoning option.
 * Nothing here imports a page, a store, or the global webMCP registry — the
 * config object arrives read from the Phase 1.3 store by the caller.
 */

import { chat, maxIterations } from "@tanstack/ai";
import type {
  AnyClientTool,
  AnyTextAdapter,
  ClientTool,
  ModelMessage,
  SchemaInput,
  UIMessage,
} from "@tanstack/ai";
import type {
  ChatFetcher,
  ChatFetcherInput,
  ChatFetcherOptions,
  ChatTransport,
  ConnectConnectionAdapter,
  RunAgentInputContext,
} from "@tanstack/ai-client";
import { useChat } from "@tanstack/ai-react";
import type { UseChatReturn } from "@tanstack/ai-react";
import { useMemo, useRef, useState } from "react";

import {
  createAgentProviderAdapter,
  type AgentProviderAdapterConfig,
  type AgentProviderId,
} from "./providers";
import { isAgentConfigured, type AgentConfig } from "./config/store";
import {
  buildAgentModelOptions,
  type AgentModelOptions,
  type AgentModelReasoningOption,
} from "./model-options";

/** The agent's bridged client tool (the Phase 2.3 bridge's element type). */
export type AgentChatTool = ClientTool<
  SchemaInput | undefined,
  SchemaInput | undefined
>;

/** One catalogue entry in the system prompt's context block. */
export interface AgentChatToolDescriptor {
  readonly name: string;
  readonly description: string;
}

/**
 * The base instruction text (D8): the shipped default of the user's editable
 * system prompt, fully replaceable via the config store — a stored
 * `systemPrompt` replaces it wholesale; an explicitly empty stored prompt
 * strips it entirely. Names no model or provider ids (D5) and frames
 * multi-angle capture as an OPTION after geometry changes (D10).
 */
export const AGENT_BASE_INSTRUCTION = `You are the slopcad CAD agent, working inside the user's parametric CAD workbench.

- Consult the context block below for the current document state and the exact tool catalogue before assuming what exists.
- Change the model through the provided tools; never describe steps for the user to perform by hand.
- Call tools only by their catalogued names, and prefer one well-formed call over several guessed ones.
- After you change geometry, you may capture the current object to check your work; one view is usually enough, and you may request several angles in a single capture call when a change affects more than one orientation.
- When a tool reports a structured error, read its code and message and correct the call instead of repeating it.`;

/** The context block's opening delimiter (exported for the chat UI's "marked as such" rendering, D8). */
export const AGENT_CONTEXT_START = "<slopcad-agent-context>";

/** The context block's closing delimiter. */
export const AGENT_CONTEXT_END = "</slopcad-agent-context>";

/** Everything the prompt assembly needs, all of it page-supplied. */
export interface AgentSystemPromptInput {
  /**
   * The user's editable prompt from the config store: `null` means never
   * edited ({@link AGENT_BASE_INSTRUCTION} applies), an empty string means
   * deliberately stripped (context block only).
   */
  readonly userPrompt: string | null;
  /** The page's `cad_get_document` summary of the current document. */
  readonly documentSummary: string;
  /** The catalogue derived from the bound tool set. */
  readonly toolCatalogue: readonly AgentChatToolDescriptor[];
}

/** Renders the auto-appended context block: summary + tool catalogue, delimited. */
function agentContextBlock(input: AgentSystemPromptInput): string {
  const lines = [
    AGENT_CONTEXT_START,
    "Everything in this block is generated by slopcad on every message; it is",
    "not part of the user's editable system prompt.",
    "",
    "Current document summary:",
    input.documentSummary.length === 0
      ? "(the document is empty)"
      : input.documentSummary,
    "",
    "Tool catalogue (the only tools you may call):",
    ...(input.toolCatalogue.length === 0
      ? ["(no tools are bound)"]
      : input.toolCatalogue.map(
          (tool) => `- ${tool.name}: ${tool.description}`,
        )),
    AGENT_CONTEXT_END,
  ];
  return lines.join("\n");
}

/**
 * Assembles the agent system prompt: the user's editable prompt (or the base
 * instruction while never edited) above the auto-appended, delimited context
 * block. An empty or whitespace-only user prompt yields the context block
 * alone; a stored prompt replaces the base instruction wholesale.
 */
export function assembleAgentSystemPrompt(
  input: AgentSystemPromptInput,
): string {
  const instruction =
    input.userPrompt === null
      ? AGENT_BASE_INSTRUCTION
      : input.userPrompt.trim();
  const context = agentContextBlock(input);
  return instruction.length === 0 ? context : `${instruction}\n\n${context}`;
}

/** Derives the prompt's tool catalogue from the bound tool set. */
export function agentToolCatalogue(
  tools: ReadonlyArray<AnyClientTool>,
): AgentChatToolDescriptor[] {
  return tools.map((tool) => ({
    description: tool.description,
    name: tool.name,
  }));
}

/**
 * The native `modelOptions` merge (D8): resolves the config's remembered
 * reasoning selection against the selected model's catalog
 * `reasoning_options` entry through the Phase 1.3 builder, which emits the
 * provider's NATIVE shape or `undefined` — nothing is offered when the model
 * declares no option, the config holds no selection, the config is
 * unconfigured (D5's type state), or the remembered value is not among the
 * catalog's offered values.
 */
export function resolveAgentModelOptions(
  config: AgentConfig,
  reasoningOption: AgentModelReasoningOption | undefined,
): AgentModelOptions | undefined {
  if (!isAgentConfigured(config) || config.reasoning === null) {
    return undefined;
  }
  if (reasoningOption === undefined) {
    return undefined;
  }
  return buildAgentModelOptions(
    config.provider,
    reasoningOption,
    config.reasoning.value,
  );
}

/** The refusal the transports raise when the config cannot carry a run. */
export class AgentChatUnconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentChatUnconfiguredError";
  }
}

/** The narrowed provider + its validated adapter config (fetch included). */
interface ClientAdapterBinding {
  readonly provider: AgentProviderId;
  readonly adapterConfig: AgentProviderAdapterConfig;
}

/** Validates the client-direct prerequisites and binds the adapter config. */
function clientAdapterBinding(
  config: AgentConfig,
  transport: typeof globalThis.fetch,
): ClientAdapterBinding {
  if (!isAgentConfigured(config)) {
    throw new AgentChatUnconfiguredError(
      "The agent is not configured: pick a provider and a model (nothing is ever preselected) before sending.",
    );
  }
  const apiKey = config.apiKeyByProvider[config.provider];
  if (apiKey === undefined) {
    throw new AgentChatUnconfiguredError(
      `Client-direct mode needs the ${config.provider} API key, which is stored only in this browser (it never crosses to the slopcad server).`,
    );
  }
  if (
    config.provider === "openai-compatible" &&
    config.openAiCompatibleBaseUrl === null
  ) {
    throw new AgentChatUnconfiguredError(
      "The openai-compatible provider needs an endpoint base URL before it can be called.",
    );
  }
  return {
    adapterConfig: {
      apiKey,
      fetch: transport,
      modelId: config.modelId,
      ...(config.provider === "openai-compatible" &&
      config.openAiCompatibleBaseUrl !== null
        ? { baseURL: config.openAiCompatibleBaseUrl }
        : {}),
    },
    provider: config.provider,
  };
}

/** Everything the transport factory binds from the caller. */
export interface AgentChatTransportInput {
  /** The agent config, read from the Phase 1.3 store by the page. */
  readonly config: AgentConfig;
  /** The page's `cad_get_document` summary of the current document. */
  readonly documentSummary: string;
  /** The bridged client tools (the page-mounted webMCP binding). */
  readonly tools: ReadonlyArray<AnyClientTool>;
  /** The selected model's catalog `reasoning_options` entry, when it declares one. */
  readonly reasoningOption?: AgentModelReasoningOption;
}

/** Injectable seams, the provider factories' convention. */
export interface AgentChatTransportDeps {
  /**
   * Adapter construction (the Phase 1.2 factory dispatch); tests substitute
   * a scripted text adapter. Defaults to {@link createAgentProviderAdapter}.
   */
  readonly createAdapter?: (
    providerId: AgentProviderId,
    config: AgentProviderAdapterConfig,
  ) => AnyTextAdapter;
  /** Injectable HTTP transport — defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** The relay endpoint; defaults to `"/api/agent-relay"` (Phase 1.5). */
  readonly relayUrl?: string;
}

/** The client-direct connection: the browser-resident `chat()` loop (D1). */
function createClientDirectConnection(
  input: AgentChatTransportInput,
  deps: AgentChatTransportDeps,
): ConnectConnectionAdapter {
  // Everything run-scoped is derived INSIDE connect(): the connection
  // object outlives many runs, and the hook (its only production caller)
  // hands it live-read getters — a prompt or model options snapshot taken
  // here would freeze the first render's context into every later run.
  const createAdapter = deps.createAdapter ?? createAgentProviderAdapter;
  const transport = deps.fetch ?? globalThis.fetch;
  return {
    async *connect(
      messages: Array<UIMessage> | Array<ModelMessage>,
      _data: Record<string, unknown> | undefined,
      abortSignal: AbortSignal | undefined,
      runContext: RunAgentInputContext | undefined,
    ) {
      const { config } = input;
      const systemPrompt = assembleAgentSystemPrompt({
        documentSummary: input.documentSummary,
        toolCatalogue: agentToolCatalogue(input.tools),
        userPrompt: config.systemPrompt,
      });
      const modelOptions = resolveAgentModelOptions(
        config,
        input.reasoningOption,
      );
      const { adapterConfig, provider } = clientAdapterBinding(
        config,
        transport,
      );
      const adapter = createAdapter(provider, adapterConfig);
      // The chat client's stop() aborts its request signal; chat() takes an
      // AbortController, so the two are bridged once, here.
      const abortController = new AbortController();
      abortSignal?.addEventListener(
        "abort",
        () => {
          abortController.abort();
        },
        { once: true },
      );
      yield* chat({
        abortController,
        adapter,
        agentLoopStrategy: maxIterations(config.maxIterations),
        messages,
        ...(modelOptions === undefined ? {} : { modelOptions }),
        ...(runContext?.parentRunId === undefined
          ? {}
          : { parentRunId: runContext.parentRunId }),
        ...(runContext?.resume === undefined
          ? {}
          : { resume: runContext.resume }),
        ...(runContext?.runId === undefined ? {} : { runId: runContext.runId }),
        ...(runContext?.threadId === undefined
          ? {}
          : { threadId: runContext.threadId }),
        systemPrompts: [systemPrompt],
        tools: input.tools,
      });
    },
  };
}

/** The fixed id of the relay request's prepended system message. */
const RELAY_SYSTEM_MESSAGE_ID = "slopcad-agent-system";

/** Reads a relay failure envelope's message when the body carries one. */
async function relayFailureMessage(response: Response): Promise<string> {
  const fallback = `The agent relay answered ${String(response.status)}.`;
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string" &&
      payload.message.length > 0
    ) {
      return payload.message;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** The server-relay fetcher (D2): POSTs the keyless conversation, returns the SSE response. */
function createRelayFetcher(
  input: AgentChatTransportInput,
  deps: AgentChatTransportDeps,
): ChatFetcher {
  const relayUrl = deps.relayUrl ?? "/api/agent-relay";
  const transport = deps.fetch ?? globalThis.fetch;
  return async (
    request: ChatFetcherInput,
    options: ChatFetcherOptions,
  ): Promise<Response> => {
    // As in the client connection: per-request derivation, never a
    // snapshot — the fetcher outlives settings edits and document changes.
    const { config } = input;
    const systemPrompt = assembleAgentSystemPrompt({
      documentSummary: input.documentSummary,
      toolCatalogue: agentToolCatalogue(input.tools),
      userPrompt: config.systemPrompt,
    });
    const modelOptions = resolveAgentModelOptions(
      config,
      input.reasoningOption,
    );
    if (!isAgentConfigured(config)) {
      throw new AgentChatUnconfiguredError(
        "The agent is not configured: pick a provider and a model (nothing is ever preselected) before sending.",
      );
    }
    // Exactly the relay's wire contract: five fields, never a key (D1/D2).
    // The guarantee is structural — this literal only ever reads the
    // config's provider/modelId, its schema-normalized loop bound, and the
    // pre-resolved native options (shapes the relay's closed modelOptions
    // universe accepts verbatim, per the Phase 3 boundary fix), so no
    // credential can enter the body by construction.
    const body: Record<string, unknown> = {
      messages: [
        {
          id: RELAY_SYSTEM_MESSAGE_ID,
          parts: [{ content: systemPrompt, type: "text" }],
          role: "system",
        },
        ...request.messages,
      ],
      maxIterations: config.maxIterations,
      modelId: config.modelId,
      ...(modelOptions === undefined ? {} : { modelOptions }),
      provider: config.provider,
    };
    const response = await transport(relayUrl, {
      body: JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      method: "POST",
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(await relayFailureMessage(response));
    }
    return response;
  };
}

/**
 * Selects the chat transport by mode (D1/D2): client mode answers the
 * `connection` currency (the browser-resident loop); server mode answers the
 * `fetcher` currency (the keyless relay POST). The returned value satisfies
 * useChat's `connection` XOR `fetcher` exactly — one arm is always `undefined`.
 */
export function createAgentChatTransport(
  input: AgentChatTransportInput,
  deps: AgentChatTransportDeps = {},
): ChatTransport {
  return input.config.mode === "server"
    ? { fetcher: createRelayFetcher(input, deps) }
    : { connection: createClientDirectConnection(input, deps) };
}

/** Everything {@link useAgentChat} takes; all dynamic values are page-supplied. */
export interface UseAgentChatInput {
  /** The agent config, read from the Phase 1.3 store by the page. */
  readonly config: AgentConfig;
  /** The page's `cad_get_document` summary of the current document. */
  readonly documentSummary: string;
  /** The bridged client tools (the page-mounted webMCP binding). */
  readonly tools: ReadonlyArray<AnyClientTool>;
  /** The selected model's catalog `reasoning_options` entry, when it declares one. */
  readonly reasoningOption?: AgentModelReasoningOption;
  /** Injectable HTTP transport (tests, the session e2e); defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** The relay endpoint override; defaults to `"/api/agent-relay"`. */
  readonly relayUrl?: string;
  /**
   * Injectable adapter factory (the D12 host seam): replaces the Phase 1.2
   * provider dispatch for the client-direct transport — a host that owns its
   * own model plumbing (or a demo with a scripted transport) supplies the
   * adapter; the provider factories' config (`apiKey`/`baseURL`/`fetch`)
   * still arrive validated, but no provider SDK is called.
   */
  readonly createAdapter?: AgentChatTransportDeps["createAdapter"];
}

/**
 * The agent chat runtime hook (Phase 3.3): binds transport, prompt, native
 * model options, and the config's loop bound onto `useChat` and returns the
 * useChat surface unchanged — `stop` and `reload` (retry) ride through as-is.
 *
 * ## The client-rebuild contract (verified against @tanstack/ai-react
 * 0.29.4's `use-chat`)
 *
 * `useChat` constructs its `ChatClient` ONCE per `threadId` — the client
 * memo keys on the thread id alone, and later `connection`/`fetcher`
 * identity changes are never applied to the live client. A transport that
 * silently kept the mount-time object would freeze the first render's mode
 * (a client→server switch would keep calling the provider browser-direct,
 * keys and all) and its first render's prompt context forever. The hook
 * therefore does two things:
 *
 * - the transport's closures read the LIVE inputs through per-field
 *   getters over a latest-ref (`config`, `documentSummary`, … are resolved
 *   at every `connect()`/fetch, never snapshotted), so ordinary input
 *   changes need no new client at all;
 * - a transport-currency change (the `connection` XOR `fetcher` arm — the
 *   mode switch — or an injected seam) mints a NEW thread id, which is the
 * one sanctioned rebuild trigger, seeded with the live transcript
 * (`initialMessages`) so the swap never loses history.
 */
export function useAgentChat(
  input: UseAgentChatInput,
): UseChatReturn<readonly AgentChatTool[]> {
  const { config, tools } = input;
  const fetchOverride = input.fetch;
  const relayUrl = input.relayUrl;
  const createAdapter = input.createAdapter;

  // The latest-ref the transport's getter-input reads through.
  const inputRef = useRef(input);
  inputRef.current = input;

  // The getter-input: one stable object whose fields resolve per read, so
  // the memoized transport stays identity-stable while its behavior stays
  // live. The transport rebuilds only when the CURRENCY changes (the mode
  // arm) or an injected seam does.
  const transportMode = config.mode;
  const liveInput = useMemo<AgentChatTransportInput>(
    () => ({
      get config() {
        return inputRef.current.config;
      },
      get documentSummary() {
        return inputRef.current.documentSummary;
      },
      get reasoningOption() {
        return inputRef.current.reasoningOption;
      },
      get tools() {
        return inputRef.current.tools;
      },
    }),
    [],
  );
  const transport = useMemo<ChatTransport>(() => {
    const deps: AgentChatTransportDeps = {
      ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
      ...(relayUrl === undefined ? {} : { relayUrl }),
      ...(createAdapter === undefined ? {} : { createAdapter }),
    };
    // The same arm switch `createAgentChatTransport` performs, inlined so
    // the mode is a TEXTUAL input of this memo: the currency must flip the
    // transport's identity (a new client follows), while everything the
    // arms read stays live through the getter-input.
    return transportMode === "server"
      ? { fetcher: createRelayFetcher(liveInput, deps) }
      : { connection: createClientDirectConnection(liveInput, deps) };
  }, [createAdapter, fetchOverride, liveInput, relayUrl, transportMode]);

  // The rebuild trigger: a new thread id per transport identity, minted in
  // the render-phase state adjustment (React's adjust-state-when-props-
  // change pattern) so the client swap happens before anything renders.
  const [clientThreadId, setClientThreadId] = useState(
    () => `slopcad-agent-${globalThis.crypto.randomUUID()}`,
  );
  const transportRef = useRef(transport);
  if (transportRef.current !== transport) {
    transportRef.current = transport;
    setClientThreadId(`slopcad-agent-${globalThis.crypto.randomUUID()}`);
  }

  // The transcript seed for a rebuild: the messages as of the previous
  // render (the currency change comes from a settings save, which never
  // touches the transcript). Ignored while the thread id is unchanged.
  const transcriptSeedRef = useRef<readonly UIMessage[]>([]);
  const chat = useChat({
    ...transport,
    initialMessages: [...transcriptSeedRef.current],
    threadId: clientThreadId,
    tools,
  });
  transcriptSeedRef.current = chat.messages;
  return chat;
}
