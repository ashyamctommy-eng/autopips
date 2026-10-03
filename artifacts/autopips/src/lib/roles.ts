/** Role helpers shared by pages and client widgets. SUPER_ADMIN inherits every ADMIN capability. */
export type AppRole = 'CLIENT' | 'ADMIN' | 'SUPER_ADMIN' | 'TRADING_MANAGER';

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export function isSuperAdmin(role: string | null | undefined): boolean {
  return role === 'SUPER_ADMIN';
}

export function isStaffRole(role: string | null | undefined): boolean {
  return isAdminRole(role) || role === 'TRADING_MANAGER';
}
