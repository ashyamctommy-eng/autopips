import './helpers/test-env';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NO-EMOJI POLICY — enforced, not just documented.
 *
 * The product is an institutional trading platform. Emoji carry no meaning in a
 * money context, render differently on every platform, and cannot be themed,
 * labelled for a screen reader, or coloured by the design tokens. The rule is
 * therefore absolute: every icon in this codebase is a `lucide-react` component,
 * which the design system can size, colour and hide from assistive technology
 * correctly.
 *
 * This test is the mechanism that keeps the rule true as the product grows. It
 * scans the source (not the built output) so a stray emoji fails CI on the commit
 * that introduced it, where the fix is obvious.
 *
 * WHAT COUNTS AS AN EMOJI
 *   `\p{Emoji_Presentation}` — exactly the codepoints that render as emoji by
 *   DEFAULT. That deliberately excludes the typographic characters this codebase
 *   legitimately uses in prose and comments: the section sign, the em dash, the
 *   arrow `->`/`\u2192`, the check and ballot marks, and `(c)`. Those are text, not
 *   pictures, and they carry no emoji presentation unless a variation selector is
 *   appended — which this test rejects separately.
 *
 *   Zero-width joiner sequences and regional indicators are checked too: they are
 *   how flags and composite emoji are built, and neither is ever wanted here.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');

/** Files that are source, not generated output or dependencies. */
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.mjs']);

/** Renders as emoji by default (U+1F300 and friends, (tm), (r), digits-with-keycap). */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
/** Presentation selectors force emoji rendering onto an otherwise-text codepoint. */
const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/u;
/** Zero-width joiner — only used to compose emoji sequences. */
const ZERO_WIDTH_JOINER = /\u200D/u;
/** Regional indicator pairs, i.e. flags. */
const REGIONAL_INDICATORS = /[\u{1F1E6}-\u{1F1FF}]/u;

function emojiReason(line: string): string | null {
  // Most specific reason first: a flag is also made of emoji-presentation
  // codepoints, and "regional indicator" is the message that tells the author
  // what to remove.
  if (REGIONAL_INDICATORS.test(line)) return 'regional indicator (flag)';
  if (ZERO_WIDTH_JOINER.test(line)) return 'zero-width joiner (composed emoji)';
  if (VARIATION_SELECTORS.test(line)) return 'variation selector (forces emoji rendering)';
  if (EMOJI_PRESENTATION.test(line)) return 'emoji-presentation character';
  return null;
}

interface Offence {
  file: string;
  line: number;
  reason: string;
  excerpt: string;
}

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function scanSource(): Offence[] {
  const offences: Offence[] = [];

  for (const file of walk(SOURCE_ROOT)) {
    const contents = fs.readFileSync(file, 'utf8');
    contents.split(/\r?\n/).forEach((line, index) => {
      const reason = emojiReason(line);
      if (!reason) return;
      offences.push({
        file: path.relative(REPO_ROOT, file),
        line: index + 1,
        reason,
        excerpt: line.trim().slice(0, 120),
      });
    });
  }

  return offences;
}

describe('no-emoji policy', () => {
  it('detects emoji reliably (so a green result means something)', () => {
    // Self-test: the guard must actually fire, or every later assertion is vacuous.
    expect(emojiReason('All set! 🚀')).toContain('emoji-presentation');
    expect(emojiReason('flagged 🇬🇧')).toContain('regional indicator');
    expect(emojiReason('family 👨‍👩‍👧')).not.toBeNull();
    expect(emojiReason('marked \u2714\ufe0f')).toContain('variation selector');
  });

  it('permits typographic punctuation that is not an emoji', () => {
    // These appear throughout the codebase and are NOT emoji: they must pass, or
    // the guard becomes noise and gets deleted.
    expect(emojiReason('10 -> 20 and A \u2192 B')).toBeNull();
    expect(emojiReason('cash \u2014 all rights reserved (c) 2026')).toBeNull();
    expect(emojiReason('ok \u2713 / not ok \u2717')).toBeNull();
    expect(emojiReason('sum \u03a3 of the parts, up to 100 %')).toBeNull();
  });

  it('uses lucide-react for every icon in src/', () => {
    const offences = scanSource();
    const report = offences
      .map((entry) => `${entry.file}:${entry.line} [${entry.reason}] ${entry.excerpt}`)
      .join('\n');

    expect(
      offences,
      offences.length === 0
        ? ''
        : `Emoji found in source. Replace each with a lucide-react icon:\n${report}`,
    ).toEqual([]);
  });
});
