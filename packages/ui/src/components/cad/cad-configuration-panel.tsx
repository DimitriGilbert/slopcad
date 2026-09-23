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
 *   input calling `onImportCsv` with the chosen file's text.
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

import { useFormedible } from "../formedible/hooks/use-formedible";
import { Button } from "../button";

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
  /** The host's last configuration notice (error region text). */
  readonly notice?: string | null;
  readonly labels?: Partial<CadConfigurationPanelLabels>;
  readonly className?: string;
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
  notice = null,
  labels: labelOverrides,
  className = "",
}: CadConfigurationPanelProps) {
  const labels = { ...CAD_CONFIGURATION_PANEL_LABELS, ...labelOverrides };

  const createForm = useFormedible<CreateValues>({
    fields: CREATE_FIELDS,
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

  const importCsv = async (files: FileList | null): Promise<void> => {
    const file = files?.[0];
    if (file === undefined || onImportCsv === undefined) return;
    const text = await file.text();
    onImportCsv(text);
  };

  const canSwitch = onSwitch !== undefined;

  return (
    <section
      data-testid="cad-configuration-panel"
      data-active-configuration={activeConfigurationId ?? "base"}
      aria-label={labels.title}
      className={`flex flex-col gap-3 p-3 text-sm ${className}`}
    >
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {labels.title}
      </h3>

      <fieldset
        role="radiogroup"
        aria-label={labels.switchLegend}
        className="flex flex-col gap-1"
      >
        <legend className="sr-only">{labels.switchLegend}</legend>
        {[null, ...configurations.map((row) => row.id)].map((id) => {
          const row = configurations.find((entry) => entry.id === id);
          const label = id === null ? labels.baseOption : (row?.name ?? id);
          const active = activeConfigurationId === id;
          return (
            <label
              key={id ?? "base"}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-accent data-[active=true]:bg-accent"
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
                className="accent-primary"
              />
              <span className="truncate">{label}</span>
            </label>
          );
        })}
      </fieldset>

      {configurations.length === 0 ? (
        <p className="text-xs text-muted-foreground">{labels.empty}</p>
      ) : (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">{labels.title}</th>
              <th
                className="py-1 pr-2 font-medium"
                title={labels.overridesHeading}
              >
                {labels.overridesHeading}
              </th>
              <th
                className="py-1 pr-2 font-medium"
                title={labels.suppressedHeading}
              >
                {labels.suppressedHeading}
              </th>
              <th
                className="py-1 pr-2 font-medium"
                title={labels.hiddenHeading}
              >
                {labels.hiddenHeading}
              </th>
              <th className="py-1 font-medium">
                <span className="sr-only">{labels.deleteLabel}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {configurations.map((row) => (
              <tr key={row.id} className="border-t border-border/60">
                <td className="max-w-32 truncate py-1 pr-2">{row.name}</td>
                <td className="py-1 pr-2 tabular-nums">{row.overrides}</td>
                <td className="py-1 pr-2 tabular-nums">{row.suppressed}</td>
                <td className="py-1 pr-2 tabular-nums">{row.hidden}</td>
                <td className="py-1 text-right">
                  {onDelete === undefined ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`${labels.deleteLabel}: ${row.name}`}
                      data-configuration-delete={row.id}
                      onClick={() => onDelete(row.id)}
                    >
                      ×
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {onCreate === undefined ? null : <createForm.Form />}

      <div className="flex gap-2">
        {onExportCsv === undefined ? null : (
          <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
            {labels.exportCsv}
          </Button>
        )}
        {onImportCsv === undefined ? null : (
          <label className="inline-flex">
            <span className="sr-only">{labels.importCsv}</span>
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label={labels.importCsv}
              data-testid="cad-configuration-csv-input"
              onChange={(event) => {
                void importCsv(event.target.files);
                event.target.value = "";
              }}
              className="w-44 text-xs file:mr-2 file:rounded file:border file:border-input file:bg-background file:px-2 file:py-0.5 file:text-xs"
            />
          </label>
        )}
      </div>

      {notice === null ? null : (
        <p
          role="alert"
          data-testid="cad-configuration-notice"
          className="text-xs text-destructive"
        >
          {notice}
        </p>
      )}
    </section>
  );
}
