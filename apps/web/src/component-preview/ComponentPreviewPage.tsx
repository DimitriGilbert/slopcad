/**
 * The reusable-component preview page (Phase 32): one parametric CAD
 * component rendered live by the real Manifold kernel in the module
 * worker — built through `@slopcad/cad-components`' public surfaces only
 * (the serialized definition, the context kernel, the analytic fixtures)
 * — with its parameter panel wired through the SAME public parameter
 * mechanism the workbench speaks: the component's descriptors become a
 * cad-core parameter collection (`componentParameterCollection`), the
 * `@slopcad/ui` `CadParameterPanel` (a Formedible form) edits it, and an
 * applied edit resolves through the component contract before the worker
 * rebuilds.
 *
 * ## Machine-readable surface (`#component-preview-root`)
 *
 * The session's settle attributes (`data-dispatched`, `data-settled`,
 * `data-in-flight`, `data-current-revision`, `data-applied-revision`,
 * `data-volume`, `data-expected-volume`, `data-error`), the viewport's
 * settle stamp (`data-cad-rendered-volume` from `onSettled`), the current
 * `data-parameter-values`, the resolved `data-ports`, and the per-body
 * `data-bodies` — all deterministic functions of (component, values).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import {
  componentParameterCollection,
  resolveComponentParameters,
  PHASE32_COMPONENTS,
  type CadComponent,
  type ComponentParameterValues,
  type ComponentPortInstance,
} from "@slopcad/cad-components";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import type {
  CadParameterApply,
  CadParameterApplyOutcome,
} from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import {
  bootComponentPreviewSession,
  type ComponentPreviewSession,
  type ComponentPreviewState,
} from "./component-preview-session";

/** The bodies' preview card ids derive from the definition's body ids. */
const BODY_ID_PREFIX = "body_";

function bodyLabel(bodyId: string): string {
  return bodyId.startsWith(BODY_ID_PREFIX)
    ? bodyId.slice(BODY_ID_PREFIX.length)
    : bodyId;
}

/** One port row of the interface table. */
function PortRow({
  port,
}: {
  readonly port: ComponentPortInstance;
}): ReactElement {
  const [x, y, z] = port.position;
  return (
    <tr className="border-border/60 hover:bg-muted/50 border-t transition-colors">
      <td className="py-1.5 pr-2 pl-3 font-mono text-xs">{port.name}</td>
      <td className="text-muted-foreground py-1.5 pr-2 text-xs">{port.kind}</td>
      <td className="text-muted-foreground py-1.5 pr-3 text-right font-mono text-xs whitespace-nowrap">
        {x.toFixed(2)}, {y.toFixed(2)}, {z.toFixed(2)}
        {port.diameter !== undefined ? ` · ⌀${port.diameter.toFixed(1)}` : ""}
      </td>
    </tr>
  );
}

export function ComponentPreviewPage({
  componentId,
}: {
  readonly componentId: string;
}): ReactElement | null {
  const component: CadComponent | undefined = useMemo(
    () => PHASE32_COMPONENTS.find((c) => c.definition.id === componentId),
    [componentId],
  );

  const [values, setValues] = useState<ComponentParameterValues>({});
  const [preview, setPreview] = useState<ComponentPreviewState | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<ComponentPreviewSession | null>(null);

  // The panel's apply surface: resolve the edit through the component's
  // OWN contract (bounds, unknown names) before anything dispatches.
  const onApply = useCallback<CadParameterApply>(
    (parameter, edit) => {
      if (component === undefined || edit.kind !== "value") {
        return {
          ok: false,
          error: {
            code: "component-preview/unsupported-edit",
            message: "The preview edits literal parameter values only.",
          },
        };
      }
      const next: ComponentParameterValues = {
        ...values,
        [parameter.name]: edit.value,
      };
      const resolved = resolveComponentParameters(component.definition, next);
      if (!resolved.ok) {
        return {
          ok: false,
          error: { code: resolved.error.code, message: resolved.error.message },
        } satisfies CadParameterApplyOutcome;
      }
      setValues(next);
      sessionRef.current?.dispatch(component, next);
      return { ok: true };
    },
    [component, values],
  );

  // Boot the worker session with the component's defaults.
  useEffect(() => {
    if (component === undefined) return;
    const defaults = Object.fromEntries(
      component.definition.parameters.map((parameter) => [
        parameter.name,
        parameter.defaultValue,
      ]),
    );
    setValues(defaults);
    setPreview(null);
    const session = bootComponentPreviewSession(
      {
        rootId: "component-preview-root",
        statusId: "component-preview-status",
        volumeId: "component-preview-volume",
        expectedVolumeId: "component-preview-expected-volume",
        boundsId: "component-preview-bounds",
        trianglesId: "component-preview-triangles",
        errorId: "component-preview-error",
      },
      (state) => {
        setPreview(state);
      },
    );
    sessionRef.current = session;
    session.dispatch(component, defaults);
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, [component]);

  const parameters = useMemo(
    () =>
      component === undefined
        ? null
        : componentParameterCollection(component.definition, values),
    [component, values],
  );

  const ports = useMemo(
    () => (component === undefined ? [] : component.ports(values)),
    [component, values],
  );

  const bodiesJson = useMemo(
    () =>
      preview === null
        ? ""
        : JSON.stringify(
            preview.bodies.map((body) => ({
              bodyId: body.bodyId,
              volumeMm3: Number(body.volumeMm3.toFixed(3)),
            })),
          ),
    [preview],
  );

  if (component === undefined) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-16">
        <p className="text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
          Component preview
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Not in the registry
        </h1>
        <p className="text-muted-foreground mt-3 max-w-prose text-sm leading-relaxed">
          No reusable component is registered under{" "}
          <span className="border-border bg-muted/60 rounded-sm border px-1.5 py-0.5 font-mono text-xs">
            {componentId}
          </span>
          . The registry serves three components, each rebuilt live by the real
          kernel with its analytic proof:
        </p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-3">
          {PHASE32_COMPONENTS.map((c) => (
            <li key={c.definition.id}>
              <Link
                className="border-border bg-card/60 hover:border-input hover:bg-muted flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors"
                to="/components/$componentId"
                params={{ componentId: c.definition.id }}
              >
                <span className="text-primary font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
                  {c.definition.id}
                </span>
                <span className="text-sm font-medium">{c.definition.name}</span>
                <span className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                  {c.definition.description}
                </span>
              </Link>
            </li>
          ))}
          <li>
            <Link
              className="border-border bg-card/60 hover:border-input hover:bg-muted flex h-full flex-col gap-2 rounded-lg border p-4 transition-colors"
              to="/components/$componentId"
              params={{ componentId: "agent-chat" }}
            >
              <span className="text-primary font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
                agent-chat-panel
              </span>
              <span className="text-sm font-medium">Agent Chat</span>
              <span className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
                The agent-chat registry item demoed live with a stub transport —
                the shipped panel, not a CAD component.
              </span>
            </Link>
          </li>
        </ul>
      </div>
    );
  }

  const definition = component.definition;
  const siblings = PHASE32_COMPONENTS.filter(
    (c) => c.definition.id !== componentId,
  );

  return (
    <div
      id="component-preview-root"
      className="mx-auto w-full max-w-7xl space-y-5 p-6"
      data-component-id={componentId}
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-expected-volume=""
      data-cad-rendered-volume=""
      data-error=""
      data-rendered-frames={String(renderedFrames)}
      data-parameter-values={JSON.stringify(values)}
      data-ports={JSON.stringify(
        ports.map((port) => ({
          diameter: port.diameter ?? null,
          kind: port.kind,
          name: port.name,
          position: port.position,
        })),
      )}
      data-bodies={bodiesJson}
    >
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
            Reusable parametric CAD components
          </p>
          <p className="border-border text-muted-foreground rounded-sm border bg-card/60 px-1.5 py-0.5 font-mono text-[11px]">
            {definition.id} · v{definition.version}
          </p>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          {definition.name}
        </h1>
        <p className="text-muted-foreground max-w-4xl text-sm leading-relaxed">
          {definition.description}
        </p>
        <nav aria-label="Other components" className="flex flex-wrap gap-2">
          {siblings.map((sibling) => (
            <Link
              key={sibling.definition.id}
              to="/components/$componentId"
              params={{ componentId: sibling.definition.id }}
              className="border-border text-muted-foreground hover:border-input hover:bg-muted hover:text-foreground inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 font-mono text-xs transition-colors"
            >
              {sibling.definition.name}
              <span aria-hidden="true" className="leading-none">
                →
              </span>
            </Link>
          ))}
        </nav>
      </header>

      {/* The build readout, promoted: the spec sheet's signature numbers
          live one line under the identity, not below the fold. The span
          ids are the session writer's targets (unchanged). */}
      <section
        aria-label="Build readouts"
        className="border-border bg-card/60 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 overflow-hidden rounded-lg border px-4 py-2.5 font-mono text-xs"
      >
        <span className="text-muted-foreground">
          status ={" "}
          <span id="component-preview-status" className="text-foreground">
            boot
          </span>
        </span>
        <span className="text-muted-foreground">
          volume ={" "}
          <span id="component-preview-volume" className="text-foreground">
            …
          </span>{" "}
          mm³
        </span>
        <span className="text-muted-foreground">
          analytic ={" "}
          <span
            id="component-preview-expected-volume"
            className="text-foreground"
          >
            …
          </span>{" "}
          mm³
        </span>
        <span className="text-muted-foreground">
          bounds ={" "}
          <span id="component-preview-bounds" className="text-foreground">
            …
          </span>{" "}
          mm
        </span>
        <span className="text-muted-foreground">
          triangles ={" "}
          <span id="component-preview-triangles" className="text-foreground">
            …
          </span>
        </span>
        <span className="text-muted-foreground">
          frames ={" "}
          <span id="component-preview-frames" className="text-foreground">
            {String(renderedFrames)}
          </span>
        </span>
        <span
          data-testid="component-preview-error"
          className="text-destructive"
        >
          <span id="component-preview-error" />
        </span>
      </section>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex w-96 shrink-0 flex-col gap-4">
          {parameters !== null && parameters.ok ? (
            <CadParameterPanel
              className="w-full"
              parameters={parameters.value.parameters}
              onApply={onApply}
              labels={{ submit: "Rebuild" }}
            />
          ) : (
            <section
              aria-label="Component parameters"
              className="border-border bg-card/60 overflow-hidden rounded-lg border"
            >
              <p className="text-destructive p-4 text-sm" role="alert">
                {parameters === null
                  ? "The submitted values no longer resolve against the definition."
                  : parameters.error.message}
              </p>
            </section>
          )}

          <section
            aria-label="Interface"
            className="border-border bg-card/60 overflow-hidden rounded-lg border"
          >
            <h2 className="text-muted-foreground border-border bg-background/40 border-b px-3 py-2 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
              Interface: {String(ports.length)} ports
            </h2>
            <table className="w-full">
              <tbody>
                {ports.map((port) => (
                  <PortRow key={port.name} port={port} />
                ))}
              </tbody>
            </table>
          </section>
        </div>

        {/* The fixed pixel box: part of the determinism contract (the
            camera derives from measured bounds; the viewport runs dpr 1).
            Capped at the viewport's 800px so the caption wraps under it
            instead of inflating the column past the row's width. */}
        <div className="max-w-[800px] space-y-2">
          <div
            id="component-preview-viewport"
            className="border-border/80 bg-background/50 rounded-lg border p-1 shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_4%,transparent),0_1px_2px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
          >
            <div className="overflow-hidden rounded-[6px]">
              <CadViewport
                cameraControls
                className="h-[520px] w-[800px]"
                projection={preview === null ? null : preview.projection}
                regeneration={preview === null ? undefined : 1}
                onSettled={() => {
                  document
                    .getElementById("component-preview-root")
                    ?.setAttribute(
                      "data-cad-rendered-volume",
                      preview === null ? "" : preview.totalVolumeMm3.toFixed(3),
                    );
                  setRenderedFrames((frames) => frames + 1);
                }}
                overlay={
                  <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-2 font-mono text-[11px]">
                    <span className="border-border bg-background/85 rounded-sm border px-2 py-1">
                      {definition.id} ·{" "}
                      {String(preview === null ? 0 : preview.bodies.length)}{" "}
                      {preview !== null && preview.bodies.length === 1
                        ? "body"
                        : "bodies"}
                    </span>
                    {preview !== null && preview.bodies.length > 1 ? (
                      <span className="border-border bg-background/85 rounded-sm border px-2 py-1">
                        {preview.bodies
                          .map(
                            (body) =>
                              `${bodyLabel(body.bodyId)} ${body.volumeMm3.toFixed(0)}mm³`,
                          )
                          .join(" · ")}
                      </span>
                    ) : null}
                  </div>
                }
              />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            Real Manifold kernel in a module worker. The build rides the same
            `solid.*` operation vocabulary as the workbench. Volume is the
            kernel&apos;s divergence-theorem measurement; the analytic value is
            the component&apos;s closed-form fixture at the current parameters.
          </p>
        </div>
      </div>
    </div>
  );
}
