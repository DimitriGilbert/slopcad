import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptForm } from "./prompt-form";

afterEach(cleanup);

function typeMessage(text: string) {
  const textarea = screen.getByLabelText("Chat message");
  fireEvent.change(textarea, { target: { value: text } });
  return textarea;
}

describe("PromptForm", () => {
  it("submits the trimmed text on Enter and clears the composer", () => {
    const onSubmit = vi.fn();
    render(<PromptForm isBusy={false} onSubmit={onSubmit} onStop={vi.fn()} />);

    const textarea = typeMessage("  extrude the base  ");
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("extrude the base");
    expect(screen.getByLabelText("Chat message")).toHaveProperty("value", "");
  });

  it("keeps the composer open on Shift+Enter", () => {
    const onSubmit = vi.fn();
    render(<PromptForm isBusy={false} onSubmit={onSubmit} onStop={vi.fn()} />);

    const textarea = typeMessage("line one");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveProperty("value", "line one");
  });

  it("ignores Enter during IME composition", () => {
    const onSubmit = vi.fn();
    render(<PromptForm isBusy={false} onSubmit={onSubmit} onStop={vi.fn()} />);

    const textarea = typeMessage("kata");
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables Send until there is text", () => {
    render(<PromptForm isBusy={false} onSubmit={vi.fn()} onStop={vi.fn()} />);

    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toHaveProperty("disabled", true);

    typeMessage("hello");

    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("morphs into Stop while busy and routes the abort to onStop", () => {
    const onStop = vi.fn();
    render(<PromptForm isBusy={true} onSubmit={vi.fn()} onStop={onStop} />);

    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));

    expect(onStop).toHaveBeenCalledOnce();
  });

  it("blocks editing and submission when disabled and surfaces the reason", () => {
    const onSubmit = vi.fn();
    render(
      <PromptForm
        isBusy={false}
        onSubmit={onSubmit}
        onStop={vi.fn()}
        disabled={true}
        disabledReason="Configure a provider in agent settings first."
      />,
    );

    const textarea = screen.getByLabelText("Chat message");
    expect(textarea).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    expect(
      screen.getByText("Configure a provider in agent settings first."),
    ).toBeTruthy();
    expect(textarea.getAttribute("aria-describedby")).toBe(
      "prompt-form-disabled-reason",
    );
  });

  it("renders the host-injected model slot in the footer row", () => {
    render(
      <PromptForm
        isBusy={false}
        onSubmit={vi.fn()}
        onStop={vi.fn()}
        modelSlot={<button type="button">Model: user-picked</button>}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Model: user-picked" }),
    ).toBeTruthy();
  });
});
