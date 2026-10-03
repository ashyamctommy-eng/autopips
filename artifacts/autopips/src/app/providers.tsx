'use client';

import { ThemeProvider } from '@/components/theme/theme-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';

/**
 * Client-side provider stack.
 *
 * Deliberately thin: no auth context that fetches secrets, no global store
 * holding tokens. The session lives in an httpOnly cookie and is read by the
 * server; components that need it receive it as props or from a server
 * component. That keeps the browser bundle free of anything sensitive.
 *
 * `ThemeProvider` is the outermost entry: it owns the `data-theme` attribute on
 * `<html>`, which the palette in globals.css keys off. Portalled UI (dialogs,
 * dropdowns, tooltips) inherits from `<html>`, so it follows the theme too.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={150}>
        {children}
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
