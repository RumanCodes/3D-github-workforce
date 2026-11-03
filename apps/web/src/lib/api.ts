export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      // Required by the server on state-changing requests (CSRF protection).
      'X-Workforce-Client': 'web',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = Array.isArray(body.issues) && body.issues.length
        ? body.issues.map((i: any) => `${i.path}: ${i.message}`).join('; ')
        : (body.message ?? message);
    } catch {
      /* no body */
    }
    if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      location.href = '/login';
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
};
