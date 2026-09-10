/**
 * Test doubles for everything that needs hardware.
 *
 * The point of this file is narrow: let the React tree mount under Node so the
 * suite can assert that the screens render, that the navigator wires up, and
 * that nothing throws at import time. Two of the worst defects found while
 * building this app were exactly that shape - a blank white screen caused by a
 * missing Babel plugin, and a crash on first launch caused by a column type -
 * and both would have been caught here.
 *
 * These mocks are the smallest thing that satisfies the module's contract. They
 * do NOT simulate a radio: transports are tested for real against MockTransport
 * in packages/core, and against two phones by hand.
 */
/* eslint-env jest */
/* global jest */

// --- storage --------------------------------------------------------------

/**
 * The keychain, remembered.
 *
 * A double that forgets is not a keychain: half of what this app does with the
 * identity key - reusing it when the profile is gone, recognising a friend
 * across launches - only means anything if the key is still there the second
 * time it is asked for. State is per test file, and `resetStorage()` clears it.
 */
jest.mock('react-native-keychain', () => {
  const vault = new Map();
  globalThis.__airlinkKeychainTest = { clear: () => vault.clear(), size: () => vault.size };
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly' },
    setGenericPassword: jest.fn(async (username, password, options = {}) => {
      vault.set(options.service ?? 'default', { username, password, service: options.service });
      return true;
    }),
    getGenericPassword: jest.fn(async (options = {}) => vault.get(options.service ?? 'default') ?? false),
    resetGenericPassword: jest.fn(async (options = {}) => vault.delete(options.service ?? 'default')),
  };
});

/**
 * An in-memory stand-in for op-sqlite, backed by node:sqlite - the same engine
 * the db package's own tests use. Real SQL runs, so a migration that is invalid
 * SQL still fails here; only the native binding is replaced.
 */
jest.mock('@op-engineering/op-sqlite', () => {
  const { DatabaseSync } = require('node:sqlite');

  /**
   * op-sqlite takes and returns BLOBs as `ArrayBuffer`; node:sqlite takes and
   * returns `Uint8Array`. The app's driver already converts in op-sqlite's
   * direction, so this double has to convert back, or every BLOB parameter is
   * rejected at binding time. Getting this wrong is not a cosmetic difference
   * in a mock: it is the exact shape of a real defect this app already had, and
   * a double that quietly accepted anything would have hidden it.
   */
  const toNode = (value) => {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  };
  const fromNode = (row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
    }
    return out;
  };

  /**
   * One database per file, not one per `open()`. The app opens the database once
   * and the real one is a file that outlives the process; a fresh `:memory:`
   * per call would mean a test could never write something with one client and
   * read it back with the next.
   */
  let shared = null;
  globalThis.__airlinkSqliteTest = {
    clear: () => {
      shared?.close();
      shared = null;
    },
  };

  return {
    open: () => {
      const db = shared ?? (shared = new DatabaseSync(':memory:'));
      const run = (sql, params) => {
        const statement = db.prepare(sql);
        const bound = params.map(toNode);
        if (/^\s*(select|pragma|with)/i.test(sql)) return { rows: statement.all(...bound).map(fromNode) };
        const info = statement.run(...bound);
        return { rows: [], rowsAffected: Number(info.changes ?? 0) };
      };
      return {
        executeSync: (sql, params = []) => run(sql, params),
        execute: async (sql, params = []) => run(sql, params),
        // Deliberately not closing: the app closes the database on shutdown,
        // and a test that then renders again would find it gone. Test files
        // start with a clean one either way.
        close: () => undefined,
      };
    },
    IOS_LIBRARY_PATH: 'library',
  };
});

// --- radios ---------------------------------------------------------------

/**
 * A stand-in for the native transport module.
 *
 * Shaped like the real TurboModule rather than like a convenience: the events
 * are codegen `EventEmitter` properties, which are subscribed as
 * `onPeerDiscovered(callback)` and return a handle with `remove()`. Getting
 * that shape wrong is how a double stops testing the thing it stands for - the
 * first version of this file returned plain functions and the app's own
 * `subscribe()` threw on it.
 *
 * It reports Bluetooth as supported and available, and discovers nobody. That
 * is the state of a phone sitting alone on a table, which is the state the home
 * screen has to look right in.
 *
 * `globalThis.__airlinkNativeTest` exposes the listener registry so a test can
 * push an event in - see the home screen test, which discovers a peer that way.
 */
jest.mock('@airlink/native-transport', () => {
  const listeners = new Map();
  const emitter = (name) => (callback) => {
    const set = listeners.get(name) ?? new Set();
    set.add(callback);
    listeners.set(name, set);
    return { remove: () => set.delete(callback) };
  };

  /** Calls the app made, so a test can assert one was made at all. */
  const calls = [];

  globalThis.__airlinkNativeTest = {
    emit: (name, event) => {
      for (const callback of listeners.get(name) ?? []) callback(event);
    },
    listenerCount: (name) => (listeners.get(name) ?? new Set()).size,
    calls: () => [...calls],
    clearCalls: () => {
      calls.length = 0;
    },
  };

  const bluetooth = {
    kind: 'ble',
    supported: true,
    available: true,
    reason: '',
    detail: '',
  };

  return {
    __esModule: true,
    // A named export, exactly as the package publishes it. A default export
    // here resolves to `undefined` at the call site and fails one frame later,
    // somewhere much less obvious.
    NativeAirLinkTransport: {
      getCapabilities: async () => ({
        platform: 'ios',
        osVersion: '26.3',
        deviceModel: 'test',
        transports: [bluetooth],
        canAdvertiseBle: true,
        supportsL2cap: true,
        canCreateHotspot: false,
        canJoinHotspot: false,
      }),
      start: async () => undefined,
      stop: async () => undefined,
      startAdvertising: async () => undefined,
      stopAdvertising: async () => undefined,
      startDiscovery: async () => undefined,
      stopDiscovery: async () => undefined,
      connect: async () => {
        // No radio, so no link. Rejecting is the honest answer, and the app has
        // to survive it - which is what the failure-path test checks.
        throw new Error('no radio in this environment');
      },
      disconnect: async () => undefined,
      send: async () => undefined,
      getLinkMetrics: async () => ({
        linkId: '',
        transport: 'ble',
        maxDatagramSize: 180,
        rssi: -60,
        packetsSent: 0,
        packetsReceived: 0,
        packetsDropped: 0,
        bytesSent: 0,
        bytesReceived: 0,
        throughput: 0,
      }),
      requestPermissions: async (transports) => {
        calls.push({ name: 'requestPermissions', transports: [...transports] });
        return {
          granted: true,
          granted_transports: [...transports],
          denied_transports: [],
          requiresSettings: false,
        };
      },
      openSettings: () => undefined,
      createHotspot: async () => {
        throw new Error('not supported in this environment');
      },
      stopHotspot: async () => undefined,
      joinHotspot: async () => false,
      leaveHotspot: async () => undefined,
      onPeerDiscovered: emitter('onPeerDiscovered'),
      onPeerLost: emitter('onPeerLost'),
      onLinkOpened: emitter('onLinkOpened'),
      onLinkState: emitter('onLinkState'),
      onData: emitter('onData'),
      onMtuChanged: emitter('onMtuChanged'),
      onAvailabilityChanged: emitter('onAvailabilityChanged'),
      onLog: emitter('onLog'),
    },
  };
});

// --- layout ---------------------------------------------------------------

/**
 * Safe-area insets come from the native side, and until they arrive the real
 * provider renders nothing at all - so without this the whole app tree is an
 * empty view and every query fails for the wrong reason. The library ships its
 * own double with fixed insets, which is what this uses.
 */
jest.mock('react-native-safe-area-context', () =>
  // The library's own double is a default export wrapping the real module, so
  // it has to be unwrapped to stand in for the module's named exports.
  require('react-native-safe-area-context/jest/mock').default,
);

// --- animation ------------------------------------------------------------

/**
 * Reanimated, by hand rather than via its own `mock.js`.
 *
 * That file re-exports the real entry point, which initialises
 * react-native-worklets, which calls into a native module that does not exist
 * under Node. The app's use of the library is small and entirely declarative -
 * `Animated.View`, three entering animations, and `useSharedValue` - so a
 * double covering exactly that is both smaller and more honest than defeating
 * the initialisation of a module the test never wants.
 */
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View, Text, ScrollView } = require('react-native');
  const entering = () => ({ duration: () => entering(), delay: () => entering(), build: () => ({}) });
  const Animated = {
    View,
    Text,
    ScrollView,
    createAnimatedComponent: (component) => component,
  };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useSharedValue: (initial) => ({ value: initial }),
    useAnimatedStyle: (factory) => factory(),
    withTiming: (value) => value,
    withSpring: (value) => value,
    runOnJS: (fn) => fn,
    runOnUI: (fn) => fn,
    FadeIn: entering(),
    FadeInDown: entering(),
    FadeOut: entering(),
    ZoomIn: entering(),
    Easing: { linear: () => 0, inOut: (fn) => fn },
    useDerivedValue: (factory) => ({ value: factory() }),
    // The React namespace is unused here but keeps the shape obvious to a
    // reader comparing this against the real module's exports.
    _React: React,
  };
});

// --- native UI ------------------------------------------------------------

jest.mock('react-native-haptic-feedback', () => ({
  __esModule: true,
  default: { trigger: jest.fn() },
}));

jest.mock('react-native-vision-camera', () => ({
  Camera: () => null,
  useCameraDevice: () => null,
  useCameraPermission: () => ({ hasPermission: false, requestPermission: async () => false }),
  useObjectOutput: () => ({}),
}));

jest.mock('react-native-video', () => ({ __esModule: true, default: () => null }));

jest.mock('@shopify/react-native-skia', () => {
  const React = require('react');
  const passthrough = (name) => {
    const Component = ({ children }) => React.createElement(name, null, children);
    Component.displayName = name;
    return Component;
  };
  return {
    Canvas: passthrough('Canvas'),
    Group: passthrough('Group'),
    Circle: passthrough('Circle'),
    Rect: passthrough('Rect'),
    RoundedRect: passthrough('RoundedRect'),
    Line: passthrough('Line'),
    Path: passthrough('Path'),
    Text: passthrough('SkiaText'),
    Paint: passthrough('Paint'),
    useFont: () => null,
    Skia: { Path: { Make: () => ({ moveTo() {}, lineTo() {}, close() {} }) } },
  };
});

jest.mock('react-native-qrcode-svg', () => ({ __esModule: true, default: () => null }));

jest.mock('@react-native-documents/picker', () => ({
  pick: async () => [],
  types: { allFiles: 'public.item' },
  isErrorWithCode: () => false,
  errorCodes: { OPERATION_CANCELED: 'OPERATION_CANCELED' },
}));

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: async () => ({ didCancel: true }),
}));

jest.mock('react-native-blob-util', () => ({
  __esModule: true,
  default: {
    fs: {
      dirs: { DocumentDir: '/tmp/airlink-test' },
      exists: async () => false,
      mkdir: async () => undefined,
      unlink: async () => undefined,
      writeFile: async () => undefined,
      readFile: async () => '',
      stat: async () => ({ size: 0 }),
    },
  },
}));
