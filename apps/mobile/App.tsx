/**
 * Application entry point.
 *
 * The real screens live under src/. This file exists only to mount the root and
 * to make the one ordering guarantee that matters: the CSPRNG polyfill must be
 * installed before anything cryptographic is imported, which is why
 * index.js imports it first.
 */
import React from 'react';
import { AppRoot } from './src/AppRoot';

export default function App(): React.JSX.Element {
  return <AppRoot />;
}
