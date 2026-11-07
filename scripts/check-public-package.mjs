#!/usr/bin/env node
// Publish hygiene guard: this package must never gain runtime dependencies.
// The DSH runtime provides @deepseek-ai/* packages; bundling or depending on them
// from npm would shadow the runtime's own copies (vendor-shadowing discipline).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const failures = [];
if (pkg.name !== 'dsh-send-later') failures.push(`name must be "dsh-send-later", got "${pkg.name}"`);
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  failures.push(`runtime dependencies are not allowed (${Object.keys(pkg.dependencies).join(', ')})`);
}
if (pkg.peerDependencies?.['@deepseek-ai/cordis'] === undefined) {
  failures.push('peerDependencies["@deepseek-ai/cordis"] must stay declared');
}
if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  failures.push('publishConfig.registry must pin the official npm registry');
}
if (pkg.license !== 'MIT') failures.push('license must be MIT');

if (failures.length > 0) {
  console.error('check-public-package failed:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log('check-public-package: ok');
