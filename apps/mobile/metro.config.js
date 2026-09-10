const path = require('path');
const fs = require('fs');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro, in a pnpm workspace, for a TypeScript codebase that writes explicit
 * extensions.
 *
 * Two things need solving here.
 *
 * 1. THE WORKSPACE. pnpm stores real packages in a content-addressed store and
 *    links them in, so Metro has to be told to watch the whole workspace (or an
 *    edit in packages/core never triggers a reload) and where to resolve
 *    modules from (or the workspace packages resolve but their dependencies do
 *    not). `unstable_enableSymlinks` is what makes pnpm's link farm resolvable
 *    at all.
 *
 * 2. THE ".js" EXTENSIONS. The TypeScript sources import siblings as
 *    `./thing.js`, which is what Node's ESM resolution and TypeScript's own
 *    `moduleResolution: "bundler"` expect - the extension refers to the file
 *    that will EXIST after compilation. Metro does not do that rewriting, so it
 *    looks for a literal `thing.js`, fails, and the whole bundle dies with
 *    "Unable to resolve module".
 *
 *    Rather than strip the extensions from several hundred imports and diverge
 *    from what `tsc` and `vitest` want, the resolver below maps a failed `.js`
 *    request onto the `.ts`/`.tsx` file that is actually there. It only rewrites
 *    RELATIVE imports, and only when the TypeScript file genuinely exists, so a
 *    real `.js` dependency inside node_modules is untouched.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const TS_EXTENSIONS = ['.ts', '.tsx'];

/** `./foo.js` -> `./foo.ts` when that file exists on disk. */
function rewriteTypeScriptSibling(context, moduleName) {
  if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) return null;
  if (!moduleName.endsWith('.js')) return null;

  const origin = context.originModulePath;
  if (!origin) return null;

  const base = path.resolve(path.dirname(origin), moduleName.slice(0, -'.js'.length));
  for (const extension of TS_EXTENSIONS) {
    const candidate = base + extension;
    if (fs.existsSync(candidate)) return { type: 'sourceFile', filePath: candidate };
  }
  return null;
}

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
    resolveRequest: (context, moduleName, platform) => {
      const rewritten = rewriteTypeScriptSibling(context, moduleName);
      if (rewritten) return rewritten;
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
