/**
 * The LEFT and RIGHT rails' DEFAULT CONTENT, as element factories.
 *
 * `CadWorkbenchSlots` lets a host replace any zone's content wholesale
 * (`slots.modelTree?.(context) ?? defaultModelTree`). The defaults on the
 * other side of that `??` are still zone content — the model tree the
 * LEFT rail shows, the three panels the RIGHT rail stacks — and they have
 * no business living in the composition root alongside the engine wiring.
 * They moved here when the rails became real zone components (step 3).
 *
 * These are FACTORIES, not components: they are called during the
 * composition's render and their results are handed to the slot
 * resolution unchanged, so hook order, the slot precedence rule and the
 * per-render identity of everything they close over are exactly what they
 * were as inline `const default…` bindings.
 *
 * Inside the rails the panels shed BOTH their floating-card chrome and
 * their own name strips: the rail's collapsible `PanelSection` is the
 * enclosure and the name. Every one keeps its standalone card look and
 * its own header anywhere else it is mounted.
 */

import type { ReactElement } from "react";
import type {
  BodyId,
  CadDocument,
  RegenerationStateMap,
} from "@slopcad/cad-core";
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadPropertyPanel } from "@slopcad/ui/components/cad/cad-property-panel";
import {
  CadConfigurationPanel,
  type CadConfigurationRow,
} from "@slopcad/ui/components/cad/cad-configuration-panel";

/** What the LEFT rail's default tree needs from the composition. */
export interface ModelTreeSlotDefaultInput {
  /** The live document (the body records the affordances read). */
  readonly document: CadDocument;
  /** The per-feature regeneration states; `null` before the first solve. */
  readonly regenerationStates: RegenerationStateMap | null;
  /** Opens the rename surface for a body. */
  readonly onRenameBody: (bodyId: BodyId) => void;
  /** Sets a body's visibility. */
  readonly onBodyVisibility: (bodyId: BodyId, visible: boolean) => void;
  /** Sets a body's isolation. */
  readonly onBodyIsolate: (bodyId: BodyId, isolated: boolean) => void;
  /** Applies an appearance preset (or clears it) to a body. */
  readonly onBodyAppearance: (bodyId: BodyId, presetId: string | null) => void;
}

/**
 * The LEFT rail's default content: the feature/body tree, rendered
 * `chrome="flush"` so the rail's Features section is the only name strip.
 * `null` until the first regeneration — the tree shows statuses or it
 * does not show at all.
 */
export function modelTreeSlotDefault({
  document,
  onBodyAppearance,
  onBodyIsolate,
  onBodyVisibility,
  onRenameBody,
  regenerationStates,
}: ModelTreeSlotDefaultInput): ReactElement | null {
  if (regenerationStates === null) return null;
  const findBody = (bodyId: BodyId) =>
    document.bodies.find((candidate) => candidate.id === bodyId);
  return (
    <CadModelTree
      bodyDisplay={(bodyId) => {
        const body = findBody(bodyId);
        return body === undefined
          ? undefined
          : {
              visible: body.visible !== false,
              isolated: body.isolated === true,
              appearance: body.appearance,
            };
      }}
      chrome="flush"
      className="w-full"
      onBodyAction={(action) => {
        if (action.type === "rename") {
          onRenameBody(action.bodyId);
          return;
        }
        if (action.type === "appearance") {
          onBodyAppearance(action.bodyId, action.presetId);
          return;
        }
        const body = findBody(action.bodyId);
        if (body === undefined) return;
        if (action.type === "toggle-visibility") {
          onBodyVisibility(action.bodyId, body.visible === false);
          return;
        }
        onBodyIsolate(action.bodyId, body.isolated !== true);
      }}
      regenerationStates={regenerationStates}
    />
  );
}

/**
 * The RIGHT rail's Selection section: the selection's properties. In the
 * rail it flows and shrinks with its content (the percentage caps the old
 * dock imposed are gone), so it only declares `shrink-0`.
 */
export function propertyPanelSlotDefault(
  regenerationStates: RegenerationStateMap | null,
): ReactElement {
  return (
    <CadPropertyPanel
      className="w-full shrink-0 rounded-none border-0 bg-transparent"
      hideHeader
      regenerationStates={regenerationStates ?? undefined}
    />
  );
}

/**
 * The RIGHT rail's Parameters section. In the rail the panel FLOWS: the
 * rail's one `PanelBody` owns the scroll and every section grows to its
 * content, so the panel's own `max-h-full` cap — which existed to fight
 * the dock's percentage split — is released.
 */
export function parameterPanelSlotDefault(): ReactElement {
  return (
    <CadParameterPanel
      className="w-full max-h-none rounded-none border-0 bg-transparent"
      hideHeader
    />
  );
}

/** What the RIGHT rail's default configuration panel needs. */
export interface ConfigurationPanelSlotDefaultInput {
  /** The live document (the configuration records the table counts). */
  readonly document: CadDocument;
  /** The active configuration, or `null` for the base document. */
  readonly activeConfigurationId: string | null;
  /** The panel's error region text (read failure, then engine notice). */
  readonly notice: string | null;
  /** Clears the CSV read error before every action. */
  readonly onClearReadError: () => void;
  /** Reports a CSV read failure (the panel's only invented-free channel). */
  readonly onReadError: (message: string) => void;
  /** Switches the active configuration. */
  readonly onSwitch: (id: string | null) => void;
  /** Creates a configuration by name. */
  readonly onCreate: (name: string) => void;
  /** Deletes a configuration by id. */
  readonly onDelete: (id: string) => void;
  /** Serializes the parameter table to the deterministic CSV. */
  readonly onExportCsv: () => string;
  /** Applies an imported parameter-table CSV. */
  readonly onImportCsv: (text: string) => void;
}

/**
 * The RIGHT rail's Configurations section (Phase 57): the switcher, the
 * row table, the Formedible create form, and the CSV exchange. Export
 * writes the deterministic CSV through the browser's download path;
 * import hands the read text to the engine, whose own parse/commit
 * refusals are the panel's error region.
 */
export function configurationPanelSlotDefault({
  activeConfigurationId,
  document,
  notice,
  onClearReadError,
  onCreate,
  onDelete,
  onExportCsv,
  onImportCsv,
  onReadError,
  onSwitch,
}: ConfigurationPanelSlotDefaultInput): ReactElement {
  const rows: readonly CadConfigurationRow[] = document.configurations.map(
    (configuration) => ({
      id: configuration.id,
      name: configuration.name,
      overrides: configuration.parameterOverrides.length,
      suppressed: configuration.suppressedFeatures.length,
      hidden: configuration.hiddenBodies.length,
    }),
  );
  return (
    <CadConfigurationPanel
      activeConfigurationId={activeConfigurationId}
      className="w-full shrink-0"
      configurations={rows}
      hideHeader
      notice={notice}
      onCreate={(name) => {
        onClearReadError();
        onCreate(name);
      }}
      onDelete={(id) => {
        onClearReadError();
        onDelete(id);
      }}
      onExportCsv={() => {
        const csv = onExportCsv();
        downloadCsv(csv, "parameters.csv");
        return csv;
      }}
      onImportCsv={(text) => {
        onClearReadError();
        onImportCsv(text);
      }}
      onImportError={onReadError}
      onSwitch={(id) => {
        onClearReadError();
        onSwitch(id);
      }}
    />
  );
}

/** The browser download path for a generated CSV, revoked immediately. */
function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
