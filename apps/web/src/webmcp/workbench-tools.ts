/**
 * The workbench's WebMCP tools (Phase 7): the eight CAD tools the
 * workbench-complete page exposes to browser-resident AI agents through the
 * WebMCP binding. Every handler drives ONLY existing domain paths — the
 * SAME `CadStore` operations the command menu, parameter panel, and history
 * hook use — so an agent action and a user action are one write path:
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
  getParameter,
  length,
  printExpression,
  type ParameterId,
  parseCommand,
  parseExpression,
  serializeDimensionalValue,
  volume,
} from "@slopcad/cad-core";
import {
  setParameterCommand,
  setParameterExpressionCommand,
  type CadStore,
} from "@slopcad/cad-react";
import type { CadCommandDescriptor } from "@slopcad/ui/components/cad/cad-command-menu";
import type { FixtureRenderState } from "../render-fixture/fixture-session";
import type { WorkbenchEngine } from "../cad-workbench/workbench-engine";
import type { WebMcpToolEntry } from "./registry";

import { defineWebMcpTool } from "./registry";
import { useWebMcpTools } from "./use-webmcp-tools";

/**
 * The narrow live surface the tools drive: the workbench store plus the two
 * engine-derived values that are page state (the applied render state and
 * the command vocabulary). Accessors keep the once-minted entries honest.
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
}

/** The structured refusal every handler returns instead of throwing. */
interface ToolRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
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
 * Builds the eight workbench tool entries from one live surface. Called
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
 * The workbench mount: registers the eight tools for the page's lifetime,
 * reading the LIVE engine and command vocabulary. One call from the
 * workbench-complete composition — no restructuring, no extra surfaces.
 */
export function useWorkbenchWebMcpTools({
  commands,
  engine,
}: {
  readonly commands: readonly CadCommandDescriptor[];
  readonly engine: WorkbenchEngine;
}): void {
  // The latest engine + vocabulary: handlers read through this ref because
  // the entries (and their spec registration) are minted once per mount.
  const live = useRef({ commands, engine });
  useEffect(() => {
    live.current = { commands, engine };
  });
  const [entries] = useState(() =>
    createWorkbenchWebMcpTools({
      appliedState: () => live.current.engine.applied?.state ?? null,
      commands: () => live.current.commands,
      measureText: () => live.current.engine.measureText,
      store: engine.store,
    }),
  );
  useWebMcpTools(entries);
}
