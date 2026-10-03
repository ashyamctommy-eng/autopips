import { remote } from '@/lib/rpc';

export const getAdminActivity = remote('server/modules/admin/admin.service', 'getAdminActivity');
export const getAdminOverview = remote('server/modules/admin/admin.service', 'getAdminOverview');
export const getAumSummary = remote('server/modules/admin/admin.service', 'getAumSummary');
export const getBotControlView = remote('server/modules/admin/admin.service', 'getBotControlView');
export const listBrokers = remote('server/modules/admin/admin.service', 'listBrokers');
export const listPlans = remote('server/modules/admin/admin.service', 'listPlans');
export const listUsers = remote('server/modules/admin/admin.service', 'listUsers');
