import { useClient } from '../../client/ClientProvider.js';
import type { AirLinkClient } from '../../client/AirLinkClient.js';

/**
 * The client, or null while it is still coming up.
 *
 * `ClientProvider` moves the app to READY - which mounts the tabs, this one
 * included - and only THEN awaits `client.start()`, so there is a window of a
 * second or more where the Play tab can be on screen and the context is still
 * null. `useClient()` throws in that window, which would take the whole app
 * down; here it means "not ready yet", and every caller handles null by
 * disabling the control and saying why.
 *
 * The hook order is unaffected: `useClient` reads its context before it decides
 * to throw, so the `useContext` underneath runs on every render either way.
 *
 * This is a workaround, not a design, and it is deliberately duplicated from
 * the Home screens rather than imported across folders - the real fix belongs
 * in ClientProvider, which should publish the instance immediately or stay in
 * the LOADING phase until `start()` resolves. See the report.
 */
export function useOptionalClient(): AirLinkClient | null {
  try {
    return useClient();
  } catch {
    return null;
  }
}
