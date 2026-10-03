import { remote } from '@/lib/rpc';

export const listPublicSymbols = remote('server/modules/market/public-market.service', 'listPublicSymbols');
