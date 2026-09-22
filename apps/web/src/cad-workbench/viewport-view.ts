/**
 * The viewport view session (Phase 45): the session-scoped record behind
 * navigation and display — the user-camera overlay, the display mode, and
 * the angle convention. Pure data plus pure reducers, so the composition
 * wires it as plain state and every writer is a user action (the ADR's
 * law: `docs/architecture/adr-user-camera-overlay.md`).
 *
 * NOTHING here ever serializes: no document record, no baseline, no
 * export carries this state — `null`/`"shaded"`/`"third-angle"` is the
 * spec-law boot, and page state is the record's whole lifetime.
 */

import type { RenderCamera } from "@slopcad/cad-core";
import type { CadDisplayMode, ViewAngleConvention } from "@slopcad/cad-r3f";

/** The session record: camera overlay + display preferences. */
export interface ViewportViewSession {
  /**
   * The user camera overlay: replaces the projection's spec for rendering
   * only while present. `null` is spec law (the boot state and the only
   * state the pinned baselines ever render).
   */
  readonly userCamera: RenderCamera | null;
  /** The display mode; `shaded` is the established default bytes. */
  readonly displayMode: CadDisplayMode;
  /** The projection-arrangement convention (third angle is the default). */
  readonly convention: ViewAngleConvention;
}

/** The session every viewport boots with: spec law, shaded, third angle. */
export function createViewportViewSession(): ViewportViewSession {
  return {
    convention: "third-angle",
    displayMode: "shaded",
    userCamera: null,
  };
}

/**
 * Writes (or clears) the user camera. The ONLY non-user writer guard is
 * structural: nothing else in the codebase calls this with a camera —
 * the callers are gesture commits and view commands.
 */
export function sessionWithUserCamera(
  session: ViewportViewSession,
  userCamera: RenderCamera | null,
): ViewportViewSession {
  return { ...session, userCamera };
}

/** Sets the display mode (a user display choice; never serialized). */
export function sessionWithDisplayMode(
  session: ViewportViewSession,
  displayMode: CadDisplayMode,
): ViewportViewSession {
  return { ...session, displayMode };
}

/** Sets the angle convention (a user display preference). */
export function sessionWithConvention(
  session: ViewportViewSession,
  convention: ViewAngleConvention,
): ViewportViewSession {
  return { ...session, convention };
}
