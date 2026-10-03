import './helpers/test-env';

import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_FEED_LIMIT,
  isTradingActivity,
  mergeActivity,
  TRADING_ACTION_PREFIXES,
} from '@/lib/activity';
import type { ActivityEventDTO } from '@/types/api';

/**
 * Messages feed — the merge rule behind `/dashboard/messages`.
 *
 * The feed has two real sources (the audit rows the server read, and the
 * `bot:activity` events the socket delivered) and no others. These tests pin the
 * three properties the screen depends on and that are easy to break by accident:
 *
 *   1. the account-wide audit trail is narrowed to trading activity, so a
 *      sign-in or a settlement never appears in the trading log;
 *   2. an event that arrives over both paths is one message, not two, and the
 *      live copy is the one kept;
 *   3. the newest message is first, and the list is capped.
 *
 * They are pure: no database, no socket. The components above them are wiring.
 */

function event(overrides: Partial<ActivityEventDTO> & { id: string }): ActivityEventDTO {
  return {
    action: 'POSITION_OPENED',
    message: 'message',
    severity: 'info',
    details: {},
    createdAt: '2026-09-27T10:00:00.000Z',
    ...overrides,
  };
}

describe('isTradingActivity', () => {
  it('accepts every configured prefix', () => {
    for (const prefix of TRADING_ACTION_PREFIXES) {
      expect(isTradingActivity({ action: `${prefix}SOMETHING` })).toBe(true);
    }
  });

  it('rejects account actions that share the audit table', () => {
    for (const action of ['LOGIN_SUCCEEDED', 'DEPOSIT_CREDITED', 'WITHDRAWAL_REQUESTED', 'KYC_APPROVED']) {
      expect(isTradingActivity({ action })).toBe(false);
    }
  });
});

describe('mergeActivity', () => {
  it('keeps one copy of an event delivered by both sources, preferring the live payload', () => {
    const stored = event({ id: 'e1', message: 'stored copy', createdAt: '2026-09-27T10:00:00.000Z' });
    const live = event({ id: 'e1', message: 'live copy', createdAt: '2026-09-27T10:00:00.000Z' });

    const merged = mergeActivity([live], [stored]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.message).toBe('live copy');
  });

  it('orders newest first across both sources', () => {
    const older = event({ id: 'old', createdAt: '2026-09-27T09:00:00.000Z' });
    const newer = event({ id: 'new', createdAt: '2026-09-27T11:00:00.000Z' });

    expect(mergeActivity([newer], [older]).map((item) => item.id)).toEqual(['new', 'old']);
    expect(mergeActivity([older], [newer]).map((item) => item.id)).toEqual(['new', 'old']);
  });

  it('caps the result and never exceeds the limit', () => {
    const many = Array.from({ length: ACTIVITY_FEED_LIMIT + 25 }, (_, index) =>
      event({
        id: `e${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 27, 10, 0, index)).toISOString(),
      }),
    );

    const merged = mergeActivity([], many);

    expect(merged).toHaveLength(ACTIVITY_FEED_LIMIT);
    expect(merged[0]?.id).toBe(`e${ACTIVITY_FEED_LIMIT + 24}`);
  });

  it('handles an empty stream without inventing an entry', () => {
    expect(mergeActivity([], [])).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const live = [event({ id: 'a' })];
    const stored = [event({ id: 'b' })];

    mergeActivity(live, stored);

    expect(live).toHaveLength(1);
    expect(stored).toHaveLength(1);
  });
});
