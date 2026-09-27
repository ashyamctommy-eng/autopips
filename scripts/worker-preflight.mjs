#!/usr/bin/env node
/**
 * WORKER PREFLIGHT — the guard against starting the socket + bot runtime in the
 * wrong image.
 *
 * HOW IT RUNS
 *   `package.json` defines `prestart:ws`, and npm runs a `pre<name>` script
 *   automatically before `<name>`. So this file executes before
 *   `npm run start:ws` — which is the exact command `railway.worker.toml` sets as
 *   the worker service's start command. If this script exits non-zero, npm does
 *   not run the main script at all. The start path itself is untouched: no
 *   wrapper process, no signal-forwarding change, no new runtime dependency.
 *
 * WHY IT EXISTS
 *   On 2026-09-27 the Railway worker deploy failed with
 *
 *     ERR_MODULE_NOT_FOUND: Cannot find module '/app/src/server/main.ts'
 *
 *   which says nothing about the actual problem: the image had been built from
 *   the WEB Dockerfile (or by Railpack), not from `Dockerfile.worker`. The web
 *   image deliberately does not contain `src/`, and `tsx` is a devDependency that
 *   its runner stage prunes away. The repository was correct; the service
 *   configuration was not, and the failure pointed at a missing file instead of
 *   at the wrong Dockerfile — which is why it cost a debugging round trip.
 *
 *   The two images are not interchangeable and never were:
 *     * `Dockerfile`        (web,     railway.toml)        -> `npm start`  (next start)
 *     * `Dockerfile.worker` (worker,  railway.worker.toml) -> `npm run start:ws`
 *
 *   This script turns both wrong-image failure modes into one sentence naming the
 *   file to set, before anything else is attempted.
 *
 *   It is intentionally dependency-free (node: builtins only) and therefore runs
 *   in EITHER image, including the pruned web image, which is the whole point.
 *
 * DELIBERATELY NOT CHECKED HERE
 *   The environment contract (DATABASE_URL, REDIS_URL, JWT_SECRET, ...) is
 *   validated by `src/lib/env.ts`, which exits 1 naming every missing variable.
 *   Duplicating that list here would create a second source of truth that drifts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY = path.join(REPO_ROOT, 'src', 'server', 'main.ts');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

const CONFIG_FILE_PATH = '/railway.worker.toml';

function fail(problem, detail) {
  const lines = [
    '',
    '[worker-preflight] FATAL: cannot start the socket + bot runtime in this image.',
    '',
    `  problem: ${problem}`,
  ];
  if (detail) lines.push(`  detail:  ${detail}`);
  lines.push(
    '',
    '  This process must run from the WORKER image, which is built from',
    '  "Dockerfile.worker" and contains src/ plus the full dependency tree',
    '  (tsx is a devDependency and is required here). The WEB image is built from',
    '  "Dockerfile" and contains neither, by design.',
    '',
    '  Fix the Railway WORKER service, not this repository:',
    `    1. Settings -> Config-as-code -> Config File Path = ${CONFIG_FILE_PATH}`,
    '    2. Settings -> Root Directory = the repository root (leave it empty at "/")',
    '    3. Settings -> Build -> Builder = Dockerfile (NOT Railpack/Nixpacks)',
    '    4. Unset any RAILWAY_DOCKERFILE_PATH variable: it silently overrides',
    '       config-as-code and is the usual reason the wrong Dockerfile is used.',
    '    5. Clear any Start Command override in the Railway UI: the deployed',
    '       config file already sets "npm run start:ws".',
    '',
    '  Do NOT change the start command to "node dist/server/main.js": nothing in',
    '  this repository builds dist/, and tsc does not rewrite the "@/*" path',
    '  aliases, so that entrypoint cannot resolve its own imports. See the header',
    '  of Dockerfile.worker ("WHY tsx AND NOT dist/").',
    '',
  );
  process.stderr.write(lines.join('\n'));
  process.exit(1);
}

const hasEntry = fs.existsSync(ENTRY);
const hasTsx = fs.existsSync(TSX);

if (!hasEntry || !hasTsx) {
  const builtNextApp = fs.existsSync(path.join(REPO_ROOT, '.next'));

  const problem = !hasEntry
    ? `the worker entrypoint is missing (${path.relative(REPO_ROOT, ENTRY)})`
    : `the TypeScript runtime is missing (${path.relative(REPO_ROOT, TSX)})`;

  const detail = builtNextApp
    ? 'this image contains a built Next.js app (.next/) and no worker source, so it is the WEB image'
    : 'this image does not contain the worker source tree';

  fail(problem, detail);
}

if (process.env.NODE_ENV !== 'production') {
  process.stderr.write(
    '[worker-preflight] WARNING: NODE_ENV is not "production". The socket server binds\n' +
      '  127.0.0.1 in development and is therefore unreachable from another container;\n' +
      '  the worker image sets NODE_ENV=production for exactly this reason.\n',
  );
}

process.stdout.write(
  '[worker-preflight] ok: worker entrypoint and tsx runtime present, starting the socket + bot runtime.\n',
);
