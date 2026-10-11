import { remote } from '@/lib/rpc';

export const listPublicSymbols = remote('server/modules/market/public-market.service', 'listPublicSymbols');
/** The markets page's list: the broker catalogue PLUS the platform's own instruments. */
export const listMarketInstruments = remote('server/modules/market/public-market.service', 'listMarketInstruments');
