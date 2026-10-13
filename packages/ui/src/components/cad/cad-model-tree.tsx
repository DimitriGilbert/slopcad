/**
 * `CadModelTree` (Phase 15.3): the shadcn-side CAD model tree — the
 * document/body/feature hierarchy drawn from real document state, with
 * two-way selection synchronization against the viewport, regeneration
 * status per feature, and collapsible feature groups. Built on plain
 * semantic tree markup (`role="tree"`/`treeitem`) — no shadcn primitive
 * models a tree, and the existing `Collapsible`-style composition would
 * not carry the tree semantics — plus the same optional-hooks read
 * discipline as the viewport and toolbar siblings.
 *
 * ## Tree derivation (from document data only)
 *
 * The tree is a pure function of the `CadDocument`:
 *
 * 1. Features render in document insertion order; a feature's declared
 *    output bodies (`feature.outputs`) render as its children, in declared
 *    order — "feature outputs feed bodies" is the document's own data, so
 *    a body appears under the feature that produced it, not beside it.
 * 2. A body claimed as an output by several features is grouped under the
 *    FIRST producer (document insertion order); later claimers do not
 *    duplicate the row — one body, one tree node.
 * 3. Bodies no feature outputs render after all features, in document
 *    order, as root-level rows.
 * 4. A feature with no outputs renders as a leaf (no twisty, never
 *    collapsible).
 *
 * ## Selection synchronization (two-way)
 *
 * - **Tree → selection**: activating a row (click, Enter, Space) applies
 *   the domain pick operation with the row's STABLE reference (`body`/
 *   `feature`) — `additive` mirrors the Shift modifier, exactly the
 *   viewport's default click semantics (single mode replaces, multi mode
 *   toggles).
 * - **Selection → tree**: a body row highlights while ANY selected
 *   reference addresses that body — `body`, `solid`, and the synthetic
 *   `face`/`edge`/`vertex` references all carry the body id. The
 *   documented rule for transient synthetic refs: they highlight the
 *   OWNING body (the body row is the tree's addressable ancestor of a
 *   face; the face itself has no tree node). A feature row highlights
 *   only for its own `feature` reference.
 *
 * ## Feature status
 *
 * When a `RegenerationStateMap` is supplied, each feature row shows its
 * `valid`/`stale`/`failed`/`suppressed` status; a failed row surfaces its
 * LAST-ATTEMPT diagnostics as an error chip (`title` carries every
 * message) and a visible, `aria-describedby`-linked line with the first
 * diagnostic message — never text the component invents. Bodies and
 * parameters have no regeneration state in the domain, so they carry no
 * status chip. Without the map the tree shows no status: it displays only
 * what it was given.
 *
 * ## State: two documented input modes, props first
 *
 * - **Prop-driven** — pass `document`, `selection`, `regenerationStates`,
 *   and/or `onPick`; no provider is required. The groups are independent:
 *   a host can mirror selection from a provider while supplying the
 *   document itself, and so on.
 * - **Provider-driven** — mount below a `<CadProvider store={...}>` and
 *   omit the props: the document mirrors `useCadDocument().document`, the
 *   selection mirrors `useCadSelection().selected`, and picks apply
 *   through `useCadSelection().pick`. `regenerationStates` is PROP-ONLY —
 *   no store concern carries it — so a provider-driven host that wants
 *   statuses passes the map it derived from the domain.
 *
 * **Precedence**: explicit props always win, per group. Without ANY
 * document source the tree renders its titled empty state; with a
 * document but NO pick surface (no provider, no `onPick`), rows render
 * `aria-disabled` and activation is structurally absent — the tree is an
 * inert viewer, it never pretends to select (the toolbar's documented
 * inert discipline).
 *
 * ## Expanded/collapsed state
 *
 * Feature groups are collapsible and default expanded. The collapsed set
 * is COMPONENT-LOCAL UI state (`useState` keyed by feature id) — never
 * document state, never persisted; it survives document identity changes
 * within a mount and resets on unmount.
 *
 * ## Keyboard (the ARIA tree pattern)
 *
 * Rows are `role="treeitem"` elements with a roving tabindex: ArrowUp/
 * ArrowDown move between visible rows, ArrowRight expands a collapsed
 * group or moves to its first child, ArrowLeft collapses an expanded
 * group or moves to the parent row, Home/End jump to the first/last
 * visible row, and Enter/Space activate (Shift for additive pick) — the
 * same single pick path as the click. The expand/collapse twisty is a
 * pointer affordance only (`aria-hidden`; expansion is conveyed by
 * `aria-expanded` and driven from the keyboard by the arrow keys), the
 * standard pattern for trees. `aria-multiselectable` reflects that the
 * underlying selection is a set; each row's `aria-selected` mirrors the
 * highlight rule above.
 *
 * All user-facing strings live in {@link CAD_MODEL_TREE_LABELS}
 * (overridable via the `labels` prop); a feature kind missing from
 * `featureKinds` falls back to the raw kind — an identifier, not prose,
 * and the documented extension point for custom features.
 */

import { useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import {
  CadProviderError,
  selectionReferenceKey,
  useCadDocument,
  useCadSelection,
  type Body,
  type BodyId,
  type CadDocument,
  type FeatureRecord,
  type FeatureRegenerationState,
  type FeatureRegenerationStatus,
  type RegenerationStateMap,
  type SelectionReference,
} from "@slopcad/cad-react";
import { cn } from "cn";
import {
  APPEARANCE_LIBRARY,
  appearancesEqual,
  type Appearance,
} from "@slopcad/cad-react";

import { Popover, PopoverContent, PopoverTrigger } from "../popover";

/** The user-facing strings of {@link CadModelTree}. Overridable via props. */
export interface CadModelTreeLabels {
  /** The visible panel title and the tree's accessible name. */
  readonly treeLabel: string;
  /** Shown when there is nothing to display (no document, or an empty one). */
  readonly emptyDocument: string;
  /** Status label for the `valid` regeneration state. */
  readonly statusValid: string;
  /** Status label for the `stale` regeneration state. */
  readonly statusStale: string;
  /** Status label for the `failed` regeneration state. */
  readonly statusFailed: string;
  /** Status label for the `suppressed` regeneration state. */
  readonly statusSuppressed: string;
  /** `title` of the twisty that expands a collapsed group. */
  readonly expand: string;
  /** `title` of the twisty that collapses an expanded group. */
  readonly collapse: string;
  /** Display labels keyed by feature kind; a missing kind falls back to it. */
  readonly featureKinds: Readonly<Record<string, string>>;
  /** `title` of the body visibility toggle, shown body visible (Phase 44). */
  readonly bodyHide: string;
  /** `title` of the body visibility toggle, shown body hidden (Phase 44). */
  readonly bodyShow: string;
  /** `title` of the body isolation toggle, not isolated (Phase 44). */
  readonly bodyIsolate: string;
  /** `title` of the body isolation toggle, isolated (Phase 44). */
  readonly bodyUnIsolate: string;
  /** `title` of the body rename affordance (Phase 44). */
  readonly bodyRename: string;
  /** The assembly group header (Phase 50), rendered before the occurrences. */
  readonly assemblyLabel: string;
  /** The BOM chip for a `phantom` occurrence. */
  readonly bomPhantom: string;
  /** The BOM chip for a `purchased` occurrence. */
  readonly bomPurchased: string;
  /** The stale chip on an occurrence whose source moved ahead. */
  readonly occurrenceStale: string;
  /** `title` prefix describing a body-source occurrence. */
  readonly sourceBody: string;
  /** `title` prefix describing a document-source occurrence. */
  readonly sourceDocument: string;
  /** `title` prefix describing a component-source occurrence. */
  readonly sourceComponent: string;
}

/** Documented label defaults; every render-output string lives here. */
export const CAD_MODEL_TREE_LABELS: CadModelTreeLabels = {
  treeLabel: "Model tree",
  emptyDocument: "No bodies or features yet.",
  statusValid: "Valid",
  statusStale: "Stale",
  statusFailed: "Failed",
  statusSuppressed: "Suppressed",
  expand: "Expand",
  collapse: "Collapse",
  featureKinds: {},
  bodyHide: "Hide body",
  bodyShow: "Show body",
  bodyIsolate: "Isolate body",
  bodyUnIsolate: "Un-isolate body",
  bodyRename: "Rename body",
  assemblyLabel: "Instances",
  bomPhantom: "phantom",
  bomPurchased: "purchased",
  occurrenceStale: "stale",
  sourceBody: "Body",
  sourceDocument: "Document",
  sourceComponent: "Component",
};

/**
 * One body-management action the tree's body affordances emit (Phase 44):
 * the visibility and isolation toggles and the rename request. The tree
 * renders the affordances; the HOST owns the mutation (a `body.update`
 * command through its transaction choreography) — the tree never mutates.
 */
export type CadBodyTreeAction =
  | { readonly type: "toggle-visibility"; readonly bodyId: BodyId }
  | { readonly type: "toggle-isolate"; readonly bodyId: BodyId }
  | { readonly type: "rename"; readonly bodyId: BodyId }
  | {
      /** Phase 59: assign an appearance-library preset, or clear with `null`. */
      readonly type: "appearance";
      readonly bodyId: BodyId;
      readonly presetId: string | null;
    };

/**
 * The per-body display state the tree's affordances render (Phase 44):
 * the defaulted visibility/isolation flags of the document's body record.
 */
export interface CadBodyDisplayState {
  readonly visible: boolean;
  readonly isolated: boolean;
  /** The body's appearance record (Phase 59); absent = the scene default. */
  readonly appearance?: Appearance;
}

/**
 * One node of the host-supplied ASSEMBLY tree (Phase 50): an occurrence
 * (or a nested sub-assembly occurrence) rendered as its own tree section.
 * The component displays ONLY what the host derives — the resolution of
 * sources, placements, and staleness stays host-side (cad-core's assembly
 * module) — so the tree remains a pure function of its props. Keys must
 * be stable and unique (the occurrence path joined is the natural choice);
 * they drive expansion state and the DOM ids, never persistence.
 */
export interface CadModelTreeAssemblyNode {
  /** Stable, unique node id (the occurrence path joined). */
  readonly key: string;
  /** The row's display label (the occurrence name). */
  readonly label: string;
  /** What kind of source the occurrence places. */
  readonly source: "body" | "document" | "component";
  /** The source's display name (body name, document name, component id). */
  readonly sourceName: string;
  /** The occurrence's BOM structure flag (absent = default — no chip). */
  readonly bomFlag?: "phantom" | "purchased";
  /** Whether a transitive source document is newer (host-derived). */
  readonly stale?: boolean;
  /** Nested sub-assembly occurrences, rendered one level deeper. */
  readonly children?: readonly CadModelTreeAssemblyNode[];
}

/** The host-derived assembly section of the tree. */
export interface CadModelTreeAssembly {
  readonly nodes: readonly CadModelTreeAssemblyNode[];
}

/** Props of {@link CadModelTree}. */
export interface CadModelTreeProps {
  /** The document to display; overrides the provider-mirrored document. */
  readonly document?: CadDocument;
  /**
   * The regeneration states, keyed by feature id; PROP-ONLY (no store
   * concern carries them). Without the map, rows carry no status.
   */
  readonly regenerationStates?: RegenerationStateMap;
  /** The selected references; overrides the provider-mirrored selection. */
  readonly selection?: readonly SelectionReference[];
  /**
   * The pick surface; overrides the provider pick (see the precedence
   * rule in the module doc). `additive` mirrors the Shift modifier.
   */
  readonly onPick?: (reference: SelectionReference, additive: boolean) => void;
  /**
   * The body display states (Phase 44), prop-only: the host reads the
   * document's body records. Without the map the affordances stay hidden —
   * the tree displays only what it was given.
   */
  readonly bodyDisplay?: (bodyId: BodyId) => CadBodyDisplayState | undefined;
  /**
   * The body-management action surface (Phase 44): the visibility,
   * isolation, and rename affordances emit here. Without it (and without
   * `bodyDisplay`) the tree renders no body affordances.
   */
  readonly onBodyAction?: (action: CadBodyTreeAction) => void;
  /**
   * The host-derived assembly tree (Phase 50), rendered after the
   * document's features and bodies. Occurrence rows are INERT — the
   * selection domain has no occurrence references yet (Phase 51
   * generalizes selection through instance paths) — so they never pick:
   * the tree's documented inert discipline.
   */
  readonly assembly?: CadModelTreeAssembly;
  /** Label token overrides, merged over {@link CAD_MODEL_TREE_LABELS}. */
  readonly labels?: Partial<CadModelTreeLabels>;
  /** Extends the container classes; width defaults to the content. */
  readonly className?: string;
}

/** Visual presentation of one regeneration state: the status dot and text. */
const STATUS_PRESENTATION: Readonly<
  Record<
    FeatureRegenerationState,
    { readonly dot: string; readonly text: string }
  >
> = Object.freeze({
  // The healthy state stays quiet; failures are the only loud row.
  valid: Object.freeze({
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  }),
  stale: Object.freeze({
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  }),
  failed: Object.freeze({
    dot: "bg-destructive",
    text: "text-destructive font-medium",
  }),
  suppressed: Object.freeze({
    dot: "border-muted-foreground/60 bg-transparent",
    text: "text-muted-foreground italic",
  }),
});

/** The label tokens of the four regeneration states. */
type StatusLabelKey =
  "statusValid" | "statusStale" | "statusFailed" | "statusSuppressed";

/** The label token of each regeneration state. */
const STATUS_LABEL_KEYS: Readonly<
  Record<FeatureRegenerationState, StatusLabelKey>
> = Object.freeze({
  valid: "statusValid",
  stale: "statusStale",
  failed: "statusFailed",
  suppressed: "statusSuppressed",
});

/**
 * One row of the tree: the stable reference it selects, its display label,
 * its depth (0-based), its parent's key (`null` at the roots), its child
 * count (only feature groups have children), and — feature rows only —
 * the feature's regeneration status.
 */
interface CadTreeRow {
  readonly key: string;
  /** `null` on assembly rows — the selection domain has no occurrence
   * references yet (Phase 51 generalizes selection through paths), so
   * those rows are inert by construction. */
  readonly reference: SelectionReference | null;
  readonly label: string;
  readonly depth: number;
  readonly parentKey: string | null;
  readonly childCount: number;
  readonly groupId: string | undefined;
  readonly status: FeatureRegenerationStatus | undefined;
  readonly children: readonly CadTreeRow[];
  /** The body the row IS (body rows only — the affordances' address). */
  readonly bodyId: BodyId | undefined;
  /** The occurrence payload (assembly rows only — the chips' data). */
  readonly assembly: CadModelTreeAssemblyNode | undefined;
}

/**
 * The derived tree shape: feature groups with their (first-producer)
 * output bodies, then the unclaimed root bodies — the module doc's
 * derivation rule, in data form.
 */
interface CadTreeShape {
  readonly groups: readonly {
    readonly row: CadTreeRow;
    readonly children: readonly CadTreeRow[];
  }[];
  readonly rootBodies: readonly CadTreeRow[];
  /** The host-derived assembly section (empty when no assembly prop). */
  readonly assemblyRows: readonly CadTreeRow[];
}

function featureRowOf(
  feature: FeatureRecord,
  label: string,
  children: readonly CadTreeRow[],
  status: FeatureRegenerationStatus | undefined,
): CadTreeRow {
  return {
    key: selectionReferenceKey({ kind: "feature", featureId: feature.id }),
    reference: { kind: "feature", featureId: feature.id },
    label,
    depth: 0,
    parentKey: null,
    childCount: children.length,
    groupId: feature.id,
    status,
    children,
    bodyId: undefined,
    assembly: undefined,
  };
}

function bodyRowOf(
  body: Body,
  depth: number,
  parentKey: string | null,
): CadTreeRow {
  return {
    key: selectionReferenceKey({ kind: "body", bodyId: body.id }),
    reference: { kind: "body", bodyId: body.id },
    label: body.name,
    depth,
    parentKey,
    childCount: 0,
    groupId: undefined,
    status: undefined,
    children: [],
    bodyId: body.id,
    assembly: undefined,
  };
}

/** Builds an assembly row (and its nested children) from a host node. */
function assemblyRowOf(
  node: CadModelTreeAssemblyNode,
  depth: number,
  parentKey: string | null,
): CadTreeRow {
  const children = (node.children ?? []).map((child) =>
    assemblyRowOf(child, depth + 1, node.key),
  );
  return {
    key: node.key,
    reference: null,
    label: node.label,
    depth,
    parentKey,
    childCount: children.length,
    groupId: node.key,
    status: undefined,
    children,
    bodyId: undefined,
    assembly: node,
  };
}

/**
 * Derives the tree shape from the document: every feature in insertion
 * order with its not-yet-claimed output bodies as children (first producer
 * wins), then the bodies no feature outputs, in document order.
 */
function deriveCadTreeShape(
  document: CadDocument,
  featureLabel: (feature: FeatureRecord) => string,
  states: RegenerationStateMap | undefined,
  assembly: readonly CadModelTreeAssemblyNode[],
): CadTreeShape {
  const bodiesById = new Map<BodyId, Body>(
    document.bodies.map((body) => [body.id, body]),
  );
  const claimed = new Set<BodyId>();
  const groups: {
    readonly row: CadTreeRow;
    readonly children: readonly CadTreeRow[];
  }[] = [];
  for (const feature of document.features) {
    const children: CadTreeRow[] = [];
    const parentKey = selectionReferenceKey({
      kind: "feature",
      featureId: feature.id,
    });
    for (const id of feature.outputs) {
      const body = bodiesById.get(id);
      if (body === undefined || claimed.has(id)) continue;
      claimed.add(id);
      children.push(bodyRowOf(body, 1, parentKey));
    }
    groups.push({
      row: featureRowOf(
        feature,
        featureLabel(feature),
        children,
        states?.get(feature.id),
      ),
      children,
    });
  }
  const rootBodies = document.bodies
    .filter((body) => !claimed.has(body.id))
    .map((body) => bodyRowOf(body, 0, null));
  const assemblyRows = assembly.map((node) => assemblyRowOf(node, 0, null));
  return { groups, rootBodies, assemblyRows };
}

/**
 * Flattens one row and — when its group is expanded — its visible
 * descendants, in depth-first order. The recursion mirrors `renderRow`'s
 * exactly (children render only while `collapsible && expanded`), so the
 * flat roving list covers EVERY rendered row at ANY depth: a depth-2
 * sub-assembly row is as keyboard-reachable as a depth-1 body row.
 */
function visibleRowsOf(
  row: CadTreeRow,
  collapsed: ReadonlySet<string>,
  rows: CadTreeRow[],
): void {
  rows.push(row);
  const groupId = row.groupId;
  if (groupId === undefined || row.childCount === 0) return;
  if (collapsed.has(groupId)) return;
  for (const child of row.children) {
    visibleRowsOf(child, collapsed, rows);
  }
}

/**
 * The visible rows in depth-first order — the flat list the roving
 * tabindex navigation moves through. Collapsed groups contribute their
 * row but not their children; expanded groups recurse, so the list is
 * exactly the set of rows `renderRow` renders.
 */
function visibleCadTreeRows(
  shape: CadTreeShape,
  collapsed: ReadonlySet<string>,
): readonly CadTreeRow[] {
  const rows: CadTreeRow[] = [];
  for (const group of shape.groups) {
    visibleRowsOf(group.row, collapsed, rows);
  }
  rows.push(...shape.rootBodies);
  for (const assemblyRow of shape.assemblyRows) {
    visibleRowsOf(assemblyRow, collapsed, rows);
  }
  return rows;
}

/**
 * Whether the selection highlights the row with `reference`: a body row is
 * highlighted by every reference that addresses its body (`body`, `solid`,
 * and the synthetic face/edge/vertex kinds — the owning-body rule), a
 * feature row only by its own feature reference.
 */
function selectionTargetsRow(
  selection: readonly SelectionReference[],
  reference: SelectionReference,
): boolean {
  if (reference.kind === "feature") {
    return selection.some(
      (entry) =>
        entry.kind === "feature" && entry.featureId === reference.featureId,
    );
  }
  return selection.some(
    (entry) => entry.kind !== "feature" && entry.bodyId === reference.bodyId,
  );
}

/** A DOM-id-safe form of a row key. */
function domIdForKey(key: string): string {
  return `cad-model-tree-${key.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The collapsed set with `id` added (immutably). */
function collapsedWith(
  collapsed: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  next.add(id);
  return next;
}

/** The collapsed set without `id` (immutably). */
function collapsedWithout(
  collapsed: ReadonlySet<string>,
  id: string,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  next.delete(id);
  return next;
}

/** The visibility eye (Phase 44): inline SVG, the ChevronIcon precedent. */
/** The shared affordance-button classes of the body rows. */
const buttonClass = cn(
  "text-muted-foreground hover:text-foreground",
  "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center",
);

function EyeIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** The hidden-body eye with its slash (Phase 44). */
function EyeOffIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <path d="M3.5 4.7C2.2 5.8 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.2 0 2.2-.4 3.1-.9" />
      <path d="M6.2 6.4a2 2 0 0 0 2.6 2.8" />
      <path d="M13.9 10.1c.4-.8.6-1.4.6-2.1 0 0-2.5-4.5-6.5-4.5-.5 0-1 .1-1.5.2" />
      <path d="M2 14 14 2" />
    </svg>
  );
}

/** The isolation crosshair (Phase 44). */
function CrosshairIcon({ signal }: { readonly signal: boolean }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-3", signal ? "text-signal" : "")}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
    </svg>
  );
}

/** The rename pencil (Phase 44). */
function PencilIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      <path d="M11 2.5 13.5 5 5.5 13 2.5 13.5 3 10.5Z" />
      <path d="M9.5 4 12 6.5" />
    </svg>
  );
}

function PaletteIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
      width="14"
    >
      <circle cx="13.5" cy="6.5" r=".5" />
      <circle cx="17.5" cy="10.5" r=".5" />
      <circle cx="8.5" cy="7.5" r=".5" />
      <circle cx="6.5" cy="12.5" r=".5" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </svg>
  );
}

/** The expansion twisty: a pointer affordance; the keyboard uses the arrows. */
function ChevronIcon({
  expanded,
}: {
  readonly expanded: boolean;
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      className={cn(
        "size-3 transition-transform duration-150",
        expanded ? "rotate-90" : "",
      )}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 16 16"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/**
 * The status chip of a feature row: a state-colored dot and the state's
 * label. A failed chip's `title` carries every diagnostic message of the
 * feature's last failed attempt.
 */
function StatusChip({
  labels,
  status,
}: {
  readonly labels: CadModelTreeLabels;
  readonly status: FeatureRegenerationStatus;
}) {
  const presentation = STATUS_PRESENTATION[status.state];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] leading-none",
        presentation.text,
      )}
      data-cad-tree-status=""
      data-state={status.state}
      title={
        status.diagnostics.length === 0
          ? undefined
          : status.diagnostics
              .map((diagnostic) => diagnostic.message)
              .join("\n")
      }
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", presentation.dot)}
      />
      {labels[STATUS_LABEL_KEYS[status.state]]}
    </span>
  );
}

/**
 * Reads the document hook, mapping the structured "no provider" error to
 * `null` — the same optional-read discipline as the viewport's and the
 * toolbar's (the structured error is thrown before any stateful hook, so
 * removing a provider above a mounted tree re-renders fewer hooks and
 * fails loudly in React, a programming error reported as one).
 */
/**
 * The assembly row's chips (Phase 50): the source kind, the BOM structure
 * flag when non-default, and the host-derived staleness marker. All three
 * are DATA the host resolved — the tree invents nothing.
 */
function AssemblyChips({
  labels,
  node,
}: {
  readonly labels: CadModelTreeLabels;
  readonly node: CadModelTreeAssemblyNode;
}): ReactElement {
  const sourceLabel =
    node.source === "body"
      ? labels.sourceBody
      : node.source === "document"
        ? labels.sourceDocument
        : labels.sourceComponent;
  const sourceTitle = `${sourceLabel}: ${node.sourceName}`;
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
      <span
        className="text-muted-foreground/70 hidden font-mono text-[9.5px] group-hover:inline"
        title={sourceTitle}
      >
        {sourceLabel}
      </span>
      {node.bomFlag !== undefined ? (
        <span
          className="border-border bg-background/60 rounded-[3px] border px-1 font-mono text-[9.5px] leading-[15px]"
          data-cad-tree-bom={node.bomFlag}
        >
          {node.bomFlag === "phantom" ? labels.bomPhantom : labels.bomPurchased}
        </span>
      ) : null}
      {node.stale === true ? (
        <span
          className="rounded-[3px] bg-amber-500/15 px-1 font-mono text-[9.5px] leading-[15px] text-amber-600 dark:text-amber-400"
          data-cad-tree-stale="true"
        >
          {labels.occurrenceStale}
        </span>
      ) : null}
    </span>
  );
}

function useOptionalCadDocument(): ReturnType<typeof useCadDocument> | null {
  try {
    return useCadDocument();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** The selection-concern counterpart of {@link useOptionalCadDocument}. */
function useOptionalCadSelection(): ReturnType<typeof useCadSelection> | null {
  try {
    return useCadSelection();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/**
 * The body-management affordances (Phase 44): the visibility eye, the
 * isolation crosshair, and the rename pencil, rendered on BODY rows when
 * the host supplies the display states and the action surface. Pure
 * presentation — every mutation is the host's (`body.update` through its
 * transaction choreography); the buttons stop propagation so activation
 * (selection) never rides an affordance click.
 */
function bodyAffordances({
  bodyId,
  display,
  labels,
  onBodyAction,
}: {
  readonly bodyId: BodyId;
  readonly display: CadBodyDisplayState | undefined;
  readonly labels: CadModelTreeLabels;
  readonly onBodyAction: (action: CadBodyTreeAction) => void;
}): ReactElement {
  const visible = display?.visible ?? true;
  const isolated = display?.isolated ?? false;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5"
      data-cad-tree-body-actions=""
    >
      <button
        aria-label={visible ? labels.bodyHide : labels.bodyShow}
        aria-pressed={!visible}
        className={buttonClass}
        data-cad-tree-body-visibility={visible ? "visible" : "hidden"}
        onClick={(event) => {
          event.stopPropagation();
          onBodyAction({ type: "toggle-visibility", bodyId });
        }}
        title={visible ? labels.bodyHide : labels.bodyShow}
        type="button"
      >
        {visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <button
        aria-label={isolated ? labels.bodyUnIsolate : labels.bodyIsolate}
        aria-pressed={isolated}
        className={buttonClass}
        data-cad-tree-body-isolate={isolated ? "isolated" : "normal"}
        onClick={(event) => {
          event.stopPropagation();
          onBodyAction({ type: "toggle-isolate", bodyId });
        }}
        title={isolated ? labels.bodyUnIsolate : labels.bodyIsolate}
        type="button"
      >
        <CrosshairIcon signal={isolated} />
      </button>
      <button
        aria-label={labels.bodyRename}
        className={buttonClass}
        data-cad-tree-body-rename=""
        onClick={(event) => {
          event.stopPropagation();
          onBodyAction({ type: "rename", bodyId });
        }}
        title={labels.bodyRename}
        type="button"
      >
        <PencilIcon />
      </button>
      <AppearancePicker
        bodyId={bodyId}
        current={display?.appearance}
        onBodyAction={onBodyAction}
      />
    </span>
  );
}

/**
 * The appearance picker (Phase 59): a palette affordance opening the
 * appearance library's presets as pure presentation — activation emits the
 * action; the HOST owns the `body.update` mutation. `display` carries the
 * body's current record so the picker marks the active preset and offers
 * clearing.
 */
function AppearancePicker({
  bodyId,
  current,
  onBodyAction,
}: {
  readonly bodyId: BodyId;
  readonly current: Appearance | undefined;
  readonly onBodyAction: (action: CadBodyTreeAction) => void;
}): ReactElement {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label="Body appearance"
            className={cn(buttonClass, "relative")}
            data-cad-tree-body-appearance=""
            onClick={(event) => {
              event.stopPropagation();
            }}
            title="Appearance"
            type="button"
          />
        }
      >
        <PaletteIcon />
        {current === undefined ? null : (
          // The active-color chip: the trigger restates the body's current
          // record's base color at a glance (the menu rows' chips, mini).
          <span
            aria-hidden="true"
            className="border-background -right-0.5 -bottom-0.5 absolute size-1.5 rounded-full border"
            data-cad-tree-appearance-active={current.baseColor}
            style={{ backgroundColor: current.baseColor }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        <div
          aria-label="Appearance presets"
          data-cad-tree-appearance-menu={bodyId}
          role="menu"
        >
          {APPEARANCE_LIBRARY.map((entry) => (
            <button
              aria-pressed={appearancesEqual(current, entry.appearance)}
              className={cn(
                "hover:bg-accent flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
              )}
              data-testid={`appearance-preset-${entry.id}`}
              key={entry.id}
              onClick={(event) => {
                event.stopPropagation();
                onBodyAction({
                  type: "appearance",
                  bodyId,
                  presetId: entry.id,
                });
              }}
              role="menuitem"
              type="button"
            >
              <span
                aria-hidden="true"
                className="border-border inline-block size-3 shrink-0 rounded-full border"
                style={{ backgroundColor: entry.appearance.baseColor }}
              />
              {entry.label}
            </button>
          ))}
          <button
            className="hover:bg-accent text-muted-foreground flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs"
            data-testid="appearance-preset-none"
            onClick={(event) => {
              event.stopPropagation();
              onBodyAction({ type: "appearance", bodyId, presetId: null });
            }}
            role="menuitem"
            type="button"
          >
            None (scene default)
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The CAD model tree: the document's feature/body hierarchy with live
 * selection synchronization, regeneration statuses, and collapsible
 * groups, in one mountable component.
 */
export function CadModelTree({
  assembly,
  bodyDisplay,
  className,
  document: documentProp,
  labels: labelOverrides,
  onBodyAction,
  onPick,
  regenerationStates,
  selection: selectionProp,
}: CadModelTreeProps) {
  const labels: CadModelTreeLabels = {
    ...CAD_MODEL_TREE_LABELS,
    ...labelOverrides,
  };
  const documentApi = useOptionalCadDocument();
  const selectionApi = useOptionalCadSelection();

  const cadDocument = documentProp ?? documentApi?.document;
  const selection = selectionProp ?? selectionApi?.selected ?? [];
  const pick =
    onPick ??
    (selectionApi === null
      ? undefined
      : (reference: SelectionReference, additive: boolean) => {
          selectionApi.pick(reference, additive);
        });

  // Component-local UI state: the collapsed feature groups (default
  // expanded). Never document state; resets on unmount.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Roving tabindex: the row focus sits on (falls back to the first row).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const featureLabel = (feature: FeatureRecord): string =>
    labels.featureKinds[feature.kind] ?? feature.kind;
  const shape =
    cadDocument === undefined
      ? null
      : deriveCadTreeShape(
          cadDocument,
          featureLabel,
          regenerationStates,
          assembly?.nodes ?? [],
        );
  const rows = shape === null ? [] : visibleCadTreeRows(shape, collapsed);
  const focusedKey =
    activeKey !== null && rows.some((row) => row.key === activeKey)
      ? activeKey
      : (rows[0]?.key ?? null);

  const focusRow = (target: CadTreeRow | undefined): void => {
    if (target === undefined) return;
    rowRefs.current.get(target.key)?.focus();
    setActiveKey(target.key);
  };

  const activateRow = (row: CadTreeRow, additive: boolean): void => {
    if (row.reference === null) return; // inert assembly row — no pick path
    pick?.(row.reference, additive);
  };

  const toggleGroup = (row: CadTreeRow): void => {
    const groupId = row.groupId;
    if (groupId === undefined || row.childCount === 0) return;
    setCollapsed((current) =>
      current.has(groupId)
        ? collapsedWithout(current, groupId)
        : collapsedWith(current, groupId),
    );
  };

  const handleRowKeyDown = (
    row: CadTreeRow,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const index = rows.findIndex((entry) => entry.key === row.key);
    // Handled keys are consumed at the deepest row: a child row's key
    // event must not bubble into its ancestor group's treeitem handler.
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(rows[index + 1]);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(rows[index - 1]);
        break;
      case "Home":
        event.preventDefault();
        focusRow(rows[0]);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight": {
        event.preventDefault();
        const groupId = row.groupId;
        if (
          groupId !== undefined &&
          row.childCount > 0 &&
          collapsed.has(groupId)
        ) {
          setCollapsed(collapsedWithout(collapsed, groupId));
          break;
        }
        focusRow(rows[index + 1]);
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const groupId = row.groupId;
        if (
          groupId !== undefined &&
          row.childCount > 0 &&
          !collapsed.has(groupId)
        ) {
          setCollapsed(collapsedWith(collapsed, groupId));
          break;
        }
        focusRow(rows.find((entry) => entry.key === row.parentKey));
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        activateRow(row, event.shiftKey);
        break;
      default:
        handled = false;
    }
    if (handled) event.stopPropagation();
  };

  const renderRow = (row: CadTreeRow): ReactElement => {
    const groupId = row.groupId;
    const selected =
      row.reference !== null && selectionTargetsRow(selection, row.reference);
    const collapsible = groupId !== undefined && row.childCount > 0;
    const expanded =
      collapsible && groupId !== undefined && !collapsed.has(groupId);
    const failure =
      row.status?.state === "failed" && row.status.diagnostics.length > 0
        ? row.status.diagnostics
        : undefined;
    const failureId =
      failure === undefined ? undefined : `${domIdForKey(row.key)}-failure`;
    return (
      <div
        aria-describedby={failureId}
        aria-expanded={collapsible ? expanded : undefined}
        aria-level={row.depth + 1}
        aria-selected={selected}
        className={cn(
          "outline-none focus-visible:ring-1 focus-visible:ring-ring/80",
          "cursor-default rounded-[3px]",
          selected
            ? "bg-accent text-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--signal)_30%,transparent)]"
            : pick === undefined
              ? "opacity-80"
              : "hover:bg-muted",
        )}
        aria-disabled={
          pick === undefined || row.reference === null || undefined
        }
        data-cad-tree-node=""
        data-node-key={row.key}
        {...(row.assembly !== undefined
          ? { "data-cad-tree-occurrence": row.assembly.source }
          : {})}
        data-selected={selected ? "true" : "false"}
        data-status={row.status?.state}
        id={domIdForKey(row.key)}
        key={row.key}
        ref={(element) => {
          if (element !== null) {
            rowRefs.current.set(row.key, element);
          } else {
            rowRefs.current.delete(row.key);
          }
        }}
        role="treeitem"
        tabIndex={row.key === focusedKey ? 0 : -1}
        onClick={(event) => {
          // A child row's activation must not bubble into its ancestor
          // group's treeitem: one activation, one pick.
          event.stopPropagation();
          activateRow(row, event.shiftKey);
        }}
        onFocus={() => {
          setActiveKey(row.key);
        }}
        onKeyDown={(event) => {
          handleRowKeyDown(row, event);
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5 px-1.5 py-1">
          {collapsible ? (
            <span
              aria-hidden="true"
              className="text-muted-foreground hover:text-foreground inline-flex size-4 shrink-0 cursor-pointer items-center justify-center"
              data-cad-tree-toggle=""
              title={expanded ? labels.collapse : labels.expand}
              onClick={(event) => {
                event.stopPropagation();
                toggleGroup(row);
              }}
            >
              <ChevronIcon expanded={expanded} />
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="text-muted-foreground/40 inline-flex size-4 shrink-0 items-center justify-center font-mono text-[10px]"
            >
              {row.depth > 0 ? "·" : ""}
            </span>
          )}
          {/* Hierarchy typography: feature rows carry the weight (the
              document's structure); the bodies they produce read lighter
              and indented under the depth guide. */}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              row.depth === 0 ? "font-medium" : "text-muted-foreground",
            )}
          >
            {row.label}
          </span>
          {row.bodyId !== undefined &&
          bodyDisplay !== undefined &&
          onBodyAction !== undefined
            ? bodyAffordances({
                bodyId: row.bodyId,
                display: bodyDisplay(row.bodyId),
                labels,
                onBodyAction,
              })
            : null}
          {row.status !== undefined ? (
            <StatusChip labels={labels} status={row.status} />
          ) : null}
          {row.assembly !== undefined ? (
            <AssemblyChips labels={labels} node={row.assembly} />
          ) : null}
        </div>
        {collapsible && expanded ? (
          <div className="border-border ml-[11px] border-l pl-1" role="group">
            {row.children.map((child) => renderRow(child))}
          </div>
        ) : null}
        {failure !== undefined ? (
          <div
            className="text-destructive px-1.5 pb-1 text-xs leading-4"
            id={failureId}
          >
            {failure[0]?.message}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className={cn(
        "border-border bg-card/60 w-56 overflow-hidden rounded-md border text-sm",
        className,
      )}
      data-slot="cad-model-tree"
    >
      <div className="text-muted-foreground border-border bg-background/40 border-b px-2.5 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
        {labels.treeLabel}
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground px-2.5 py-2 text-xs">
          {labels.emptyDocument}
        </div>
      ) : (
        <div
          aria-label={labels.treeLabel}
          aria-multiselectable="true"
          className="select-none p-1"
          role="tree"
        >
          {shape?.groups.map((group) => renderRow(group.row))}
          {shape?.rootBodies.map((body) => renderRow(body))}
          {shape?.assemblyRows.map((assemblyRow) => renderRow(assemblyRow))}
        </div>
      )}
    </div>
  );
}
