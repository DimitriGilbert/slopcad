import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFormedible } from "./hooks/use-formedible";

const contactSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Enter a valid email"),
});

type ContactValues = z.infer<typeof contactSchema>;

const defaultValues: ContactValues = { name: "", email: "" };

function ContactForm({
  onSubmit,
}: {
  onSubmit: (values: ContactValues) => void;
}) {
  const contactForm = useFormedible<ContactValues>({
    schema: contactSchema,
    fields: [
      { name: "name", type: "text", label: "Full name", required: true },
      { name: "email", type: "email", label: "Email", required: true },
    ],
    formOptions: {
      defaultValues,
      onSubmit: async ({ value }) => {
        onSubmit(value);
      },
    },
  });

  return <contactForm.Form data-testid="contact-form" />;
}

afterEach(cleanup);

describe("Formedible", () => {
  it("renders a form from a field-config object with labelled inputs", () => {
    render(<ContactForm onSubmit={() => {}} />);

    // The required marker renders as an aria-hidden asterisk inside the
    // label, so match on the leading text rather than the full content.
    expect(screen.getByLabelText(/^Full name/)).toBeTruthy();
    expect(screen.getByLabelText(/^Email/)).toBeTruthy();
  });

  it("surfaces schema validation errors on an invalid submit", async () => {
    render(<ContactForm onSubmit={() => {}} />);

    // A present-but-invalid value falls through Formedible's built-in
    // required check to the zod schema's own message.
    fireEvent.change(screen.getByLabelText(/^Full name/), {
      target: { value: "A" },
    });
    fireEvent.submit(screen.getByTestId("contact-form"));

    expect(
      await screen.findByText("Name must be at least 2 characters"),
    ).toBeTruthy();
  });

  it("delivers typed values to the configured submit handler", async () => {
    const onSubmit = vi.fn();
    render(<ContactForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/^Full name/), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.change(screen.getByLabelText(/^Email/), {
      target: { value: "ada@slopcad.dev" },
    });
    fireEvent.submit(screen.getByTestId("contact-form"));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: "Ada Lovelace",
        email: "ada@slopcad.dev",
      }),
    );
  });
});
