import { remote } from '@/lib/rpc';

export const getMyKyc = remote('server/modules/kyc/kyc.service', 'getMyKyc');
export const listKycQueue = remote('server/modules/kyc/kyc.service', 'listKycQueue');
