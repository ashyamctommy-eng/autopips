'use client';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';

/**
 * Client-side provider stack.
 *
 * Deliberately thin: no auth context that fetches secrets, no global store
 * holding tokens. The session lives in an httpOnly cookie and is read by the
 * server; components that need it receive it as props or from a server
 * component. That keeps the browser bundle free of anything sensitive.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      {children}
      <Toaster />
    </TooltipProvider>
  );
}
