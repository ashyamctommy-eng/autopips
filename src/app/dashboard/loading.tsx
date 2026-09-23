import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading skeleton for the dashboard.
 *
 * Mirrors the real page shape — header, 4-up KPI strip, a wide panel and a
 * two-column row — so the layout does not jump when the server component
 * resolves. It renders no figures of any kind.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={`metric-skeleton-${index}`}
            className="flex flex-col gap-3 rounded-xl border border-line bg-base-850/70 p-4"
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-base-850/60 p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-5 flex flex-col gap-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={`row-skeleton-${index}`} className="flex items-center justify-between gap-4">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={`panel-skeleton-${index}`} className="rounded-xl border border-line bg-base-850/60 p-5">
            <Skeleton className="h-4 w-36" />
            <div className="mt-5 flex flex-col gap-3">
              {Array.from({ length: 3 }, (_, row) => (
                <Skeleton key={`panel-row-${row}`} className="h-3 w-full" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
