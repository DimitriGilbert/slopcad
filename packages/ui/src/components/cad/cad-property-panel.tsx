/**
 * `CadPropertyPanel` (Phase 28): the shadcn-side CAD property panel — the
 * selection's properties, derived as a pure function of the document and
 * the selection the same way the model tree derives its shape: one section
 * per selected reference, in selection order, with every row a piece of
 * DOMAIN data (names, ids, kinds, statuses, diagnostics, reference
 * summaries). The panel invents nothing: a synthetic face shows its owning
 * body, its index, and its regeneration identity; a feature shows its
 * inputs resolved to the named entities it references and the bodies it
 * outputs; a body shows its name, its id, the feature that produces it,
 * and the features that consume it.
 *
 * ## Feature status
 *
 * When a `RegenerationStateMap` is supplied (PROP-ONLY, the model tree's
 * rule — no store concern carries it), a feature section shows the
 * feature's `valid`/`stale`/`failed`/`suppressed` status, and a failed
 * section surfaces the last attempt's FIRST diagnostic message as a visible,
 * `aria-describedby`-linked line (the full diagnostics ride the `title`).
 * Without the map the section shows no status.
 *
 * ## The delete action (the panel's one write path)
 *
 * A feature section may carry a remove action, committed EXCLUSIVELY
 * through the command vocabulary: the model API's
 * {@link removeFeatureTransaction} (`feature.delete`) applied through the
 * store's `applyTransaction` — the same public path
 * `useCadModel().removeFeature` takes. There is no second write path. A
 * structured refusal surfaces verbatim in the panel's error region: the
 * store-backed apply unwraps a refused transaction to its command's
 * structured `cause` (the parameter panel's {@link toOutcome} rule), so the
 * DOMAIN's refusal — an unknown feature, a dependency conflict — is what
 * renders, never the transaction envelope's own
 * `transaction/command-failed` wrapper. Removal is undoable like any
 * transaction (the host's history surface owns that).
 *
 * ## State: two documented input modes, props first
 *
 * - **Prop-driven** — pass `document`, `selection`, `regenerationStates`,
 * and/or `onRemoveFeature`; no provider is required.
 * - **Provider-driven** — mount below a `<CadProvider store={...}>` and
 *   omit the props: the document and selection mirror their concerns, and
 *   removal applies through the store.
 *
 * **Precedence**: explicit props always win, per group. Without ANY
 * document source the panel renders its titled empty state; without a
 * selection it renders the documented nothing-selected state. With no
 * remove surface (no provider, no `onRemoveFeature`) the remove button is
 * structurally absent — the panel never pretends to act (the toolbar's,
 * tree's, and parameter panel's documented inert discipline).
 *
 * All user-facing strings live in {@link CAD_PROPERTY_PANEL_LABELS}
 * (overridable via the `labels` prop); names, ids, kinds, and error
 * code/message text are domain data rendered verbatim.
 */

import { useState } from "react";
import type { ReactElement } from "react";
import {
  CadProviderError,
  removeFeatureTransaction,
  selectionReferenceKey,
  useCadDocument,
  useCadSelection,
  useCadStore,
  type Body,
  type BodyId,
  type CadDocument,
  type CadSession,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  type FeatureRegenerationStatus,
  type ParseResult,
  type RegenerationStateMap,
  type SelectionReference,
  type TransactionError,
} from "@slopcad/cad-react";
import { cn } from "cn";

import { Button } from "../button";
import { PanelHeader } from "../cockpit/panel";
import { PropertyRow as CockpitPropertyRow } from "../cockpit/property-row";

/** The user-facing strings of {@link CadPropertyPanel}. Overridable via props. */
export interface CadPropertyPanelLabels {
  /** The visible panel title. */
  readonly title: string;
  /** Shown when there is no document source at all. */
  readonly emptyDocument: string;
  /** Shown when the document exists but nothing is selected. */
  readonly emptySelection: string;
  /** The row label for a body or body-addressing reference's name. */
  readonly rowName: string;
  /** The row label for a stable id. */
  readonly rowId: string;
  /** The row label for a reference's selection kind. */
  readonly rowKind: string;
  /** The row label for the feature that outputs a body. */
  readonly rowProducedBy: string;
  /** The row label for the features that consume a body as an input. */
  readonly rowConsumedBy: string;
  /** The row label for a feature's input references. */
  readonly rowInputs: string;
  /** The row label for a feature's output bodies. */
  readonly rowOutputs: string;
  /** The row label for a synthetic reference's topology index. */
  readonly rowIndex: string;
  /** The row label for a synthetic reference's regeneration identity. */
  readonly rowRegeneration: string;
  /** The remove action's label. */
  readonly remove: string;
  /** The remove action's `title` (what it does, and where undo lives). */
  readonly removeTooltip: string;
  /** The value shown for a row the document cannot answer ("—"). */
  readonly unset: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_PROPERTY_PANEL_LABELS: CadPropertyPanelLabels = {
  title: "Properties",
  emptyDocument: "No document.",
  emptySelection: "Nothing selected.",
  rowName: "Name",
  rowId: "Id",
  rowKind: "Kind",
  rowProducedBy: "Produced by",
  rowConsumedBy: "Consumed by",
  rowInputs: "Inputs",
  rowOutputs: "Outputs",
  rowIndex: "Index",
  rowRegeneration: "Regeneration",
  remove: "Delete feature",
  removeTooltip:
    "Commit a feature.delete transaction (undo restores it from the history surface).",
  unset: "—",
};

/** The structured outcome of one removal: the domain's refusal, verbatim. */
export type CadPropertyRemoveOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/**
 * The remove surface: receives the feature id, returns the structured
 * outcome. The provider-backed surface commits `feature.delete`
 * transactions through the store.
 */
export type CadPropertyRemove = (
  featureId: FeatureId,
) => CadPropertyRemoveOutcome;

/**
 * Maps a store apply result to the remove outcome. A refused transaction
 * carries its offending command's structured error as `cause` — the
 * domain's own refusal (an unknown feature, a dependency conflict) — which
 * is what the error region surfaces, verbatim; only a cause-less refusal
 * (the transaction envelope's own shape failures) falls back to the
 * transaction error itself. The parameter panel's identical rule.
 */
function toOutcome(
  applied: ParseResult<CadSession, TransactionError>,
): CadPropertyRemoveOutcome {
  if (applied.ok) return { ok: true };
  const cause = applied.error.cause;
  return {
    ok: false,
    error: cause ?? {
      code: applied.error.code,
      message: applied.error.message,
    },
  };
}

/** Props of {@link CadPropertyPanel}. */
export interface CadPropertyPanelProps {
  /** The document the properties derive from; overrides the provider. */
  readonly document?: CadDocument;
  /** The selected references; overrides the provider-mirrored selection. */
  readonly selection?: readonly SelectionReference[];
  /**
   * The regeneration states, keyed by feature id; PROP-ONLY (no store
   * concern carries them). Without the map, feature sections carry no
   * status.
   */
  readonly regenerationStates?: RegenerationStateMap;
  /**
   * The remove surface; overrides the store apply (see the precedence rule
   * in the module doc). Without it and without a provider the remove
   * button is structurally absent.
   */
  readonly onRemoveFeature?: CadPropertyRemove;
  /** Label token overrides, merged over {@link CAD_PROPERTY_PANEL_LABELS}. */
  readonly labels?: Partial<CadPropertyPanelLabels>;
  /** Extends the container classes; width defaults to the content. */
  readonly className?: string;
  /**
   * Suppresses the panel's own name strip, for a host that already
   * supplies one — a cockpit rail's collapsible `PanelSection` carries
   * the name and the count, and two stacked name strips is exactly the
   * duplication the rail zones exist to delete (LAYOUT.md 3.5).
   */
  readonly hideHeader?: boolean;
}

/** The visual presentation of one feature regeneration status. */
const STATUS_PRESENTATION: Readonly<
  Record<FeatureRegenerationStatus["state"], string>
> = Object.freeze({
  valid: "ink-dim",
  // `stale` is a WARN status, so it rides the system's warn colour (the
  // one `StatusDot` uses) instead of a raw Tailwind amber — a second amber
  // family beside the scheme's own signal was two accents pretending to be
  // one.
  stale: "text-signal",
  failed: "text-destructive font-medium",
  suppressed: "ink-dim italic",
});

/** One name-resolved piece of an input summary: what the ref points at. */
function inputSummaryOf(document: CadDocument, ref: FeatureInputRef): string {
  if (ref.kind === "parameter") {
    const parameter = document.parameters.parameters.find(
      (candidate) => candidate.id === ref.id,
    );
    return parameter === undefined ? String(ref.id) : parameter.name;
  }
  if (ref.kind === "body") {
    return bodyNameOf(document, ref.id) ?? String(ref.id);
  }
  const feature = document.features.find(
    (candidate) => candidate.id === ref.id,
  );
  return feature === undefined ? String(ref.id) : feature.kind;
}

/** The body's name, or `undefined` when the id no longer resolves. */
function bodyNameOf(document: CadDocument, id: BodyId): string | undefined {
  return document.bodies.find((body) => body.id === id)?.name;
}

/** The feature that outputs `id` (first producer), or `undefined`. */
function producingFeatureOf(
  document: CadDocument,
  id: BodyId,
): FeatureRecord | undefined {
  return document.features.find((feature) =>
    feature.outputs.some((output) => output === id),
  );
}

/** The features that consume `id` as an input, in document order. */
function consumingFeaturesOf(
  document: CadDocument,
  id: BodyId,
): readonly FeatureRecord[] {
  return document.features.filter((feature) =>
    feature.inputs.some((ref) => ref.kind !== "parameter" && ref.id === id),
  );
}

/**
 * The panel's shared row — the cockpit `PropertyRow`, not a second
 * implementation of it.
 *
 * This file used to carry its own name/value row: a flex pair with its own
 * gap, its own label ink and its own optional mono switch, re-deciding
 * locally what the design system already fixes (24px, label left in
 * `text-label` dim ink, tabular mono value right, a hairline instead of
 * air). That is exactly the drift DESIGN.md's density contract exists to
 * prevent, so the local row is now a thin adapter: it maps this panel's
 * (label, value, tone) shape onto the primitive and adds nothing of its
 * own but the status tone.
 */
function PropertyRow({
  label,
  value,
  valueClassName,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
}): ReactElement {
  return (
    <CockpitPropertyRow
      // A property VALUE here can be a joined list of feature kinds, so the
      // value column takes the flexible track and is allowed to shrink and
      // wrap; the label (one word) keeps its intrinsic width instead of
      // ellipsising under it.
      className="grid-cols-[auto_minmax(0,1fr)] items-baseline [&>[data-slot=property-value]]:min-w-0"
      label={label}
    >
      <span
        className={cn("w-full min-w-0 text-right break-words", valueClassName)}
      >
        {value}
      </span>
    </CockpitPropertyRow>
  );
}

/**
 * Reads the document hook, mapping the structured "no provider" error to
 * `null` — the same optional-read discipline as the viewport's, toolbar's,
 * tree's, and parameter panel's (the structured error is thrown before any
 * stateful hook, so removing a provider above a mounted panel re-renders
 * fewer hooks and fails loudly in React, a programming error reported as
 * one).
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

/** The store counterpart of {@link useOptionalCadDocument}. */
function useOptionalCadStore(): ReturnType<typeof useCadStore> | null {
  try {
    return useCadStore("CadPropertyPanel");
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** One selected reference's section: the rows its kind can answer. */
function PropertySection({
  document,
  labels,
  reference,
  status,
  onRemove,
  index,
  failureId,
}: {
  readonly document: CadDocument;
  readonly labels: CadPropertyPanelLabels;
  readonly reference: SelectionReference;
  readonly status: FeatureRegenerationStatus | undefined;
  readonly onRemove: CadPropertyRemove | undefined;
  readonly index: number;
  readonly failureId: string | undefined;
}): ReactElement {
  const unset = labels.unset;
  const rows: ReactElement[] = [];
  let removableFeatureId: FeatureId | undefined;

  if (reference.kind === "feature") {
    const feature = document.features.find(
      (candidate) => candidate.id === reference.featureId,
    );
    if (feature === undefined) {
      rows.push(
        <PropertyRow
          key="id"
          label={labels.rowId}
          value={String(reference.featureId)}
        />,
      );
      rows.push(
        <PropertyRow
          key="missing"
          label={labels.rowKind}
          value="feature (not in document)"
        />,
      );
    } else {
      removableFeatureId = feature.id;
      rows.push(
        <PropertyRow key="kind" label={labels.rowKind} value={feature.kind} />,
      );
      rows.push(
        <PropertyRow
          key="id"
          label={labels.rowId}
          value={String(feature.id)}
        />,
      );
      if (status !== undefined) {
        rows.push(
          <PropertyRow
            key="status"
            label="Status"
            value={status.state}
            valueClassName={STATUS_PRESENTATION[status.state]}
          />,
        );
      }
      rows.push(
        <PropertyRow
          key="inputs"
          label={labels.rowInputs}
          value={
            feature.inputs.length === 0
              ? unset
              : feature.inputs
                  .map((ref) => inputSummaryOf(document, ref))
                  .join(", ")
          }
        />,
      );
      rows.push(
        <PropertyRow
          key="outputs"
          label={labels.rowOutputs}
          value={
            feature.outputs.length === 0
              ? unset
              : feature.outputs
                  .map((id) => bodyNameOf(document, id) ?? String(id))
                  .join(", ")
          }
        />,
      );
    }
  } else {
    // body / solid / face / edge / vertex: all address a body.
    const bodyId: BodyId = reference.bodyId;
    const body: Body | undefined = document.bodies.find(
      (candidate) => candidate.id === bodyId,
    );
    rows.push(
      <PropertyRow
        key="name"
        label={labels.rowName}
        value={body === undefined ? String(bodyId) : body.name}
      />,
    );
    rows.push(
      <PropertyRow key="id" label={labels.rowId} value={String(bodyId)} />,
    );
    rows.push(
      <PropertyRow key="kind" label={labels.rowKind} value={reference.kind} />,
    );
    if (reference.kind === "body") {
      const producer = producingFeatureOf(document, bodyId);
      rows.push(
        <PropertyRow
          key="produced-by"
          label={labels.rowProducedBy}
          value={producer === undefined ? unset : producer.kind}
        />,
      );
      const consumers = consumingFeaturesOf(document, bodyId);
      rows.push(
        <PropertyRow
          key="consumed-by"
          label={labels.rowConsumedBy}
          value={
            consumers.length === 0
              ? unset
              : consumers.map((feature) => feature.kind).join(", ")
          }
        />,
      );
    }
    if (
      reference.kind === "face" ||
      reference.kind === "edge" ||
      reference.kind === "vertex"
    ) {
      const featureIndex =
        reference.kind === "face"
          ? reference.faceIndex
          : reference.kind === "edge"
            ? reference.edgeIndex
            : reference.vertexIndex;
      rows.push(
        <PropertyRow
          key="index"
          label={labels.rowIndex}
          value={String(featureIndex)}
        />,
      );
      rows.push(
        <PropertyRow
          key="regeneration"
          label={labels.rowRegeneration}
          value={String(reference.regeneration)}
        />,
      );
    }
  }

  const failure =
    status !== undefined &&
    status.state === "failed" &&
    status.diagnostics.length > 0
      ? status.diagnostics
      : undefined;

  return (
    <section
      aria-describedby={failureId}
      className="border-b border-rule-strong last:border-b-0"
      data-cad-property-section=""
      data-reference-kind={reference.kind}
    >
      {/* The rows run flush: each one carries its own hairline and its own
          24px, so a wrapping stack with a gap would re-space the density
          contract from outside it. Only the section's extras (a failure
          line, the remove verb) get panel padding. */}
      {rows}
      {failure !== undefined || removableFeatureId !== undefined ? (
        <div className="flex flex-col gap-(--gap) px-(--pad-row) py-(--gap)">
          {failure !== undefined ? (
            <div
              className="text-destructive text-ui"
              id={failureId}
              title={failure.map((diagnostic) => diagnostic.message).join("\n")}
            >
              {failure[0]?.message}
            </div>
          ) : null}
          {removableFeatureId !== undefined && onRemove !== undefined ? (
            <Button
              className="self-start"
              data-testid={`cad-property-remove-${String(index)}`}
              onClick={() => {
                onRemove(removableFeatureId);
              }}
              size="xs"
              title={labels.removeTooltip}
              type="button"
              variant="destructive"
            >
              {labels.remove}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The CAD property panel: the selection's properties, derived from the
 * document, with the feature remove action routed through the command
 * vocabulary, in one mountable component.
 */
export function CadPropertyPanel({
  className,
  hideHeader = false,
  document: documentProp,
  labels: labelOverrides,
  onRemoveFeature,
  regenerationStates,
  selection: selectionProp,
}: CadPropertyPanelProps) {
  const labels: CadPropertyPanelLabels = {
    ...CAD_PROPERTY_PANEL_LABELS,
    ...labelOverrides,
  };
  const documentApi = useOptionalCadDocument();
  const selectionApi = useOptionalCadSelection();
  const store = useOptionalCadStore();

  const cadDocument = documentProp ?? documentApi?.document;
  const selection = selectionProp ?? selectionApi?.selected ?? [];
  const remove =
    onRemoveFeature ??
    (store === null
      ? undefined
      : (featureId: FeatureId) =>
          toOutcome(
            store.applyTransaction(removeFeatureTransaction(featureId)),
          ));

  const [removeFailure, setRemoveFailure] = useState<string | undefined>(
    undefined,
  );

  const removeFeature: CadPropertyRemove | undefined =
    remove === undefined
      ? undefined
      : (featureId) => {
          setRemoveFailure(undefined);
          const outcome = remove(featureId);
          if (!outcome.ok) {
            setRemoveFailure(`${outcome.error.code}: ${outcome.error.message}`);
          }
          return outcome;
        };

  return (
    <div
      className={cn(
        "w-(--rail-w) overflow-hidden rounded-md border border-rule bg-panel text-ui",
        className,
      )}
      data-slot="cad-property-panel"
    >
      {/* The name strip is the cockpit `PanelHeader`: one fixed height, the
          section voice, and the selection count in the trailing slot. The
          count used to be printed in the SIGNAL colour — an accent spent on
          a number, which is the one thing DESIGN.md says it may never
          decorate. */}
      {hideHeader ? null : (
        <PanelHeader
          title={labels.title}
          trailing={
            cadDocument === undefined ? undefined : String(selection.length)
          }
        />
      )}
      {cadDocument === undefined ? (
        <p className="px-(--pad-row) py-(--gap) text-ui ink-dim">
          {labels.emptyDocument}
        </p>
      ) : selection.length === 0 ? (
        <p className="px-(--pad-row) py-(--gap) text-ui ink-dim">
          {labels.emptySelection}
        </p>
      ) : (
        <>
          {selection.map((reference, index) => (
            <PropertySection
              document={cadDocument}
              failureId={
                reference.kind === "feature"
                  ? `cad-property-${String(index)}-failure`
                  : undefined
              }
              index={index}
              // The domain's canonical key (includes the topology index), so
              // two same-kind synthetic references of one body at one
              // regeneration stay distinct siblings — same rule as the tree.
              key={selectionReferenceKey(reference)}
              labels={labels}
              onRemove={removeFeature}
              reference={reference}
              status={
                reference.kind === "feature"
                  ? regenerationStates?.get(reference.featureId)
                  : undefined
              }
            />
          ))}
          {removeFailure !== undefined ? (
            <div
              className="border-t border-rule px-(--pad-row) py-(--gap) text-ui text-destructive"
              data-cad-property-error=""
              role="alert"
            >
              {removeFailure}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
