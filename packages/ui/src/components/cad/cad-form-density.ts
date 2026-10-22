/**
 * The cockpit's form treatment — ONE definition, shared by every CAD form.
 *
 * Formedible renders a form from a config, and the config is where a form
 * declares how dense it is. Without a shared declaration each CAD surface
 * re-invented the answer: the parameter rail, the configuration panel and
 * the twenty-seven feature-dialog forms each stacked a default-size label
 * over a 32px control with the default gap, so one parameter ate ~62px of
 * a rail whose row contract (DESIGN.md) is 24px, and the feature dialogs
 * spoke a different type scale from the panels behind them.
 *
 * The three keys below are the class hooks the Formedible config already
 * exposes (`fieldClassName`, `labelClassName`, `formClassName` — see
 * `formedible/lib/types.ts`), filled with the system's own tokens. The
 * treatment deliberately does NOT live inside the formedible components:
 * the auth forms and the project forms are page forms, not instrument
 * chrome, and they keep the default comfortable scale.
 *
 * Spread it into a `useFormedible` config:
 *
 * ```ts
 * const form = useFormedible<Values>({ ...COCKPIT_FORM, fields, formOptions });
 * ```
 *
 * `[&_…]` descendant hooks carry the control metrics because the control
 * primitives (`Input`, `FieldLabel`, `FieldError`) are shared with those
 * page forms and may not be re-sized at the source. `font-normal` on the
 * label is load bearing: `FieldLabel` ships `font-medium`, which at 11px in
 * a dense rail reads as a second heading level beside the small-caps
 * section strip above it.
 */
export const COCKPIT_FORM = {
  fieldClassName: [
    "gap-(--gap-tight)",
    "[&_[data-slot=input]]:h-(--control-h) [&_[data-slot=input]]:px-1.5",
    "[&_[data-slot=field-description]]:text-micro",
    "[&_[data-slot=field-error]]:text-micro",
  ].join(" "),
  // `space-y-0` and `items-start` are both corrections, not decoration:
  // `FormLayout` ships `space-y-4`, which does NOT collide with a `gap` in
  // tailwind-merge's eyes, so the two would stack into 28px of air between
  // fields; and a flex column stretches its children, which turned the one
  // confirming action of each form into a full-width filled slab — exactly
  // what DESIGN.md forbids the accent to do.
  formClassName: "flex flex-col items-start gap-(--gap-group) space-y-0",
  labelClassName: "text-label font-normal ink-dim",
} as const;
