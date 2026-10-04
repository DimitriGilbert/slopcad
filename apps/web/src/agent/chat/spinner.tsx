/**
 * Ported from shadcn-ui/chatbot-template (`components/ui/spinner.tsx`), MIT
 * License — Copyright (c) 2026 shadcn,
 * https://github.com/shadcn-ui/chatbot-template.
 *
 * Unmodified apart from the `cn` import path. The inline status spinner used
 * by agent progress lines ("Searching the web for '…'…") and busy buttons.
 */

import { cn } from "@slopcad/ui/lib/utils";
import { Loader2Icon } from "lucide-react";
import * as React from "react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
