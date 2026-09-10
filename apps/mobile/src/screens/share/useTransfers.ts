import { useCallback, useSyncExternalStore } from 'react';
import { useClient } from '../../client/ClientProvider.js';
import { transferCenterFor, type TransferCenter, type TransferRecord } from './transferCenter.js';

/**
 * Reading the transfer centre from React.
 *
 * `useSyncExternalStore` rather than a `useState` + effect pairing because the
 * centre is written to from outside the React tree - protocol timers, session
 * events, an app-state change - and this is the hook that exists precisely so
 * those writes cannot be torn or missed between a render and its effect.
 */

/**
 * The centre, or null while the client is still coming up.
 *
 * `ClientProvider` moves the app to READY - which mounts the tabs - and only
 * then awaits `client.start()`, so there is a window of a second or more where
 * this screen is on show and the context is still null. `useClient()` throws in
 * that window, which would take the whole app down. The throw is caught and
 * treated as "not ready yet"; the hook order is unaffected, because `useClient`
 * reads its context before it decides to throw.
 *
 * A workaround, not a design: the fix belongs in ClientProvider, which should
 * either publish the instance immediately or stay in LOADING until `start()`
 * resolves. Until it does, every caller has to handle null by disabling the
 * control and saying why.
 */
export function useTransferCenter(): TransferCenter | null {
  try {
    return transferCenterFor(useClient());
  } catch {
    return null;
  }
}

/**
 * Stable no-op sources for the window above.
 *
 * `useSyncExternalStore` compares the snapshot it gets by identity and warns -
 * then re-renders forever - if a new one comes back each time, so these are
 * module-level constants rather than anything built per render.
 */
const NO_TRANSFERS: readonly TransferRecord[] = [];
const noSubscribe = (): (() => void) => (): void => undefined;
const noTransfers = (): readonly TransferRecord[] => NO_TRANSFERS;

export function useTransfers(): readonly TransferRecord[] {
  const centre = useTransferCenter();
  return useSyncExternalStore(centre?.subscribe ?? noSubscribe, centre?.list ?? noTransfers);
}

export function useTransfer(transferId: string): TransferRecord | undefined {
  const centre = useTransferCenter();
  // The centre replaces a record object whenever it changes and keeps it
  // otherwise, so this snapshot is referentially stable between publishes.
  const snapshot = useCallback(() => centre?.get(transferId), [centre, transferId]);
  return useSyncExternalStore(centre?.subscribe ?? noSubscribe, snapshot);
}
