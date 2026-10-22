"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      /*
       * The toast surface stays the overlay rung in every state (below);
       * the TYPE is carried by this icon and by the message's own words,
       * tinted from the product's semantic tokens. Sonner's `richColors`
       * would repaint the whole toast in its own green/red palette —
       * a second colour language arriving over the instrument's chrome,
       * which is exactly what the design system forbids.
       */
      icons={{
        success: <CircleCheckIcon className="size-4 text-status-ok" />,
        info: <InfoIcon className="size-4 text-status-parked" />,
        warning: <TriangleAlertIcon className="size-4 text-signal" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--overlay)",
          "--normal-text": "var(--ink)",
          "--normal-border": "var(--rule-strong)",
          "--border-radius": "var(--radius-md, var(--radius))",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
