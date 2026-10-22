/**
 * `CadConfigurationPanel` (Phase 57): the workbench's configuration surface
 * — the switcher, the configuration table, and the parameter-table CSV —
 * as one props-driven mountable component.
 *
 * ## What it renders
 *
 * - **The switcher**: a radiogroup listing the BASE document (the default)
 *   and every configuration row; switching invokes `onSwitch` and the host
 *   applies the effective view (the panel never mutates anything itself —
 *   the props are the write path, the parameter panel's discipline).
 * - **The table**: one row per configuration with its name and the counts
 *   of its overrides / suppressed features / hidden bodies, plus a delete
 *   affordance wired to `onDelete`.
 * - **The create form**: a Formedible form (the schema + field-config
 *   surface, never hand-rolled inputs) collecting the new row's name.
 * - **The CSV row**: an export affordance calling `onExportCsv` and a file
 *   input calling `onImportCsv` with the chosen file's text. A failed file
 *   read is caught — the fire-and-forget promise never rejects — and the
 *   error's own message surfaces through `onImportError`, the host's
 *   notice-surface channel; without the prop the refusal stays caught but
 *   unrendered (the inert discipline: the panel never invents a surface).
 *
 * ## State honesty
 *
 * The component holds no document state: `configurations`,
 * `activeConfigurationId`, and every callback are props. Every apply
 * failure surfaces through the host's `notice` string verbatim — the panel
 * renders it as its error region and invents no error text of its own.
 * With no `onSwitch` the switcher renders disabled (the toolbar's inert
 * discipline): the panel never pretends to apply.
 */

import { Download, Upload, X } from "lucide-react";

import { useFormedible } from "../formedible/hooks/use-formedible";
import { PanelHeader } from "../cockpit/panel";
import { ToolButton, ToolGroup } from "../cockpit/tool-button";
import { COCKPIT_FORM } from "./cad-form-density";

/** The panel's user-facing strings (overridable via the `labels` prop). */
export interface CadConfigurationPanelLabels {
  readonly title: string;
  readonly baseOption: string;
  readonly activeAria: string;
  readonly switchLegend: string;
  readonly createLabel: string;
  readonly createSubmit: string;
  readonly deleteLabel: string;
  readonly exportCsv: string;
  readonly importCsv: string;
  readonly overridesHeading: string;
  readonly suppressedHeading: string;
  readonly hiddenHeading: string;
  readonly empty: string;
}

export const CAD_CONFIGURATION_PANEL_LABELS: CadConfigurationPanelLabels = {
  title: "Configurations",
  baseOption: "Base document",
  activeAria: "Active configuration",
  switchLegend: "Switch configuration",
  createLabel: "New configuration name",
  createSubmit: "Create",
  deleteLabel: "Delete configuration",
  exportCsv: "Export CSV",
  importCsv: "Import CSV",
  overridesHeading: "over",
  suppressedHeading: "sup",
  hiddenHeading: "hid",
  empty: "No configurations yet.",
};

/** One table row: a configuration row's display data. */
export interface CadConfigurationRow {
  readonly id: string;
  readonly name: string;
  readonly overrides: number;
  readonly suppressed: number;
  readonly hidden: number;
}

export interface CadConfigurationPanelProps {
  readonly configurations: readonly CadConfigurationRow[];
  /** The active row's id, or `null` for the base document. */
  readonly activeConfigurationId: string | null;
  /** Applies a configuration; `null` returns to the base document. */
  readonly onSwitch?: (configurationId: string | null) => void;
  /** Creates a configuration row with the given name. */
  readonly onCreate?: (name: string) => void;
  /** Deletes the configuration row with the given id. */
  readonly onDelete?: (configurationId: string) => void;
  /** Produces the deterministic parameter-table CSV. */
  readonly onExportCsv?: () => string;
  /** Imports CSV text as parameter-table edits. */
  readonly onImportCsv?: (text: string) => void;
  /**
   * Reports a failed CSV file read: the error's own message, verbatim, for
   * the host's notice surface. Absent, a failed read is still caught (the
   * input's promise never rejects) but surfaces nowhere.
   */
  readonly onImportError?: (message: string) => void;
  /** The host's last configuration notice (error region text). */
  readonly notice?: string | null;
  readonly labels?: Partial<CadConfigurationPanelLabels>;
  readonly className?: string;
  /**
   * Suppresses the panel's own name strip, for a host that already
   * supplies one — a cockpit rail's collapsible `PanelSection` (LAYOUT.md
   * 3.5). The section's `aria-label` on this element still names it, so
   * nothing loses its accessible name.
   */
  readonly hideHeader?: boolean;
}

// Deliberately lenient at the form layer (and schema-free — the CAD
// component area imports no schema library): a disabled submit is a
// tab-order dead end inside the panel, so an empty/over-long name is
// submitted and refused by the DOMAIN (the host surfaces the structured
// refusal verbatim in the panel's notice region) — the domain-validated
// discipline.
interface CreateValues {
  readonly name: string;
  [key: string]: unknown;
}

// Module scope: configs minted per render fight the hook's defaultValues
// adoption gate (the Formedible discipline), so the field list is defined
// once.
const CREATE_FIELDS = [
  {
    name: "name",
    type: "text",
    label: "New configuration name",
  },
] as const;

const CREATE_DEFAULT_VALUES: CreateValues = { name: "" };

/**
 * The create form's submit, de-amped.
 *
 * Formedible's submit renders the Button's one filled variant, which put a
 * second amber slab in the right dock — directly under the parameter
 * panel's pinned Apply. DESIGN.md allows ONE confirming action per
 * surface, and in the dock's single glance that one is Apply (the
 * document-changing commit); minting a configuration row is a quiet
 * secondary verb, so it wears the panel's own control treatment at the
 * strip's control height. The label and the submit path are untouched.
 */
const CREATE_SUBMIT_CLASS =
  "h-(--tool-h) border-rule bg-panel text-ink-dim shadow-none " +
  "hover:bg-well hover:text-ink active:shadow-none";

/**
 * The CAD configuration panel: switcher, table, create form, and CSV row.
 */
export function CadConfigurationPanel({
  configurations,
  activeConfigurationId,
  onSwitch,
  onCreate,
  onDelete,
  onExportCsv,
  onImportCsv,
  onImportError,
  notice = null,
  labels: labelOverrides,
  className = "",
  hideHeader = false,
}: CadConfigurationPanelProps) {
  const labels = { ...CAD_CONFIGURATION_PANEL_LABELS, ...labelOverrides };

  const createForm = useFormedible<CreateValues>({
    ...COCKPIT_FORM,
    fields: CREATE_FIELDS,
    submitButtonClassName: CREATE_SUBMIT_CLASS,
    formOptions: {
      defaultValues: CREATE_DEFAULT_VALUES,
      onSubmit: ({ value }) => {
        onCreate?.(value.name.trim());
      },
    },
  });

  const exportCsv = (): void => {
    if (onExportCsv === undefined) return;
    onExportCsv();
  };

  // Fire-and-forget by the file input, so the promise must never reject: a
  // failed read (or a throwing host callback) is caught and reported through
  // onImportError — the host's notice channel — instead of dying unhandled.
  const importCsv = async (files: FileList | null): Promise<void> => {
    const file = files?.[0];
    if (file === undefined || onImportCsv === undefined) return;
    try {
      const text = await file.text();
      onImportCsv(text);
    } catch (error) {
      onImportError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const canSwitch = onSwitch !== undefined;

  return (
    <section
      data-testid="cad-configuration-panel"
      data-active-configuration={activeConfigurationId ?? "base"}
      aria-label={labels.title}
      className={`flex min-w-0 flex-col text-ui ${className}`}
    >
      {/* The panel's name strip is the cockpit `PanelHeader`, keeping its
          `h3` so the heading stays in the document outline; the padding
          moved off the panel and onto the body, because the switcher's rows
          run edge to edge like every other row in the cockpit. */}
      {hideHeader ? null : <PanelHeader title={labels.title} titleAs="h3" />}

      <fieldset
        role="radiogroup"
        aria-label={labels.switchLegend}
        className="flex min-w-0 flex-col"
      >
        <legend className="sr-only">{labels.switchLegend}</legend>
        {[null, ...configurations.map((row) => row.id)].map((id) => {
          const row = configurations.find((entry) => entry.id === id);
          const label = id === null ? labels.baseOption : (row?.name ?? id);
          const active = activeConfigurationId === id;
          return (
            /*
             * The active configuration is a SELECTED ENTITY, so it wears
             * the system's selection treatment — the row wash plus the
             * signal edge on the inline start (`PropertyRow`'s selected
             * appearance, by value) — instead of the flat `--accent` fill
             * it used to carry. One accent, one meaning: the amber on this
             * row says "this is the configuration you are looking at".
             */
            <label
              key={id ?? "base"}
              className="flex min-h-(--row-h) cursor-pointer items-center gap-(--gap) border-l-2 border-l-transparent px-(--pad-row) text-ui text-ink transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-well data-[active=true]:border-l-select-edge data-[active=true]:bg-select-wash data-[active=true]:text-select-ink"
              data-active={active}
            >
              <input
                type="radio"
                name="cad-configuration-switcher"
                role="radio"
                aria-checked={active}
                aria-label={`${labels.activeAria}: ${label}`}
                checked={active}
                disabled={!canSwitch}
                onChange={() => onSwitch?.(id)}
                className="size-3 accent-select-edge"
              />
              <span className="truncate">{label}</span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex min-w-0 flex-col gap-(--gap-group) p-(--pad-panel)">
        {configurations.length === 0 ? (
          <p className="text-ui text-ink-dim">{labels.empty}</p>
        ) : (
          /* The counts table keeps the row rhythm: `--row-h` cells, the
             label voice in the head, tabular mono figures, and a hairline
             between rows instead of a boxed grid. */
          <table className="w-full border-collapse text-ui">
            <thead>
              <tr className="text-left">
                <th className="h-(--row-h) pr-(--gap) text-label font-normal text-ink-dim">
                  {labels.title}
                </th>
                <th
                  className="h-(--row-h) pr-(--gap) text-label font-normal text-ink-dim"
                  title={labels.overridesHeading}
                >
                  {labels.overridesHeading}
                </th>
                <th
                  className="h-(--row-h) pr-(--gap) text-label font-normal text-ink-dim"
                  title={labels.suppressedHeading}
                >
                  {labels.suppressedHeading}
                </th>
                <th
                  className="h-(--row-h) pr-(--gap) text-label font-normal text-ink-dim"
                  title={labels.hiddenHeading}
                >
                  {labels.hiddenHeading}
                </th>
                <th className="h-(--row-h)">
                  <span className="sr-only">{labels.deleteLabel}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {configurations.map((row) => (
                <tr key={row.id} className="border-t border-rule/60">
                  <td className="h-(--row-h) max-w-32 truncate pr-(--gap)">
                    {row.name}
                  </td>
                  <td className="h-(--row-h) pr-(--gap) font-mono text-data tabular">
                    {row.overrides}
                  </td>
                  <td className="h-(--row-h) pr-(--gap) font-mono text-data tabular">
                    {row.suppressed}
                  </td>
                  <td className="h-(--row-h) pr-(--gap) font-mono text-data tabular">
                    {row.hidden}
                  </td>
                  <td className="h-(--row-h) text-right">
                    {onDelete === undefined ? null : (
                      <ToolButton
                        aria-label={`${labels.deleteLabel}: ${row.name}`}
                        className="w-(--control-h) justify-center px-0"
                        data-configuration-delete={row.id}
                        onClick={() => onDelete(row.id)}
                        size="sm"
                        title={`${labels.deleteLabel}: ${row.name}`}
                        tone="destructive"
                      >
                        <X aria-hidden="true" />
                      </ToolButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {onCreate === undefined ? null : <createForm.Form />}

        {/* The parameter-table exchange: icon controls, the strip's
            dialect (step 2) — the name the text buttons carried is now the
            `aria-label` and the `title`, so nothing lost a name. */}
        <ToolGroup label="Parameter table" separated={false}>
          {onExportCsv === undefined ? null : (
            <ToolButton
              aria-label={labels.exportCsv}
              onClick={exportCsv}
              size="icon"
              title={labels.exportCsv}
            >
              <Download aria-hidden="true" />
            </ToolButton>
          )}
          {onImportCsv === undefined ? null : (
            /*
             * A native file input renders the browser's own "Choose File /
             * No file chosen" control, which in a CAD rail reads as an
             * unstyled escape hatch (and overflowed it). The input keeps its
             * testid and its accessible name — it is still the real control,
             * and the label still activates it — but it stops drawing
             * itself, and the label wears the product's control treatment.
             */
            <label
              className="inline-flex size-(--tool-h) cursor-pointer items-center justify-center rounded-sm border border-transparent text-ink-dim transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-well hover:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-(--focus)"
              title={labels.importCsv}
            >
              <Upload aria-hidden="true" className="size-3.5 shrink-0" />
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label={labels.importCsv}
                data-testid="cad-configuration-csv-input"
                onChange={(event) => {
                  void importCsv(event.target.files);
                  event.target.value = "";
                }}
                className="sr-only"
              />
            </label>
          )}
        </ToolGroup>

        {notice === null ? null : (
          <p
            role="alert"
            data-testid="cad-configuration-notice"
            className="text-ui text-destructive"
          >
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
