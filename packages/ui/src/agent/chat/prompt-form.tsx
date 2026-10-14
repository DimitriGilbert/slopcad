/**
 * Adapted from shadcn-ui/chatbot-template (`components/prompt-form.tsx`), MIT
 * License — Copyright (c) 2026 shadcn,
 * https://github.com/shadcn-ui/chatbot-template.
 *
 * Modified for slopcad: the template's `ModelSelect`/`GatewayModel` pair is
 * replaced by a host-injected `modelSlot` node — the form never names a model
 * or provider, the host owns that affordance (D5: nothing preselected, raw
 * string always typable elsewhere). Also adds a disabled-with-reason state so
 * the composer can block sending until the agent is configured, and rides the
 * registry's input-group primitives (installed as a sibling item). Zero
 * AI-SDK / AI-Gateway imports.
 *
 * Kept from the template: Enter sends, Shift+Enter newlines, IME composition
 * guarded (`isComposing`), and one button morphing ArrowUp "Send" ↔ Square
 * "Stop generating" with explicit `aria-label`s.
 */

import { ArrowUpIcon, SquareIcon } from "lucide-react";
import * as React from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../../components/input-group";

const disabledReasonId = "prompt-form-disabled-reason";

export interface PromptFormProps {
  /** Called with the trimmed text when the composer submits. */
  onSubmit: (text: string) => void;
  /** Called when the user aborts an in-flight generation. */
  onStop: () => void;
  /** True while a response streams; morphs the Send button into Stop. */
  isBusy: boolean;
  /**
   * Host-injected model affordance rendered at the block-end slot of the
   * composer's footer row — a picker, a plain model label, or a button that
   * opens model settings. The form itself owns no model state.
   */
  modelSlot?: React.ReactNode;
  /** Blocks editing and submission until the host is configured. */
  disabled?: boolean;
  /** Why the composer is disabled; rendered as muted helper text. */
  disabledReason?: string;
  placeholder?: string;
}

export function PromptForm({
  onSubmit,
  onStop,
  isBusy,
  modelSlot,
  disabled = false,
  disabledReason,
  placeholder = "Send a message…",
}: PromptFormProps) {
  const [input, setInput] = React.useState("");

  function handleSubmit(event?: React.FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || isBusy || disabled) return;
    onSubmit(text);
    setInput("");
  }

  return (
    <form onSubmit={handleSubmit}>
      <InputGroup>
        <InputGroupTextarea
          placeholder={placeholder}
          aria-label="Chat message"
          aria-describedby={
            disabled && disabledReason ? disabledReasonId : undefined
          }
          className="p-3.5"
          value={input}
          disabled={disabled}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              handleSubmit();
            }
          }}
        />
        <InputGroupAddon align="block-end">
          {modelSlot}
          {isBusy ? (
            <InputGroupButton
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Stop generating"
              className="ml-auto"
              onClick={onStop}
            >
              <SquareIcon />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              aria-label="Send message"
              className="ml-auto"
              disabled={!input.trim() || disabled}
            >
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {disabled && disabledReason ? (
        <p
          id={disabledReasonId}
          className="mt-1.5 text-xs text-muted-foreground"
        >
          {disabledReason}
        </p>
      ) : null}
    </form>
  );
}
