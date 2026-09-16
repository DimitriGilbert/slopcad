import type { ReactNode } from "react";
import type {
  FormedibleFieldRenderProps,
  FormedibleFormValues,
  NormalizedFieldType,
} from "../lib/types";

import { AutocompleteField } from "./autocomplete-field";
import { CheckboxField } from "./checkbox-field";
import { ArrayField } from "./array-field";
import { ColorPickerField } from "./color-picker-field";
import { ComboboxField } from "./combobox-field";
import { DateField } from "./date-field";
import { DurationPickerField } from "./duration-picker-field";
import { FileUploadField } from "./file-upload-field";
import { LocationPickerField } from "./location-picker-field";
import { MaskedField } from "./masked-field";
import { MultiComboboxField } from "./multi-combobox-field";
import { MultiSelectField } from "./multi-select-field";
import { NumberField } from "./number-field";
import { ObjectField } from "./object-field";
import { PasswordField } from "./password-field";
import { PhoneField } from "./phone-field";
import { RadioField } from "./radio-field";
import { RatingField } from "./rating-field";
import { SelectField } from "./select-field";
import { SliderField } from "./slider-field";
import { SwitchField } from "./switch-field";
import { TextareaField } from "./textarea-field";
import { TextField } from "./text-field";

type FieldComponent = <TFormValues extends FormedibleFormValues>(
  props: FormedibleFieldRenderProps<TFormValues>,
) => ReactNode;

const fieldRegistry: Partial<Record<NormalizedFieldType, FieldComponent>> = {
  array: ArrayField,
  autocomplete: AutocompleteField,
  checkbox: CheckboxField,
  color: ColorPickerField,
  combobox: ComboboxField,
  date: DateField,
  duration: DurationPickerField,
  email: TextField,
  file: FileUploadField,
  location: LocationPickerField,
  masked: MaskedField,
  multiCombobox: MultiComboboxField,
  multiSelect: MultiSelectField,
  number: NumberField,
  object: ObjectField,
  password: PasswordField,
  phone: PhoneField,
  radio: RadioField,
  rating: RatingField,
  select: SelectField,
  slider: SliderField,
  switch: SwitchField,
  tel: TextField,
  text: TextField,
  textarea: TextareaField,
  url: TextField,
};

export function getFieldComponent<TFormValues extends FormedibleFormValues>(
  type: NormalizedFieldType | (string & {}),
): (props: FormedibleFieldRenderProps<TFormValues>) => ReactNode {
  return fieldRegistry[type as NormalizedFieldType] ?? TextField;
}
