/**
 * `ToolOptionsBar` — the cockpit's TOP′ zone: the ARMED tool's own strip.
 *
 * A parametric cockpit dials a tool in at the top of the frame, not in a
 * modal. Until this bar existed every option in slopcad lived in a
 * Formedible dialog, which is why arming a tool told the operator nothing
 * about what it could be told to do. The bar is the mechanism for that:
 * one `--tool-h` strip directly under the tool strip, present only while
 * a tool is armed, rendering a DESCRIPTOR rather than per-tool JSX.
 *
 * ## Why a descriptor
 *
 * The bar never knows a tool. It renders `{toolLabel, hint, controls}`,
 * and the controls are three honest shapes — a `toggle` (armed truth in
 * `aria-pressed`), an `action` (momentary, no pressed state at all), and
 * a `readout` (a DRO cell: dim name, mono tabular value). A tool whose
 * option does not fit one of those three does not get a fourth shape; it
 * gets a dialog, as it does today.
 *
 * ## Honesty
 *
 * A control the tool cannot offer right now renders DISABLED with the
 * reason in its `title` — never absent, never enabled-and-inert. A tool
 * with no options produces no descriptor, and the bar is then not
 * rendered at all: an empty strip claiming a tool has options is the kind
 * of fake state the product forbids.
 */

import { cn } from "cn";
import type { ComponentProps } from "react";

import { PropertyRow, Readout } from "./property-row";
import { ToolButton, ToolGroup } from "./tool-button";

/** A two-state option of the armed tool. */
export interface ToolOptionsToggle {
  readonly kind: "toggle";
  /** Stable id (the option's name in the tool's vocabulary). */
  readonly id: string;
  /** The visible name and accessible name. */
  readonly label: string;
  /** Whether the option is on — published as `aria-pressed`. */
  readonly pressed: boolean;
  /** Whether the option can be changed right now. */
  readonly disabled?: boolean;
  /** What the option does, or why it cannot change. */
  readonly title: string;
  /** Flips the option. */
  readonly onToggle: () => void;
}

/** A momentary action of the armed tool. */
export interface ToolOptionsAction {
  readonly kind: "action";
  /** Stable id (the action's name in the tool's vocabulary). */
  readonly id: string;
  /** The visible name and accessible name. */
  readonly label: string;
  /** Whether the action can run right now. */
  readonly disabled?: boolean;
  /** What running it does, or why it cannot run. */
  readonly title: string;
  /** Runs the action. */
  readonly onRun: () => void;
}

/** A live value the armed tool reports. */
export interface ToolOptionsReadout {
  readonly kind: "readout";
  /** Stable id (the readout's name in the tool's vocabulary). */
  readonly id: string;
  /** The readout's dim name. */
  readonly label: string;
  /** The readout's value, already formatted by its owner. */
  readonly value: string;
}

/** One control of the armed tool's bar. */
export type ToolOptionsControl =
  ToolOptionsToggle | ToolOptionsAction | ToolOptionsReadout;

/** Everything the bar renders for one armed tool. */
export interface ToolOptionsDescriptor {
  /** The armed tool's name — the bar's leading plate. */
  readonly toolLabel: string;
  /** The tool's prompt: what the operator is expected to do next. */
  readonly hint: string;
  /** The tool's controls, in bar order. */
  readonly controls: readonly ToolOptionsControl[];
}

/** Props of {@link ToolOptionsBar}. */
export type ToolOptionsBarProps = Omit<
  ComponentProps<"div">,
  "children" | "role" | "aria-label"
> & {
  /** The armed tool's descriptor, or `null` for "no tool is armed". */
  readonly descriptor: ToolOptionsDescriptor | null;
  /** The bar's accessible name. */
  readonly label?: string;
};

/** The armed tool's option strip, or nothing when no tool is armed. */
function ToolOptionsBar({
  className,
  descriptor,
  label = "Tool options",
  ...props
}: ToolOptionsBarProps) {
  if (descriptor === null) return null;
  return (
    <div
      aria-label={label}
      className={cn(
        "flex h-(--tool-h) w-full shrink-0 items-center gap-(--gap-group)",
        "border-b border-rule bg-well px-(--gap)",
        className,
      )}
      data-slot="tool-options-bar"
      data-tool-options={descriptor.toolLabel}
      role="group"
      {...props}
    >
      {/* The armed tool's name: the bar says WHOSE options these are, so
          the strip above does not have to be read to know. */}
      <span className="label-section shrink-0 text-ink">
        {descriptor.toolLabel}
      </span>
      <span className="shrink-0 font-mono text-micro text-ink-faint">
        {descriptor.hint}
      </span>
      {descriptor.controls.length === 0 ? null : (
        <ToolGroup
          className="min-w-0"
          label={`${descriptor.toolLabel} options`}
        >
          {descriptor.controls.map((control) =>
            control.kind === "readout" ? (
              <Readout
                data-tool-option={control.id}
                key={control.id}
                label={control.label}
              >
                {control.value}
              </Readout>
            ) : (
              <ToolButton
                aria-pressed={
                  control.kind === "toggle" ? control.pressed : undefined
                }
                data-tool-option={control.id}
                disabled={control.disabled}
                key={control.id}
                onClick={
                  control.kind === "toggle" ? control.onToggle : control.onRun
                }
                size="sm"
                title={control.title}
              >
                {control.label}
              </ToolButton>
            ),
          )}
        </ToolGroup>
      )}
    </div>
  );
}

/** Props of {@link ToolOptionsPanel}. */
export type ToolOptionsPanelProps = Omit<
  ComponentProps<"div">,
  "children" | "role" | "aria-label"
> & {
  /** The armed tool's descriptor, or `null` for "no tool is armed". */
  readonly descriptor: ToolOptionsDescriptor | null;
};

/**
 * `ToolOptionsPanel` — the SAME descriptor, rendered down a rail.
 *
 * The layout law puts the armed tool's form in the inspector as well as
 * on the strip: the inspector is where a feature is dialled in, and a
 * tool that is live has more to say than a 28px strip row has width for.
 * This is deliberately not a second vocabulary — it renders the identical
 * `ToolOptionsDescriptor` the bar renders, so a tool can never offer one
 * thing at the top of the frame and another at its side. Readouts become
 * `PropertyRow`s (label left, tabular value right); toggles and actions
 * become one quiet run of controls.
 */
function ToolOptionsPanel({
  className,
  descriptor,
  ...props
}: ToolOptionsPanelProps) {
  if (descriptor === null) return null;
  const readouts = descriptor.controls.filter(
    (control): control is ToolOptionsReadout => control.kind === "readout",
  );
  const controls = descriptor.controls.filter(
    (control) => control.kind !== "readout",
  );
  return (
    <div
      aria-label={`${descriptor.toolLabel} options`}
      className={cn("flex min-w-0 flex-col", className)}
      data-slot="tool-options-panel"
      data-tool-options={descriptor.toolLabel}
      role="group"
      {...props}
    >
      <p className="px-(--pad-panel) pt-(--pad-row) text-label text-ink-dim">
        <span className="text-ink">{descriptor.toolLabel}</span>
        {" — "}
        {descriptor.hint}
      </p>
      {readouts.map((readout) => (
        <PropertyRow
          data-tool-option={readout.id}
          key={readout.id}
          label={readout.label}
        >
          <span className="font-mono text-data tabular">{readout.value}</span>
        </PropertyRow>
      ))}
      {controls.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-(--gap-tight) p-(--pad-panel)">
          {controls.map((control) => (
            <ToolButton
              aria-pressed={
                control.kind === "toggle" ? control.pressed : undefined
              }
              data-tool-option={control.id}
              disabled={control.disabled}
              key={control.id}
              onClick={
                control.kind === "toggle" ? control.onToggle : control.onRun
              }
              size="sm"
              title={control.title}
            >
              {control.label}
            </ToolButton>
          ))}
        </div>
      )}
    </div>
  );
}

export { ToolOptionsBar, ToolOptionsPanel };
