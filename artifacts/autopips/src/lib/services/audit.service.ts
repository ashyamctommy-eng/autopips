import { remote } from '@/lib/rpc';

export { AUDIT } from '@/lib/shared/audit';
export const listAudit = remote('server/modules/audit/audit.service', 'listAudit');
