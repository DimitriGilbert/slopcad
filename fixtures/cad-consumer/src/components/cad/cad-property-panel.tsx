import { useState } from "react";
import type { ReactElement } from "react";
import {
  CadProviderError,
  removeFeatureTransaction,
  useCadDocument,
  useCadSelection,
  useCadStore,
  type Body,
  type BodyId,
  type CadDocument,
  type FeatureId,
  type FeatureInputRef,
  type FeatureRecord,
  type FeatureRegenerationStatus,
  type RegenerationStateMap,
  type SelectionReference,
} from "@slopcad/cad-react";
import { cn } from "cn";

import { Button } from "../button";

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
}

/** The visual presentation of one feature regeneration status. */
const STATUS_PRESENTATION: Readonly<
  Record<FeatureRegenerationStatus["state"], string>
> = Object.freeze({
  valid: "text-muted-foreground",
  stale: "text-amber-600 dark:text-amber-400",
  failed: "text-destructive font-medium",
  suppressed: "text-muted-foreground italic",
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

/** The panel's shared row: a muted label left, the value right, mono. */
function PropertyRow({
  label,
  value,
  valueClassName,
  mono = true,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueClassName?: string;
  readonly mono?: boolean;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right break-words",
          mono && "font-mono",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
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
        <PropertyRow
          key="kind"
          label={labels.rowKind}
          value={feature.kind}
          mono={false}
        />,
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
            mono={false}
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
        mono={body === undefined}
      />,
    );
    rows.push(
      <PropertyRow key="id" label={labels.rowId} value={String(bodyId)} />,
    );
    rows.push(
      <PropertyRow
        key="kind"
        label={labels.rowKind}
        value={reference.kind}
        mono={false}
      />,
    );
    if (reference.kind === "body") {
      const producer = producingFeatureOf(document, bodyId);
      rows.push(
        <PropertyRow
          key="produced-by"
          label={labels.rowProducedBy}
          value={producer === undefined ? unset : producer.kind}
          mono={producer === undefined}
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
      className="border-border/60 border-b last:border-b-0"
      data-cad-property-section=""
      data-reference-kind={reference.kind}
    >
      <div className="flex flex-col gap-1.5 px-2 py-2 text-xs">
        {rows}
        {failure !== undefined ? (
          <div
            className="text-destructive leading-4"
            id={failureId}
            title={failure.map((diagnostic) => diagnostic.message).join("\n")}
          >
            {failure[0]?.message}
          </div>
        ) : null}
        {removableFeatureId !== undefined && onRemove !== undefined ? (
          <Button
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
      : (featureId: FeatureId) => {
          const applied = store.applyTransaction(
            removeFeatureTransaction(featureId),
          );
          return applied.ok
            ? { ok: true }
            : { ok: false, error: applied.error };
        });

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
        "border-border bg-background w-72 border text-sm",
        className,
      )}
      data-slot="cad-property-panel"
    >
      <div className="text-muted-foreground border-border flex items-baseline justify-between border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
        <span>{labels.title}</span>
        {cadDocument !== undefined ? (
          <span className="font-mono normal-case">
            {String(selection.length)}
          </span>
        ) : null}
      </div>
      {cadDocument === undefined ? (
        <div className="text-muted-foreground px-2 py-2">
          {labels.emptyDocument}
        </div>
      ) : selection.length === 0 ? (
        <div className="text-muted-foreground px-2 py-2">
          {labels.emptySelection}
        </div>
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
              key={
                reference.kind === "feature"
                  ? `feature:${String(reference.featureId)}`
                  : reference.kind === "body" || reference.kind === "solid"
                    ? `${reference.kind}:${String(reference.bodyId)}`
                    : `${reference.kind}:${String(reference.bodyId)}:${String(reference.regeneration)}`
              }
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
              className="text-destructive border-border border-t px-2 py-1.5 text-xs leading-4"
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
