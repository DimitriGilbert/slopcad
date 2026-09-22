/**
 * The native document compatibility suite (Phase 35.2): the explicit,
 * forward-enrolling contract every committed native document fixture must
 * satisfy. It consolidates the checks that were previously spread across
 * the format/migration/fixture suites into one named gate:
 *
 * - **Format contract** — every fixture stamps the CURRENT
 *   `CAD_NATIVE_FORMAT_VERSION`, `readNativeFormatVersion` agrees with the
 *   stamp, and `validateNativeCadDocument` accepts it with zero issues.
 * - **Byte stability** — parse → serialize → stringify reproduces the
 *   committed file byte-for-byte, through the text AND the binary encode
 *   paths. A serializer change that alters output breaks here first; a
 *   fixture may only change deliberately (regenerating is a visible diff).
 * - **Deterministic serialization** — two independent parse/serialize
 *   pipelines over the same bytes produce identical output (fixed key
 *   order, canonicalized metadata — no insertion-order nondeterminism).
 * - **Log replay** — re-applying every persisted transaction from the
 *   persisted base with `applyTransaction` reproduces every persisted
 *   intermediate document snapshot deep-equal, and a full undo → redo
 *   cycle over the revived history lands on the head document exactly:
 *   the parametric intent the format promises (log + head agreement) is
 *   replayable, not just stored.
 * - **Migration coverage** — the migration registry is contiguous
 *   (v1→v2→…→current, no gaps, never beyond current), every fixture sits
 *   at the current version, its migration plan to current is empty, and
 *   running `migrateNativeCadDocument` is a verified byte-identical no-op.
 *
 * Fixture enrollment is automatic: every `*.native.json` under
 * `packages/cad-core/fixtures/` joins this battery, so a newly committed
 * fixture can never skip the compatibility contract. The behavioral
 * assertions specific to one fixture (the plate's expression survival, the
 * failed feature's diagnostics, undo semantics of the rolled-back
 * document) stay in `native-fixtures.test.ts`; this suite is the
 * format-level contract they all share. Layered above it: the persistence
 * bridge round-trip is driven end to end (save → DB → reopen) by the
 * projects e2e suite, and the migration mechanism (planning, running,
 * refusal of impossible plans) is proven with injected synthetic
 * migrations in `native-migration.test.ts` — the production registry
 * stays empty until real old-shape documents exist.
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  applyTransaction,
  CAD_NATIVE_FORMAT_VERSION,
  canRedo,
  canUndo,
  currentDocument,
  encodeNativeCadDocument,
  migrateNativeCadDocument,
  NATIVE_FORMAT_MIGRATIONS,
  parseNativeCadDocument,
  parseNativeCadDocumentFromBytes,
  parseNativeCadDocumentFromString,
  planNativeFormatMigrations,
  readNativeFormatVersion,
  redoHistory,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  undoHistory,
  validateNativeCadDocument,
  type CadDocument,
  type NativeCadDocument,
} from "./index";

const FIXTURES = new URL("../fixtures/", import.meta.url);

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The compatibility suite rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".native.json"))
    .map((entry) => entry.name)
    .sort();
}

async function loadFixture(
  name: string,
): Promise<{ text: string; native: NativeCadDocument }> {
  const text = await readFile(new URL(name, FIXTURES), "utf8");
  const native = requireOk(
    parseNativeCadDocumentFromString(text),
    `parsing ${name}`,
  );
  return { text, native };
}

describe("the native document compatibility suite", () => {
  it("enrolls every committed fixture (the golden set is not silently shrinking)", () => {
    const names = fixtureNames();
    expect(names).toEqual([
      "curve-entities.native.json",
      "failed-feature.native.json",
      "helix-thread.native.json",
      "plate-with-hole.native.json",
      "rolled-back.native.json",
      "sketch-on-face.native.json",
      "workbench-extrude.native.json",
    ]);
  });

  describe.each(fixtureNames())("%s", (name) => {
    it("stamps the current format version and validates structurally", async () => {
      const { text } = await loadFixture(name);
      const revived = JSON.parse(text) as Record<string, unknown>;
      expect(revived.formatVersion).toBe(CAD_NATIVE_FORMAT_VERSION);
      expect(readNativeFormatVersion(revived)).toBe(CAD_NATIVE_FORMAT_VERSION);
      const validation = validateNativeCadDocument(revived);
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.formatVersion).toBe(CAD_NATIVE_FORMAT_VERSION);
    });

    it("round-trips to byte-identical output through text and bytes", async () => {
      const { text, native } = await loadFixture(name);
      expect(
        stringifyNativeCadDocument(serializeNativeCadDocument(native)),
      ).toBe(text);
      const fromBytes = requireOk(
        parseNativeCadDocumentFromBytes(encodeNativeCadDocument(native)),
        `the byte round trip of ${name}`,
      );
      expect(
        stringifyNativeCadDocument(serializeNativeCadDocument(fromBytes)),
      ).toBe(text);
    });

    it("serializes deterministically across independent parses", async () => {
      const { text } = await loadFixture(name);
      const first = requireOk(
        parseNativeCadDocumentFromString(text),
        `the first parse of ${name}`,
      );
      const second = requireOk(
        parseNativeCadDocumentFromString(
          stringifyNativeCadDocument(serializeNativeCadDocument(first)),
        ),
        `the second parse of ${name}`,
      );
      const firstText = stringifyNativeCadDocument(
        serializeNativeCadDocument(first),
      );
      const secondText = stringifyNativeCadDocument(
        serializeNativeCadDocument(second),
      );
      expect(firstText).toBe(text);
      expect(secondText).toBe(text);
      // Re-serializing one revived instance twice must not drift either.
      expect(
        stringifyNativeCadDocument(serializeNativeCadDocument(first)),
      ).toBe(firstText);
    });

    it("replays the persisted log to every persisted intermediate state", async () => {
      const { native } = await loadFixture(name);
      const { history } = native;
      expect(history.cursor).toBe(history.entries.length);
      let replayed: CadDocument = history.base;
      for (const [index, entry] of history.entries.entries()) {
        replayed = requireOk(
          applyTransaction(replayed, entry.transaction),
          `replaying ${name} transaction ${String(index)}`,
        );
        expect(replayed).toEqual(entry.document);
      }
      expect(replayed).toEqual(native.document);
    });

    it("restores the head exactly through a full undo/redo cycle", async () => {
      const { native } = await loadFixture(name);
      let history = native.history;
      const depth = history.entries.length;
      expect(history.cursor).toBe(depth);
      expect(canUndo(history)).toBe(depth > 0);
      expect(canRedo(history)).toBe(false);
      for (let step = 0; step < depth; step += 1) {
        history = requireOk(
          undoHistory(history),
          `undo ${String(step)} of ${name}`,
        ).history;
      }
      expect(canUndo(history)).toBe(false);
      for (let step = 0; step < depth; step += 1) {
        history = requireOk(
          redoHistory(history),
          `redo ${String(step)} of ${name}`,
        ).history;
      }
      expect(canRedo(history)).toBe(false);
      expect(currentDocument(history)).toEqual(native.document);
    });

    it("needs no migration at the current version and migrating is a byte-identical no-op", async () => {
      const { text } = await loadFixture(name);
      const revived = JSON.parse(text) as Record<string, unknown>;
      expect(readNativeFormatVersion(revived)).toBe(CAD_NATIVE_FORMAT_VERSION);
      expect(
        requireOk(
          planNativeFormatMigrations(
            CAD_NATIVE_FORMAT_VERSION,
            CAD_NATIVE_FORMAT_VERSION,
            NATIVE_FORMAT_MIGRATIONS,
          ),
          `planning migrations for ${name}`,
        ),
      ).toEqual([]);
      const migrated = requireOk(
        migrateNativeCadDocument(revived),
        `migrating ${name}`,
      );
      const remigrated = requireOk(
        parseNativeCadDocument(migrated),
        `re-parsing migrated ${name}`,
      );
      expect(
        stringifyNativeCadDocument(serializeNativeCadDocument(remigrated)),
      ).toBe(text);
    });
  });

  it("keeps the migration registry contiguous and current-bounded", () => {
    for (const [index, migration] of NATIVE_FORMAT_MIGRATIONS.entries()) {
      expect(migration.from).toBe(index + 1);
      expect(migration.to).toBe(index + 2);
    }
    const highest = NATIVE_FORMAT_MIGRATIONS.at(-1)?.to ?? 1;
    expect(highest).toBeLessThanOrEqual(CAD_NATIVE_FORMAT_VERSION);
  });

  // The Phase 36 gate: a fixture at its v1 form migrates forward and
  // resaves BYTE-IDENTICALLY to the committed v2 file. The v1 form is
  // derived by inverting the registry's steps in order (each real step is
  // stamp-additive, so the inverse is the same content walk with the
  // decremented stamp) — no hand-maintained v1 copies.
  it("migrates each fixture's v1 form to a byte-identical resave of the committed file", async () => {
    for (const name of fixtureNames()) {
      const { text } = await loadFixture(name);
      const current = JSON.parse(text) as Record<string, unknown>;
      expect(readNativeFormatVersion(current)).toBe(CAD_NATIVE_FORMAT_VERSION);
      const v1 = downgradeToV1(current);
      expect(readNativeFormatVersion(v1)).toBe(1);
      const migrated = requireOk(
        migrateNativeCadDocument(v1),
        `migrating the v1 form of ${name}`,
      );
      const reparsed = requireOk(
        parseNativeCadDocument(migrated),
        `re-parsing the migrated v1 form of ${name}`,
      );
      const resaved = stringifyNativeCadDocument(
        serializeNativeCadDocument(reparsed),
      );
      expect(resaved).toBe(text);
    }
  });
});

/** Lowers every embedded sketch stamp and the envelope one version (v2→v1). */
function downgradeToV1(input: unknown): Record<string, unknown> {
  const lowerSketch = (payload: unknown): unknown => {
    if (
      typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).formatVersion === 2
    ) {
      return { ...(payload as Record<string, unknown>), formatVersion: 1 };
    }
    return payload;
  };
  const lowerSection = (section: unknown): unknown => {
    if (
      typeof section !== "object" ||
      section === null ||
      Array.isArray(section)
    ) {
      return section;
    }
    const record = section as Record<string, unknown>;
    if (!Array.isArray(record.sketches)) return section;
    return {
      ...record,
      sketches: record.sketches.map((entry: unknown) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? {
              ...(entry as Record<string, unknown>),
              sketch: lowerSketch((entry as Record<string, unknown>).sketch),
            }
          : entry,
      ),
    };
  };
  const record = input as Record<string, unknown>;
  const out: Record<string, unknown> = {
    ...record,
    formatVersion: 1,
    document: lowerSection(record.document),
  };
  if (
    typeof record.history === "object" &&
    record.history !== null &&
    !Array.isArray(record.history)
  ) {
    const history = record.history as Record<string, unknown>;
    out.history = {
      ...history,
      base: lowerSection(history.base),
      transactions: Array.isArray(history.transactions)
        ? history.transactions.map((transaction: unknown) => {
            if (
              typeof transaction !== "object" ||
              transaction === null ||
              Array.isArray(transaction)
            ) {
              return transaction;
            }
            const tx = transaction as Record<string, unknown>;
            if (!Array.isArray(tx.commands)) return transaction;
            return {
              ...tx,
              commands: tx.commands.map((command: unknown) =>
                typeof command === "object" &&
                command !== null &&
                !Array.isArray(command) &&
                (command as Record<string, unknown>).type === "sketch.create"
                  ? {
                      ...(command as Record<string, unknown>),
                      sketch: lowerSketch(
                        (command as Record<string, unknown>).sketch,
                      ),
                    }
                  : command,
              ),
            };
          })
        : history.transactions,
    };
  }
  return out;
}
