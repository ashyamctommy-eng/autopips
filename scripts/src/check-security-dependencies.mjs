import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pruned = new Set([
  'node_modules', '.git', 'vendor', '.venv', 'venv', 'target', 'dist', 'build',
  '.next', '.cache', 'coverage', 'out-tsc',
]);
const filenames = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
]);
const flagged = new Map([
  ['postcss', new Set(['8.4.31'])],
  ['next', new Set(['14.2.35'])],
  ['vite', new Set(['5.4.21'])],
  ['braces', new Set(['3.0.3'])],
  ['vitest', new Set(['2.1.9', '3.2.7'])],
  ['@vitest/mocker', new Set(['2.1.9', '3.2.7'])],
  ['brace-expansion', new Set(['5.0.9'])],
  ['fast-uri', new Set(['3.1.7'])],
  ['esbuild', new Set(['0.21.5'])],
  ['lodash', new Set(['4.17.23'])],
  ['glob', new Set(['10.3.10'])],
]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !pruned.has(entry.name)) yield* walk(path.join(dir, entry.name));
    else if (entry.isFile() && filenames.has(entry.name)) yield path.join(dir, entry.name);
  }
}

const files = [...walk(root)].sort();
const errors = [];
const fail = (file, name, version) => errors.push(`${path.relative(root, file)}: ${name}@${version}`);
function check(file, name, version) {
  if (typeof version !== 'string') return;
  if (flagged.get(name)?.has(version.replace(/^[~^=]/, ''))) fail(file, name, version);
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const data = JSON.parse(text);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']) {
      for (const [name, version] of Object.entries(data[field] || {})) check(file, name, version);
    }
    for (const [key, dataPackage] of Object.entries(data.packages || {})) {
      const name = dataPackage.name || key.split('node_modules/').at(-1);
      check(file, name, dataPackage.version);
    }
    // npm v1 lockfiles nest dependency records.
    const pending = [data.dependencies];
    while (pending.length) {
      const dependencies = pending.pop();
      for (const [name, dep] of Object.entries(dependencies || {})) {
        if (dep && typeof dep === 'object') {
          check(file, name, dep.version);
          if (dep.dependencies) pending.push(dep.dependencies);
        }
      }
    }
  } else {
    for (const [name, versions] of flagged) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const version of versions) {
        const ver = version.replaceAll('.', '\\.');
        const pattern = new RegExp(`(?:^|[\\s"' /])${escaped}@(?:[~^])?${ver}(?=[\\s"'(:]|$)`, 'm');
        if (pattern.test(text)) fail(file, name, version);
      }
    }
  }
}
console.log(`Checked ${files.filter(f => f.endsWith('package.json')).length} manifests and ${files.filter(f => !f.endsWith('package.json')).length} lockfiles (including untracked and hidden directories).`);
if (errors.length) {
  console.error(`Vulnerable pins remain:\n${errors.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('None of the reported vulnerable package/version pairs remain.');
}