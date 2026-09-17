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
import { angle as angleValue, length as lengthValue, valueIn } from "@slopcad/cad-core";
import {
  applySolvedParameters,
  applySketchSessionTransaction,
  canRedoSketch,
  canUndoSketch,
  createReferenceSketchSolver,
  createSketchSession,
  isDimensionalConstraint,
  redoSketchSession,
  serializeSketchCommand,
  undoSketchSession,
  type SketchCommand,
  type SketchDiagnostic,
  type SerializedSketchCommand,
} from "@slopcad/cad-sketch";
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

/** Props of {@link SketchMode}. */
export interface SketchModeProps {
  /** Exits sketch mode (the host's mode switch, e.g. back to the model). */
  readonly onExit: () => void;
}

/** The full sketch workspace: toolbar, canvas, inspector, status line. */
export function SketchMode({ onExit }: SketchModeProps): ReactElement {
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

  // The dimension apply surface: the one write path for dimension edits.
  const editDimension = useCallback(
    (constraintId: string, value: number) => {
      const constraint = session.sketch.constraints.find(
        (candidate) => candidate.id === constraintId,
      );
      if (constraint === null || constraint === undefined || !isDimensionalConstraint(constraint)) {
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

  const inspectorConstraints: readonly CadSketchInspectorConstraint[] =
    useMemo(
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

  const selectedDimension:
    | CadSketchInspectorDimension
    | null = useMemo(() => {
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
      data-sketch-constraints={JSON.stringify(authoredSurface.constraints)}
      data-sketch-diagnostics={JSON.stringify(
        diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          severity: diagnostic.severity,
        })),
      )}
      data-sketch-entities={JSON.stringify(authoredSurface.entities)}      data-sketch-gesture={editor.gesture.kind}
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
      <div className="border-border bg-background flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <Button
          data-testid="workbench-mode-toggle"
          onClick={onExit}
          size="xs"
          type="button"
          variant="outline"
        >
          Model
        </Button>
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
        <div aria-label="Sketch history" className="flex items-center gap-1" role="group">
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
        className="border-border bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-xs"
        data-testid="sketch-status"
      >
        <span
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
