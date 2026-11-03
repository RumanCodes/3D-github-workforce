import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { type Db, InjectDb } from '../infra/infra.module';

export const SESSION_COOKIE = 'wf_session';
const SESSION_DAYS = 30;

export type AuthUser = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'ADMIN' | 'LEAD' | 'MEMBER';
  teamId: string | null;
  githubIds: string[];
};

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

@Injectable()
export class SessionService {
  constructor(@InjectDb() private readonly db: Db) {}

  /** Creates a session and returns the raw token for the cookie. Only its hash is stored. */
  async create(employeeId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.db.execute(sql`INSERT INTO sessions (id, employee_id, expires_at) VALUES (${hash(token)}, ${employeeId}, ${expiresAt})`);
    return { token, expiresAt };
  }

  async destroy(token: string | undefined) {
    if (token) await this.db.execute(sql`DELETE FROM sessions WHERE id = ${hash(token)}`);
  }

  async userFromToken(token: string | undefined): Promise<AuthUser | null> {
    if (!token) return null;
    const r = await this.db.execute<any>(sql`
      SELECT e.id, e.display_name, e.avatar_url, e.role, e.team_id,
             COALESCE(array_agg(i.external_id) FILTER (WHERE i.external_id IS NOT NULL), '{}') AS github_ids
      FROM sessions s
      JOIN employees e ON e.id = s.employee_id AND e.active
      LEFT JOIN external_identities i ON i.employee_id = e.id AND i.source = 'GITHUB'
      WHERE s.id = ${hash(token)} AND s.expires_at > now()
      GROUP BY e.id`);
    const x = r.rows[0];
    if (!x) return null;
    return {
      id: x.id,
      displayName: x.display_name,
      avatarUrl: x.avatar_url,
      role: x.role,
      teamId: x.team_id,
      githubIds: x.github_ids,
    };
  }

  async userFromCookieHeader(header: string | undefined) {
    return this.userFromToken(parseCookies(header)[SESSION_COOKIE]);
  }
}
