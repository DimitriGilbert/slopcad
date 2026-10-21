import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

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
      <TitleTag className="label-section truncate text-ink-faint">
        {title}
      </TitleTag>
      {children}
      {trailing === undefined ? null : (
        <span
          data-slot="panel-header-trailing"
          className="ml-auto flex shrink-0 items-center gap-(--gap-tight) text-data text-ink-faint tabular"
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
 */
function PanelSection({
  className,
  title,
  trailing,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  readonly title: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <div
      data-slot="panel-section"
      className={cn("flex min-w-0 flex-col", className)}
      {...props}
    >
      <div className="flex h-(--header-h) shrink-0 items-center gap-(--gap) border-t border-rule bg-well/60 px-(--pad-panel)">
        <span className="label-section truncate text-ink-faint">{title}</span>
        {trailing === undefined ? null : (
          <span className="ml-auto flex shrink-0 items-center gap-(--gap-tight) text-data text-ink-faint tabular">
            {trailing}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

export { Panel, PanelBody, PanelHeader, PanelSection };
