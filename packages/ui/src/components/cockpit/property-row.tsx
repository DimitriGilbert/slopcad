import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

/**
 * `PropertyRow` — the unit of information density.
 *
 * A parametric CAD panel is a list of name/value pairs, and the single
 * biggest difference between a professional one and a web form is that
 * the pair shares a line: label left in dim ink, value right in tabular
 * mono, 24px tall, separated by a hairline instead of by air. One screen
 * then carries three times the facts at the same legibility.
 *
 * Presentational by design — it renders a `div` and takes no handlers, so
 * it never fakes an affordance. A consumer that needs the row to be
 * selectable supplies its own interactive wrapper and passes `selected`;
 * the selection appearance (wash plus the signal edge on the inline-start
 * border) lives here so every panel agrees on what selected looks like.
 */
function PropertyRow({
  className,
  label,
  unit,
  selected = false,
  children,
  ...props
}: ComponentProps<"div"> & {
  readonly label: ReactNode;
  /** The unit, printed after the value in faint ink (never inside it). */
  readonly unit?: ReactNode;
  readonly selected?: boolean;
}) {
  return (
    <div
      data-slot="property-row"
      data-selected={selected ? "true" : undefined}
      className={cn(
        "grid min-h-(--row-h) grid-cols-[minmax(0,1fr)_auto] items-center",
        "gap-(--gap) border-l-2 border-l-transparent border-b border-b-rule/60",
        "px-(--pad-row) text-ui last:border-b-0",
        selected
          ? "border-l-select-edge bg-select-wash text-select-ink"
          : "text-ink",
        className,
      )}
      {...props}
    >
      <span
        data-slot="property-label"
        className="truncate text-label text-ink-dim"
      >
        {label}
      </span>
      <span
        data-slot="property-value"
        className="flex items-baseline gap-1 font-mono text-data tabular"
      >
        {children}
        {unit === undefined ? null : (
          <span className="text-micro text-ink-faint">{unit}</span>
        )}
      </span>
    </div>
  );
}

/**
 * `Readout` — one measured fact, as a DRO cell.
 *
 * Used in the status strip and over the viewport: a tiny dim name and a
 * tabular value on one baseline. The value is always mono so a changing
 * number never reflows its neighbours, which is what makes a live readout
 * readable while the model moves.
 */
function Readout({
  className,
  label,
  unit,
  children,
  ...props
}: ComponentProps<"div"> & {
  readonly label: ReactNode;
  readonly unit?: ReactNode;
}) {
  return (
    <div
      data-slot="readout"
      className={cn(
        "flex shrink-0 items-baseline gap-1.5 whitespace-nowrap",
        className,
      )}
      {...props}
    >
      <span className="label-section text-ink-faint">{label}</span>
      <span className="font-mono text-data text-ink tabular">{children}</span>
      {unit === undefined ? null : (
        <span className="font-mono text-micro text-ink-faint">{unit}</span>
      )}
    </div>
  );
}

/** The named states a {@link StatusDot} can report. */
export type StatusTone = "ok" | "warn" | "error" | "parked" | "idle";

const STATUS_COLOR: Readonly<Record<StatusTone, string>> = {
  ok: "bg-status-ok",
  warn: "bg-signal",
  error: "bg-destructive",
  parked: "bg-status-parked",
  idle: "bg-ink-faint",
};

/**
 * `StatusDot` — a 6px lamp.
 *
 * Colour is never the only carrier of a status in this product, so the
 * dot is `aria-hidden` and `label` is rendered beside it as screen-reader
 * text. A consumer that already prints the status in visible words passes
 * the same string; nothing is ever communicated by hue alone.
 */
function StatusDot({
  className,
  tone,
  label,
  ...props
}: ComponentProps<"span"> & {
  readonly tone: StatusTone;
  readonly label: string;
}) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone}
      className={cn("inline-flex shrink-0 items-center", className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", STATUS_COLOR[tone])}
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export { PropertyRow, Readout, StatusDot };
