/**
 * The login route: the auth stage. The two Formedible-era form components
 * keep their field contracts (labels, buttons, validation) verbatim; the
 * route composes them onto one centered instrument card with the brand
 * plate above it — the first composed surface a signed-out visitor sees.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      {
        title: "Sign in · slopcad",
      },
    ],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <div className="bg-background/30 flex h-full items-center justify-center overflow-y-auto px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center">
        <Link
          className="mb-6 flex items-center gap-2.5"
          title="slopcad home"
          to="/"
        >
          <span
            aria-hidden="true"
            className="border-primary/70 bg-primary/15 relative size-4 rounded-[4px] border"
          >
            <span className="border-primary absolute -top-1 -left-1 size-2 rounded-[2px] border" />
          </span>
          <span className="text-foreground font-mono text-sm font-semibold tracking-tight">
            slopcad
          </span>
        </Link>
        <div className="border-border bg-card/60 w-full rounded-lg border p-6 shadow-[0_1px_2px_color-mix(in_oklch,var(--foreground)_10%,transparent)]">
          {showSignIn ? (
            <SignInForm onSwitchToSignUp={() => setShowSignIn(false)} />
          ) : (
            <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
          )}
        </div>
      </div>
    </div>
  );
}
