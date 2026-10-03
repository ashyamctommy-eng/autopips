import { remote } from '@/lib/rpc';

export const getWallet = remote('server/modules/positions/position.service', 'getWallet');
export const listPositions = remote('server/modules/positions/position.service', 'listPositions');
