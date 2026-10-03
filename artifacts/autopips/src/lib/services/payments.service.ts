import { remote } from '@/lib/rpc';

export const adminListDeposits = remote('server/modules/payments/payments.service', 'adminListDeposits');
export const adminListWithdrawals = remote('server/modules/payments/payments.service', 'adminListWithdrawals');
export const listDeposits = remote('server/modules/payments/payments.service', 'listDeposits');
export const listSupportedCurrencies = remote('server/modules/payments/payments.service', 'listSupportedCurrencies');
export const listWithdrawals = remote('server/modules/payments/payments.service', 'listWithdrawals');
