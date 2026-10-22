/**
 * The model field's renderer (agent settings sheet): a `command`-based,
 * family-grouped picker behind a select-like trigger, delivered to the
 * Formedible form as a custom field `component` so the raw form config in
 * `./agent-settings-form` stays React-free. The sheet passes the LIVE
 * provider's options and the source's status through the field config's
 * `pickerData` custom prop ({@link MODEL_PICKER_DATA_PROP}).
 *
 * Contracts it keeps with the form:
 *
 * - the committed value is the model ID string (the `modelId` field —
 *   the form's `onChange` mirror then copies the pick into `rawModelId`,
 *   the raw-first resolution authority);
 * - a hand-typed raw id stays visible and wins: the trigger shows the
 *   RESOLVED model (raw override when one is typed), and the picker's
 *   "Not chosen" entry plus the empty/error states all name the raw-id
 *   field as the escape hatch (D5's always-typable rule);
 * - honest states only: `loading`/`error`/`empty` print their reason
 *   inside the list — an error keeps serving whatever entries the cache
 *   held, labelled, never a fake success.
 */

import { useState } from "react";
import type { ReactElement } from "react";
import { ChevronsUpDownIcon } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@slopcad/ui/components/command";
import type { FormedibleFieldComponentProps } from "@slopcad/ui/components/formedible/lib/types";
import { FieldWrapper } from "@slopcad/ui/components/formedible/fields/field-wrapper";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@slopcad/ui/components/popover";

import {
  groupModelPickerOptions,
  MODEL_PICKER_DATA_PROP,
  type AgentModelPickerData,
  type AgentSettingsValues,
} from "./agent-settings-form";

/**
 * The value the "Not chosen" entry carries — cmdk values must be
 * non-empty strings, so the un-pick rides a sentinel the select handler
 * maps back to `""` (the form's own unset choice).
 */
const UNSET_ITEM_VALUE = "__agent-model-unset__";

/** The fallback data when the field config carries no picker payload. */
const NO_PICKER_DATA: AgentModelPickerData = {
  emptyText: "No models to list — type a raw id in the Model id field.",
  options: [],
  status: { kind: "empty", message: "No picker data was provided." },
};

interface PickerDataCandidate {
  readonly options?: unknown;
  readonly emptyText?: unknown;
  readonly status?: unknown;
}

/** Narrows the custom prop, tolerating a missing or wrong-shaped payload. */
function readPickerData(value: unknown): AgentModelPickerData {
  if (typeof value !== "object" || value === null) {
    return NO_PICKER_DATA;
  }
  const candidate = value as PickerDataCandidate;
  if (
    Array.isArray(candidate.options) &&
    typeof candidate.emptyText === "string" &&
    typeof candidate.status === "object" &&
    candidate.status !== null
  ) {
    return value as AgentModelPickerData;
  }
  return NO_PICKER_DATA;
}

/** The status line shown above the groups while the source is not ready. */
function PickerStatusNote({
  status,
}: {
  readonly status: AgentModelPickerData["status"];
}): ReactElement | null {
  if (status.kind === "ready") {
    return null;
  }
  const message =
    status.kind === "loading" ? "Loading the model list…" : status.message;
  return (
    <div
      className={`border-b border-rule px-(--pad-row) py-1.5 text-ui ${
        status.kind === "error" ? "text-destructive" : "ink-dim"
      }`}
      data-testid="agent-settings-picker-status"
      role={status.kind === "error" ? "alert" : "status"}
    >
      {message}
    </div>
  );
}

export function AgentModelPickerField(
  props: FormedibleFieldComponentProps<AgentSettingsValues>,
): ReactElement {
  const { field, fieldConfig } = props;
  const [open, setOpen] = useState(false);
  const data = readPickerData(fieldConfig[MODEL_PICKER_DATA_PROP]);

  // The raw-id override wins the trigger's display too — the committed
  // truth is `resolveSettingsModelId`, so the control must not advertise
  // a stale pick while a hand-typed id is what will be sent.
  const formValues = field.formValues;
  const rawOverride =
    typeof formValues?.rawModelId === "string"
      ? formValues.rawModelId.trim()
      : "";
  const picked = typeof field.value === "string" ? field.value : "";
  const pickedOption = data.options.find((option) => option.value === picked);
  const displayValue = rawOverride !== "" ? rawOverride : picked;
  // The human name only when the pick resolved in the list AND it differs
  // from the id — a saved-but-unlisted id shows as a bare mono id.
  const displayLabel =
    rawOverride !== "" || pickedOption === undefined
      ? null
      : pickedOption.label === pickedOption.value
        ? null
        : pickedOption.label;

  const groups = groupModelPickerOptions(data.options);

  return (
    <FieldWrapper fieldConfig={fieldConfig} field={field}>
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            field.onBlur();
          }
        }}
        open={open}
      >
        <PopoverTrigger
          aria-invalid={field.error ? true : undefined}
          aria-label={typeof props.label === "string" ? props.label : "Model"}
          className="flex h-8 w-full min-w-0 cursor-default items-center justify-between gap-1.5 rounded-none border border-input bg-transparent px-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20"
          data-testid="agent-settings-model-picker"
          disabled={fieldConfig.disabled}
          id={field.id}
        >
          <span className="flex min-w-0 items-baseline gap-1.5 truncate">
            {displayValue === "" ? (
              <span className="truncate text-muted-foreground">
                {fieldConfig.placeholder ?? "Choose a model…"}
              </span>
            ) : (
              <>
                {displayLabel === null ? null : (
                  <span className="truncate">{displayLabel}</span>
                )}
                <span
                  className={`truncate font-mono tabular ${
                    displayLabel === null
                      ? ""
                      : "text-[10px] text-muted-foreground"
                  }`}
                >
                  {displayValue}
                </span>
                {rawOverride !== "" && rawOverride !== picked ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    (raw id)
                  </span>
                ) : null}
              </>
            )}
          </span>
          <ChevronsUpDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="Model list"
          className="w-[min(30rem,calc(100dvw-4rem))] gap-0 rounded-md border border-rule-strong bg-overlay p-0 ring-0 shadow-overlay"
        >
          <Command className="rounded-md bg-overlay ink">
            <CommandInput
              aria-label="Search models"
              placeholder="Search models…"
            />
            <CommandList>
              <PickerStatusNote status={data.status} />
              <CommandEmpty className="ink-dim">
                {data.status.kind === "loading"
                  ? "Loading the model list…"
                  : data.status.kind === "error"
                    ? data.status.message
                    : data.options.length === 0
                      ? data.emptyText
                      : "No models match — type the raw id in the Model id field."}
              </CommandEmpty>
              {picked !== "" ? (
                <CommandGroup heading="Current">
                  <CommandItem
                    keywords={["none", "unset", "clear"]}
                    onSelect={() => {
                      field.onChange("");
                      setOpen(false);
                    }}
                    value={UNSET_ITEM_VALUE}
                  >
                    <span className="ink-dim">Not chosen</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {groups.map((group) => (
                <CommandGroup heading={group.family} key={group.family}>
                  {group.options.map((option) => (
                    <CommandItem
                      data-checked={option.value === picked}
                      key={option.value}
                      keywords={[option.label, option.family]}
                      onSelect={() => {
                        field.onChange(option.value);
                        setOpen(false);
                      }}
                      value={option.value}
                    >
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate">{option.label}</span>
                        {option.label === option.value ? null : (
                          <span className="truncate font-mono text-micro ink-faint tabular">
                            {option.value}
                          </span>
                        )}
                      </span>
                      {option.detail === undefined ? null : (
                        <span className="ml-auto shrink-0 font-mono text-micro ink-faint tabular">
                          {option.detail}
                        </span>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
            <div className="border-t border-rule px-(--pad-row) py-1.5 text-micro ink-faint">
              Missing a model? Type its raw id in the Model id field — it
              overrides this pick.
            </div>
          </Command>
        </PopoverContent>
      </Popover>
    </FieldWrapper>
  );
}
