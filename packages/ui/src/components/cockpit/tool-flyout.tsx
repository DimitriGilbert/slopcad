/**
 * `ToolFlyout` — a tool FAMILY as one strip control.
 *
 * This is the mechanism that kills the wide word-row. A family (Modify,
 * Pattern, Create…) used to spend one labelled button per member, which
 * is how the command row grew to nineteen text verbs and then to three
 * tiers of `max-*:hidden`. A flyout spends ONE strip slot per family at
 * every width: the face shows the family's last-used member, the chevron
 * opens the whole family, and nothing is ever hidden because the viewport
 * got narrow.
 *
 * ## Anatomy
 *
 * - **The face** — an icon `ToolButton` carrying the faced member's
 *   `aria-label`, `title`, `aria-keyshortcuts`, `data-tool-id` and its
 *   `data-testid`. Pressing it RUNS that member; it is a real control,
 *   not a menu trigger. A corner tick marks it as the face of a family
 *   rather than a lone verb.
 * - **The chevron** — a narrow sibling with `aria-haspopup="menu"` and
 *   `aria-expanded`, named for the family. It opens the popover, and it
 *   is the only part of the pair that is a menu trigger.
 * - **The popover** — a `role="menu"` list of the family's members: icon,
 *   label, and the member's key cap. Choosing one re-faces the family and
 *   runs it. A disabled member stays listed, disabled, with the title
 *   that says WHY — a family never lies about what it can do.
 *
 * ## Machine handles
 *
 * `data-testid` belongs to the FACE only — two elements answering to one
 * testid is a lie automation cannot resolve. Inside the menu the handle
 * is `data-tool-id` on each `role="menuitem"`, plus `data-faced` on the
 * one the face currently shows; the pair `[role="menuitem"][data-tool-id]`
 * addresses every member of every family uniformly.
 *
 * ## Facing
 *
 * `facedId` controls the face; omit it and the flyout remembers the last
 * member chosen through the menu, starting at `defaultFacedId` (or the
 * first member). The remembered face is UI memory, not document state —
 * it never drives what the face is allowed to run, so a face whose member
 * became unavailable simply renders disabled with its own reason.
 *
 * ## Keyboard
 *
 * Arrow keys rove the open menu, Home/End jump to its ends, Escape closes
 * it (the popover's own behaviour) and returns focus to the chevron. The
 * face and chevron themselves are ordinary tab stops — see `ToolStrip`
 * for why the strip does not collapse its tab order.
 */

import { cn } from "cn";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { KeyCap, ToolButton } from "./tool-button";

/** One member of a tool family. */
export interface ToolFlyoutItem {
  /** The member's stable id (the tool or command id, never prose). */
  readonly id: string;
  /** The accessible name — what the member IS. */
  readonly label: string;
  /** The `title` — what running it does, or why it cannot run. */
  readonly description: string;
  /** The member's icon; the face renders it at strip size. */
  readonly icon: LucideIcon;
  /** The member's `aria-keyshortcuts` value and key cap, when it has one. */
  readonly shortcut?: string;
  /** Whether the member can run right now. */
  readonly disabled?: boolean;
  /** The member's `data-testid`, preserved across its move into the family. */
  readonly testId?: string;
  /** Runs the member. */
  readonly onSelect: () => void;
}

/** Props of {@link ToolFlyout}. */
export interface ToolFlyoutProps {
  /** The family's name — the chevron's accessible name and the menu's. */
  readonly label: string;
  /** The family's members, in menu order. */
  readonly items: readonly ToolFlyoutItem[];
  /** Controls the faced member; omit for the remembered last-used face. */
  readonly facedId?: string;
  /** The initial face when uncontrolled (default: the first member). */
  readonly defaultFacedId?: string;
  /** Reports a face change (menu choice), controlled or not. */
  readonly onFacedIdChange?: (itemId: string) => void;
  /** The member that is currently ARMED, if any — pressed on the face. */
  readonly pressedId?: string | null;
  /** The chevron's `data-testid`. */
  readonly triggerTestId?: string;
  /** Extends the pair's container classes. */
  readonly className?: string;
}

/** The menu keys the flyout claims. */
const MENU_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

/** The menu item one key press moves focus to, wrapping at the ends. */
function menuTarget(
  key: string,
  items: readonly HTMLButtonElement[],
  current: number,
): HTMLButtonElement | undefined {
  if (key === "Home") return items[0];
  if (key === "End") return items[items.length - 1];
  if (current === -1) return items[0];
  const step = key === "ArrowDown" ? 1 : -1;
  return items[(current + step + items.length) % items.length];
}

/** The family's face: the controlled id, the remembered one, or the first. */
function faceOf(
  items: readonly ToolFlyoutItem[],
  facedId: string | undefined,
  rememberedId: string | null,
): ToolFlyoutItem | undefined {
  const wanted = facedId ?? rememberedId;
  if (wanted === null || wanted === undefined) return items[0];
  return items.find((item) => item.id === wanted) ?? items[0];
}

/** A tool family rendered as one strip control plus its menu. */
export function ToolFlyout({
  className,
  defaultFacedId,
  facedId,
  items,
  label,
  onFacedIdChange,
  pressedId,
  triggerTestId,
}: ToolFlyoutProps) {
  const [rememberedId, setRememberedId] = useState<string | null>(
    defaultFacedId ?? null,
  );
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const face = faceOf(items, facedId, rememberedId);

  // Opening a family puts focus on its faced member, so the menu is
  // keyboard-usable the instant it appears (the popover itself only moves
  // focus into the popup, which would leave the operator one extra key
  // from the member they already have in muscle memory).
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (menu === null) return;
    const buttons = [
      ...menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    ];
    const faced = buttons.find(
      (button) => button.dataset["toolId"] === face?.id,
    );
    (faced ?? buttons[0])?.focus();
  }, [open, face?.id]);

  const choose = (item: ToolFlyoutItem): void => {
    setRememberedId(item.id);
    onFacedIdChange?.(item.id);
    setOpen(false);
    item.onSelect();
  };

  const handleMenuKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!MENU_KEYS.includes(event.key)) return;
    const menu = menuRef.current;
    if (menu === null) return;
    const buttons = [
      ...menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    ];
    if (buttons.length === 0) return;
    const active = document.activeElement;
    const current = buttons.findIndex((button) => button === active);
    const next = menuTarget(event.key, buttons, current);
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  if (face === undefined) return null;
  const FaceIcon = face.icon;

  return (
    <div
      className={cn("flex shrink-0 items-center", className)}
      data-slot="tool-flyout"
      data-tool-family={label}
    >
      <ToolButton
        aria-keyshortcuts={face.shortcut}
        aria-label={face.label}
        aria-pressed={
          pressedId === undefined ? undefined : pressedId === face.id
        }
        className="relative rounded-e-none"
        data-testid={face.testId}
        data-tool-id={face.id}
        disabled={face.disabled}
        onClick={() => {
          face.onSelect();
        }}
        size="icon"
        title={face.description}
      >
        <FaceIcon />
        {/* The family tick: this face stands for more than itself. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-[3px] bottom-[3px] size-[3px] bg-current opacity-70 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
        />
      </ToolButton>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <button
              aria-haspopup="menu"
              aria-label={`${label} family`}
              className={cn(
                "flex h-(--tool-h) w-3 shrink-0 items-center justify-center",
                "rounded-sm rounded-s-none border border-transparent text-ink-faint",
                "transition-[background-color,color] duration-(--dur-state)",
                "ease-(--ease-instrument) focus-instrument",
                "hover:bg-well hover:text-ink aria-expanded:bg-well",
                "aria-expanded:text-ink",
              )}
              data-slot="tool-flyout-trigger"
              data-testid={triggerTestId}
              title={`${label} — the whole family`}
              type="button"
            />
          }
        >
          <ChevronDown className="size-2.5" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-56 gap-0 rounded-sm border border-rule bg-overlay p-1 text-ui shadow-overlay ring-0"
        >
          <div
            aria-label={label}
            className="flex flex-col"
            onKeyDown={handleMenuKeyDown}
            ref={menuRef}
            role="menu"
          >
            {items.map((item) => {
              const ItemIcon = item.icon;
              return (
                <button
                  className={cn(
                    "flex h-(--row-h-lg) items-center gap-(--gap) rounded-sm px-(--pad-row)",
                    "text-left text-ui text-ink-dim focus-instrument",
                    "transition-[background-color,color] duration-(--dur-state)",
                    "ease-(--ease-instrument)",
                    "hover:not-disabled:bg-well hover:not-disabled:text-ink",
                    "disabled:pointer-events-none disabled:text-ink-faint",
                    "data-faced:bg-well data-faced:text-ink",
                    "[&_svg]:size-3.5 [&_svg]:shrink-0",
                  )}
                  data-faced={item.id === face.id ? "" : undefined}
                  data-tool-id={item.id}
                  disabled={item.disabled}
                  key={item.id}
                  onClick={() => {
                    choose(item);
                  }}
                  role="menuitem"
                  title={item.description}
                  type="button"
                >
                  <ItemIcon />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.shortcut === undefined ? null : (
                    <KeyCap>{item.shortcut}</KeyCap>
                  )}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
