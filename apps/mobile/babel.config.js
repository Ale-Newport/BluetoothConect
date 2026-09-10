module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    /**
     * Reanimated 4 moved its Babel plugin into react-native-worklets.
     *
     * Without it, worklets never initialise and every module that imports
     * Reanimated throws at module scope - so its exports come back undefined and
     * whatever imported it fails with an opaque "cannot read property X of
     * undefined". That is exactly how this was found: a blank white screen and
     * two unrelated-looking TypeErrors in the device log.
     *
     * It must be LAST in the plugin list.
     */
    'react-native-worklets/plugin',
  ],
};
