/**
 * The workbench mount of the agent chat (PLAN-AGENT-CHAT Phase 4.5, M2):
 * the bridge between the page-agnostic Phase 4.4 panel and the workbench
 * page's live surfaces. Mounted INSIDE the workbench composition (not the
 * route layout) so the CadProvider-backed store, the WebMCP binding, and
 * the tRPC client are all alive — this module is where they meet:
 *
 * - the document summary, re-read through the REAL `cad_get_document`
 *   registry tool whenever the outline's inputs change — the document
 *   object, the selection, or the workbench mode (the same path the
 *   agent itself takes — never a second summary implementation);
 * - the selected model's catalog `reasoning_options` entry, looked up
 *   from the same provider-scoped `modelCatalog.list` query the settings
 *   sheet's picker rides (D14);
 * - the Phase 3.4 browser store (OPFS-backed) with the opt-in sync
 *   transport bound to the agentConversations tRPC mutations;
 * - the shared catalog force-refresh handle (D7) — one mutation, one
 *   invalidation — built here and handed to both the settings sheet and
 *   the palette command's target.
 *
 * The agent CONFIG itself is owned one level up (the right sidebar
 * composition), which also owns the settings sheet: applied settings flow
 * down here as a new config prop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ModelCatalogRefreshOutcome } from "@slopcad/api/routers/model-catalog";
import type { CadDocument, SelectionState } from "@slopcad/cad-core";
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import { Settings2Icon } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@slopcad/ui/components/empty";
import type { NamedProviderId } from "@slopcad/api/providers";
import { AGENT_CONVERSATION_TITLE_MAX_LENGTH } from "@slopcad/api/limits";
import type { AgentToolsSurface } from "@slopcad/ui/agent/tools";
import type { AgentConfig } from "@slopcad/ui/agent/config/store";
import type { AgentChatSessionSlot } from "@slopcad/ui/agent/chat/session-slot";
import { AGENT_PROVIDER_IDS } from "@slopcad/ui/agent/providers";
import { AgentChatPanel } from "@slopcad/ui/agent/chat/agent-chat-panel";
import { toast } from "sonner";
import type { AgentChatStore } from "../persistence/store";
import type { AgentSyncTransport } from "../persistence/sync";

import { openBrowserAgentChatStore } from "../persistence/browser";
import { executeWebMcpTool, subscribeWebMcpTools } from "../../webmcp/registry";
import { namedCatalogProviderOf } from "./agent-settings-form";

import { useTRPC } from "@/utils/trpc";

/** A never-aborted signal (the registry takes one; the read is instant). */
const NEVER_ABORT = new AbortController().signal;

/** The refresh outcomes the router declares, for narrowing the wire value. */
const REFRESH_OUTCOMES: readonly ModelCatalogRefreshOutcome[] = [
  "fresh-cache",
  "refetched",
  "not-modified",
  "stale-served",
];

/** Narrows the wire-typed outcome string into the declared union. */
function isRefreshOutcome(value: unknown): value is ModelCatalogRefreshOutcome {
  return (
    typeof value === "string" &&
    REFRESH_OUTCOMES.includes(value as ModelCatalogRefreshOutcome)
  );
}

/**
 * How a FAILED refresh announces itself: the settings sheet reads the
 * `error` note off the handle it renders; the palette dispatch (the menu
 * closes before the command runs) announces through the app's toast.
 */
export type AgentCatalogRefreshNotify = "note" | "toast";

/**
 * The one catalog force-refresh surface (D7) the settings sheet's button
 * and the palette command share — one mutation, one list invalidation.
 */
export interface AgentCatalogRefresh {
  /** True while a refresh is in flight. */
  readonly isPending: boolean;
  /** The last refresh's outcome, once known. */
  readonly outcome: ModelCatalogRefreshOutcome | null;
  /**
   * The last failed refresh's user-readable reason (a protected-procedure
   * auth error, the typed staleOrError gateway error, or a transport
   * failure); `null` while no failure is on record.
   */
  readonly error: string | null;
  /**
   * Force-refreshes the given named provider's catalog cache. `notify`
   * picks the failure surface — `"note"` (the default) leaves the reason
   * on this handle for the sheet to render; `"toast"` also raises it
   * through the app toast for dispatches with no open surface.
   */
  readonly refresh: (
    provider: NamedProviderId,
    notify?: AgentCatalogRefreshNotify,
  ) => void;
}

/**
 * One user-readable line out of a failed refresh: the server's own
 * message when it carries one (the typed staleOrError gateway text, the
 * auth error), a transport line otherwise.
 */
function refreshFailureLine(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return `The catalog refresh failed: ${cause.message.trim()}`;
  }
  return "The catalog refresh failed — the request never reached the server.";
}

/**
 * Builds the shared catalog force-refresh handle (D7). Identity stability
 * is load-bearing: the handle flows into the chat panel's session memo
 * (and through it the palette-commands slot), so the `refresh` function
 * is ref-backed and stable across renders and the handle object is
 * re-minted ONLY when the pending/outcome/error state actually moves — a
 * fresh identity per render would cycle the session-slot notify against
 * the workbench's own re-renders (React's maximum-update-depth error).
 */
export function useAgentCatalogRefresh(): AgentCatalogRefresh {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const refreshMutation = useMutation(
    trpc.modelCatalog.refresh.mutationOptions(),
  );
  const mutationRef = useRef(refreshMutation);
  mutationRef.current = refreshMutation;
  const refresh = useCallback(
    (provider: NamedProviderId, notify: AgentCatalogRefreshNotify = "note") => {
      mutationRef.current.mutate(
        { force: true, provider },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({
              queryKey: trpc.modelCatalog.list.queryKey(),
            });
          },
          onError: (cause) => {
            // A refresh that never produced an outcome must not idle its
            // consumers silently: a dispatch with no open surface (the
            // palette command) announces through the app toast; the
            // sheet reads the handle's error note instead.
            if (notify === "toast") {
              toast.error(refreshFailureLine(cause));
            }
          },
        },
      );
    },
    [queryClient, trpc],
  );
  const outcome = isRefreshOutcome(refreshMutation.data?.outcome)
    ? refreshMutation.data.outcome
    : null;
  // Derived from the mutation itself, so a new dispatch resets it the
  // same way it resets `data` — no stale-failure bookkeeping.
  const error = refreshMutation.isError
    ? refreshFailureLine(refreshMutation.error)
    : null;
  return useMemo(
    () => ({ error, isPending: refreshMutation.isPending, outcome, refresh }),
    [error, outcome, refresh, refreshMutation.isPending],
  );
}

/**
 * Reads the compact document outline through the real `cad_get_document`
 * registry tool and keeps it as the string the panel's sync getter
 * serves. The outline reports more than the document object, and not all
 * of it rides the document's identity: the selection is its own store
 * concern (a selection change cannot re-render a document-only
 * subscriber) and the workbench mode is page-level state — so both ride
 * this effect's inputs explicitly and re-derive the summary exactly like
 * a new document object does. A refused read degrades to the empty
 * summary (the system prompt then carries the instruction block only) —
 * with one retry on the registry's next change: child effects run BEFORE
 * the workbench page's own binding effect, so the very first read can
 * race the tool's registration and must re-run once the toolset lands.
 */
export function useDocumentSummary(
  document: CadDocument,
  selection: SelectionState,
  mode: string,
): () => string {
  const [summary, setSummary] = useState("");
  useEffect(() => {
    let cancelled = false;
    let unsubscribeRetry: (() => void) | null = null;
    const read = () => {
      void executeWebMcpTool(
        "cad_get_document",
        {},
        { signal: NEVER_ABORT },
      ).then((result) => {
        if (cancelled) {
          return;
        }
        const next = result.ok ? result.result : "";
        setSummary((previous) => (previous === next ? previous : next));
        if (result.ok) {
          if (unsubscribeRetry !== null) {
            unsubscribeRetry();
            unsubscribeRetry = null;
          }
          return;
        }
        if (unsubscribeRetry === null) {
          unsubscribeRetry = subscribeWebMcpTools(read);
        }
      });
    };
    read();
    return () => {
      cancelled = true;
      if (unsubscribeRetry !== null) {
        unsubscribeRetry();
      }
    };
    // The revision signals, spelled out: the document object's identity
    // (the engine mints a new object per committed transaction) plus the
    // selection and mode, whose changes never ride that identity.
  }, [document, mode, selection]);
  return useCallback(() => summary, [summary]);
}

/** Everything the right-sidebar composition injects into the chat view. */
export interface AgentChatSidebarViewProps {
  /** The live agent config (owned by the host; settings saves land here). */
  readonly config: AgentConfig;
  /**
   * The live workbench document; its identity is the summary's commit
   * revision signal (the engine mints a new object per commit).
   */
  readonly document: CadDocument;
  /**
   * The live selection state; a change re-derives the summary (the
   * outline reports it, and it does not ride the document's identity —
   * it is the store's own selection concern).
   */
  readonly selection: SelectionState;
  /**
   * The page-level workbench mode; a change re-derives the summary (the
   * outline reports it, and page state never rides the document's
   * identity).
   */
  readonly mode: string;
  /** The page's bound webMCP tool set + executor (M2's binding). */
  readonly toolsSurface: AgentToolsSurface;
  /** The palette-commands slot the panel reports its session into (4.4). */
  readonly sessionSlot: AgentChatSessionSlot | null;
  /** Opens the host's agent settings sheet. */
  readonly onOpenSettings: () => void;
  /** The shared catalog force-refresh (the palette command's target). */
  readonly catalogRefresh: AgentCatalogRefresh;
  /** The setup walkthrough injected as the panel's empty state. */
  readonly emptyState?: ReactNode;
}

export function AgentChatSidebarView({
  catalogRefresh,
  config,
  document,
  emptyState,
  mode,
  onOpenSettings,
  selection,
  sessionSlot,
  toolsSurface,
}: AgentChatSidebarViewProps): ReactElement {
  const trpc = useTRPC();

  // The document summary through the real tool path.
  const getDocumentSummary = useDocumentSummary(document, selection, mode);

  // The selected model's reasoning option (D8): the provider-scoped
  // catalog query, deduped with the settings sheet's by key. The
  // disabled-state input is the canonical list's first id (never a
  // hand-picked provider): the query never runs without a named one.
  const namedProvider = namedCatalogProviderOf(config.provider);
  const catalogQuery = useQuery(
    trpc.modelCatalog.list.queryOptions(
      { provider: namedProvider ?? AGENT_PROVIDER_IDS[0] },
      { enabled: namedProvider !== null, retry: false },
    ),
  );
  const reasoningOption = useMemo((): ModelReasoningOption | undefined => {
    if (namedProvider === null || config.modelId === null) {
      return undefined;
    }
    const options = catalogQuery.data?.find(
      (entry) => entry.modelId === config.modelId,
    )?.reasoningOptions;
    return options === null || options === undefined ? undefined : options[0];
  }, [catalogQuery.data, config.modelId, namedProvider]);

  // The opt-in sync transport: the agentConversations mutations, bound
  // through a latest-ref (the store mints once, the handlers stay live).
  const createMutation = useMutation(
    trpc.agentConversations.create.mutationOptions(),
  );
  const appendMutation = useMutation(
    trpc.agentConversations.append.mutationOptions(),
  );
  const deleteMutation = useMutation(
    trpc.agentConversations.delete.mutationOptions(),
  );
  const mutationsRef = useRef({
    appendMutation,
    createMutation,
    deleteMutation,
  });
  mutationsRef.current = { appendMutation, createMutation, deleteMutation };
  const syncTransport = useMemo<AgentSyncTransport>(
    () => ({
      appendMessage: async (input) => {
        const dto =
          await mutationsRef.current.appendMutation.mutateAsync(input);
        // The wire dto's `parts` is optional-unknown; the sync contract
        // requires the key present — null is the honest absent value.
        return { ...dto, parts: dto.parts ?? null };
      },
      createConversation: (input) =>
        mutationsRef.current.createMutation.mutateAsync(input),
      deleteConversation: async (input) => {
        await mutationsRef.current.deleteMutation.mutateAsync(input);
      },
    }),
    [],
  );

  // The sync opt-in reads the LIVE config through the same ref pattern, so
  // toggling sync in settings never remounts the store.
  const configRef = useRef(config);
  configRef.current = config;

  // The OPFS-backed store opens once per mount; a failed open degrades to
  // the panel's designed ephemeral mode (store: null).
  const [store, setStore] = useState<AgentChatStore | null>(null);
  useEffect(() => {
    let cancelled = false;
    openBrowserAgentChatStore({
      sync: {
        enabled: () => configRef.current.syncEnabled,
        transport: syncTransport,
      },
    })
      .then((opened) => {
        if (!cancelled) {
          setStore(opened);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStore(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [syncTransport]);

  // The palette command's catalog refresh target (D7): the configured
  // named provider's cache. openai-compatible has no catalog (D14 — its
  // models come from the endpoint itself), and an unconfigured agent has
  // no scope to refresh, so those calls stay inert. The command runs with
  // the menu already closed, so its failure surface is the app toast.
  const handleForceRefreshCatalog = useCallback(() => {
    if (namedProvider === null) {
      return;
    }
    catalogRefresh.refresh(namedProvider, "toast");
  }, [catalogRefresh, namedProvider]);

  return (
    <AgentChatPanel
      config={config}
      conversationTitleMaxLength={AGENT_CONVERSATION_TITLE_MAX_LENGTH}
      emptyState={emptyState}
      getDocumentSummary={getDocumentSummary}
      onForceRefreshCatalog={handleForceRefreshCatalog}
      onOpenSettings={onOpenSettings}
      reasoningOption={reasoningOption}
      sessionSlot={sessionSlot}
      store={store}
      toolsSurface={toolsSurface}
    />
  );
}

/**
 * The setup walkthrough shown while the transcript is empty and the agent
 * is unconfigured (D5): three steps and the settings opener, zero vendor
 * or marketing copy.
 */
export function AgentChatEmptyState({
  onOpenSettings,
}: {
  readonly onOpenSettings: () => void;
}): ReactElement {
  return (
    <Empty className="justify-center py-8" data-testid="agent-chat-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Settings2Icon />
        </EmptyMedia>
        <EmptyTitle>Set up the agent</EmptyTitle>
        <EmptyDescription>
          The chat needs a provider and a model before it can send. Nothing is
          preselected; your API key stays in this browser.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <ol className="list-decimal space-y-1 pl-5 text-left">
          <li>Open agent settings.</li>
          <li>Pick a provider, a model, and paste its API key.</li>
          <li>Ask for a change — the agent runs the workbench's own tools.</li>
        </ol>
        <Button
          aria-label="Open agent settings"
          data-testid="agent-chat-empty-open-settings"
          onClick={onOpenSettings}
          size="sm"
          type="button"
        >
          <Settings2Icon />
          Open agent settings
        </Button>
      </EmptyContent>
    </Empty>
  );
}
