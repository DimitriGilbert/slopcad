import { useEffect } from "react";
import { cn } from "cn";

import {
  Command,
  CommandDialog,
  CommandEmpty,
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
}: CadCommandMenuProps) {
  const labels: CadCommandMenuLabels = {
    ...CAD_COMMAND_MENU_LABELS,
    ...labelOverrides,
  };

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

  if (!open) return null;

  // Group tokens in first-seen order — the host's array is the IA.
  const groups: {
    readonly token: string;
    readonly commands: CadCommandDescriptor[];
  }[] = [];
  for (const command of commands) {
    const existing = groups.find((group) => group.token === command.group);
    if (existing === undefined) {
      groups.push({ token: command.group, commands: [command] });
    } else {
      existing.commands.push(command);
    }
  }

  return (
    <CommandDialog
      className={cn("sm:max-w-md", className)}
      description={labels.description}
      onOpenChange={onOpenChange}
      open={open}
      title={labels.title}
    >
      <Command>
        <CommandInput placeholder={labels.placeholder} />
        <CommandList data-cad-command-list="">
          <CommandEmpty>{labels.empty}</CommandEmpty>
          {groups.map((group) => (
            <CommandGroup
              data-cad-command-group={group.token}
              heading={group.token}
              key={group.token}
            >
              {group.commands.map((command) => (
                <CommandItem
                  data-cad-command-id={command.id}
                  data-disabled={command.disabled === true || undefined}
                  disabled={command.disabled === true}
                  key={command.id}
                  keywords={
                    command.keywords === undefined
                      ? undefined
                      : [command.keywords]
                  }
                  onSelect={() => {
                    onOpenChange(false);
                    command.run();
                  }}
                  value={
                    command.keywords === undefined
                      ? command.label
                      : `${command.label} ${command.keywords}`
                  }
                >
                  <span>{command.label}</span>
                  {command.shortcut !== undefined ? (
                    <CommandShortcut>{command.shortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
