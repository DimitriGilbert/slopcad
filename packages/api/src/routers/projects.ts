/**
 * The projects router (Phase 31): every procedure is a
 * `protectedProcedure` and every read/write scopes by the session user's
 * ownership — a project row is reachable only through
 * `ownerId === ctx.session.user.id`, so another user's project is
 * structurally invisible (NOT_FOUND, never a leak of existence through
 * content).
 */

import { randomUUID } from "node:crypto";
import { type SlopcadDatabase } from "@slopcad/db";
import {
  document as documentTable,
  project as projectTable,
} from "@slopcad/db/schema/projects";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "../limits";

/** The wire form of a project row: timestamps as ISO strings. */
export interface ProjectDto {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A project row with its document count (the list's one summary number). */
export interface ProjectSummaryDto extends ProjectDto {
  readonly documentCount: number;
}

export function toProjectDto(
  row: typeof projectTable.$inferSelect,
): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const projectIdInput = z.object({ projectId: z.string().min(1) });

export function createProjectsRouter(deps: { readonly db: SlopcadDatabase }) {
  const { db } = deps;
  return {
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await db
        .select()
        .from(projectTable)
        .where(eq(projectTable.ownerId, ctx.session.user.id))
        .orderBy(desc(projectTable.updatedAt));
      const documentCounts = await db
        .select({
          projectId: documentTable.projectId,
          documents: count(),
        })
        .from(documentTable)
        .innerJoin(
          projectTable,
          and(
            eq(documentTable.projectId, projectTable.id),
            eq(projectTable.ownerId, ctx.session.user.id),
          ),
        )
        .groupBy(documentTable.projectId);
      const countByProject = new Map(
        documentCounts.map((row) => [row.projectId, row.documents]),
      );
      const summaries: ProjectSummaryDto[] = rows.map((row) => ({
        ...toProjectDto(row),
        documentCount: countByProject.get(row.id) ?? 0,
      }));
      return summaries;
    }),
    create: protectedProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(PROJECT_NAME_MAX_LENGTH),
          description: z
            .string()
            .trim()
            .max(PROJECT_DESCRIPTION_MAX_LENGTH)
            .optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const inserted = await db
          .insert(projectTable)
          .values({
            id: randomUUID(),
            ownerId: ctx.session.user.id,
            name: input.name,
            description: input.description ?? null,
          })
          .returning();
        if (inserted[0] === undefined) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "The project insert returned no row.",
          });
        }
        return toProjectDto(inserted[0]);
      }),
    get: protectedProcedure
      .input(projectIdInput)
      .query(async ({ ctx, input }) => {
        const found = await db
          .select()
          .from(projectTable)
          .where(
            and(
              eq(projectTable.id, input.projectId),
              eq(projectTable.ownerId, ctx.session.user.id),
            ),
          )
          .limit(1);
        const row = found[0];
        if (row === undefined) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Project not found",
          });
        }
        return toProjectDto(row);
      }),
  };
}
