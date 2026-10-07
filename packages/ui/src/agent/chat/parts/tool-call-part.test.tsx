/**
 * The tool-call renderer's crash-safety test (R5F1): a wire payload deep
 * enough that `JSON.stringify` throws while `JSON.parse` still accepted it
 * (~5000 nesting levels — ~10 KB of `[`, trivially inside a streamed
 * `arguments` string) must render the stable placeholder, not unmount the
 * chat. Pins the render path (`RawJsonDisclosure` stringifies eagerly, even
 * while the disclosure is collapsed) together with {@link stableJson}'s
 * totality.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentChatToolCallPart } from "./part-types";

import { AgentToolCallPart } from "./tool-call-part";

/**
 * The verified asymmetry band: stringify throws a RangeError from ~4500
 * nesting levels while parse accepts past 8000 — 5000 sits safely inside
 * (parse-ok, stringify-throws) on the engine this suite runs on.
 */
const WIRE_DEPTH = 5000;

/** Builds a `[0]`-nested array iteratively (no recursion, no stringify). */
function deepValue(depth: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}

/** The arguments text for the same depth, built by concatenation. */
function deepArguments(depth: number): string {
  return `${"[".repeat(depth)}0${"]".repeat(depth)}`;
}

afterEach(cleanup);

describe("AgentToolCallPart", () => {
  it("renders a wire-deep input as the placeholder instead of crashing", () => {
    const part: AgentChatToolCallPart = {
      type: "tool-call",
      id: "call_deep",
      name: "echo",
      arguments: deepArguments(WIRE_DEPTH),
      input: deepValue(WIRE_DEPTH),
      state: "input-complete",
    };

    render(<AgentToolCallPart part={part} />);

    expect(screen.getByTestId("agent-tool-call-part")).not.toBeNull();
    expect(screen.getByText("[unrenderable JSON]")).not.toBeNull();
  });
});
