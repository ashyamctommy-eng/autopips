import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers/test-env';

/**
 * ZERO-SIMULATION STATIC GUARD.
 *
 * This test reads the producer paths (`src/server/**` and `src/app/**`) as TEXT
 * and refuses to let a future contributor quietly reintroduce simulated
 * performance. It is a *static* guard: it never imports the modules it scans.
 *
 * WHY EACH RED FLAG IS BANNED
 * ───────────────────────────
 *  • `Math.random` — every number this platform shows (equity, P/L, win rate,
 *    lot size, deposit amount) must trace back to exactly one of three
 *    authorities: a MetaApi broker event, a verified NOWPayments IPN, or an
 *    admin action recorded in AuditLog. Randomness is fabricated data by
 *    definition, and it is also non-reproducible: a random number in a money
 *    path makes an incident impossible to replay.
 *  • `mock` / `fake` / `dummy` / `placeholder` — a mock data source is a
 *    simulated broker/ledger. The whole product claim ("no simulation") dies the
 *    moment a `mockMode` flag or a fallback fixture exists, because the flag can
 *    be enabled (or default to on) in production. The ONE allow-listed
 *    occurrence, `dummyVerify`, is a timing equalizer in the login path: it
 *    burns Argon2id CPU for an unknown email so response time cannot reveal
 *    whether an account exists. It produces no data.
 *  • literal arrays of trade objects — a hard-coded trade list (instrument +
 *    P/L) is fabricated track record: it would be summed by the accounting code
 *    and shown as real performance. Trade rows may only be written from
 *    broker-confirmed fills.
 *  • hard-coded win-rate / return literals in the strategy-stats path — the
 *    stats object is advertised publicly. A literal would be an invented track
 *    record; every field must be derived from `TradeRecord` rows.
 *
 * HOW THE SCAN WORKS
 * ──────────────────
 * 1. Comments and JSDoc are blanked out with the TypeScript AST comment ranges
 *    (never a regex — `https://…` string literals would break a regex stripper).
 *    Prose is excluded on purpose: this codebase *documents* the ban by naming
 *    the banned thing ("there is no `mockMode`"), and a check that failed on
 *    prose would force contributors to delete the documentation.
 * 2. The remaining CODE is asserted to be free of every red flag, with an
 *    explicit, justified allow-list.
 * 3. The RAW text is also scanned, and every raw occurrence must be either a
 *    comment or an allow-listed code match. Adding a new mention anywhere
 *    (including in a comment) fails this test until a human reviews it and
 *    records the justification here — that is the point of the allow-list.
 */

const SCAN_ROOTS: string[] = [path.join(REPO_ROOT, 'src', 'server'), path.join(REPO_ROOT, 'src', 'app')];

interface ScannedFile {
  /** Path relative to the repo root, POSIX separators. */
  rel: string;
  raw: string;
  /** Same length as `raw`, with every comment character replaced by a space. */
  code: string;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Blank out every comment range using the TypeScript AST (length-preserving). */
function stripComments(text: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
  const chars = text.split('');
  const ranges: Array<[number, number]> = [];

  const collect = (list: readonly ts.CommentRange[] | undefined): void => {
    if (!list) return;
    for (const range of list) ranges.push([range.pos, range.end]);
  };

  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const [start, end] of ranges) {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function scan(): ScannedFile[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    if (fs.existsSync(root)) listSourceFiles(root, files);
  }
  expect(files.length, 'the static guard must find producer files to scan').toBeGreaterThan(20);

  return files
    .map((full) => {
      const raw = fs.readFileSync(full, 'utf8');
      return { rel: path.relative(REPO_ROOT, full).split(path.sep).join('/'), raw, code: stripComments(raw, full) };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

const FILES = scan();

/** Line number (1-based) of an offset, for actionable failure messages. */
function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function codeMatches(source: string, pattern: RegExp): Array<{ index: number; match: string }> {
  const found: Array<{ index: number; match: string }> = [];
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match = regex.exec(source);
  while (match !== null) {
    found.push({ index: match.index, match: match[0] });
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
    match = regex.exec(source);
  }
  return found;
}

/** Banned vocabulary, as a single case-insensitive word pattern. */
const BANNED_VOCAB = /\b(mock\w*|fake\w*|dummy\w*|placeholder\w*|simulat\w*)\b/gi;

/** Performance fields that may never be assigned a numeric literal. */
const PERFORMANCE_LITERAL_PATTERNS: readonly RegExp[] = [
  /winRatePct\s*:\s*-?\d/,
  /winRate\s*:\s*-?\d/,
  /observedReturnPct\s*:\s*-?\d/,
  /profitFactor\s*:\s*-?\d/,
  /maxObservedDrawdownPct\s*:\s*-?\d/,
  /netPnL\s*:\s*-?\d/,
];

/**
 * A literal array of hard-coded trade objects: an array literal holding two or
 * more object literals that each carry trade-ish keys. That shape is, by
 * construction, a fabricated trade book.
 */
function tradeObjectArrayPattern(): RegExp {
  const tradeKey =
    '(?:netPnL|grossPnL|profit|pnl|instrument|symbol|volume|entryPrice|exitPrice|direction)';
  return new RegExp(`\\[\\s*(?:\\{[^{}]*${tradeKey}[^{}]*\\}\\s*,?\\s*){2,}\\]`, 'i');
}

/**
 * ALLOW-LIST — every occurrence that is allowed to exist, with its
 * justification. Anything not matched here is a failure.
 *
 * (a) CODE occurrences:
 *   `dummyVerify` — src/server/modules/auth/password.service.ts defines it and
 *   src/app/api/v1/auth/login/route.ts calls it. It is the documented
 *   timing-equalizer: it performs a real Argon2id verify against a reference
 *   hash so an unknown email costs the same CPU time as a known one. It returns
 *   nothing and touches no data — it cannot fabricate a record.
 */
const CODE_ALLOW_LIST: Array<{ rel: string; match: RegExp; justification: string }> = [
  {
    rel: 'src/server/modules/auth/password.service.ts',
    match: /^dummyVerify$/,
    justification: 'Documented timing-equalizer (no data produced) — see password.service.ts.',
  },
  {
    rel: 'src/app/api/v1/auth/login/route.ts',
    match: /^dummyVerify$/,
    justification: 'Call site of the documented timing-equalizer in the login handler.',
  },
];

/**
 * (b) RAW (comment) occurrences. These are PROSE that documents the policy, and
 * they are the reason the code scan strips comments. Keep this list exact: a new
 * entry means someone wrote a new sentence about simulation, and a human should
 * confirm it is prose and not a plan ("TODO: add mock data").
 */
const COMMENT_ALLOW_LIST: Array<{ rel: string; token: RegExp; justification: string }> = [
  {
    rel: 'src/server/accounting/strategy-stats.ts',
    token: /^(?:Simulation|placeholder)$/i,
    justification: 'Doc comment: explains that no placeholder may be shown without a verified track record.',
  },
  {
    rel: 'src/server/modules/broker/broker.types.ts',
    token: /^(?:SIMULATION|mockMode)$/i,
    justification: 'Doc comment: states the adapter has no mockMode — the ban itself.',
  },
  {
    rel: 'src/server/modules/broker/broker.registry.ts',
    token: /^placeholder$/i,
    justification: 'Doc comment: a placeholder mask/balance must never reach the admin UI.',
  },
  {
    rel: 'src/server/modules/broker/broker.sync.ts',
    token: /^placeholder$/i,
    justification: 'Code comment: the broker fill time replaces the placeholder written at fill time.',
  },
  {
    rel: 'src/server/modules/bot/bot.runtime.ts',
    token: /^simulated$/i,
    justification: 'Doc comment: the runtime contains no simulated prices, P/L or history.',
  },
  {
    rel: 'src/server/modules/auth/password.service.ts',
    token: /^fake$/i,
    justification: 'Doc comment: explains why a hard-coded fake PHC string is NOT used.',
  },
  {
    rel: 'src/server/modules/kyc/kyc.service.ts',
    token: /^SIMULATION$/i,
    justification: 'Doc comment: nothing here invents a verification result.',
  },
  {
    rel: 'src/server/modules/payments/nowpayments.client.ts',
    token: /^SIMULATION$/i,
    justification: 'Doc comment: the client returns provider responses verbatim (no simulated payments).',
  },
  {
    rel: 'src/server/modules/account/account.service.ts',
    token: /^(?:placeholder|simulation)$/i,
    justification: 'Doc comment: an unverified quota/estimate is reported as unknown, never as a placeholder number.',
  },
  {
    rel: 'src/server/modules/admin/admin.service.ts',
    token: /^placeholder$/i,
    justification: 'Doc comment: admin aggregates are absent until real rows exist, instead of zero placeholders.',
  },
  {
    rel: 'src/app/api/v1/admin/brokers/route.ts',
    token: /^placeholder$/i,
    justification: 'Doc comment: refusing to persist a placeholder account mask/balance.',
  },
];

function isCodeAllowed(rel: string, match: string): boolean {
  return CODE_ALLOW_LIST.some((entry) => entry.rel === rel && entry.match.test(match));
}

function isCommentAllowed(rel: string, token: string): boolean {
  return COMMENT_ALLOW_LIST.some((entry) => entry.rel === rel && entry.token.test(token));
}

describe('static guard: no fabricated data in the producer paths', () => {
  it('scans the expected producer paths', () => {
    const rels = FILES.map((file) => file.rel);
    expect(rels).toContain('src/server/accounting/equity.ts');
    expect(rels).toContain('src/server/accounting/ledger.ts');
    expect(rels).toContain('src/server/accounting/strategy-stats.ts');
    expect(rels).toContain('src/server/modules/bot/strategy.engine.ts');
    expect(rels).toContain('src/server/modules/broker/deriv.adapter.ts');
    expect(rels.some((rel) => rel.startsWith('src/app/api/'))).toBe(true);
  });

  it('contains no Math.random anywhere in code (fabricated + non-replayable numbers)', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const hit of codeMatches(file.code, /Math\.random/g)) {
        violations.push(`${file.rel}:${lineAt(file.code, hit.index)}`);
      }
    }
    expect(violations, `Math.random is forbidden in producer code: ${violations.join(', ')}`).toEqual([]);
  });

  it('contains no mock/fake/dummy/simulated/placeholder code, only the allow-listed dummyVerify', () => {
    const violations: string[] = [];
    const allowed: string[] = [];
    for (const file of FILES) {
      for (const hit of codeMatches(file.code, BANNED_VOCAB)) {
        if (isCodeAllowed(file.rel, hit.match)) {
          allowed.push(`${file.rel}:${lineAt(file.code, hit.index)} ${hit.match}`);
        } else {
          violations.push(`${file.rel}:${lineAt(file.code, hit.index)} "${hit.match}"`);
        }
      }
    }
    expect(
      violations,
      `Banned vocabulary in executable code (a simulated data source). If this is genuinely not data-producing, ` +
        `add it to CODE_ALLOW_LIST with a written justification: ${violations.join(' | ')}`,
    ).toEqual([]);
    // The allow-list must actually be used — otherwise it is stale (and the ban
    // would silently rot into dead documentation).
    expect(allowed.length).toBeGreaterThan(0);
    for (const entry of allowed) expect(entry).toMatch(/dummyVerify/);
  });

  it('every raw mention (comments included) is covered by the documented allow-list', () => {
    const unreviewed: string[] = [];
    const seen = new Set<string>();

    for (const file of FILES) {
      for (const hit of codeMatches(file.raw, BANNED_VOCAB)) {
        const line = lineAt(file.raw, hit.index);
        // Comment stripping is length-preserving, so an occurrence is CODE only
        // if the identical text sits at the identical offset in the stripped
        // source. Everything else was inside a comment/JSDoc.
        const sameOffsetInCode = file.code.slice(hit.index, hit.index + hit.match.length) === hit.match;

        if (sameOffsetInCode) {
          if (isCodeAllowed(file.rel, hit.match)) seen.add(`${file.rel}::${hit.match}`);
          else unreviewed.push(`${file.rel}:${line} "${hit.match}" (code)`);
        } else {
          if (isCommentAllowed(file.rel, hit.match)) seen.add(`${file.rel}::${hit.match}`);
          else unreviewed.push(`${file.rel}:${line} "${hit.match}" (comment)`);
        }
      }
    }

    expect(
      unreviewed,
      `Un-reviewed mention(s) of banned vocabulary. If it is prose documenting the ban, add it to ` +
        `COMMENT_ALLOW_LIST with a justification; if it is code, it must be removed: ${unreviewed.join(' | ')}`,
    ).toEqual([]);

    // Every allow-list entry must be live: a stale entry would silently permit a
    // future occurrence of the same shape.
    for (const entry of [...CODE_ALLOW_LIST, ...COMMENT_ALLOW_LIST]) {
      const keys = Array.from(seen).filter((key) => key.startsWith(`${entry.rel}::`));
      expect(keys.length, `allow-list entry for ${entry.rel} is stale (no occurrence found)`).toBeGreaterThan(0);
    }
  });

  it('contains no literal array of hard-coded trade objects (fabricated track record)', () => {
    const literalTradeArray = tradeObjectArrayPattern();

    const violations: string[] = [];
    for (const file of FILES) {
      const hit = literalTradeArray.exec(file.code);
      if (hit) violations.push(`${file.rel}:${lineAt(file.code, hit.index ?? 0)}`);
    }
    expect(
      violations,
      `Hard-coded trade objects found — trades may only be written from broker-confirmed fills: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('strategy stats are derived from TradeRecord rows, never from a literal', () => {
    const stats = FILES.find((file) => file.rel === 'src/server/accounting/strategy-stats.ts');
    expect(stats).toBeDefined();
    const code = stats?.code ?? '';

    // Positive controls: the producer reads the ledger…
    expect(code).toMatch(/prisma\.tradeRecord\.findMany/);
    // …and the non-guarantee flag is a literal `true` (the type forces the UI to
    // render the caveat, so it can never be turned off by data).
    expect(code).toMatch(/indicativeOnly:\s*true/);

    // Negative controls: no numeric literal may be assigned to a performance field.
    for (const pattern of PERFORMANCE_LITERAL_PATTERNS) {
      expect(pattern.test(code), `hard-coded performance literal ${String(pattern)} in strategy-stats.ts`).toBe(false);
    }
  });

  it('the deposit credit path verifies the IPN HMAC before any mutation', () => {
    const payments = FILES.find((file) => file.rel === 'src/server/modules/payments/payments.service.ts');
    expect(payments).toBeDefined();
    const code = payments?.code ?? '';
    expect(code).toMatch(/verifyIpnSignature/);

    // Inside `handleIpn`, the HMAC check must run before the first deposit write.
    const handlerStart = code.indexOf('export async function handleIpn');
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    const handler = code.slice(handlerStart, handlerStart + 12_000);
    const verifyCall = handler.indexOf('verifyIpnSignature({');
    const firstDepositWrite = handler.search(/prisma\.deposit\.(create|update|updateMany|upsert)/);
    expect(verifyCall).toBeGreaterThanOrEqual(0);
    expect(firstDepositWrite).toBeGreaterThanOrEqual(0);
    expect(verifyCall).toBeLessThan(firstDepositWrite);
    // And the invalid-signature branch must reject before touching the row.
    expect(handler).toMatch(/!verification\.valid/);
  });

  it('the broker adapter declares no simulation/mock mode switch', () => {
    const adapter = FILES.find((file) => file.rel === 'src/server/modules/broker/deriv.adapter.ts');
    expect(adapter).toBeDefined();
    const code = adapter?.code ?? '';
    expect(code).not.toMatch(/mock|simulate|simulation/i);
    // A positive control: the adapter really does talk to the broker.
    expect(code).toMatch(/DerivClient|deriv\.client|Deriv/);

    // The transport is held to the same rule: no simulated price source.
    const transport = FILES.find((file) => file.rel === 'src/server/modules/broker/deriv.client.ts');
    expect(transport).toBeDefined();
    expect(transport?.code ?? '').not.toMatch(/mock|simulate|simulation/i);
  });

  it('no faker/fixture-data generator is imported by producer code', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      for (const hit of codeMatches(file.code, /@faker-js|faker\b|chance\.|\bcasual\b/g)) {
        violations.push(`${file.rel}:${lineAt(file.code, hit.index)}`);
      }
    }
    expect(violations, `test-data generators must not exist in producer code: ${violations.join(', ')}`).toEqual([]);
  });
});

describe('static guard: the detectors actually detect (positive controls)', () => {
  /**
   * Without this block the guard could pass simply because its patterns are dead
   * (a typo in a regex is indistinguishable from a clean codebase). Each pattern
   * is therefore run against a synthetic forbidden snippet and must fire, and
   * against a benign snippet and must not.
   */
  it('Math.random detector fires on a randomised money path', () => {
    const snippet = 'const equity = 1000 + Math.random() * 500;';
    expect(codeMatches(snippet, /Math\.random/g)).toHaveLength(1);
    expect(codeMatches('const seed = 0x5eed1eaf;', /Math\.random/g)).toHaveLength(0);
  });

  it('banned-vocabulary detector fires on a mock data source and on a fabricated fallback', () => {
    const mockSource = "import { mockTrades } from './mock-trades';";
    expect(codeMatches(mockSource, BANNED_VOCAB).length).toBeGreaterThan(0);
    const fallback = "const price = quote ?? fakeQuote;";
    expect(codeMatches(fallback, BANNED_VOCAB).length).toBeGreaterThan(0);
    const simulation = 'if (mode === "simulation") return seededEquity;';
    expect(codeMatches(simulation, BANNED_VOCAB).length).toBeGreaterThan(0);
    expect(codeMatches('const placeholderValue = 0;', BANNED_VOCAB).length).toBeGreaterThan(0);
    expect(codeMatches('const verified = await verify(hash, password);', BANNED_VOCAB)).toHaveLength(0);
  });

  it('hard-coded trade array detector fires on a literal trade book', () => {
    const pattern = tradeObjectArrayPattern();
    const fabricated =
      "const seed = [{ instrument: 'XAUUSD', netPnL: 1200 }, { instrument: 'EURUSD', netPnL: -300 }];";
    expect(pattern.test(fabricated)).toBe(true);
    // A real broker mapping loop is not a literal book.
    expect(pattern.test('const rows = deals.map((d) => ({ instrument: d.instrument }));')).toBe(false);
    // A single object literal (one event) is not a book either.
    expect(pattern.test("const event = { instrument: 'XAUUSD', netPnL: 10 };")).toBe(false);
  });

  it('performance-literal detector fires on an invented win rate', () => {
    const pattern = PERFORMANCE_LITERAL_PATTERNS[0] as RegExp;
    expect(pattern.test('winRatePct: 87,')).toBe(true);
    expect(pattern.test('winRatePct: decisive === 0 ? null : usd(wins).div(decisive).toNumber(),')).toBe(false);
  });
});
