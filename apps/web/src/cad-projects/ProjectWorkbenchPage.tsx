/**
 * The project workbench (Phase 31): the REAL workbench — the same engine,
 * the same composed layout, the same four CAD components — with the
 * persistence chrome the product needs around it. The bar is one honest
 * row ABOVE the command row (rendered through the layout's bar slot, so
 * the bare workbench's pinned DOM stays byte-identical):
 *
 * - OPEN — the document's latest saved version loads on mount through the
 *   tRPC documents API and enters the store through `replaceSession` (the
 *   store's one whole-session door); the scene follows the reopened
 *   document's newest solid feature, so the model is visible immediately;
 * - SAVE — serializes the live session through the native-document bridge
 *   (the format's canonical text; the server re-validates it with the
 *   format's own parser before it can become a version row) and appends
 *   exactly one `document_version`;
 * - HISTORY — the versions popover lists every persisted save; picking one
 *   loads that version's bytes through the same open path and PINS it (an
 *   explicit version choice survives background refetches of the latest
 *   pointer until the next save).
 *
 * The Save affordance is honest by construction: it is disabled until the
 * document's persisted state is known, and again the moment the live
 * document matches the last-saved document identity (the domain's
 * immutable values make dirty-tracking an identity check, not a diff).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { CadDocument } from "@slopcad/cad-core";
import { useCadDocument, useCadStore } from "@slopcad/cad-react";
import { Button } from "@slopcad/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@slopcad/ui/components/popover";
import { ArrowLeft, History, Save } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { WorkbenchLayout } from "../cad-workbench/CadWorkbenchPage";
import {
  useWorkbenchEngine,
  WorkbenchStoreProvider,
} from "../cad-workbench/workbench-engine";
import {
  parseNativeTextToSession,
  serializeSessionToNativeText,
} from "./native-document-bridge";

import { useTRPC } from "@/utils/trpc";

export function ProjectWorkbenchPage(): ReactElement {
  const { documentId } = useParams({
    from: "/_auth/documents/$documentId",
  });
  // The store is composed ONCE above the provider, exactly the workbench
  // page's structure; the body runs the engine and the layout.
  return (
    <WorkbenchStoreProvider>
      <ProjectWorkbenchMountGate documentId={documentId} />
    </WorkbenchStoreProvider>
  );
}

function ProjectWorkbenchMountGate({
  documentId,
}: {
  readonly documentId: string;
}): ReactElement | null {
  // The workbench is a client instrument — WebGL, worker execution, the
  // settle protocol — and every other workbench route behaves accordingly:
  // its engine never enters the server-rendered HTML, the browser builds
  // it. The mount gate keeps this page on that same contract (server shell
  // only, full tree on mount), which also keeps the auth-gated route off
  // the router's server-side lazy-retry path.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) {
    return null;
  }
  return <ProjectWorkbenchBody documentId={documentId} />;
}

function ProjectWorkbenchBody({
  documentId,
}: {
  readonly documentId: string;
}): ReactElement {
  const engine = useWorkbenchEngine({
    rootId: "workbench-root",
    statusId: "workbench-status",
    volumeId: "workbench-volume",
    errorId: "workbench-error",
  });
  return (
    <WorkbenchLayout
      engine={engine}
      bar={<PersistenceBar engine={engine} documentId={documentId} />}
    />
  );
}

/**
 * The bar's persistence milestones, kept in a ref: they gate effects and
 * identity comparisons and must not re-render the workbench.
 */
interface PersistenceMilestones {
  /** The persisted text the store mirrors; null before the first read, "" for a fresh document. */
  loadedFrom: string | null;
  /** The document identity last persisted or loaded (the dirty baseline). */
  savedDocument: CadDocument | null;
  /** The version ordinal live in the store (the loaded or just-saved one). */
  liveVersion: number;
  /** An explicit version choice is live; latest-pointer refetches must not displace it. */
  pinned: boolean;
}

function PersistenceBar({
  engine,
  documentId,
}: {
  readonly engine: ReturnType<typeof useWorkbenchEngine>;
  readonly documentId: string;
}): ReactElement {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const store = useCadStore("PersistenceBar");
  const { document } = useCadDocument();

  const documentQuery = useQuery(
    trpc.documents.get.queryOptions({ documentId }),
  );
  const versionsQuery = useQuery(
    trpc.documents.listVersions.queryOptions({ documentId }),
  );

  const milestonesRef = useRef<PersistenceMilestones>({
    loadedFrom: null,
    savedDocument: null,
    liveVersion: 0,
    pinned: false,
  });
  const [liveVersion, setLiveVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const applyContent = useCallback(
    (text: string, version: number, pinned: boolean) => {
      const parsed = parseNativeTextToSession(text);
      if (!parsed.ok) {
        toast.error(`The saved document failed to load: ${parsed.error}`);
        return;
      }
      store.replaceSession(parsed.session);
      engine.setActiveScene(parsed.scene);
      milestonesRef.current = {
        loadedFrom: text,
        savedDocument: parsed.document,
        liveVersion: version,
        pinned,
      };
      setLiveVersion(version);
      setLoaded(true);
    },
    [engine, store],
  );

  // OPEN: the latest persisted content enters the store exactly once per
  // distinct text; an explicit version pick (pinned) is never displaced by
  // a background refetch of the latest pointer.
  useEffect(() => {
    if (!documentQuery.isSuccess) return;
    const latest = documentQuery.data.latest;
    if (latest === null) {
      // A fresh document: the workbench boots from its authored starting
      // document; the first Save creates version 1.
      if (milestonesRef.current.loadedFrom === null) {
        milestonesRef.current = {
          ...milestonesRef.current,
          loadedFrom: "",
        };
        setLoaded(true);
      }
      return;
    }
    if (
      !milestonesRef.current.pinned &&
      milestonesRef.current.loadedFrom !== latest.nativeContent
    ) {
      applyContent(latest.nativeContent, latest.version, false);
    }
  }, [documentQuery.isSuccess, documentQuery.data, applyContent]);

  // SAVE: serialize the live session through the native bridge. The server
  // validates the payload with the same machinery before it becomes a
  // version row. The dispatch-time DOCUMENT identity rides the mutation's
  // context: `onSuccess` must compare against what was DISPATCHED, not what
  // the store holds at RESPONSE time — an edit that lands while the save is
  // in flight keeps the surface dirty afterwards (the old code snapshotted
  // the response-time document, silently marking that in-flight edit as
  // persisted when only the dispatched state reached the server).
  const saveMutation = useMutation(
    trpc.documents.save.mutationOptions({
      onMutate: () => ({
        dispatchedDocument: store.getSession().document,
      }),
      onSuccess: (result, variables, context) => {
        milestonesRef.current = {
          loadedFrom: variables.nativeContent,
          savedDocument: context.dispatchedDocument,
          liveVersion: result.version,
          pinned: false,
        };
        setLiveVersion(result.version);
        toast.success(`Saved as version ${String(result.version)}`);
        void queryClient.invalidateQueries({
          queryKey: trpc.documents.get.queryOptions({ documentId }).queryKey,
        });
        void queryClient.invalidateQueries({
          queryKey: trpc.documents.listVersions.queryOptions({ documentId })
            .queryKey,
        });
      },
      onError: (error) => {
        toast.error(`Save refused: ${error.message}`);
      },
    }),
  );

  const handleSave = (): void => {
    saveMutation.mutate({
      documentId,
      nativeContent: serializeSessionToNativeText(
        store.getSession(),
        engine.regenerationStates ?? new Map(),
        engine.rollback,
      ),
    });
  };

  // HISTORY: an explicit version pick loads through the versions API (a
  // query read, fetched imperatively) and pins itself against the latest
  // pointer until the next save.
  const loadVersion = useCallback(
    async (version: number): Promise<void> => {
      try {
        const fetched = await queryClient.fetchQuery(
          trpc.documents.getVersion.queryOptions({ documentId, version }),
        );
        applyContent(fetched.nativeContent, fetched.version, true);
        toast.success(`Opened version ${String(fetched.version)}`);
      } catch (error) {
        toast.error(
          `Open refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [applyContent, documentId, queryClient, trpc],
  );

  // Dirty: an identity check between the live document and the last-saved
  // one (immutable domain values). A fresh document (loadedFrom "") starts
  // dirty: its authored content has never been persisted.
  const isDirty = document !== milestonesRef.current.savedDocument;
  const canSave =
    loaded &&
    !saveMutation.isPending &&
    (isDirty || loadedFromIsEmpty(milestonesRef.current));

  return (
    <div
      className="flex h-10 shrink-0 items-center gap-2 px-2"
      data-testid="project-persistence-bar"
      data-loaded={String(loaded)}
      data-live-version={String(liveVersion)}
      data-dirty={String(isDirty)}
    >
      {documentQuery.isSuccess ? (
        <Link
          to="/projects/$projectId"
          params={{ projectId: documentQuery.data.document.projectId }}
        >
          <Button variant="ghost" size="xs">
            <ArrowLeft data-icon="inline-start" />
            Projects
          </Button>
        </Link>
      ) : null}
      <div className="min-w-0">
        <span
          className="text-sm font-medium"
          data-testid="persistence-document-name"
        >
          {documentQuery.isSuccess
            ? documentQuery.data.document.name
            : documentQuery.isError
              ? "Document unavailable"
              : "…"}
        </span>
      </div>
      <div className="flex-1" />
      <span
        className="text-muted-foreground font-mono text-xs"
        aria-live="polite"
        data-testid="persistence-state"
      >
        {saveMutation.isPending
          ? "saving…"
          : !loaded
            ? "loading…"
            : isDirty
              ? "unsaved changes"
              : liveVersion > 0
                ? `saved v${String(liveVersion)}`
                : "nothing saved yet"}
      </span>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              disabled={!loaded}
              aria-label="Version history"
            />
          }
        >
          <History data-icon="inline-start" />
          History
          {liveVersion > 0 ? (
            <span className="text-muted-foreground font-mono">
              v{String(liveVersion)}
            </span>
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64">
          <div className="text-muted-foreground border-b px-2 pb-1.5 text-xs font-medium tracking-wider uppercase">
            Saved versions
          </div>
          {versionsQuery.isLoading ? (
            <div className="text-muted-foreground px-2 py-2 text-xs">…</div>
          ) : versionsQuery.data !== undefined &&
            versionsQuery.data.length > 0 ? (
            <ul className="py-1">
              {[...versionsQuery.data].reverse().map((version) => (
                <li key={version.id}>
                  <button
                    type="button"
                    className="hover:bg-accent flex w-full items-center justify-between px-2 py-1.5 text-left text-xs"
                    onClick={() => {
                      void loadVersion(version.version);
                    }}
                  >
                    <span className="font-mono">
                      v{String(version.version)}
                    </span>
                    <span className="text-muted-foreground">
                      {new Date(version.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-muted-foreground px-2 py-2 text-xs">
              Nothing saved yet. The first save becomes version 1.
            </div>
          )}
        </PopoverContent>
      </Popover>
      <Button
        data-testid="persistence-save"
        variant="outline"
        size="xs"
        disabled={!canSave}
        onClick={handleSave}
      >
        <Save data-icon="inline-start" />
        Save
      </Button>
    </div>
  );
}

function loadedFromIsEmpty(milestones: PersistenceMilestones): boolean {
  return milestones.loadedFrom === "" && milestones.savedDocument === null;
}
