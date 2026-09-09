import React from 'react';
import { EmptyState, Screen } from '../../ui/index.js';

/**
 * Choose a game
 *
 * NOT YET IMPLEMENTED. This placeholder exists so the navigator compiles while
 * the screen is being written. It says so plainly rather than pretending to
 * work, and it must not survive into a release build.
 */
export function GamePickerScreen(): React.JSX.Element {
  return (
    <Screen>
      <EmptyState icon="🚧" title="Choose a game" body="This screen is not built yet." />
    </Screen>
  );
}
