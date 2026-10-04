/**
 * The projects surface's WebMCP tools (Phase 8): the three workspace tools
 * the authenticated projects/dashboard pages expose to browser-resident AI
 * agents through the WebMCP binding. Every handler drives ONLY existing
 * client paths — the SAME tRPC procedures and router routes the pages'
 * queries, forms, and buttons use — so an agent action and a user action
 * are one write path:
 *
 * - `projects_list` — `queryClient.fetchQuery(trpc.projects.list...)`, the
 *   imperative read the drawing workbench's save path uses; the same
 *   procedure `useQuery(trpc.projects.list.queryOptions())` serves both
 *   the projects page and the dashboard.
 * - `projects_create` — the page's own `trpc.projects.create` mutation
 *   wiring: list invalidation and the toast included, so an agent-created
 *   project lands exactly like a form-created one (the submit path is the
 *   Formedible form's `onSubmitted` → `createMutation.mutateAsync`).
 * - `open_document` — `queryClient.fetchQuery(trpc.documents.list...)`
 *   plus `navigate()` to the exact routes the project card
 *   (`/projects/$projectId`) and the document row's Open button
 *   (`/documents/$documentId`) link to.
 *
 * Like the workbench set, the entries read LIVE state through accessor
 * functions (the tRPC proxy, query client, and mutation are re-derived
 * every render); the entries themselves — and their spec registration —
 * are minted once per mount.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { DocumentSummaryDto } from "@slopcad/api/routers/documents";
import type {
  ProjectDto,
  ProjectSummaryDto,
} from "@slopcad/api/routers/projects";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { WebMcpToolEntry } from "./registry";

import { defineWebMcpTool } from "./registry";
import { useWebMcpTools } from "./use-webmcp-tools";

import { createProjectSchema } from "@/cad-projects/project-forms";
import { useTRPC } from "@/utils/trpc";

/**
 * The narrow live surface the tools drive: the projects pages' own tRPC
 * reads/writes and the router's navigation. Accessors keep the
 * once-minted entries honest.
 */
export interface ProjectsWebMcpSurface {
  /** The signed-in user's projects, newest first (the list query's shape). */
  readonly listProjects: () => Promise<readonly ProjectSummaryDto[]>;
  /** The create mutation the New project form submits through. */
  readonly createProject: (input: {
    readonly name: string;
    readonly description?: string | undefined;
  }) => Promise<ProjectDto>;
  /** One project's documents, newest first (the detail page's query). */
  readonly listDocuments: (
    projectId: string,
  ) => Promise<readonly DocumentSummaryDto[]>;
  /** Navigate to the project page (the project card's link target). */
  readonly openProject: (projectId: string) => void;
  /** Navigate to the document workbench (the Open button's target). */
  readonly openDocument: (documentId: string) => void;
}

/** The structured refusal every handler returns instead of throwing. */
interface ToolRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

/** The refusal code when one of the tRPC calls fails (session, network). */
const REQUEST_FAILED = "projects/request-failed";

/** A refusal, the one shape handlers never throw. */
function refusal(code: string, message: string): ToolRefusal {
  return { code, message, ok: false };
}

/** Runs one tRPC-backed call, converting a client failure into a refusal. */
async function callOrFail<T>(
  run: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | ToolRefusal> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return refusal(
      REQUEST_FAILED,
      `The tRPC call failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The document records the open tool reports: identity and save history. */
function documentSummaries(documents: readonly DocumentSummaryDto[]) {
  return documents.map((document) => ({
    documentId: document.id,
    latestVersion: document.latestVersion,
    name: document.name,
    updatedAt: document.updatedAt,
    versionCount: document.versionCount,
  }));
}

/**
 * Builds the three projects tool entries from one live surface. Called
 * once per mount (the entries read through the surface's accessors, so
 * once-minted entries stay current).
 */
export function createProjectsWebMcpTools(
  surface: ProjectsWebMcpSurface,
): readonly WebMcpToolEntry[] {
  return [
    defineWebMcpTool({
      annotations: { readOnlyHint: true },
      description:
        "List the signed-in user's projects — id, name, description, document count, and last update, newest first — the same projects.list result the projects page and the dashboard render.",
      inputSchema: z.object({}),
      name: "projects_list",
      execute: async () => {
        const result = await callOrFail(() => surface.listProjects());
        if (!result.ok) return result;
        return {
          ok: true,
          projects: result.value.map((project) => ({
            description: project.description,
            documentCount: project.documentCount,
            id: project.id,
            name: project.name,
            updatedAt: project.updatedAt,
          })),
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Create a project — the same projects.create mutation the New project form submits (name trimmed and required, description optional). The projects list is invalidated and the page's own toast fires, so an agent-created project lands exactly like a form-created one. Returns the created project's id.",
      inputSchema: createProjectSchema,
      name: "projects_create",
      execute: async (input) => {
        const result = await callOrFail(() => surface.createProject(input));
        if (!result.ok) return result;
        return {
          name: result.value.name,
          ok: true,
          projectId: result.value.id,
        };
      },
    }),
    defineWebMcpTool({
      annotations: { consequentialHint: true },
      description:
        "Open a project's document in the workbench — the same navigation the project page's links perform. With documentId: navigates to the document's workbench route (the Open button's target). Without: navigates to the project page (the project card's target) and returns the project's documents, so the agent can pick one and call again.",
      inputSchema: z.object({
        documentId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "the document to open (omit to list the project's documents)",
          ),
        projectId: z
          .string()
          .min(1)
          .describe("the project that owns the document"),
      }),
      name: "open_document",
      execute: async (input) => {
        if (input.documentId === undefined) {
          const result = await callOrFail(() =>
            surface.listDocuments(input.projectId),
          );
          if (!result.ok) return result;
          surface.openProject(input.projectId);
          return {
            documents: documentSummaries(result.value),
            navigatedTo: `/projects/${input.projectId}`,
            ok: true,
            opened: "project",
          };
        }
        surface.openDocument(input.documentId);
        return {
          documentId: input.documentId,
          navigatedTo: `/documents/${input.documentId}`,
          ok: true,
          opened: "document",
          projectId: input.projectId,
        };
      },
    }),
  ];
}

/**
 * The projects/dashboard mount: registers the three tools for the page's
 * lifetime, wiring them to the pages' own live clients — the tRPC options
 * proxy, the shared query client, the router's navigate, and the create
 * mutation with the projects page's exact invalidation and toast wiring.
 * One call from each authenticated page — no restructuring, no extra
 * surfaces.
 */
export function useProjectsWebMcpTools(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createMutation = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryOptions().queryKey,
        });
        toast.success(`Project "${created.name}" created`);
      },
      onError: (error) => {
        toast.error(`Project refused: ${error.message}`);
      },
    }),
  );
  // The latest clients: handlers read through this ref because the
  // entries (and their spec registration) are minted once per mount.
  const live = useRef({ createMutation, navigate, queryClient, trpc });
  useEffect(() => {
    live.current = { createMutation, navigate, queryClient, trpc };
  });
  const [entries] = useState(() =>
    createProjectsWebMcpTools({
      createProject: (input) => live.current.createMutation.mutateAsync(input),
      listDocuments: (projectId) =>
        live.current.queryClient.fetchQuery(
          live.current.trpc.documents.list.queryOptions({ projectId }),
        ),
      listProjects: () =>
        live.current.queryClient.fetchQuery(
          live.current.trpc.projects.list.queryOptions(),
        ),
      openDocument: (documentId) => {
        void live.current.navigate({
          params: { documentId },
          to: "/documents/$documentId",
        });
      },
      openProject: (projectId) => {
        void live.current.navigate({
          params: { projectId },
          to: "/projects/$projectId",
        });
      },
    }),
  );
  useWebMcpTools(entries);
}
