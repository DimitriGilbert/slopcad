/**
 * The three projects WebMCP tools against injectable surfaces: the tRPC
 * DTOs the pages' own queries return, the create mutation's input
 * contract, and the navigation targets the project card and the Open
 * button link to. Plus one integration mount: the REAL provider stack the
 * router applies (query client + tRPC + a memory router) with the hook
 * registered for its lifetime.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@slopcad/api/routers/index";
import type { DocumentSummaryDto } from "@slopcad/api/routers/documents";
import type {
  ProjectDto,
  ProjectSummaryDto,
} from "@slopcad/api/routers/projects";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProjectsWebMcpTools,
  useProjectsWebMcpTools,
  type ProjectsWebMcpSurface,
} from "./projects-tools";
import {
  executeWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
  webMcpToolSnapshot,
} from "./registry";
import { bindWebMcpTools } from "./use-webmcp-tools";

import { TRPCProvider } from "@/utils/trpc";

/** The structured outcome of driving one tool through the registry. */
type ToolRun =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The three tool names, in registration order. */
const TOOL_NAMES = [
  "projects_list",
  "projects_create",
  "open_document",
] as const;

/** The projects the list tests serve (the list query's newest-first shape). */
const PROJECTS: readonly ProjectSummaryDto[] = [
  {
    createdAt: "2026-09-28T10:00:00.000Z",
    description: "one-session e2e",
    documentCount: 1,
    id: "prj_session",
    name: "Session journey",
    updatedAt: "2026-09-28T12:00:00.000Z",
  },
  {
    createdAt: "2026-09-27T09:00:00.000Z",
    description: null,
    documentCount: 0,
    id: "prj_empty",
    name: "Empty bench",
    updatedAt: "2026-09-27T09:00:00.000Z",
  },
];

/** The session project's documents (the detail page's query shape). */
const DOCUMENTS: readonly DocumentSummaryDto[] = [
  {
    createdAt: "2026-09-28T10:30:00.000Z",
    id: "doc_plate",
    latestVersion: 2,
    name: "session-plate",
    projectId: "prj_session",
    updatedAt: "2026-09-28T11:30:00.000Z",
    versionCount: 2,
  },
];

/** The create result the mutation would return for a fresh project. */
function createdProject(name: string): ProjectDto {
  return {
    createdAt: "2026-09-29T09:00:00.000Z",
    description: null,
    id: "prj_new",
    name,
    updatedAt: "2026-09-29T09:00:00.000Z",
  };
}

/** A recording fake of one projects surface. */
interface SurfaceSpy {
  readonly surface: ProjectsWebMcpSurface;
  readonly createdInputs: () => readonly {
    readonly name: string;
    readonly description?: string | undefined;
  }[];
  readonly openedDocument: () => string | null;
  readonly openedProject: () => string | null;
}

/** The default spy: successful reads, spied writes and navigation. */
function spySurface(options?: { readonly failList?: boolean }): SurfaceSpy {
  const createdInputs: {
    readonly name: string;
    readonly description?: string | undefined;
  }[] = [];
  let openedDocument: string | null = null;
  let openedProject: string | null = null;
  return {
    createdInputs: () => createdInputs,
    openedDocument: () => openedDocument,
    openedProject: () => openedProject,
    surface: {
      createProject: (input) => {
        createdInputs.push(input);
        return Promise.resolve(createdProject(input.name));
      },
      listDocuments: (projectId) => {
        if (projectId !== "prj_session") {
          return Promise.reject(new Error("Project not found"));
        }
        return Promise.resolve(DOCUMENTS);
      },
      listProjects: () => {
        if (options?.failList === true) {
          return Promise.reject(new Error("UNAUTHORIZED"));
        }
        return Promise.resolve(PROJECTS);
      },
      openDocument: (documentId) => {
        openedDocument = documentId;
      },
      openProject: (projectId) => {
        openedProject = projectId;
      },
    },
  };
}

/** Binds the three tools over one surface. */
function bindTools(surface: ProjectsWebMcpSurface): () => void {
  return bindWebMcpTools(createProjectsWebMcpTools(surface));
}

/**
 * Drives one tool with raw JSON input through the registry boundary. The
 * tool's DOMAIN refusals (`{ ok: false, code, message }`) are tool RESULTS
 * — the registry stringifies whatever a handler returns (the spec's
 * DOMString), so they surface here as refusals; only boundary failures
 * (unknown tool, schema-invalid input, handler throw) fail at the registry.
 */
async function runTool(name: string, input: unknown): Promise<ToolRun> {
  const outcome = await executeWebMcpTool(name, input, {
    signal: new AbortController().signal,
  });
  if (!outcome.ok) {
    return { code: outcome.code, message: outcome.message, ok: false };
  }
  const payload: unknown = JSON.parse(outcome.result);
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { readonly ok?: unknown }).ok === false
  ) {
    const refusal = payload as {
      readonly code: string;
      readonly message: string;
    };
    return { code: refusal.code, message: refusal.message, ok: false };
  }
  return { ok: true, payload };
}

afterEach(() => {
  cleanup();
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
});

describe("projects_list", () => {
  it("returns the list query's summaries: id, name, description, documents, update", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("projects_list", {});
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toEqual({
        ok: true,
        projects: [
          {
            description: "one-session e2e",
            documentCount: 1,
            id: "prj_session",
            name: "Session journey",
            updatedAt: "2026-09-28T12:00:00.000Z",
          },
          {
            description: null,
            documentCount: 0,
            id: "prj_empty",
            name: "Empty bench",
            updatedAt: "2026-09-27T09:00:00.000Z",
          },
        ],
      });
    }
    unbind();
  });

  it("refuses honestly when the tRPC call fails", async () => {
    const spy = spySurface({ failList: true });
    const unbind = bindTools(spy.surface);
    const run = await runTool("projects_list", {});
    expect(run).toMatchObject({
      code: "projects/request-failed",
      ok: false,
    });
    if (!run.ok) expect(run.message).toContain("UNAUTHORIZED");
    unbind();
  });
});

describe("projects_create", () => {
  it("submits through the create mutation and returns the created project id", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("projects_create", {
      description: "agent-made",
      name: "Bracket redesign",
    });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toMatchObject({
        name: "Bracket redesign",
        ok: true,
        projectId: "prj_new",
      });
    }
    expect(spy.createdInputs()).toEqual([
      { description: "agent-made", name: "Bracket redesign" },
    ]);
    unbind();
  });

  it("trims the name through the form's own schema and omits a missing description", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("projects_create", { name: "  Bracket  " });
    expect(run.ok).toBe(true);
    expect(spy.createdInputs()).toEqual([
      { description: undefined, name: "Bracket" },
    ]);
    unbind();
  });

  it("refuses an empty name at the schema, never reaching the mutation", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("projects_create", { name: "   " });
    expect(run).toMatchObject({ code: "webmcp/invalid-input", ok: false });
    expect(spy.createdInputs()).toEqual([]);
    unbind();
  });
});

describe("open_document", () => {
  it("navigates to the document's workbench route — the Open button's target", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("open_document", {
      documentId: "doc_plate",
      projectId: "prj_session",
    });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toEqual({
        documentId: "doc_plate",
        navigatedTo: "/documents/doc_plate",
        ok: true,
        opened: "document",
        projectId: "prj_session",
      });
    }
    expect(spy.openedDocument()).toBe("doc_plate");
    expect(spy.openedProject()).toBe(null);
    unbind();
  });

  it("without a documentId, opens the project page and lists its documents", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("open_document", { projectId: "prj_session" });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toEqual({
        documents: [
          {
            documentId: "doc_plate",
            latestVersion: 2,
            name: "session-plate",
            updatedAt: "2026-09-28T11:30:00.000Z",
            versionCount: 2,
          },
        ],
        navigatedTo: "/projects/prj_session",
        ok: true,
        opened: "project",
      });
    }
    expect(spy.openedProject()).toBe("prj_session");
    expect(spy.openedDocument()).toBe(null);
    unbind();
  });

  it("refuses an unknown project without navigating", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("open_document", { projectId: "prj_nope" });
    expect(run).toMatchObject({
      code: "projects/request-failed",
      ok: false,
    });
    if (!run.ok) expect(run.message).toContain("Project not found");
    expect(spy.openedProject()).toBe(null);
    unbind();
  });

  it("requires the projectId at the schema", async () => {
    const spy = spySurface();
    const unbind = bindTools(spy.surface);
    const run = await runTool("open_document", {});
    expect(run).toMatchObject({ code: "webmcp/invalid-input", ok: false });
    unbind();
  });
});

describe("registration shape", () => {
  it("carries the three names with honest annotations and object schemas", () => {
    const unbind = bindTools(spySurface().surface);
    expect(webMcpToolNames()).toEqual([...TOOL_NAMES]);
    const snapshot = webMcpToolSnapshot();
    expect(snapshot.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of snapshot) {
      expect((tool.inputSchema as { readonly type?: string }).type).toBe(
        "object",
      );
    }
    const byName = new Map(snapshot.map((tool) => [tool.name, tool]));
    expect(byName.get("projects_list")?.annotations).toEqual({
      readOnlyHint: true,
    });
    expect(byName.get("projects_create")?.annotations).toEqual({
      consequentialHint: true,
    });
    expect(byName.get("open_document")?.annotations).toEqual({
      consequentialHint: true,
    });
    unbind();
  });
});

describe("the projects mount (real providers)", () => {
  /** The page-shaped harness: the hook mounted under the providers. */
  function MountHarness(): ReactElement {
    useProjectsWebMcpTools();
    return <div data-testid="projects-webmcp-harness" />;
  }

  /** The router composition the hook needs: navigate inside a router. */
  function renderHarness(): { readonly unmount: () => void } {
    const queryClient = new QueryClient();
    const trpcClient = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: "/api/trpc" })],
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({ component: MountHarness }),
    });
    const mounted = render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <RouterProvider router={router} />
        </TRPCProvider>
      </QueryClientProvider>,
    );
    return { unmount: mounted.unmount };
  }

  it("registers all three tools for the mount and unregisters on unmount", async () => {
    const { unmount } = renderHarness();
    // The router resolves its initial match asynchronously; wait for the
    // harness (and with it the mount effect) to land.
    await waitFor(() => expect(webMcpToolNames()).toEqual([...TOOL_NAMES]));
    expect(window.__slopcadWebMcpTools?.().map((tool) => tool.name)).toEqual([
      ...TOOL_NAMES,
    ]);
    unmount();
    expect(webMcpToolNames()).toEqual([]);
  });
});
