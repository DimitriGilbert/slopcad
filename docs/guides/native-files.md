# Native files

The native `slopcad` document format (`packages/cad-core/src/native-format.ts`,
Phase 17) is the ONE serialization that preserves parametric history:
same parameters (with expressions), same feature graph, same bodies,
same undo/redo reach, same regeneration picture, same metadata.

## The shape (fixed key order — field list current as of format v9; the parser in `@slopcad/cad-core` is the source of truth)

```jsonc
{
  "formatVersion": 9, // CAD_NATIVE_FORMAT_VERSION
  "metadata": {/* sorted JSON-safe scalars */},
  "document": {/* SerializedCadDocument — state at the history cursor */},
  "history": {
    "base": {/* the document the log starts from */},
    "transactions": [/* the applied transaction log, incl. redo branch */],
    "cursor": 3,
  },
  "regeneration": {/* loadable states, not recomputed */},
  "rollback": { "afterFeatureId": null }, // optional envelope field (Phase 20)
  "suppressedFeatures": ["feat_…"], // optional, additive like rollback: sorted
  // FeatureIds clamped to the declared features, emitted only when non-empty;
  // absent loads as an empty set
  "drawing": {/* sheets and views */}, // optional envelope field (Phase 53):
  // emitted last, only when a drawing exists; absent means none
}
```

## The three persistence decisions

1. **History: log AND state, dual-persisted with a replay check.** The
   format stores the transaction log and the current document; loading
   replays the log over the base through the single `applyTransaction`
   interpreter and verifies the replay reaches a serialization-equal
   state (`native-format/history-mismatch` otherwise). Belt and braces:
   corruption fails structurally instead of loading quietly.
2. **Regeneration states are loadable state, not recomputed.** They
   record the last executor run's outcomes — recomputing them at load
   would mean executing geometry before the document is even visible.
3. **Derived kernel objects never become canonical.** Bodies persist as
   `{ id, name }` (plus the Phase 44 display flags `visible`/`isolated`,
   emitted only when non-default — `visible: false`, `isolated: true` —
   so a flagless document serializes byte-identically to its pre-flag
   form); geometry is rebuilt by regeneration. Nothing derived from a
   kernel appears in the file. The flags' growth stays at envelope v3 by
   the stated reasoning: an old reader's tolerant body parse ignores the
   additive fields (display state dropped, never corrupted — no model
   data rides them), and the `body.update` command that writes them is
   the Phase 20 command-type disclosure pattern (written only by this
   version, rejected loudly — never mis-applied — by an older reader's
   strict log parse), which arrived without an envelope bump.

## The API

```ts
import {
  createNativeCadDocument,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  encodeNativeCadDocument,
  parseNativeCadDocumentFromString,
  parseNativeCadDocumentFromBytes,
  validateNativeCadDocument,
  migrateNativeCadDocument,
} from "@slopcad/cad-core";

const text = stringifyNativeCadDocument(serializeNativeCadDocument(native)); // 2-space JSON + \n
const bytes = encodeNativeCadDocument(native); // UTF-8 of the same
const reopened = parseNativeCadDocumentFromString(text); // replays + verifies
const validation = validateNativeCadDocument(JSON.parse(text)); // structural, no replay,
// collects every issue
```

Deterministic: the same document serializes to identical bytes (the
suite pins a resave being byte-identical). Versioning is gated through
the migration framework (`native-migration.ts`): current parses
directly, older migrates (`planNativeFormatMigrations`), future is
rejected predictably. The app's persistence bridge
(`apps/web/src/cad-projects/native-document-bridge.ts`) is the one place
the live session meets this format.

## The runnable example

`packages/docs-examples/src/core/native.ts`: a three-transaction session
saved, reopened (hole parameter 12 mm restored, log replayed, 3
transactions), validated (0 issues), and resaved byte-identically — the
suite pins each fact.

## What does NOT preserve history

Every exchange format is geometry-only — see
[mesh-exchange.md](mesh-exchange.md) and [step-iges.md](step-iges.md),
and the table the `/docs` page renders. STEP import even marks the fact
in data: imported solids carry `origin: "imported-step"`, so a consumer
can always tell geometry-only imports from feature-built solids.

## Version history

- **v1** (Phase 17): the first native format — document state, dual-
  persisted history (base + transaction log + cursor), regeneration
  states, sorted metadata; rollback arrived later as an additive-
  optional envelope field.
- **v2** (Phase 36): the embedded sketch payloads' vocabulary grew
  (the sketch format's own v2 — new entity and constraint kinds). The
  envelope's shape is unchanged; the version moves because the stamp is
  an old reader's only gate against sketch payloads it cannot parse.
  The registered v1→v2 migration bumps every embedded sketch payload's
  stamp (head document, history base, and every `sketch.create` command
  in the log) and touches nothing else; the compatibility suite proves
  each committed fixture's v1 form migrates to a byte-identical resave
  of the v2 file.
