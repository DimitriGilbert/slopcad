# ADR: Configurations — representation and effective-view semantics

Phase 57. Status: accepted. Supersedes none; complements
`adr-assemblies-structure.md` (one document, many views over it).

## Context

The roadmap's configuration phase asks for "named parameter-set rows over
the same document (parameter overrides + feature suppression/visibility
flags + body presence), deterministic evaluation (config → effective
document view without duplicating records)". The risk note names the trap:
effective-view semantics must not fork the document model — two parallel
document representations that can drift.

## Decision

1. **The document IS the base configuration.** A `CadDocument`'s stored
   parameter values, feature list, and body visibility flags are the
   default (unconfigured) state. There is no second document.

2. **A configuration row is deltas, never copies.** A
   `DocumentConfiguration` holds:
   - `parameterOverrides`: parameter id + the value it takes under the
     configuration (same dimensional type — a type swap is rejected);
   - `suppressedFeatures`: feature ids the executor skips under the
     configuration;
   - `hiddenBodies`: body ids the effective view omits.
     Rows live in an additive `configurations` document section with a
     `cfg_` id kind and a zero-omitted generator counter (the mate/joint
     precedent). Every referenced id must name a record of the SAME
     document, enforced at the add boundary and re-enforced at native
     parse; removal of a referenced parameter/feature/body refuses with
     `document/configuration-in-use` (removal never cascades).

3. **The effective view is derived data.** `applyDocumentConfiguration`
   evaluates a row into an `EffectiveDocumentView` — a parameter
   collection with overrides applied (cached values swapped; expressions
   untouched; recomputation stays the regeneration pipeline's job) plus
   the suppressed and hidden id lists. The view is never persisted and
   never becomes a document; consumers (the workbench switcher, per-config
   export, pinned drawing views) read it per evaluation.

4. **Applying a configuration is a document transaction plus authoring
   state**, exactly the levers that already exist: parameter values commit
   through the transaction log (the diff/stale machinery re-derives the
   affected feature set — no new invalidation path), the suppressed set
   rides the existing page-level authoring state that `regenerate` already
   consumes. Switching configs therefore reuses the stale-set machinery
   unchanged; per-configuration scene caching is the recording mode's
   concern if the stale set ever grows (roadmap budget note).

5. **Drawing views pin configurations additively.** An optional
   `configurationId` on a `DrawingView` names the row whose effective
   values drive that view's projection; absent = base document
   (byte-identical serialization for unpinned views). The drawing parser
   validates the id's wire shape; the native envelope cross-checks the
   membership (`native-format/configuration-unknown-view-pin`), the same
   layering as the regeneration/drawing split.

6. **Native format growth is v6, content-additive.** The v5→v6 migration
   is the identity (v5 content is valid v6 content); the envelope stamp
   moves because an old reader would silently drop the standalone section
   and counter.

7. **CSV is a deterministic table lens.** Export emits the parameter
   table (LF, fixed `name,value,unit` header, collection order, bare
   unquoted fields). Import parses rows strictly, matches by parameter
   name, and produces typed overrides — the same rows a configuration
   holds — so a CSV round-trip is a configuration edit, not a side
   channel.

## Consequences

- No document fork: every consumer continues to read one `CadDocument`;
  configurations are queries over it.
- Suppression/visibility in a row is authoring INTENT; the document's own
  flags remain the base state. UI surfaces must not conflate the two.
- Old readers cannot carry configuration rows — hence the envelope bump —
  matching the six-phase-old migration discipline.
