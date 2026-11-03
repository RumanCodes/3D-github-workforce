'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';

type Options = { github: boolean; dev: boolean };
type DevUser = { id: string; displayName: string; role: string; team: string | null };

export default function LoginPage() {
  const options = useQuery({ queryKey: ['auth-options'], queryFn: () => api.get<Options>('/auth/options') });
  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api.get<DevUser[]>('/auth/dev/users'),
    enabled: !!options.data?.dev,
  });
  const [error, setError] = useState<string | null>(null);

  const devLogin = async (employeeId: string) => {
    try {
      await api.post('/auth/dev/login', { employeeId });
      location.href = '/office?source=github';
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Enter your office</h1>
      <p className="mt-2 text-ink-2">
        Your team, products and GitHub contributions in one live 3D office. Sign in with your work account.
      </p>

      <div className="mt-8 space-y-6">
        {options.data?.github && (
          <a
            href="/api/auth/github"
            className="flex h-11 items-center justify-center rounded-md bg-ink text-[15px] font-medium text-panel hover:opacity-90"
          >
            Sign in with GitHub
          </a>
        )}
        {options.data && !options.data.github && !options.data.dev && (
          <p className="text-sm text-fail">
            Sign-in isn’t configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET on the server.
          </p>
        )}
        {options.error && <p className="text-sm text-fail">Can’t reach the server. Check that it is running on port 4000.</p>}

        {options.data?.dev && (
          <section className="rounded-lg border border-line bg-panel">
            <header className="border-b border-line px-4 py-3">
              <h2 className="font-semibold">Development sign-in</h2>
              <p className="text-sm text-ink-3">Local only. Pick a sample person to see the app with their permissions.</p>
            </header>
            <ul className="divide-y divide-line">
              {devUsers.data?.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div>
                    <div className="font-medium">{u.displayName}</div>
                    <div className="text-sm text-ink-3">
                      {u.role === 'ADMIN' ? 'Admin' : u.role === 'LEAD' ? 'Team lead' : 'Member'}
                      {u.team ? `, ${u.team}` : ''}
                    </div>
                  </div>
                  <Button onClick={() => devLogin(u.id)}>Sign in</Button>
                </li>
              ))}
              {devUsers.data?.length === 0 && (
                <li className="px-4 py-3 text-sm text-ink-3">No employees yet. Run pnpm db:seed on the server.</li>
              )}
            </ul>
          </section>
        )}
        {error && <p className="text-sm text-fail">{error}</p>}
      </div>
    </main>
  );
}
