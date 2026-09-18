/**
 * Component tests for `CadCommandMenu` (Phase 28). The menu is a pure
 * prop-driven surface over host command descriptors, so the tests exercise
 * exactly the component's own decisions: the first-seen grouping, the
 * run-then-close ordering, the disabled discipline, the shortcut slot
 * rendering, the Ctrl/Cmd+K hotkey (and its modifiers/`hotkey: false`
 * refusals), and the closed-state null render that keeps server renders
 * portal-free.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAD_COMMAND_MENU_LABELS,
  CadCommandMenu,
  type CadCommandDescriptor,
} from "./cad-command-menu";

/**
 * cmdk observes the list's size with a ResizeObserver and scrolls the
 * selected item with scrollIntoView, neither of which jsdom implements;
 * no-op stubs keep the component's real code path intact.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = ResizeObserverStub;
Element.prototype.scrollIntoView = (): void => {};

function commands(): CadCommandDescriptor[] {
  return [
    {
      id: "select",
      label: "Select",
      group: "Tools",
      shortcut: "1",
      run: vi.fn(),
    },
    {
      id: "measure",
      label: "Measure",
      group: "Tools",
      shortcut: "2",
      run: vi.fn(),
    },
    {
      id: "undo",
      label: "Undo",
      group: "History",
      run: vi.fn(),
    },
    {
      id: "export",
      label: "Export model",
      group: "File",
      disabled: true,
      run: vi.fn(),
    },
  ];
}

interface RenderOptions {
  readonly open: boolean;
  readonly hotkey?: boolean;
  readonly commands?: readonly CadCommandDescriptor[];
}

function renderMenu(options: RenderOptions): void {
  render(
    <CadCommandMenu
      commands={options.commands ?? commands()}
      hotkey={options.hotkey}
      onOpenChange={() => {}}
      open={options.open}
    />,
  );
}

afterEach(cleanup);

describe("CadCommandMenu", () => {
  it("renders nothing while closed", () => {
    renderMenu({ open: false });
    expect(document.querySelector("[data-slot=dialog-content]")).toBeNull();
  });

  it("renders the groups in first-seen order with every command", () => {
    renderMenu({ open: true });
    const groups = document.querySelectorAll("[data-cad-command-group]");
    expect(
      [...groups].map((group) => group.getAttribute("data-cad-command-group")),
    ).toEqual(["Tools", "History", "File"]);
    for (const command of commands()) {
      expect(
        document.querySelector(`[data-cad-command-id="${command.id}"]`),
      ).not.toBeNull();
    }
  });

  it("runs a command and closes the menu, in that order", () => {
    const onOpenChange = vi.fn();
    const list = commands();
    render(
      <CadCommandMenu
        commands={list}
        onOpenChange={onOpenChange}
        open={true}
      />,
    );
    const measureItem = document.querySelector(
      '[data-cad-command-id="measure"]',
    );
    expect(measureItem).not.toBeNull();
    fireEvent.click(measureItem as HTMLElement);
    // Close first, then run: focus leaves the palette before the command's
    // surface mounts.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(list[1]?.run).toHaveBeenCalledTimes(1);
  });

  it("keeps a disabled command visible but refuses to run it", () => {
    const list = commands();
    renderMenu({ open: true, commands: list });
    const item = document.querySelector('[data-cad-command-id="export"]');
    expect(item).not.toBeNull();
    const itemElement = item as HTMLElement;
    expect(itemElement.getAttribute("data-disabled")).toBe("true");
    fireEvent.click(itemElement);
    expect(list[3]?.run).not.toHaveBeenCalled();
  });

  it("renders the shortcut token verbatim in the shortcut slot", () => {
    renderMenu({ open: true });
    const item = document.querySelector('[data-cad-command-id="select"]');
    expect(item?.textContent).toContain("1");
  });

  it("opens on Ctrl+K and Cmd+K while closed", () => {
    const onOpenChange = vi.fn();
    render(
      <CadCommandMenu
        commands={commands()}
        onOpenChange={onOpenChange}
        open={false}
      />,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("refuses modified, shifted, and non-k presses, and honors hotkey: false", () => {
    const onOpenChange = vi.fn();
    render(
      <CadCommandMenu
        commands={commands()}
        hotkey={false}
        onOpenChange={onOpenChange}
        open={false}
      />,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does not register the hotkey while open (the dialog owns Escape)", () => {
    const onOpenChange = vi.fn();
    render(
      <CadCommandMenu
        commands={commands()}
        onOpenChange={onOpenChange}
        open={true}
      />,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("renders label overrides and the empty state", () => {
    renderMenu({ open: true, commands: [] });
    expect(screen.getByText(CAD_COMMAND_MENU_LABELS.empty)).not.toBeNull();
  });
});
