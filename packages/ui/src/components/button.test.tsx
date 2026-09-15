import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "./button";

afterEach(cleanup);

describe("Button", () => {
  it("renders a native button that forwards text and props", () => {
    render(<Button type="submit">Extrude</Button>);
    const button = screen.getByRole("button", { name: "Extrude" });
    expect(button.getAttribute("type")).toBe("submit");
  });

  it("applies the destructive variant classes", () => {
    const { container } = render(<Button variant="destructive">Delete</Button>);
    const button = container.querySelector("button");
    expect(button?.classList.contains("text-destructive")).toBe(true);
  });

  it("disables natively", () => {
    render(<Button disabled>Cut</Button>);
    const button = screen.getByRole("button", { name: "Cut" });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });
});
