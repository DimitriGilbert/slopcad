/**
 * `ToolFlyout` contract tests: the face runs its member directly (it is a
 * control, not a menu trigger), the chevron is the only menu trigger, the
 * family re-faces to the last member chosen, every member stays listed —
 * disabled members included — and the testid belongs to the face alone.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Circle, Drill, Scissors } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolFlyout, type ToolFlyoutItem } from "./tool-flyout";

afterEach(cleanup);

function items(
  overrides: Partial<Record<string, Partial<ToolFlyoutItem>>> = {},
): readonly ToolFlyoutItem[] {
  const base: readonly ToolFlyoutItem[] = [
    {
      id: "hole",
      label: "Hole",
      description: "Cut a hole",
      icon: Circle,
      shortcut: "H",
      testId: "complete-hole",
      onSelect: () => {},
    },
    {
      id: "holeSpec",
      label: "Hole spec…",
      description: "Open the hole dialog",
      icon: Drill,
      testId: "complete-hole-spec",
      onSelect: () => {},
    },
    {
      id: "split",
      label: "Split",
      description: "Extrude a profile first; a split needs a solid.",
      icon: Scissors,
      disabled: true,
      testId: "complete-split",
      onSelect: () => {},
    },
  ];
  return base.map((item) => ({ ...item, ...overrides[item.id] }));
}

function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "Modify family" }));
}

describe("ToolFlyout", () => {
  it("faces the first member and runs it on a direct press", () => {
    const onSelect = vi.fn();
    render(<ToolFlyout items={items({ hole: { onSelect } })} label="Modify" />);
    const face = screen.getByRole("button", { name: "Hole" });
    expect(face.getAttribute("data-testid")).toBe("complete-hole");
    expect(face.getAttribute("aria-keyshortcuts")).toBe("H");
    expect(face.getAttribute("title")).toBe("Cut a hole");
    fireEvent.click(face);
    // The face is a CONTROL: pressing it runs the member, it does not open
    // the family.
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("honours defaultFacedId so a family can face its harness-read member", () => {
    render(
      <ToolFlyout defaultFacedId="holeSpec" items={items()} label="Modify" />,
    );
    expect(
      screen
        .getByRole("button", { name: "Hole spec…" })
        .getAttribute("data-testid"),
    ).toBe("complete-hole-spec");
  });

  it("opens the whole family from the chevron, disabled members included", () => {
    render(<ToolFlyout items={items()} label="Modify" />);
    const chevron = screen.getByRole("button", { name: "Modify family" });
    expect(chevron.getAttribute("aria-haspopup")).toBe("menu");
    openMenu();
    const menu = screen.getByRole("menu", { name: "Modify" });
    const members = [
      ...menu.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
    ];
    // Nothing is dropped for being unavailable: the refusal is a disabled
    // row with the reason in its title, not an absent control.
    expect(members.map((member) => member.dataset["toolId"])).toEqual([
      "hole",
      "holeSpec",
      "split",
    ]);
    const split = members[2];
    expect(split?.disabled).toBe(true);
    expect(split?.getAttribute("title")).toContain("a split needs a solid");
  });

  it("keeps the testid on the face alone", () => {
    render(<ToolFlyout items={items()} label="Modify" />);
    openMenu();
    // One element per testid — the menu's handle is data-tool-id.
    expect(
      document.querySelectorAll("[data-testid='complete-hole']"),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll("[data-testid='complete-hole-spec']"),
    ).toHaveLength(0);
  });

  it("re-faces to the member chosen and runs it, closing the menu", () => {
    const onSelect = vi.fn();
    const onFacedIdChange = vi.fn<(itemId: string) => void>();
    render(
      <ToolFlyout
        items={items({ holeSpec: { onSelect } })}
        label="Modify"
        onFacedIdChange={onFacedIdChange}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Hole spec/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onFacedIdChange).toHaveBeenCalledWith("holeSpec");
    expect(screen.queryByRole("menu")).toBeNull();
    // The strip slot now shows the family's last-used member.
    expect(
      screen
        .getByRole("button", { name: "Hole spec…" })
        .getAttribute("data-testid"),
    ).toBe("complete-hole-spec");
  });

  it("lets facedId control the face outright", () => {
    render(<ToolFlyout facedId="holeSpec" items={items()} label="Modify" />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hole" }));
    // The controlled prop never moved, so neither did the face.
    expect(screen.getByRole("button", { name: "Hole spec…" })).not.toBeNull();
  });

  it("marks the faced member in the open family", () => {
    render(<ToolFlyout items={items()} label="Modify" />);
    openMenu();
    expect(
      screen.getByRole("menuitem", { name: "Hole" }).hasAttribute("data-faced"),
    ).toBe(true);
    expect(
      screen
        .getByRole("menuitem", { name: /Hole spec/ })
        .hasAttribute("data-faced"),
    ).toBe(false);
  });

  it("roves the open family with the arrow keys, skipping disabled rows", async () => {
    render(<ToolFlyout items={items()} label="Modify" />);
    openMenu();
    const menu = screen.getByRole("menu", { name: "Modify" });
    const hole = screen.getByRole("menuitem", { name: "Hole" });
    const holeSpec = screen.getByRole("menuitem", { name: /Hole spec/ });
    // Opening focuses the faced member, so the family is usable at once
    // (the popover moves focus into the popup first; the flyout then hands
    // it to the member the operator already has in muscle memory).
    await waitFor(() => {
      expect(document.activeElement).toBe(hole);
    });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(holeSpec);
    // Split is disabled, so the ring is two long and wraps back to Hole.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(hole);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(holeSpec);
  });

  it("presses the face only for the armed member", () => {
    const { rerender } = render(
      <ToolFlyout items={items()} label="Modify" pressedId={null} />,
    );
    expect(
      screen.getByRole("button", { name: "Hole" }).getAttribute("aria-pressed"),
    ).toBe("false");
    rerender(<ToolFlyout items={items()} label="Modify" pressedId="hole" />);
    expect(
      screen.getByRole("button", { name: "Hole" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("makes no claim about arming for a family of momentary verbs", () => {
    render(<ToolFlyout items={items()} label="Modify" />);
    expect(
      screen.getByRole("button", { name: "Hole" }).hasAttribute("aria-pressed"),
    ).toBe(false);
  });

  it("renders nothing for an empty family", () => {
    const { container } = render(<ToolFlyout items={[]} label="Modify" />);
    expect(container.firstChild).toBeNull();
  });
});
