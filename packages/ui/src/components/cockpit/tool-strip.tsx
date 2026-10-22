/**
 * `ToolStrip` — the cockpit's horizontal run of tool clusters.
 *
 * The strip is the container the command row never had: before this
 * primitive the cockpit's top edge was an inline `<div>` whose groups were
 * hand-rolled `role="group"` divs and whose dividers were copy-pasted
 * `aria-hidden` spans. Everything structural about a strip — its height
 * off `--appbar-h`, its cluster gaps, its one keyboard model, and the
 * trailing cluster that catches families with no permanent home — lives
 * here, once.
 *
 * ## Clusters
 *
 * A strip's children are `ToolGroup`s. The group primitive already owns
 * the rule that separates one cluster from the next, so the strip adds no
 * dividers of its own: it lays the clusters out and nothing more.
 *
 * ## The trailing cluster (`overflow`)
 *
 * `overflow` is the strip's LAST cluster, pinned to the inline end and
 * present at every width. It exists because the zone invariant forbids
 * the old answer to a crowded row — `max-[1799px]:hidden` — so a family
 * that cannot earn a permanent cluster folds into this one instead of
 * disappearing. A control is never hidden by viewport width; it moves
 * into a flyout, and the flyout moves here.
 *
 * ## Keyboard
 *
 * `role="toolbar"` names the strip for assistive technology, and the
 * arrow keys walk its controls (Home/End jump to the ends). Tab order is
 * deliberately NOT collapsed to a single stop: the cockpit's keyboard
 * journey tabs through the row's controls today, and a roving tabindex
 * would silently remove every one of those stops. Arrow navigation is an
 * addition to the native order, never a replacement for it. A host
 * `onKeyDown` runs FIRST and wins — calling `preventDefault` in it (as a
 * digit-shortcut handler does) stops the strip from moving focus.
 */

import { cn } from "cn";
import { useRef } from "react";
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";

/** The keys the strip claims; every other key passes straight through. */
const STRIP_KEYS: readonly string[] = [
  "ArrowRight",
  "ArrowLeft",
  "Home",
  "End",
];

/** The control one strip key press moves focus to, wrapping at the ends. */
function stripTarget(
  key: string,
  controls: readonly HTMLButtonElement[],
  current: number,
): HTMLButtonElement | undefined {
  if (key === "Home") return controls[0];
  if (key === "End") return controls[controls.length - 1];
  if (current === -1) return controls[0];
  const step = key === "ArrowRight" ? 1 : -1;
  return controls[(current + step + controls.length) % controls.length];
}

/** Props of {@link ToolStrip}. */
export type ToolStripProps = Omit<
  ComponentProps<"div">,
  "role" | "aria-label"
> & {
  /** The strip's accessible name — a toolbar without one is invisible. */
  readonly label: string;
  /** The pinned trailing cluster (see the module doc). */
  readonly overflow?: ReactNode;
};

/** The strip container: clusters in, one toolbar out. */
function ToolStrip({
  className,
  label,
  overflow,
  children,
  onKeyDown,
  ...props
}: ToolStripProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!STRIP_KEYS.includes(event.key)) return;
    const strip = stripRef.current;
    if (strip === null) return;
    const controls = [
      ...strip.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    ];
    if (controls.length === 0) return;
    const active = document.activeElement;
    const current = controls.findIndex((control) => control === active);
    const next = stripTarget(event.key, controls, current);
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div
      aria-label={label}
      aria-orientation="horizontal"
      className={cn(
        "flex h-(--appbar-h) w-full shrink-0 items-center",
        "gap-(--gap) border-b border-rule bg-chrome px-(--gap)",
        className,
      )}
      data-slot="tool-strip"
      onKeyDown={handleKeyDown}
      ref={stripRef}
      role="toolbar"
      {...props}
    >
      <div className="flex min-w-0 items-center gap-(--gap)">{children}</div>
      {overflow === undefined ? null : (
        <div
          className="ml-auto flex shrink-0 items-center gap-(--gap)"
          data-slot="tool-strip-overflow"
        >
          {overflow}
        </div>
      )}
    </div>
  );
}

export { ToolStrip };
