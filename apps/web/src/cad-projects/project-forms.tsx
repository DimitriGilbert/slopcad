/**
 * The project surface's forms (Phase 31): Formedible config objects —
 * schema + field list + options — not hand-rolled TSX forms. The two
 * forms the product needs to bring documents into the persisted world:
 * creating a project and creating a document inside it. Each component is
 * the hook plus the rendered `Form`; the wire-up (tRPC mutation, toast,
 * navigation) lives in the routes and flows through `onSubmitted`.
 */

import {
  DOCUMENT_NAME_MAX_LENGTH,
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@slopcad/api/limits";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { ReactElement } from "react";
import { z } from "zod";

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the project a name")
    .max(
      PROJECT_NAME_MAX_LENGTH,
      `Keep the name under ${PROJECT_NAME_MAX_LENGTH} characters`,
    ),
  description: z
    .string()
    .trim()
    .max(
      PROJECT_DESCRIPTION_MAX_LENGTH,
      `Keep the description under ${PROJECT_DESCRIPTION_MAX_LENGTH} characters`,
    )
    .optional(),
});

export type CreateProjectValues = z.infer<typeof createProjectSchema>;

export const createProjectFields = [
  {
    name: "name",
    type: "text",
    label: "Project name",
    placeholder: "Bracket redesign",
    required: true,
    maxLength: PROJECT_NAME_MAX_LENGTH,
  },
  {
    name: "description",
    type: "textarea",
    label: "Description",
    placeholder: "What lives in this project?",
    rows: 2,
    maxLength: PROJECT_DESCRIPTION_MAX_LENGTH,
  },
] as const;

/** The create-project form: config object in, typed submit out. */
export function CreateProjectForm({
  onSubmitted,
  submitLabel = "Create project",
}: {
  readonly onSubmitted: (values: CreateProjectValues) => Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<CreateProjectValues>({
    schema: createProjectSchema,
    fields: createProjectFields,
    formOptions: {
      defaultValues: { name: "", description: "" },
      onSubmit: async ({ value }) => {
        await onSubmitted(value);
      },
    },
    resetOnSubmitSuccess: true,
    submitLabel,
    submitButtonClassName: "w-full",
  });
  return <form.Form aria-label="Create project" className="space-y-3" />;
}

export const createDocumentSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the document a name")
    .max(
      DOCUMENT_NAME_MAX_LENGTH,
      `Keep the name under ${DOCUMENT_NAME_MAX_LENGTH} characters`,
    ),
});

export type CreateDocumentValues = z.infer<typeof createDocumentSchema>;

export const createDocumentFields = [
  {
    name: "name",
    type: "text",
    label: "Document name",
    placeholder: "carrier-plate",
    required: true,
    maxLength: DOCUMENT_NAME_MAX_LENGTH,
  },
] as const;

/** The create-document form: one field, one deliberate action. */
export function CreateDocumentForm({
  onSubmitted,
  submitLabel = "Create document",
}: {
  readonly onSubmitted: (values: CreateDocumentValues) => Promise<void>;
  readonly submitLabel?: string;
}): ReactElement {
  const form = useFormedible<CreateDocumentValues>({
    schema: createDocumentSchema,
    fields: createDocumentFields,
    formOptions: {
      defaultValues: { name: "" },
      onSubmit: async ({ value }) => {
        await onSubmitted(value);
      },
    },
    resetOnSubmitSuccess: true,
    submitLabel,
    submitButtonClassName: "w-full",
  });
  return <form.Form aria-label="Create document" className="space-y-3" />;
}
