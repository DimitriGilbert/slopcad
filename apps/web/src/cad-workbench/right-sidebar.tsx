/**
 * The workbench's right sidebar (PLAN-AGENT-CHAT Phase 4.5, D16): the
 * properties/parameters/configuration dock, now a TWO-VIEW container —
 * a segmented control at its top switches between the dock's panels and
 * the agent chat that replaces them while active — and a USER-RESIZABLE
 * one: the hardcoded width is gone, a drag handle (plus the keyboard
 * separator pattern) sets it, and the size persists per browser with the
 * sibling layout state.
 *
 * Restore semantics (D16's "switching back restores the previous content
 * and its state"): while the chat is active the panels column is HIDDEN,
 * never unmounted — the same discipline the workspace row applies to
 * sketch mode — so every scroll position and control state survives the
 * round trip; the chat view, conversely, mounts only while active and
 * restores its transcript through the Phase 3.4 persistence store.
 *
 * Searched before building: the repo carries no reusable resizer or
 * panel-resize pattern, so the width logic lives in
 * `./right-sidebar-size` (node-tested) and the handle chrome here.
 *
 * The agent wiring (config state, settings sheet, shared catalog
 * refresh) is owned HERE — one composition point under the workbench
 * page (M2), where the CadProvider-backed document and the WebMCP tool
 * binding are alive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import type { CadDocument } from "@slopcad/cad-core";
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import { MessageSquareTextIcon, PanelsTopLeftIcon } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import type { AgentToolsSurface } from "@slopcad/ui/agent/tools";
import type { AgentChatSessionSlot } from "@slopcad/ui/agent/chat/session-slot";
import type { AgentChatView } from "../agent/chat/view-state";
import {
  createAgentConfigStore,
  getBrowserAgentConfigStorage,
  isAgentConfigured,
  type AgentConfig,
  type AgentConfigSetResult,
} from "@slopcad/ui/agent/config/store";

import { AgentSettingsSheet } from "../agent/chat/agent-settings";
import {
  agentConfigPatchFromSettingsValues,
  type AgentSettingsValues,
} from "../agent/chat/agent-settings-form";
import {
  AgentChatEmptyState,
  AgentChatSidebarView,
  useAgentCatalogRefresh,
} from "../agent/chat/workbench-chat-view";
import {
  isRightSidebarResizeKey,
  keyboardResizeRightSidebar,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  useRightSidebarWidth,
} from "./right-sidebar-size";

/**
 * The pure panel-visibility mapping — `hidden` (state-preserving display
 * toggle), never unmount, per D16's restore semantics. Node-tested in
 * the sibling spec.
 */
export function rightSidebarPanelsClassName(
  view: AgentChatView,
): "hidden" | "flex" {
  return view === "chat" ? "hidden" : "flex";
}

/** Everything the workbench composition injects into the right sidebar. */
export interface WorkbenchRightSidebarProps {
  /** The shared right-sidebar view (the palette toggle rides it too). */
  readonly view: AgentChatView;
  /** Sets the view (the view-state module's setter, 4.4). */
  readonly onViewChange: (view: AgentChatView) => void;
  /** The live workbench document (the chat's context summary source). */
  readonly document: CadDocument;
  /** The page's bound webMCP tools + executor (M2). */
  readonly toolsSurface: AgentToolsSurface;
  /** The palette-commands slot the chat panel reports into (4.4). */
  readonly sessionSlot: AgentChatSessionSlot | null;
  /** The drawer-open state below `xl` (the composition's own toggle). */
  readonly drawerOpen: boolean;
  /** The right dock's property panel (the composition's slot default). */
  readonly propertyPanel: ReactNode;
  /** The right dock's parameter panel. */
  readonly parameterPanel: ReactNode;
  /** The right dock's configuration panel. */
  readonly configurationPanel: ReactNode;
}

export function WorkbenchRightSidebar({
  configurationPanel,
  document,
  drawerOpen,
  onViewChange,
  parameterPanel,
  propertyPanel,
  sessionSlot,
  toolsSurface,
  view,
}: WorkbenchRightSidebarProps): ReactElement {
  const { setWidth, width } = useRightSidebarWidth();

  // The agent config: the browser store is pull-only, so it is read into
  // state AFTER hydration (the view-state idiom — the first render never
  // depends on storage) and updated by applied settings below. Until a
  // choice is stored the config is the unconfigured default (D5).
  const configStore = useMemo(() => {
    const storage = getBrowserAgentConfigStorage();
    return storage === null ? null : createAgentConfigStore(storage);
  }, []);
  const [config, setConfig] = useState<AgentConfig>(unconfiguredAgentConfig);
  useEffect(() => {
    if (configStore !== null) {
      setConfig(configStore.get());
    }
  }, [configStore]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Where the settings sheet returns focus: captured at OPEN time because
  // the opener varies (the walkthrough's button, the composer's model
  // slot, the palette command) — the io dialogs' finalFocus discipline.
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const openSettings = useCallback(() => {
    // `globalThis`: the component's own `document` prop (the CAD
    // document) shadows the browser global inside this scope.
    const active = globalThis.document.activeElement;
    settingsReturnFocusRef.current =
      active instanceof HTMLElement && active !== globalThis.document.body
        ? active
        : null;
    setSettingsOpen(true);
  }, []);

  const catalogRefresh = useAgentCatalogRefresh();

  /** The settings sheet's apply seam: patch → store write → live config. */
  const handleApplySettings = useCallback(
    (
      values: AgentSettingsValues,
      reasoningOption: ModelReasoningOption | undefined,
    ): AgentConfigSetResult => {
      if (configStore === null) {
        return {
          ok: false,
          error: new Error("Browser storage is unavailable in this context."),
        };
      }
      const result = configStore.set(
        agentConfigPatchFromSettingsValues(values, {
          config,
          reasoningOption,
        }),
      );
      if (result.ok) {
        setConfig(configStore.get());
      }
      return result;
    },
    [config, configStore],
  );

  // The resize handle's keyboard side: the separator pattern's four keys,
  // clamped and persisted by the width hook.
  const handleResizeKeydown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isRightSidebarResizeKey(event.key)) {
        return;
      }
      event.preventDefault();
      setWidth(keyboardResizeRightSidebar(width, event.key));
    },
    [setWidth, width],
  );

  // The drag side: pointer capture on the handle, width = the dock's own
  // right edge minus the pointer (the dock is right-anchored at every
  // breakpoint), clamped by the setter.
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Capture keeps the drag tracking through moves outside the thin
      // handle; the prevented default stops text selection mid-drag.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsDragging(true);
    },
    [],
  );
  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) {
        return;
      }
      const dock = dockRef.current;
      if (dock === null) {
        return;
      }
      const right = dock.getBoundingClientRect().right;
      setWidth(right - event.clientX);
    },
    [isDragging, setWidth],
  );
  const handleResizePointerEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  const chatView = (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentChatSidebarView
        catalogRefresh={catalogRefresh}
        config={config}
        document={document}
        emptyState={
          isAgentConfigured(config) ? undefined : (
            <AgentChatEmptyState onOpenSettings={openSettings} />
          )
        }
        onOpenSettings={openSettings}
        sessionSlot={sessionSlot}
        toolsSurface={toolsSurface}
      />
    </div>
  );

  return (
    <div
      className={`border-border bg-card absolute inset-y-0 right-0 z-30 flex shrink-0 flex-col border-l shadow-2xl transition-[transform,visibility] duration-200 xl:relative xl:z-auto xl:bg-card/40 xl:shadow-none ${
        drawerOpen
          ? "visible translate-x-0"
          : "invisible translate-x-full xl:visible xl:translate-x-0"
      }`}
      data-agent-view={view}
      data-testid="workbench-panels-dock"
      ref={dockRef}
      style={{ width }}
    >
      {/* The view switch (D16): a segmented pair at the top of the dock.
          Both buttons are always in the tab order; `aria-pressed` names
          the active view. */}
      <div
        aria-label="Right sidebar view"
        className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2"
        data-testid="right-sidebar-view-switch"
        role="group"
      >
        <Button
          aria-pressed={view === "sidebar"}
          data-testid="right-sidebar-view-panels"
          onClick={() => {
            onViewChange("sidebar");
          }}
          size="xs"
          type="button"
          variant={view === "sidebar" ? "secondary" : "ghost"}
        >
          <PanelsTopLeftIcon />
          Panels
        </Button>
        <Button
          aria-pressed={view === "chat"}
          data-testid="right-sidebar-view-chat"
          onClick={() => {
            onViewChange("chat");
          }}
          size="xs"
          type="button"
          variant={view === "chat" ? "secondary" : "ghost"}
        >
          <MessageSquareTextIcon />
          Agent chat
        </Button>
      </div>

      {/* The panels column: HIDDEN while chat is active — never
          unmounted, so both sides' state survives the switch (D16). */}
      <div
        className={`${rightSidebarPanelsClassName(view)} min-h-0 flex-1 flex-col`}
      >
        <div className="max-h-[55%] min-h-0 shrink-0 overflow-y-auto">
          {propertyPanel}
        </div>
        {/* The parameter dock: the panel owns its internal scroll so the
            pinned Apply footer stays on screen at any height. */}
        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
          {parameterPanel}
        </div>
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border">
          {configurationPanel}
        </div>
      </div>

      {/* The chat mounts only while its view is active (D16); the
          transcript restores from the persistence store on reopen. */}
      {view === "chat" ? chatView : null}

      {/* The resize handle (D16): the separator a11y pattern — drag with
          pointer capture, arrows/Home/End by keyboard, min/max clamped,
          size persisted by the width hook. */}
      <div
        aria-label="Resize the right sidebar"
        aria-orientation="vertical"
        aria-valuemax={RIGHT_SIDEBAR_MAX_WIDTH}
        aria-valuemin={RIGHT_SIDEBAR_MIN_WIDTH}
        aria-valuenow={Math.round(width)}
        className={`absolute inset-y-0 left-0 z-40 w-1.5 -translate-x-1/2 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${
          isDragging ? "bg-primary/40" : "bg-transparent"
        }`}
        data-testid="right-sidebar-resize-handle"
        onKeyDown={handleResizeKeydown}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        role="separator"
        tabIndex={0}
      />

      {/* The settings sheet mounts only while open (the io dialogs'
          discipline: a closed dialog never enters the rendered tree). */}
      {settingsOpen ? (
        <AgentSettingsSheet
          catalogRefresh={catalogRefresh}
          config={config}
          finalFocus={settingsReturnFocusRef}
          onApplySettings={handleApplySettings}
          onOpenChange={setSettingsOpen}
          open
        />
      ) : null}
    </div>
  );
}

/** The store's unconfigured default (D5: provider and model are null). */
const unconfiguredAgentConfig: AgentConfig = {
  apiKeyByProvider: {},
  maxIterations: 5,
  mode: "client",
  modelId: null,
  openAiCompatibleBaseUrl: null,
  provider: null,
  reasoning: null,
  syncEnabled: false,
  systemPrompt: null,
};
