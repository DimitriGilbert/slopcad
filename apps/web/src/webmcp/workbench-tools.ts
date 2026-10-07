/**
 * The workbench's WebMCP tools (Phase 7, the Phase 2.1 capture tool, and the
 * Phase 2.2 getters): the eleven CAD tools the workbench-complete page
 * exposes to browser-resident AI agents through the WebMCP binding. Every
 * handler drives ONLY existing
 * domain paths — the SAME `CadStore` operations the command menu, parameter
 * panel, and history hook use — so an agent action and a user action are
 * one write path:
 *
 * - `cad_get_document_summary` — `store.getDocument()` (the store the
 *   document hook mirrors).
 * - `cad_list_commands` / `cad_run_command` — the page's live command-menu
 *   vocabulary (`CadCommandDescriptor[]`; `run()` is the exact callback a
 *   menu row click fires).
 * - `cad_set_parameter` — `store.applyCommand(setParameterCommand(...))`
 *   for numbers and `store.applyCommand(setParameterExpressionCommand(...))`
 *   for strings, the identical commits `useCadParameters().setValue` /
 *   `setValueFromExpression` issue (numbers in the parameter's own
 *   dimension, strings committed AS defining expressions through the domain
 *   parser — the document re-derives values and refuses cycles).
 * - `cad_undo` / `cad_redo` — `store.undo()` / `store.redo()`, the history
 *   hook's own moves.
 * - `cad_apply_commands` — strict `parseCommand` on every entry, then ONE
 *   atomic `store.applyTransaction({ commands })` (where a cad-jsx-compiled
 *   transaction lands).
 * - `cad_measure` — the engine's applied render state: the settled scene's
 *   kernel-measured volume, area, and bounds, the same source the
 *   Measurement block's readouts render.
 * - `cad_capture_views` — the snapshot exporter's own camera math and
 *   frame settle over the LIVE canvas (D10): one view or several angles in
 *   one call, each returned as a base64 PNG image part; the user's camera
 *   is restored on every exit path, and concurrent executions queue on a
 *   mutex instead of interleaving over the shared camera overlay and
 *   frame ledger.
 * - `cad_get_document` — the compact, model-oriented outline (Phase 2.2):
 *   mode, feature timeline outline, `$`-variables, bodies, selection,
 *   history, and the assembly records, through the shared
 *   `document-outline` builders.
 * - `cad_get_diagnostics` — the structured diagnostics read (D9): the
 *   regeneration issue, the joined per-feature timeline statuses and their
 *   failure diagnostics, the sketch solver's stamps while the sketch
 *   workspace is mounted, and the assembly mate-solve section
 *   (`assembly/mate-*` codes, joint DOF accounting).
 *
 * The entries read LIVE state through accessor functions (the page's engine
 * and command list are re-derived every render); the entries themselves —
 * and their spec registration — are minted once per mount.
 */

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  angle,
  area,
  type AnyDimensionalValue,
  type CadCommand,
  type CadDocument,
  type Dimension,
  dimensionless,
  type FeatureTimelineEntry,
  getParameter,
  length,
  printExpression,
  type ParameterId,
  parseCommand,
  parseExpression,
  type RenderCamera,
  serializeDimensionalValue,
  serializeSelectionReference,
  volume,
} from "@slopcad/cad-core";
import {
  CAD_ORBIT_MAX_ELEVATION_DEG,
  CAD_ORBIT_MIN_ELEVATION_DEG,
  type ViewAngleConvention,
} from "@slopcad/cad-r3f";
import {
  setParameterCommand,
  setParameterExpressionCommand,
  type CadStore,
} from "@slopcad/cad-react";
import type { CadCommandDescriptor } from "@slopcad/ui/components/cad/cad-command-menu";
import type { FixtureRenderState } from "../render-fixture/fixture-session";
import type { WorkbenchEngine } from "../cad-workbench/workbench-engine";
import type { WebMcpToolEntry } from "./registry";

import {
  blobToBase64,
  captureViewCamera,
  captureViewName,
  captureViewportPng,
  ISOMETRIC_SERIES_VIEWS,
  waitForRenderedFrame,
  type CaptureViewRequest,
} from "../cad-workbench/snapshot-export";
import { assemblyDiagnostics, documentOutline } from "./document-outline";
import { defineWebMcpTool } from "./registry";
import { useWebMcpTools } from "./use-webmcp-tools";

/**
 * The narrow live surface the tools drive: the workbench store plus the
 * engine-derived values that are page state (the applied render state and
 * the command vocabulary) and the viewport's capture machinery. Accessors
 * keep the once-minted entries honest.
 */
export interface WorkbenchWebMcpSurface {
  /** The workbench's store — the same `CadStore` the engine runs on. */
  readonly store: CadStore;
  /** The live command-menu vocabulary (what the palette renders). */
  readonly commands: () => readonly CadCommandDescriptor[];
  /** The engine's applied render state, or `null` before the first settle. */
  readonly appliedState: () => FixtureRenderState | null;
  /** The measure tool's last point-pair distance (mm), or `null`. */
  readonly measureText: () => string | null;
  /** The live viewport capture surface `cad_capture_views` drives. */
  readonly capture: WorkbenchCaptureSurface;
  /** The page-level mode (`model` or `sketch`) the document outline reports. */
  readonly mode: () => string;
  /**
   * The engine's joined feature timeline — the timeline chips' own source —
   * or `null` before the first regeneration run.
   */
  readonly timeline: () => readonly FeatureTimelineEntry[] | null;
  /** The engine's last derivation failure, or `null` when the run was clean. */
  readonly regenerationIssue: () => string | null;
  /**
   * The sketch solver's readout while the sketch workspace is mounted, or
   * `null` outside sketch mode (the diagnostics tool reports the same
   * status/dof/diagnostics the sketch status bar does).
   */
  readonly sketchSolve: () => SketchSolveReadout | null;
}

/**
 * The capture surface (D10): the viewport's own user-camera overlay, frame
 * ledger, and canvas — the exact machinery the snapshot-export user
 * commands run, so an agent capture and a user export are one render path.
 */
export interface WorkbenchCaptureSurface {
  /** The frame-ledger root id (the `data-rendered-frames` element). */
  readonly rootId: string;
  /** The engine's rendered-frame count at call time. */
  readonly renderedFrames: () => number;
  /** The user-camera overlay's current camera (restored after a capture). */
  readonly userCamera: () => RenderCamera | null;
  /** Applies a camera through the user-camera overlay (session state). */
  readonly setUserCamera: (camera: RenderCamera | null) => void;
  /** The viewport's live canvas, or `null` when it is not mounted. */
  readonly canvas: () => HTMLCanvasElement | null;
  /** The view session's projection-arrangement convention. */
  readonly convention: () => ViewAngleConvention;
}

/** The structured refusal every handler returns instead of throwing. */
interface ToolRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/**
 * The sketch solver readout `cad_get_diagnostics` reports: the solve loop's
 * own status/DOF plus its structured diagnostics (the same values the sketch
 * status bar renders).
 */
export interface SketchSolveReadout {
  readonly status: string;
  readonly dof: number | null;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly severity: string;
  }[];
}

/**
 * Reads the sketch workspace's solve readout from its own machine stamps —
 * `#sketch-root`'s `data-sketch-solve` and `data-sketch-diagnostics`, the
 * same contract the e2e walks read. `null` when the workspace is not
 * mounted or a stamp is unreadable: a diagnostics read never throws.
 */
function readSketchSolveStamps(): SketchSolveReadout | null {
  const root = document.getElementById("sketch-root");
  if (root === null) return null;
  try {
    const solve = JSON.parse(root.dataset.sketchSolve ?? "null") as {
      readonly diagnostics?: unknown;
      readonly dof?: unknown;
      readonly status?: unknown;
    } | null;
    const diagnostics = JSON.parse(
      root.dataset.sketchDiagnostics ?? "null",
    ) as unknown;
    if (
      solve === null ||
      typeof solve.status !== "string" ||
      (solve.dof !== null && typeof solve.dof !== "number") ||
      !Array.isArray(diagnostics) ||
      !diagnostics.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { readonly code?: unknown }).code === "string" &&
          typeof (entry as { readonly message?: unknown }).message ===
            "string" &&
          typeof (entry as { readonly severity?: unknown }).severity ===
            "string",
      )
    ) {
      return null;
    }
    return {
      diagnostics: diagnostics.map((entry) => {
        const diagnostic = entry as {
          readonly code: string;
          readonly message: string;
          readonly severity: string;
        };
        return {
          code: diagnostic.code,
          message: diagnostic.message,
          severity: diagnostic.severity,
        };
      }),
      dof: solve.dof ?? null,
      status: solve.status,
    };
  } catch {
    return null;
  }
}

/** The refusal code for a command id the live vocabulary does not carry. */
const COMMAND_UNKNOWN = "workbench/command-unknown";

/** The refusal code for a command that exists but cannot run right now. */
const COMMAND_DISABLED = "workbench/command-unavailable";

/** The refusal code for arguments the nullary command vocabulary rejects. */
const COMMAND_ARGS_UNSUPPORTED = "workbench/command-args-unsupported";

/** The refusal code for a parameter id the document does not declare. */
const PARAMETER_UNKNOWN = "workbench/parameter-unknown";

/** The refusal code when the scene has nothing evaluated to measure. */
const MEASURE_NO_SCENE = "workbench/measure-no-settled-scene";

/** The refusal code when the asked-for subject is not what was measured. */
const MEASURE_SUBJECT_MISMATCH = "workbench/measure-subject-mismatch";

/** The refusal code when the scene has nothing settled to capture. */
const CAPTURE_NO_SCENE = "workbench/capture-no-settled-scene";

/** The refusal code when the viewport canvas is not mounted. */
const CAPTURE_NO_VIEWPORT = "workbench/capture-no-viewport";

/** The refusal code when the canvas cannot be encoded as PNG. */
const CAPTURE_FAILED = "workbench/capture-failed";

/** The most views one capture call may request (each is frame-settled). */
const CAPTURE_MAX_VIEWS = 16;

/** A refusal, the one shape handlers never throw. */
function refusal(code: string, message: string): ToolRefusal {
  return { code, message, ok: false };
}

/** Maps the store's structured failures into the tool refusal shape. */
function refusalFromError(error: {
  readonly code: string;
  readonly message: string;
}): ToolRefusal {
  return refusal(error.code, error.message);
}

/**
 * A promise-chain mutex: `run` queues `job` behind every job handed over
 * before it, and a job starts only after the previous one SETTLED —
 * fulfilled or rejected; one job's failure never breaks the queue for the
 * others. The caller still receives each job's own outcome; the tail the
 * chain retains is the settled (never-rejecting) form, so the retained
 * promise stays a plain resolution.
 */
function createMutex(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * The domain's canonical value of `dimension` at `magnitude` — the same
 * switch `CadParameterPanel` applies for literal edits (the panel's helper
 * is module-private; the rule is the dimension's canonical-unit factory).
 */
function canonicalValue(
  dimension: Dimension,
  magnitude: number,
): AnyDimensionalValue {
  switch (dimension) {
    case "length":
      return length(magnitude);
    case "angle":
      return angle(magnitude);
    case "area":
      return area(magnitude);
    case "volume":
      return volume(magnitude);
    case "dimensionless":
      return dimensionless(magnitude);
  }
}

/** The body the settled scene measured, in the readouts' own resolution. */
function sceneBodyIdOf(applied: FixtureRenderState): string | null {
  const bodyId = applied.projection.objects.find(
    (object) => object.bodyId !== undefined,
  )?.bodyId;
  return bodyId === undefined ? null : String(bodyId);
}

/** The bodies the summary tool reports: identity, name, kind, visibility. */
function bodySummaries(document: CadDocument) {
  return document.bodies.map((body) => ({
    id: String(body.id),
    kind: body.kind ?? "solid",
    name: body.name,
    visible: body.visible ?? true,
  }));
}

/**
 * One requested capture view as the tool's schema parses it: every field
 * optional at the type level, with the cross-field rule (a preset XOR both
 * angles) enforced by the schema's refine below.
 */
type CaptureViewInput = z.output<typeof captureViewSchema>;

/**
 * Narrows one schema-parsed view into the camera math's request shape.
 * The schema's refine guarantees exactly one form is present; the guard
 * keeps the narrowing total and honest (a violation turns into the
 * registry's structured tool-failure, never an agent-visible crash).
 */
function captureViewRequestOf(view: CaptureViewInput): CaptureViewRequest {
  if (view.preset !== undefined) {
    return { preset: view.preset };
  }
  if (view.azimuth === undefined || view.elevation === undefined) {
    throw new RangeError(
      "A capture view needs either a preset or BOTH azimuth and elevation.",
    );
  }
  return { azimuth: view.azimuth, elevation: view.elevation };
}

/**
 * One requested capture view: a named preset (`iso` follows the session's
 * angle convention) or an arbitrary azimuth/elevation pair. The angles are
 * degrees in the viewport's own orbit frame — azimuth 0 looks from +X
 * (the right side), −90 from the front; elevation is bounded to the
 * interactive orbit band (±88°) because the poles are the presets' own.
 */
const captureViewSchema = z
  .object({
    preset: z.enum(ISOMETRIC_SERIES_VIEWS).optional(),
    azimuth: z.number().optional(),
    elevation: z
      .number()
      .min(CAD_ORBIT_MIN_ELEVATION_DEG)
      .max(CAD_ORBIT_MAX_ELEVATION_DEG)
      .optional(),
  })
  .superRefine((view, ctx) => {
    const hasPreset = view.preset !== undefined;
    const hasAngles =
      view.azimuth !== undefined || view.elevation !== undefined;
    if (hasPreset && hasAngles) {
      ctx.addIssue({
        code: "custom",
        message:
          "A capture view is either a preset or azimuth+elevation, never both.",
      });
      return;
    }
    if (!hasPreset) {
      if (view.azimuth === undefined || view.elevation === undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            "A capture view needs either a preset or BOTH azimuth and elevation.",
        });
      }
    }
  });

/**
 * One captured view as the tool returns it — a TanStack AI image content
 * part's inline form (`{ name, mimeType, data }`, base64 PNG; the Phase
 * 2.3 bridge wraps these into the loop's image parts verbatim).
 */
interface CapturedViewImage {
  readonly name: string;
  readonly mimeType: "image/png";
  readonly data: string;
}

/**
 * The `cad_capture_views` body: one read-modify-write over the SHARED
 * user-camera overlay and the global frame ledger — snapshot the user's
 * camera, drive the overlay per view, settle each frame, restore. Never
 * reentrant: callers serialize executions through the capture mutex.
 */
async function captureViews(
  surface: WorkbenchWebMcpSurface,
  views: readonly CaptureViewInput[],
): Promise<
  | { readonly images: readonly CapturedViewImage[]; readonly ok: true }
  | ToolRefusal
> {
  const applied = surface.appliedState();
  if (applied === null) {
    return refusal(
      CAPTURE_NO_SCENE,
      "The scene has not settled yet; there is no evaluated model to capture.",
    );
  }
  const capture = surface.capture;
  const requests = views.map(captureViewRequestOf);
  const bounds = applied.measurement.bounds;
  const convention = capture.convention();
  const framesAtStart = capture.renderedFrames();
  const previousCamera = capture.userCamera();
  const images: CapturedViewImage[] = [];
  // The highest frame count the ledger actually reported: the restore's
  // settle waits one frame past RENDERED evidence, never past the
  // requested count — an early refusal (unmounted canvas, failed encode)
  // leaves the unvisited views' targets unreachable, and waiting on one
  // would burn the settle's full timeout on frames that can never exist.
  let settledFrames = framesAtStart;
  try {
    for (const [index, request] of requests.entries()) {
      capture.setUserCamera(captureViewCamera(request, { bounds, convention }));
      settledFrames = Math.max(
        settledFrames,
        await waitForRenderedFrame(capture.rootId, framesAtStart + index + 1),
      );
      const canvas = capture.canvas();
      if (canvas === null) {
        return refusal(
          CAPTURE_NO_VIEWPORT,
          "The viewport canvas is not mounted; nothing can be captured.",
        );
      }
      const blob = await captureViewportPng(canvas);
      if (blob === null) {
        return refusal(
          CAPTURE_FAILED,
          `views[${String(index)}]: the canvas could not be encoded as PNG.`,
        );
      }
      images.push({
        data: await blobToBase64(blob),
        mimeType: "image/png",
        name: captureViewName(request),
      });
    }
  } finally {
    // The user's camera comes back on EVERY exit path — success, refusal,
    // throw — and the restored view settles one frame past what actually
    // rendered before the tool returns, so the viewport the user sees is
    // theirs again.
    capture.setUserCamera(previousCamera);
    await waitForRenderedFrame(capture.rootId, settledFrames + 1);
  }
  return { images, ok: true };
}

/**
 * Builds the eleven workbench tool entries from one live surface. Called
 * once per mount (the entries read through the surface's accessors, so
 * once-minted entries stay current); the command-id enum is derived from
 * the SAME command list the handlers check live — the mount-time
 * vocabulary, which is stable for a page's lifetime (tool registry and IO
 * presence are fixed at mount; only the disabled flags move).
 */
export function createWorkbenchWebMcpTools(
  surface: WorkbenchWebMcpSurface,
): readonly WebMcpToolEntry[] {
  const commandIds = [...new Set(surface.commands().map((c) => c.id))];
  const commandIdSchema =
    commandIds.length === 0
      ? z.string().describe("the live command id (see cad_list_commands)")
      : z
          .enum(commandIds)
          .describe("one of the command-menu ids (see cad_list_commands)");
  // Concurrent capture executions are reachable: the AI client starts
  // every client-tool execution as an unawaited promise (two calls in one
  // assistant message run at once), and the bridge, the registry
  // executor, and the spec mirror all land on this one entry. The capture
  // body is a read-modify-write over the SHARED camera overlay and the
  // global frame ledger, so every execution queues on one mount-scoped
  // mutex instead of interleaving.
  const serializeCaptures = createMutex();

  return [
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        "Summarize the open CAD document: body, feature, and parameter counts, the feature kinds in the timeline, and every body and parameter record (ids, names, values in canonical units).",
      inputSchema: z.object({}),
      name: "cad_get_document_summary",
      execute: () => {
        const document = surface.store.getDocument();
        return {
          bodies: bodySummaries(document),
          counts: {
            bodies: document.bodies.length,
            features: document.features.length,
            parameters: document.parameters.parameters.length,
          },
          documentId: String(document.id),
          featureKinds: [...new Set(document.features.map((f) => f.kind))],
          ok: true,
          parameters: document.parameters.parameters.map((parameter) => ({
            id: String(parameter.id),
            name: parameter.name,
            value: serializeDimensionalValue(parameter.value),
          })),
        };
      },
    }),
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        "List the workbench command-menu vocabulary: every command id, label, group, and search keywords, with each command's current availability. This is the exact list the Ctrl/Cmd+K palette renders.",
      inputSchema: z.object({}),
      name: "cad_list_commands",
      execute: () => ({
        commands: surface.commands().map((command) => ({
          available: !(command.disabled ?? false),
          group: command.group,
          id: command.id,
          keywords: command.keywords ?? null,
          label: command.label,
        })),
        ok: true,
      }),
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Run one workbench command-menu command by id — the same dispatch a palette row click fires. Every command in the vocabulary is nullary: `args` must be omitted or empty.",
      inputSchema: z.object({
        args: z.record(z.string(), z.unknown()).optional(),
        commandId: commandIdSchema,
      }),
      name: "cad_run_command",
      execute: (input) => {
        if (input.args !== undefined && Object.keys(input.args).length > 0) {
          return refusal(
            COMMAND_ARGS_UNSUPPORTED,
            "The workbench command vocabulary is nullary; no command accepts arguments.",
          );
        }
        const command = surface
          .commands()
          .find((entry) => entry.id === input.commandId);
        if (command === undefined) {
          return refusal(
            COMMAND_UNKNOWN,
            `No command "${input.commandId}" in the current vocabulary (see cad_list_commands).`,
          );
        }
        if (command.disabled ?? false) {
          return refusal(
            COMMAND_DISABLED,
            `Command "${command.id}" (${command.label}) is disabled in the current document state.`,
          );
        }
        command.run();
        return { ok: true, ran: command.id };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Set one document parameter by id. A number commits the stored value in the parameter's own dimension at its canonical unit (a length parameter takes millimetres); any defining expression stays in place and keeps driving the parameter. A string is parsed as an expression and committed AS the parameter's defining expression — the document re-derives the parameter's value and its dependents, refusing unknown identifiers and reference cycles with structured errors. The same `parameter.set` commits the parameter panel issues.",
      inputSchema: z.object({
        id: z
          .string()
          .describe("the parameter id (see cad_get_document_summary)"),
        value: z.union([z.number(), z.string()]),
      }),
      name: "cad_set_parameter",
      execute: (input) => {
        const store = surface.store;
        const collection = store.getParameters();
        const parameter = getParameter(collection, input.id as ParameterId);
        if (parameter === undefined) {
          return refusal(
            PARAMETER_UNKNOWN,
            `No parameter "${input.id}" in the document (see cad_get_document_summary).`,
          );
        }
        let command: CadCommand;
        if (typeof input.value === "number") {
          command = setParameterCommand(
            input.id as ParameterId,
            canonicalValue(parameter.value.dimension, input.value),
          );
        } else {
          const parsed = parseExpression(input.value);
          if (!parsed.ok) return refusalFromError(parsed.error);
          // The expression ITSELF is committed (the serialized AST): the
          // document's interpreter validates it against the live collection
          // and recomputes the parameter and its dependents.
          command = setParameterExpressionCommand(
            input.id as ParameterId,
            parsed.value,
          );
        }
        const applied = store.applyCommand(command);
        if (!applied.ok) {
          return refusalFromError(applied.error.cause ?? applied.error);
        }
        const stored = getParameter(
          store.getParameters(),
          input.id as ParameterId,
        );
        return {
          name: parameter.name,
          ok: true,
          parameterId: input.id,
          ...(stored === undefined
            ? {}
            : {
                value: serializeDimensionalValue(stored.value),
                ...(stored.expression === null
                  ? {}
                  : { expression: printExpression(stored.expression) }),
              }),
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Move the workbench history back one commit (the history hook's own undo). Refused structurally when there is nothing to undo.",
      inputSchema: z.object({}),
      name: "cad_undo",
      execute: () => historyMove(surface.store, "undo"),
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Move the workbench history forward one commit (the history hook's own redo). Refused structurally when there is nothing to redo.",
      inputSchema: z.object({}),
      name: "cad_redo",
      execute: () => historyMove(surface.store, "redo"),
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Apply a batch of serialized CAD commands as ONE atomic transaction. Every entry is strictly parsed by the domain's `parseCommand` first — one malformed entry applies nothing. This is the path a compiled @slopcad/cad-jsx model enters the document through.",
      inputSchema: z.object({
        commands: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe(
            "serialized CAD commands (canonical JSON, discriminated by type)",
          ),
      }),
      name: "cad_apply_commands",
      execute: (input) => {
        const parsed: CadCommand[] = [];
        for (const [index, raw] of input.commands.entries()) {
          const result = parseCommand(raw);
          if (!result.ok) {
            return refusal(
              result.error.code,
              `commands[${String(index)}]: ${result.error.message}`,
            );
          }
          parsed.push(result.value);
        }
        const applied = surface.store.applyTransaction({ commands: parsed });
        if (!applied.ok) return refusalFromError(applied.error);
        return { applied: parsed.length, ok: true };
      },
    }),
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        "Read the settled scene's kernel measurements: volume, surface area, axis-aligned bounds (all mm/mm²/mm³), and triangle count — the same evaluated state the Measurement block renders. Optionally scope to one feature or body id; the scene answers for exactly the body it measured, so an unmeasured subject is refused honestly.",
      inputSchema: z.object({
        featureOrBodyId: z
          .string()
          .optional()
          .describe("a body id, or a feature id whose output to measure"),
      }),
      name: "cad_measure",
      execute: (input) => {
        const applied = surface.appliedState();
        if (applied === null) {
          return refusal(
            MEASURE_NO_SCENE,
            "The scene has not settled yet; there is no evaluated measurement to read.",
          );
        }
        const sceneBodyId = sceneBodyIdOf(applied);
        if (input.featureOrBodyId !== undefined) {
          const matchesSceneBody =
            sceneBodyId !== null && sceneBodyId === input.featureOrBodyId;
          const feature = surface.store
            .getDocument()
            .features.find(
              (entry) => String(entry.id) === input.featureOrBodyId,
            );
          const featureOwnsSceneBody =
            feature !== undefined &&
            sceneBodyId !== null &&
            feature.outputs.some((output) => String(output) === sceneBodyId);
          if (!matchesSceneBody && !featureOwnsSceneBody) {
            return refusal(
              MEASURE_SUBJECT_MISMATCH,
              `The settled scene measured body ${sceneBodyId ?? "(none)"}; "${input.featureOrBodyId}" is not that body or a feature producing it.`,
            );
          }
        }
        return {
          areaMm2: applied.measurement.area,
          bodyId: sceneBodyId,
          boundsMm: applied.measurement.bounds,
          lastMeasureDistanceMm: surface.measureText(),
          ok: true,
          triangles: applied.measurement.triangles,
          volumeMm3: applied.measurement.volume,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        'Capture PNG images of the current model from one or more views — one view is the common case; several angles may be requested in a single call (bounded to 16). Each view is either a named preset ("front" | "top" | "right" | "iso"; iso follows the session\'s angle convention) or an arbitrary azimuth/elevation pair in degrees (azimuth 0 looks from +X, -90 from the front; elevation stays inside the ±88° orbit band). The camera is applied through the user-camera overlay, the frame settles, the LIVE canvas is captured, and the user\'s camera is restored — the exact machinery the snapshot-export commands run. Returns one image part per requested view: { name, mimeType: "image/png", data } with data as base64. No width/height parameters: the live viewport\'s size is used (custom-size/offscreen renders are not supported).',
      inputSchema: z.object({
        views: z
          .array(captureViewSchema)
          .min(1)
          .max(CAPTURE_MAX_VIEWS)
          .describe("the views to capture, in order"),
      }),
      name: "cad_capture_views",
      // Serialized: the handler queues behind any in-flight capture (see
      // the mutex above) — queued runs read the ledger only after the
      // previous run's restore settled, so captures never interleave and
      // can never mislabel another run's camera as their own.
      execute: (input) =>
        serializeCaptures(() => captureViews(surface, input.views)),
    }),
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        "Read a compact, model-oriented outline of the open CAD document and workbench state, sized for a context budget (outline shapes, never full geometry): the workbench mode, the feature timeline outline (ids, kinds, joined statuses), every $-variable's name/value/expression, the bodies, the current selection, the history cursor, and the document's assembly occurrence/mate/joint records. A fuller read than cad_get_document_summary (which stays the cheap counts-first probe).",
      inputSchema: z.object({}),
      name: "cad_get_document",
      execute: () => {
        const store = surface.store;
        const document = store.getDocument();
        const timeline = surface.timeline();
        const statusOf = new Map(
          (timeline ?? []).map((entry) => [String(entry.id), entry.status]),
        );
        const outline = documentOutline(
          document,
          (feature) => statusOf.get(String(feature.id)) ?? null,
        );
        const history = store.getHistoryView();
        const selection = store.getSelection();
        return {
          ...outline,
          history: {
            canRedo: history.canRedo,
            canUndo: history.canUndo,
            cursor: history.cursor,
            depth: history.depth,
          },
          mode: surface.mode(),
          ok: true,
          selection: {
            hover:
              selection.hover === null
                ? null
                : serializeSelectionReference(selection.hover),
            selected: selection.selected.map(serializeSelectionReference),
          },
        };
      },
    }),
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        "Read the workbench's structured diagnostics (the LSP-shaped error contract): the last regeneration failure, every feature's joined timeline status with its failure diagnostics (severity/code/message — the timeline chips' own source), the sketch solver's status/DOF/diagnostics while the sketch workspace is mounted, and the assembly section (mate-solve status with assembly/mate-* diagnostics, joint DOF accounting).",
      inputSchema: z.object({}),
      name: "cad_get_diagnostics",
      execute: () => {
        const assembly = assemblyDiagnostics(surface.store.getDocument());
        if (!assembly.ok) return refusal(assembly.code, assembly.message);
        return {
          assembly,
          ok: true,
          regeneration: {
            features: (surface.timeline() ?? []).map((entry) => ({
              diagnostics: entry.diagnostics.map((diagnostic) => ({
                code: diagnostic.code,
                message: diagnostic.message,
                severity: diagnostic.severity,
              })),
              id: String(entry.id),
              kind: entry.kind,
              status: entry.status,
            })),
            issue: surface.regenerationIssue(),
          },
          sketch: surface.sketchSolve(),
        };
      },
    }),
  ];
}

/** The undo/redo move shared shape: the store's own history operation. */
function historyMove(store: CadStore, move: "undo" | "redo") {
  const moved = move === "undo" ? store.undo() : store.redo();
  if (!moved.ok) return refusalFromError(moved.error);
  const view = store.getHistoryView();
  return {
    canRedo: view.canRedo,
    canUndo: view.canUndo,
    cursor: view.cursor,
    depth: view.depth,
    ok: true,
  };
}

/**
 * The workbench mount: registers the workbench tool set for the page's
 * lifetime, reading the LIVE engine, command vocabulary, and viewport
 * capture surface. One call from the workbench-complete composition — no
 * restructuring, no extra surfaces. Returns the minted entries so the
 * page can hand the SAME binding (entries + the registry executor) to
 * the agent chat's tools surface — one tool set, two consumers.
 */
export function useWorkbenchWebMcpTools({
  capture,
  commands,
  engine,
}: {
  readonly capture: WorkbenchCaptureSurface;
  readonly commands: readonly CadCommandDescriptor[];
  readonly engine: WorkbenchEngine;
}): readonly WebMcpToolEntry[] {
  // The latest engine + vocabulary + capture surface: handlers read
  // through this ref because the entries (and their spec registration)
  // are minted once per mount. `rootId` is read at mint — every caller's
  // frame-ledger root is fixed for the page's lifetime.
  const live = useRef({ capture, commands, engine });
  useEffect(() => {
    live.current = { capture, commands, engine };
  });
  const [entries] = useState(() =>
    createWorkbenchWebMcpTools({
      appliedState: () => live.current.engine.applied?.state ?? null,
      capture: {
        canvas: () => live.current.capture.canvas(),
        convention: () => live.current.capture.convention(),
        renderedFrames: () => live.current.capture.renderedFrames(),
        rootId: capture.rootId,
        setUserCamera: (camera) => {
          live.current.capture.setUserCamera(camera);
        },
        userCamera: () => live.current.capture.userCamera(),
      },
      commands: () => live.current.commands,
      measureText: () => live.current.engine.measureText,
      mode: () => live.current.engine.mode,
      regenerationIssue: () => live.current.engine.regenerationIssue,
      sketchSolve: readSketchSolveStamps,
      store: engine.store,
      timeline: () => live.current.engine.timeline,
    }),
  );
  useWebMcpTools(entries);
  return entries;
}
