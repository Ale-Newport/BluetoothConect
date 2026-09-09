const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro in a pnpm workspace.
 *
 * pnpm stores real packages under a content-addressed .pnpm store and links
 * them in, so Metro has to be told (a) to watch the whole workspace, not just
 * this app, and (b) where to resolve modules from. Without watchFolders, an
 * edit in packages/core would not trigger a reload; without the extra
 * nodeModulesPaths, the workspace packages resolve but their dependencies do
 * not. `unstable_enableSymlinks` is what makes pnpm's link farm resolvable at
 * all.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
    disableHierarchicalLookup: false,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
