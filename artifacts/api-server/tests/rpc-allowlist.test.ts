import './helpers/test-env';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { readMethods } from '../src/migration-api';
import { REPO_ROOT } from './helpers/test-env';

/**
 * SPA ↔ RPC ALLOW-LIST CONTRACT GUARD.
 *
 * The Vite SPA has no Next.js server: a "server component" reads its data
 * through `POST /api/migration/query` via `remote(module, method)` in
 * `artifacts/autopips/src/lib/rpc.ts`. That endpoint serves nothing except the
 * closed list in `src/migration-api.ts` — anything else is refused with 404
 * `Unknown read operation.` *before* the session gate runs.
 *
 * WHY THIS TEST EXISTS (the incident it prevents)
 * ───────────────────────────────────────────────
 * The Active Strategy Tracker (`/dashboard/strategy`, commit c1aa0b2) read one
 * investment through `remote('server/modules/account/account.service',
 * 'getInvestmentForUser')`. The method was implemented, correct, REST-reachable
 * and unit-tested — and absent from the allow-list. The page awaits that read
 * during render, so the refusal was not a quiet empty state: it replaced the
 * whole dashboard route with the group error boundary ("Something went wrong").
 * An account with no ACTIVE/PAUSED investment never makes the call and renders
 * normally, so the fault hid behind the operator's own empty demo account and
 * only appeared for the clients whose money was actually deployed.
 *
 * A missing entry is invisible to the API's own tests (every service method is
 * fine) and to the UI's (the call is one line). This is the only place the two
 * halves meet: every `remote(...)` the SPA ships must be named by the API.
 *
 * HOW
 * ──
 * The SPA sources are parsed with the TypeScript AST (never regex, so prose in a
 * comment cannot be mistaken for a call). Every call expression whose callee is
 * `remote` must pass two string literals; a dynamic call this guard cannot read
 * FAILS the test rather than slipping through, so the scan can never pass
 * vacuously. Each pair is then required in `readMethods`.
 *
 * It is a STATIC guard: it never imports or executes the SPA.
 */

const SPA_SRC = path.resolve(REPO_ROOT, '..', 'autopips', 'src');
/** The `remote()` definition itself — a declaration, not a call site. */
const RPC_DEFINITION = path.join('lib', 'rpc.ts');

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, found);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

interface CallSite {
  rel: string;
  module: string;
  method: string;
}

const files = fs.existsSync(SPA_SRC) ? walk(SPA_SRC) : [];
const scanned = files.filter((file) => !file.endsWith(RPC_DEFINITION));

const callSites: CallSite[] = [];
const unreadable: string[] = [];

for (const file of scanned) {
  const rel = path.relative(SPA_SRC, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'remote') {
      const [moduleArg, methodArg] = node.arguments;
      if (
        node.arguments.length === 2 &&
        moduleArg !== undefined &&
        methodArg !== undefined &&
        ts.isStringLiteral(moduleArg) &&
        ts.isStringLiteral(methodArg)
      ) {
        callSites.push({ rel, module: moduleArg.text, method: methodArg.text });
      } else {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        unreadable.push(`${rel}:${line + 1} — remote() must be called with two string literals`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

describe('SPA remote reads are allow-listed by /api/migration/query', () => {
  it('finds the SPA sources', () => {
    expect(fs.existsSync(SPA_SRC)).toBe(true);
    expect(scanned.length).toBeGreaterThan(20);
  });

  it('reads every remote() call statically — no dynamic call can slip past this guard', () => {
    expect(unreadable).toEqual([]);
  });

  it('scans a non-trivial number of call sites', () => {
    // Guards against the scan silently matching nothing after a refactor.
    expect(callSites.length).toBeGreaterThanOrEqual(25);
  });

  it('allow-lists every method the SPA calls', () => {
    const refused = callSites
      .filter((call) => !(readMethods[call.module] ?? []).includes(call.method))
      .map((call) => `${call.module}#${call.method} (called from ${call.rel})`);

    expect(refused).toEqual([]);
  });

  it('allow-lists the strategy tracker read', () => {
    const tracker = callSites.find(
      (call) =>
        call.module === 'server/modules/account/account.service' &&
        call.method === 'getInvestmentForUser',
    );
    expect(tracker, 'the strategy tracker must still read its investment detail').toBeDefined();
    expect(readMethods['server/modules/account/account.service']).toContain('getInvestmentForUser');
  });
});
