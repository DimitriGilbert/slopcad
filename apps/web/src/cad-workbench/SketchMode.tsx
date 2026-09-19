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
 * (the serialized command log), `data-sketch-history`, and
 * `data-sketch-gesture` — everything the Playwright battery asserts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import {
  angle,
  angle as angleValue,
  length,
  length as lengthValue,
  valueIn,
} from "@slopcad/cad-core";
import {
  applySolvedParameters,
  applySketchSessionTransaction,
  canRedoSketch,
  canUndoSketch,
  createReferenceSketchSolver,
  createSketchSession,
  isDimensionalConstraint,
  redoSketchSession,
  resolveExtrudeProfile,
  serializeSketch,
  serializeSketchCommand,
  undoSketchSession,
  workplaneToPlacement,
  type SketchCommand,
  type SketchDiagnostic,
  type SerializedSketch,
  type SerializedSketchCommand,
} from "@slopcad/cad-sketch";
import type { ProfileExtrudeInput } from "@slopcad/cad-kernel";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import {
  CadSketchCanvas,
  type CadSketchPoint,
} from "@slopcad/ui/components/cad/cad-sketch-canvas";
import {
  CadSketchInspector,
  type CadSketchInspectorConstraint,
  type CadSketchInspectorDimension,
} from "@slopcad/ui/components/cad/cad-sketch-inspector";
import { CadSketchToolbar } from "@slopcad/ui/components/cad/cad-sketch-toolbar";

import {
  constraintLabel,
  constraintOperandIds,
  createSketchEditorState,
  createWorkbenchSketch,
  isSketchToolId,
  pointTargetPosition,
  SKETCH_CANVAS,
  SKETCH_CONSTRAINT_TOOLS,
  SKETCH_DRAWING_TOOLS,
  sketchEditorReducer,
  sketchSurface,
  sketchViewModel,
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
  /** The last successfully solved sketch (`null` before the first solve). */
  readonly solved: ReturnType<typeof applySolvedParameters> | null;
  readonly diagnostics: readonly SketchDiagnostic[];
}

const SOLVER = createReferenceSketchSolver();

const TOOLBAR_GROUPS = [
  { id: "tools", label: "Tools", toolIds: SKETCH_DRAWING_TOOLS },
  { id: "constraints", label: "Constraints", toolIds: SKETCH_CONSTRAINT_TOOLS },
];

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
   * resolution failures stay here as structured statuses.
   */
  readonly onExtrude: (submission: SketchExtrudeSubmission) => void;
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

/** The revolve axis the selector pins: a workplane axis (X or Y). */
export type RevolveAxisId = "x" | "y";

/** The full sketch workspace: toolbar, canvas, inspector, status line. */
export function SketchMode({
  onExit,
  onExtrude,
  onRevolve,
  extrudeDisabled = false,
  extrudeDisabledTitle,
}: SketchModeProps): ReactElement {
  const [session, setSession] = useState(() =>
    createSketchSession(createWorkbenchSketch()),
  );
  const [editor, setEditor] = useState<SketchEditorState>(
    createSketchEditorState,
  );
  const [solveState, setSolveState] = useState<SketchSolveState>({
    status: "solved",
    dof: 0,
    solved: null,
    diagnostics: [],
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

  // The solve loop: every authored change re-derives; a failure keeps the
  // last-known-good geometry and surfaces the structured diagnostics.
  useEffect(() => {
    const result = SOLVER.solve(
      session.sketch.entities,
      session.sketch.constraints,
    );
    if (result.status === "failed") {
      setSolveState((previous) => ({
        status: "failed",
        dof: null,
        solved: previous.solved,
        diagnostics: result.diagnostics,
      }));
      return;
    }
    setSolveState({
      status: result.status,
      dof: result.dof,
      solved: applySolvedParameters(session.sketch, result.parameters),
      diagnostics: result.diagnostics,
    });
  }, [session.sketch]);

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
  // loop and placement to the host.
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
    onExtrude({
      sketch: serializeSketch(sketch),
      loop: profile.value.segments.map((segment) => {
        if (segment.kind === "line") {
          return {
            kind: "line" as const,
            start: [segment.start.x, segment.start.y] as const,
            end: [segment.end.x, segment.end.y] as const,
          };
        }
        if (segment.kind === "arc") {
          return {
            kind: "arc" as const,
            center: [segment.center.x, segment.center.y] as const,
            radius: segment.radius,
            startAngle: angle(segment.startAngle, "rad"),
            endAngle: angle(segment.endAngle, "rad"),
          };
        }
        return {
          kind: "circle" as const,
          center: [segment.center.x, segment.center.y] as const,
          radius: segment.radius,
        };
      }),
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

  // The dimension apply surface: the one write path for dimension edits.
  const editDimension = useCallback(
    (constraintId: string, value: number) => {
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
      const dimensionCommand: SketchCommand = {
        constraintId: constraint.id,
        type: "sketch.dimension.set",
        value:
          constraint.value.dimension === "length"
            ? lengthValue(value)
            : angleValue(value, "deg"),
      };
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
    [session],
  );

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

  const inspectorConstraints: readonly CadSketchInspectorConstraint[] = useMemo(
    () =>
      session.sketch.constraints.map((constraint) => {
        const diagnostic = diagnosticById.get(constraint.id);
        return {
          entityIds: constraintOperandIds(constraint),
          id: constraint.id,
          kind: constraint.kind,
          label: constraintLabel(constraint),
          message: diagnostic?.message,
          status:
            diagnostic === undefined
              ? "ok"
              : diagnostic.severity === "error"
                ? "error"
                : "warning",
        };
      }),
    [session.sketch.constraints, diagnosticById],
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
      unit: canonical.dimension === "length" ? "mm" : "deg",
      value: valueIn(
        canonical,
        canonical.dimension === "length" ? "mm" : "deg",
      ),
    };
  }, [editor.selectedConstraintId, session.sketch.constraints]);

  const view = sketchViewModel(
    session.sketch,
    solveState.solved,
    { entityIds: editor.selectedEntityIds },
    diagnostics,
  );

  const pickMarkers: readonly CadSketchPoint[] = editor.picks.map((pick) => {
    const position = pointTargetPosition(session.sketch.entities, {
      entity: pick.entityId,
      point: pick.point ?? "center",
    });
    return position ?? { x: 0, y: 0 };
  });

  const preview = (() => {
    if (pointer === null) return { kind: "none" } as const;
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
      default:
        return { kind: "none" } as const;
    }
  })();

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      dispatch({ type: "escape" });
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      dispatch({ type: "delete-selection" });
    }
  };

  return (
    <div
      aria-label="Sketch workspace"
      className="flex min-h-0 flex-1 flex-col"
      data-sketch-commands={JSON.stringify(commandLog)}
      data-sketch-extrude={
        extrudeOutcome === null ? "" : JSON.stringify(extrudeOutcome)
      }
      data-sketch-revolve={
        revolveOutcome === null ? "" : JSON.stringify(revolveOutcome)
      }
      data-sketch-revolve-axis={revolveAxis}
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
          : sketchSurface(solveState.solved).entities,
      )}
      data-sketch-tool={editor.tool}
      data-sketch-tool-status={JSON.stringify(editor.status)}
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
      <div className="flex min-h-0 flex-1 items-start justify-center gap-3 p-3">
        <CadSketchCanvas
          annotations={view.annotations}
          entities={view.entities}
          gridStep={SKETCH_CANVAS.gridStep}
          height={SKETCH_CANVAS.height}
          hoveredEntityId={editor.hoveredEntityId}
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
          className="shrink-0"
          constraints={inspectorConstraints}
          diagnostics={diagnostics.map((diagnostic) => ({
            code: diagnostic.code,
            message: diagnostic.message,
            severity: diagnostic.severity,
          }))}
          dimension={selectedDimension}
          dof={solveState.dof ?? 0}
          onEditDimension={editDimension}
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
            editor.status.severity === "error" ? "text-destructive" : undefined
          }
          data-sketch-status-severity={editor.status.severity}
          data-testid="sketch-status-message"
        >
          {editor.status.message}
        </span>
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
