import { remote } from '@/lib/rpc';

/** Mode-dependent public execution disclosure (read live on the server). */
const mode = remote('server/modules/legal/disclosure', 'isInternalExecutionMode');
const notice = remote('server/modules/legal/disclosure', 'internalExecutionNotice');
export const isInternalExecutionMode = (): Promise<boolean> => mode();
export const internalExecutionNotice = (): Promise<string[]> => notice();
