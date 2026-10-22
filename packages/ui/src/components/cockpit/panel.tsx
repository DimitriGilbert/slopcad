import { cn } from "cn";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/**
 * `Panel` — the cockpit's enclosure primitive.
 *
 * Every docked region of the instrument (model tree, properties,
 * parameters, timeline, inspector) is one `Panel`: a surface off the
 * elevation ramp, a hairline rule, and nothing else. There is no card
 * shadow, no gradient and no inner padding by default — a panel is a
 * frame, and its content owns its own density.
 *
 * `elevation` picks the rung: `panel` for a docked face, `raised` for a
 * panel that sits over another one, `overlay` for a floating surface
 * (popover, palette, dialog body) which is the only rung that carries a
 * shadow. `flush` drops the rule and the radius for a panel that spans a
 * frame edge, where the frame's own rule already separates it.
 */
function Panel({
  className,
  elevation = "panel",
  flush = false,
  ...props
}: ComponentProps<"section"> & {
  readonly elevation?: "panel" | "raised" | "overlay";
  readonly flush?: boolean;
}) {
  return (
    <section
      data-slot="panel"
      data-elevation={elevation}
      className={cn(
        "flex min-h-0 min-w-0 flex-col",
        elevation === "panel" && "bg-panel",
        elevation === "raised" && "bg-panel-raised",
        elevation === "overlay" && "bg-overlay shadow-overlay",
        flush ? "border-0" : "rounded-md border border-rule",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `PanelHeader` — the panel's name strip.
 *
 * One fixed height, the section voice (small caps, tracked, dim), an
 * optional right-hand slot for a count or a control, and a bottom rule.
 * The header is never a heading element by default: panels are furniture,
 * not document structure. Pass `as="h2"` through `titleAs` when a surface
 * genuinely needs the outline entry.
 */
function PanelHeader({
  className,
  title,
  titleAs: TitleTag = "span",
  trailing,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  readonly title: ReactNode;
  readonly titleAs?: "span" | "h1" | "h2" | "h3";
  readonly trailing?: ReactNode;
}) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex h-(--header-h) shrink-0 items-center gap-(--gap)",
        "border-b border-rule px-(--pad-panel)",
        className,
      )}
      {...props}
    >
      <TitleTag className="label-section truncate ink-faint">{title}</TitleTag>
      {children}
      {trailing === undefined ? null : (
        <span
          data-slot="panel-header-trailing"
          className="ml-auto flex shrink-0 items-center gap-(--gap-tight) text-data ink-faint tabular"
        >
          {trailing}
        </span>
      )}
    </div>
  );
}

/**
 * `PanelBody` — the scrolling content region of a panel.
 *
 * Owns the overflow and the panel's one padding decision, so no consumer
 * has to re-derive either. `inset={false}` is the dense default (rows run
 * edge to edge and draw their own separators); `inset` adds the panel pad
 * for prose and form content.
 */
function PanelBody({
  className,
  inset = false,
  ...props
}: ComponentProps<"div"> & { readonly inset?: boolean }) {
  return (
    <div
      data-slot="panel-body"
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overflow-x-hidden",
        inset && "p-(--pad-panel)",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `PanelSection` — a named group WITHIN a panel body.
 *
 * The cockpit stacks several concerns in one rail (tree, then
 * measurement, then parameters). Each is a section: a rule above, the
 * same small-caps voice as a panel header, and its rows below. Sections
 * never nest and never carry their own surface — the stack must read as
 * one continuous panel, not as a pile of cards.
 *
 * ## Disclosure
 *
 * `collapsible` turns the name strip into a disclosure button: a chevron
 * at the inline start, `aria-expanded` carrying the truth, and
 * `aria-controls` pointing at the content region. This is what lets a
 * rail stack four concerns in one scroll without the percentage height
 * caps the old right dock used (`max-h-[55%]` / `max-h-[45%]`) — the
 * operator closes what they are not using instead of every section
 * fighting for a share of the column.
 *
 * Closed content is HIDDEN, never unmounted (the cockpit's restore
 * discipline — a closed section keeps its scroll position, its form
 * state and its selection), and `display:none` takes it out of the tab
 * order and the accessibility tree at the same time.
 *
 * State is uncontrolled by default (`defaultOpen`) and controlled when
 * `open` is supplied, so a rail can persist the whole disclosure map.
 * `trailing` stays OUTSIDE the button: a count is decoration, but a
 * control in that slot must stay independently clickable.
 */
function PanelSection({
  className,
  title,
  trailing,
  collapsible = false,
  defaultOpen = true,
  open,
  onOpenChange,
  children,
  id,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  readonly title: ReactNode;
  readonly trailing?: ReactNode;
  /** Turns the name strip into a disclosure button. */
  readonly collapsible?: boolean;
  /** The uncontrolled initial disclosure state. */
  readonly defaultOpen?: boolean;
  /** The controlled disclosure state (wins over `defaultOpen`). */
  readonly open?: boolean;
  /** Called with the next disclosure state on every toggle. */
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = !collapsible || (open ?? uncontrolledOpen);
  const contentId = id === undefined ? undefined : `${id}-content`;

  const name = (
    <span className="label-section truncate ink-faint">{title}</span>
  );

  return (
    <div
      data-slot="panel-section"
      data-state={collapsible ? (isOpen ? "open" : "closed") : undefined}
      className={cn("flex min-w-0 shrink-0 flex-col", className)}
      id={id}
      {...props}
    >
      <div className="flex h-(--header-h) shrink-0 items-center gap-(--gap) border-t border-rule bg-well/60 px-(--pad-panel)">
        {collapsible ? (
          <button
            aria-controls={contentId}
            aria-expanded={isOpen}
            className={cn(
              "-mx-1 flex min-w-0 flex-1 items-center gap-(--gap-tight) rounded-sm px-1",
              "h-full cursor-pointer text-left transition-colors",
              "duration-(--dur-state) ease-(--ease-instrument) focus-instrument",
              "hover:bg-well",
            )}
            data-slot="panel-section-toggle"
            onClick={() => {
              const next = !isOpen;
              setUncontrolledOpen(next);
              onOpenChange?.(next);
            }}
            type="button"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3 shrink-0 ink-faint transition-transform",
                "duration-(--dur-state) ease-(--ease-instrument)",
                isOpen && "rotate-90",
              )}
            />
            {name}
          </button>
        ) : (
          name
        )}
        {trailing === undefined ? null : (
          <span className="ml-auto flex shrink-0 items-center gap-(--gap-tight) text-data ink-faint tabular">
            {trailing}
          </span>
        )}
      </div>
      {collapsible ? (
        <div
          className={isOpen ? "flex min-w-0 flex-col" : "hidden"}
          data-slot="panel-section-content"
          id={contentId}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

export { Panel, PanelBody, PanelHeader, PanelSection };
