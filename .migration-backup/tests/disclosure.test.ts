import { describe, expect, it } from 'vitest';

import { splitNoticeParagraphs } from '@/server/modules/legal/disclosure';
import { SETTING_DEFINITIONS } from '@/server/modules/settings/settings.service';

/**
 * The public execution disclosure.
 *
 * Two things are load-bearing:
 *   1. paragraph splitting matches what the admin textarea promises (a blank line
 *      separates paragraphs), so an operator edit renders as intended;
 *   2. the built-in default actually states the internal-execution facts — a
 *      disclosure that quietly omitted "Autopipsz is your counterparty" would be
 *      the exact failure this exists to prevent.
 */

describe('splitNoticeParagraphs', () => {
  it('splits on blank lines and trims', () => {
    expect(splitNoticeParagraphs('One.\n\nTwo.\n\n  Three.  ')).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('preserves a single line break inside a paragraph', () => {
    expect(splitNoticeParagraphs('Line one\nLine two\n\nNext.')).toEqual([
      'Line one\nLine two',
      'Next.',
    ]);
  });

  it('drops empty paragraphs from stray blank lines', () => {
    expect(splitNoticeParagraphs('\n\nA\n\n\n\nB\n\n')).toEqual(['A', 'B']);
  });

  it('returns an empty list for whitespace only', () => {
    expect(splitNoticeParagraphs('   \n\n  ')).toEqual([]);
  });
});

describe('internal execution disclosure default', () => {
  const definition = SETTING_DEFINITIONS.find(
    (def) => def.key === 'disclosure.internal_execution_notice',
  );

  it('is registered as operator-editable long text', () => {
    expect(definition).toBeDefined();
    expect(definition?.kind).toBe('longtext');
    // The console caps `text` at 500 chars; a real disclosure needs more room.
    expect(definition?.defaultValue.length).toBeGreaterThan(500);
    expect(definition?.defaultValue.length).toBeLessThanOrEqual(8000);
  });

  it('states the facts that make the disclosure honest', () => {
    const paragraphs = splitNoticeParagraphs(definition?.defaultValue ?? '');
    expect(paragraphs.length).toBeGreaterThanOrEqual(5);

    const text = paragraphs.join(' ').toLowerCase();
    // The counterparty shift is the point: without these the page would still
    // imply third-party broker execution.
    expect(text).toContain('counterparty');
    expect(text).toContain('no order is placed');
    expect(text).toContain('not a licensed venue');
    expect(text).toContain('compensation scheme');
    // Synthetics cannot be traded anywhere; saying so avoids a second false claim.
    expect(text).toContain('r_10');
  });

  it('contains no fabricated-data vocabulary', () => {
    // Mirrors the static guard's ban list; kept here so an operator edit that
    // reintroduces this language is caught in the same place as the default.
    const banned = /\b(mock\w*|fake\w*|dummy\w*|placeholder\w*|simulat\w*)\b/i;
    expect(banned.test(definition?.defaultValue ?? '')).toBe(false);
  });
});
