/**
 * The CSPRNG polyfill MUST be the first import in the process.
 *
 * Hermes has no `crypto.getRandomValues`, and @noble refuses to generate a key
 * without one rather than silently falling back to something weak. Importing it
 * here, before anything else, guarantees the identity key generated on first
 * launch is properly random.
 */
import 'react-native-get-random-values';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
