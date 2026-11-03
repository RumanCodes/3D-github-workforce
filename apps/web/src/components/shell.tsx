'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLiveConnection } from '@/lib/live';
export type Me = { id: string; displayName: string; avatarUrl: string | null; role: 'ADMIN' | 'LEAD' | 'MEMBER'; teamId: string | null; githubIds: string[] };
export function useMe(enabled = true) { return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/me'), enabled, staleTime: 300000 }); }
export function AppShell({ children }: { children: React.ReactNode }) {

 return <div className="office-app">{children}</div>;
}
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
 return <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><h1 className="text-2xl font-semibold">{title}</h1>{children}</div>;
}
