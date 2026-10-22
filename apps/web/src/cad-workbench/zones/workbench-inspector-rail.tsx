/**
 * RIGHT — `WorkbenchInspectorRail`, the dock that says what the current
 * SELECTION is, and what the armed tool will do to it.
 *
 * ## What this replaces
 *
 * `right-sidebar.tsx`, the last cockpit surface still on legacy tokens.
 * It was `border-border bg-card shadow-2xl` with `xl:bg-card/40`, a
 * `hover:bg-primary/30` resize handle, a two-button segmented switch of
 * text `Button`s, and three panels whose heights were HARD-CODED
 * PERCENTAGES — `max-h-[55%]` properties, `flex-1` parameters,
 * `max-h-[45%]` configurations — none of them collapsible, reorderable,
 * or given to the operator. Below 1280px the whole dock was an
 * off-canvas `invisible translate-x-full` drawer behind a scrim, driven
 * by a toggle that only existed below that width.
 *
 * ## What it is now
 *
 * A `Panel flush` on cockpit tokens whose body is a stack of collapsible
 * `PanelSection`s — **Selection**, **Measurement** (moved here from the
 * LEFT rail by LAYOUT.md 3.6: a measurement is a property of the
 * selection, not part of the document's structure), **Parameters**,
 * **Configurations** — each disclosing on its own, each flowing
 * naturally. No percentage caps: the operator closes what they are not
 * using. Every inner panel renders `hideHeader`, so the section's
 * disclosure strip is the ONE name strip per concern.
 *
 * The collapse contract is the model rail's: expanded at the persisted
 * drag width, collapsed at `--rail-w-icon`, in the flex flow at every
 * width, with a permanent toggle that reports `aria-expanded`. The
 * collapsed rail keeps the view switch and gains one mark per section,
 * each of which expands the rail and discloses its section.
 *
 * ## What is deliberately kept
 *
 * - the **two-view contract** (D16): the panels column is HIDDEN, never
 *   unmounted, while the chat is active, so every scroll position and
 *   control state survives the round trip; the chat mounts only while
 *   active and restores its transcript from the persistence store;
 * - the **resize separator** and its full a11y pattern (drag with
 *   pointer capture, arrows/Home/End, `aria-valuemin`/`max`/`now`),
 *   now drawn on `--select-edge` and `--focus` instead of `--primary`;
 * - every `data-testid`, `data-agent-view`, and accessible name. The
 *   view switch's buttons became ICON controls (the step-2 dialect), and
 *   their `aria-label`s carry the exact words the text buttons printed.
 * - the agent wiring (config state, settings sheet, catalog refresh),
 *   which is owned HERE — one composition point under the workbench
 *   page, where the CadProvider document and the WebMCP tool binding are
 *   alive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";
import type { CadDocument, SelectionState } from "@slopcad/cad-core";
import type { ModelReasoningOption } from "@slopcad/db/schema/model-catalog";
import {
  Grid3x3,
  MessageSquareTextIcon,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeftIcon,
  Ruler,
  SlidersHorizontal,
  SquareDashedMousePointer,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Panel,
  PanelBody,
  PanelSection,
} from "@slopcad/ui/components/cockpit/panel";
import {
  ToolButton,
  ToolValueGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import { ToolOptionsPanel } from "@slopcad/ui/components/cockpit/tool-options-bar";
import type { ToolOptionsDescriptor } from "@slopcad/ui/components/cockpit/tool-options-bar";
import type { AgentToolsSurface } from "@slopcad/ui/agent/tools";
import type { AgentChatSessionSlot } from "@slopcad/ui/agent/chat/session-slot";
import type { AgentChatView } from "../../agent/chat/view-state";
import {
  createAgentConfigStore,
  getBrowserAgentConfigStorage,
  isAgentConfigured,
  type AgentConfig,
  type AgentConfigSetResult,
} from "@slopcad/ui/agent/config/store";
import type { WorkbenchRailSectionId } from "../rail-state";

import { AgentSettingsSheet } from "../../agent/chat/agent-settings";
import {
  agentConfigPatchFromSettingsValues,
  type AgentSettingsValues,
} from "../../agent/chat/agent-settings-form";
import {
  AgentChatEmptyState,
  AgentChatSidebarView,
  useAgentCatalogRefresh,
} from "../../agent/chat/workbench-chat-view";
import {
  isRightSidebarResizeKey,
  keyboardResizeRightSidebar,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  useRightSidebarWidth,
} from "../right-sidebar-size";

/**
 * The pure panel-visibility mapping — `hidden` (state-preserving display
 * toggle), never unmount, per D16's restore semantics. Node-tested in
 * the sibling spec.
 */
export function inspectorRailPanelsClassName(
  view: AgentChatView,
): "hidden" | "flex" {
  return view === "chat" ? "hidden" : "flex";
}

/** The rail's four sections, in rail order, with their icon-rail marks. */
const SECTIONS: readonly {
  readonly id: WorkbenchRailSectionId;
  readonly title: string;
  readonly icon: LucideIcon;
}[] = [
  {
    icon: SquareDashedMousePointer,
    id: "inspector-selection",
    title: "Selection",
  },
  { icon: Ruler, id: "inspector-measurement", title: "Measurement" },
  { icon: SlidersHorizontal, id: "inspector-parameters", title: "Parameters" },
  { icon: Grid3x3, id: "inspector-configurations", title: "Configurations" },
];

/** Everything the workbench composition injects into the inspector rail. */
export interface WorkbenchInspectorRailProps {
  /** The shared right-sidebar view (the palette toggle rides it too). */
  readonly view: AgentChatView;
  /** Sets the view (the view-state module's setter, 4.4). */
  readonly onViewChange: (view: AgentChatView) => void;
  /** The live workbench document (the chat's context summary source). */
  readonly document: CadDocument;
  /**
   * The live selection state (the chat summary's selection revision
   * signal — a store concern that does not ride the document's identity).
   */
  readonly selection: SelectionState;
  /**
   * The page-level workbench mode (the chat summary's mode revision
   * signal — page state that does not ride the document's identity).
   */
  readonly mode: string;
  /** The page's bound webMCP tools + executor (M2). */
  readonly toolsSurface: AgentToolsSurface;
  /** The palette-commands slot the chat panel reports into (4.4). */
  readonly sessionSlot: AgentChatSessionSlot | null;
  /** The Selection section's content (the `propertyPanel` slot's node). */
  readonly propertyPanel: ReactNode;
  /**
   * The ARMED tool's descriptor, or `null` when nothing is armed. While a
   * tool is live it takes over the Selection section — the layout law's
   * rule that a feature is dialled in at the inspector, not in a modal —
   * and it renders the SAME descriptor the TOP′ bar renders, so the two
   * can never disagree about what the tool offers.
   *
   * The property panel underneath is HIDDEN, never unmounted: it is the
   * cockpit's restore discipline (a re-shown panel keeps its scroll and
   * its state), and its machine surface
   * (`[data-slot="cad-property-panel"]`) keeps answering while a tool is
   * armed — automation reads the selection's provenance in the middle of
   * a tool gesture.
   */
  readonly armedTool: ToolOptionsDescriptor | null;
  /** The Measurement section's content (moved here from the LEFT rail). */
  readonly measurementSection: ReactNode;
  /** The Parameters section's content (the `parameterPanel` slot's node). */
  readonly parameterPanel: ReactNode;
  /** The Configurations section's content. */
  readonly configurationPanel: ReactNode;
  /** How many references are selected (the Selection section's count). */
  readonly selectionCount: number;
  /** Whether the rail is collapsed to the icon width. */
  readonly collapsed: boolean;
  /** Flips the collapse. */
  readonly onToggleCollapsed: () => void;
  /** Whether one of the rail's sections is disclosed. */
  readonly isSectionOpen: (section: WorkbenchRailSectionId) => boolean;
  /** Sets one section's disclosure. */
  readonly onSectionOpenChange: (
    section: WorkbenchRailSectionId,
    open: boolean,
  ) => void;
}

export function WorkbenchInspectorRail({
  armedTool,
  collapsed,
  configurationPanel,
  document,
  isSectionOpen,
  measurementSection,
  mode,
  onSectionOpenChange,
  onToggleCollapsed,
  onViewChange,
  parameterPanel,
  propertyPanel,
  selection,
  selectionCount,
  sessionSlot,
  toolsSurface,
  view,
}: WorkbenchInspectorRailProps): ReactElement {
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
  const dockRef = useRef<HTMLElement | null>(null);
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
        mode={mode}
        onOpenSettings={openSettings}
        selection={selection}
        sessionSlot={sessionSlot}
        toolsSurface={toolsSurface}
      />
    </div>
  );

  // In the 26px name strip every control is a `--control-h` square
  // (nothing inside a panel header may be taller than the header); in the
  // icon rail they are full `--tool-h` buttons, the width it is sized for.
  const railButtonSize = collapsed ? "icon" : "sm";
  const railButtonClass = collapsed
    ? undefined
    : "w-(--control-h) justify-center px-0";

  const CollapseIcon = collapsed ? PanelRightOpen : PanelRightClose;
  const collapseToggle = (
    <ToolButton
      aria-expanded={!collapsed}
      aria-label="Toggle panels"
      className={railButtonClass}
      data-testid="workbench-toggle-panels"
      onClick={onToggleCollapsed}
      size={railButtonSize}
      title={
        collapsed
          ? "Expand the inspector rail to its full width."
          : "Collapse the inspector rail to its icon width."
      }
    >
      <CollapseIcon aria-hidden="true" />
    </ToolButton>
  );

  // The view switch (D16): both buttons are always in the tab order and
  // `aria-pressed` names the active view. Icon controls since step 3 —
  // the `aria-label`s carry the words the text buttons printed.
  //
  // It is a segmented VALUE, so it rides the value track: exactly one of
  // the two views is live at all times, which made the active one a
  // permanent amber mark in the rail's header — beside the parameter
  // panel's amber Apply and the selected configuration's amber row, in a
  // 240px column. The accent rule has three jobs and "which tab you are
  // on" is none of them; the track says it without spending the signal.
  const viewSwitch = (
    <ToolValueGroup
      className={
        collapsed ? "flex-col items-stretch gap-(--gap-tight)" : undefined
      }
      data-testid="right-sidebar-view-switch"
      label="Right sidebar view"
    >
      <ToolButton
        aria-label="Panels"
        aria-pressed={view === "sidebar"}
        className={railButtonClass}
        data-testid="right-sidebar-view-panels"
        onClick={() => {
          onViewChange("sidebar");
        }}
        size={railButtonSize}
        title="Show the inspector panels."
        tone="value"
      >
        <PanelsTopLeftIcon aria-hidden="true" />
      </ToolButton>
      <ToolButton
        aria-label="Agent chat"
        aria-pressed={view === "chat"}
        className={railButtonClass}
        data-testid="right-sidebar-view-chat"
        onClick={() => {
          onViewChange("chat");
        }}
        size={railButtonSize}
        title="Show the agent chat."
        tone="value"
      >
        <MessageSquareTextIcon aria-hidden="true" />
      </ToolButton>
    </ToolValueGroup>
  );

  return (
    <Panel
      className={`relative shrink-0 border-l border-rule ${
        collapsed ? "w-(--rail-w-icon)" : ""
      }`}
      data-agent-view={view}
      data-collapsed={collapsed ? "true" : "false"}
      data-testid="workbench-panels-dock"
      data-zone="right"
      flush
      ref={dockRef}
      style={collapsed ? undefined : { width }}
    >
      {collapsed ? (
        /* The icon rail: the toggle, the view switch, and one mark per
           section — each of which expands the rail AND discloses its
           section, so the collapsed rail is a way into the content. */
        <div className="flex min-h-0 flex-col gap-(--gap-tight) p-(--gap-tight)">
          {collapseToggle}
          {viewSwitch}
          <span aria-hidden="true" className="my-(--gap-tight) h-px bg-rule" />
          {SECTIONS.map(({ icon: Icon, id, title }) => (
            <ToolButton
              aria-label={title}
              key={id}
              onClick={() => {
                onSectionOpenChange(id, true);
                onViewChange("sidebar");
                onToggleCollapsed();
              }}
              size="icon"
              title={`Open ${title} in the inspector rail.`}
            >
              <Icon aria-hidden="true" />
            </ToolButton>
          ))}
        </div>
      ) : (
        <>
          <div className="flex h-(--header-h) shrink-0 items-center gap-(--gap) border-b border-rule px-(--gap-tight)">
            {viewSwitch}
            <span className="ml-auto flex shrink-0 items-center">
              {collapseToggle}
            </span>
          </div>

          {/* The panels column: HIDDEN while chat is active — never
              unmounted, so both sides' state survives the switch (D16). */}
          <PanelBody
            className={`${inspectorRailPanelsClassName(view)} min-h-0 flex-1 flex-col`}
          >
            <PanelSection
              collapsible
              id="rail-inspector-selection"
              onOpenChange={(open) => {
                onSectionOpenChange("inspector-selection", open);
              }}
              open={isSectionOpen("inspector-selection")}
              title={armedTool === null ? "Selection" : armedTool.toolLabel}
              trailing={armedTool === null ? String(selectionCount) : "armed"}
            >
              {armedTool === null ? null : (
                <ToolOptionsPanel descriptor={armedTool} />
              )}
              <div className={armedTool === null ? undefined : "hidden"}>
                {propertyPanel}
              </div>
            </PanelSection>
            <PanelSection
              collapsible
              id="rail-inspector-measurement"
              onOpenChange={(open) => {
                onSectionOpenChange("inspector-measurement", open);
              }}
              open={isSectionOpen("inspector-measurement")}
              title="Measurement"
            >
              {measurementSection}
            </PanelSection>
            <PanelSection
              collapsible
              id="rail-inspector-parameters"
              onOpenChange={(open) => {
                onSectionOpenChange("inspector-parameters", open);
              }}
              open={isSectionOpen("inspector-parameters")}
              title="Parameters"
            >
              {parameterPanel}
            </PanelSection>
            <PanelSection
              collapsible
              id="rail-inspector-configurations"
              onOpenChange={(open) => {
                onSectionOpenChange("inspector-configurations", open);
              }}
              open={isSectionOpen("inspector-configurations")}
              title="Configurations"
            >
              {configurationPanel}
            </PanelSection>
          </PanelBody>

          {/* The chat mounts only while its view is active (D16); the
              transcript restores from the persistence store on reopen. */}
          {view === "chat" ? chatView : null}

          {/* The resize handle (D16): the separator a11y pattern — drag
              with pointer capture, arrows/Home/End by keyboard, min/max
              clamped, size persisted by the width hook. The handle is
              absent while the rail is collapsed, because a collapsed rail
              has one width and a separator that could not move it would
              be a fake control. */}
          <div
            aria-label="Resize the right sidebar"
            aria-orientation="vertical"
            aria-valuemax={RIGHT_SIDEBAR_MAX_WIDTH}
            aria-valuemin={RIGHT_SIDEBAR_MIN_WIDTH}
            aria-valuenow={Math.round(width)}
            className={`absolute inset-y-0 left-0 z-40 w-1.5 -translate-x-1/2 cursor-col-resize touch-none transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-select-edge/40 focus-visible:bg-select-edge/50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--focus) ${
              isDragging ? "bg-select-edge/50" : "bg-transparent"
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
        </>
      )}

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
    </Panel>
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
