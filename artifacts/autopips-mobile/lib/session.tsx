import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';

const domain = process.env.EXPO_PUBLIC_DOMAIN;
const origin = domain ? `https://${domain}` : '';
if (origin) setBaseUrl(origin);
type Credentials = { accessToken: string; refreshToken: string; issuedAt: number };
type AuthResult = { accessToken?: string; refreshToken?: string; requires2FA?: boolean; challengeId?: string };
let credentials: Credentials | null = null;
let rotation: Promise<string | null> | null = null;
let generation = 0;
const key = 'autopips.session';

export class SessionError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function authRequest(action: string, body: object): Promise<AuthResult> {
  if (!origin) throw new Error('The account server is not configured.');
  const response = await fetch(`${origin}/api/mobile/auth/${action}`, {
    method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', ...(credentials ? { Authorization: `Bearer ${credentials.accessToken}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new SessionError(payload.error?.message ?? 'Account service unavailable.', response.status);
  return payload.data;
}
async function save(result: AuthResult) {
  if (!result.accessToken || !result.refreshToken) throw new Error('No valid session was returned.');
  const next = { accessToken: result.accessToken, refreshToken: result.refreshToken, issuedAt: Date.now() };
  // Web preview is intentionally memory-only; never persist tokens in browser storage.
  if (Platform.OS !== 'web') await SecureStore.setItemAsync(key, JSON.stringify(next));
  credentials = next;
}
async function clear() {
  generation++;
  credentials = null;
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(key);
}
async function getToken(): Promise<string | null> {
  if (!credentials) return null;
  if (Date.now() - credentials.issuedAt < 5 * 60 * 1000) return credentials.accessToken;
  if (!rotation) {
    const epoch = generation;
    rotation = (async () => {
      const result = await authRequest('refresh', { refreshToken: credentials!.refreshToken });
      if (epoch !== generation) return null;
      await save(result);
      return credentials?.accessToken ?? null;
    })().finally(() => { rotation = null; });
  }
  return rotation;
}
setAuthTokenGetter(getToken);

type SessionContextValue = {
  ready: boolean; signedIn: boolean; error: string | null;
  signIn: (email: string, password: string, challengeId?: string, token?: string) => Promise<string | null>;
  signOut: () => Promise<void>; expire: () => Promise<void>; retry: () => void;
};
const SessionContext = createContext<SessionContextValue | null>(null);
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (Platform.OS !== 'web') {
          const stored = await SecureStore.getItemAsync(key);
          if (stored) {
            const parsed = JSON.parse(stored) as Credentials;
            if (typeof parsed.refreshToken !== 'string') throw new Error('Invalid saved session.');
            credentials = { ...parsed, issuedAt: 0 };
            await getToken();
          }
        }
        if (active) { setSignedIn(!!credentials); setError(null); }
      } catch (e) {
        if (e instanceof SessionError && e.status === 401) await clear();
        else if (active) setError('Unable to restore your session. Check your connection and retry.');
      } finally { if (active) setReady(true); }
    })();
    return () => { active = false; };
  }, [attempt]);
  async function expire() {
    await queryClient.cancelQueries();
    queryClient.clear();
    setSignedIn(false);
    await clear();
  }
  async function signOut() {
    // Finish any rotation before revoking; never leave a freshly rotated session behind.
    if (rotation) await rotation.catch(() => null);
    await authRequest('logout', { refreshToken: credentials?.refreshToken });
    await expire();
  }
  async function signIn(email: string, password: string, challengeId?: string, token?: string) {
    const result = await authRequest(challengeId ? 'challenge' : 'login',
      challengeId ? { challengeId, token } : { email, password });
    if (result.requires2FA && result.challengeId) return result.challengeId;
    await save(result);
    queryClient.clear();
    setSignedIn(true);
    setError(null);
    return null;
  }
  return <SessionContext.Provider value={{ ready, signedIn, error, signIn, signOut, expire, retry() { setReady(false); setAttempt(a => a + 1); } }}>{children}</SessionContext.Provider>;
}
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider is required.');
  return value;
}