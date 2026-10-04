import { describe, expect, it } from 'vitest';
import {
  normalizeTelemetryStrategyId,
  telemetryWinRatePct,
} from '../src/imported/server/modules/telemetry/telemetry.analytics';

describe('telemetry analytics helpers', () => {
  it('leaves win rate unavailable when there are no decisive closed outcomes', () => {
    expect(telemetryWinRatePct(0, 0)).toBeNull();
  });

  it('calculates win rate from wins and losses without inventing outcomes', () => {
    expect(telemetryWinRatePct(3, 1)).toBe(75);
    expect(telemetryWinRatePct(1, 2)).toBe(33.33);
  });

  it('maps the Golden Momentum slug and alias to one dashboard identifier', () => {
    expect(normalizeTelemetryStrategyId('gold-momentum')).toBe('golden_momentum');
    expect(normalizeTelemetryStrategyId('Golden_Momentum')).toBe('golden_momentum');
    expect(normalizeTelemetryStrategyId('trend-following')).toBe('trend-following');
  });
});