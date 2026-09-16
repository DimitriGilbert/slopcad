import type {
  FormedibleFieldRenderProps,
  FormedibleFormValues,
} from "../lib/types";

import { FieldWrapper } from "./field-wrapper";
import { Checkbox } from "../../checkbox";

export function CheckboxField<TFormValues extends FormedibleFormValues>({
  fieldConfig,
  field,
}: FormedibleFieldRenderProps<TFormValues>) {
  const checked = field.value === true;

  return (
    <FieldWrapper fieldConfig={fieldConfig} field={field}>
      <Checkbox
        id={field.id}
        name={field.name}
        checked={checked}
        disabled={fieldConfig.disabled}
        required={fieldConfig.required}
        aria-invalid={field.error ? true : undefined}
        className={fieldConfig.inputClassName}
        onBlur={field.onBlur}
        onCheckedChange={(nextChecked) => field.onChange(nextChecked === true)}
      />
    </FieldWrapper>
  );
}
