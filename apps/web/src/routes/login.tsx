/**
 * The login route: the auth stage. The two Formedible-era form components
 * keep their field contracts (labels, buttons, validation) verbatim; the
 * route composes them onto one centered instrument card with the brand
 * plate above it — the first composed surface a signed-out visitor sees.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Panel } from "@slopcad/ui/components/cockpit/panel";

import { PlateMark } from "@/components/header";
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
    <div className="flex h-full items-center justify-center overflow-y-auto bg-chrome px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center">
        <Link
          className="mb-(--gap-group) flex items-center gap-2 focus-instrument"
          title="slopcad home"
          to="/"
        >
          <PlateMark className="size-4 rounded-[4px]" />
          <span className="font-display text-title font-semibold text-ink">
            slopcad
          </span>
        </Link>
        {/* The auth card is the one thing on the page, so it is an
            overlay rung — the only rung that carries a shadow. */}
        <Panel elevation="overlay" className="w-full p-(--gap-group)">
          {showSignIn ? (
            <SignInForm onSwitchToSignUp={() => setShowSignIn(false)} />
          ) : (
            <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
          )}
        </Panel>
      </div>
    </div>
  );
}
