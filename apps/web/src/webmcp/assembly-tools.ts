/**
 * The assembly WebMCP tools (PLAN-AGENT-CHAT Phase 2.2, D11): the assembly
 * capability pages' agent surface — every occurrence/mate/joint operation a
 * user can reach on those pages, driven through the SAME cad-core document
 * doors the pages' own buttons use (`addOccurrence` / `removeOccurrence` /
 * `addMate` / `removeMate` / `addJoint` / `removeJoint`, the pattern
 * resolvers, the interference and clearance batches), so an agent action
 * and a user action are one write path. Binding follows the registry rule:
 * the tools bind where the assembly document lives — the
 * `/workbench-assembly` and `/workbench-assembly-motion` pages (mutable
 * documents) and the `/workbench-assembly-interference` page (a read-only
 * document: reads and the interference report only, never a mutator).
 *
 * The read tools share the workbench set's own builders: `cad_get_document`
 * renders the same compact, model-oriented outline (occurrence trees,
 * mates, joints included) and `cad_get_diagnostics` the same assembly
 * section (`assembly/mate-*` solve codes, joint DOF accounting).
 *
 * Errors are the registry's structured refusals — `{ ok: false, code,
 * message }`, the doors' own codes (`document/*`, `assembly/*`) plus this
 * module's `workbench/assembly-*` codes — never a throw, exactly like
 * every other tool in the registry.
 */

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  addJoint,
  addMate,
  addOccurrence,
  type AssemblyPatternError,
  type BodyId,
  type CadDocument,
  checkAssemblyClearances,
  checkResolvedAssemblyInterference,
  type ClearanceInstance,
  type ClearanceMesh,
  createBodyId,
  createJointId,
  createMateId,
  createOccurrenceId,
  createReferenceId,
  type DatumVec3,
  type DocumentOccurrence,
  type InterferenceVolumeFn,
  JOINT_KINDS,
  MATE_KINDS,
  OCCURRENCE_PATTERN_INSTANCE_LIMIT,
  type OccurrenceBomFlag,
  type ParseResult,
  type PlacementTransform,
  removeJoint,
  removeMate,
  removeOccurrence,
  resolveAssemblyInstances,
  resolveCircularOccurrencePattern,
  resolveLinearOccurrencePattern,
  resolveMirroredOccurrencePlacement,
  resolveOccurrencePlacement,
  type OccurrenceSource,
} from "@slopcad/cad-core";
import type { WebMcpToolEntry } from "./registry";

import { assemblyDiagnostics, documentOutline } from "./document-outline";
import { defineWebMcpTool } from "./registry";
import { useWebMcpTools } from "./use-webmcp-tools";

/**
 * The interference-volume threshold (mm³) one detector run shares across
 * both surfaces: the interference page's run button (`runInterferenceCheck`
 * in the workbench fixture) and this module's `cad_assembly_check_interference`
 * tool read the same constant, so an agent run and a button run can never
 * disagree about which pairs count as interfering (deliberately looser than
 * the kernel's 1e-9 default — the pages' long-standing report threshold).
 */
export const INTERFERENCE_TOLERANCE_MM3 = 0.001;

/**
 * The interference/clearance seams a host page binds to its own geometry
 * sources (the Phase 58 fixture's own binding): local bounds per body, the
 * kernel-bound intersection-volume seam, and the clearance meshes. A page
 * without them honestly refuses the report tool.
 */
export interface AssemblyInterferenceSeams {
  /** The body's LOCAL-space AABB, or `undefined` when the host has none. */
  readonly boundsOf: (
    bodyId: BodyId,
  ) => { readonly min: DatumVec3; readonly max: DatumVec3 } | undefined;
  /** The intersection-volume seam (mm³), or `null` when the kernel declines. */
  readonly intersectVolume: InterferenceVolumeFn;
  /** The body's LOCAL-space triangle soup for clearance measurement. */
  readonly meshOf: (bodyId: BodyId) => ClearanceMesh | undefined;
}

/**
 * The narrow live surface the assembly tools drive. Accessors keep the
 * once-minted entries reading LIVE state; `commit`'s PRESENCE at mint time
 * decides the tool set — a page whose document is not mutable (the
 * interference fixture's constant) mounts the reads without the mutators,
 * so the registry snapshot never advertises a write the page cannot land.
 */
export interface AssemblyWebMcpSurface {
  /** The live assembly document. */
  readonly document: () => CadDocument;
  /**
   * Commits the next document (the pages' own state setter), or `null` on
   * a read-only page.
   */
  readonly commit: ((next: CadDocument) => void) | null;
  /**
   * The cross-document resolution seam (sub-assembly sources), or `null`
   * when the page carries none.
   */
  readonly resolveDocument:
    ((documentId: string) => CadDocument | undefined) | null;
  /** The page's interference/clearance seams, or `null` when absent. */
  readonly interference: AssemblyInterferenceSeams | null;
}

/** The structured refusal every handler returns instead of throwing. */
interface ToolRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/** The refusal code for a mutation on a page whose document is read-only. */
const ASSEMBLY_READONLY = "workbench/assembly-readonly";

/** The refusal code for an occurrence id the document does not carry. */
const OCCURRENCE_UNKNOWN = "workbench/assembly-occurrence-unknown";

/** The refusal code when the page carries no interference seams. */
const INTERFERENCE_UNAVAILABLE = "workbench/assembly-interference-unavailable";

/** The refusal code when the assembly walk itself fails (cross-document). */
const RESOLUTION_FAILED = "workbench/assembly-resolution-failed";

/** A refusal, the one shape handlers never throw. */
function refusal(code: string, message: string): ToolRefusal {
  return { code, message, ok: false };
}

/** Maps the doors' structured failures into the tool refusal shape. */
function refusalFromError(error: {
  readonly code: string;
  readonly message: string;
}): ToolRefusal {
  return refusal(error.code, error.message);
}

/** A finite 3-vector, the pattern/frame placements' own tuple form. */
const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

/**
 * The occurrence BOM flag vocabulary (the domain's `OccurrenceBomFlag`;
 * the package root re-exports only its type, so the literal is pinned here
 * and `satisfies` keeps it lockstep with the domain).
 */
const occurrenceBomFlags = [
  "default",
  "phantom",
  "purchased",
] as const satisfies readonly OccurrenceBomFlag[];

/** The pattern count bound, the resolver's own limit. */
const patternCountSchema = z
  .number()
  .int()
  .min(1)
  .max(OCCURRENCE_PATTERN_INSTANCE_LIMIT);

/** The occurrence source vocabulary, discriminated exactly as the door is. */
const occurrenceSourceSchema = z.discriminatedUnion("kind", [
  z.object({ bodyId: z.string(), kind: z.literal("body") }),
  z.object({
    documentId: z.string().min(1).max(128),
    kind: z.literal("document"),
  }),
  z.object({
    componentId: z.string().min(1).max(128),
    kind: z.literal("component"),
  }),
]);

/** Builds the door's typed source form from the schema-parsed input. */
function occurrenceSourceOf(
  source: z.output<typeof occurrenceSourceSchema>,
): OccurrenceSource {
  switch (source.kind) {
    case "body":
      return { bodyId: createBodyId(source.bodyId), kind: "body" };
    case "component":
      return { componentId: source.componentId, kind: "component" };
    case "document":
      return { documentId: source.documentId, kind: "document" };
  }
}

/**
 * The mutable-document guard every mutator runs first: total and honest
 * even if a mutator were ever minted on a read-only page.
 */
function requireCommit(
  surface: AssemblyWebMcpSurface,
): ((next: CadDocument) => void) | ToolRefusal {
  const commit = surface.commit;
  if (commit === null) {
    return refusal(
      ASSEMBLY_READONLY,
      "This page's assembly document is read-only; the mutation tools are not available here.",
    );
  }
  return commit;
}

/** The pattern stamp's outcome: the landed sibling ids, or a refusal. */
type PatternOutcome =
  | ToolRefusal
  | {
      readonly ok: true;
      readonly added: readonly string[];
      readonly occurrenceCount: number;
      readonly patternKind: string;
    };

/**
 * Stamps one resolved pattern ATOMICALLY: the resolver's placements compute
 * first (its structured `assembly/pattern-*` refusal maps verbatim), then
 * every sibling occurrence adds through the document door in one fold — a
 * refusal anywhere applies NOTHING (the pattern buttons stamp through the
 * same fold; this tool adds the all-or-nothing guarantee).
 */
function stampPattern(
  surface: AssemblyWebMcpSurface,
  commit: (next: CadDocument) => void,
  seed: DocumentOccurrence,
  namePrefix: string | undefined,
  request: {
    readonly patternKind: "linear" | "circular" | "mirror";
    readonly placements: ParseResult<
      readonly PlacementTransform[],
      AssemblyPatternError
    >;
  },
): PatternOutcome {
  if (!request.placements.ok) return refusalFromError(request.placements.error);
  let working = surface.document();
  const added: string[] = [];
  for (const [index, placement] of request.placements.value.entries()) {
    const next = addOccurrence(working, {
      name: `${namePrefix ?? seed.name} ${request.patternKind} ${String(index + 1)}`,
      placement: {
        kind: "offset",
        translation: [
          placement.translation[0],
          placement.translation[1],
          placement.translation[2],
        ],
      },
      source: seed.source,
    });
    if (!next.ok) return refusalFromError(next.error);
    working = next.value.document;
    added.push(String(next.value.occurrence.id));
  }
  commit(working);
  return {
    added,
    occurrenceCount: working.occurrences.length,
    ok: true,
    patternKind: request.patternKind,
  };
}

/**
 * Builds the assembly tool set from one live surface. Reads mint always;
 * the seven mutators mint only when `commit` is present (see the surface
 * docs). The id fields are optional explicit ids — absent means the
 * document's own id generator mints the next one.
 */
export function createAssemblyWebMcpTools(
  surface: AssemblyWebMcpSurface,
): readonly WebMcpToolEntry[] {
  const documentTool = defineWebMcpTool({
    annotations: { readOnlyHint: true },
    description:
      "Read a compact, model-oriented outline of the assembly document: bodies, features, $-variables, and — the assembly heart — the occurrence tree records (ids, names, source kinds/names, BOM flags, placements), the mate records, and the joint records. Outline shapes, never full geometry; the workbench-complete page exposes the same tool over its own store.",
    inputSchema: z.object({}),
    name: "cad_get_document",
    execute: () => ({
      ...documentOutline(surface.document()),
      ok: true,
    }),
  });

  const diagnosticsTool = defineWebMcpTool({
    annotations: { readOnlyHint: true },
    description:
      "Read the assembly's structured diagnostics: the mate-solve read over the document's mate/joint records — solve status, assembly/mate-* diagnostics (an anchor-less solve reports the solver's own honest assembly/mate-unresolved until the executor's topology seam exists), residual, system DOF — plus the joints' DOF accounting and the record counts.",
    inputSchema: z.object({}),
    name: "cad_get_diagnostics",
    execute: () => {
      const assembly = assemblyDiagnostics(surface.document());
      if (!assembly.ok) return refusal(assembly.code, assembly.message);
      return { assembly, ok: true };
    },
  });

  const interferenceTool = defineWebMcpTool({
    annotations: { readOnlyHint: true },
    description:
      "Run the interference and clearance batches over the resolved assembly: every overlapping occurrence pair with its intersection volume (mm³) and world bounds, every checked pair's sampled minimum distance (mm), and the pairs the kernel seam declined. Reads the page's own geometry seams — the same bounds/kernel binding the interference report panel renders; refused structurally on a page without them.",
    inputSchema: z.object({}),
    name: "cad_assembly_check_interference",
    execute: () => {
      const seams = surface.interference;
      if (seams === null) {
        return refusal(
          INTERFERENCE_UNAVAILABLE,
          "This page carries no interference geometry seams (local bounds, intersection kernel, clearance meshes); the batch refuses to guess them.",
        );
      }
      const document = surface.document();
      const resolution = resolveAssemblyInstances(document, {
        document: (documentId) =>
          surface.resolveDocument?.(documentId) ?? undefined,
      });
      if (!resolution.ok) {
        return refusalFromError(resolution.error);
      }
      const report = checkResolvedAssemblyInterference({
        boundsOf: seams.boundsOf,
        instances: resolution.instances,
        intersectVolume: seams.intersectVolume,
        tolerance: INTERFERENCE_TOLERANCE_MM3,
      });
      if (!report.ok) return refusalFromError(report.error);
      const clearanceInstances: ClearanceInstance[] = [];
      for (const instance of resolution.instances) {
        const mesh = seams.meshOf(instance.bodyId);
        if (mesh === undefined) {
          return refusal(
            RESOLUTION_FAILED,
            `No clearance mesh was supplied for body ${String(instance.bodyId)}; the clearance batch refuses to guess one.`,
          );
        }
        clearanceInstances.push({
          bodyId: instance.bodyId,
          mesh,
          path: instance.path,
          transform: instance.transform,
        });
      }
      const pairs: (readonly [number, number])[] = [];
      for (let i = 0; i < clearanceInstances.length; i += 1) {
        for (let j = i + 1; j < clearanceInstances.length; j += 1) {
          pairs.push([i, j]);
        }
      }
      const clearances = checkAssemblyClearances({
        instances: clearanceInstances,
        pairs,
      });
      if (!clearances.ok) return refusalFromError(clearances.error);
      return {
        checkedPairs: report.value.checkedPairs,
        clearances: clearances.value.clearances.map((clearance) => ({
          clearanceMm: clearance.distance,
          first: clearance.firstPath.map(String),
          second: clearance.secondPath.map(String),
        })),
        ok: true,
        pairs: report.value.pairs.map((pair) => ({
          first: pair.firstPath.map(String),
          firstBoundsMm: pair.firstBounds,
          firstBodyId: String(pair.firstBodyId),
          second: pair.secondPath.map(String),
          secondBoundsMm: pair.secondBounds,
          secondBodyId: String(pair.secondBodyId),
          volumeMm3: pair.volume,
        })),
        precision: clearances.value.precision,
        skipped: report.value.skipped.map((pair) => ({
          first: pair.firstPath.map(String),
          reason: pair.reason,
          second: pair.secondPath.map(String),
        })),
        toleranceMm3: report.value.tolerance,
      };
    },
  });

  if (surface.commit === null) {
    return [documentTool, diagnosticsTool, interferenceTool];
  }

  const mutators = [
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Add one component occurrence to the assembly — the same document door the page's Add-instance button drives. The source addresses a body of this document, another document by its persistence id, or a registry component; an offset translation places it (absent = identity). The door re-validates everything: names (1-64 chars), body sources must exist, BOM flags must be declared.",
      inputSchema: z.object({
        bomFlag: z.enum(occurrenceBomFlags).optional(),
        name: z.string().min(1).max(64),
        occurrenceId: z
          .string()
          .optional()
          .describe(
            "an explicit occurrence id (occ_ prefix); omitted mints the next generated one",
          ),
        source: occurrenceSourceSchema,
        translation: vec3Schema
          .optional()
          .describe("the offset placement in mm; omitted places at identity"),
      }),
      name: "cad_assembly_add_occurrence",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const added = addOccurrence(surface.document(), {
          ...(input.occurrenceId === undefined
            ? {}
            : { id: createOccurrenceId(input.occurrenceId) }),
          ...(input.bomFlag === undefined ? {} : { bomFlag: input.bomFlag }),
          name: input.name,
          placement:
            input.translation === undefined
              ? undefined
              : { kind: "offset", translation: input.translation },
          source: occurrenceSourceOf(input.source),
        });
        if (!added.ok) return refusalFromError(added.error);
        commit(added.value.document);
        return {
          name: added.value.occurrence.name,
          occurrenceCount: added.value.document.occurrences.length,
          occurrenceId: String(added.value.occurrence.id),
          ok: true,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Remove one component occurrence by id — the door the page's Remove-instance button drives. Refused with the domain's own in-use code while any mate or joint still addresses the occurrence (drop those first).",
      inputSchema: z.object({
        occurrenceId: z.string(),
      }),
      name: "cad_assembly_remove_occurrence",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const removed = removeOccurrence(
          surface.document(),
          createOccurrenceId(input.occurrenceId),
        );
        if (!removed.ok) return refusalFromError(removed.error);
        commit(removed.value);
        return {
          occurrenceCount: removed.value.occurrences.length,
          ok: true,
          removed: input.occurrenceId,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Stamp a component pattern: resolve the seed occurrence's placement through the domain's own pattern resolvers, then add the generated sibling occurrences — the same machinery the pattern buttons drive. linear steps the seed along a UNIT direction by spacingMm; circular rotates it about a datum axis (UNIT direction, right-hand rule) by angleStepDeg each; mirror reflects it across a plane (UNIT normal). Vectors must be unit length and counts whole numbers; the resolver's structured refusals come back verbatim. Stamped placements are translation offsets (the document placement vocabulary's own form).",
      inputSchema: z
        .object({
          circular: z
            .object({
              angleStepDeg: z.number().refine((step) => step !== 0, {
                message: "The angle step must be non-zero degrees.",
              }),
              axisDirection: vec3Schema,
              axisOrigin: vec3Schema,
              count: patternCountSchema,
            })
            .optional(),
          kind: z.enum(["linear", "circular", "mirror"]),
          linear: z
            .object({
              count: patternCountSchema,
              direction: vec3Schema,
              spacingMm: z.number().positive(),
            })
            .optional(),
          mirror: z
            .object({ planeNormal: vec3Schema, planeOrigin: vec3Schema })
            .optional(),
          namePrefix: z.string().min(1).max(40).optional(),
          seedOccurrenceId: z.string(),
        })
        .superRefine((pattern, ctx) => {
          const carried =
            pattern.kind === "linear"
              ? pattern.linear
              : pattern.kind === "circular"
                ? pattern.circular
                : pattern.mirror;
          if (carried === undefined) {
            ctx.addIssue({
              code: "custom",
              message: `A ${pattern.kind} pattern needs its "${pattern.kind}" parameters.`,
            });
          }
        }),
      name: "cad_assembly_pattern",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const document = surface.document();
        const seed = document.occurrences.find(
          (occurrence) => String(occurrence.id) === input.seedOccurrenceId,
        );
        if (seed === undefined) {
          return refusal(
            OCCURRENCE_UNKNOWN,
            `No occurrence "${input.seedOccurrenceId}" exists in this document (see cad_get_document).`,
          );
        }
        const seedPlacement = resolveOccurrencePlacement(
          seed.placement,
          document.datums,
        );
        if (!seedPlacement.ok) {
          return refusalFromError(seedPlacement.error);
        }
        // The superRefine guarantees exactly the kind's parameters are
        // present; the guard keeps the narrowing total and honest (a
        // violation turns into the registry's structured tool-failure,
        // never an agent-visible crash — the capture tool's own rule).
        if (input.kind === "linear") {
          if (input.linear === undefined) {
            throw new RangeError(
              "A linear pattern needs its linear parameters.",
            );
          }
          return stampPattern(surface, commit, seed, input.namePrefix, {
            placements: resolveLinearOccurrencePattern({
              count: input.linear.count,
              direction: input.linear.direction,
              seed: seedPlacement.value,
              spacingMm: input.linear.spacingMm,
            }),
            patternKind: "linear",
          });
        }
        if (input.kind === "circular") {
          if (input.circular === undefined) {
            throw new RangeError(
              "A circular pattern needs its circular parameters.",
            );
          }
          return stampPattern(surface, commit, seed, input.namePrefix, {
            placements: resolveCircularOccurrencePattern({
              angleStepDeg: input.circular.angleStepDeg,
              axisDirection: input.circular.axisDirection,
              axisOrigin: input.circular.axisOrigin,
              count: input.circular.count,
              seed: seedPlacement.value,
            }),
            patternKind: "circular",
          });
        }
        if (input.mirror === undefined) {
          throw new RangeError("A mirror pattern needs its mirror parameters.");
        }
        const mirrored = resolveMirroredOccurrencePlacement({
          planeNormal: input.mirror.planeNormal,
          planeOrigin: input.mirror.planeOrigin,
          seed: seedPlacement.value,
        });
        return stampPattern(surface, commit, seed, input.namePrefix, {
          // The mirror resolver answers ONE placement; the stamp fold takes
          // the singleton array.
          placements: mirrored.ok
            ? { ok: true as const, value: [mirrored.value] }
            : mirrored,
          patternKind: "mirror",
        });
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Add one assembly mate record — the Phase 51 door. Each endpoint addresses an occurrence of this document plus a persistent reference record id that must already exist (mint references through the document's own reference paths first); the two occurrences must differ. distance mates carry a value in mm, angle mates in degrees; every other kind takes none. Follow with cad_get_diagnostics for the mate-solve read.",
      inputSchema: z.object({
        first: z.object({ occurrenceId: z.string(), referenceId: z.string() }),
        kind: z.enum(MATE_KINDS),
        mateId: z
          .string()
          .optional()
          .describe(
            "an explicit mate id (mat_ prefix); omitted mints the next generated one",
          ),
        name: z.string().min(1).max(64),
        second: z.object({ occurrenceId: z.string(), referenceId: z.string() }),
        value: z.number().nonnegative().optional(),
      }),
      name: "cad_assembly_add_mate",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const added = addMate(surface.document(), {
          first: {
            occurrenceId: createOccurrenceId(input.first.occurrenceId),
            referenceId: createReferenceId(input.first.referenceId),
          },
          ...(input.mateId === undefined
            ? {}
            : { id: createMateId(input.mateId) }),
          kind: input.kind,
          name: input.name,
          second: {
            occurrenceId: createOccurrenceId(input.second.occurrenceId),
            referenceId: createReferenceId(input.second.referenceId),
          },
          ...(input.value === undefined ? {} : { value: input.value }),
        });
        if (!added.ok) return refusalFromError(added.error);
        commit(added.value.document);
        return {
          kind: added.value.mate.kind,
          mateCount: added.value.document.mates.length,
          mateId: String(added.value.mate.id),
          name: added.value.mate.name,
          ok: true,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Remove one assembly mate record by id (the Phase 51 door's structured not-found refusal otherwise).",
      inputSchema: z.object({ mateId: z.string() }),
      name: "cad_assembly_remove_mate",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const removed = removeMate(
          surface.document(),
          createMateId(input.mateId),
        );
        if (!removed.ok) return refusalFromError(removed.error);
        commit(removed.value);
        return {
          mateCount: removed.value.mates.length,
          ok: true,
          removed: input.mateId,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Add one assembly joint record — the Phase 51 motion door. The joint mobilizes one occurrence relative to a base occurrence (they must differ); axis-bearing kinds (revolute, slider, cylindrical, planar) require a frame with a finite origin and a non-zero finite axis, ball takes the origin only, rigid takes no frame at all. The kind's remaining DOF table is what cad_get_diagnostics reports.",
      inputSchema: z.object({
        baseOccurrenceId: z.string(),
        frame: z
          .object({ axis: vec3Schema.optional(), origin: vec3Schema })
          .optional(),
        jointId: z
          .string()
          .optional()
          .describe(
            "an explicit joint id (jnt_ prefix); omitted mints the next generated one",
          ),
        kind: z.enum(JOINT_KINDS),
        name: z.string().min(1).max(64),
        occurrenceId: z.string(),
      }),
      name: "cad_assembly_add_joint",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const added = addJoint(surface.document(), {
          baseOccurrenceId: createOccurrenceId(input.baseOccurrenceId),
          ...(input.frame === undefined
            ? {}
            : {
                frame: {
                  origin: input.frame.origin,
                  ...(input.frame.axis === undefined
                    ? {}
                    : { axis: input.frame.axis }),
                },
              }),
          ...(input.jointId === undefined
            ? {}
            : { id: createJointId(input.jointId) }),
          kind: input.kind,
          name: input.name,
          occurrenceId: createOccurrenceId(input.occurrenceId),
        });
        if (!added.ok) return refusalFromError(added.error);
        commit(added.value.document);
        return {
          jointCount: added.value.document.joints.length,
          jointId: String(added.value.joint.id),
          kind: added.value.joint.kind,
          name: added.value.joint.name,
          ok: true,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Remove one assembly joint record by id (the Phase 51 door's structured not-found refusal otherwise).",
      inputSchema: z.object({ jointId: z.string() }),
      name: "cad_assembly_remove_joint",
      execute: (input) => {
        const commit = requireCommit(surface);
        if ("ok" in commit) return commit;
        const removed = removeJoint(
          surface.document(),
          createJointId(input.jointId),
        );
        if (!removed.ok) return refusalFromError(removed.error);
        commit(removed.value);
        return {
          jointCount: removed.value.joints.length,
          ok: true,
          removed: input.jointId,
        };
      },
    }),
  ];

  return [documentTool, diagnosticsTool, ...mutators, interferenceTool];
}

/**
 * The assembly pages' mount: registers the tool set for the page's
 * lifetime, reading the LIVE document, commit door, resolution seam, and
 * interference seams. `commit`'s presence at mount decides the set (a
 * read-only page mounts the reads only); document accessors stay live
 * through the ref, exactly like the workbench mount.
 */
export function useAssemblyWebMcpTools(surface: AssemblyWebMcpSurface): void {
  const live = useRef(surface);
  useEffect(() => {
    live.current = surface;
  });
  const [entries] = useState(() =>
    createAssemblyWebMcpTools({
      commit: surface.commit,
      document: () => live.current.document(),
      interference: surface.interference,
      resolveDocument: surface.resolveDocument,
    }),
  );
  useWebMcpTools(entries);
}
