import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state for the authentication route group.
 *
 * It renders only the *card* — `(auth)/layout.tsx` (background, brand header,
 * security footer) stays mounted while this streams. The shape mirrors
 * `AuthCard`: title, description, two labelled fields, a full-width action —
 * so nothing jumps when the page resolves. It contains no text and no figures.
 */
export default function AuthLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the form.</span>
      <Card className="overflow-hidden">
        <div aria-hidden className="h-0.5 w-full bg-base-700" />
        <div className="flex flex-col gap-2 p-6 pb-0 sm:p-7 sm:pb-0">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-full max-w-xs" />
        </div>
        <div className="flex flex-col gap-5 p-6 sm:p-7">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={`auth-field-skeleton-${index}`} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          ))}
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
        <div className="border-t border-line bg-base-900/40 px-6 py-4 sm:px-7">
          <Skeleton className="h-4 w-48" />
        </div>
      </Card>
    </div>
  );
}
