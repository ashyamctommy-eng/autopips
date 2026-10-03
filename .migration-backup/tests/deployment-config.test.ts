import './helpers/test-env';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DEPLOYMENT CONFIGURATION — drift guard for the two runtime images.
 *
 * This repository ships TWO containers from one codebase, and they are not
 * interchangeable:
 *
 *   web    `Dockerfile`         `railway.toml`         -> `npm start`     (next start)
 *   worker `Dockerfile.worker`  `railway.worker.toml`  -> `npm run start:ws`
 *
 * On 2026-09-27 a Railway worker service was built from the WEB Dockerfile and
 * started with the worker start command. It died with
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/app/src/server/main.ts'
 *
 * which is a true statement about a missing file and a useless statement about
 * the cause: the web image has no `src/` by design, and `tsx` is a devDependency
 * its runner stage prunes. Nothing in the repository was broken. What made it
 * expensive was that the invariants which would have identified the mistake
 * lived only in prose — in container-image build steps, in Railway's UI, and in
 * a Dockerfile header — so no gate could fail on the commit that broke them.
 *
 * This file turns those invariants into assertions. It is deliberately TEXTUAL:
 * it does not parse Dockerfiles or YAML, it pins the specific strings that make
 * the two deployment shapes correct, so an edit that blurs them fails CI with a
 * pointer at the reason rather than at a stack trace three layers away.
 *
 * It also pins the one thing a future session is most likely to "fix" wrongly:
 * `start:ws` must NOT be rewritten to `node dist/server/main.js`. Nothing in this
 * repository builds `dist/`, and `tsc` does not rewrite the `@/*` path aliases,
 * so that entrypoint cannot resolve its own imports. See the `Dockerfile.worker`
 * header ("WHY `tsx` AND NOT `dist/`") for the full reasoning.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

interface PackageJson {
  scripts: Record<string, string>;
}

const pkg = JSON.parse(read('package.json')) as PackageJson;

/** Active (non-comment) lines of a dotfile-style ignore file. */
function activeLines(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * A Dockerfile with its comment lines removed: the instructions that build and
 * run something, as opposed to the prose that explains them. This matters for
 * the negative assertions below — the `Dockerfile.worker` header discusses
 * `node dist/server/main.js` at length precisely to record why the image must
 * never use it, so a naive grep over the whole file would match the warning and
 * fail the very rule the warning documents.
 */
function dockerfileInstructions(relativePath: string): string {
  return activeLines(read(relativePath)).join('\n');
}

describe('railway.worker.toml selects the worker image and the guarded start command', () => {
  const worker = read('railway.worker.toml');

  it('builds from Dockerfile.worker with the Dockerfile builder', () => {
    expect(worker).toMatch(/builder\s*=\s*"DOCKERFILE"/);
    expect(worker).toMatch(/dockerfilePath\s*=\s*"Dockerfile\.worker"/);
  });

  it('starts via `npm run start:ws`, which runs the preflight guard', () => {
    expect(worker).toMatch(/startCommand\s*=\s*"npm run start:ws"/);
    expect(pkg.scripts['prestart:ws']).toBe('node scripts/worker-preflight.mjs');
  });

  it('stays at exactly one replica and probes /healthz', () => {
    expect(worker).toMatch(/numReplicas\s*=\s*1/);
    expect(worker).toMatch(/healthcheckPath\s*=\s*"\/healthz"/);
  });
});

describe('railway.toml selects the web image and the web start command', () => {
  const web = read('railway.toml');

  it('builds from Dockerfile and starts with `npm start`', () => {
    expect(web).toMatch(/builder\s*=\s*"DOCKERFILE"/);
    expect(web).toMatch(/dockerfilePath\s*=\s*"Dockerfile"/);
    expect(web).toMatch(/startCommand\s*=\s*"npm start"/);
  });
});

describe('package.json keeps the worker on tsx, never on a compiled dist entrypoint', () => {
  it('runs the worker entrypoint through tsx', () => {
    expect(pkg.scripts['start:ws']).toBe('tsx src/server/main.ts');
  });

  it('does not reference dist/ from the scripts that start or build a runtime', () => {
    // `build:server` (tsc -> dist) exists, but nothing that starts a process may
    // depend on it: tsc leaves `@/*` imports unresolved. This assertion exists to
    // fail the next well-meaning "use the compiled output in production" edit.
    for (const name of ['start:ws', 'start', 'dev:ws', 'build']) {
      expect(pkg.scripts[name]).not.toMatch(/\bdist\b/);
    }
  });
});

describe('the worker image contains what the worker start command needs', () => {
  const dockerfile = dockerfileInstructions('Dockerfile.worker');

  it('copies src/ and the preflight guard', () => {
    expect(dockerfile).toMatch(/COPY src \.\/src/);
    expect(dockerfile).toMatch(/COPY scripts \.\/scripts/);
  });

  it('runs `npm run start:ws` as its default command', () => {
    expect(dockerfile).toMatch(/CMD \["npm", "run", "start:ws"\]/);
  });

  it('installs the full dependency tree, so tsx survives', () => {
    // `tsx` is a devDependency. Pruning dev dependencies here would remove the
    // runtime that executes the worker, which is why the prune belongs to the web
    // image and must never be copied into this one.
    expect(dockerfile).not.toMatch(/npm prune/);
    expect(dockerfile).toMatch(/npm ci/);
  });

  it('never points at a compiled entrypoint', () => {
    expect(dockerfile).not.toMatch(/dist\/server\/main\.js/);
  });
});

describe('the web image stays web-only, which is what makes the guard necessary', () => {
  const dockerfile = dockerfileInstructions('Dockerfile');

  it('does not copy the server source tree', () => {
    // If this ever becomes true, the preflight guard's diagnosis ("this is the
    // web image, it has no src/") would be wrong and must be revisited together
    // with this assertion.
    expect(dockerfile).not.toMatch(/COPY src \.\/src/);
  });
});

describe('.dockerignore keeps both images buildable', () => {
  const ignored = activeLines(read('.dockerignore'));

  it('never excludes the trees the worker image copies', () => {
    expect(ignored).not.toContain('src');
    expect(ignored).not.toContain('scripts');
    expect(ignored).not.toContain('src/');
    expect(ignored).not.toContain('scripts/');
    expect(ignored).not.toContain('prisma');
  });
});

describe('the worker preflight guard runs in either image', () => {
  const preflight = read('scripts/worker-preflight.mjs');

  it('depends on node builtins only, so the pruned web image can execute it', () => {
    const specifiers = [...preflight.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier.startsWith('node:')).toBe(true);
    }
  });

  it('names the file to fix and the entrypoint not to use', () => {
    expect(preflight).toContain('railway.worker.toml');
    expect(preflight).toContain('Dockerfile.worker');
    expect(preflight).toContain('RAILWAY_DOCKERFILE_PATH');
    expect(preflight).toContain('dist/server/main.js');
  });
});
