// Gives each CI build of the plugin its own version, so the Supernote installs it
// as an update (it compares versionCode) and the settings page can show which
// build is running. Run from the repo root before bundling.
//   versionName 0.2.<run>, versionCode <run>, commit = short SHA
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const run = Number(process.env.GITHUB_RUN_NUMBER || process.argv[2] || 0);
const commit = (process.env.GITHUB_SHA || process.argv[3] || 'dev').slice(0, 7);
const version = `0.2.${run}`;
const plugin = join(process.cwd(), 'packages', 'plugin');

const configPath = join(plugin, 'PluginConfig.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.versionName = version;
config.versionCode = String(Math.max(2, run));
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const pkgPath = join(plugin, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

writeFileSync(
  join(plugin, 'src', 'buildInfo.ts'),
  `// Written by scripts/stamp-plugin-version.mjs in CI.\nexport const BUILD = { version: '${version}', commit: '${commit}' };\n`,
);
console.log(`Plugin version ${version} (code ${config.versionCode}, commit ${commit})`);
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`, { flag: 'a' });
