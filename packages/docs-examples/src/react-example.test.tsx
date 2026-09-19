// @vitest-environment jsdom
/**
 * The docs-examples proof suite, part 3: the React integration guide's
 * example (docs/guides/react.md) rendered in jsdom — the store mounts,
 * the hook reads the parameter, the button's edit lands as a real
 * `parameter.set` transaction, and the component re-renders with the new
 * value.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GuideReactExample } from "./react/store";

afterEach(cleanup);

describe("guide example: React integration", () => {
  it("reads the parameter through the hook and edits it through setValue", () => {
    render(<GuideReactExample />);
    const value = screen.getByTestId("guide-hole-value");
    expect(value.textContent).toBe("10");
    const edits = screen.getByTestId("guide-edits");
    expect(edits.textContent).toBe("0");

    const button = screen.getByRole("button", { name: "Widen the hole" });
    fireEvent.click(button);
    expect(screen.getByTestId("guide-hole-value").textContent).toBe("12");
    expect(screen.getByTestId("guide-edits").textContent).toBe("1");
    expect(screen.getByTestId("guide-document-parameters").textContent).toBe(
      "1",
    );

    fireEvent.click(button);
    expect(screen.getByTestId("guide-hole-value").textContent).toBe("14");
    expect(screen.getByTestId("guide-edits").textContent).toBe("2");
  });
});
