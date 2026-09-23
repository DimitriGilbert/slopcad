import { cn } from "cn";
import type {
  FormedibleFieldRenderProps,
  FormedibleFormValues,
} from "../lib/types";

import {
  hasDatalistOptions,
  renderDatalistOptions,
} from "./advanced-field-utils";
import { FieldWrapper } from "./field-wrapper";
import { Input } from "../../input";

export function NumberField<TFormValues extends FormedibleFormValues>({
  fieldConfig,
  field,
}: FormedibleFieldRenderProps<TFormValues>) {
  const value =
    typeof field.value === "number" || typeof field.value === "string"
      ? field.value
      : "";
  const min = fieldConfig.min ?? fieldConfig.numberConfig?.min;
  const max = fieldConfig.max ?? fieldConfig.numberConfig?.max;
  const step = fieldConfig.step ?? fieldConfig.numberConfig?.step;
  const datalistId = `${field.id}-datalist`;

  const input = (
    <Input
      id={field.id}
      name={field.name}
      type="number"
      value={value}
      placeholder={fieldConfig.placeholder}
      list={hasDatalistOptions(fieldConfig.datalist) ? datalistId : undefined}
      disabled={fieldConfig.disabled}
      required={fieldConfig.required}
      min={min}
      max={max}
      step={step}
      aria-invalid={field.error ? true : undefined}
      className={cn(
        // Room for the suffix tag on the control's right edge.
        fieldConfig.suffix === undefined ? undefined : "pr-10",
        fieldConfig.inputClassName,
      )}
      onBlur={field.onBlur}
      onChange={(event) =>
        field.onChange(
          event.target.value === "" ? undefined : event.target.valueAsNumber,
        )
      }
    />
  );

  return (
    <FieldWrapper fieldConfig={fieldConfig} field={field}>
      {fieldConfig.suffix === undefined ? (
        input
      ) : (
        <div className="relative flex w-full items-center">
          {input}
          {/* The unit as an aria-hidden tag: decoration beside the value,
              never part of the field's accessible name. */}
          <span
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute right-2.5 font-mono text-[11px]"
            data-slot="field-suffix"
          >
            {fieldConfig.suffix}
          </span>
        </div>
      )}
      {renderDatalistOptions(datalistId, fieldConfig.datalist)}
    </FieldWrapper>
  );
}
