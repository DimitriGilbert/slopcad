// @vitest-environment node
// Pure URL sanitation over the WHATWG parser; jsdom adds nothing.

import { describe, expect, it } from "vitest";

import { safeHttpUrl } from "./safe-http-url";

describe("safeHttpUrl", () => {
  it("passes http and https URLs through unchanged", () => {
    expect(safeHttpUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeHttpUrl("https://example.com/a?b=c")).toBe(
      "https://example.com/a?b=c",
    );
  });

  it("refuses non-http protocols so model output cannot inject script URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl("data:text/html,<h1>hi</h1>")).toBeUndefined();
    expect(safeHttpUrl("file:///etc/passwd")).toBeUndefined();
  });

  it("refuses unparseable input", () => {
    expect(safeHttpUrl("")).toBeUndefined();
    expect(safeHttpUrl("not a url")).toBeUndefined();
  });
});
