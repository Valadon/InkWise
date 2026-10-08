module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // htmlparser2's ESM build uses `export * as ns from`.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
