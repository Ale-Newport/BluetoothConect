import { useClient } from '../../client/ClientProvider.js';
import type { AirLinkClient } from '../../client/AirLinkClient.js';

/**
 * The client, or null while it is still coming up.
 *
 * `ClientProvider` moves the app to READY - which mounts this screen - and only
 * then awaits `client.start()`, so there is a window of a second or more where
 * the navigator is on screen and the context is still null. `useClient()`
 * throws in that window, which would take the whole app down on the screen
 * people see first.
 *
 * So we call it and treat the throw as "not ready yet". The hook order is
 * unaffected: `useClient` reads its context before it decides to throw, so the
 * `useContext` call underneath happens on every render either way.
 *
 * This is a workaround, not a design. The fix belongs in ClientProvider: either
 * publish the instance immediately, or stay in the LOADING phase until
 * `start()` resolves. Until then, every caller must handle null by disabling
 * the control and saying why.
 */
export function useOptionalClient(): AirLinkClient | null {
  try {
    return useClient();
  } catch {
    return null;
  }
}
