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
export function useTransferCenter(): TransferCenter {
  return transferCenterFor(useClient());
}

export function useTransfers(): readonly TransferRecord[] {
  const centre = useTransferCenter();
  return useSyncExternalStore(centre.subscribe, centre.list);
}

export function useTransfer(transferId: string): TransferRecord | undefined {
  const centre = useTransferCenter();
  // The centre replaces a record object whenever it changes and keeps it
  // otherwise, so this snapshot is referentially stable between publishes.
  const snapshot = useCallback(() => centre.get(transferId), [centre, transferId]);
  return useSyncExternalStore(centre.subscribe, snapshot);
}
