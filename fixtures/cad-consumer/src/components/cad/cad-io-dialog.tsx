import type { RefObject } from "react";
import { cn } from "cn";

import { Button } from "../button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../dialog";

/** One exportable format the host declares. */
export interface CadExportFormatOption {
  /** Stable identity (the `onExport` argument; the entry key). */
  readonly id: string;
  /** The visible label ("STL") and search text. */
  readonly label: string;
  /** What the export produces, for this host and this format. */
  readonly description: string;
  /** The exchange taxonomy chip ("mesh / binary"): what kind of artifact
   * this format carries, rendered as a mono tag on the row. */
  readonly meta?: string;
  /** Disabled formats render but cannot start. */
  readonly disabled?: boolean;
}

/** One held export the host reports back. */
export interface CadExportEntry {
  /** The format id this entry belongs to. */
  readonly formatId: string;
  /** The held byte count, verbatim from the adapter's output. */
  readonly byteCount: number;
  /** The honest detail line ("1234 triangles", "1 solid"). */
  readonly detail: string;
  /** Download affordance (a host-built object URL), when offered. */
  readonly downloadUrl?: string;
  /** Download filename, when offered. */
  readonly downloadName?: string;
}

/** Labels of {@link CadExportDialog}. Overridable via props. */
export interface CadExportDialogLabels {
  readonly title: string;
  readonly description: string;
  readonly exportAction: string;
  readonly exporting: string;
  readonly download: string;
  readonly empty: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_EXPORT_DIALOG_LABELS: CadExportDialogLabels = {
  title: "Export model",
  description:
    "Export the settled model geometry. Files are held in memory; the download link serves exactly the held bytes.",
  exportAction: "Export",
  exporting: "exporting…",
  download: "download",
  empty: "No exportable formats declared.",
};

/** Props of {@link CadExportDialog}. */
export interface CadExportDialogProps {
  /** The exportable formats, in display order. */
  readonly formats: readonly CadExportFormatOption[];
  /** The held exports, keyed by format id (one per format). */
  readonly entries?: readonly CadExportEntry[];
  /** The format currently exporting, or `null`. */
  readonly pendingFormatId?: string | null;
  /** The host's structured error text, rendered in an alert region. */
  readonly error?: string;
  /** Starts one export; the host owns every surface it touches. */
  readonly onExport: (formatId: string) => void;
  /** Whether the dialog is open (controlled). */
  readonly open: boolean;
  /** Receives every open-state transition the dialog drives. */
  readonly onOpenChange: (open: boolean) => void;
  /** Label token overrides, merged over {@link CAD_EXPORT_DIALOG_LABELS}. */
  readonly labels?: Partial<CadExportDialogLabels>;
  /**
   * Ref to the element focus returns to when the dialog closes — the
   * host's trigger, typically (see the mounting-and-focus doc section).
   */
  readonly finalFocus?: RefObject<HTMLElement | null>;
  /** Extends the dialog content classes. */
  readonly className?: string;
}

/**
 * The CAD export dialog: the host's exportable formats with their held
 * results, in one mountable component.
 */
export function CadExportDialog({
  className,
  entries = [],
  error = "",
  finalFocus,
  formats,
  labels: labelOverrides,
  onExport,
  onOpenChange,
  open,
  pendingFormatId = null,
}: CadExportDialogProps) {
  const labels: CadExportDialogLabels = {
    ...CAD_EXPORT_DIALOG_LABELS,
    ...labelOverrides,
  };
  if (!open) return null;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-busy={pendingFormatId !== null || undefined}
        className={cn("sm:max-w-lg", className)}
        data-cad-export-dialog=""
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        {formats.length === 0 ? (
          <p className="text-muted-foreground text-xs">{labels.empty}</p>
        ) : (
          <div className="flex flex-col">
            {formats.map((format) => {
              const entry = entries.find(
                (candidate) => candidate.formatId === format.id,
              );
              const pending = pendingFormatId === format.id;
              return (
                <div
                  className="border-border/60 flex flex-col gap-1.5 border-b py-2.5 last:border-b-0"
                  data-cad-export-format={format.id}
                  key={format.id}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground text-xs font-medium">
                          {format.label}
                        </span>
                        {format.meta !== undefined ? (
                          <span
                            aria-hidden="true"
                            className="border-border text-muted-foreground shrink-0 border px-1 font-mono text-[10px] leading-4"
                          >
                            {format.meta}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-muted-foreground text-xs leading-4">
                        {format.description}
                      </div>
                    </div>
                    <Button
                      data-testid={`cad-export-run-${format.id}`}
                      disabled={format.disabled === true || pending}
                      onClick={() => {
                        onExport(format.id);
                      }}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {pending ? labels.exporting : labels.exportAction}
                    </Button>
                  </div>
                  {entry !== undefined ? (
                    <div
                      className="text-muted-foreground flex items-center gap-2 font-mono text-xs"
                      data-cad-export-entry={format.id}
                    >
                      <span>{`${String(entry.byteCount)} B`}</span>
                      <span>{entry.detail}</span>
                      {entry.downloadUrl !== undefined ? (
                        <a
                          className="text-foreground underline underline-offset-2"
                          data-testid={`cad-export-download-${format.id}`}
                          download={entry.downloadName}
                          href={entry.downloadUrl}
                        >
                          {labels.download}
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {error !== "" ? (
          <p
            className="text-destructive font-mono text-xs"
            data-cad-export-error=""
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One importable format the host declares. */
export interface CadImportFormatOption {
  /** Stable identity (keys; the held-entry link). */
  readonly id: string;
  /** The visible label ("STL") and search text. */
  readonly label: string;
  /** What an import of this format produces, for this host. */
  readonly description: string;
  /** The exchange taxonomy chip ("brep / worker"): the artifact kind and
   * the channel it arrives through, rendered as a mono tag on the row. */
  readonly meta?: string;
  /** The file-extension accept token (", "-joined extensions). */
  readonly extensions: readonly string[];
}

/** One held export the host offers for a round-trip import. */
export interface CadImportHeldEntry {
  /** The format id the held bytes came from. */
  readonly formatId: string;
  /** The held byte count. */
  readonly byteCount: number;
  /** Starts the round trip: import exactly the held bytes. */
  readonly onImport: () => void;
}

/** One structured import outcome the host reports back. */
export interface CadImportOutcome {
  /** The format id the import arrived through. */
  readonly formatId: string;
  /** The honest provenance detail (flavor, unit, solid count). */
  readonly detail: string;
  /** The validated mesh's triangle count. */
  readonly triangles: number;
  /** The validated mesh's volume readout ("1234.567 mm³"). */
  readonly volume: string;
  /** The validated mesh's extents ("30.000 × 20.000 × 4.000 mm"). */
  readonly extents: string;
}

/** Labels of {@link CadImportDialog}. Overridable via props. */
export interface CadImportDialogLabels {
  readonly title: string;
  readonly description: string;
  readonly fileLabel: string;
  readonly importHeld: string;
  readonly empty: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_IMPORT_DIALOG_LABELS: CadImportDialogLabels = {
  title: "Import model",
  description:
    "Import geometry through the supported adapters. The imported mesh previews in the viewport; it is geometry, not document history.",
  fileLabel: "Import mesh or model file",
  importHeld: "Import held",
  empty: "No importable formats declared.",
};

/** Props of {@link CadImportDialog}. */
export interface CadImportDialogProps {
  /** The importable formats, in display order. */
  readonly formats: readonly CadImportFormatOption[];
  /** The host's held exports offered for a round-trip import. */
  readonly held?: readonly CadImportHeldEntry[];
  /** The file input's accept token (derived from the formats when omitted). */
  readonly accept?: string;
  /** Whether an import is running (the file input and held buttons disable). */
  readonly pending?: boolean;
  /** The host's structured error text, rendered in an alert region. */
  readonly error?: string;
  /** The latest import's structured outcome, when one succeeded. */
  readonly outcome?: CadImportOutcome | null;
  /** Hands selected files to the host; the host owns every adapter. */
  readonly onImportFiles: (files: readonly File[]) => void;
  /** Whether the dialog is open (controlled). */
  readonly open: boolean;
  /** Receives every open-state transition the dialog drives. */
  readonly onOpenChange: (open: boolean) => void;
  /** Label token overrides, merged over {@link CAD_IMPORT_DIALOG_LABELS}. */
  readonly labels?: Partial<CadImportDialogLabels>;
  /**
   * Ref to the element focus returns to when the dialog closes — the
   * host's trigger, typically (see the mounting-and-focus doc section).
   */
  readonly finalFocus?: RefObject<HTMLElement | null>;
  /** Extends the dialog content classes. */
  readonly className?: string;
}

/**
 * The CAD import dialog: the host's importable formats, the file picker,
 * the held round-trips, and the latest outcome's readout, in one
 * mountable component.
 */
export function CadImportDialog({
  accept,
  className,
  error = "",
  finalFocus,
  formats,
  held = [],
  labels: labelOverrides,
  onImportFiles,
  onOpenChange,
  open,
  outcome = null,
  pending = false,
}: CadImportDialogProps) {
  const labels: CadImportDialogLabels = {
    ...CAD_IMPORT_DIALOG_LABELS,
    ...labelOverrides,
  };
  const acceptToken =
    accept ?? formats.flatMap((format) => format.extensions).join(",");
  if (!open) return null;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-busy={pending || undefined}
        className={cn("sm:max-w-lg", className)}
        data-cad-import-dialog=""
        finalFocus={finalFocus}
      >
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          <DialogDescription>{labels.description}</DialogDescription>
        </DialogHeader>
        {formats.length === 0 ? (
          <p className="text-muted-foreground text-xs">{labels.empty}</p>
        ) : (
          <div className="flex flex-col">
            {formats.map((format) => {
              const heldEntry = held.find(
                (candidate) => candidate.formatId === format.id,
              );
              return (
                <div
                  className="border-border/60 flex items-center justify-between gap-3 border-b py-2.5 last:border-b-0"
                  data-cad-import-format={format.id}
                  key={format.id}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground text-xs font-medium">
                        {format.label}
                      </span>
                      {format.meta !== undefined ? (
                        <span
                          aria-hidden="true"
                          className="border-border text-muted-foreground shrink-0 border px-1 font-mono text-[10px] leading-4"
                        >
                          {format.meta}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground text-xs leading-4">
                      {format.description}
                    </div>
                  </div>
                  {heldEntry !== undefined ? (
                    <Button
                      data-testid={`cad-import-held-${format.id}`}
                      disabled={pending}
                      onClick={heldEntry.onImport}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {`${labels.importHeld} (${String(heldEntry.byteCount)} B)`}
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <input
              accept={acceptToken}
              className="border-input bg-background file:bg-background file:text-foreground mt-2.5 w-full rounded-none border px-2 py-1 text-xs"
              data-testid="cad-import-file"
              disabled={pending}
              multiple={false}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 0) onImportFiles(files);
                event.target.value = "";
              }}
              type="file"
              aria-label={labels.fileLabel}
            />
          </div>
        )}
        {outcome !== null ? (
          <div
            className="border-border/60 text-muted-foreground flex flex-col gap-1 border-t pt-2 font-mono text-xs"
            data-cad-import-outcome={outcome.formatId}
          >
            <span>{`source = ${outcome.formatId}`}</span>
            <span>{`triangles = ${String(outcome.triangles)}`}</span>
            <span>{`volume = ${outcome.volume}`}</span>
            <span>{`extents = ${outcome.extents}`}</span>
            <span>{outcome.detail}</span>
          </div>
        ) : null}
        {error !== "" ? (
          <p
            className="text-destructive font-mono text-xs"
            data-cad-import-error=""
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
