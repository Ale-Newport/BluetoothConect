/**
 * Jest for the app.
 *
 * Two things need explaining.
 *
 * `transformIgnorePatterns`: the React Native preset only transforms
 * `react-native` itself, but the libraries this app depends on ship untranspiled
 * ESM in `lib/module`, which Node cannot parse inside a CommonJS test. Each name
 * below is a package that actually appears in an import chain reachable from
 * `App.tsx` - not a speculative list.
 *
 * `setupFiles`: everything that talks to a radio, a keystore or a database is
 * replaced by a mock in `jest.setup.js`. That is not a way of avoiding the real
 * thing - the real thing is exercised by the acceptance tests in /tests and by
 * running the app on a device - it is what makes it possible to assert that the
 * screens mount at all, which is the failure this suite exists to catch.
 */
const esmPackages = [
  '(jest-)?react-native',
  '@react-native(-community)?',
  '@react-navigation',
  'react-native-gesture-handler',
  'react-native-safe-area-context',
  'react-native-screens',
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-svg',
  'react-native-keychain',
  '@op-engineering/op-sqlite',
  '@shopify/react-native-skia',
  'react-native-vision-camera',
  'react-native-qrcode-svg',
  'react-native-video',
  '@react-native-documents/picker',
  'react-native-image-picker',
  'react-native-blob-util',
  'react-native-haptic-feedback',
  'react-native-nitro-image',
  'react-native-nitro-modules',
  'react-native-get-random-values',
  '@noble',
];

module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: [
    // Both libraries ship their own doubles for their native side. Using them
    // rather than hand-rolling is deliberate: they are maintained alongside the
    // real modules, so they cannot drift the way a local copy would.
    'react-native-gesture-handler/jestSetup',
    '<rootDir>/jest.setup.js',
  ],
  transformIgnorePatterns: [`node_modules/(?!(${esmPackages.join('|')})/)`],
  moduleNameMapper: {
    // The app imports its own TypeScript with explicit `.js` specifiers, which
    // is correct for the bundler and for `tsc` but not something Jest resolves
    // on its own.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testEnvironment: 'node',
};
