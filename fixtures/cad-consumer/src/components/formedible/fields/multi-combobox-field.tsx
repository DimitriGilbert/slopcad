import type {
  FormedibleFieldRenderProps,
  FormedibleFormValues,
} from "../lib/types";

import { MultiSelectField } from "./multi-select-field";

export function MultiComboboxField<TFormValues extends FormedibleFormValues>(
  props: FormedibleFieldRenderProps<TFormValues>,
) {
  return (
    <MultiSelectField
      {...props}
      fieldConfig={{
        ...props.fieldConfig,
        multiSelectConfig:
          props.fieldConfig.multiComboboxConfig ??
          props.fieldConfig.multiSelectConfig,
      }}
    />
  );
}
