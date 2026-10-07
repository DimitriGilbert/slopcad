/**
 * Local replacement for `use-sync-external-store/shim/with-selector`.
 *
 * Why this exists: the shim package is CJS, and rolldown-vite's CJS
 * interop inlines it with a runtime `__require("react")` that loads a
 * SECOND React instance from disk during SSR — Base UI's `useStore` (via
 * `@tanstack/react-store`, zustand) then reads that instance's null
 * dispatcher and throws "Cannot read properties of null (reading
 * 'useSyncExternalStore')", degrading the route to the client-only shell.
 * vite.config.ts aliases this specifier here, keeping the graph on the
 * single bundled React (see that config for the alias pair).
 *
 * This is the canonical MIT implementation from use-sync-external-store
 * (facebook/react, packages/use-sync-external-store), unchanged in
 * behavior: it memoizes the selector result against snapshot identity
 * (Object.is) and an optional custom equality, and delegates to React's
 * native `useSyncExternalStore` — exactly what the shim does on React 19.
 */

import {
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

type Subscribe = (onStoreChange: () => void) => () => void;

/** React's `is`: the Object.is polyfill for runtimes without it. */
function is(x: unknown, y: unknown): boolean {
  return (
    (x === y && (x !== 0 || 1 / (x as number) === 1 / (y as number))) ||
    (x !== x && y !== y)
  );
}

const objectIs: (x: unknown, y: unknown) => boolean =
  typeof Object.is === "function" ? Object.is : is;

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: Subscribe,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  // The rendered selection is memoized across renders through this
  // instance ref (the canonical implementation's `inst`).
  const instRef = useRef<{ hasValue: boolean; value: Selection | null } | null>(
    null,
  );
  let inst: { hasValue: boolean; value: Selection | null };
  if (instRef.current === null) {
    inst = { hasValue: false, value: null };
    instRef.current = inst;
  } else {
    inst = instRef.current;
  }

  const [getSelection, getServerSelection] = useMemo(() => {
    // Memoization state lives in the closure rebuilt whenever the inputs
    // change, exactly as in the canonical implementation.
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        // First call: no previous selection to reconcile against.
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual !== undefined) {
          // React may render concurrently with a previous selector; even
          // then the memoized selection must be kept when still equal.
          if (inst.hasValue) {
            // `hasValue` guarantees the value is a real selection (the
            // boolean and the field are set together in the effect below).
            const currentSelection = inst.value as Selection;
            if (isEqual(currentSelection, nextSelection)) {
              memoizedSelection = currentSelection;
              return currentSelection;
            }
          }
        }
        memoizedSelection = nextSelection;
        return nextSelection;
      }

      const prevSelection = memoizedSelection;
      if (objectIs(memoizedSnapshot, nextSnapshot)) {
        // Same snapshot: reuse the previous selection.
        return prevSelection;
      }

      const nextSelection = selector(nextSnapshot);
      if (isEqual !== undefined && isEqual(prevSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return prevSelection;
      }

      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return nextSelection;
    };

    const maybeGetServerSnapshot =
      getServerSnapshot === undefined ? null : getServerSnapshot;

    const getSnapshotWithSelector = (): Selection =>
      memoizedSelector(getSnapshot());
    const getServerSnapshotWithSelector =
      maybeGetServerSnapshot === null
        ? undefined
        : () => memoizedSelector(maybeGetServerSnapshot());

    return [getSnapshotWithSelector, getServerSnapshotWithSelector] as const;
    // The closure reads `inst`'s fields deliberately non-reactively: it is
    // the ref-held stable instance (canonical implementation's dep list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getSnapshot, getServerSnapshot, selector, isEqual]);

  const value = useSyncExternalStore(
    subscribe,
    getSelection,
    getServerSelection,
  );

  useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
    // `inst` is the ref-held stable instance (canonical dep list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useDebugValue(value);
  return value;
}

// CJS interop: the package's module.exports is the namespace object, and
// zustand/traditional imports it as a default (`import
// useSyncExternalStoreExports from ...`) before destructuring the hook.
export default { useSyncExternalStoreWithSelector };
