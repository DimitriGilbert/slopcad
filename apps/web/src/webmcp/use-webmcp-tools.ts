/**
 * The WebMCP binding (Phase 7): the React seam that mounts a set of tool
 * entries for a route's lifetime and — when the browser exposes the draft
 * `document.modelContext` API — ALSO mirrors them there for browser-
 * resident AI agents.
 *
 * ## The mirror is a projection, never the truth
 *
 * The internal registry ({@link ./registry}) is populated unconditionally:
 * registering there needs no flag, no origin trial, no browser. The spec
 * mirror is progressive enhancement — when `document.modelContext` is
 * absent (every current browser may be), the mirror side silently no-ops
 * and the registry still serves the `window.__slopcadWebMcpTools` seam.
 *
 * ## Failure honesty
 *
 * A mirror `registerTool` rejection must never throw into app code — the
 * page's function does not depend on the agent surface. The repo has no
 * shared logging pattern, so rejections are swallowed into a debug counter
 * readable via {@link webMcpMirrorDiagnostics} (never `console`).
 *
 * ## SSR safety
 *
 * The hook does nothing during render; all browser access lives inside the
 * effect ({@link bindWebMcpTools}), which React never runs on the server.
 * The binding itself re-checks `typeof document` so the exported function
 * is safe in any non-DOM caller as well.
 */

import { useEffect } from "react";

import {
  executeWebMcpTool,
  registerWebMcpTool,
  webMcpToolSnapshot,
  type WebMcpToolEntry,
  type WebMcpToolSnapshot,
} from "./registry";
import { getModelContext, type ModelContextTool } from "./model-context";

/** What the window test seam exposes (installed by {@link bindWebMcpTools}). */
declare global {
  interface Window {
    /**
     * The WebMCP test seam: the registry's serializable snapshot (names,
     * titles, descriptions, JSON Schemas, annotations — no handlers), so
     * tests and e2e can assert registration without the Chrome flag.
     */
    __slopcadWebMcpTools?: () => readonly WebMcpToolSnapshot[];
  }
}

/** Mirror registration attempts since page load (the debug counter). */
let mirrorRegistrationAttempts = 0;

/** Mirror registrations the host API rejected since page load. */
let mirrorRegistrationFailures = 0;

/** The debug counter: mirror health without any console output. */
export function webMcpMirrorDiagnostics(): {
  readonly attempts: number;
  readonly failures: number;
} {
  return {
    attempts: mirrorRegistrationAttempts,
    failures: mirrorRegistrationFailures,
  };
}

/**
 * Mirrors every entry into `document.modelContext`, adapting each to the
 * spec's `ModelContextTool` shape. The JSON Schemas come from the
 * registry's own snapshot (the canonical derived form — never re-derived
 * here), and `execute` routes through {@link executeWebMcpTool} so the
 * agent's raw JSON input is parsed by the SAME schema and the result
 * arrives as the DOMString the spec's `executeTool` returns. One shared
 * `AbortController` carries every registration — aborting it is the spec's
 * unregistration path, which {@link bindWebMcpTools}'s cleanup performs.
 */
function mirrorToolsToModelContext(
  entries: readonly WebMcpToolEntry[],
): AbortController | null {
  const context = getModelContext(
    typeof document === "undefined" ? null : document,
  );
  if (context === null) return null;
  const inputSchemas = new Map(
    webMcpToolSnapshot().map((snapshot) => [snapshot.name, snapshot]),
  );
  const controller = new AbortController();
  for (const entry of entries) {
    const inputSchema = inputSchemas.get(entry.name)?.inputSchema;
    const specTool: ModelContextTool = {
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.annotations === undefined
        ? {}
        : { annotations: entry.annotations }),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      description: entry.description,
      execute: (inputObject, options) =>
        executeWebMcpTool(entry.name, inputObject, options).then((outcome) =>
          outcome.ok ? outcome.result : outcome.message,
        ),
      name: entry.name,
    };
    mirrorRegistrationAttempts += 1;
    context.registerTool(specTool, { signal: controller.signal }).catch(() => {
      mirrorRegistrationFailures += 1;
    });
  }
  return controller;
}

/**
 * Binds one set of tool entries for a host's lifetime: registers every entry
 * in the internal registry (ALWAYS — the source of truth), mirrors them to
 * `document.modelContext` when the API is present, and installs the
 * `window.__slopcadWebMcpTools` test seam once per page. Returns the cleanup
 * that aborts the mirror registration (the spec's unregistration path) and
 * unregisters exactly the entries THIS call registered — through the
 * registrations' ownership handles, so a name another host re-registered
 * in the meantime survives this host's unmount. Browser access is guarded,
 * so the function is safe under SSR and in non-DOM hosts.
 */
export function bindWebMcpTools(
  entries: readonly WebMcpToolEntry[],
): () => void {
  const registrations = entries.map((entry) => registerWebMcpTool(entry));
  const mirrorController =
    typeof document === "undefined" ? null : mirrorToolsToModelContext(entries);
  if (
    typeof window === "object" &&
    window !== null &&
    window.__slopcadWebMcpTools === undefined
  ) {
    window.__slopcadWebMcpTools = () => webMcpToolSnapshot();
  }
  return () => {
    mirrorController?.abort();
    for (const registration of registrations) registration.unregister();
  };
}

/**
 * The React hook: mounts the entries for the component's lifetime. The
 * effect (never run during SSR) binds on mount and unbinds on unmount; the
 * entries identity is the dependency, so hosts pass a stable array (the
 * workbench hook in ./workbench-tools builds its entries exactly once).
 */
export function useWebMcpTools(entries: readonly WebMcpToolEntry[]): void {
  useEffect(() => bindWebMcpTools(entries), [entries]);
}
