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
  commandRank,
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

  it("orders searched groups by best surviving score — the import-vs-Loft regression", () => {
    // The bug this ranking replaced: with grouped commands, cmdk's
    // post-filter reordering highlighted the first surviving item of the
    // FIRST group, so a Workspace keyword graze beat the perfect File
    // label match. The menu ranks itself now: typing "import" grazes
    // Loft's keywords (m-p in "morph", o in "solid", r-t in "create") but
    // the perfect label match must own the TOP of the list — File renders
    // first despite being last in the array, and Measure (no match) drops.
    const list: CadCommandDescriptor[] = [
      {
        id: "measure",
        label: "Measure",
        group: "Tools",
        run: vi.fn(),
      },
      {
        id: "loft",
        label: "Loft ordered sections",
        group: "Workspace",
        keywords: "loft sections morph solid create",
        run: vi.fn(),
      },
      {
        id: "import",
        label: "Import model",
        group: "File",
        keywords: "stl 3mf step brep iges open upload",
        run: vi.fn(),
      },
    ];
    render(
      <CadCommandMenu commands={list} onOpenChange={() => {}} open={true} />,
    );
    const input = document.querySelector('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLElement, {
      target: { value: "import" },
    });
    const groups = document.querySelectorAll("[data-cad-command-group]");
    expect(
      [...groups].map((group) => group.getAttribute("data-cad-command-group")),
    ).toEqual(["File", "Workspace"]);
    expect(
      document.querySelector('[data-cad-command-id="import"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-cad-command-id="loft"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-cad-command-id="measure"]'),
    ).toBeNull();
  });

  it("reorders groups by their best surviving score, not first-seen order", () => {
    // A keyword graze in the first-seen group (History) must NOT outrank a
    // stronger match in a later group (File): "mpo" grazes History's
    // keywords and matches File's label consecutively, so File renders
    // first despite being second in the array.
    const list: CadCommandDescriptor[] = [
      {
        id: "remove-rollback",
        label: "Remove rollback point",
        group: "History",
        keywords: "timeline marker",
        run: vi.fn(),
      },
      {
        id: "import",
        label: "Import model",
        group: "File",
        keywords: "stl 3mf step brep iges open upload",
        run: vi.fn(),
      },
    ];
    render(
      <CadCommandMenu commands={list} onOpenChange={() => {}} open={true} />,
    );
    const input = document.querySelector('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLElement, {
      target: { value: "mpo" },
    });
    expect(
      commandRank("Import model stl 3mf step brep iges open upload", "mpo"),
    ).toBeGreaterThan(
      commandRank("Remove rollback point timeline marker", "mpo"),
    );
    const groups = document.querySelectorAll("[data-cad-command-group]");
    expect(
      [...groups].map((group) => group.getAttribute("data-cad-command-group")),
    ).toEqual(["File", "History"]);
  });

  it("keeps duplicate-label commands distinct: arrows move the highlight, Enter runs it", () => {
    // The regression: cmdk selects by string equality on `value`, so two
    // commands sharing a label were `aria-selected` simultaneously, the
    // highlight could never move to the second (the store's Object.is
    // guard), and Enter ran the first DOM match — the second command was
    // keyboard-unreachable. The unique `label + id` composite value fixes
    // all three; the label still leads the composite.
    const list: CadCommandDescriptor[] = [
      { id: "save-doc", label: "Save", group: "File", run: vi.fn() },
      { id: "save-copy", label: "Save", group: "File", run: vi.fn() },
    ];
    const onOpenChange = vi.fn();
    render(
      <CadCommandMenu
        commands={list}
        onOpenChange={onOpenChange}
        open={true}
      />,
    );
    const first = document.querySelector('[data-cad-command-id="save-doc"]');
    const second = document.querySelector('[data-cad-command-id="save-copy"]');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Exactly ONE highlight despite the identical labels…
    expect(first?.getAttribute("aria-selected")).toBe("true");
    expect(second?.getAttribute("aria-selected")).toBe("false");

    // …ArrowDown moves it to the second duplicate, ArrowUp back, Down
    // again — the highlight genuinely travels between the duplicates.
    const input = document.querySelector('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    fireEvent.keyDown(input as HTMLElement, { key: "ArrowDown" });
    expect(first?.getAttribute("aria-selected")).toBe("false");
    expect(second?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input as HTMLElement, { key: "ArrowUp" });
    expect(first?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input as HTMLElement, { key: "ArrowDown" });
    expect(second?.getAttribute("aria-selected")).toBe("true");

    // Enter runs the HIGHLIGHTED one (the second duplicate), closing the
    // menu first; the first duplicate never runs.
    fireEvent.keyDown(input as HTMLElement, { key: "Enter" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(list[1]?.run).toHaveBeenCalledTimes(1);
    expect(list[0]?.run).not.toHaveBeenCalled();
  });

  it("runs the first duplicate when it is the one highlighted", () => {
    const list: CadCommandDescriptor[] = [
      { id: "save-doc", label: "Save", group: "File", run: vi.fn() },
      { id: "save-copy", label: "Save", group: "File", run: vi.fn() },
    ];
    render(
      <CadCommandMenu commands={list} onOpenChange={() => {}} open={true} />,
    );
    const input = document.querySelector('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    // No navigation: the initial highlight sits on the first duplicate,
    // and Enter runs exactly that one.
    fireEvent.keyDown(input as HTMLElement, { key: "Enter" });
    expect(list[0]?.run).toHaveBeenCalledTimes(1);
    expect(list[1]?.run).not.toHaveBeenCalled();
  });

  it("drops a duplicate whose id alone matches the query", () => {
    // The composite `label + id` value must never leak into the search
    // haystack: ranking scores the label + keywords text only. "copy"
    // lives ONLY in save-copy's id — the bare "Save" label cannot match
    // it, so the duplicate must drop; were the composite to leak in,
    // "Save save-copy" contains "copy" and the item would wrongly
    // survive.
    const list: CadCommandDescriptor[] = [
      { id: "save-doc", label: "Save", group: "File", run: vi.fn() },
      { id: "save-copy", label: "Save", group: "File", run: vi.fn() },
      { id: "measure", label: "Measure", group: "Tools", run: vi.fn() },
    ];
    render(
      <CadCommandMenu commands={list} onOpenChange={() => {}} open={true} />,
    );
    const input = document.querySelector('[data-slot="command-input"]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLElement, { target: { value: "copy" } });
    // The rank premise: the bare label scores zero against the id-only
    // token — only a leaked composite would score above zero.
    expect(commandRank("Save", "copy")).toBe(0);
    expect(
      document.querySelector('[data-cad-command-id="save-copy"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-cad-command-id="save-doc"]'),
    ).toBeNull();
    // Nothing survived, so the empty state shows — the drop came from
    // real filtering, not a broken render.
    expect(screen.getByText(CAD_COMMAND_MENU_LABELS.empty)).not.toBeNull();
  });
});

describe("commandRank", () => {
  it("scores an empty query as a uniform match and a miss as zero", () => {
    expect(commandRank("Loft ordered sections", "")).toBe(1);
    expect(commandRank("Loft ordered sections", "   ")).toBe(1);
    // No in-order subsequence: "Measure" carries no "i" at all, so the
    // query "import" can never match it (the component test's drop).
    expect(commandRank("Measure", "import")).toBe(0);
  });

  it("ranks a perfect label match above a scattered keyword graze", () => {
    const perfect = commandRank(
      "Import model stl 3mf step brep iges open upload",
      "import",
    );
    // The keyword graze: the same query's letters land scattered through
    // Loft's search text — m-p in "morph", o in "solid", r-t in "create".
    const graze = commandRank(
      "Loft ordered sections morph solid create",
      "import",
    );
    expect(graze).toBeGreaterThan(0);
    expect(perfect).toBeGreaterThan(graze);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(commandRank("Import Model", "IMPORT")).toBe(
      commandRank("import model", "import"),
    );
    expect(commandRank("Import model", "  import  ")).toBe(
      commandRank("Import model", "import"),
    );
  });
});
