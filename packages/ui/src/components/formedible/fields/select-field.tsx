import type {
  FormedibleFieldRenderProps,
  FormedibleFormValues,
} from "../lib/types";

import { FieldWrapper } from "./field-wrapper";
import { resolveFieldOptions } from "./advanced-field-utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../select";

export function SelectField<TFormValues extends FormedibleFormValues>({
  fieldConfig,
  field,
}: FormedibleFieldRenderProps<TFormValues>) {
  const value = typeof field.value === "string" ? field.value : "";
  const options = resolveFieldOptions(fieldConfig, field.formValues);

  // Radix's SelectValue derives the selected item's text from the mounted
  // listbox, so a set value renders as its RAW value string until the
  // first open. Resolving the label ourselves (and handing it to
  // SelectValue as children) makes the closed trigger honest pre-open:
  // the human label when the value matches an option, the placeholder
  // otherwise.
  const selected = options.find((option) => option.value === value);

  return (
    <FieldWrapper fieldConfig={fieldConfig} field={field}>
      <Select
        value={value}
        disabled={fieldConfig.disabled}
        required={fieldConfig.required}
        onValueChange={field.onChange}
      >
        <SelectTrigger
          id={field.id}
          name={field.name}
          aria-invalid={field.error ? true : undefined}
          className={fieldConfig.inputClassName}
          onBlur={field.onBlur}
        >
          <SelectValue placeholder={fieldConfig.placeholder}>
            {selected?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </FieldWrapper>
  );
}
