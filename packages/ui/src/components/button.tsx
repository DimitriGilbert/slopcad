import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "cn";
import { cva, type VariantProps } from "class-variance-authority";

/**
 * The control scale of the Machinist system: 4px corners, hairline
 * borders, and one loud fill (the amber primary). Every variant keeps
 * AA contrast in both themes — the primary inks are tuned per theme
 * (near-black on amber, near-white on bronze).
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-sm border border-transparent bg-clip-padding text-xs font-medium whitespace-nowrap transition-colors duration-150 outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/70 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // The one filled variant. Its disabled state DROPS the accent
        // entirely (the system's accent rule: the signal colour means
        // armed / selected / confirmable — an action that cannot be taken
        // is none of those, so a faded amber slab would be a lie).
        default:
          "bg-primary text-primary-foreground hover:bg-primary/85 shadow-[inset_0_1px_0_color-mix(in_oklch,var(--primary-foreground)_14%,transparent)] active:shadow-[inset_0_2px_6px_color-mix(in_oklch,var(--primary-foreground)_28%,transparent)] disabled:border-rule disabled:bg-well disabled:text-ink-faint disabled:shadow-none disabled:opacity-100",
        outline:
          "border-border bg-card text-foreground hover:border-input hover:bg-muted dark:bg-card/60 dark:hover:bg-muted aria-expanded:bg-muted",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_6%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/60",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/15 dark:hover:bg-destructive/25 dark:focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Every rung is a density token, never a pixel: `cockpit.css` owns
      // the control ramp (20 / 24 / 28 / 32 / 36) and one edit there
      // re-tunes every button in the product. A hardcoded `h-8` here was
      // a second, silent source of the same metric — the exact thing
      // DESIGN.md's "no component may hardcode a height" forbids.
      size: {
        default:
          "h-(--control-h-lg) gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-(--control-h) gap-1 px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-(--tool-h) gap-1 px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-(--control-h-xl) gap-1.5 px-3.5 has-data-[icon=inline-start]:pl-2",
        icon: "h-(--control-h-lg) w-(--control-h-lg)",
        "icon-xs":
          "h-(--control-h) w-(--control-h) [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "h-(--tool-h) w-(--tool-h) [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "h-(--control-h-xl) w-(--control-h-xl)",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
