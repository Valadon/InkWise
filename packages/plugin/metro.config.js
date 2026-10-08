const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const coreDir = path.resolve(__dirname, '../core');
const defaultConfig = getDefaultConfig(__dirname);

/**
 * The plugin bundles @inkwise/core straight from its TypeScript source
 * (packages/core/src). Core uses NodeNext-style `./x.js` imports, so map those
 * to the `.ts` files Metro can see.
 */
const config = {
  watchFolders: [coreDir],
  resolver: {
    useWatchman: !process.env.CI,
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    unstable_conditionNames: ['react-native', 'require', 'default'],
    resolveRequest(context, moduleName, platform) {
      if (moduleName === '@inkwise/core') {
        return { type: 'sourceFile', filePath: path.join(coreDir, 'src/index.ts') };
      }
      if (
        moduleName.startsWith('.') &&
        moduleName.endsWith('.js') &&
        context.originModulePath.startsWith(coreDir + path.sep)
      ) {
        return context.resolveRequest(context, moduleName.replace(/\.js$/, '.ts'), platform);
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);
