import { cn } from "cn";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";

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
 */
const toolButtonVariants = cva(
  [
    "group/tool relative inline-flex shrink-0 items-center gap-(--gap)",
    "rounded-sm border border-transparent bg-transparent",
    "font-medium whitespace-nowrap select-none",
    "text-ink-dim transition-[background-color,color,border-color]",
    "duration-(--dur-state) ease-(--ease-instrument) focus-instrument",
    "hover:not-disabled:bg-well hover:not-disabled:text-ink",
    "active:not-disabled:translate-y-px",
    "disabled:pointer-events-none disabled:text-ink-faint disabled:opacity-60",
    // Armed: the one sanctioned appearance of the signal colour on a control.
    "aria-pressed:border-select-edge/45 aria-pressed:bg-select-wash",
    "aria-pressed:text-ink",
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
        "font-mono text-micro text-ink-faint tabular",
        "h-(--control-h-sm) leading-none",
        className,
      )}
      {...props}
    >
      {children}
    </kbd>
  );
}

export { KeyCap, ToolButton, ToolGroup, toolButtonVariants };
