/**
 * The agent chat orchestrator (PLAN-AGENT-CHAT Phase 4.4): the panel that
 * composes the whole chat surface — the Phase 3.3 runtime hook underneath,
 * the Phase 4.3 parts dispatcher over its messages, the Phase 4.2 prompt
 * form as the composer, and the Phase 3.4 store through the persistence
 * controller (resume on mount, append on message completion, delete on
 * clear).
 *
 * Page-agnostic by contract: every dynamic thing arrives as a prop — the
 * agent config, the document-summary getter, the bridged tools surface,
 * the settings opener, the catalog force-refresh, and the persistence
 * handle. Nothing here imports a page, a workbench store, or tRPC; the
 * Phase 4.5 right-sidebar mount (and, later, the registry host) injects
 * all of it.
 *
 * The panel reports its live surface into the injected session slot so
 * the palette commands (authored alongside this component) dispatch to
 * the one live instance; while unmounted the slot holds null and those
 * commands render disabled — never a no-op handler.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { MessageSquarePlusIcon, Settings2Icon, Trash2Icon } from "lucide-react";
import type { AgentModelReasoningOption } from "../model-options";
import type { AgentConfig } from "../config/store";
import type { AgentChatPersistenceStore } from "./agent-chat-controller";
import type { AgentChatSyncStatus } from "./status-lines";
import type { AgentChatMessage } from "./parts/part-types";
import type { AgentChatSessionSlot } from "./session-slot";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "../../components/message-scroller";
import { Message, MessageContent } from "../../components/message";
import { Bubble, BubbleContent } from "../../components/bubble";
import { Button } from "../../components/button";
import { useAgentChat, type AgentChatTransportDeps } from "../use-agent-chat";
import { createAgentTools, type AgentToolsSurface } from "../tools";
import { createAgentChatController } from "./agent-chat-controller";
import { agentComposerGate, agentModelSummary } from "./composer-gate";
import { agentPendingStatusLine, formatAgentSyncStatus } from "./status-lines";
import { PromptForm } from "./prompt-form";
import { PartSpinner } from "./parts/busy";
import { AgentMessageParts } from "./parts/message-parts";

/** Everything the panel takes; every dynamic value is host-injected. */
export interface AgentChatPanelProps {
  /** The live agent config (the host reads the Phase 1.3 store). */
  readonly config: AgentConfig;
  /** Reads the current document summary (the system prompt's context). */
  readonly getDocumentSummary: () => string;
  /** The host's webMCP binding, bridged here into the chat's client tools. */
  readonly toolsSurface: AgentToolsSurface;
  /** The selected model's catalog `reasoning_options` entry, when it declares one. */
  readonly reasoningOption?: AgentModelReasoningOption;
  /** Opens the host's agent settings surface (the composer's model slot). */
  readonly onOpenSettings: () => void;
  /** Force-refreshes the host's model catalog (the palette command's target). */
  readonly onForceRefreshCatalog: () => void;
  /**
   * The host-injected persistence handle (D12); `null` = ephemeral,
   * nothing persists. The slopcad app passes its Phase 3.4 store, which
   * satisfies the structural contract.
   */
  readonly store: AgentChatPersistenceStore | null;
  /** The slot the panel reports its live session into (palette commands). */
  readonly sessionSlot: AgentChatSessionSlot | null;
  /**
   * Rendered inside the transcript while it is empty and nothing is
   * streaming (Phase 4.5: the host's setup walkthrough).
   */
  readonly emptyState?: ReactNode;
  /** Injectable HTTP transport (tests, the session e2e). */
  readonly fetch?: typeof globalThis.fetch;
  /** The relay endpoint override; defaults to `"/api/agent-relay"`. */
  readonly relayUrl?: string;
  /**
   * Injectable adapter factory (D12's transport injection): replaces the
   * provider dispatch for client-direct runs — the host that owns its model
   * plumbing (or a demo with a scripted transport) supplies the adapter and
   * no provider SDK is called. Stability contract: referential stability is
   * NOT required — the runtime hook holds the seam behind a latest-ref and
   * rebuilds the transport (new thread id) only on a mode change, so an
   * inline arrow re-created per render cannot reset a live conversation.
   * The seam in force is the one current at the last mode-driven rebuild.
   */
  readonly createAdapter?: AgentChatTransportDeps["createAdapter"];
  /**
   * The host's conversation-title bound (Phase 5's registry lift): the
   * slopcad app passes `AGENT_CONVERSATION_TITLE_MAX_LENGTH`; absent means
   * lazily created titles are unbounded.
   */
  readonly conversationTitleMaxLength?: number;
}

/** One readable line out of an unknown thrown value. */
function errorLine(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return reason;
  }
  return "The request failed for an unknown reason.";
}

/** A user message's concatenated text (its parts are text-only). */
function userTextOf(message: AgentChatMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") {
      text += part.content;
    }
  }
  return text;
}

/**
 * The agent chat panel: transcript, status surfaces, lifecycle buttons,
 * and the composer. See the module doc for the page-agnosticism contract.
 */
export function AgentChatPanel({
  config,
  conversationTitleMaxLength,
  createAdapter,
  emptyState,
  fetch: fetchOverride,
  getDocumentSummary,
  onForceRefreshCatalog,
  onOpenSettings,
  reasoningOption,
  relayUrl,
  sessionSlot,
  store,
  toolsSurface,
}: AgentChatPanelProps): ReactElement {
  // The bridged client tools: one bridge per host-supplied surface.
  const tools = useMemo(() => createAgentTools(toolsSurface), [toolsSurface]);
  // The runtime hook (Phase 3.3). The document summary is read per render
  // through the getter and consumed through the hook's live getter-input,
  // so the memoized transport stays identity-stable across document
  // changes — only a transport-currency change re-binds it.
  const chat = useAgentChat({
    config,
    documentSummary: getDocumentSummary(),
    ...(reasoningOption === undefined ? {} : { reasoningOption }),
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
    ...(relayUrl === undefined ? {} : { relayUrl }),
    ...(createAdapter === undefined ? {} : { createAdapter }),
    tools,
  });

  const isBusy = chat.status === "submitted" || chat.status === "streaming";
  const gate = agentComposerGate(config);

  // The controller reads the live chat through a latest-ref (its methods
  // run from effects and handlers after renders have moved on).
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const controller = useMemo(
    () =>
      createAgentChatController({
        getChat: () => chatRef.current,
        store,
        ...(conversationTitleMaxLength === undefined
          ? {}
          : { titleMaxLength: conversationTitleMaxLength }),
      }),
    [conversationTitleMaxLength, store],
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  // Resume the newest saved conversation once per store binding.
  useEffect(() => {
    void controller.start();
  }, [controller]);

  // Persist every message the hook produces exactly once — at RUN
  // COMPLETION, never per stream delta (ids arrive long before their
  // parts finish; the controller skips the passes while the run is
  // live, so the effect must also ride the status signal to fire the
  // one completion pass).
  useEffect(() => {
    controller.receiveMessages(chat.messages);
  }, [controller, chat.messages, chat.status]);

  // Surface the store's sync status (failures never silent, D3).
  const [syncStatus, setSyncStatus] = useState<AgentChatSyncStatus | null>(
    null,
  );
  useEffect(() => {
    if (store === null) {
      setSyncStatus(null);
      return;
    }
    setSyncStatus(store.getSyncStatus());
    return store.onSyncStatusChange(setSyncStatus);
  }, [store]);
  const syncLine =
    syncStatus === null ? null : formatAgentSyncStatus(syncStatus);

  // A send whose promise rejected without surfacing through the hook's
  // error state still reaches the user through this line.
  const [sendError, setSendError] = useState<string | null>(null);
  const handleSend = useCallback(
    (text: string) => {
      setSendError(null);
      void chat.sendMessage(text).catch((reason: unknown) => {
        setSendError(errorLine(reason));
      });
    },
    [chat],
  );

  // The live session this panel reports for the palette commands.
  const hasConversation =
    snapshot.conversationId !== null || chat.messages.length > 0;
  const session = useMemo(
    () => ({
      clearConversation: () => {
        void controller.clearConversation();
      },
      forceRefreshCatalog: onForceRefreshCatalog,
      hasConversation,
      openSettings: onOpenSettings,
    }),
    [controller, hasConversation, onForceRefreshCatalog, onOpenSettings],
  );
  useEffect(() => {
    if (sessionSlot === null) {
      return;
    }
    sessionSlot.set(session);
    return () => {
      sessionSlot.set(null);
    };
  }, [session, sessionSlot]);

  const pendingLine = agentPendingStatusLine({
    busy: isBusy,
    messages: chat.messages,
  });
  const runError = chat.error === undefined ? sendError : chat.error.message;
  const lastMessage = chat.messages.at(-1);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col"
      data-testid="agent-chat-panel"
    >
      {/* The lifecycle row: the conversation verbs plus the resumed
          conversation's title when one was loaded. */}
      <div
        className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-2"
        data-testid="agent-chat-header"
      >
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">
          {snapshot.conversationTitle === null
            ? "Agent chat"
            : snapshot.conversationTitle}
        </span>
        <Button
          aria-label="Start a new agent conversation"
          data-testid="agent-chat-new"
          onClick={() => {
            controller.newConversation();
          }}
          size="icon-xs"
          title="Start a new agent conversation"
          type="button"
          variant="ghost"
        >
          <MessageSquarePlusIcon />
        </Button>
        <Button
          aria-label="Clear the agent conversation"
          data-testid="agent-chat-clear"
          disabled={!hasConversation}
          onClick={() => {
            void controller.clearConversation();
          }}
          size="icon-xs"
          title="Clear the agent conversation"
          type="button"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      </div>

      {/* The transcript: per-user-message scroll anchoring (the scroller
          primitive's own idiom), parts rendered through the Phase 4.3
          dispatcher whose in-part status lines ARE the persistent
          history — they ride the messages into the store. */}
      <MessageScrollerProvider>
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="flex w-full flex-col gap-4 px-3 py-3">
              {chat.messages.length === 0 && pendingLine === null
                ? emptyState
                : null}
              {chat.messages.map((message) =>
                message.role === "user" ? (
                  <MessageScrollerItem
                    key={message.id}
                    messageId={message.id}
                    scrollAnchor={true}
                  >
                    <Message align="end">
                      <MessageContent>
                        <Bubble align="end" variant="muted">
                          <BubbleContent>{userTextOf(message)}</BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <Message align="start">
                      <MessageContent>
                        <AgentMessageParts
                          parts={message.parts}
                          streaming={isBusy && message.id === lastMessage?.id}
                        />
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                ),
              )}
              {pendingLine === null ? null : (
                <div
                  className="flex items-center gap-2 px-1.5 text-xs text-muted-foreground"
                  data-testid="agent-chat-pending"
                >
                  <PartSpinner />
                  <span className="leading-none">{pendingLine}</span>
                </div>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* The status surfaces: persistence failures (with their at-rest
          retry), run errors with their retry, and the sync line (with
          its explicit retry when failed). */}
      {snapshot.error === null ? null : (
        <div
          className="flex items-start gap-2 px-3 pt-2 text-xs text-destructive"
          data-testid="agent-chat-persistence-error"
        >
          <span className="min-w-0 wrap-break-word">{snapshot.error}</span>
          <Button
            aria-label="Retry saving the agent conversation"
            onClick={() => {
              controller.retryPersistence();
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            Retry save
          </Button>
        </div>
      )}
      {runError === null ? null : (
        <div
          className="flex items-start gap-2 px-3 pt-2 text-xs text-destructive"
          data-testid="agent-chat-error"
        >
          <span className="min-w-0 wrap-break-word">{runError}</span>
          {isBusy ? null : (
            <Button
              aria-label="Retry the last agent message"
              onClick={() => {
                setSendError(null);
                void controller.retryRun();
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {syncLine === null ? null : (
        <p
          className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground"
          data-testid="agent-chat-sync-status"
        >
          <span className="min-w-0 wrap-break-word">{syncLine}</span>
          {syncStatus?.state === "failed" && store !== null ? (
            <Button
              aria-label="Retry syncing the agent conversation"
              onClick={() => {
                void store.syncNow();
              }}
              size="xs"
              type="button"
              variant="outline"
            >
              Retry sync
            </Button>
          ) : null}
        </p>
      )}

      {/* The composer: the Phase 4.2 prompt form with the model slot
          (provider/model summary + the settings opener) and the D5
          disabled-with-reason gate. */}
      <div className="px-3 pt-2 pb-3">
        <PromptForm
          disabled={gate.disabled}
          disabledReason={gate.reason === null ? undefined : gate.reason}
          isBusy={isBusy}
          modelSlot={
            <Button
              aria-label="Open agent settings"
              onClick={onOpenSettings}
              size="xs"
              title="Open agent settings"
              type="button"
              variant="ghost"
            >
              <Settings2Icon />
              <span className="max-w-40 truncate">
                {agentModelSummary(config)}
              </span>
            </Button>
          }
          onSubmit={handleSend}
          onStop={chat.stop}
        />
      </div>
    </div>
  );
}
