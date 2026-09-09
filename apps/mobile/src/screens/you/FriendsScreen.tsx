import React from 'react';
import { EmptyState, Screen } from '../../ui/index.js';

/**
 * Friends
 *
 * NOT YET IMPLEMENTED. This placeholder exists so the navigator compiles while
 * the screen is being written. It says so plainly rather than pretending to
 * work, and it must not survive into a release build.
 */
export function FriendsScreen(): React.JSX.Element {
  return (
    <Screen>
      <EmptyState icon="🚧" title="Friends" body="This screen is not built yet." />
    </Screen>
  );
}
