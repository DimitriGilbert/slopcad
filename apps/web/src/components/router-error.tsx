import type { ReactElement } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@slopcad/ui/components/button";

/**
 * The router's default error screen: with no `defaultErrorComponent`, the
 * installed TanStack router mounts no CatchBoundary at all, so any render
 * throw (e.g. an untrusted chat part the display layer could not render)
 * unmounts the whole React tree into a blank page. This screen catches
 * instead — one honest line, the error's own message, and the router's
 * reset affordance — styled after the app's minimal pending/not-found
 * surfaces.
 */
export default function RouterErrorScreen({
  error,
  reset,
}: ErrorComponentProps): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium text-foreground">
        Something went wrong.
      </p>
      <p className="max-w-md text-xs text-muted-foreground">
        {error instanceof Error && error.message.length > 0
          ? error.message
          : "An unexpected error interrupted this view."}
      </p>
      <Button onClick={reset} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
}
