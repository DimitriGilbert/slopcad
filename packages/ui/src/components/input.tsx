import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "cn";
import * as React from "react";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-sm border border-input bg-card/50 px-2.5 py-1 font-mono text-xs tabular-nums transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:font-sans file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-ring/40 focus-visible:border-ring focus-visible:bg-card focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/40 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/25 md:text-xs dark:bg-input/20 dark:disabled:bg-input/50 dark:aria-invalid:border-destructive/60 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
