import { remote } from '@/lib/rpc';

export const getOverview = remote('server/modules/account/account.service', 'getOverview');
export const listActivePlans = remote('server/modules/account/account.service', 'listActivePlans');
export const listActivity = remote('server/modules/account/account.service', 'listActivity');
export const listInvestments = remote('server/modules/account/account.service', 'listInvestments');
export const listPositions = remote('server/modules/account/account.service', 'listPositions');
export const listTrades = remote('server/modules/account/account.service', 'listTrades');

export type { TradeDTO } from '@/types/server-dtos';
