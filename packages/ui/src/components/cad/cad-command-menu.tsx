/**
 * `CadCommandMenu` (Phase 28): the shadcn-side CAD command menu — the
 * searchable palette of every command the host workbench exposes, built on
 * the existing `Command` primitives (cmdk) with NO CAD coupling: the menu
 * is a pure prop-driven surface over {@link CadCommandDescriptor} values.
 * The host owns what a command IS — arming a tool through the store's
 * `arm` op, undoing through the history hook, opening an import dialog —
 * so every dispatched command rides whatever public surface the host
 * wired, and the menu never reaches into a store itself.
 *
 * ## Open state and keyboard
 *
 * Open state is CONTROLLED (`open` + `onOpenChange`); the component owns
 * exactly one piece of behavior on top: the documented hotkey
 * (Ctrl/Cmd+K, disable with `hotkey: false`) opens the menu from a window
 * keydown listener registered only while the menu is closed — Escape and
 * the dialog's own focus discipline are the primitives' existing behavior.
 * Running a command closes the menu first, then calls `command.run()`, so
 * focus leaves the palette before the command's surface mounts. The
 * dialog content mounts ONLY while open, which keeps server renders free
 * of any portal work (the toolbar's documented SSR discipline).
 *
 * ## Grouping, ranking, and shortcuts
 *
 * Commands render grouped by their `group` token, in first-seen array
 * order — the host's array IS the menu's information architecture. The
 * optional `shortcut` string renders verbatim in the item's shortcut slot
 * (display only; the host wires its own key handlers for those shortcuts,
 * exactly as the toolbar owns its digit keys).
 *
 * ## Search ranking (the Phase 39 fix, disclosed)
 *
 * The menu ranks queries ITSELF and renders the ranked result
 * (`shouldFilter={false}` — cmdk's own filtering stays out of the way).
 * The reason is an upstream cmdk limitation this component hit for real:
 * cmdk's post-filter reordering moves items within their groups and
 * reorders GROUPS through an internal group-id lookup that never matches
 * the rendered group (`data-value` carries the heading, not the id), so
 * with grouped commands the palette's highlighted item was always the
 * first surviving item of the FIRST group — a keyword graze in Tools beat
 * a perfect label match in File. {@link commandRank} here is the
 * documented deterministic substitute: an in-order subsequence match over
 * `label + keywords` that rewards consecutive and leading matches; a
 * command with score 0 does not render, groups order by their best
 * surviving score, items order by score within their group. An empty
 * query renders every command in first-seen order (the unfiltered IA).
 *
 * Selection identity is separate from search text: cmdk highlights and
 * Enter-dispatches by STRING EQUALITY on the item's `value`, so two
 * commands sharing a label must not share a value — the label alone would
 * highlight both `aria-selected` at once, trap the arrow navigation
 * (cmdk's store guards on `Object.is`), and run the first DOM match on
 * Enter. Each item therefore carries a unique `label + id` composite
 * (the label leads it), while ranking keeps scoring the label + keywords
 * haystack — search behavior is untouched.
 *
 * All user-facing strings live in {@link CAD_COMMAND_MENU_LABELS}
 * (overridable via the `labels` prop); command labels and groups are host
 * data rendered verbatim.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { cn } from "cn";

import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../command";

/** The user-facing strings of {@link CadCommandMenu}. Overridable via props. */
export interface CadCommandMenuLabels {
  /** The dialog's accessible title. */
  readonly title: string;
  /** The dialog's accessible description. */
  readonly description: string;
  /** The input's placeholder. */
  readonly placeholder: string;
  /** Shown when no command matches the query. */
  readonly empty: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_COMMAND_MENU_LABELS: CadCommandMenuLabels = {
  title: "Command menu",
  description: "Search the workbench commands.",
  placeholder: "Type a command…",
  empty: "No matching command.",
};

/** One host-registered command: the menu's whole data model. */
export interface CadCommandDescriptor {
  /** Stable identity (React key; also the machine surface's entry id). */
  readonly id: string;
  /** The visible label and the search text. */
  readonly label: string;
  /** The group token the command renders under (first-seen order). */
  readonly group: string;
  /** Extra search terms beyond the label (never rendered). */
  readonly keywords?: string;
  /** The shortcut's display token, verbatim (display only). */
  readonly shortcut?: string;
  /** Disabled commands stay visible but cannot run. */
  readonly disabled?: boolean;
  /** The command's effect; the host owns every surface it touches. */
  readonly run: () => void;
}

/** Props of {@link CadCommandMenu}. */
export interface CadCommandMenuProps {
  /** The commands to render, grouped in first-seen order. */
  readonly commands: readonly CadCommandDescriptor[];
  /** Whether the menu is open (controlled). */
  readonly open: boolean;
  /** Receives every open-state transition the menu drives. */
  readonly onOpenChange: (open: boolean) => void;
  /** Whether Ctrl/Cmd+K opens the menu while closed; default `true`. */
  readonly hotkey?: boolean;
  /** Label token overrides, merged over {@link CAD_COMMAND_MENU_LABELS}. */
  readonly labels?: Partial<CadCommandMenuLabels>;
  /** Extends the dialog content classes. */
  readonly className?: string;
}

/** The mod-digits key that opens the menu while closed. */
const HOTKEY_KEY = "k";

/**
 * The menu's deterministic search rank of one command for one query: an
 * in-order, case-insensitive subsequence match over the command's search
 * text (label + keywords) that rewards consecutive hits and a leading
 * hit. 0 means "no match — do not render"; higher is better, with an
 * exact prefix of the label ranking above scattered keyword grazes.
 */
export function commandRank(haystack: string, search: string): number {
  const text = haystack.toLowerCase();
  const query = search.trim().toLowerCase();
  if (query === "") return 1;
  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const character of query) {
    const found = text.indexOf(character, cursor);
    if (found < 0) return 0;
    streak = found === cursor ? streak + 1 : 1;
    score += 1 + streak * 0.5 + (found === 0 ? 0.5 : 0);
    cursor = found + 1;
  }
  return score;
}

/** A ranked group: the token plus its surviving commands, best first. */
interface RankedGroup {
  readonly token: string;
  readonly commands: readonly {
    readonly command: CadCommandDescriptor;
    readonly score: number;
  }[];
}

/** The command's search text: label plus keywords, one haystack. */
function searchTextOf(command: CadCommandDescriptor): string {
  return command.keywords === undefined
    ? command.label
    : `${command.label} ${command.keywords}`;
}

/**
 * The CAD command menu: the host's commands as one searchable, grouped,
 * keyboard-first palette, in one mountable component.
 */
export function CadCommandMenu({
  className,
  commands,
  hotkey = true,
  labels: labelOverrides,
  onOpenChange,
  open,
}: CadCommandMenuProps): ReactElement | null {
  const labels: CadCommandMenuLabels = {
    ...CAD_COMMAND_MENU_LABELS,
    ...labelOverrides,
  };
  // The live query, mirrored from the input (the menu ranks itself; cmdk's
  // filtering stays disabled).
  const [search, setSearch] = useState("");

  // The hotkey lives in an effect so server renders never touch `window`
  // and the listener exists only while the menu cannot handle it itself.
  useEffect(() => {
    if (!hotkey || open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== HOTKEY_KEY) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      onOpenChange(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [hotkey, onOpenChange, open]);

  // A closed menu renders nothing (the SSR discipline) and drops its query,
  // so reopening starts from the unfiltered IA.
  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const rankedGroups: readonly RankedGroup[] = useMemo(() => {
    // Group tokens in first-seen order — the host's array is the IA.
    const groups: { token: string; commands: CadCommandDescriptor[] }[] = [];
    for (const command of commands) {
      const existing = groups.find((group) => group.token === command.group);
      if (existing === undefined) {
        groups.push({ token: command.group, commands: [command] });
      } else {
        existing.commands.push(command);
      }
    }
    if (search.trim() === "") {
      return groups.map((group) => ({
        token: group.token,
        commands: group.commands.map((command) => ({ command, score: 1 })),
      }));
    }
    const ranked = groups.map((group) => ({
      token: group.token,
      commands: group.commands
        .map((command) => ({
          command,
          score: commandRank(searchTextOf(command), search),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            commands.indexOf(a.command) - commands.indexOf(b.command),
        ),
    }));
    // Groups order by their best surviving score (ties keep first-seen
    // order); empty groups drop out.
    return ranked
      .filter((group) => group.commands.length > 0)
      .map((group) => ({
        token: group.token,
        commands: group.commands,
        best: Math.max(...group.commands.map((entry) => entry.score)),
      }))
      .sort((a, b) => b.best - a.best)
      .map(({ token, commands: rankedCommands }) => ({
        token,
        commands: rankedCommands,
      }));
  }, [commands, search]);

  const resultCount = rankedGroups.reduce(
    (count, group) => count + group.commands.length,
    0,
  );

  return (
    <CommandDialog
      className={cn("sm:max-w-md", className)}
      description={labels.description}
      onOpenChange={onOpenChange}
      open={open}
      title={labels.title}
    >
      <Command shouldFilter={false}>
        <CommandInput
          onValueChange={(value) => {
            setSearch(value);
          }}
          placeholder={labels.placeholder}
        />
        <CommandList data-cad-command-list="">
          {resultCount === 0 ? (
            <div
              className="text-muted-foreground py-6 text-center text-sm"
              data-cad-command-empty=""
            >
              {labels.empty}
            </div>
          ) : (
            rankedGroups.map((group) => (
              <CommandGroup
                data-cad-command-group={group.token}
                heading={group.token}
                key={group.token}
              >
                {group.commands.map(({ command }) => (
                  <CommandItem
                    data-cad-command-id={command.id}
                    data-disabled={command.disabled === true || undefined}
                    disabled={command.disabled === true}
                    key={command.id}
                    onSelect={() => {
                      onOpenChange(false);
                      command.run();
                    }}
                    // Unique selection identity: the label leads the
                    // composite (so the value still reads as the command),
                    // the id breaks label ties — see the module doc.
                    value={`${command.label} ${command.id}`}
                  >
                    <span>{command.label}</span>
                    {command.shortcut !== undefined ? (
                      <CommandShortcut>{command.shortcut}</CommandShortcut>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
