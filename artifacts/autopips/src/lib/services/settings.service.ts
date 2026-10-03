import { remote } from '@/lib/rpc';

export const listAdminSettings = remote('server/modules/settings/settings.service', 'listAdminSettings');

export type { AdminSettingView } from '@/types/server-dtos';
