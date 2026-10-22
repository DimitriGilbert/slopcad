import { cn } from "cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

/**
 * `ToolButton` — the instrument's one interactive control for tools,
 * modes and view actions.
 *
 * The accent rule of the whole product: a tool button is quiet until it
 * is ARMED. Idle is dim ink on nothing; hover lifts the surface, not the
 * ink colour; the armed state (`aria-pressed`) is the only place the
 * signal colour appears on a control — a wash plus a 1px edge, never a
 * filled amber slab. That keeps the accent meaning "this is live" instead
 * of meaning "this is a button".
 *
 * Pressed state is `aria-pressed`, not a class, so the armed truth is in
 * the accessibility tree where tests and screen readers both read it.
 * Momentary actions (undo, export) pass no `aria-pressed` at all.
 *
 * ## Armed is not the same as current
 *
 * `tone="value"` is the second appearance rule, and it exists because the
 * accent rule was being spent on things that are never off. A display
 * mode, a light rig, a render quality, a revolve axis — these are
 * SEGMENTED VALUES: exactly one member of the group is pressed at all
 * times, there is no null state, and nothing about the pressed one is
 * "live". Painted with the armed treatment they put three permanent amber
 * pills in the viewport's corner, which is three more than DESIGN.md's
 * "if two things on screen are amber, one of them is wrong" allows and
 * leaves the real armed tool and the real selection no contrast to claim.
 *
 * A value group therefore reads as what it physically is: an inset track
 * ({@link ToolValueGroup}, on the deepest well) with the current member
 * RAISED out of it on `panel-raised` behind a `rule-strong` edge. Same
 * `aria-pressed` truth, same testids, no accent — and the idle members
 * gain the button affordance they never had as bare words in a row.
 */
const toolButtonVariants = cva(
  [
    "group/tool relative inline-flex shrink-0 items-center gap-(--gap)",
    "rounded-sm border border-transparent bg-transparent",
    "font-medium whitespace-nowrap select-none",
    // `ink-dim`, not `text-ink-dim`: the size variants below carry
    // `text-ui`, and a `text-ink*` colour in the same merged string
    // deletes it (see the ink utilities in cockpit.css).
    "ink-dim transition-[background-color,color,border-color]",
    "duration-(--dur-state) ease-(--ease-instrument) focus-instrument",
    "hover:not-disabled:bg-well hover:not-disabled:ink",
    "active:not-disabled:translate-y-px",
    "disabled:pointer-events-none disabled:ink-faint disabled:opacity-60",
    // Armed: the one sanctioned appearance of the signal colour on a control.
    "aria-pressed:border-select-edge/45 aria-pressed:bg-select-wash",
    "aria-pressed:ink",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    "[&_svg:not([class*='size-'])]:size-3.5",
  ],
  {
    variants: {
      size: {
        default: "h-(--tool-h) px-2 text-ui",
        sm: "h-(--control-h) px-1.5 text-ui",
        icon: "h-(--tool-h) w-(--tool-h) justify-center px-0",
      },
      tone: {
        default: "",
        /* A destructive action reads as destructive only on intent
         * (hover/focus); at rest it stays as quiet as every neighbour. */
        destructive:
          "hover:not-disabled:bg-destructive/12 hover:not-disabled:text-destructive",
        /* One member of a segmented value group. The pressed member is
         * the CURRENT value, not an armed state, so it is raised out of
         * the group's track instead of accented — these overrides win
         * over the armed rules above because a variant's classes merge
         * after the base's. */
        value:
          "aria-pressed:border-rule-strong aria-pressed:bg-panel-raised aria-pressed:ink",
      },
    },
    defaultVariants: { size: "default", tone: "default" },
  },
);

function ToolButton({
  className,
  size,
  tone,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof toolButtonVariants>) {
  return (
    <button
      data-slot="tool-button"
      type={type}
      className={cn(toolButtonVariants({ size, tone }), className)}
      {...props}
    />
  );
}

/**
 * `ToolGroup` — a related run of tool buttons.
 *
 * Grouping is structural, not decorative: buttons that belong to one
 * concern sit tight together, and a rule separates one group from the
 * next. No pill container, no segmented-control chrome — the gap and the
 * rule carry the whole relationship.
 *
 * `label` is required because an unlabelled group is invisible to
 * assistive technology; it becomes the group's accessible name.
 */
function ToolGroup({
  className,
  label,
  separated = true,
  ...props
}: ComponentProps<"div"> & {
  readonly label: string;
  readonly separated?: boolean;
}) {
  return (
    <div
      data-slot="tool-group"
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 items-center gap-(--gap-tight)",
        separated &&
          "border-rule pl-(--gap) not-first:border-l first:pl-0 ml-(--gap-tight) first:ml-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `ToolValueGroup` — a segmented value, as a track.
 *
 * The container half of `tone="value"`: a hairline well-deep track the
 * members sit flush inside, so the current member reads as RAISED out of
 * it and the others read as seated in it. That inset is what makes a
 * group of words a control — before it, an unpressed display mode was
 * bare text in a grid with no affordance at all, and the pressed one had
 * to borrow the armed accent just to be distinguishable.
 *
 * Pass `columns` for a wrapped track (the viewport strip's 2×2 display
 * modes); omit it for one row (an axis pair). The group is still a
 * `ToolGroup`, so it still carries the required accessible name.
 */
function ToolValueGroup({
  className,
  columns,
  ...props
}: ComponentProps<typeof ToolGroup> & {
  /** Lay the members out in this many equal columns instead of one row. */
  readonly columns?: number;
}) {
  return (
    <ToolGroup
      data-slot="tool-value-group"
      separated={false}
      className={cn(
        "gap-px rounded-sm border border-rule bg-well-deep p-px",
        columns === undefined
          ? "flex"
          : "grid grid-cols-(--tool-value-columns) items-stretch",
        "[&>*]:min-w-0 [&>*]:flex-1 [&>*]:rounded-[3px]",
        className,
      )}
      style={
        columns === undefined
          ? undefined
          : ({
              "--tool-value-columns": `repeat(${String(columns)}, minmax(0, 1fr))`,
            } as CSSProperties)
      }
      {...props}
    />
  );
}

/**
 * `KeyCap` — a shortcut hint rendered as a physical cap.
 *
 * Decorative by contract: the cap is `aria-hidden`, and the control it
 * sits in carries the real `aria-keyshortcuts`. This is what keeps the
 * keyboard-first surface discoverable without doubling every accessible
 * name with punctuation noise.
 */
function KeyCap({
  className,
  children,
  ...props
}: ComponentProps<"kbd"> & { readonly children: ReactNode }) {
  return (
    <kbd
      data-slot="key-cap"
      aria-hidden="true"
      className={cn(
        "inline-flex min-w-(--control-h-sm) items-center justify-center",
        "rounded-[2px] border border-rule bg-well-deep px-1",
        // `ink-faint`, not `text-ink-faint`: paired with `text-micro` in
        // one merged string the colour utility deleted the SIZE, and a
        // 16px cap over a 14px icon is what put the sketch strip's digits
        // on top of the marks they annotate (see cockpit.css).
        "font-mono text-micro ink-faint tabular",
        "h-(--control-h-sm) leading-none",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

export { KeyCap, ToolButton, ToolGroup, ToolValueGroup, toolButtonVariants };
