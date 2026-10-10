import { remote } from '@/lib/rpc';

export const listAdminSettings = remote('server/modules/settings/settings.service', 'listAdminSettings');

/**
 * Public support/direct-line mailboxes, editable in Admin → Platform settings.
 * Read anonymously (a whitelisted public read) so the footer and /contact can
 * render them without a session.
 */
export interface PublicContactLine {
  label: string;
  email: string;
  blurb: string;
}

export function getPublicContactLines(): Promise<PublicContactLine[]> {
  return remote('server/modules/settings/settings.service', 'publicContactLines')();
}

export type { AdminSettingView } from '@/types/server-dtos';
