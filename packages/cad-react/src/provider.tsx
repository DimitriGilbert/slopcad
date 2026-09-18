/**
 * The CAD React provider (Phase 14): context plumbing that hands the
 * {@link CadStore} — the host-composed runtime over consumer-supplied
 * domain instances — to the CAD hooks.
 *
 * The provider never constructs domain state. A host builds its own
 * session/selection/tool composition (through `createCadStore`, the
 * documented factory, or any equivalent) and passes the store down; the
 * hooks below it mirror domain state through scoped subscriptions and
 * issue their mutations back as domain operations. React state here is a
 * mirror, never the canonical source: there is no API on this layer that
 * accepts React-side state and writes it into the domain — the domain only
 * ever consumes command/operation data.
 *
 * Using any CAD hook outside a {@link CadProvider} is a programming error
 * and throws the structured {@link CadProviderError}.
 */

import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";

import { type CadStore } from "./store";

const CadStoreContext = createContext<CadStore | null>(null);

/** Stable failure code of {@link CadProviderError}. */
export const CAD_PROVIDER_ERROR_CODE = "cad-react/provider-missing";

/**
 * The structured error thrown when a CAD hook runs without a
 * {@link CadProvider} ancestor: a programming error, reported with a
 * stable code rather than an inscrutable null dereference.
 */
export class CadProviderError extends Error {
  readonly code: typeof CAD_PROVIDER_ERROR_CODE = CAD_PROVIDER_ERROR_CODE;

  constructor(hookName: string) {
    super(
      `${hookName} requires a <CadProvider> ancestor: wrap the component tree (once, above every CAD consumer) in <CadProvider store={...}>. The provider must receive the CadStore the host composed from its own domain instances.`,
    );
    this.name = "CadProviderError";
  }
}

/**
 * Resolves the store from context, throwing {@link CadProviderError} when
 * no provider is above the caller. Every CAD hook routes through this.
 */
export function useCadStore(hookName: string): CadStore {
  const store = useContext(CadStoreContext);
  if (store === null) {
    throw new CadProviderError(hookName);
  }
  return store;
}

/** Props of {@link CadProvider}. */
export interface CadProviderProps {
  /** The host-composed store over the host's domain instances. */
  readonly store: CadStore;
  readonly children: ReactNode;
}

/** Mounts the store into context for every CAD hook below it. */
export function CadProvider({
  children,
  store,
}: CadProviderProps): ReactElement {
  return (
    <CadStoreContext.Provider value={store}>
      {children}
    </CadStoreContext.Provider>
  );
}
