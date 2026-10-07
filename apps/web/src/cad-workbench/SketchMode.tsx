/**
 * The workbench's sketch mode (Phase 25): the browser sketch editor built
 * from the `@slopcad/ui` sketch components — `CadSketchToolbar` (drawing and
 * constraint tools), `CadSketchCanvas` (the deterministic 2D workplane
 * surface), and `CadSketchInspector` (solver readout, constraint list,
 * dimension editor) — around a real sketch session.
 *
 * ## Composition wiring (the same canonicality rule as the model mode)
 *
 * The sketch DOMAIN is canonical; React mirrors it. The session (sketch +
 * snapshot history) and the editor state are the two immutable values this
 * component threads; every read renders from them, every mutation is a
 * domain operation — editor events go through the pure
 * `sketchEditorReducer`, and the returned transaction is the ONLY write
 * path: an atomic `applySketchSessionTransaction` commit that advances the
 * sketch and the history together (or surfaces the structured refusal in
 * the status line, changing nothing). The command log records the canonical
 * serialization of every committed command, in issue order.
 *
 * ## The solve loop (the Phase 20 discipline, mirrored)
 *
 * Every authored-sketch change runs one reference-solver pass. A solved or
 * under-constrained result applies its parameters (`applySolvedParameters`)
 * and becomes the displayed geometry, with the remaining degrees of freedom
 * surfaced in the inspector and status bar; a failed solve KEEPS the last
 * successful geometry on display (last-known-good), reports its structured
 * diagnostics in the inspector and per-entity badges, and never corrupts
 * the session — the authored sketch and its history describe exactly what
 * was drawn, so undo/redo re-derive honestly.
 *
 * ## Machine surfaces (`data-*` on the root)
 *
 * `data-sketch-tool`, `data-sketch-tool-status`, `data-sketch-selection`,
 * `data-sketch-entities`, `data-sketch-constraints`, `data-sketch-solved`,
 * `data-sketch-solve`, `data-sketch-diagnostics`, `data-sketch-commands`
 * (the serialized command log), `data-sketch-history`, `data-sketch-gesture`,
 * and `data-sketch-workplane` (the session's boot workplane — the
 * sketch-on-face regression pin) — everything the Playwright battery asserts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import {
  angle,
  angle as angleValue,
  createReferenceId,
  findParameterByName,
  length,
  length as lengthValue,
  mintTopologyReference,
  valueIn,
  type BodyId,
  type ParameterCollection,
  type TopologyView,
} from "@slopcad/cad-core";
import {
  analyzeConstrainedness,
  applySolvedParameters,
  boundDimensionParameterId,
  circularArrayCommands,
  convertTopologyEntities,
  createSketchEntityId,
  applySketchSessionTransaction,
  canRedoSketch,
  canUndoSketch,
  createPolygonEntity,
  createReferenceSketchSolver,
  createSketchSession,
  createStraightSlotEntity,
  entityPolyline,
  isDimensionalConstraint,
  rectangularArrayCommands,
  redoSketchSession,
  resolveExtrudeProfile,
  resolveSketchDimensionBindings,
  serializeDimensionPresentation,
  serializeSketch,
  serializeSketchCommand,
  undoSketchSession,
  workplaneToPlacement,
  type SketchCommand,
  type SketchConstrainedness,
  type SketchConstraint,
  type SketchDiagnostic,
  type SketchEntity,
  type SketchParameterLookup,
  type SerializedSketch,
  type SerializedSketchCommand,
  type Workplane,
} from "@slopcad/cad-sketch";
import type { ProfileExtrudeInput } from "@slopcad/cad-kernel";
import { importDxf } from "@slopcad/cad-io/dxf-import";
import { importSvg } from "@slopcad/cad-io/svg-import";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import {
  expressionNumberTokenName,
  expressionNumberTokenNegated,
} from "@slopcad/ui/components/formedible/fields/expression-number-field";
import {
  CadSketchCanvas,
  type CadSketchCanvasPreview,
  type CadSketchPoint,
} from "@slopcad/ui/components/cad/cad-sketch-canvas";
import {
  CadSketchInspector,
  type CadSketchInspectorConstraint,
  type CadSketchInspectorDimension,
} from "@slopcad/ui/components/cad/cad-sketch-inspector";
import { CadSketchToolbar } from "@slopcad/ui/components/cad/cad-sketch-toolbar";
// Type-only: the host commit outcome rides the extrude action's return
// (erased at runtime — no cycle with the engine's own SketchMode import).
import type { FeatureFormOutcome } from "./workbench-engine";

import { kernelSegment } from "./extrude";
import {
  constraintLabel,
  constraintOperandIds,
  createSketchEditorState,
  createWorkbenchSketch,
  isSketchToolId,
  pointTargetPosition,
  POLYGON_TOOL_SIDES,
  SKETCH_CANVAS,
  SKETCH_CONSTRAINT_TOOLS,
  SKETCH_DRAWING_TOOLS,
  SKETCH_EDIT_TOOLS,
  sketchEditorReducer,
  sketchSurface,
  sketchViewModel,
  SKETCH_EDITOR_STATUS_TEXT,
  type SketchEditorEvent,
  type SketchEditorState,
} from "./sketch-editor";
import {
  resolveRevolveSubmission,
  REVOLVE_AXIS_X_RAD,
  REVOLVE_AXIS_Y_RAD,
  type SketchRevolveSubmission,
} from "./revolve";

/** The solve loop's derived state (last-known-good geometry included). */
interface SketchSolveState {
  readonly status: "solved" | "under-constrained" | "failed";
  /** Degrees of freedom; `null` when the solve failed. */
  readonly dof: number | null;
  /**
   * The last successfully solved sketch with the AUTHORED constraints —
   * bindings included — over solved entity values. This is the commit
   * source (extrude/revolve/save): a serialized sketch must keep its
   * parameter bindings so the document re-drives it as parameters change.
   */
  readonly solved: ReturnType<typeof applySolvedParameters> | null;
  /**
   * The same solved geometry over the RESOLVED constraint copies (bindings
   * stripped to their current literal values) — the DISPLAY sketch: the
   * canvas readouts present the live resolved quantities. `null` when
   * nothing is bound (it is then just `solved`).
   */
  readonly resolvedDisplay: ReturnType<typeof applySolvedParameters> | null;
  readonly diagnostics: readonly SketchDiagnostic[];
  /** Per-entity constrainedness (Phase 37's ink convention). */
  readonly constrainedness: SketchConstrainedness | null;
}

const SOLVER = createReferenceSketchSolver();

const TOOLBAR_GROUPS = [
  { id: "tools", label: "Tools", toolIds: SKETCH_DRAWING_TOOLS },
  { id: "edit", label: "Edit", toolIds: SKETCH_EDIT_TOOLS },
  { id: "constraints", label: "Constraints", toolIds: SKETCH_CONSTRAINT_TOOLS },
];

/**
 * The topology surface the convert tool consumes (Phase 37): the resolving
 * kernel's view plus the bodies the host owns — the snapshots SketchMode
 * lists in the inspector's convert section.
 */
export interface SketchModeTopology {
  readonly view: TopologyView;
  readonly bodies: readonly BodyId[];
}

/** The resolved extrusion the action hands to the host. */
export interface SketchExtrudeSubmission {
  /** The canonical serialized sketch (stored as the document sketch record). */
  readonly sketch: SerializedSketch;
  /** The resolved profile loop in kernel-contract form. */
  readonly loop: ProfileExtrudeInput["loop"];
  /** The workplane placement in kernel-contract form. */
  readonly placement: ProfileExtrudeInput["placement"];
}

/** Props of {@link SketchMode}. */
export interface SketchModeProps {
  /** Exits sketch mode (the host's mode switch, e.g. back to the model). */
  readonly onExit: () => void;
  /**
   * The Phase 26.1 extrude action: the host commits the sketch as a
   * document record, creates the extrude feature, and dispatches the real
   * kernel execution to the worker. Called only with a RESOLVED profile;
   * resolution failures stay here as structured statuses. A host may
   * return the commit's structured outcome — a refusal overwrites the
   * provisional "resolved" stamp on the machine's extrude outcome (never a
   * swallowed verdict beside a silently unchanged document); void-returning
   * hosts keep the pre-outcome behavior.
   */
  readonly onExtrude: (
    submission: SketchExtrudeSubmission,
  ) => FeatureFormOutcome | void;
  /**
   * Keeps the extrude action from committing: a host whose document
   * composition ONE more extrude would invalidate (the chain workbench —
   * the chain scene request composes one extrude as the base) passes
   * `true`, so the button states that instead of committing a transaction
   * the scene can no longer resolve. Optional: a host whose document
   * accepts any number of extrudes (the established workbench) omits it
   * and the action stays unguarded, exactly as before.
   */
  readonly extrudeDisabled?: boolean;
  /** The guarded action's explanation, shown as the disabled button's title. */
  readonly extrudeDisabledTitle?: string;
  /**
   * The Phase 26.2 revolve action: the host commits the sketch as a
   * document record, creates the sweep and axis parameters plus the revolve
   * feature, and dispatches the real kernel execution to the worker. Called
   * only with a RESOLVED, axis-valid profile; failures stay here. Optional:
   * a host whose document vocabulary carries no revolve (the Phase 26
   * chain workbench) omits it, and the revolve controls stay hidden instead
   * of dead.
   */
  readonly onRevolve?: (submission: SketchRevolveSubmission) => void;
  /**
   * The Phase 37 convert source: the persistent-topology view of the
   * host's bodies, when the host has one. Without it the convert tool
   * surfaces its honest decline (`sketch-convert/view-missing`) — a host
   * whose kernel carries no persistent topology never pretends to convert.
   */
  readonly topology?: SketchModeTopology;
  /**
   * The Phase 38 save-sketch action: commits the CURRENT sketch as a
   * STANDALONE document sketch record (no feature) — the sketch pool the
   * workbench's sweep and loft forms pick from. Optional: a host whose
   * vocabulary needs no standalone sketches omits it and the control stays
   * hidden instead of dead.
   */
  readonly onSaveSketch?: (submission: {
    readonly sketch: SerializedSketch;
  }) => void;
  /**
   * The Phase 39 boot workplane: a face-derived datum plane the session
   * starts on (sketch-on-face). `undefined` boots the ordinary XY workplane.
   * Boot-time configuration — a remount starts a new session, so the host
   * re-mounts SketchMode when the anchor changes.
   */
  readonly bootWorkplane?: Workplane;
  /**
   * The Phase 56 sketch-exchange control: the host exposes the DXF/SVG
   * file-import entry in the sketch command row. Optional: a host that
   * carries no exchange control omits it and the command row renders
   * EXACTLY its pre-exchange children — the plain workbench's resting
   * layout is frozen by the byte-stable canvas battery (the workspace
   * scroll math moves with any row-width change).
   */
  readonly importSketchFiles?: boolean;
  /**
   * The document's parameter collection (Phase 26a): the environment
   * bound dimensions resolve against and the vocabulary the inspector's
   * dimension field offers as `$name` tokens. Optional: a host without a
   * parameter vocabulary omits it — its sketches stay literal-only (the
   * inspector keeps the plain number field) and nothing else changes.
   */
  readonly parameters?: ParameterCollection;
}

/** The default extrusion depth the action creates the parameter with (mm). */
export const EXTRUDE_DEFAULT_DEPTH_MM = 10;

/** The machine-surface outcome of the last extrude attempt. */
export interface SketchExtrudeOutcome {
  readonly status: "resolved" | "failed";
  readonly code?: string;
  readonly message?: string;
}

/** The machine-surface outcome of the last revolve attempt. */
export interface SketchRevolveOutcome {
  readonly status: "resolved" | "failed";
  readonly code?: string;
  readonly message?: string;
}

/**
 * The Phase 56 sketch-exchange import's machine surface: the outcome of one
 * DXF/SVG file import into the active sketch — entities committed as one
 * undoable transaction, out-of-subset declines recorded (never silently
 * dropped), parse failures surfaced with their adapter's stable code.
 */
export interface SketchImportOutcome {
  readonly status: "imported" | "declined" | "failed";
  /** The adapter's structured failure/decline code, when one exists. */
  readonly code?: string;
  /** The human-readable summary (the status line's text). */
  readonly message: string;
  /** The exchange that produced this outcome. */
  readonly source?: "dxf" | "svg";
  /** How many entities the committed transaction added. */
  readonly imported?: number;
  /** How many file elements the pinned subset declined. */
  readonly declined?: number;
}

/** The revolve axis the selector pins: a workplane axis (X or Y). */
export type RevolveAxisId = "x" | "y";

/**
 * Whether the keyboard event was raised from an editable surface — a text
 * input, a textarea, a `role="textbox"` element, or anything contenteditable
 * — resolved through the composed path so shadow-rooted fields count too.
 * The inspector's fields render inside the sketch root, and a Delete or
 * Backspace typed into one of them must keep its native text-editing meaning
 * instead of riding the root's delete-selection shortcut.
 */
const isEditableKeyboardOrigin = (
  event: ReactKeyboardEvent<HTMLDivElement>,
): boolean => {
  for (const node of event.nativeEvent.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement
    ) {
      return true;
    }
    if (node instanceof HTMLElement && node.isContentEditable) return true;
    if (node.getAttribute("role") === "textbox") return true;
  }
  return false;
};

/** The full sketch workspace: toolbar, canvas, inspector, status line. */
export function SketchMode({
  onExit,
  onExtrude,
  onRevolve,
  extrudeDisabled = false,
  extrudeDisabledTitle,
  topology,
  onSaveSketch,
  bootWorkplane,
  importSketchFiles = false,
  parameters,
}: SketchModeProps): ReactElement {
  const [session, setSession] = useState(() =>
    createSketchSession(createWorkbenchSketch(bootWorkplane)),
  );
  const [editor, setEditor] = useState<SketchEditorState>(
    createSketchEditorState,
  );
  const [solveState, setSolveState] = useState<SketchSolveState>({
    status: "solved",
    dof: 0,
    solved: null,
    resolvedDisplay: null,
    diagnostics: [],
    constrainedness: null,
  });
  const [commandLog, setCommandLog] = useState<
    readonly SerializedSketchCommand[]
  >([]);
  const [pointer, setPointer] = useState<CadSketchPoint | null>(null);
  // The Phase 26.1 extrude action's machine surface (the last attempt).
  const [extrudeOutcome, setExtrudeOutcome] =
    useState<SketchExtrudeOutcome | null>(null);
  // The Phase 26.2 revolve action: the pinned axis (a workplane axis) and
  // the last attempt's machine surface.
  const [revolveAxis, setRevolveAxis] = useState<RevolveAxisId>("x");
  const [revolveOutcome, setRevolveOutcome] =
    useState<SketchRevolveOutcome | null>(null);
  // The Phase 37 convert attempt's machine surface (the last outcome set).
  const [convertOutcome, setConvertOutcome] = useState<string | null>(null);
  // The Phase 56 sketch-exchange import's machine surface: the last DXF/SVG
  // file import into this session's sketch.
  const [sketchImport, setSketchImport] = useState<SketchImportOutcome | null>(
    null,
  );

  // The displayed sketch: the authored sketch with the drag's provisional
  // geometry overlaid — the value the solve loop re-solves per move.
  const displaySketch = useMemo(() => {
    const provisional = editor.provisional;
    if (provisional === null) return session.sketch;
    return {
      ...session.sketch,
      entities: session.sketch.entities.map((entity) =>
        entity.id === provisional.id ? provisional : entity,
      ),
    };
  }, [editor.provisional, session.sketch]);

  // The parameter environment bound dimensions resolve against: a stable
  // per-collection lookup (the document's parameter collection is an
  // immutable value, so identity changes exactly when a parameter does).
  // A host without parameters contributes an empty environment — its
  // sketches cannot carry bindings anyway.
  const parameterLookup = useMemo<SketchParameterLookup>(() => {
    if (parameters === undefined) return () => undefined;
    return (parameterId) => {
      const found = parameters.parameters.find(
        (candidate) => candidate.id === parameterId,
      );
      return found === undefined ? undefined : { value: found.value };
    };
  }, [parameters]);

  // The solve loop: every displayed change re-derives (including each drag
  // move — the drag re-solves through the solver per move); a failure keeps
  // the last-known-good geometry and surfaces the structured diagnostics.
  // Bound dimensions resolve FIRST (against the live parameter environment)
  // and the solver consumes the resolved literal copies — so a parameter
  // edit re-drives the sketch here exactly as it re-drives committed
  // geometry downstream, and an unresolvable binding surfaces as the
  // sketch's structured failure (last-known-good kept).
  useEffect(() => {
    const resolution = resolveSketchDimensionBindings(
      displaySketch.constraints,
      parameterLookup,
    );
    if (!resolution.ok) {
      setSolveState((previous) => ({
        status: "failed",
        constrainedness: null,
        dof: null,
        solved: previous.solved,
        resolvedDisplay: previous.resolvedDisplay,
        diagnostics: [resolution.error],
      }));
      return;
    }
    const solveInput =
      resolution.value === displaySketch.constraints
        ? displaySketch
        : { ...displaySketch, constraints: resolution.value };
    const result = SOLVER.solve(solveInput.entities, solveInput.constraints);
    if (result.status === "failed") {
      setSolveState((previous) => ({
        status: "failed",
        constrainedness: null,
        dof: null,
        solved: previous.solved,
        resolvedDisplay: previous.resolvedDisplay,
        diagnostics: result.diagnostics,
      }));
      return;
    }
    // The commit sketch keeps the AUTHORED constraints (bindings intact —
    // the document re-drives them); the display sketch carries the resolved
    // copies so readouts present the live resolved quantities.
    const solved = applySolvedParameters(displaySketch, result.parameters);
    const resolvedDisplay =
      resolution.value === displaySketch.constraints
        ? solved
        : { ...solved, constraints: resolution.value };
    setSolveState({
      constrainedness: analyzeConstrainedness(
        resolvedDisplay.entities,
        solveInput.constraints,
      ),
      diagnostics: result.diagnostics,
      dof: result.dof,
      resolvedDisplay,
      solved,
      status: result.status,
    });
  }, [displaySketch, parameterLookup]);

  const dispatch = useCallback(
    (event: SketchEditorEvent): void => {
      const transition = sketchEditorReducer(editor, event, session.sketch);
      setEditor(transition.state);
      const transaction = transition.transaction;
      if (transaction === null) return;
      const applied = applySketchSessionTransaction(session, transaction);
      if (!applied.ok) {
        setEditor({
          ...transition.state,
          status: {
            code: applied.error.code,
            message: applied.error.message,
            severity: "error",
          },
        });
        return;
      }
      setSession(applied.value);
      setCommandLog((log) => [
        ...log,
        ...transaction.commands.map(serializeSketchCommand),
      ]);
    },
    [editor, session],
  );

  /**
   * Commits adapter-converted entities into this session's sketch as ONE
   * `sketch.entity.create` transaction (atomic, one undo step). Imported
   * ids re-mint deterministically when they would collide with entities the
   * session already holds (importing the same file twice re-ids, never
   * merges). A zero-entity parse declines instead of committing nothing.
   */
  const commitImportedEntities = useCallback(
    (
      entities: readonly SketchEntity[],
      source: "dxf" | "svg",
      fileName: string,
      declinedCount: number,
    ): void => {
      const declinedNote =
        declinedCount === 0 ? "" : `; ${String(declinedCount)} declined`;
      if (entities.length === 0) {
        setSketchImport({
          code: "sketch-import/empty",
          declined: declinedCount,
          message: `${fileName}: nothing in the pinned subset to import${declinedNote}`,
          source,
          status: "declined",
        });
        return;
      }
      const taken = new Set(session.sketch.entities.map((e) => e.id));
      const commands: SketchCommand[] = entities.map((entity) => {
        let id = entity.id;
        if (taken.has(id)) {
          let suffix = 1;
          let candidate = createSketchEntityId(
            `${entity.id}-i${String(suffix)}`,
          );
          while (taken.has(candidate)) {
            suffix += 1;
            candidate = createSketchEntityId(`${entity.id}-i${String(suffix)}`);
          }
          id = candidate;
        }
        taken.add(id);
        return { entity: { ...entity, id }, type: "sketch.entity.create" };
      });
      const applied = applySketchSessionTransaction(session, { commands });
      if (!applied.ok) {
        setSketchImport({
          code: applied.error.code,
          message: `${applied.error.code}: ${applied.error.message}`,
          source,
          status: "failed",
        });
        return;
      }
      setSession(applied.value);
      setCommandLog((log) => [...log, ...commands.map(serializeSketchCommand)]);
      setSketchImport({
        declined: declinedCount,
        imported: entities.length,
        message: `${fileName}: imported ${String(entities.length)} entities${declinedNote}`,
        source,
        status: "imported",
      });
    },
    [session],
  );

  // The Phase 56 sketch-exchange entry point: one DXF or SVG file imports
  // into THIS session's sketch. The adapters' structured outcomes surface
  // whole: a parse failure carries its stable `dxf-import/*` /
  // `svg-import/*` code; out-of-subset declines are counted, never dropped.
  const importSketchFile = useCallback(
    (file: File): void => {
      file
        .arrayBuffer()
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          const name = file.name.toLowerCase();
          if (name.endsWith(".dxf")) {
            const result = importDxf(bytes);
            if (!result.ok) {
              setSketchImport({
                code: result.error.code,
                message: `${result.error.code}: ${result.error.message}`,
                source: "dxf",
                status: "failed",
              });
              return;
            }
            commitImportedEntities(
              result.value.entities,
              "dxf",
              file.name,
              result.value.declined.length,
            );
            return;
          }
          if (name.endsWith(".svg")) {
            const result = importSvg(bytes);
            if (!result.ok) {
              setSketchImport({
                code: result.error.code,
                message: `${result.error.code}: ${result.error.message}`,
                source: "svg",
                status: "failed",
              });
              return;
            }
            commitImportedEntities(
              result.value.entities,
              "svg",
              file.name,
              result.value.declined.length,
            );
            return;
          }
          setSketchImport({
            code: "sketch-import/unsupported-file",
            message: `sketch import reads .dxf and .svg — got ${file.name}`,
            status: "declined",
          });
        })
        .catch((error: unknown) => {
          setSketchImport({
            code: "sketch-import/read-failed",
            message: error instanceof Error ? error.message : String(error),
            status: "failed",
          });
        });
    },
    [commitImportedEntities],
  );

  const undo = useCallback((): void => {
    const moved = undoSketchSession(session);
    if (moved.ok) setSession(moved.value.session);
  }, [session]);

  const redo = useCallback((): void => {
    const moved = redoSketchSession(session);
    if (moved.ok) setSession(moved.value.session);
  }, [session]);

  // The Phase 26.1 extrude action: resolve the CURRENT sketch (solved
  // geometry when available, authored otherwise) into one closed profile
  // loop. A resolution failure stays here — structured code on the status
  // line and the machine surface — and never reaches the document; a
  // resolved profile hands the serialized sketch plus the kernel-vocabulary
  // loop and placement to the host, and the host's OWN refusal (a refused
  // document transaction) comes back through the return value and takes
  // over the machine's extrude outcome — never a silent dead verb.
  const extrude = useCallback((): void => {
    const sketch = solveState.solved ?? session.sketch;
    const profile = resolveExtrudeProfile(sketch.entities);
    if (!profile.ok) {
      setExtrudeOutcome({
        status: "failed",
        code: profile.error.code,
        message: profile.error.message,
      });
      setEditor((current) => ({
        ...current,
        status: {
          code: profile.error.code,
          message: profile.error.message,
          severity: "error",
        },
      }));
      return;
    }
    const placement = workplaneToPlacement(sketch.workplane);
    setExtrudeOutcome({ status: "resolved" });
    const applied = onExtrude({
      sketch: serializeSketch(sketch),
      loop: profile.value.segments.map(kernelSegment),
      placement: {
        rotation: {
          axis: placement.rotation.axis,
          angle: angle(placement.rotation.angleRad, "rad"),
        },
        translation: {
          x: length(placement.translation.x),
          y: length(placement.translation.y),
          z: length(placement.translation.z),
        },
      },
    });
    if (applied !== undefined && !applied.ok) {
      // The host's refusal overwrites the provisional resolved stamp: the
      // document refused the commit (an id conflict on an adopted document,
      // say) and the machine surface reports it — the sketch stays open on
      // the refusal instead of a resolved verdict over a dead verb.
      setExtrudeOutcome({
        status: "failed",
        code: applied.code,
        message: applied.message,
      });
      setEditor((current) => ({
        ...current,
        status: {
          code: applied.code,
          message: applied.message,
          severity: "error",
        },
      }));
    }
  }, [onExtrude, session.sketch, solveState.solved]);

  // The Phase 26.2 revolve action: resolve the CURRENT sketch exactly like
  // the extrude action, then run the kernel's axis validation (crossing
  // refuses with the structured code before anything is committed) and hand
  // the serialized sketch plus the kernel-vocabulary loop, placement, and
  // axis to the host.
  const revolve = useCallback((): void => {
    const sketch = solveState.solved ?? session.sketch;
    const resolution = resolveRevolveSubmission({
      sketch: serializeSketch(sketch),
      entities: sketch.entities,
      workplane: sketch.workplane,
      axisDirectionRad:
        revolveAxis === "x" ? REVOLVE_AXIS_X_RAD : REVOLVE_AXIS_Y_RAD,
    });
    if (!resolution.ok) {
      setRevolveOutcome({
        status: "failed",
        code: resolution.code,
        message: resolution.message,
      });
      setEditor((current) => ({
        ...current,
        status: {
          code: resolution.code,
          message: resolution.message,
          severity: "error",
        },
      }));
      return;
    }
    setRevolveOutcome({ status: "resolved" });
    if (onRevolve === undefined) return;
    onRevolve(resolution.value);
  }, [onRevolve, revolveAxis, session.sketch, solveState.solved]);

  // The Phase 38 save action: serialize the CURRENT sketch (solved
  // geometry when available, authored otherwise) and hand it to the host as
  // a standalone document record. The button is hidden without the prop —
  // a host with no use for standalone sketches shows no dead control.
  const save = useCallback((): void => {
    if (onSaveSketch === undefined) return;
    const sketch = solveState.solved ?? session.sketch;
    onSaveSketch({ sketch: serializeSketch(sketch) });
  }, [onSaveSketch, session.sketch, solveState.solved]);

  // The dimension apply surface: the one write path for dimension edits. A
  // number commits the literal form (unchanged semantics — and a literal on
  // a bound constraint unbinds it); a `$name` string resolves against the
  // document's parameters and commits the bound form (the dimension follows
  // the parameter from the next solve on). Unknown or wrong-dimension names
  // refuse exactly like the feature dialogs' value resolution — the
  // inspector surfaces the refusal verbatim and nothing commits. A NEGATED
  // token (`-$name`, Phase 30) passes the field's grammar gate but is
  // refused HERE, per the domain — a binding stores the parameter id and
  // its resolve pass reads the value verbatim (no sign channel), so:
  // - distance/radius/diameter/angle: the domain's own range rule
  //   (`resolveSketchDimensionBindings`) refuses a non-positive / out-of-
  //   range resolved value at solve — the negated binding would be a
  //   refusal-in-waiting, so the seam refuses first with the same code;
  // - distanceX/distanceY (signed by the domain): the sign would silently
  //   DROP — the constraint would follow `name`, not `-name` — which is a
  //   lie, not a semantics. The established route is the chapter-taught
  //   signed helper variable: define the negation as its own expression
  //   variable and bind that.
  const editDimension = useCallback(
    (constraintId: string, value: number | string) => {
      const constraint = session.sketch.constraints.find(
        (candidate) => candidate.id === constraintId,
      );
      if (
        constraint === null ||
        constraint === undefined ||
        !isDimensionalConstraint(constraint)
      ) {
        return {
          error: {
            code: "sketch-command/constraint-unknown",
            message: `Constraint ${constraintId} does not exist or carries no dimensional value.`,
          },
          ok: false,
        } as const;
      }
      let dimensionCommand: SketchCommand;
      if (typeof value === "number") {
        dimensionCommand = {
          constraintId: constraint.id,
          type: "sketch.dimension.set",
          value:
            constraint.value.dimension === "length"
              ? lengthValue(value)
              : angleValue(value, "deg"),
        };
      } else {
        const name = expressionNumberTokenName(value);
        if (name === null) {
          return {
            error: {
              code: "sketch/dimension-binding-invalid",
              message: `"${value}" is not a $name parameter reference.`,
            },
            ok: false,
          } as const;
        }
        // The negated-binding refusal: the domain-following split (see the
        // comment above) — range-ruled kinds cite the domain's own resolve
        // rule, the signed kinds cite the verbatim-read mechanism.
        if (expressionNumberTokenNegated(value)) {
          const signed =
            constraint.kind === "distanceX" || constraint.kind === "distanceY";
          return {
            error: {
              code: "sketch/dimension-binding-invalid",
              message: signed
                ? `"-$${name}" cannot bind: a dimension binding reads the parameter's value verbatim, so the sign would silently drop — define a negated variable (an expression -${name}) and bind that.`
                : `"-$${name}" cannot bind: a dimension binding reads the parameter's value verbatim, and a ${constraint.kind} constraint must resolve inside its range (the domain refuses the negated value) — bind the positive variable.`,
            },
            ok: false,
          } as const;
        }
        const parameter =
          parameters === undefined
            ? undefined
            : findParameterByName(parameters, name);
        if (parameter === undefined) {
          return {
            error: {
              code: "sketch/dimension-binding-unresolved",
              message: `Unknown parameter "${name}".`,
            },
            ok: false,
          } as const;
        }
        if (parameter.value.dimension !== constraint.value.dimension) {
          return {
            error: {
              code: "sketch/dimension-binding-invalid",
              message: `The parameter "${name}" carries ${parameter.value.dimension}, but this dimension needs ${constraint.value.dimension}.`,
            },
            ok: false,
          } as const;
        }
        dimensionCommand = {
          constraintId: constraint.id,
          type: "sketch.dimension.set",
          parameterId: parameter.id,
        };
      }
      const applied = applySketchSessionTransaction(session, {
        commands: [dimensionCommand],
      });
      if (!applied.ok) {
        return { error: applied.error, ok: false } as const;
      }
      setSession(applied.value);
      setCommandLog((log) => [
        ...log,
        serializeSketchCommand(dimensionCommand),
      ]);
      return { ok: true } as const;
    },
    [parameters, session],
  );

  // The convert list (Phase 37): one persistent reference per topology
  // entity of the host's bodies, minted deterministically; vertices are
  // convertible, edges/faces carry the domain's honest decline up front.
  const convertList = useMemo(() => {
    if (topology === undefined) return null;
    const entries = [];
    for (const bodyId of topology.bodies) {
      const snapshot = topology.view.snapshotOf(bodyId);
      if (snapshot === null || !snapshot.persistentTopology) continue;
      for (const entity of snapshot.entities) {
        const referenceId = createReferenceId(
          `ref_${bodyId}_${entity.kind}_${String(entity.ordinal)}`,
        );
        const minted = mintTopologyReference(
          snapshot,
          entity.ordinal,
          {
            bodyId,
            featurePath: [],
          },
          {
            id: referenceId,
            kind: entity.kind,
          },
        );
        entries.push({
          convertible: entity.kind === "vertex" && minted.ok,
          declineMessage:
            entity.kind === "vertex"
              ? undefined
              : `A model ${entity.kind} carries only summary measures — not the curve projection needs.`,
          kind: entity.kind,
          label: `${entity.kind} ${String(entity.ordinal)} of ${bodyId}`,
          minted: minted.ok ? minted.value : null,
          referenceId,
        });
      }
    }
    return entries;
  }, [topology]);

  // ----- Phase 37 op surfaces -------------------------------------------------

  // The array apply surface: the inspector's Formedible form lands here;
  // the domain op builds the copies for the LIVE selection and the commit
  // rides the session (one atomic, undoable transaction).
  const applyArray = useCallback(
    (
      tool: "rectArray" | "circArray",
      values:
        | {
            readonly countX: number;
            readonly countY: number;
            readonly spacingX: number;
            readonly spacingY: number;
          }
        | {
            readonly count: number;
            readonly angleStepDeg: number;
            readonly centerX: number;
            readonly centerY: number;
          },
    ) => {
      if (editor.selectedEntityIds.length === 0) {
        return {
          error: {
            code: "sketch/no-selection",
            message:
              "The array applies to the selected entities; none are selected.",
          },
          ok: false,
        } as const;
      }
      // One commit path: the op's commands land atomically through the
      // session and the command log records their serializations.
      const commitCommands = (
        commands: readonly SketchCommand[],
      ):
        | { readonly ok: true }
        | {
            readonly ok: false;
            readonly error: { readonly code: string; readonly message: string };
          } => {
        const applied = applySketchSessionTransaction(session, { commands });
        if (!applied.ok) {
          return { error: applied.error, ok: false };
        }
        setSession(applied.value);
        setCommandLog((log) => [
          ...log,
          ...commands.map(serializeSketchCommand),
        ]);
        return { ok: true };
      };
      if (
        tool === "rectArray" &&
        "countX" in values &&
        "countY" in values &&
        "spacingX" in values &&
        "spacingY" in values
      ) {
        const result = rectangularArrayCommands(session.sketch, {
          countX: values.countX,
          countY: values.countY,
          entityIds: editor.selectedEntityIds,
          spacingX: values.spacingX,
          spacingY: values.spacingY,
        });
        if (!result.ok) {
          return { error: result.error, ok: false } as const;
        }
        const committed = commitCommands(result.value);
        if (!committed.ok) return committed;
        dispatch({
          status: {
            code: null,
            message: SKETCH_EDITOR_STATUS_TEXT.arrayApplied(
              result.value.length,
            ),
            severity: "hint",
          },
          type: "note-status",
        });
        return { ok: true } as const;
      }
      if (
        tool === "circArray" &&
        "count" in values &&
        "angleStepDeg" in values &&
        "centerX" in values &&
        "centerY" in values
      ) {
        const result = circularArrayCommands(session.sketch, {
          angleStepRad: (values.angleStepDeg * Math.PI) / 180,
          center: { x: values.centerX, y: values.centerY },
          count: values.count,
          entityIds: editor.selectedEntityIds,
        });
        if (!result.ok) {
          return { error: result.error, ok: false } as const;
        }
        const committed = commitCommands(result.value);
        if (!committed.ok) return committed;
        dispatch({
          status: {
            code: null,
            message: SKETCH_EDITOR_STATUS_TEXT.arrayApplied(
              result.value.length,
            ),
            severity: "hint",
          },
          type: "note-status",
        });
        return { ok: true } as const;
      }
      return {
        error: {
          code: "sketch-op/array-counts-invalid",
          message: "The array form submitted incomplete values.",
        },
        ok: false,
      } as const;
    },
    [dispatch, editor.selectedEntityIds, session],
  );

  // The convert apply surface: resolves the entry's persistent reference
  // against the view and commits the projected construction point.
  const applyConvert = useCallback(
    (referenceId: string) => {
      if (topology === undefined) {
        return {
          error: {
            code: "sketch-convert/view-missing",
            message:
              "No topology view is available: model geometry cannot be converted here.",
          },
          ok: false,
        } as const;
      }
      const entry = convertList?.find(
        (candidate) => candidate.referenceId === referenceId,
      );
      if (entry === undefined || entry.minted === null) {
        return {
          error: {
            code: "sketch-convert/reference-invalid",
            message: `The convert entry ${referenceId} carries no resolvable reference.`,
          },
          ok: false,
        } as const;
      }
      const result = convertTopologyEntities(session.sketch, {
        references: [entry.minted],
        view: topology.view,
      });
      if (!result.ok) {
        return { error: result.error, ok: false } as const;
      }
      const outcome = result.value[0];
      if (outcome === undefined) {
        return {
          error: {
            code: "sketch-convert/reference-invalid",
            message: "The convert produced no outcome.",
          },
          ok: false,
        } as const;
      }
      if (outcome.status === "declined") {
        setConvertOutcome(
          JSON.stringify({
            code: outcome.code,
            reference: referenceId,
            status: "declined",
          }),
        );
        return {
          error: { code: outcome.code, message: outcome.message },
          ok: false,
        } as const;
      }
      const applied = applySketchSessionTransaction(session, {
        commands: [outcome.command],
      });
      if (!applied.ok) {
        return { error: applied.error, ok: false } as const;
      }
      setSession(applied.value);
      setCommandLog((log) => [...log, serializeSketchCommand(outcome.command)]);
      setConvertOutcome(
        JSON.stringify({
          offsetMm: outcome.offsetMm,
          reference: referenceId,
          status: "converted",
        }),
      );
      dispatch({
        status: {
          code: null,
          message:
            outcome.offsetMm === 0
              ? SKETCH_EDITOR_STATUS_TEXT.converted(1)
              : `${SKETCH_EDITOR_STATUS_TEXT.converted(1)} (projected ${String(outcome.offsetMm)} mm off-plane)`,
          severity: "hint",
        },
        type: "note-status",
      });
      return { ok: true } as const;
    },
    [convertList, dispatch, session, topology],
  );

  // The effective status: the convert tool without a topology view states
  // its honest decline instead of pointing at an inspector list that has
  // nothing to list.
  const effectiveStatus =
    editor.tool === "convert" && topology === undefined
      ? {
          ...editor.status,
          message: SKETCH_EDITOR_STATUS_TEXT.convertNoTopology,
        }
      : editor.status;

  // ----- Derived view models -------------------------------------------------
  const authoredSurface = sketchSurface(session.sketch);
  const diagnostics = solveState.diagnostics;
  const diagnosticById = useMemo(() => {
    const map = new Map<string, SketchDiagnostic>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.location !== undefined) {
        map.set(diagnostic.location.primary, diagnostic);
      }
    }
    return map;
  }, [diagnostics]);

  /** The parameter NAME a bound constraint points at, when resolvable. */
  const boundParameterNameOf = useCallback(
    (constraint: SketchConstraint): string | undefined => {
      const parameterId = boundDimensionParameterId(constraint);
      if (parameterId === null || parameters === undefined) return undefined;
      return parameters.parameters.find(
        (candidate) => candidate.id === parameterId,
      )?.name;
    },
    [parameters],
  );

  const inspectorConstraints: readonly CadSketchInspectorConstraint[] = useMemo(
    () =>
      session.sketch.constraints.map((constraint) => {
        const diagnostic = diagnosticById.get(constraint.id);
        const boundName = boundParameterNameOf(constraint);
        return {
          entityIds: constraintOperandIds(constraint),
          id: constraint.id,
          kind: constraint.kind,
          label:
            boundName === undefined
              ? constraintLabel(constraint)
              : `${constraint.kind} $${boundName}`,
          message: diagnostic?.message,
          status:
            diagnostic === undefined
              ? "ok"
              : diagnostic.severity === "error"
                ? "error"
                : "warning",
        };
      }),
    [boundParameterNameOf, diagnosticById, session.sketch.constraints],
  );

  const selectedDimension: CadSketchInspectorDimension | null = useMemo(() => {
    const selected = session.sketch.constraints.find(
      (constraint) => constraint.id === editor.selectedConstraintId,
    );
    if (selected === undefined || !isDimensionalConstraint(selected)) {
      return null;
    }
    const canonical = selected.value;
    return {
      constraintId: selected.id,
      decimals: 3,
      parameterName: boundParameterNameOf(selected),
      unit: canonical.dimension === "length" ? "mm" : "deg",
      value: valueIn(
        canonical,
        canonical.dimension === "length" ? "mm" : "deg",
      ),
    };
  }, [
    boundParameterNameOf,
    editor.selectedConstraintId,
    session.sketch.constraints,
  ]);

  const view = sketchViewModel(
    displaySketch,
    solveState.resolvedDisplay ?? solveState.solved,
    { entityIds: editor.selectedEntityIds },
    diagnostics,
    solveState.constrainedness,
  );

  const pickMarkers: readonly CadSketchPoint[] = editor.picks.map((pick) => {
    const position = pointTargetPosition(session.sketch.entities, {
      entity: pick.entityId,
      point: pick.point ?? "center",
    });
    return position ?? { x: 0, y: 0 };
  });

  const preview: CadSketchCanvasPreview = (() => {
    if (pointer === null) return { kind: "none" };
    switch (editor.gesture.kind) {
      case "line":
        return {
          from: editor.gesture.start,
          kind: "line",
          to: pointer,
        } as const;
      case "circle":
        return {
          center: editor.gesture.center,
          kind: "circle",
          radius: Math.hypot(
            pointer.x - editor.gesture.center.x,
            pointer.y - editor.gesture.center.y,
          ),
        } as const;
      case "rectangle":
        return {
          from: editor.gesture.corner,
          kind: "rectangle",
          to: pointer,
        } as const;
      case "ellipse": {
        const { center, axis } = editor.gesture;
        const rotation = Math.atan2(axis.y - center.y, axis.x - center.x);
        const cosR = Math.cos(rotation);
        const sinR = Math.sin(rotation);
        const radiusY = Math.abs(
          -sinR * (pointer.x - center.x) + cosR * (pointer.y - center.y),
        );
        return {
          center: { x: center.x, y: center.y },
          kind: "ellipse" as const,
          radiusX: Math.hypot(axis.x - center.x, axis.y - center.y),
          radiusY,
          rotation,
        };
      }
      case "slot": {
        // The provisional stadium preview reuses the domain's own boundary
        // derivation on a transient entity (the deflection-disciplined
        // polyline the committed slot will render as).
        const { start, end } = editor.gesture;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const radius =
          Math.abs((pointer.x - start.x) * dy - (pointer.y - start.y) * dx) /
          Math.sqrt(lengthSquared);
        if (!(radius > 0)) return { kind: "none" } as const;
        const provisional = createStraightSlotEntity(
          createSketchEntityId("skent_preview"),
          start,
          end,
          radius,
        );
        const points = entityPolyline(provisional);
        if (points === null) return { kind: "none" } as const;
        return {
          kind: "polyline",
          points: points.map((point) => ({ x: point.x, y: point.y })),
        } as const;
      }
      case "pick":
        return editor.gesture.tool === "ellipse"
          ? {
              center: editor.gesture.point,
              kind: "circle",
              radius: Math.hypot(
                pointer.x - editor.gesture.point.x,
                pointer.y - editor.gesture.point.y,
              ),
            }
          : {
              from: editor.gesture.point,
              kind: "line",
              to: pointer,
            };
      case "spline": {
        // The picked controls so far, threaded through the pointer — the
        // same polyline the committed control spline will render as once a
        // fourth control lands.
        const points = [...editor.gesture.points, pointer].map((point) => ({
          x: point.x,
          y: point.y,
        }));
        return points.length < 2
          ? { kind: "none" }
          : { kind: "polyline", points };
      }
      case "polygon": {
        // The provisional hexagon (the tool's fixed discrete parameters)
        // through the domain's own boundary derivation.
        const { center } = editor.gesture;
        const radius = Math.hypot(pointer.x - center.x, pointer.y - center.y);
        if (!(radius > 0)) return { kind: "none" };
        const provisional = createPolygonEntity(
          createSketchEntityId("skent_preview"),
          center,
          radius,
          POLYGON_TOOL_SIDES,
          Math.atan2(pointer.y - center.y, pointer.x - center.x),
          "inscribed",
        );
        const points = entityPolyline(provisional);
        if (points === null || points.length < 2) return { kind: "none" };
        return {
          kind: "polyline",
          points: points.map((point) => ({ x: point.x, y: point.y })),
        };
      }
      default:
        return { kind: "none" };
    }
  })();

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      dispatch({ type: "escape" });
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      // An editable origin (an inspector dimension field, an array count)
      // keeps the key for its own text editing — no preventDefault, no
      // delete-selection — so correcting a value never destroys the
      // selected constraint or the entities a form is patterning.
      if (isEditableKeyboardOrigin(event)) return;
      event.preventDefault();
      dispatch({ type: "delete-selection" });
    }
  };

  return (
    <div
      aria-label="Sketch workspace"
      className="flex min-h-0 flex-1 flex-col"
      data-sketch-commands={JSON.stringify(commandLog)}
      data-sketch-convert={convertOutcome ?? ""}
      data-sketch-dimensions={JSON.stringify(
        view.dimensions.map(serializeDimensionPresentation),
      )}
      data-sketch-entity-dof={JSON.stringify(
        Object.fromEntries(view.entityDof),
      )}
      data-sketch-extrude={
        extrudeOutcome === null ? "" : JSON.stringify(extrudeOutcome)
      }
      data-sketch-revolve={
        revolveOutcome === null ? "" : JSON.stringify(revolveOutcome)
      }
      data-sketch-revolve-axis={revolveAxis}
      data-sketch-import={
        sketchImport === null ? "" : JSON.stringify(sketchImport)
      }
      data-sketch-constraints={JSON.stringify(authoredSurface.constraints)}
      data-sketch-diagnostics={JSON.stringify(
        diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          severity: diagnostic.severity,
        })),
      )}
      data-sketch-entities={JSON.stringify(authoredSurface.entities)}
      data-sketch-gesture={editor.gesture.kind}
      data-sketch-history={JSON.stringify({
        canRedo: canRedoSketch(session),
        canUndo: canUndoSketch(session),
        cursor: session.history.cursor,
        depth: session.history.entries.length,
      })}
      data-sketch-selection={JSON.stringify({
        constraintId: editor.selectedConstraintId,
        entityIds: editor.selectedEntityIds,
      })}
      data-sketch-solve={JSON.stringify({
        diagnostics: diagnostics.length,
        dof: solveState.dof,
        status: solveState.status,
      })}
      data-sketch-solved={JSON.stringify(
        solveState.solved === null
          ? null
          : sketchSurface(solveState.resolvedDisplay ?? solveState.solved)
              .entities,
      )}
      data-sketch-tool={editor.tool}
      data-sketch-tool-status={JSON.stringify(effectiveStatus)}
      data-sketch-workplane={JSON.stringify(session.sketch.workplane)}
      id="sketch-root"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* The sketch command row: mode exit, tool strip, undo/redo. */}
      <div className="border-border bg-card/50 flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <Button
          data-testid="workbench-mode-toggle"
          onClick={onExit}
          size="xs"
          type="button"
          variant="outline"
        >
          Model
        </Button>
        <Button
          data-testid="sketch-extrude"
          disabled={extrudeDisabled}
          onClick={extrude}
          size="xs"
          title={extrudeDisabled ? extrudeDisabledTitle : undefined}
          type="button"
          variant="outline"
        >
          Extrude
        </Button>
        {/* The Phase 38 save action: commits the sketch as a standalone
            document record for the sweep/loft forms to pick from. Rendered
            only when the host carries the action; disabled on an empty
            canvas — an empty record would resolve nothing. */}
        {onSaveSketch === undefined ? null : (
          <Button
            data-testid="sketch-save"
            disabled={session.sketch.entities.length === 0}
            onClick={save}
            size="xs"
            title="Save this sketch to the document; sweep and loft pick their sketches from the saved pool."
            type="button"
            variant="outline"
          >
            Save
          </Button>
        )}
        {/* The revolve action: the axis selector (a workplane axis — the
            axis line runs through the workplane origin along it) pinned as
            authoring state, then the action button. The selected axis is
            machine-visible through data-sketch-revolve-axis. Rendered only
            when the host carries the action — a host without it shows no
            dead controls. */}
        {onRevolve === undefined ? null : (
          <>
            <div
              aria-label="Revolve axis"
              className="flex items-center gap-1"
              role="group"
            >
              <span className="text-muted-foreground pl-1 text-xs">axis</span>
              <Button
                aria-pressed={revolveAxis === "x"}
                data-testid="revolve-axis-x"
                onClick={() => {
                  setRevolveAxis("x");
                }}
                size="xs"
                type="button"
                variant={revolveAxis === "x" ? "default" : "outline"}
              >
                X
              </Button>
              <Button
                aria-pressed={revolveAxis === "y"}
                data-testid="revolve-axis-y"
                onClick={() => {
                  setRevolveAxis("y");
                }}
                size="xs"
                type="button"
                variant={revolveAxis === "y" ? "default" : "outline"}
              >
                Y
              </Button>
            </div>
            <Button
              data-testid="sketch-revolve"
              onClick={revolve}
              size="xs"
              type="button"
              variant="outline"
            >
              Revolve
            </Button>
          </>
        )}
        <CadSketchToolbar
          activeToolId={editor.tool}
          className="border-0 bg-transparent p-0"
          groups={TOOLBAR_GROUPS}
          onActivate={(toolId) => {
            if (isSketchToolId(toolId)) {
              dispatch({ tool: toolId, type: "activate-tool" });
            }
          }}
        />
        {/* The Phase 56 sketch-exchange entry: a DXF/SVG file imports into
            the ACTIVE sketch as entities (one undoable transaction). The
            outcome surfaces on the status line below. Rendered only when the
            host carries the exchange control — the plain workbench (the
            byte-stable render battery's fixture) omits it, so its resting
            command row keeps the exact pre-exchange layout the
            scroll-sensitive deterministic canvas captures freeze. */}
        {importSketchFiles ? (
          <input
            accept=".dxf,.svg"
            aria-label="Import DXF or SVG into the active sketch"
            className="border-input bg-background file:bg-background file:text-foreground h-7 w-48 rounded-none border px-1 text-xs"
            data-testid="sketch-import-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) importSketchFile(file);
              event.target.value = "";
            }}
            type="file"
          />
        ) : null}
        <div className="flex-1" />
        <div
          aria-label="Sketch history"
          className="flex items-center gap-1"
          role="group"
        >
          <Button
            data-testid="sketch-undo"
            disabled={!canUndoSketch(session)}
            onClick={undo}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button
            data-testid="sketch-redo"
            disabled={!canRedoSketch(session)}
            onClick={redo}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Redo2 data-icon="inline-start" />
            Redo
          </Button>
        </div>
      </div>
      {/* The workspace: canvas dominant, inspector docked right. */}
      <div className="flex min-h-0 flex-1 flex-wrap items-start justify-center gap-3 overflow-y-auto p-3">
        <CadSketchCanvas
          annotations={view.annotations}
          dimensions={view.dimensions}
          draggingEntityId={editor.drag?.entityId ?? null}
          entities={view.entities}
          entityDof={view.entityDof}
          gridStep={SKETCH_CANVAS.gridStep}
          height={SKETCH_CANVAS.height}
          hoveredEntityId={editor.hoveredEntityId}
          onDragEnd={(point) => {
            dispatch({ point, type: "drag-end" });
          }}
          onDragMove={(point) => {
            dispatch({ point, type: "drag-move" });
          }}
          onDragStart={(drag) => {
            dispatch({
              entityId: drag.entityId,
              point: drag.point,
              type: "drag-start",
            });
          }}
          onHover={(entityId) => {
            dispatch({ entityId, type: "hover" });
          }}
          onMove={setPointer}
          onPick={({ entityId, point }) => {
            dispatch({ entityId, point, type: "canvas-pick" });
          }}
          origin={SKETCH_CANVAS.origin}
          picks={pickMarkers}
          preview={preview}
          regions={view.regions}
          scale={SKETCH_CANVAS.scale}
          width={SKETCH_CANVAS.width}
        />
        <CadSketchInspector
          array={
            editor.tool === "rectArray" || editor.tool === "circArray"
              ? {
                  selectionCount: editor.selectedEntityIds.length,
                  tool: editor.tool,
                }
              : null
          }
          className="shrink-0"
          constraints={inspectorConstraints}
          convert={
            convertList === null
              ? null
              : {
                  entries: convertList.map((entry) => ({
                    convertible: entry.convertible,
                    declineMessage: entry.declineMessage,
                    kind: entry.kind,
                    label: entry.label,
                    referenceId: entry.referenceId,
                  })),
                  hint: "Vertices project to construction points on the sketch plane.",
                }
          }
          diagnostics={diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            severity: diagnostic.severity,
          }))}
          dimension={selectedDimension}
          dof={solveState.dof ?? 0}
          onApplyArray={applyArray}
          onConvert={applyConvert}
          onEditDimension={editDimension}
          parameterNames={
            parameters === undefined
              ? undefined
              : parameters.parameters.map((parameter) => parameter.name)
          }
          onSelectConstraint={(constraintId) => {
            const found =
              constraintId === null
                ? null
                : session.sketch.constraints.find(
                    (candidate) => candidate.id === constraintId,
                  );
            dispatch({
              constraintId: found?.id ?? null,
              type: "select-constraint",
            });
          }}
          selectedConstraintId={editor.selectedConstraintId}
          solveStatus={solveState.status}
        />
      </div>
      {/* The sketch status line: the editor status plus the solver readout. */}
      <div
        className="border-border bg-card/50 text-muted-foreground flex h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-[11px]"
        data-testid="sketch-status"
      >
        <span
          aria-live="polite"
          className={
            effectiveStatus.severity === "error"
              ? "text-destructive"
              : undefined
          }
          data-sketch-status-severity={editor.status.severity}
          data-testid="sketch-status-message"
        >
          {effectiveStatus.message}
        </span>
        {sketchImport === null ? null : (
          <span
            className={
              sketchImport.status === "failed" ? "text-destructive" : undefined
            }
            data-testid="sketch-import-outcome"
          >
            {sketchImport.message}
          </span>
        )}
        <span className="ml-auto">
          entities = {String(authoredSurface.entities.length)}
        </span>
        <span>constraints = {String(authoredSurface.constraints.length)}</span>
        <span>commands = {String(commandLog.length)}</span>
        <span data-testid="sketch-status-solve">
          solve = {solveState.status}
          {solveState.dof === null ? "" : ` (dof ${String(solveState.dof)})`}
        </span>
      </div>
    </div>
  );
}
