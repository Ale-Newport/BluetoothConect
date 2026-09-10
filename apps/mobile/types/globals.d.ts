/**
 * Test-only globals.
 *
 * The doubles in jest.setup.js expose a small amount of control - push a native
 * event in, make the keychain forget - and this declares that surface so the
 * tests can use it without `any`. None of it exists at runtime in the app.
 */
declare global {
  // eslint-disable-next-line no-var
  var __airlinkNativeTest:
    | {
        emit: (event: string, payload: unknown) => void;
        listenerCount: (event: string) => number;
        calls: () => { name: string; transports?: string[] }[];
        clearCalls: () => void;
      }
    | undefined;
  // eslint-disable-next-line no-var
  var __airlinkKeychainTest: { clear: () => void; size: () => number } | undefined;
  // eslint-disable-next-line no-var
  var __airlinkSqliteTest: { clear: () => void } | undefined;
}

export {};
