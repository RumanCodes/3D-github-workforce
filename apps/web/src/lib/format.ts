export function hours(h: number | null | undefined): string {
  if (h === null || h === undefined) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  return `${(h / 24).toFixed(1).replace(/\.0$/, '')} days`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function percent(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`;
}

export function initials(name: string): string {
  return name
    .replace(/\[bot\]$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
