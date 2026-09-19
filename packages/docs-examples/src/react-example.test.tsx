// @vitest-environment jsdom
/**
 * The docs-examples proof suite, part 3: the React integration guide's
 * example (docs/guides/react.md) rendered in jsdom — the store mounts,
 * the hook reads the parameter, the button's edit lands as a real
 * `parameter.set` transaction, and the component re-renders with the new
 * value.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
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

  it("keeps the same store across parent re-renders (edits are not reset)", () => {
    /** A host that re-renders without remounting the example. */
    function Host() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <GuideReactExample />
          <button type="button" onClick={() => setTick(tick + 1)}>
            rerender host
          </button>
          <output data-testid="host-tick">{String(tick)}</output>
        </div>
      );
    }

    render(<Host />);
    const widen = screen.getByRole("button", { name: "Widen the hole" });
    fireEvent.click(widen);
    expect(screen.getByTestId("guide-hole-value").textContent).toBe("12");
    fireEvent.click(widen);
    expect(screen.getByTestId("guide-hole-value").textContent).toBe("14");
    expect(screen.getByTestId("guide-edits").textContent).toBe("2");

    // Force a parent re-render: the example stays mounted (same element at
    // the same position), so its store must survive the re-render. A store
    // rebuilt in the render body would reset the document — the displayed
    // value would snap back to 10 while the panel's edit counter stays 2.
    fireEvent.click(screen.getByRole("button", { name: "rerender host" }));
    expect(screen.getByTestId("host-tick").textContent).toBe("1");
    expect(screen.getByTestId("guide-hole-value").textContent).toBe("14");
    expect(screen.getByTestId("guide-edits").textContent).toBe("2");

    // The next edit continues from the preserved document value and the
    // preserved edit count (10 + 3*2 = 16).
    fireEvent.click(widen);
    expect(screen.getByTestId("guide-hole-value").textContent).toBe("16");
    expect(screen.getByTestId("guide-edits").textContent).toBe("3");
  });
});
