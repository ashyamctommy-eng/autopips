import { describe, expect, it } from 'vitest';

import {
  CURRENT_LEGAL_DOCUMENTS,
  canonicalDocumentText,
  currentLegalDocuments,
  findCurrentDocument,
  legalContentHash,
  type LegalDocumentDefinition,
} from '@/server/modules/legal/legal.documents';

/**
 * The legal registry is the source of truth for what a client accepted: the
 * `contentHash` stored on every consent row is the SHA-256 of the text this
 * module serves. These tests pin the properties that make a consent record
 * trustworthy — that all three instruments exist and are versioned, and that the
 * hash is deterministic and text-sensitive.
 *
 * No database is involved (that is the point of the module split).
 */

describe('legal document registry', () => {
  it('publishes exactly the three instruments a registration accepts', () => {
    const types = CURRENT_LEGAL_DOCUMENTS.map((doc) => doc.type).sort();
    expect(types).toEqual(['PRIVACY_POLICY', 'RISK_DISCLOSURE', 'TERMS_OF_SERVICE']);
  });

  it('gives every document a version, an effective date, a public url and non-empty text', () => {
    for (const doc of CURRENT_LEGAL_DOCUMENTS) {
      expect(doc.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.url.startsWith('/')).toBe(true);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.paragraphs.length).toBeGreaterThan(0);
      for (const paragraph of doc.paragraphs) {
        expect(paragraph.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('uses a distinct version per type for the current revision', () => {
    const keys = CURRENT_LEGAL_DOCUMENTS.map((doc) => `${doc.type}:${doc.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('hashes the served text deterministically as 64 hex chars', () => {
    const doc = CURRENT_LEGAL_DOCUMENTS[0];
    const hash = legalContentHash(doc);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(legalContentHash(doc)).toBe(hash);
    expect(currentLegalDocuments()[0].contentHash).toBe(hash);
  });

  it('changes the hash when the served text changes (the record is text-sensitive)', () => {
    const base: LegalDocumentDefinition = CURRENT_LEGAL_DOCUMENTS[0];
    const tampered: LegalDocumentDefinition = {
      ...base,
      paragraphs: [...base.paragraphs.slice(0, -1), `${base.paragraphs.at(-1)} (edited)`],
    };
    expect(legalContentHash(tampered)).not.toBe(legalContentHash(base));
  });

  it('canonical text is the paragraphs joined by blank lines', () => {
    const doc = CURRENT_LEGAL_DOCUMENTS[1];
    expect(canonicalDocumentText(doc)).toBe(doc.paragraphs.join('\n\n'));
  });

  it('resolves a current document by type and refuses an unknown type', () => {
    expect(findCurrentDocument('TERMS_OF_SERVICE').url).toBe('/terms');
    expect(findCurrentDocument('PRIVACY_POLICY').url).toBe('/privacy');
    expect(() => findCurrentDocument('NOT_A_DOCUMENT' as never)).toThrow();
  });
});
