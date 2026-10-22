import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "cn";
import { SearchIcon, CheckIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { InputGroup, InputGroupAddon } from "./input-group";

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-xl",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn("top-1/3 translate-y-0 overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="border-b pb-0">
      <InputGroup className="h-8 border-none border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full font-mono text-xs tabular-nums outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 opacity-50" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 scroll-py-0 overflow-x-hidden overflow-y-auto outline-none",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-xs", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        // The group heading speaks the system's section voice ON the
        // system's own `label-section` utility — it used to respell that
        // voice "by value" as four separate variants, and the respelling
        // was the bug: `text-micro` and `text-ink-faint` landed in one
        // merged string, the merger filed both as text COLOUR, and the
        // size was dropped. Every palette heading rendered at the
        // browser's 16px. The real utility cannot be stripped (it is not
        // a `text-*` class) and carries the size, the tracking, the caps
        // and the weight in one token.
        "text-ink overflow-hidden **:[[cmdk-group-heading]]:flex **:[[cmdk-group-heading]]:h-(--header-h) **:[[cmdk-group-heading]]:items-center **:[[cmdk-group-heading]]:px-(--pad-row) **:[[cmdk-group-heading]]:label-section **:[[cmdk-group-heading]]:text-ink-faint",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-rule", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // The highlighted command is a SELECTED ENTITY, so it wears the
        // system's selection treatment: the row wash plus the signal edge on
        // the inline start, at the cockpit's row height. It used to paint a
        // full-width `--accent` fill with its own inset signal ring — the
        // loudest single element in the palette, and a third dialect of a
        // state the product already had two spellings for.
        // `ink`, not `text-ink`: beside `text-ui` the colour utility ate
        // the size and every command in the palette rendered at 16px —
        // a third over the 12px DESIGN.md gives a menu item. See the ink
        // utilities in cockpit.css.
        "group/command-item relative flex min-h-(--row-h) cursor-default items-center gap-(--gap) border-l-2 border-l-transparent rounded-sm px-(--pad-row) text-ui ink outline-hidden select-none in-data-[slot=dialog-content]:rounded-sm! data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:border-l-select-edge data-selected:bg-select-wash data-selected:text-select-ink [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        // The shortcut cap is the `KeyCap` treatment by value: the deepest
        // well, a hairline, faint tabular mono at `--control-h-sm`.
        // `ink-faint`, not `text-ink-faint` — see KeyCap and the ink
        // utilities in cockpit.css; the colour spelling ate `text-micro`
        // and the caps rendered as tall as the labels beside them.
        "ml-auto inline-flex h-(--control-h-sm) min-w-(--control-h-sm) items-center justify-center rounded-[2px] border border-rule bg-well-deep px-1 font-mono text-micro ink-faint tabular leading-none",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
