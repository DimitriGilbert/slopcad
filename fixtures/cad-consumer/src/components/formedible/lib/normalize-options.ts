import type {
  FormedibleFormValues,
  NormalizedUseFormedibleOptions,
  UseFormedibleOptions,
} from "./types";

import { normalizeFieldConfig } from "./normalize-field-config";

export function normalizeOptions<TFormValues extends FormedibleFormValues>(
  options: UseFormedibleOptions<TFormValues>,
): NormalizedUseFormedibleOptions<TFormValues> {
  return {
    ...options,
    fields: (options.fields ?? []).map((field) => normalizeFieldConfig(field)),
  };
}
