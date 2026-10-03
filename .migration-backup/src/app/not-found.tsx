import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BrandMark } from '@/components/shared/brand-mark';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <BrandMark size="lg" />
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-line bg-base-850">
        <Compass className="h-6 w-6 text-brand" />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-base-100">Page not found</h1>
        <p className="max-w-md text-sm text-muted">
          That route does not exist on autopips.pro. If you followed a link from inside
          the platform, the resource may have been moved.
        </p>
      </div>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/">Back to home</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/dashboard">Dashboard</Link>
        </Button>
      </div>
    </main>
  );
}
