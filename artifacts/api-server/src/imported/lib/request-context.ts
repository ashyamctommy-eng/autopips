import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response } from 'express';

export const requestContext = new AsyncLocalStorage<{ req: Request; res: Response }>();

/** Preserve request-local httpOnly cookies without any Next.js runtime. */
export function cookies() {
  const context = requestContext.getStore();
  if (!context) throw new Error('Cookies require an active HTTP request.');
  return {
    get(name: string) {
      const value = context.req.cookies?.[name];
      return typeof value === 'string' ? { name, value } : undefined;
    },
    set(name: string, value: string, options: Record<string, unknown> = {}) {
      const { maxAge, sameSite, ...rest } = options;
      context.res.cookie(name, value, {
        ...rest,
        ...(typeof maxAge === 'number' ? { maxAge: maxAge * 1000 } : {}),
        ...(sameSite ? { sameSite: String(sameSite).toLowerCase() as 'lax' | 'strict' | 'none' } : {}),
      });
    },
  };
}