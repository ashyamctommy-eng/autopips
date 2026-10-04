import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../src/imported/lib/env', () => ({
  serverEnv: () => ({ NODE_ENV: 'production' }),
}));
vi.mock('../src/imported/lib/redis', () => ({
  redis: {},
  rkey: (...parts: string[]) => parts.join(':'),
}));
vi.mock('../src/imported/lib/prisma', () => ({ prisma: {} }));

import { requestContext } from '../src/imported/lib/request-context';
import { clearAuthCookies } from '../src/imported/server/modules/auth/session';
import { authCookieOptions } from '../src/imported/server/modules/auth/token.service';

describe('production auth cookie options', () => {
  it('uses secure, httpOnly cross-site cookies', () => {
    expect(authCookieOptions(900)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 900,
    });
  });

  it('clears both cookies with the same cross-site attributes', () => {
    const setCookie = vi.fn();
    const request = {} as Request;
    const response = { cookie: setCookie } as unknown as Response;

    requestContext.run({ req: request, res: response }, () => clearAuthCookies());

    const clearedCookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
      maxAge: 0,
    };
    expect(setCookie).toHaveBeenNthCalledWith(1, 'ap_at', '', clearedCookieOptions);
    expect(setCookie).toHaveBeenNthCalledWith(2, 'ap_rt', '', clearedCookieOptions);
  });
});