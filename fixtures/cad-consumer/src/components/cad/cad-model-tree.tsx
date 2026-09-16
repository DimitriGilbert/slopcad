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
  type FeatureId,
  type FeatureRecord,
  type FeatureRegenerationState,
  type FeatureRegenerationStatus,
  type RegenerationStateMap,
  type SelectionReference,
} from "@slopcad/cad-react";
import { cn } from "cn";

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
};

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
  /** Label token overrides, merged over {@link CAD_MODEL_TREE_LABELS}. */
  readonly labels?: Partial<CadModelTreeLabels>;
  /** Extends the container classes; width defaults to the content. */
  readonly className?: string;
}

/** Visual presentation of one regeneration state: the status dot and text. */
const STATUS_PRESENTATION: Readonly<
  Record<FeatureRegenerationState, { readonly dot: string; readonly text: string }>
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
  | "statusValid"
  | "statusStale"
  | "statusFailed"
  | "statusSuppressed";

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
  readonly reference: SelectionReference;
  readonly label: string;
  readonly depth: number;
  readonly parentKey: string | null;
  readonly childCount: number;
  readonly groupId: FeatureId | undefined;
  readonly status: FeatureRegenerationStatus | undefined;
  readonly children: readonly CadTreeRow[];
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
  };
}

function bodyRowOf(body: Body, depth: number, parentKey: string | null): CadTreeRow {
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
): CadTreeShape {
  const bodiesById = new Map<BodyId, Body>(
    document.bodies.map((body) => [body.id, body]),
  );
  const claimed = new Set<BodyId>();
  const groups: { readonly row: CadTreeRow; readonly children: readonly CadTreeRow[] }[] = [];
  for (const feature of document.features) {
    const children: CadTreeRow[] = [];
    const parentKey = selectionReferenceKey({ kind: "feature", featureId: feature.id });
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
  return { groups, rootBodies };
}

/**
 * The visible rows in depth-first order — the flat list the roving
 * tabindex navigation moves through. Collapsed groups contribute their
 * row but not their children.
 */
function visibleCadTreeRows(shape: CadTreeShape, collapsed: ReadonlySet<FeatureId>): readonly CadTreeRow[] {
  const rows: CadTreeRow[] = [];
  for (const group of shape.groups) {
    rows.push(group.row);
    if (group.row.childCount > 0 && group.row.groupId !== undefined && !collapsed.has(group.row.groupId)) {
      rows.push(...group.children);
    }
  }
  rows.push(...shape.rootBodies);
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
      (entry) => entry.kind === "feature" && entry.featureId === reference.featureId,
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
  collapsed: ReadonlySet<FeatureId>,
  id: FeatureId,
): ReadonlySet<FeatureId> {
  const next = new Set(collapsed);
  next.add(id);
  return next;
}

/** The collapsed set without `id` (immutably). */
function collapsedWithout(
  collapsed: ReadonlySet<FeatureId>,
  id: FeatureId,
): ReadonlySet<FeatureId> {
  const next = new Set(collapsed);
  next.delete(id);
  return next;
}

/** The expansion twisty: a pointer affordance; the keyboard uses the arrows. */
function ChevronIcon({ expanded }: { readonly expanded: boolean }): ReactElement {
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
          : status.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
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
 * The CAD model tree: the document's feature/body hierarchy with live
 * selection synchronization, regeneration statuses, and collapsible
 * groups, in one mountable component.
 */
export function CadModelTree({
  className,
  document: documentProp,
  labels: labelOverrides,
  onPick,
  regenerationStates,
  selection: selectionProp,
}: CadModelTreeProps) {
  const labels: CadModelTreeLabels = { ...CAD_MODEL_TREE_LABELS, ...labelOverrides };
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
  const [collapsed, setCollapsed] = useState<ReadonlySet<FeatureId>>(
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
      : deriveCadTreeShape(cadDocument, featureLabel, regenerationStates);
  const rows = shape === null ? [] : visibleCadTreeRows(shape, collapsed);
  const focusedKey =
    activeKey !== null && rows.some((row) => row.key === activeKey)
      ? activeKey
      : rows[0]?.key ?? null;

  const focusRow = (target: CadTreeRow | undefined): void => {
    if (target === undefined) return;
    rowRefs.current.get(target.key)?.focus();
    setActiveKey(target.key);
  };

  const activateRow = (row: CadTreeRow, additive: boolean): void => {
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
        if (groupId !== undefined && row.childCount > 0 && collapsed.has(groupId)) {
          setCollapsed(collapsedWithout(collapsed, groupId));
          break;
        }
        focusRow(rows[index + 1]);
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        const groupId = row.groupId;
        if (groupId !== undefined && row.childCount > 0 && !collapsed.has(groupId)) {
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
    const selected = selectionTargetsRow(selection, row.reference);
    const collapsible = groupId !== undefined && row.childCount > 0;
    const expanded = collapsible && groupId !== undefined && !collapsed.has(groupId);
    const failure =
      row.status?.state === "failed" && row.status.diagnostics.length > 0
        ? row.status.diagnostics
        : undefined;
    const failureId = failure === undefined ? undefined : `${domIdForKey(row.key)}-failure`;
    return (
      <div
        aria-describedby={failureId}
        aria-disabled={pick === undefined || undefined}
        aria-expanded={collapsible ? expanded : undefined}
        aria-level={row.depth + 1}
        aria-selected={selected}
        className={cn(
          "outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
          "cursor-default rounded-none",
          selected
            ? "bg-accent text-accent-foreground"
            : pick === undefined
              ? "opacity-80"
              : "hover:bg-muted",
        )}
        data-cad-tree-node=""
        data-node-key={row.key}
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
          ) : null}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          {row.status !== undefined ? (
            <StatusChip labels={labels} status={row.status} />
          ) : null}
        </div>
        {collapsible && expanded ? (
          <div className="border-border/60 ml-[11px] border-l pl-1" role="group">
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
        "border-border bg-background w-56 border text-sm",
        className,
      )}
      data-slot="cad-model-tree"
    >
      <div className="text-muted-foreground border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
        {labels.treeLabel}
      </div>
      {rows.length === 0 ? (
        <div className="text-muted-foreground px-2 py-2">
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
        </div>
      )}
    </div>
  );
}
