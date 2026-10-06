export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '') ?? '';

export function resolveApiUrl(path: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(path)) return path;

  const apiPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${apiPath}` : apiPath;
}

/** Send API requests with the browser's httpOnly session cookies attached. */
export function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(resolveApiUrl(path), { ...init, credentials: 'include' });
}