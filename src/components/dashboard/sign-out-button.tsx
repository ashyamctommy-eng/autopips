'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { Spinner } from '@/components/ui/spinner';

/**
 * Sign out (client component).
 *
 * `POST /api/v1/auth/logout` revokes the session server-side (the Redis marker
 * kills the access token within its lifetime) and clears both cookies. The route
 * is idempotent — a 200 either way — so this component can call it
 * unconditionally and then send the browser to the sign-in page.
 */
export interface SignOutButtonProps {
  className?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}

export function SignOutButton({
  className,
  variant = 'outline',
  size = 'sm',
}: SignOutButtonProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const handleSignOut = React.useCallback(() => {
    if (pending) return;
    setPending(true);
    void (async () => {
      try {
        const response = await fetch('/api/v1/auth/logout', {
          method: 'POST',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) {
          toast({
            title: 'Sign-out reported a problem',
            description: 'Your session cookies were cleared locally. Close the tab if anything looks unusual.',
            variant: 'warn',
          });
        }
      } catch {
        toast({
          title: 'Sign-out could not reach the server',
          description: 'Closing this tab will end the local session.',
          variant: 'warn',
        });
      } finally {
        setPending(false);
        router.replace('/login');
        router.refresh();
      }
    })();
  }, [pending, router]);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={handleSignOut}
      disabled={pending}
    >
      {pending ? <Spinner size="sm" label="Signing out" /> : <LogOut aria-hidden />}
      Sign out
    </Button>
  );
}

export default SignOutButton;
