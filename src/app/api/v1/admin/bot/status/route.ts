import { handler, ok } from '@/lib/http';
import { requireAdmin } from '@/server/modules/auth/session';
import { getBotControlState } from '@/server/modules/bot/bot-control.service';
import {
  ensureBrokerConnected,
  getAdapterForConnection,
  listBrokerConnections,
} from '@/server/modules/broker/broker.registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/admin/bot/status
 *
 * The bot-control console's read model: the kill-switch state (with its reason
 * and provenance), the EFFECTIVE risk limits, and the broker's instrument list
 * so the operator can toggle symbols without typing tickers from memory.
 *
 * `symbols` is empty when no broker connection is reachable — the console says
 * so rather than offering a fabricated list. `killSwitch` is never cached here:
 * it is the whole point that an operator sees the truth.
 */
export const GET = handler(async () => {
  await requireAdmin();

  const state = await getBotControlState();

  let symbols: Array<{ symbol: string; displayName: string; market: string; isTradable: boolean }> = [];
  let symbolsError: string | null = null;

  try {
    const connections = await listBrokerConnections();
    const connection = connections.find((row) => row.status === 'CONNECTED') ?? connections[0];
    if (connection) {
      const adapter = await ensureBrokerConnected(await getAdapterForConnection(connection));
      symbols = (await adapter.listInstruments()).map((instrument) => ({
        symbol: instrument.symbol,
        displayName: instrument.displayName,
        market: instrument.market,
        isTradable: instrument.isTradable,
      }));
    } else {
      symbolsError = 'No broker connection is registered yet.';
    }
  } catch (err) {
    // An unreachable broker must not break the console: the kill switch still
    // has to be operable when the broker is the thing that is broken.
    symbolsError = err instanceof Error ? err.message : 'The broker could not list instruments.';
    console.warn('[admin/bot/status] instrument list unavailable:', symbolsError);
  }

  return ok({ killSwitch: state, symbols, symbolsError });
});
